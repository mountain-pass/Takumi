"""Telegram channel — long-polling (getUpdates), so it works on localhost with no
public URL or webhook. Config: {"bot_token": "<token from @BotFather>"}."""
from __future__ import annotations

import asyncio
import logging

import httpx

from .base import ChannelAdapter, register

logger = logging.getLogger(__name__)
_API = "https://api.telegram.org/bot{token}/{method}"


@register
class TelegramAdapter(ChannelAdapter):
    type = "telegram"

    def __init__(self, channel_id, config, on_message):
        super().__init__(channel_id, config, on_message)
        self._token = (config or {}).get("bot_token", "").strip()
        self._task: asyncio.Task | None = None
        self._client: httpx.AsyncClient | None = None
        self._offset = 0
        self._stopped = False

    def _url(self, method: str) -> str:
        return _API.format(token=self._token, method=method)

    async def verify(self) -> tuple[bool, str]:
        if not self._token:
            return False, "Missing bot token"
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.get(self._url("getMe"))
                data = r.json()
            if data.get("ok"):
                u = data["result"]
                return True, f"@{u.get('username') or u.get('first_name', 'bot')}"
            return False, str(data.get("description") or "Telegram rejected the token")
        except Exception as e:
            return False, str(e)[:200]

    async def start(self) -> None:
        if not self._token:
            raise ValueError("Telegram channel has no bot token")
        self._stopped = False
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(40.0, connect=15.0))
        self._task = asyncio.create_task(self._poll_loop(), name=f"telegram-{self.channel_id}")

    async def stop(self) -> None:
        self._stopped = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if self._client:
            await self._client.aclose()
            self._client = None

    async def send(self, external_chat_id: str, text: str) -> None:
        # Telegram caps messages at 4096 chars — chunk long replies.
        client = self._client or httpx.AsyncClient(timeout=30)
        try:
            for i in range(0, len(text) or 1, 4000):
                chunk = text[i:i + 4000] or "(no content)"
                await client.post(self._url("sendMessage"),
                                  json={"chat_id": external_chat_id, "text": chunk})
        finally:
            if self._client is None:
                await client.aclose()

    async def _poll_loop(self) -> None:
        """getUpdates long-poll. Resilient: on error, back off and retry."""
        backoff = 1
        while not self._stopped:
            try:
                r = await self._client.get(
                    self._url("getUpdates"),
                    params={"offset": self._offset, "timeout": 30, "allowed_updates": '["message"]'})
                data = r.json()
                if not data.get("ok"):
                    raise RuntimeError(data.get("description") or "getUpdates failed")
                backoff = 1
                for upd in data.get("result", []):
                    self._offset = max(self._offset, upd["update_id"] + 1)
                    msg = upd.get("message") or {}
                    text = msg.get("text")
                    chat = msg.get("chat") or {}
                    if not text or not chat.get("id"):
                        continue
                    frm = msg.get("from") or {}
                    sender = (frm.get("first_name") or "") + (f" {frm.get('last_name')}" if frm.get("last_name") else "")
                    sender = sender.strip() or frm.get("username") or "Telegram user"
                    try:
                        await self._on_message(str(chat["id"]), sender, text)
                    except Exception as e:
                        logger.exception("[telegram] handler failed: %s", e)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._stopped:
                    break
                logger.warning("[telegram] poll error (retry in %ss): %s", backoff, e)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
