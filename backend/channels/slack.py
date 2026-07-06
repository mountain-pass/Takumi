"""Slack channel — Socket Mode (websocket, no public URL, works on localhost).
Config: {"bot_token": "xoxb-...", "app_token": "xapp-..."}.

Setup: create a Slack app, enable Socket Mode (gives the app-level xapp token),
add the bot scopes chat:write + the message events, install to the workspace
(gives the xoxb bot token), and subscribe to message.channels / message.im events.
"""
from __future__ import annotations

import asyncio
import json
import logging

import httpx
from websockets.asyncio.client import connect

from .base import ChannelAdapter, register

logger = logging.getLogger(__name__)
_API = "https://slack.com/api"


@register
class SlackAdapter(ChannelAdapter):
    type = "slack"

    def __init__(self, channel_id, config, on_message):
        super().__init__(channel_id, config, on_message)
        cfg = config or {}
        self._bot = cfg.get("bot_token", "").strip()
        self._app = cfg.get("app_token", "").strip()
        self._task: asyncio.Task | None = None
        self._client = httpx.AsyncClient(timeout=30)
        self._stopped = False
        self._bot_user_id = None

    async def verify(self) -> tuple[bool, str]:
        if not self._bot or not self._app:
            return False, "Need both a bot token (xoxb-) and an app token (xapp-)"
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.post(f"{_API}/auth.test",
                                 headers={"Authorization": f"Bearer {self._bot}"})
            d = r.json()
            if d.get("ok"):
                self._bot_user_id = d.get("user_id")
                return True, d.get("team", "Slack")
            return False, f"auth.test failed: {d.get('error')}"
        except Exception as e:
            return False, str(e)[:200]

    async def start(self) -> None:
        if not self._bot or not self._app:
            raise ValueError("Slack channel needs bot + app tokens")
        self._stopped = False
        self._task = asyncio.create_task(self._run(), name=f"slack-{self.channel_id}")

    async def stop(self) -> None:
        self._stopped = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        await self._client.aclose()

    async def send(self, external_chat_id: str, text: str) -> None:
        await self._client.post(f"{_API}/chat.postMessage",
                                headers={"Authorization": f"Bearer {self._bot}"},
                                json={"channel": external_chat_id, "text": text or "(no content)"})

    async def _run(self) -> None:
        backoff = 1
        while not self._stopped:
            try:
                r = await self._client.post(f"{_API}/apps.connections.open",
                                            headers={"Authorization": f"Bearer {self._app}"})
                d = r.json()
                if not d.get("ok"):
                    raise RuntimeError(f"apps.connections.open failed: {d.get('error')}")
                await self._session(d["url"])
                backoff = 1
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._stopped:
                    break
                logger.warning("[slack] socket error (retry %ss): %s", backoff, e)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

    async def _session(self, wss: str) -> None:
        async with connect(wss, max_size=2 ** 22) as ws:
            while not self._stopped:
                msg = json.loads(await ws.recv())
                mtype = msg.get("type")
                if mtype == "disconnect":
                    return
                if mtype == "hello":
                    continue
                # Ack every envelope immediately so Slack doesn't retry.
                if msg.get("envelope_id"):
                    await ws.send(json.dumps({"envelope_id": msg["envelope_id"]}))
                if mtype != "events_api":
                    continue
                event = ((msg.get("payload") or {}).get("event")) or {}
                if event.get("type") != "message":
                    continue
                # Ignore edits/deletes/joins and the bot's own messages.
                if event.get("subtype") or event.get("bot_id"):
                    continue
                if event.get("user") and event["user"] == self._bot_user_id:
                    continue
                text = event.get("text") or ""
                chan = event.get("channel")
                if text and chan:
                    try:
                        await self._on_message(str(chan), event.get("user") or "Slack user", text)
                    except Exception as e:
                        logger.exception("[slack] handler failed: %s", e)
