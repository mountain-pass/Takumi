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


def ensure_agent_folder(data_dir: str, agent_name: str, agent_role: str = "",
                        agent_description: str = "", system_prompt: str = "") -> Path:
    d = agent_dir(data_dir, agent_name)
    d.mkdir(parents=True, exist_ok=True)

    agent_md = f"# {agent_name}\n\n**Role:** {agent_role}\n\n**Description:** {agent_description}\n"
    if system_prompt:
        agent_md += f"\n---\n\n## System Prompt\n\n{system_prompt}\n"
    (d / "agent.md").write_text(agent_md)

    _write_if_missing(d / "soul.md", f"# Soul — {agent_name}\n\nCore identity, values, and personality traits.\n")
    _write_if_missing(d / "memory.md", f"# Memory — {agent_name}\n\nPersistent memories and learned context.\n")
    _write_if_missing(d / "skills.md", f"# Skills — {agent_name}\n\nCapabilities and tools this agent can use.\n")

    return d


def write_soul(data_dir: str, agent_name: str, personality: str) -> None:
    """Persist an agent's personality ('soul') to soul.md in its folder."""
    d = agent_dir(data_dir, agent_name)
    d.mkdir(parents=True, exist_ok=True)
    body = (personality or "").strip()
    content = f"# Soul — {agent_name}\n\n"
    content += body if body else "Core identity, values, and personality traits."
    content += "\n"
    (d / "soul.md").write_text(content)


def _read_md_body(path: Path) -> str:
    """Read a markdown file and strip the leading '# ...' title line."""
    if not path.exists():
        return ""
    text = path.read_text().strip()
    lines = text.split("\n")
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    return "\n".join(lines).strip()


def read_agent_context(data_dir: str, agent_name: str) -> dict:
    """Return the agent's soul + memory text for injecting into its prompt."""
    d = agent_dir(data_dir, agent_name)
    return {
        "soul": _read_md_body(d / "soul.md"),
        "memory": _read_md_body(d / "memory.md"),
    }


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
