"""
MCP manager — connects to configured Model Context Protocol servers and exposes
their tools to agents.

Each enabled server is owned by a dedicated background worker task. The worker
opens the transport + ClientSession (async context managers) and keeps them open
for the lifetime of the connection, serving tool calls received over an
asyncio.Queue. This keeps every enter/exit of the anyio cancel scopes on the same
task, which the MCP/anyio stack requires.

Tools are namespaced as ``mcp__<slug>__<tool>`` where <slug> is derived from the
server name. Agents opt in per-server via a ``mcp:<server_id>`` skill token.
"""
from __future__ import annotations

import asyncio
import logging
import re

logger = logging.getLogger(__name__)

CALL_TIMEOUT = 120  # seconds for a single tool call


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_") or "server"


def tool_full_name(slug: str, tool: str) -> str:
    return f"mcp__{slug}__{tool}"


class _ServerConn:
    def __init__(self, config: dict) -> None:
        self.config = config
        self.id: str = config["id"]
        self.slug: str = slugify(config.get("name", ""))
        self.status: str = "disconnected"   # disconnected | connecting | connected | error
        self.error: str = ""
        self.tools: list[dict] = []          # [{name, full_name, description, schema}]
        self._queue: asyncio.Queue = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._ready = asyncio.Event()

    async def start(self) -> None:
        self._ready.clear()
        self._task = asyncio.create_task(self._run(), name=f"mcp-{self.slug}")
        # Wait (bounded) for the worker to connect and list tools.
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=45)
        except asyncio.TimeoutError:
            self.status = "error"
            self.error = self.error or "Timed out connecting to MCP server"

    async def stop(self) -> None:
        if self._task and not self._task.done():
            await self._queue.put(("stop", None, None))
            try:
                await asyncio.wait_for(self._task, timeout=10)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
        self.status = "disconnected"
        self.tools = []

    async def call(self, tool: str, arguments: dict):
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        await self._queue.put(("call", (tool, arguments or {}), fut))
        return await asyncio.wait_for(fut, timeout=CALL_TIMEOUT)

    # ── Worker ────────────────────────────────────────────────────────────────

    async def _open_transport(self):
        """Return an async-context-manager yielding (read, write) streams."""
        transport = (self.config.get("transport") or "stdio").lower()
        if transport == "stdio":
            from mcp.client.stdio import stdio_client, StdioServerParameters
            params = StdioServerParameters(
                command=self.config.get("command", ""),
                args=list(self.config.get("args", []) or []),
                env=dict(self.config.get("env", {}) or {}) or None,
            )
            return stdio_client(params), "stdio"
        if transport == "http":
            from mcp.client.streamable_http import streamablehttp_client
            return streamablehttp_client(
                self.config.get("url", ""),
                headers=dict(self.config.get("headers", {}) or {}) or None,
            ), "http"
        if transport == "sse":
            from mcp.client.sse import sse_client
            return sse_client(
                self.config.get("url", ""),
                headers=dict(self.config.get("headers", {}) or {}) or None,
            ), "sse"
        raise ValueError(f"Unknown MCP transport: {transport}")

    async def _run(self) -> None:
        from mcp import ClientSession
        self.status = "connecting"
        self.error = ""
        try:
            ctx, kind = await self._open_transport()
            async with ctx as streams:
                # stdio/sse yield (read, write); http yields (read, write, get_session_id)
                read, write = streams[0], streams[1]
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    await self._load_tools(session)
                    self.status = "connected"
                    self._ready.set()
                    logger.info("[mcp:%s] connected — %d tool(s)", self.slug, len(self.tools))
                    await self._serve(session)
        except Exception as e:
            self.status = "error"
            self.error = str(e)
            logger.error("[mcp:%s] connection failed: %s", self.slug, e)
            self._ready.set()
            # Fail any queued calls.
            self._drain_with_error(e)

    async def _load_tools(self, session) -> None:
        resp = await session.list_tools()
        tools = []
        for t in resp.tools:
            tools.append({
                "name": t.name,
                "full_name": tool_full_name(self.slug, t.name),
                "description": t.description or "",
                "schema": getattr(t, "inputSchema", None) or {},
            })
        self.tools = tools

    async def _serve(self, session) -> None:
        while True:
            kind, payload, fut = await self._queue.get()
            if kind == "stop":
                return
            if kind == "call":
                tool, arguments = payload
                try:
                    result = await session.call_tool(tool, arguments)
                    if not fut.done():
                        fut.set_result(_result_to_text(result))
                except Exception as e:
                    if not fut.done():
                        fut.set_exception(e)

    def _drain_with_error(self, exc: Exception) -> None:
        while not self._queue.empty():
            try:
                kind, payload, fut = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if kind == "call" and fut and not fut.done():
                fut.set_exception(exc)


