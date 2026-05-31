"""
Manage per-agent data folders under <data_dir>/agents/<slug>/
Each agent gets: agent.md, soul.md, memory.md, skills.md
"""
from __future__ import annotations
import re
import shutil
from pathlib import Path


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "agent"


def agents_root(data_dir: str) -> Path:
    return Path(data_dir) / "agents"


def agent_dir(data_dir: str, agent_name: str) -> Path:
    return agents_root(data_dir) / _slugify(agent_name)


def ensure_agent_folder(data_dir: str, agent_name: str, agent_role: str = "", agent_description: str = "") -> Path:
    d = agent_dir(data_dir, agent_name)
    d.mkdir(parents=True, exist_ok=True)

    _write_if_missing(d / "agent.md", f"# {agent_name}\n\n**Role:** {agent_role}\n\n**Description:** {agent_description}\n")
    _write_if_missing(d / "soul.md", f"# Soul — {agent_name}\n\nCore identity, values, and personality traits.\n")
    _write_if_missing(d / "memory.md", f"# Memory — {agent_name}\n\nPersistent memories and learned context.\n")
    _write_if_missing(d / "skills.md", f"# Skills — {agent_name}\n\nCapabilities and tools this agent can use.\n")

    return d


def remove_agent_folder(data_dir: str, agent_name: str) -> None:
    d = agent_dir(data_dir, agent_name)
    if d.exists():
        shutil.rmtree(d)


def remove_all_agent_folders(data_dir: str) -> None:
    root = agents_root(data_dir)
    if root.exists():
        shutil.rmtree(root)


def _write_if_missing(path: Path, content: str) -> None:
    if not path.exists():
        path.write_text(content)
