"""ChannelService — starts/stops channel adapters and routes their messages into the
Manager, then sends the reply back out. This is where OMNI-CHANNEL lives: every inbound
message, whatever channel it came from, is handled by the same Manager brain
(ceo.chat_with_context) and is given a digest of recent activity across ALL channels +
workflow runs, so the agent has full platform knowledge regardless of the entry point.
"""
from __future__ import annotations

import logging
import uuid

from .. import database
from .base import ADAPTERS, ChannelAdapter
# Import provider modules for their side effect: registering into ADAPTERS.
from . import telegram, discord, slack, whatsapp  # noqa: F401

logger = logging.getLogger(__name__)


class ChannelService:
    def __init__(self):
        self._adapters: dict[str, ChannelAdapter] = {}   # channel_id → running adapter

    # ── lifecycle ────────────────────────────────────────────────────────────
    async def start_all(self) -> None:
        for ch in await database.list_channels():
            if ch.get("enabled"):
                await self.start_channel(ch)

    async def stop_all(self) -> None:
        for ch_id in list(self._adapters):
            await self.stop_channel(ch_id)

    async def start_channel(self, ch: dict) -> tuple[bool, str]:
        """Start (or restart) one channel's adapter. Returns (ok, detail)."""
        await self.stop_channel(ch["id"])
        cls = ADAPTERS.get(ch["type"])
        if cls is None:
            await database.set_channel_status(ch["id"], "error", f"Unsupported channel type '{ch['type']}'")
            return False, f"Unsupported channel type '{ch['type']}'"
        adapter = cls(ch["id"], ch.get("config") or {},
                      lambda chat_id, sender, text, _c=ch: self._handle_incoming(_c, chat_id, sender, text))
        ok, detail = await adapter.verify()
        if not ok:
            await database.set_channel_status(ch["id"], "error", detail)
            return False, detail
        try:
            await adapter.start()
        except Exception as e:
            await database.set_channel_status(ch["id"], "error", str(e)[:200])
            return False, str(e)[:200]
        self._adapters[ch["id"]] = adapter
        await database.set_channel_status(ch["id"], "connected", detail)
        logger.info("[channels] started %s channel %s (%s)", ch["type"], ch["id"], detail)
        return True, detail

    async def deliver_to_channel(self, conv_id: str, text: str) -> bool:
        """Push a message to the external channel a conversation belongs to. Used when
        a DELEGATED task finishes asynchronously (the Manager's specialist replies later)
        — without this, channel users only ever get the Manager's immediate reply and
        never the actual delegated result. Returns True if it was sent."""
        if not conv_id or not conv_id.startswith("chan:"):
            return False
        try:
            _, channel_id, external_chat_id = conv_id.split(":", 2)
        except ValueError:
            return False
        adapter = self._adapters.get(channel_id)
        if adapter is None:
            return False
        try:
            await adapter.send(external_chat_id, text)
            return True
        except Exception as e:
            logger.warning("[channels] deliver to %s failed: %s", conv_id, e)
            return False

    async def stop_channel(self, ch_id: str) -> None:
        adapter = self._adapters.pop(ch_id, None)
        if adapter:
            try:
                await adapter.stop()
            except Exception as e:
                logger.warning("[channels] error stopping %s: %s", ch_id, e)
        await database.set_channel_status(ch_id, "disconnected", "")

    async def verify_config(self, ch_type: str, config: dict) -> tuple[bool, str]:
        cls = ADAPTERS.get(ch_type)
        if cls is None:
            return False, f"Unsupported channel type '{ch_type}'"
        return await cls("preview", config or {}, None).verify()  # type: ignore[arg-type]

    # ── WhatsApp webhook (inbound needs a public URL, so it can't long-poll) ──
    async def whatsapp_verify(self, token: str) -> bool:
        """GET webhook verification: true if any WhatsApp channel uses this verify_token."""
        for ch in await database.list_channels():
            if ch["type"] == "whatsapp" and (ch.get("config") or {}).get("verify_token") == token:
                return True
        return False

    async def handle_whatsapp_webhook(self, payload: dict) -> None:
        """Parse a Meta Cloud API webhook and route each message to its channel."""
        for entry in payload.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value") or {}
                phone_id = (value.get("metadata") or {}).get("phone_number_id")
                if not phone_id:
                    continue
                ch = await self._whatsapp_channel_for(phone_id)
                if not ch:
                    continue
                contacts = {c.get("wa_id"): (c.get("profile") or {}).get("name")
                            for c in value.get("contacts", [])}
                for m in value.get("messages", []):
                    if m.get("type") != "text":
                        continue
                    frm = m.get("from")
                    text = (m.get("text") or {}).get("body")
                    if frm and text:
                        await self._handle_incoming(ch, frm, contacts.get(frm) or "WhatsApp user", text)

    async def _whatsapp_channel_for(self, phone_id: str) -> dict | None:
        for ch in await database.list_channels():
            if (ch["type"] == "whatsapp" and ch.get("enabled")
                    and (ch.get("config") or {}).get("phone_number_id") == phone_id):
                return ch
        return None

    # ── inbound routing ──────────────────────────────────────────────────────
    async def _handle_incoming(self, ch: dict, external_chat_id: str, sender: str, text: str) -> None:
        """A user messaged a channel → run it through the Manager and reply back."""
        from ..orchestrator import orchestrator
        from ..api.routes import _strip_ceo_json

        ceo = next((a for a in orchestrator.get_agents() if a.config.is_ceo), None)
        adapter = self._adapters.get(ch["id"])
        if ceo is None or adapter is None:
            return

        # Each external chat maps to a persistent platform conversation, so the
        # per-chat history is remembered and also visible in the web Chat.
        conv_id = f"chan:{ch['id']}:{external_chat_id}"
        conv = await database.get_conversation(conv_id)
        if not conv:
            await database.create_conversation(conv_id, title=f"{ch.get('name') or ch['type']} · {sender}")

        await database.save_message({
            "id": str(uuid.uuid4()), "conversation_id": conv_id,
            "from_agent_id": "user", "to_agent_id": ceo.config.id,
            "content": text, "role": "user",
            "metadata": {"channel": ch["type"], "channel_id": ch["id"], "sender": sender},
        })

        digest = await self._omni_digest(conv_id)
        origin = (f"[This message arrived via the {ch['type']} channel from {sender}. "
                  f"Reply conversationally for a chat app — concise, no markdown tables.]")
        message_for_llm = f"{text}\n\n{origin}{digest}"

        try:
            response, actions = await ceo.chat_with_context(message_for_llm, conversation_id=conv_id)
        except Exception as e:
            logger.exception("[channels] Manager failed on %s message: %s", ch["type"], e)
            await adapter.send(external_chat_id, "Sorry — I hit an error handling that. Please try again.")
            return

        # When the Manager DELEGATES, its reply is often just the action JSON with no
        # user-facing text → stripping it leaves nothing. Acknowledge the delegation so the
        # channel user isn't left hanging; the actual result is delivered later by
        # present_results → deliver_to_channel once the specialist finishes.
        reply = (_strip_ceo_json(response) or "").strip()
        if not reply:
            names = self._delegated_agent_names(orchestrator, actions)
            reply = (f"On it — I've asked {names} to handle that. I'll reply here as soon as it's ready."
                     if names else "On it — working on that now; I'll reply here shortly.")
        await database.save_message({
            "id": str(uuid.uuid4()), "conversation_id": conv_id,
            "from_agent_id": ceo.config.id, "to_agent_id": "user",
            "content": response, "role": "assistant",
            "metadata": {"channel": ch["type"], "channel_id": ch["id"]},
        })
        await database.update_conversation(conv_id, text[:80])
        await adapter.send(external_chat_id, reply)

    def _delegated_agent_names(self, orchestrator, actions: list | None) -> str:
        """Human list of the agents the Manager just delegated to (for the ack message)."""
        by_id = {a.config.id: a.config.name for a in orchestrator.get_agents()}
        names: list[str] = []
        for a in (actions or []):
            if a.get("action") in ("create_task", "delegate") and a.get("status") in ("ok", None):
                n = by_id.get(a.get("agent_id")) or a.get("agent") or a.get("agent_name")
                if n and n not in names:
                    names.append(n)
        if not names:
            return ""
        return names[0] if len(names) == 1 else ", ".join(names[:-1]) + f" and {names[-1]}"

    async def _omni_digest(self, current_conv_id: str) -> str:
        """Cross-channel awareness: recent conversations everywhere + recent workflow
        runs, so the agent has the same platform knowledge from any channel."""
        lines: list[str] = []
        try:
            convs = await database.get_conversations(limit=8)
            others = [c for c in convs if c.get("id") != current_conv_id][:6]
            if others:
                lines.append("Recent conversations across the platform (all channels):")
                for c in others:
                    lines.append(f"  - {c.get('title') or 'Untitled'} (updated {c.get('updated_at', '?')})")
        except Exception as e:
            logger.debug("[channels] digest conversations failed: %s", e)
        try:
            runs = await database.recent_runs(limit=6)
            if runs:
                lines.append("Recent workflow runs:")
                for r in runs:
                    lines.append(f"  - {r.get('workflow_name') or 'Workflow'}: {r.get('status')} "
                                 f"({r.get('mode')}, {r.get('started_at')})")
        except Exception as e:
            logger.debug("[channels] digest runs failed: %s", e)
        if not lines:
            return ""
        return ("\n\n---\n## Platform activity (shared across all channels — for your awareness)\n"
                + "\n".join(lines))


# Module-level singleton used by the orchestrator + API routes.
channel_service = ChannelService()