def _result_to_text(result) -> str:
    """Flatten an MCP CallToolResult into text for the agent."""
    parts = []
    for block in getattr(result, "content", []) or []:
        text = getattr(block, "text", None)
        if text is not None:
            parts.append(text)
        else:
            parts.append(str(getattr(block, "data", block)))
    out = "\n".join(p for p in parts if p)
    if getattr(result, "isError", False):
        return f"[tool error] {out}" if out else "[tool error]"
    return out or "(no output)"


class MCPManager:
    def __init__(self) -> None:
        self._conns: dict[str, _ServerConn] = {}

    async def start(self) -> None:
        from . import database
        servers = await database.get_all_mcp_servers()
        for s in servers:
            if s.get("enabled", True):
                await self._connect(s)

    async def stop(self) -> None:
        for conn in list(self._conns.values()):
            await conn.stop()
        self._conns.clear()

    async def _connect(self, config: dict) -> _ServerConn:
        existing = self._conns.get(config["id"])
        if existing:
            await existing.stop()
        conn = _ServerConn(config)
        self._conns[config["id"]] = conn
        await conn.start()
        return conn

    async def refresh(self, config: dict) -> dict:
        """(Re)connect a server and return its status + discovered tools."""
        if config.get("enabled", True):
            conn = await self._connect(config)
        else:
            await self.remove(config["id"])
            return {"id": config["id"], "status": "disconnected", "tools": [], "error": ""}
        return self.status_for(config["id"])

    async def remove(self, server_id: str) -> None:
        conn = self._conns.pop(server_id, None)
        if conn:
            await conn.stop()

    def status_for(self, server_id: str) -> dict:
        conn = self._conns.get(server_id)
        if not conn:
            return {"id": server_id, "status": "disconnected", "tools": [], "error": ""}
        return {
            "id": server_id,
            "slug": conn.slug,
            "status": conn.status,
            "error": conn.error,
            "tools": [{"name": t["name"], "full_name": t["full_name"], "description": t["description"]}
                      for t in conn.tools],
        }

    def all_status(self) -> list[dict]:
        return [self.status_for(sid) for sid in self._conns]

    def tools_for_server(self, server_id: str) -> list[dict]:
        conn = self._conns.get(server_id)
        return conn.tools if conn else []

    def find_tool(self, full_name: str) -> tuple[str, str] | None:
        """Map a namespaced tool name back to (server_id, tool_name)."""
        for sid, conn in self._conns.items():
            for t in conn.tools:
                if t["full_name"] == full_name:
                    return sid, t["name"]
        return None

    async def call_tool(self, full_name: str, arguments: dict) -> str:
        match = self.find_tool(full_name)
        if not match:
            return f"Error: MCP tool '{full_name}' not found or its server is offline."
        server_id, tool_name = match
        conn = self._conns.get(server_id)
        try:
            return await conn.call(tool_name, arguments)
        except asyncio.TimeoutError:
            return f"Error: MCP tool '{full_name}' timed out."
        except Exception as e:
            logger.error("[mcp] call %s failed: %s", full_name, e)
            return f"Error calling MCP tool '{full_name}': {e}"


# Singleton
mcp_manager = MCPManager()
