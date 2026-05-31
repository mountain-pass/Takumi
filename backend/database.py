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

CREATE TABLE IF NOT EXISTS agent_connections (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    to_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    label     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_id, to_id)
);

CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT 'New conversation',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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


# ── Agents ────────────────────────────────────────────────────────────────────

async def save_agent(agent: dict) -> None:
    skills = json.dumps(agent.get("skills", []))
    await _conn().execute(
        """INSERT INTO agents(id, name, role, description, system_prompt,
           llm_provider, llm_model, skills, is_ceo, avatar_color,
           max_context_messages, canvas_x, canvas_y)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, role=excluded.role, description=excluded.description,
             system_prompt=excluded.system_prompt, llm_provider=excluded.llm_provider,
             llm_model=excluded.llm_model, skills=excluded.skills, is_ceo=excluded.is_ceo,
             avatar_color=excluded.avatar_color, max_context_messages=excluded.max_context_messages,
             canvas_x=excluded.canvas_x, canvas_y=excluded.canvas_y""",
        (
            agent["id"], agent["name"], agent.get("role", ""),
            agent.get("description", ""), agent.get("system_prompt", ""),
            agent.get("llm_provider", "anthropic"), agent.get("llm_model", ""),
            skills, int(agent.get("is_ceo", False)),
            agent.get("avatar_color", "#4F46E5"),
            agent.get("max_context_messages", 20),
            agent.get("canvas_x", 0), agent.get("canvas_y", 0),
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
        result.append(d)
    return result


async def delete_agent(agent_id: str) -> None:
    await _conn().execute("DELETE FROM agents WHERE id = ?", (agent_id,))
    await _conn().commit()


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

async def create_conversation(conv_id: str, title: str = "New conversation") -> dict:
    now = datetime.utcnow().isoformat()
    await _conn().execute(
        "INSERT INTO conversations(id, title, created_at, updated_at) VALUES(?, ?, ?, ?)",
        (conv_id, title, now, now),
    )
    await _conn().commit()
    return {"id": conv_id, "title": title, "created_at": now, "updated_at": now}


async def get_conversations(limit: int = 50) -> list[dict]:
    rows = await (await _conn().execute(
        "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?", (limit,)
    )).fetchall()
    return [dict(r) for r in rows]


async def update_conversation(conv_id: str, title: str) -> None:
    await _conn().execute(
        "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?",
        (title, conv_id),
    )
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
    """One-time import from legacy JSON files into SQLite."""
    import os

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
