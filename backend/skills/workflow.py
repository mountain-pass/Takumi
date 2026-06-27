"""
Agent-facing skill: run a published workflow by name.

Lets an agent kick off any LIVE workflow as a tool during its work, passing an
optional JSON payload as the trigger input. Draft workflows are not runnable.
"""
from __future__ import annotations

import json
import logging

logger = logging.getLogger(__name__)


async def run_workflow_skill(name: str, payload: dict | str | None = None) -> str:
    from .. import database
    from ..orchestrator import orchestrator
    from ..workflows import run_workflow

    workflows = await database.list_workflows()
    target = next((w for w in workflows if (w.get("name") or "").lower() == (name or "").lower()), None)
    if target is None:
        live = [w["name"] for w in workflows if w.get("status") == "live"]
        return f"No workflow named '{name}'. Live workflows: {', '.join(live) or '(none)'}."
    if target.get("status") != "live":
        return f"Workflow '{name}' is a draft — publish it before it can be triggered."

    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {"input": payload}
    run_id = await run_workflow(target, payload or {}, mode="live",
                                trigger_source="agent", orchestrator=orchestrator)
    run = await database.get_run(run_id)
    steps = run.get("steps", []) if run else []
    last = steps[-1] if steps else None
    status = run.get("status") if run else "unknown"
    summary = f"Ran workflow '{target['name']}' ({status}) — {len(steps)} step(s)."
    if status == "failed" and run and run.get("error"):
        summary += f" Error: {run['error'][:300]}"
    if last and last.get("output"):
        # Return the full final output so the calling agent can act on it.
        summary += f"\nFinal output:\n{json.dumps(last['output'], indent=2)[:3000]}"
    return summary
