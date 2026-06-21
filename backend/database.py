"""
SQLite persistence layer for Takumi.
Stores org settings, API keys, agents, canvas layout, connections,
conversations, and all messages (user↔agent and agent↔agent).
"""
from __future__ import annotations

import json
import aiosqlite
from pathlib import Path
from datetime import datetime
from typing import Any

_DB_NAME = "takumi.db"
_db_path: str = ""
_db: aiosqlite.Connection | None = None


SCHEMA = """
CREATE TABLE IF NOT EXISTS org_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    provider TEXT PRIMARY KEY,
    api_key  TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    role                 TEXT NOT NULL DEFAULT '',
    description          TEXT NOT NULL DEFAULT '',
    system_prompt        TEXT NOT NULL DEFAULT '',
    llm_provider         TEXT NOT NULL DEFAULT 'anthropic',
    llm_model            TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    skills               TEXT NOT NULL DEFAULT '[]',
    is_ceo               INTEGER NOT NULL DEFAULT 0,
    avatar_color         TEXT NOT NULL DEFAULT '#4F46E5',
    max_context_messages INTEGER NOT NULL DEFAULT 20,
    canvas_x             REAL NOT NULL DEFAULT 0,
    canvas_y             REAL NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_providers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'llm',
    provider   TEXT NOT NULL DEFAULT '',
    api_key    TEXT NOT NULL DEFAULT '',
    base_url   TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_connections (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    to_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    label     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_id, to_id)
);

CREATE TABLE IF NOT EXISTS mcp_servers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    transport  TEXT NOT NULL DEFAULT 'stdio',   -- 'stdio' | 'http' | 'sse'
    command    TEXT NOT NULL DEFAULT '',         -- stdio: executable
    args       TEXT NOT NULL DEFAULT '[]',       -- stdio: JSON array
    env        TEXT NOT NULL DEFAULT '{}',       -- stdio: JSON object
    url        TEXT NOT NULL DEFAULT '',          -- http/sse: server URL
    headers    TEXT NOT NULL DEFAULT '{}',        -- http/sse: JSON object
    auth       TEXT NOT NULL DEFAULT 'none',       -- 'none' | 'oauth'
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS heal_incidents (
    id            TEXT PRIMARY KEY,
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|in_progress|healed|failed|dismissed
    conversation_id TEXT,
    agent_id      TEXT NOT NULL DEFAULT '',
    provider      TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    base_url      TEXT NOT NULL DEFAULT '',
    error         TEXT NOT NULL DEFAULT '',
    traceback     TEXT NOT NULL DEFAULT '',
    branch        TEXT NOT NULL DEFAULT '',
    cto_agent_id  TEXT NOT NULL DEFAULT '',
    result        TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mcp_oauth (
    server_id   TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
    tokens      TEXT NOT NULL DEFAULT '',   -- OAuthToken JSON
    client_info TEXT NOT NULL DEFAULT '',   -- OAuthClientInformationFull JSON
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT 'New conversation',
    is_temporary INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artifacts (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT,
    task_id         TEXT,
    agent_id        TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL DEFAULT 'Artifact',
    kind            TEXT NOT NULL DEFAULT 'html',
    content         TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    from_agent_id   TEXT NOT NULL,
    to_agent_id     TEXT NOT NULL,
    content         TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'assistant',
    task_id         TEXT,
    metadata        TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_agents ON messages(from_agent_id, to_agent_id);

CREATE TABLE IF NOT EXISTS agent_tasks (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    assigned_by     TEXT NOT NULL DEFAULT 'user',
    title           TEXT NOT NULL,
    instruction     TEXT NOT NULL DEFAULT '',
    task_type       TEXT NOT NULL DEFAULT 'adhoc',
    priority        TEXT NOT NULL DEFAULT 'normal',
    status          TEXT NOT NULL DEFAULT 'pending',
    schedule_cron   TEXT,
    schedule_human  TEXT,
    next_run_at     TEXT,
    last_run_at     TEXT,
    result          TEXT,
    parent_task_id  TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    token_count     INTEGER NOT NULL DEFAULT 0,
    run_count       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    started_at      TEXT,
    completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent ON agent_tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_next_run ON agent_tasks(next_run_at);

CREATE TABLE IF NOT EXISTS agent_task_logs (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    agent_id    TEXT NOT NULL,
    action      TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    token_count INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_logs_task ON agent_task_logs(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_logs_agent ON agent_task_logs(agent_id, created_at);

CREATE TABLE IF NOT EXISTS risk_assessments (
    id           TEXT PRIMARY KEY,
    task_id      TEXT,
    assessor_id  TEXT NOT NULL DEFAULT '',
    subject      TEXT NOT NULL DEFAULT '',
    score        INTEGER NOT NULL DEFAULT 0,
    level        TEXT NOT NULL DEFAULT 'low',
    threshold    INTEGER NOT NULL DEFAULT 10,
    verdict      TEXT NOT NULL DEFAULT 'proceed',  -- proceed | review | block
    decision     TEXT NOT NULL DEFAULT 'proceed',  -- proceed | remediated | held | approved | rejected
    categories   TEXT NOT NULL DEFAULT '{}',
    findings     TEXT NOT NULL DEFAULT '[]',
    rationale    TEXT NOT NULL DEFAULT '',
    attempt      INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_risk_task ON risk_assessments(task_id, created_at);

CREATE TABLE IF NOT EXISTS activity_log (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL DEFAULT '',
    agent_name  TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT 'tool',   -- tool | web | mcp | shell | browser | risk | task | model
    action      TEXT NOT NULL DEFAULT '',
    summary     TEXT NOT NULL DEFAULT '',
    task_id     TEXT,
    ok          INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_log(agent_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL DEFAULT 'info',   -- alert | info | success
    title       TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    action      TEXT NOT NULL DEFAULT '',        -- button label, e.g. "View result"
    link_view   TEXT NOT NULL DEFAULT '',        -- nav target: chat | risk | skills | ...
    link_id     TEXT NOT NULL DEFAULT '',        -- e.g. conversation id to open
    dedupe_key  TEXT NOT NULL DEFAULT '',        -- collapse repeat notifications
    read        INTEGER NOT NULL DEFAULT 0,
    dismissed   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_live ON notifications(dismissed, created_at);

CREATE TABLE IF NOT EXISTS risk_policies (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    summary     TEXT NOT NULL DEFAULT '',
    threshold   INTEGER NOT NULL DEFAULT 10,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


async def init(data_dir: str) -> None:
    global _db_path, _db
    p = Path(data_dir)
    p.mkdir(parents=True, exist_ok=True)
    _db_path = str(p / _DB_NAME)
    _db = await aiosqlite.connect(_db_path)
    _db.row_factory = aiosqlite.Row
    await _db.execute("PRAGMA journal_mode=WAL")
    await _db.execute("PRAGMA foreign_keys=ON")
    await _db.executescript(SCHEMA)
    # Migrations for existing DBs
    for migration in [
        "ALTER TABLE agents ADD COLUMN api_provider_id TEXT REFERENCES api_providers(id)",
        "ALTER TABLE conversations ADD COLUMN is_temporary INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE agent_tasks ADD COLUMN depends_on TEXT",
        "ALTER TABLE mcp_servers ADD COLUMN auth TEXT NOT NULL DEFAULT 'none'",
        "ALTER TABLE agents ADD COLUMN personality TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE agents ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 10",
        "ALTER TABLE agents ADD COLUMN token_budget INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE agents ADD COLUMN hitl_enabled INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE agents ADD COLUMN hitl_triggers TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE agent_tasks ADD COLUMN context TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE agents ADD COLUMN extra_models TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE agent_tasks ADD COLUMN daily_sop INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE risk_policies ADD COLUMN transcript TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE risk_policies ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE risk_policies ADD COLUMN review_frequency_months INTEGER NOT NULL DEFAULT 12",
        "ALTER TABLE risk_policies ADD COLUMN last_reviewed TEXT",
        "ALTER TABLE risk_policies ADD COLUMN review_due INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE risk_policies ADD COLUMN review_reason TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE risk_policies ADD COLUMN rationale TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE risk_policies ADD COLUMN impact_table TEXT NOT NULL DEFAULT '[]'",
        # Liveness heartbeat + escalation tracking for the task watchdog.
        "ALTER TABLE agent_tasks ADD COLUMN last_heartbeat TEXT",
        "ALTER TABLE agent_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE agent_tasks ADD COLUMN watchdog_flags TEXT NOT NULL DEFAULT '{}'",
    ]:
        try:
            await _db.execute(migration)
        except Exception:
            pass
    await _db.commit()


async def close() -> None:
    global _db
    if _db:
        await _db.close()
        _db = None


def _conn() -> aiosqlite.Connection:
    if not _db:
        raise RuntimeError("Database not initialised — call database.init() first")
    return _db


# ── Org settings ──────────────────────────────────────────────────────────────

async def get_setting(key: str, default: str = "") -> str:
    row = await (await _conn().execute(
        "SELECT value FROM org_settings WHERE key = ?", (key,)
    )).fetchone()
    return row["value"] if row else default


async def set_setting(key: str, value: str) -> None:
    await _conn().execute(
        "INSERT INTO org_settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    await _conn().commit()


async def get_all_settings() -> dict[str, str]:
    rows = await (await _conn().execute("SELECT key, value FROM org_settings")).fetchall()
    return {r["key"]: r["value"] for r in rows}


async def set_many_settings(data: dict[str, str]) -> None:
    db = _conn()
    for k, v in data.items():
        await db.execute(
            "INSERT INTO org_settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (k, str(v)),
        )
    await db.commit()


# ── API keys ──────────────────────────────────────────────────────────────────

async def save_api_key(provider: str, api_key: str, base_url: str = "") -> None:
    await _conn().execute(
        "INSERT INTO api_keys(provider, api_key, base_url, updated_at) VALUES(?, ?, ?, datetime('now')) "
        "ON CONFLICT(provider) DO UPDATE SET api_key=excluded.api_key, base_url=excluded.base_url, updated_at=datetime('now')",
        (provider, api_key, base_url),
    )
    await _conn().commit()


async def get_api_key(provider: str) -> dict | None:
    row = await (await _conn().execute(
        "SELECT provider, api_key, base_url FROM api_keys WHERE provider = ?", (provider,)
    )).fetchone()
    return dict(row) if row else None


async def get_all_api_keys() -> list[dict]:
    rows = await (await _conn().execute("SELECT provider, api_key, base_url FROM api_keys")).fetchall()
    return [dict(r) for r in rows]


# ── API Providers ─────────────────────────────────────────────────────────────

async def create_api_provider(provider: dict) -> dict:
    await _conn().execute(
        "INSERT INTO api_providers(id, name, type, provider, api_key, base_url) VALUES(?, ?, ?, ?, ?, ?)",
        (provider["id"], provider["name"], provider.get("type", "llm"),
         provider.get("provider", ""), provider.get("api_key", ""), provider.get("base_url", "")),
    )
    await _conn().commit()
    return provider


async def get_all_api_providers() -> list[dict]:
    rows = await (await _conn().execute(
        "SELECT id, name, type, provider, api_key, base_url, created_at FROM api_providers ORDER BY created_at"
    )).fetchall()
    return [dict(r) for r in rows]


async def update_api_provider(provider_id: str, updates: dict) -> dict | None:
    row = await (await _conn().execute(
        "SELECT * FROM api_providers WHERE id = ?", (provider_id,)
    )).fetchone()
    if not row:
        return None
    current = dict(row)
    current.update({k: v for k, v in updates.items() if v is not None})
    await _conn().execute(
        "UPDATE api_providers SET name=?, type=?, provider=?, api_key=?, base_url=? WHERE id=?",
        (current["name"], current["type"], current["provider"],
         current["api_key"], current["base_url"], provider_id),
    )
    await _conn().commit()
    return current


async def get_api_provider(provider_id: str) -> dict | None:
    row = await (await _conn().execute(
        "SELECT id, name, type, provider, api_key, base_url, created_at FROM api_providers WHERE id = ?",
        (provider_id,),
    )).fetchone()
    return dict(row) if row else None


async def delete_api_provider(provider_id: str) -> None:
    await _conn().execute("DELETE FROM api_providers WHERE id = ?", (provider_id,))
    await _conn().commit()


# ── Agents ────────────────────────────────────────────────────────────────────

async def save_agent(agent: dict) -> None:
    skills = json.dumps(agent.get("skills", []))
    hitl_triggers = json.dumps(agent.get("hitl_triggers", []))
    extra_models = json.dumps(agent.get("extra_models", []))
    await _conn().execute(
        """INSERT INTO agents(id, name, role, description, system_prompt,
           llm_provider, llm_model, skills, is_ceo, avatar_color,
           max_context_messages, canvas_x, canvas_y, api_provider_id,
           personality, max_iterations, token_budget, hitl_enabled, hitl_triggers, extra_models)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, role=excluded.role, description=excluded.description,
             system_prompt=excluded.system_prompt, llm_provider=excluded.llm_provider,
             llm_model=excluded.llm_model, skills=excluded.skills, is_ceo=excluded.is_ceo,
             avatar_color=excluded.avatar_color, max_context_messages=excluded.max_context_messages,
             canvas_x=excluded.canvas_x, canvas_y=excluded.canvas_y,
             api_provider_id=excluded.api_provider_id,
             personality=excluded.personality, max_iterations=excluded.max_iterations,
             token_budget=excluded.token_budget, hitl_enabled=excluded.hitl_enabled,
             hitl_triggers=excluded.hitl_triggers, extra_models=excluded.extra_models""",
        (
            agent["id"], agent["name"], agent.get("role", ""),
            agent.get("description", ""), agent.get("system_prompt", ""),
            agent.get("llm_provider", "anthropic"), agent.get("llm_model", ""),
            skills, int(agent.get("is_ceo", False)),
            agent.get("avatar_color", "#4F46E5"),
            agent.get("max_context_messages", 20),
            agent.get("canvas_x", 0), agent.get("canvas_y", 0),
            agent.get("api_provider_id"),
            agent.get("personality", ""), agent.get("max_iterations", 10),
            agent.get("token_budget", 0), int(agent.get("hitl_enabled", False)),
            hitl_triggers, extra_models,
        ),
    )
    await _conn().commit()


async def get_all_agents() -> list[dict]:
    rows = await (await _conn().execute(
        "SELECT * FROM agents ORDER BY is_ceo DESC, created_at"
    )).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["skills"] = json.loads(d["skills"])
        d["is_ceo"] = bool(d["is_ceo"])
        d["hitl_enabled"] = bool(d.get("hitl_enabled", 0))
        d["hitl_triggers"] = json.loads(d.get("hitl_triggers") or "[]")
        d["extra_models"] = json.loads(d.get("extra_models") or "[]")
        result.append(d)
    return result


async def delete_agent(agent_id: str) -> None:
    await _conn().execute("DELETE FROM agents WHERE id = ?", (agent_id,))
    await _conn().commit()


async def migrate_rename_ceo() -> None:
    """One-time: rename the lead agent from the old 'CEO' default to 'Manager'.

    Guarded by a setting flag so it only relabels the default and won't override
    a name the user later chooses.
    """
    if await get_setting("_ceo_renamed") == "1":
        return
    await _conn().execute(
        """UPDATE agents
              SET name = 'Manager'
            WHERE is_ceo = 1 AND name = 'CEO'""",
    )
    await _conn().execute(
        """UPDATE agents
              SET role = 'Manager'
            WHERE is_ceo = 1 AND role = 'Chief Executive Officer'""",
    )
    await _conn().commit()
    await set_setting("_ceo_renamed", "1")


# ── MCP servers ───────────────────────────────────────────────────────────────

def _row_to_mcp(r) -> dict:
    d = dict(r)
    d["args"] = json.loads(d.get("args") or "[]")
    d["env"] = json.loads(d.get("env") or "{}")
    d["headers"] = json.loads(d.get("headers") or "{}")
    d["enabled"] = bool(d["enabled"])
    d["auth"] = d.get("auth") or "none"
    return d


async def get_all_mcp_servers() -> list[dict]:
    rows = await (await _conn().execute(
        "SELECT * FROM mcp_servers ORDER BY created_at"
    )).fetchall()
    return [_row_to_mcp(r) for r in rows]


async def get_mcp_server(server_id: str) -> dict | None:
    row = await (await _conn().execute(
        "SELECT * FROM mcp_servers WHERE id = ?", (server_id,)
    )).fetchone()
    return _row_to_mcp(row) if row else None


async def save_mcp_server(s: dict) -> None:
    await _conn().execute(
        """INSERT INTO mcp_servers(id, name, transport, command, args, env, url, headers, auth, enabled)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, transport=excluded.transport, command=excluded.command,
             args=excluded.args, env=excluded.env, url=excluded.url,
             headers=excluded.headers, auth=excluded.auth, enabled=excluded.enabled""",
        (
            s["id"], s["name"], s.get("transport", "stdio"),
            s.get("command", ""), json.dumps(s.get("args", [])),
            json.dumps(s.get("env", {})), s.get("url", ""),
            json.dumps(s.get("headers", {})), s.get("auth", "none"),
            int(s.get("enabled", True)),
        ),
    )
    await _conn().commit()


async def delete_mcp_server(server_id: str) -> None:
    await _conn().execute("DELETE FROM mcp_servers WHERE id = ?", (server_id,))
    await _conn().commit()


# ── MCP OAuth token storage ───────────────────────────────────────────────────

async def get_mcp_oauth(server_id: str) -> dict:
    """Return {'tokens': <json str or ''>, 'client_info': <json str or ''>}."""
    row = await (await _conn().execute(
        "SELECT tokens, client_info FROM mcp_oauth WHERE server_id = ?", (server_id,)
    )).fetchone()
    if not row:
        return {"tokens": "", "client_info": ""}
    return {"tokens": row["tokens"] or "", "client_info": row["client_info"] or ""}


async def set_mcp_oauth(server_id: str, *, tokens: str | None = None,
                        client_info: str | None = None) -> None:
    cur = await get_mcp_oauth(server_id)
    t = tokens if tokens is not None else cur["tokens"]
    c = client_info if client_info is not None else cur["client_info"]
    await _conn().execute(
        """INSERT INTO mcp_oauth(server_id, tokens, client_info, updated_at)
           VALUES(?, ?, ?, datetime('now'))
           ON CONFLICT(server_id) DO UPDATE SET
             tokens=excluded.tokens, client_info=excluded.client_info,
             updated_at=excluded.updated_at""",
        (server_id, t, c),
    )
    await _conn().commit()


async def clear_mcp_oauth(server_id: str) -> None:
    await _conn().execute("DELETE FROM mcp_oauth WHERE server_id = ?", (server_id,))
    await _conn().commit()


# ── Self-heal incidents ───────────────────────────────────────────────────────

async def save_heal_incident(inc: dict) -> None:
    await _conn().execute(
        """INSERT INTO heal_incidents(id, status, conversation_id, agent_id, provider,
              model, base_url, error, traceback, branch, cto_agent_id, result)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status=excluded.status, branch=excluded.branch, cto_agent_id=excluded.cto_agent_id,
             result=excluded.result, updated_at=datetime('now')""",
        (
            inc["id"], inc.get("status", "pending"), inc.get("conversation_id"),
            inc.get("agent_id", ""), inc.get("provider", ""), inc.get("model", ""),
            inc.get("base_url", ""), inc.get("error", ""), inc.get("traceback", ""),
            inc.get("branch", ""), inc.get("cto_agent_id", ""), inc.get("result", ""),
        ),
    )
    await _conn().commit()


async def get_heal_incident(incident_id: str) -> dict | None:
    row = await (await _conn().execute(
        "SELECT * FROM heal_incidents WHERE id = ?", (incident_id,)
    )).fetchone()
    return dict(row) if row else None


async def get_heal_incidents(limit: int = 50) -> list[dict]:
    rows = await (await _conn().execute(
        "SELECT * FROM heal_incidents ORDER BY created_at DESC LIMIT ?", (limit,)
    )).fetchall()
    return [dict(r) for r in rows]


async def update_heal_incident(incident_id: str, updates: dict) -> None:
    cols = ", ".join(f"{k}=?" for k in updates)
    await _conn().execute(
        f"UPDATE heal_incidents SET {cols}, updated_at=datetime('now') WHERE id=?",
        (*updates.values(), incident_id),
    )
    await _conn().commit()


# ── Artifacts (rich HTML output for the viewer pane) ──────────────────────────

async def save_artifact(artifact: dict) -> None:
    await _conn().execute(
        """INSERT INTO artifacts(id, conversation_id, task_id, agent_id, title, kind, content)
           VALUES(?, ?, ?, ?, ?, ?, ?)""",
        (
            artifact["id"], artifact.get("conversation_id"), artifact.get("task_id"),
            artifact.get("agent_id", ""), artifact.get("title", "Artifact"),
            artifact.get("kind", "html"), artifact.get("content", ""),
        ),
    )
    await _conn().commit()


async def get_artifact(artifact_id: str) -> dict | None:
    row = await (await _conn().execute(
        "SELECT * FROM artifacts WHERE id = ?", (artifact_id,)
    )).fetchone()
    return dict(row) if row else None


async def get_artifacts_for_tasks(task_ids: list[str]) -> list[dict]:
    if not task_ids:
        return []
    placeholders = ",".join("?" * len(task_ids))
    rows = await (await _conn().execute(
        f"SELECT id, title, kind, agent_id, task_id FROM artifacts WHERE task_id IN ({placeholders}) ORDER BY created_at",
        task_ids,
    )).fetchall()
    return [dict(r) for r in rows]


# ── Agent connections (canvas) ────────────────────────────────────────────────

async def save_connection(from_id: str, to_id: str, label: str = "") -> int:
    cur = await _conn().execute(
        "INSERT INTO agent_connections(from_id, to_id, label) VALUES(?, ?, ?) "
        "ON CONFLICT(from_id, to_id) DO UPDATE SET label=excluded.label",
        (from_id, to_id, label),
    )
    await _conn().commit()
    return cur.lastrowid


async def get_all_connections() -> list[dict]:
    rows = await (await _conn().execute(
        "SELECT id, from_id, to_id, label FROM agent_connections"
    )).fetchall()
    return [dict(r) for r in rows]


async def delete_connection(from_id: str, to_id: str) -> None:
    await _conn().execute(
        "DELETE FROM agent_connections WHERE from_id = ? AND to_id = ?",
        (from_id, to_id),
    )
    await _conn().commit()


async def update_connection_label(from_id: str, to_id: str, label: str) -> None:
    await _conn().execute(
        "UPDATE agent_connections SET label = ? WHERE from_id = ? AND to_id = ?",
        (label, from_id, to_id),
    )
    await _conn().commit()


# ── Canvas positions ──────────────────────────────────────────────────────────

async def save_canvas_position(agent_id: str, x: float, y: float) -> None:
    await _conn().execute(
        "UPDATE agents SET canvas_x = ?, canvas_y = ? WHERE id = ?",
        (x, y, agent_id),
    )
    await _conn().commit()


async def save_all_canvas_positions(positions: dict[str, dict]) -> None:
    db = _conn()
    for agent_id, pos in positions.items():
        await db.execute(
            "UPDATE agents SET canvas_x = ?, canvas_y = ? WHERE id = ?",
            (pos["x"], pos["y"], agent_id),
        )
    await db.commit()


# ── Conversations ─────────────────────────────────────────────────────────────

async def create_conversation(conv_id: str, title: str = "New conversation", is_temporary: bool = False) -> dict:
    now = datetime.utcnow().isoformat()
    await _conn().execute(
        "INSERT INTO conversations(id, title, is_temporary, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
        (conv_id, title, int(is_temporary), now, now),
    )
    await _conn().commit()
    return {"id": conv_id, "title": title, "is_temporary": is_temporary, "created_at": now, "updated_at": now}


async def get_conversation(conv_id: str) -> dict | None:
    row = await (await _conn().execute(
        "SELECT * FROM conversations WHERE id = ?", (conv_id,)
    )).fetchone()
    return dict(row) if row else None


async def get_conversations(limit: int = 50) -> list[dict]:
    rows = await (await _conn().execute(
        "SELECT * FROM conversations WHERE is_temporary = 0 ORDER BY updated_at DESC LIMIT ?", (limit,)
    )).fetchall()
    return [dict(r) for r in rows]


async def update_conversation(conv_id: str, title: str) -> None:
    await _conn().execute(
        "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?",
        (title, conv_id),
    )
    await _conn().commit()


async def delete_conversation(conv_id: str) -> None:
    await _conn().execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
    await _conn().execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
    await _conn().commit()


# ── Messages ──────────────────────────────────────────────────────────────────

async def save_message(msg: dict) -> None:
    metadata = json.dumps(msg.get("metadata", {}))
    await _conn().execute(
        """INSERT INTO messages(id, conversation_id, from_agent_id, to_agent_id,
           content, role, task_id, metadata, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            msg["id"],
            msg.get("conversation_id"),
            msg["from_agent_id"],
            msg["to_agent_id"],
            msg["content"],
            msg.get("role", "assistant"),
            msg.get("task_id"),
            metadata,
            msg.get("created_at", datetime.utcnow().isoformat()),
        ),
    )
    await _conn().commit()


