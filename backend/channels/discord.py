"""Discord channel — connects to the Gateway over a websocket (outbound only, so it
works on localhost with no public URL). Config: {"bot_token": "<bot token>"}.

The bot needs the privileged MESSAGE CONTENT intent enabled in the Discord developer
portal, and to be invited to a server. It replies in whatever channel it's messaged in.
"""
from __future__ import annotations

import asyncio
import json
import logging

import httpx
from websockets.asyncio.client import connect

from .base import ChannelAdapter, register

logger = logging.getLogger(__name__)
_API = "https://discord.com/api/v10"
# GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT | DIRECT_MESSAGES
_INTENTS = (1 << 0) | (1 << 9) | (1 << 15) | (1 << 12)


@register
class DiscordAdapter(ChannelAdapter):
    type = "discord"

    def __init__(self, channel_id, config, on_message):
        super().__init__(channel_id, config, on_message)
        self._token = (config or {}).get("bot_token", "").strip()
        self._task: asyncio.Task | None = None
        self._hb_task: asyncio.Task | None = None
        self._client = httpx.AsyncClient(timeout=30)
        self._stopped = False
        self._bot_id = None

    def _headers(self):
        return {"Authorization": f"Bot {self._token}", "Content-Type": "application/json"}

    async def verify(self) -> tuple[bool, str]:
        if not self._token:
            return False, "Missing bot token"
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.get(f"{_API}/users/@me", headers=self._headers())
            if r.status_code == 200:
                u = r.json()
                return True, f"{u.get('username', 'bot')}"
            return False, f"Discord rejected the token ({r.status_code})"
        except Exception as e:
            return False, str(e)[:200]

    async def start(self) -> None:
        if not self._token:
            raise ValueError("Discord channel has no bot token")
        self._stopped = False
        self._task = asyncio.create_task(self._run(), name=f"discord-{self.channel_id}")

    async def stop(self) -> None:
        self._stopped = True
        for t in (self._hb_task, self._task):
            if t:
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass
        self._hb_task = self._task = None
        await self._client.aclose()

    async def send(self, external_chat_id: str, text: str) -> None:
        for i in range(0, len(text) or 1, 1900):   # Discord caps at 2000 chars
            chunk = text[i:i + 1900] or "(no content)"
            await self._client.post(f"{_API}/channels/{external_chat_id}/messages",
                                    headers=self._headers(), json={"content": chunk})

    async def _run(self) -> None:
        backoff = 1
        while not self._stopped:
            try:
                r = await self._client.get(f"{_API}/gateway/bot", headers=self._headers())
                wss = r.json()["url"] + "/?v=10&encoding=json"
                await self._session(wss)
                backoff = 1
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._stopped:
                    break
                logger.warning("[discord] gateway error (retry %ss): %s", backoff, e)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

    async def _session(self, wss: str) -> None:
        seq = None
        async with connect(wss, max_size=2 ** 22) as ws:
            hello = json.loads(await ws.recv())
            interval = hello["d"]["heartbeat_interval"] / 1000

            async def heartbeat():
                while not self._stopped:
                    await asyncio.sleep(interval)
                    try:
                        await ws.send(json.dumps({"op": 1, "d": seq}))
                    except Exception:
                        return
            self._hb_task = asyncio.create_task(heartbeat())

            await ws.send(json.dumps({"op": 2, "d": {
                "token": self._token, "intents": _INTENTS,
                "properties": {"os": "linux", "browser": "takumi", "device": "takumi"}}}))

            while not self._stopped:
                payload = json.loads(await ws.recv())
                if payload.get("s") is not None:
                    seq = payload["s"]
                op, t, d = payload.get("op"), payload.get("t"), payload.get("d") or {}
                if op == 7 or op == 9:          # reconnect / invalid session
                    return
                if op != 0:
                    continue
                if t == "READY":
                    self._bot_id = (d.get("user") or {}).get("id")
                elif t == "MESSAGE_CREATE":
                    author = d.get("author") or {}
                    if author.get("bot") or author.get("id") == self._bot_id:
                        continue
                    text = d.get("content") or ""
                    chan = d.get("channel_id")
                    if text and chan:
                        sender = author.get("global_name") or author.get("username") or "Discord user"
                        try:
                            await self._on_message(str(chan), sender, text)
                        except Exception as e:
                            logger.exception("[discord] handler failed: %s", e)
