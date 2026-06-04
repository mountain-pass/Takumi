"""
Shell skill for agents — run shell commands via subprocess.

UNRESTRICTED: commands run with the privileges of the backend process. A timeout
and output cap are enforced so a single command can't hang or flood the prompt.
"""
from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 60      # seconds
MAX_TIMEOUT = 300
MAX_OUTPUT_CHARS = 12000


async def run_shell(command: str, timeout: int = DEFAULT_TIMEOUT, cwd: str = "") -> str:
    """Run a shell command and return its combined stdout/stderr and exit code."""
    command = (command or "").strip()
    if not command:
        return "Error: empty command."
    try:
        t = int(timeout)
    except (TypeError, ValueError):
        t = DEFAULT_TIMEOUT
    t = max(1, min(t, MAX_TIMEOUT))

    workdir = os.path.expanduser(cwd) if cwd else None
    if workdir and not os.path.isdir(workdir):
        return f"Error: working directory not found: {workdir}"

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=workdir,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=t)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            return f"Error: command timed out after {t}s: {command}"

        output = (stdout or b"").decode("utf-8", errors="replace")
        if len(output) > MAX_OUTPUT_CHARS:
            output = output[:MAX_OUTPUT_CHARS] + "\n[...output truncated...]"
        header = f"$ {command}\n(exit code {proc.returncode})\n"
        return header + (output if output.strip() else "(no output)")
    except Exception as e:
        logger.error("run_shell failed for %r: %s", command, e)
        return f"Error running command: {e}"