async def get_messages(
    conversation_id: str | None = None,
    from_agent_id: str | None = None,
    to_agent_id: str | None = None,
    limit: int = 100,
) -> list[dict]:
    conditions = []
    params: list[Any] = []

    if conversation_id:
        conditions.append("conversation_id = ?")
        params.append(conversation_id)
    if from_agent_id:
        conditions.append("from_agent_id = ?")
        params.append(from_agent_id)
    if to_agent_id:
        conditions.append("to_agent_id = ?")
        params.append(to_agent_id)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    rows = await (await _conn().execute(
        f"SELECT * FROM messages {where} ORDER BY created_at ASC LIMIT ?",
        params + [limit],
    )).fetchall()

    result = []
    for r in rows:
        d = dict(r)
        d["metadata"] = json.loads(d["metadata"])
        result.append(d)
    return result


# ── Agent Tasks ──────────────────────────────────────────────────────────────

async def can_assign_task(from_agent_id: str, to_agent_id: str) -> bool:
    """Check if from_agent has a connection to to_agent (directional)."""
    if from_agent_id == "user":
        return True  # user can assign to anyone
    row = await (await _conn().execute(
        "SELECT 1 FROM agent_connections WHERE from_id = ? AND to_id = ?",
        (from_agent_id, to_agent_id),
    )).fetchone()
    return row is not None


