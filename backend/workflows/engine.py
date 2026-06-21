"""
Workflow executor — walks a saved graph from its trigger node, runs each node
through its handler, persists per-node steps, and broadcasts live progress.

The graph is the React-Flow shape: {nodes: [{id, type, data}], edges: [{source,
target, sourceHandle?}]}. Execution is a topological walk; `if` nodes prune the
branch that wasn't taken. LLM nodes are passed through the Risk & Compliance gate.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections import defaultdict, deque

from .. import database
from .. import compliance
from .. import notifications
from ..models import WSEvent, WSEventType
from .nodes import NODE_HANDLERS, NODE_TIMEOUT, NodeContext

logger = logging.getLogger(__name__)


async def _broadcast(orchestrator, kind: WSEventType, payload: dict) -> None:
    if orchestrator is None:
        return
    try:
        await orchestrator._broadcast(WSEvent(type=kind, payload=payload))
    except Exception:
        pass


def _topo_order(nodes: list[dict], edges: list[dict]) -> list[str]:
    ids = [n["id"] for n in nodes]
    indeg = {i: 0 for i in ids}
    adj = defaultdict(list)
    for e in edges:
        if e.get("source") in indeg and e.get("target") in indeg:
            adj[e["source"]].append(e["target"])
            indeg[e["target"]] += 1
    q = deque([i for i in ids if indeg[i] == 0])
    order: list[str] = []
    while q:
        n = q.popleft()
        order.append(n)
        for m in adj[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                q.append(m)
    # Append any nodes left out by cycles so they still run (best-effort).
    for i in ids:
        if i not in order:
            order.append(i)
    return order


async def _run_compliance(node: dict, output: dict, workflow: dict, run_id: str, orchestrator) -> dict:
    """Gate an LLM node's output through Risk & Compliance. Returns a compliance dict."""
    if not workflow.get("require_compliance", True):
        return {"status": "skipped", "reason": "compliance not required for this workflow"}
    rc = compliance.find_rc_agent(orchestrator) if orchestrator is not None else None
    label = (node.get("data") or {}).get("label") or "LLM step"
    content = output.get("text") or ""
    if rc is None:
        return {"status": "unchecked", "reason": "no Risk & Compliance agent in the organisation"}
    try:
        record = await compliance.assess(rc, subject=f"Workflow LLM node: {label}",
                                         content=content, task_id=run_id)
        return {
            "status": "blocked" if record.get("verdict") == "block" else "reviewed",
            "level": record.get("level"),
            "score": record.get("score"),
            "verdict": record.get("verdict"),
            "reviewer": rc.config.name,
        }
    except Exception as e:
        logger.warning("[workflow] compliance assess failed: %s", e)
        return {"status": "error", "reason": str(e)[:200]}


