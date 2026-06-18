"""
Activity-log skill — lets the Manager answer "what did the system do today?" by
reading the system-wide log of agent tool/MCP/web/etc. calls.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from .. import database

_KIND_VERB = {
    "web": "searched/read the web",
    "mcp": "called an MCP tool",
    "shell": "ran a shell command",
    "browser": "used the browser",
    "risk": "ran a risk/compliance check",
    "file": "read/wrote a file",
    "model": "called a specialist model",
    "task": "worked a task",
    "tool": "used a tool",
}


async def activity_log(hours: float = 24, agent: str = "", limit: int = 80) -> str:
    """Return what agents have done in the last `hours` hours. Optionally filter
    by agent name."""
    try:
        hours = float(hours)
    except Exception:
        hours = 24
    since = (datetime.utcnow() - timedelta(hours=hours)).isoformat()
    rows = await database.get_activity(since_iso=since, limit=int(limit) * 2)
    if agent:
        a = agent.lower()
        rows = [r for r in rows if a in (r.get("agent_name", "").lower())]
    if not rows:
        return f"No agent activity in the last {hours:g} hours{f' for {agent}' if agent else ''}."
    rows = rows[: int(limit)]
    lines = [f"Agent activity — last {hours:g}h ({len(rows)} entries, newest first):"]
    for r in rows:
        ts = (r.get("created_at") or "")[11:16]  # HH:MM (UTC)
        flag = "" if r.get("ok", 1) else " ⚠️failed"
        lines.append(f"- {ts} **{r.get('agent_name') or 'agent'}** {r.get('action','')}: "
                     f"{r.get('summary','')[:160]}{flag}")
    return "\n".join(lines)