async def create_task(task: dict) -> dict:
    await _conn().execute(
        """INSERT INTO agent_tasks(
            id, agent_id, assigned_by, title, instruction, task_type,
            priority, status, schedule_cron, schedule_human, next_run_at,
            parent_task_id, conversation_id, depends_on, context, daily_sop
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            task["id"], task["agent_id"], task.get("assigned_by", "user"),
            task["title"], task.get("instruction", ""),
            task.get("task_type", "adhoc"), task.get("priority", "normal"),
            task.get("status", "pending"), task.get("schedule_cron"),
            task.get("schedule_human"), task.get("next_run_at"),
            task.get("parent_task_id"), task.get("conversation_id"),
            task.get("depends_on"),
            json.dumps(task.get("context", {})) if not isinstance(task.get("context"), str) else task.get("context", "{}"),
            int(task.get("daily_sop", 0)),
        ),
    )
    await _conn().commit()
    return task


async def get_task(task_id: str) -> dict | None:
    row = await (await _conn().execute(
        "SELECT * FROM agent_tasks WHERE id = ?", (task_id,)
    )).fetchone()
    return dict(row) if row else None


async def get_tasks_for_agent(agent_id: str, status: str | None = None) -> list[dict]:
    if status:
        rows = await (await _conn().execute(
            "SELECT * FROM agent_tasks WHERE agent_id = ? AND status = ? ORDER BY created_at DESC",
            (agent_id, status),
        )).fetchall()
    else:
        rows = await (await _conn().execute(
            "SELECT * FROM agent_tasks WHERE agent_id = ? ORDER BY created_at DESC",
            (agent_id,),
        )).fetchall()
    return [dict(r) for r in rows]


async def get_all_tasks(status: str | None = None, limit: int = 100) -> list[dict]:
    if status:
        rows = await (await _conn().execute(
            "SELECT * FROM agent_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?",
            (status, limit),
        )).fetchall()
    else:
        rows = await (await _conn().execute(
            "SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT ?", (limit,)
        )).fetchall()
    return [dict(r) for r in rows]


# ── Activity log (system-wide) ────────────────────────────────────────────────

async def log_activity(entry: dict) -> None:
    import uuid as _uuid
    try:
        await _conn().execute(
            """INSERT INTO activity_log(id, agent_id, agent_name, kind, action, summary, task_id, ok)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
            (entry.get("id") or _uuid.uuid4().hex, entry.get("agent_id", ""),
             entry.get("agent_name", ""), entry.get("kind", "tool"),
             entry.get("action", "")[:120], entry.get("summary", "")[:600],
             entry.get("task_id"), int(entry.get("ok", 1))),
        )
        await _conn().commit()
    except Exception:
        pass  # logging must never break the agent


