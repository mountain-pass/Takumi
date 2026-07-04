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
import os
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
        if record.get("incomplete"):
            # The assessor couldn't actually score (e.g. its LLM key is invalid).
            # Don't pass it off as a clean review — surface the failure instead.
            return {"status": "error", "reviewer": rc.config.name,
                    "reason": f"Review could not be completed: {record.get('error')}"}
        return {
            "status": "blocked" if record.get("verdict") == "block" else "reviewed",
            "level": record.get("level"),
            "score": record.get("score"),
            "threshold": record.get("threshold"),
            "verdict": record.get("verdict"),
            "rationale": record.get("rationale"),
            "categories": record.get("categories"),
            "findings": record.get("findings"),
            "reviewer": rc.config.name,
        }
    except Exception as e:
        logger.warning("[workflow] compliance assess failed: %s", e)
        return {"status": "error", "reason": str(e)[:200]}


async def run_workflow(workflow: dict, trigger_payload: dict | None = None, *,
                       mode: str = "test", trigger_source: str = "manual",
                       orchestrator=None, _depth: int = 0, until_node: str | None = None,
                       only_node: str | None = None, seed_context: dict | None = None,
                       verify: bool = False) -> str:
    """Execute a workflow graph. Returns the run_id. Steps stream over WS.
    `until_node` stops after that node executes (used by 'Execute step').
    `only_node` runs JUST that node with the given `trigger_payload` as its input
    (used by 'This step only' — re-test one node without re-running upstream).
    `seed_context` pre-populates ctx.context (keyed by upstream node id/label) so
    {{Upstream.field}} tokens still resolve in only_node mode.
    `verify` = a safe dry-run used by the AI builder to prove the flow works without
    real-world side effects: outbound mutating HTTP calls (POST/PUT/PATCH/DELETE — how
    email/Telegram/WhatsApp/etc. are sent) are SIMULATED not sent, and any files written
    are deleted after the run."""
    run_id = uuid.uuid4().hex
    graph = workflow.get("graph") or {}
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    # `wfback_*` edges are the visual loop-back drawn from a Loop body to the Loop node.
    # The engine fans the loop body out internally, so these are decorative only — drop
    # them so they never affect topo ordering or input assembly.
    edges = [e for e in graph.get("edges", []) if not str(e.get("id", "")).startswith("wfback")]

    await database.create_run({"id": run_id, "workflow_id": workflow["id"],
                               "mode": mode, "status": "running", "trigger_source": trigger_source})
    await _broadcast(orchestrator, WSEventType.WORKFLOW_RUN,
                     {"run_id": run_id, "workflow_id": workflow["id"], "status": "running", "mode": mode})

    ctx = NodeContext(run_id=run_id, mode=mode, orchestrator=orchestrator, workflow=workflow)
    ctx.depth = _depth
    verify_writes: list[str] = []     # files written during a verify run → deleted at the end
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

    def assemble_inputs(node_id, src_outputs, in_edges=None):
        live = [s for s in src_outputs]
        # Deterministic input order for Merge: sort by the targetHandle index
        # ('input-0', 'input-1', …) so Input 1/2/3 map to the wired ports.
        if in_edges:
            def hidx(src):
                for e in in_edges:
                    if e.get("source") == src:
                        th = str(e.get("targetHandle") or "")
                        return int(th[6:]) if th.startswith("input-") and th[6:].isdigit() else 10**6
                return 10**6
            live.sort(key=hidx)
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
        # Verify (dry-run): don't let an outbound mutating HTTP call actually fire — that's
        # how messages/emails get sent out. Simulate a success so downstream nodes still run.
        if verify and ntype == "http":
            _m = str(((node.get("data") or {}).get("config") or {}).get("method") or "GET").upper()
            if _m not in ("GET", "HEAD", "OPTIONS"):
                output = {"status": 0, "ok": True, "skipped": True, "body": "",
                          "note": f"[verify] outbound HTTP {_m} not sent (verification run)"}
                ctx.context[node_id] = output
                _lbl = (node.get("data") or {}).get("label")
                if _lbl:
                    ctx.context[_lbl] = output
                await database.finish_run_step(step_id, status="success", output=output)
                await _broadcast(orchestrator, WSEventType.WORKFLOW_STEP,
                                 {"run_id": run_id, "node_id": node_id, "status": "success",
                                  "label": label, "output": output})
                return output, None
        handler = NODE_HANDLERS.get(ntype)
        if handler is None:
            await database.finish_run_step(step_id, status="failed", error=f"Unknown node type '{ntype}'")
            await _broadcast(orchestrator, WSEventType.WORKFLOW_STEP,
                             {"run_id": run_id, "node_id": node_id, "status": "failed", "label": label})
            raise ValueError(f"Unknown node type '{ntype}'")
        try:
            # LLM nodes run a full agentic tool loop (web search, browser, …) which
            # can take minutes — give them the agent work budget, not the 120s default.
            node_timeout = 960 if ntype == "llm" else NODE_TIMEOUT
            output = await asyncio.wait_for(handler(node, inputs, ctx), timeout=node_timeout)
            if not isinstance(output, dict):
                output = {"value": output}
        except Exception as e:
            logger.warning("[workflow] node %s (%s) failed: %s", node_id, ntype, e)
            await database.finish_run_step(step_id, status="failed", error=str(e)[:500])
            await _broadcast(orchestrator, WSEventType.WORKFLOW_STEP,
                             {"run_id": run_id, "node_id": node_id, "status": "failed", "label": label, "error": str(e)[:300]})
            raise
        # Verify run: the file write proves path+content are valid, then we remove it so
        # a dry-run leaves nothing behind on disk.
        if verify and ntype == "write_file" and isinstance(output, dict) and output.get("path"):
            verify_writes.append(output["path"])
        comp = await _run_compliance(node, output, workflow, run_id, orchestrator) if ntype == "llm" else None
        ctx.context[node_id] = output
        # Also expose the output under the node's label so templates can read
        # {{My Node.field}} (friendlier than the raw node id).
        _lbl = (node.get("data") or {}).get("label")
        if _lbl:
            ctx.context[_lbl] = output
        # When this workflow requires compliance review, the output must clear the
        # Risk & Compliance agent before reaching downstream steps. A BLOCK verdict —
        # or NO compliance agent being set up at all — fails the node. (_run_compliance
        # only returns 'blocked'/'unchecked' when require_compliance is on, so the
        # per-workflow flag is authoritative regardless of the org-wide mode.)
        tokens = ctx.step_tokens.get(node_id)
        if comp and comp.get("status") in ("blocked", "unchecked", "error"):
            if comp.get("status") == "unchecked":
                err = ("Compliance review is required for this workflow, but no Risk & Compliance "
                       "agent is set up. Add a compliance agent in Risk & Compliance so this workflow "
                       "can run according to the rules.")
            elif comp.get("status") == "error":
                err = (f"Compliance review could not be completed, so this output cannot proceed. "
                       f"{comp.get('reason') or ''}").strip()
            else:
                err = f"Blocked by compliance review ({comp.get('level')}, score {comp.get('score')})"
            await database.finish_run_step(step_id, status="failed", output=output, compliance=comp,
                                           tokens=tokens, error=err)
            await _broadcast(orchestrator, WSEventType.WORKFLOW_STEP,
                             {"run_id": run_id, "node_id": node_id, "status": "failed",
                              "label": label, "output": output, "compliance": comp, "error": err})
            raise RuntimeError(err)
        await database.finish_run_step(step_id, status="success", output=output, compliance=comp, tokens=tokens)
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
                    inp = assemble_inputs(nid, {e["source"]: local.get(e["source"], {}) for e in ie}, ie)
                out, _ = await exec_node(node, inp, label_suffix=f" [item {i + 1}]")
                local[nid] = out
            if len(terminals) == 1:
                results.append(local.get(terminals[0]))
            elif terminals:
                results.append({t: local.get(t) for t in terminals})
        for nid in body:                                  # don't re-run body in the main walk
            consumed.add(nid); executed.add(nid)
        return results

    # An error-catch branch ("Stop and Error" catcher): nodes reachable from any
    # error_trigger node run ONLY when something fails, never in the normal flow.
    def _node_type(n):
        return n.get("type") or (n.get("data") or {}).get("type") or "trigger"
    error_triggers = [nid for nid, n in nodes.items() if _node_type(n) == "error_trigger"]
    error_branch: set[str] = set()
    for et in error_triggers:
        error_branch |= _reach([et])

    async def run_error_branch(failed_label: str, error_msg: str, failed_id: str) -> None:
        payload = {"error": error_msg, "node": failed_label, "node_id": failed_id,
                   "run_id": run_id, "workflow": workflow.get("name", "")}
        order = [n for n in _topo_order(list(nodes.values()), edges) if n in error_branch]
        local: dict[str, dict] = {}
        for nid in order:
            node = nodes[nid]
            ie = [e for e in incoming.get(nid, []) if e.get("source") in error_branch]
            if _node_type(node) == "error_trigger" or not ie:
                inp = payload
            else:
                inp = assemble_inputs(nid, {e["source"]: local.get(e["source"], {}) for e in ie})
            try:
                out, _ = await exec_node(node, inp)
                local[nid] = out
            except Exception as e:
                logger.warning("[workflow] error branch node %s failed: %s", nid, e)
                break

    run_status = "success"
    run_error = ""
    failed_label = ""; failed_id = ""
    try:
        single = nodes.get(only_node) if only_node else None
        if only_node and single is None:
            run_status = "failed"; run_error = f"Node {only_node} not found"
        elif single is not None:
            if seed_context:
                ctx.context.update(seed_context)
            try:
                await exec_node(single, trigger_payload or {})
            except Exception as e:
                run_status = "failed"; run_error = str(e)[:500]
                failed_label = (single.get("data") or {}).get("label") or _node_type(single)
                failed_id = only_node
        # Wave scheduler: run all nodes whose predecessors are settled CONCURRENTLY,
        # so independent branches (e.g. several Web Search nodes) fire in parallel, and
        # a join node still waits for every upstream because it only becomes ready once
        # all its predecessors have finished. Falls back to nothing in only_node mode.
        async def _run_one(node_id):
            node = nodes[node_id]
            ntype = node.get("type") or (node.get("data") or {}).get("type") or "trigger"
            in_edges = incoming.get(node_id, [])
            is_start = ntype == "trigger" or not in_edges
            live_sources = [e["source"] for e in in_edges if edge_is_live(e)]
            inputs = (trigger_payload or {}) if is_start else assemble_inputs(
                node_id, {s: outputs.get(s, {}) for s in live_sources}, in_edges)
            output, _ = await exec_node(node, inputs)
            if ntype == "loop":
                items = output.get("items") if isinstance(output, dict) else []
                output = {**output, "results": await run_loop_body(node_id, items or [])}
                branch_of[node_id] = "done"
            elif isinstance(output, dict) and "_branch" in output:
                branch_of[node_id] = output["_branch"]
            outputs[node_id] = output
            executed.add(node_id)

        if not only_node:
            skipped: set[str] = set()
            pending = {nid for nid in _topo_order(list(nodes.values()), edges)
                       if nid not in consumed and nid not in error_branch}

            def _settled(nid):
                return nid in executed or nid in consumed or nid in error_branch or nid in skipped

            stop = False
            while pending and not stop:
                ready = [nid for nid in pending
                         if all(_settled(e["source"]) for e in incoming.get(nid, []))]
                if not ready:
                    break  # remaining nodes are unreachable (cycle/disconnected) — leave them
                wave = []
                for nid in ready:
                    node = nodes[nid]
                    ntype = node.get("type") or (node.get("data") or {}).get("type") or "trigger"
                    in_edges = incoming.get(nid, [])
                    is_start = ntype == "trigger" or not in_edges
                    if not is_start and not [e for e in in_edges if edge_is_live(e)]:
                        skipped.add(nid); pending.discard(nid)   # pruned branch
                    else:
                        wave.append(nid)
                if not wave:
                    continue  # this round only pruned; re-evaluate readiness
                results = await asyncio.gather(*[_run_one(nid) for nid in wave],
                                               return_exceptions=True)
                for nid, r in zip(wave, results):
                    pending.discard(nid)
                    if isinstance(r, asyncio.CancelledError):
                        raise r
                    if isinstance(r, Exception) and run_status != "failed":
                        run_status = "failed"; run_error = str(r)[:500]
                        failed_label = (nodes[nid].get("data") or {}).get("label") or nid
                        failed_id = nid; stop = True
                if until_node and until_node in executed:
                    stop = True  # 'Execute step' — stop after the requested node ran
    except asyncio.CancelledError:
        # Stopped from the editor — finalise the run record then re-raise so the
        # awaiting request unwinds.
        await database.finish_run(run_id, "cancelled", "Execution stopped")
        await _broadcast(orchestrator, WSEventType.WORKFLOW_RUN,
                         {"run_id": run_id, "workflow_id": workflow["id"], "status": "cancelled", "mode": mode})
        raise
    except Exception as e:
        run_status = "failed"; run_error = str(e)[:500]
        logger.exception("[workflow] run %s crashed", run_id)

    # Catch-all: on any failure, run the error branch with the error context.
    if run_status == "failed" and error_branch:
        try:
            await run_error_branch(failed_label, run_error, failed_id)
        except Exception as e:
            logger.warning("[workflow] error branch crashed: %s", e)

    # Verify run cleanup: delete any files the dry-run wrote so it leaves no trace.
    for _p in verify_writes:
        try:
            os.remove(_p)
        except OSError:
            pass

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
