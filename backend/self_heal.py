"""
Self-healing: when invoking an LLM/provider fails in a way that looks like a code
or format problem (a new/unknown provider the adapters don't handle yet), we
record an incident and — with the user's approval — hand it to the CTO agent to
patch the codebase. Each fix lands on a dedicated `self-heal/<id>` git branch with
a local commit, so it's auto-applied (dev runs with --reload) and easy to roll back.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import uuid

from . import database

logger = logging.getLogger(__name__)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── Detection ─────────────────────────────────────────────────────────────────

# Substrings in an exception that suggest a code/format issue we can patch (vs a
# transient network blip or a plain bad API key).
_HEALABLE_SIGNALS = (
    "unsupported", "not supported", "unexpected keyword", "no attribute",
    "keyerror", "unknown provider", "unknown field", "invalid_request_error",
    "unrecognized", "missing required", "json", "parse", "schema",
    "object has no", "typeerror", "validationerror", "unprocessable",
    "model_not_found", "unknownprovider", "decode", "nonetype",
)
_NON_HEALABLE = (
    "invalid api key", "invalid x-api-key", "incorrect api key", "401",
    "unauthorized", "authentication", "permission", "rate limit", "429",
    "timed out", "timeout", "connection error", "connection refused",
    "insufficient", "quota", "billing",
)


def is_healable_llm_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    if any(s in msg for s in _NON_HEALABLE):
        return False
    return any(s in msg for s in _HEALABLE_SIGNALS) or isinstance(exc, (KeyError, TypeError, AttributeError))


# ── Incident lifecycle ────────────────────────────────────────────────────────

async def record_incident(*, conversation_id, agent_id, provider, model, base_url,
                          error, traceback="") -> dict:
    inc = {
        "id": uuid.uuid4().hex[:12],
        "status": "pending",
        "conversation_id": conversation_id,
        "agent_id": agent_id or "",
        "provider": provider or "",
        "model": model or "",
        "base_url": base_url or "",
        "error": (error or "")[:2000],
        "traceback": (traceback or "")[:6000],
    }
    await database.save_heal_incident(inc)
    logger.warning("[self-heal] Recorded incident %s for provider '%s' model '%s'",
                   inc["id"], provider, model)
    return inc


async def propose(orchestrator, inc: dict) -> None:
    """Broadcast a self-heal proposal so the UI can ask the user for approval."""
    if not (orchestrator and orchestrator._ws_broadcast):
        return
    from .models import WSEvent, WSEventType
    await orchestrator._ws_broadcast(WSEvent(
        type=WSEventType.SELF_HEAL,
        payload={
            "kind": "proposal",
            "incident_id": inc["id"],
            "provider": inc["provider"],
            "model": inc["model"],
            "error": inc["error"][:400],
            "conversation_id": inc["conversation_id"],
        },
    ).model_dump_json())


# ── Git helpers ───────────────────────────────────────────────────────────────

def _git(*args: str) -> tuple[int, str]:
    try:
        p = subprocess.run(["git", "-C", REPO_ROOT, *args],
                           capture_output=True, text=True, timeout=30)
        return p.returncode, (p.stdout + p.stderr).strip()
    except Exception as e:
        return 1, str(e)


def _dirty_paths() -> set[str]:
    """Paths with working-tree changes (excludes compiled bytecode)."""
    _, out = _git("status", "--porcelain")
    paths = set()
    for line in out.splitlines():
        p = line[3:].strip().strip('"')
        if p and not p.endswith(".pyc") and "__pycache__" not in p:
            paths.add(p)
    return paths


# Pre-heal dirty snapshot per incident, so we only commit what the CTO changed.
_baselines: dict[str, set[str]] = {}


def create_heal_branch(incident_id: str) -> str:
    _baselines[incident_id] = _dirty_paths()  # remember what was dirty BEFORE
    branch = f"self-heal/{incident_id}"
    code, out = _git("checkout", "-b", branch)
    if code != 0 and "already exists" in out:
        branch = f"self-heal/{incident_id}-{uuid.uuid4().hex[:4]}"
        _git("checkout", "-b", branch)
    return branch


def commit_heal(branch: str, incident: dict) -> str:
    # Commit ONLY files the CTO changed (current dirty minus the pre-heal baseline),
    # so unrelated uncommitted work is never swept into the self-heal commit.
    baseline = _baselines.get(incident["id"], set())
    changed = sorted(_dirty_paths() - baseline)
    if not changed:
        return ""
    rc, _ = _git("add", "--", *changed)
    if rc != 0:
        return ""
    msg = (f"Self-heal: fix {incident.get('provider','provider')} "
           f"invocation [incident {incident['id']}]\n\nError: {incident.get('error','')[:200]}")
    code, _out = _git("commit", "-m", msg)
    if code != 0:
        return ""
    rc, sha = _git("rev-parse", "--short", "HEAD")
    _baselines.pop(incident["id"], None)
    return sha if rc == 0 else ""


# ── CTO selection ─────────────────────────────────────────────────────────────

_CTO_HINTS = ("cto", "chief technology", "engineer", "architect", "developer", "devops")
_CODE_SKILLS = ["read_file", "write_file", "list_files", "run_shell"]


def find_cto(orchestrator):
    """Pick the engineering agent: prefer a CTO-ish role, else any non-CEO agent."""
    candidates = [a for a in orchestrator.get_agents() if not a.config.is_ceo]
    for a in candidates:
        text = f"{a.config.role} {a.config.name} {a.config.description}".lower()
        if any(h in text for h in _CTO_HINTS):
            return a
    return candidates[0] if candidates else None


async def _ensure_code_skills(agent) -> None:
    """Grant the CTO the file/shell skills needed to patch code (persist + live)."""
    skills = list(agent.config.skills or [])
    changed = False
    for s in _CODE_SKILLS:
        if s not in skills:
            skills.append(s)
            changed = True
    if changed:
        agent.config.skills = skills  # live agent uses this object
        await database.save_agent(agent.config.model_dump(mode="json"))
        logger.info("[self-heal] Granted code skills to CTO '%s'", agent.config.name)


# ── Orchestration ─────────────────────────────────────────────────────────────

async def run_heal(orchestrator, incident_id: str) -> dict:
    """Approved by the user: branch, then dispatch a fix task to the CTO."""
    from .models import AgentMessage
    inc = await database.get_heal_incident(incident_id)
    if not inc:
        return {"ok": False, "error": "incident not found"}
    if inc["status"] in ("in_progress", "healed"):
        return {"ok": True, "status": inc["status"]}

    cto = find_cto(orchestrator)
    if not cto:
        await database.update_heal_incident(incident_id, {"status": "failed", "result": "No engineering agent available"})
        return {"ok": False, "error": "no CTO/engineer agent"}
    await _ensure_code_skills(cto)

    branch = create_heal_branch(incident_id)
    await database.update_heal_incident(incident_id, {
        "status": "in_progress", "branch": branch, "cto_agent_id": cto.config.id,
    })

    instruction = _build_cto_instruction(inc, branch)
    task_id = str(uuid.uuid4())
    await database.create_task({
        "id": task_id,
        "agent_id": cto.config.id,
        "assigned_by": orchestrator._ceo.config.id if orchestrator._ceo else "user",
        "title": f"Self-heal: fix {inc['provider']} LLM invocation",
        "instruction": instruction,
        "task_type": "adhoc",
        "priority": "urgent",
        "status": "in_progress",
        "next_run_at": _now(),
        "started_at": _now(),
        "conversation_id": inc["conversation_id"],
        "context": {"heal_incident_id": incident_id, "branch": branch},
    })
    await orchestrator.bus.publish(AgentMessage(
        from_agent=orchestrator._ceo.config.id if orchestrator._ceo else "user",
        to_agent=cto.config.id,
        content=f"[Task: Self-heal] \n\n{instruction}",
        task_id=task_id,
    ))
    logger.info("[self-heal] Dispatched fix task %s to CTO '%s' on branch %s",
                task_id[:8], cto.config.name, branch)
    return {"ok": True, "task_id": task_id, "branch": branch, "cto": cto.config.name}


async def finalize_heal(orchestrator, incident_id: str, result: str) -> None:
    """The CTO finished its fix task — commit the working tree to the heal branch."""
    inc = await database.get_heal_incident(incident_id)
    if not inc or inc["status"] == "healed":
        return
    sha = commit_heal(inc.get("branch", ""), inc)
    status = "healed" if sha else "failed"
    await database.update_heal_incident(incident_id, {
        "status": status, "result": (f"Committed {sha} on {inc['branch']}. " if sha else "No changes committed. ") + (result or "")[:500],
    })
    logger.info("[self-heal] Incident %s -> %s (%s)", incident_id, status, sha or "no commit")
    if orchestrator and orchestrator._ws_broadcast:
        from .models import WSEvent, WSEventType
        msg = (f"✅ The CTO patched the code for **{inc['provider']}** and committed it to branch "
               f"`{inc['branch']}` ({sha}). The fix is live — try again. "
               "Roll back any time with `git checkout` of that branch."
               if sha else
               f"⚠️ The CTO investigated **{inc['provider']}** but produced no code change. {(result or '')[:300]}")
        await orchestrator._ws_broadcast(WSEvent(
            type=WSEventType.SELF_HEAL,
            payload={"kind": "result", "incident_id": incident_id, "status": status,
                     "message": msg, "conversation_id": inc["conversation_id"], "sha": sha},
        ).model_dump_json())


def _now() -> str:
    from datetime import datetime
    return datetime.utcnow().isoformat()


def _build_cto_instruction(inc: dict, branch: str) -> str:
    return f"""You are the CTO. A live LLM/provider invocation FAILED and you must patch the codebase so it works. This is an autonomous self-heal — fix the actual source code.

## The failure
- Provider: {inc['provider']}
- Model: {inc['model']}
- Base URL: {inc['base_url']}
- Error: {inc['error']}

Traceback:
{inc['traceback'][:3000]}

## The codebase
Repository root: {REPO_ROOT}
LLM adapters live in `backend/llm_adapters/` (one file per provider, e.g. `openai_adapter.py`, `custom_adapter.py`, `ollama_adapter.py`) and the factory is `backend/llm_adapters/factory.py`. Provider request/response shapes are OpenAI-compatible for most custom gateways.

## Your job (use your read_file / list_files / write_file / run_shell tools)
1. Read the relevant adapter file(s) and the factory to understand how this provider is called.
2. Diagnose the error (e.g. an unsupported request parameter, a wrong response shape, an unhandled provider).
3. Patch the source code with write_file so the provider works — keep changes minimal and backwards-compatible; do not break other providers.
4. Optionally sanity-check with run_shell (e.g. `cd {REPO_ROOT} && .venv/bin/python -c "import backend.api.routes"`).
5. Do NOT run any git commands — the system commits your changes to branch `{branch}` automatically when you finish.

When done, give a one-line summary of what you changed and why."""