async def get_activity(since_iso: str | None = None, agent_id: str | None = None,
                       limit: int = 200) -> list[dict]:
    q = "SELECT * FROM activity_log"
    cond, args = [], []
    if since_iso:
        # created_at is stored as SQLite datetime('now') ("YYYY-MM-DD HH:MM:SS"),
        # so normalise the ISO 'T' separator for a correct string comparison.
        cond.append("created_at >= ?"); args.append(str(since_iso).replace("T", " "))
    if agent_id:
        cond.append("agent_id = ?"); args.append(agent_id)
    if cond:
        q += " WHERE " + " AND ".join(cond)
    q += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit)
    rows = await (await _conn().execute(q, tuple(args))).fetchall()
    return [dict(r) for r in rows]


# ── Notifications (user-facing) ───────────────────────────────────────────────

async def add_notification(entry: dict) -> dict:
    """Insert a notification. If a non-empty dedupe_key matches an existing
    non-dismissed row, refresh that row instead of stacking duplicates."""
    import uuid as _uuid
    dedupe = (entry.get("dedupe_key") or "").strip()
    if dedupe:
        row = await (await _conn().execute(
            "SELECT id FROM notifications WHERE dedupe_key = ? AND dismissed = 0 LIMIT 1",
            (dedupe,),
        )).fetchone()
        if row:
            await _conn().execute(
                """UPDATE notifications SET type=?, title=?, body=?, action=?,
                   link_view=?, link_id=?, read=0, created_at=datetime('now') WHERE id=?""",
                (entry.get("type", "info"), entry.get("title", ""), entry.get("body", ""),
                 entry.get("action", ""), entry.get("link_view", ""), entry.get("link_id", ""),
                 row["id"]),
            )
            await _conn().commit()
            return await get_notification(row["id"])
    nid = entry.get("id") or _uuid.uuid4().hex
    await _conn().execute(
        """INSERT INTO notifications(id, type, title, body, action, link_view, link_id, dedupe_key)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
        (nid, entry.get("type", "info"), entry.get("title", ""), entry.get("body", ""),
         entry.get("action", ""), entry.get("link_view", ""), entry.get("link_id", ""), dedupe),
    )
    await _conn().commit()
    return await get_notification(nid)


async def get_notification(nid: str) -> dict | None:
    row = await (await _conn().execute(
        "SELECT * FROM notifications WHERE id = ?", (nid,)
    )).fetchone()
    return dict(row) if row else None


async def get_notifications(limit: int = 50, include_dismissed: bool = False) -> list[dict]:
    q = "SELECT * FROM notifications"
    if not include_dismissed:
        q += " WHERE dismissed = 0"
    q += " ORDER BY created_at DESC LIMIT ?"
    rows = await (await _conn().execute(q, (limit,))).fetchall()
    return [dict(r) for r in rows]


async def mark_notification_read(nid: str) -> None:
    await _conn().execute("UPDATE notifications SET read = 1 WHERE id = ?", (nid,))
    await _conn().commit()


async def mark_all_notifications_read() -> None:
    await _conn().execute("UPDATE notifications SET read = 1 WHERE dismissed = 0")
    await _conn().commit()


async def dismiss_notification(nid: str) -> None:
    await _conn().execute("UPDATE notifications SET dismissed = 1 WHERE id = ?", (nid,))
    await _conn().commit()


async def clear_notifications() -> None:
    await _conn().execute("UPDATE notifications SET dismissed = 1 WHERE dismissed = 0")
    await _conn().commit()


# ── Risk policies (named) ─────────────────────────────────────────────────────

async def list_risk_policies(enabled_only: bool = False) -> list[dict]:
    q = "SELECT * FROM risk_policies"
    if enabled_only:
        q += " WHERE enabled = 1"
    q += " ORDER BY created_at"
    rows = await (await _conn().execute(q)).fetchall()
    return [dict(r) for r in rows]


async def get_risk_policy_row(policy_id: str) -> dict | None:
    row = await (await _conn().execute(
        "SELECT * FROM risk_policies WHERE id = ?", (policy_id,))).fetchone()
    return dict(row) if row else None


async def save_risk_policy(p: dict) -> None:
    from datetime import date
    await _conn().execute(
        """INSERT INTO risk_policies(id, name, body, summary, threshold, enabled, transcript,
              review_frequency_months, last_reviewed, rationale, impact_table)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, body=excluded.body,
             summary=excluded.summary, threshold=excluded.threshold, enabled=excluded.enabled,
             transcript=excluded.transcript, review_frequency_months=excluded.review_frequency_months,
             rationale=excluded.rationale, impact_table=excluded.impact_table""",
        (p["id"], p.get("name", ""), p.get("body", ""), p.get("summary", ""),
         int(p.get("threshold", 10)), int(p.get("enabled", 1)),
         json.dumps(p.get("transcript", [])) if not isinstance(p.get("transcript"), str) else p.get("transcript", "[]"),
         int(p.get("review_frequency_months", 12)),
         p.get("last_reviewed") or date.today().isoformat(),  # new policy counts as reviewed today
         p.get("rationale", "")[:2000],
         json.dumps(p.get("impact_table", [])) if not isinstance(p.get("impact_table"), str) else p.get("impact_table", "[]")),
    )
    await _conn().commit()


async def mark_policy_reviewed(policy_id: str) -> None:
    from datetime import date
    await _conn().execute(
        "UPDATE risk_policies SET last_reviewed = ?, review_due = 0, review_reason = '' WHERE id = ?",
        (date.today().isoformat(), policy_id))
    await _conn().commit()


async def flag_policy_for_review(policy_id: str, reason: str) -> None:
    await _conn().execute(
        "UPDATE risk_policies SET review_due = 1, review_reason = ? WHERE id = ?",
        (reason[:200], policy_id))
    await _conn().commit()


async def delete_risk_policy(policy_id: str) -> None:
    await _conn().execute("DELETE FROM risk_policies WHERE id = ?", (policy_id,))
    await _conn().commit()


async def set_default_risk_policy(policy_id: str) -> None:
    await _conn().execute("UPDATE risk_policies SET is_default = 0")
    await _conn().execute("UPDATE risk_policies SET is_default = 1 WHERE id = ?", (policy_id,))
    await _conn().commit()


async def get_default_risk_policy() -> dict | None:
    row = await (await _conn().execute(
        "SELECT * FROM risk_policies WHERE is_default = 1 AND enabled = 1 LIMIT 1")).fetchone()
    return dict(row) if row else None


# ── Risk register ─────────────────────────────────────────────────────────────

async def save_risk_assessment(a: dict) -> None:
    await _conn().execute(
        """INSERT INTO risk_assessments(id, task_id, assessor_id, subject, score, level,
              threshold, verdict, decision, categories, findings, rationale, attempt)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            a["id"], a.get("task_id"), a.get("assessor_id", ""), a.get("subject", "")[:300],
            int(a.get("score", 0)), a.get("level", "low"), int(a.get("threshold", 10)),
            a.get("verdict", "proceed"), a.get("decision", "proceed"),
            json.dumps(a.get("categories", {})), json.dumps(a.get("findings", [])),
            a.get("rationale", "")[:2000], int(a.get("attempt", 0)),
        ),
    )
    await _conn().commit()


