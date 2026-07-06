"""WhatsApp channel — Meta (Facebook) Cloud API.
Config: {"access_token": "...", "phone_number_id": "...", "verify_token": "..."}.

Sending works anywhere. INBOUND messages arrive via a webhook, which needs a PUBLIC
URL (Meta can't reach localhost) — point your app's webhook to
  https://<your-public-host>/api/channels/whatsapp/webhook
and use the same `verify_token` in the Meta app config. Locally you can expose it
with a tunnel (e.g. cloudflared/ngrok). Outbound replies work regardless.
"""
from __future__ import annotations

import logging

import httpx

from .base import ChannelAdapter, register

logger = logging.getLogger(__name__)
_GRAPH = "https://graph.facebook.com/v18.0"


@register
class WhatsAppAdapter(ChannelAdapter):
    type = "whatsapp"

    def __init__(self, channel_id, config, on_message):
        super().__init__(channel_id, config, on_message)
        cfg = config or {}
        self._token = cfg.get("access_token", "").strip()
        self._phone_id = cfg.get("phone_number_id", "").strip()
        self._client = httpx.AsyncClient(timeout=30)

    async def verify(self) -> tuple[bool, str]:
        if not self._token or not self._phone_id:
            return False, "Need an access token and phone number ID"
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.get(f"{_GRAPH}/{self._phone_id}",
                                params={"fields": "verified_name,display_phone_number",
                                        "access_token": self._token})
            if r.status_code == 200:
                d = r.json()
                return True, d.get("verified_name") or d.get("display_phone_number") or "WhatsApp"
            return False, f"Meta rejected the credentials ({r.status_code}): {r.text[:120]}"
        except Exception as e:
            return False, str(e)[:200]

    async def start(self) -> None:
        # Nothing to poll — inbound arrives via the shared webhook route. We only
        # validate that sending is possible.
        if not self._token or not self._phone_id:
            raise ValueError("WhatsApp channel missing access token / phone number ID")

    async def stop(self) -> None:
        await self._client.aclose()

    async def send(self, external_chat_id: str, text: str) -> None:
        await self._client.post(
            f"{_GRAPH}/{self._phone_id}/messages",
            headers={"Authorization": f"Bearer {self._token}"},
            json={"messaging_product": "whatsapp", "to": external_chat_id,
                  "type": "text", "text": {"body": text[:4096] or "(no content)"}})
