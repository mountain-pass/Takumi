"""
Webhook test-capture: lets the editor 'listen' for a real webhook call while
testing. Test arms a Future for a workflow; the public hook endpoint delivers the
next call's payload to it (instead of running live), so the test runs with real data.
"""
from __future__ import annotations
import asyncio

_armed: dict[str, asyncio.Future] = {}


def arm(workflow_id: str) -> asyncio.Future:
    old = _armed.get(workflow_id)
    if old and not old.done():
        old.cancel()
    fut = asyncio.get_event_loop().create_future()
    _armed[workflow_id] = fut
    return fut


def deliver(workflow_id: str, payload: dict) -> bool:
    """Resolve a waiting test with the incoming payload. Returns True if one was waiting."""
    fut = _armed.get(workflow_id)
    if fut and not fut.done():
        fut.set_result(payload or {})
        _armed.pop(workflow_id, None)
        return True
    return False


def is_armed(workflow_id: str) -> bool:
    fut = _armed.get(workflow_id)
    return bool(fut and not fut.done())


def disarm(workflow_id: str) -> None:
    fut = _armed.pop(workflow_id, None)
    if fut and not fut.done():
        fut.cancel()