async def get_risk_assessments(limit: int = 50) -> list[dict]:
    rows = await (await _conn().execute(
        "SELECT * FROM risk_assessments ORDER BY created_at DESC LIMIT ?", (limit,)
    )).fetchall()
    return [_hydrate_risk(dict(r)) for r in rows]


async def get_latest_risk_for_task(task_id: str) -> dict | None:
    row = await (await _conn().execute(
        "SELECT * FROM risk_assessments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
        (task_id,),
    )).fetchone()
    return _hydrate_risk(dict(row)) if row else None


def _hydrate_risk(d: dict) -> dict:
    d["categories"] = json.loads(d.get("categories") or "{}")
    d["findings"] = json.loads(d.get("findings") or "[]")
    return d


async def get_daily_sop_tasks() -> list[dict]:
    """The Manager's MASTER list — all active daily-SOP tasks across agents."""
    rows = await (await _conn().execute(
        "SELECT * FROM agent_tasks WHERE daily_sop = 1 AND status != 'cancelled' "
        "ORDER BY agent_id, created_at"
    )).fetchall()
    return [dict(r) for r in rows]


async def get_due_tasks(now_iso: str) -> list[dict]:
    """Get tasks with next_run_at <= now that are pending or standing."""
    rows = await (await _conn().execute(
        "SELECT * FROM agent_tasks WHERE next_run_at <= ? AND status IN ('pending', 'paused') ORDER BY next_run_at",
        (now_iso,),
    )).fetchall()
    return [dict(r) for r in rows]


