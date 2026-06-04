"""
File skills for agents — read, write, and list files on the local filesystem.

Backed by Python's built-in file I/O. These are UNRESTRICTED: agents may access
any path the backend process can reach. Relative paths resolve against the
current working directory of the backend process.
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

# Cap how much we read/return so a huge file can't blow up the prompt.
MAX_READ_CHARS = 20000
MAX_LIST_ENTRIES = 200


async def read_file(path: str, max_chars: int = MAX_READ_CHARS) -> str:
    """Read a text file and return its contents (truncated to max_chars)."""
    try:
        path = os.path.expanduser(str(path))
        if not os.path.exists(path):
            return f"Error: file not found: {path}"
        if os.path.isdir(path):
            return f"Error: '{path}' is a directory. Use list_files to inspect it."
        try:
            cap = int(max_chars)
        except (TypeError, ValueError):
            cap = MAX_READ_CHARS
        cap = max(1, min(cap, MAX_READ_CHARS * 5))
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = f.read(cap + 1)
        size = os.path.getsize(path)
        if len(data) > cap:
            data = data[:cap] + f"\n\n[...truncated, file is {size} bytes...]"
        return f"--- {path} ({size} bytes) ---\n{data}"
    except Exception as e:
        logger.error("read_file failed for %s: %s", path, e)
        return f"Error reading file: {e}"


async def write_file(path: str, content: str = "", mode: str = "overwrite") -> str:
    """Write text to a file. mode='overwrite' (default) or 'append'.

    Parent directories are created automatically.
    """
    try:
        path = os.path.expanduser(str(path))
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        file_mode = "a" if str(mode).lower().startswith("a") else "w"
        text = content if isinstance(content, str) else str(content)
        with open(path, file_mode, encoding="utf-8") as f:
            f.write(text)
        action = "Appended to" if file_mode == "a" else "Wrote"
        return f"{action} {path} ({len(text)} chars)."
    except Exception as e:
        logger.error("write_file failed for %s: %s", path, e)
        return f"Error writing file: {e}"


async def list_files(path: str = ".") -> str:
    """List the entries in a directory."""
    try:
        path = os.path.expanduser(str(path or "."))
        if not os.path.exists(path):
            return f"Error: path not found: {path}"
        if not os.path.isdir(path):
            return f"'{path}' is a file, not a directory."
        entries = sorted(os.listdir(path))
        if not entries:
            return f"{path} is empty."
        lines = [f"Contents of {os.path.abspath(path)}:"]
        for name in entries[:MAX_LIST_ENTRIES]:
            full = os.path.join(path, name)
            try:
                if os.path.isdir(full):
                    lines.append(f"  {name}/")
                else:
                    lines.append(f"  {name}  ({os.path.getsize(full)} bytes)")
            except OSError:
                lines.append(f"  {name}")
        if len(entries) > MAX_LIST_ENTRIES:
            lines.append(f"  ... and {len(entries) - MAX_LIST_ENTRIES} more")
        return "\n".join(lines)
    except Exception as e:
        logger.error("list_files failed for %s: %s", path, e)
        return f"Error listing directory: {e}"
