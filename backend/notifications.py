"""
User-facing notifications.

A thin layer over the `notifications` table that also pushes a live
`notification` WebSocket event so the bell in the top bar updates instantly.
Notifications carry an optional navigation target (link_view + link_id) so the
frontend can route the user to the right place when they click "View".
"""
from __future__ import annotations
import logging

from . import database

logger = logging.getLogger(__name__)

# Set during app lifespan (main.py) — same broadcaster the orchestrator uses.
_broadcast = None


def set_broadcast(fn) -> None:
    global _broadcast
    _broadcast = fn


async def push(*, type: str = "info", title: str, body: str = "", action: str = "",
               link_view: str = "", link_id: str = "", dedupe_key: str = "") -> dict | None:
    """Persist a notification and broadcast it. Never raises — a failed
    notification must not break the work that triggered it."""
    try:
        entry = await database.add_notification({
            "type": type, "title": title, "body": body, "action": action,
            "link_view": link_view, "link_id": link_id, "dedupe_key": dedupe_key,
        })
    except Exception as e:
        logger.debug("notification persist failed: %s", e)
        return None
    if _broadcast and entry:
        try:
            from .models import WSEvent, WSEventType
            await _broadcast(WSEvent(type=WSEventType.NOTIFICATION, payload=entry).model_dump_json())
        except Exception as e:
            logger.debug("notification broadcast failed: %s", e)
    return entry