async def update_task(task_id: str, updates: dict) -> dict | None:
    row = await (await _conn().execute(
        "SELECT * FROM agent_tasks WHERE id = ?", (task_id,)
    )).fetchone()
    if not row:
        return None
    current = dict(row)
    current.update({k: v for k, v in updates.items() if v is not None})
    ctx = current.get("context", "{}")
    if not isinstance(ctx, str):
        ctx = json.dumps(ctx)
    await _conn().execute(
        """UPDATE agent_tasks SET
            title=?, instruction=?, task_type=?, priority=?, status=?,
            schedule_cron=?, schedule_human=?, next_run_at=?, last_run_at=?,
            result=?, token_count=?, run_count=?, started_at=?, completed_at=?,
            context=?
        WHERE id=?""",
        (
            current["title"], current["instruction"], current["task_type"],
            current["priority"], current["status"], current["schedule_cron"],
            current["schedule_human"], current["next_run_at"], current["last_run_at"],
            current["result"], current["token_count"], current["run_count"],
            current["started_at"], current["completed_at"], ctx, task_id,
        ),
    )
    await _conn().commit()
    return current


# ── Task liveness / watchdog ──────────────────────────────────────────────────

async def touch_task_heartbeat(task_id: str) -> None:
    """Mark a task as still alive — called by the working agent each step. A fresh
    heartbeat means 'slow but progressing'; a stale one means the thread is wedged."""
    try:
        await _conn().execute(
            "UPDATE agent_tasks SET last_heartbeat = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), task_id),
        )
        await _conn().commit()
    except Exception:
        pass