async def run_workflow(workflow: dict, trigger_payload: dict | None = None, *,
                       mode: str = "test", trigger_source: str = "manual",
                       orchestrator=None, _depth: int = 0) -> str:
    """Execute a workflow graph. Returns the run_id. Steps stream over WS."""
    run_id = uuid.uuid4().hex
    graph = workflow.get("graph") or {}
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    edges = graph.get("edges", [])

    await database.create_run({"id": run_id, "workflow_id": workflow["id"],
                               "mode": mode, "status": "running", "trigger_source": trigger_source})
    await _broadcast(orchestrator, WSEventType.WORKFLOW_RUN,
                     {"run_id": run_id, "workflow_id": workflow["id"], "status": "running", "mode": mode})

    ctx = NodeContext(run_id=run_id, mode=mode, orchestrator=orchestrator, workflow=workflow)
    ctx.depth = _depth
    outputs: dict[str, dict] = {}
    executed: set[str] = set()
    consumed: set[str] = set()       # nodes already run inside a loop body
    branch_of: dict[str, str] = {}   # if/loop-node id → taken handle

    # Edge maps.
    incoming = defaultdict(list)
    adj = defaultdict(list)
    for e in edges:
        incoming[e.get("target")].append(e)
        if e.get("source") and e.get("target"):
            adj[e["source"]].append(e["target"])

    def edge_is_live(e) -> bool:
        src = e.get("source")
        if src not in executed:
            return False
        if src in branch_of:
            return (e.get("sourceHandle") or "true") == branch_of[src]
        return True

    def assemble_inputs(node_id, src_outputs):
        live = [s for s in src_outputs]
        ups = [src_outputs[s] for s in live]
        if len(ups) == 1:
            return ups[0]
        merged: dict = {}
        for u in ups:
            if isinstance(u, dict):
                merged.update(u)
        merged["_merged"] = ups
        return merged

    async def exec_node(node, inputs, *, label_suffix="") -> tuple[dict | None, dict | None]:
        """Record + run a single node. Returns (output, compliance) or (None, None) on failure."""
        node_id = node["id"]
        ntype = node.get("type") or (node.get("data") or {}).get("type") or "trigger"
        label = ((node.get("data") or {}).get("label") or ntype) + label_suffix
        step_id = uuid.uuid4().hex
        await database.add_run_step({"id": step_id, "run_id": run_id, "node_id": node_id,
                                     "node_type": ntype, "node_label": label, "status": "running",
                                     "input": inputs if isinstance(inputs, dict) else {"value": inputs}})
        await _broadcast(orchestrator, WSEventType.WORKFLOW_STEP,
                         {"run_id": run_id, "node_id": node_id, "status": "running", "label": label})
        handler = NODE_HANDLERS.get(ntype)
        if handler is None:
            await database.finish_run_step(step_id, status="failed", error=f"Unknown node type '{ntype}'")
            await _broadcast(orchestrator, WSEventType.WORKFLOW_STEP,
                             {"run_id": run_id, "node_id": node_id, "status": "failed", "label": label})
            raise ValueError(f"Unknown node type '{ntype}'")
        try:
            output = await asyncio.wait_for(handler(node, inputs, ctx), timeout=NODE_TIMEOUT)
            if not isinstance(output, dict):
                output = {"value": output}
        except Exception as e:
            logger.warning("[workflow] node %s (%s) failed: %s", node_id, ntype, e)
            await database.finish_run_step(step_id, status="failed", error=str(e)[:500])
            await _broadcast(orchestrator, WSEventType.WORKFLOW_STEP,
                             {"run_id": run_id, "node_id": node_id, "status": "failed", "label": label, "error": str(e)[:300]})
            raise
        comp = await _run_compliance(node, output, workflow, run_id, orchestrator) if ntype == "llm" else None
        ctx.context[node_id] = output
        # A compliance agent that BLOCKS the output fails the node when the gate is
        # strict ('all'). Under 'unless_excluded'/'off' it's recorded but allowed.
        if comp and comp.get("status") == "blocked" and compliance.get_mode() == "all":
            await database.finish_run_step(step_id, status="failed", output=output, compliance=comp,
                                           error=f"Blocked by compliance ({comp.get('level')}, score {comp.get('score')})")
            await _broadcast(orchestrator, WSEventType.WORKFLOW_STEP,
                             {"run_id": run_id, "node_id": node_id, "status": "failed",
                              "label": label, "output": output, "compliance": comp,
                              "error": "Blocked by compliance review"})
            raise RuntimeError(f"Compliance blocked '{label}'")
        await database.finish_run_step(step_id, status="success", output=output, compliance=comp)
        await _broadcast(orchestrator, WSEventType.WORKFLOW_STEP,
                         {"run_id": run_id, "node_id": node_id, "status": "success",
                          "label": label, "output": output, "compliance": comp})
        return output, comp

    def _reach(starts: list[str]) -> set[str]:
        seen, stack = set(), list(starts)
        while stack:
            n = stack.pop()
            if n in seen:
                continue
            seen.add(n)
            stack.extend(adj.get(n, []))
        return seen

    async def run_loop_body(loop_id, items) -> list:
        """Run the loop's body sub-branch once per item; return collected results.
        Body = nodes reachable from the loop's 'loop' handle but not via 'done'."""
        loop_starts = [e["target"] for e in edges if e.get("source") == loop_id and e.get("sourceHandle") == "loop"]
        done_starts = [e["target"] for e in edges if e.get("source") == loop_id and e.get("sourceHandle") == "done"]
        body = (_reach(loop_starts) - _reach(done_starts)) - {loop_id}
        body_order = [n for n in _topo_order(list(nodes.values()), edges) if n in body]
        body_edges = [e for e in edges if e.get("source") in body and e.get("target") in body]
        body_incoming = defaultdict(list)
        for e in body_edges:
            body_incoming[e["target"]].append(e)
        terminals = [n for n in body if not any(e.get("source") == n for e in body_edges)]
        results = []
        for i, item in enumerate(items[:200]):           # bounded fan-out
            local: dict[str, dict] = {}
            for nid in body_order:
                node = nodes[nid]
                ie = body_incoming.get(nid, [])
                if not ie:                                # body entry node → receives the item
                    inp = item if isinstance(item, dict) else {"item": item}
                else:
                    inp = assemble_inputs(nid, {e["source"]: local.get(e["source"], {}) for e in ie})
                out, _ = await exec_node(node, inp, label_suffix=f" [item {i + 1}]")
                local[nid] = out
            if len(terminals) == 1:
                results.append(local.get(terminals[0]))
            elif terminals:
                results.append({t: local.get(t) for t in terminals})
        for nid in body:                                  # don't re-run body in the main walk
            consumed.add(nid); executed.add(nid)
        return results

    run_status = "success"
    run_error = ""
    try:
        for node_id in _topo_order(list(nodes.values()), edges):
            if node_id in consumed:
                continue
            node = nodes[node_id]
            ntype = node.get("type") or (node.get("data") or {}).get("type") or "trigger"
            in_edges = incoming.get(node_id, [])
            is_start = ntype == "trigger" or not in_edges
            live_sources = [e["source"] for e in in_edges if edge_is_live(e)]
            if not is_start and not live_sources:
                continue  # pruned branch — skip silently

            inputs = (trigger_payload or {}) if is_start else assemble_inputs(
                node_id, {s: outputs.get(s, {}) for s in live_sources})

            try:
                output, _ = await exec_node(node, inputs)
            except Exception as e:
                run_status = "failed"; run_error = str(e)[:500]
                break

            # Loop nodes fan their body sub-branch out per item, then continue via 'done'.
            if ntype == "loop":
                items = output.get("items") if isinstance(output, dict) else []
                results = await run_loop_body(node_id, items or [])
                output = {**output, "results": results}
                branch_of[node_id] = "done"
            elif "_branch" in output:
                branch_of[node_id] = output["_branch"]

            outputs[node_id] = output
            executed.add(node_id)
    except Exception as e:
        run_status = "failed"; run_error = str(e)[:500]
        logger.exception("[workflow] run %s crashed", run_id)

    await database.finish_run(run_id, run_status, run_error)
    await _broadcast(orchestrator, WSEventType.WORKFLOW_RUN,
                     {"run_id": run_id, "workflow_id": workflow["id"], "status": run_status, "mode": mode})

    # Live runs happen without a user watching — surface the outcome in the bell.
    if mode == "live":
        ok = run_status == "success"
        await notifications.push(
            type="success" if ok else "alert",
            title=f"Workflow {'completed' if ok else 'failed'}: {workflow.get('name', 'Workflow')}",
            body=(f"Triggered by {trigger_source}." if ok else (run_error or "A node failed.")),
            action="View workflow", link_view="workflows", link_id=workflow["id"],
            dedupe_key=f"wfrun:{workflow['id']}",
        )
    return run_id