async def set_task_attempts(task_id: str, attempts: int) -> None:
    try:
        await _conn().execute("UPDATE agent_tasks SET attempts = ? WHERE id = ?", (attempts, task_id))
        await _conn().commit()
    except Exception:
        pass


async def set_watchdog_flags(task_id: str, flags: dict) -> None:
    try:
        await _conn().execute("UPDATE agent_tasks SET watchdog_flags = ? WHERE id = ?",
                              (json.dumps(flags), task_id))
        await _conn().commit()
    except Exception:
        pass


# ── Backup / restore ──────────────────────────────────────────────────────────

# Config tables that make up a portable backup (settings, not chat history).
# Ordered so parents are inserted before children (FK-safe).
BACKUP_TABLES = [
    "org_settings", "api_keys", "api_providers",
    "agents", "agent_connections", "mcp_servers", "mcp_oauth",
]


async def export_tables(tables: list[str]) -> dict:
    out = {}
    for t in tables:
        rows = await (await _conn().execute(f"SELECT * FROM {t}")).fetchall()
        out[t] = [dict(r) for r in rows]
    return out


async def import_tables(data: dict, tables: list[str]) -> dict:
    """Replace the given tables with the backed-up rows (FK-safe)."""
    conn = _conn()
    await conn.execute("PRAGMA foreign_keys=OFF")
    counts = {}
    # Clear children first (reverse order).
    for t in reversed(tables):
        await conn.execute(f"DELETE FROM {t}")
    for t in tables:
        rows = data.get(t, []) or []
        for row in rows:
            cols = list(row.keys())
            placeholders = ",".join("?" * len(cols))
            await conn.execute(
                f"INSERT INTO {t} ({','.join(cols)}) VALUES ({placeholders})",
                [row[c] for c in cols],
            )
        counts[t] = len(rows)
    await conn.execute("PRAGMA foreign_keys=ON")
    await conn.commit()
    return counts


async def get_tasks_for_conversation(conversation_id: str) -> list[dict]:
    """All tasks belonging to one chat conversation (a 'plan')."""
    rows = await (await _conn().execute(
        "SELECT * FROM agent_tasks WHERE conversation_id = ? ORDER BY created_at",
        (conversation_id,),
    )).fetchall()
    return [dict(r) for r in rows]


async def delete_task(task_id: str) -> None:
    await _conn().execute("DELETE FROM agent_tasks WHERE id = ?", (task_id,))
    await _conn().commit()


# ── Agent Task Logs ──────────────────────────────────────────────────────────

async def create_task_log(log: dict) -> dict:
    await _conn().execute(
        """INSERT INTO agent_task_logs(id, task_id, agent_id, action, detail, token_count)
           VALUES(?, ?, ?, ?, ?, ?)""",
        (
            log["id"], log["task_id"], log["agent_id"],
            log["action"], log.get("detail", ""), log.get("token_count", 0),
        ),
    )
    await _conn().commit()
    return log


async def get_task_logs(task_id: str, limit: int = 50) -> list[dict]:
    rows = await (await _conn().execute(
        "SELECT * FROM agent_task_logs WHERE task_id = ? ORDER BY created_at ASC LIMIT ?",
        (task_id, limit),
    )).fetchall()
    return [dict(r) for r in rows]


async def get_agent_task_logs(agent_id: str, limit: int = 100) -> list[dict]:
    rows = await (await _conn().execute(
        "SELECT * FROM agent_task_logs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?",
        (agent_id, limit),
    )).fetchall()
    return [dict(r) for r in rows]


# ── Messages (agent-to-agent) ────────────────────────────────────────────────

async def get_agent_to_agent_messages(agent_a: str, agent_b: str, limit: int = 50) -> list[dict]:
    rows = await (await _conn().execute(
        """SELECT * FROM messages
           WHERE (from_agent_id = ? AND to_agent_id = ?)
              OR (from_agent_id = ? AND to_agent_id = ?)
           ORDER BY created_at ASC LIMIT ?""",
        (agent_a, agent_b, agent_b, agent_a, limit),
    )).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["metadata"] = json.loads(d["metadata"])
        result.append(d)
    return result


# ── Migration helper ──────────────────────────────────────────────────────────

async def migrate_from_json(data_dir: str) -> None:
    """One-time import from legacy JSON files into SQLite.

    Guarded so it runs only once: on every subsequent startup the SQLite
    settings are authoritative. Without this guard, organisation.json (which
    holds the original/default org name) would re-overwrite the user's saved
    org name on every restart.
    """
    import os

    if await get_setting("_json_migrated", "") == "1":
        return

    # Migrate runtime_settings.json
    rs_path = Path(data_dir) / "runtime_settings.json"
    if rs_path.exists():
        try:
            rs = json.loads(rs_path.read_text())
            settings_map = {}
            for key in ("org_name", "org_description", "configured"):
                if key in rs:
                    settings_map[key] = str(rs[key])

            if settings_map:
                await set_many_settings(settings_map)

            provider = rs.get("llm_provider", "")
            api_key = rs.get("llm_api_key", "")
            base_url = rs.get("llm_base_url", "")
            if provider and api_key:
                await save_api_key(provider, api_key, base_url)
                await set_setting("default_llm_provider", provider)
                await set_setting("default_llm_model", rs.get("llm_model", ""))

        except Exception:
            pass

    # Migrate organisation.json
    org_path = Path(data_dir) / "organisation.json"
    if org_path.exists():
        try:
            org = json.loads(org_path.read_text())
            for i, agent in enumerate(org.get("agents", [])):
                agent.setdefault("canvas_x", 80 + ((i - 1) % 3) * 260 if not agent.get("is_ceo") else 80)
                agent.setdefault("canvas_y", 60 if agent.get("is_ceo") else 220 + ((i - 1) // 3) * 150)
                await save_agent(agent)

            if org.get("name"):
                await set_setting("org_name", org["name"])
            if org.get("description"):
                await set_setting("org_description", org["description"])

        except Exception:
            pass

    # Mark migration complete so legacy JSON files never re-clobber the
    # authoritative SQLite settings on subsequent restarts.
    await set_setting("_json_migrated", "1")
