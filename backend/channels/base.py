"""Channel adapter interface + registry.

Add a new channel by writing an adapter subclass and registering it in ADAPTERS
(bottom of telegram.py-style module). Adapters only deal with transport — receiving
messages from the provider and sending replies back; all the platform logic (routing
to the Manager, persistence, omni-channel context) lives in service.ChannelService.
"""
from __future__ import annotations

from typing import Awaitable, Callable

# Called by an adapter when a user messages the channel:
#   on_message(external_chat_id, sender_name, text)
OnMessage = Callable[[str, str, str], Awaitable[None]]


class ChannelAdapter:
    """Transport for one configured channel (one bot token)."""

    type: str = "base"

    def __init__(self, channel_id: str, config: dict, on_message: OnMessage):
        self.channel_id = channel_id
        self.config = config or {}
        self._on_message = on_message

    async def verify(self) -> tuple[bool, str]:
        """Check the credentials are valid. Returns (ok, human detail)."""
        raise NotImplementedError

    async def start(self) -> None:
        """Begin receiving messages (e.g. spawn a long-poll task)."""
        raise NotImplementedError

    async def stop(self) -> None:
        """Stop receiving and clean up."""
        raise NotImplementedError

    async def send(self, external_chat_id: str, text: str) -> None:
        """Send a reply back to the originating chat."""
        raise NotImplementedError


# type → adapter class. Populated by importing the provider modules.
ADAPTERS: dict[str, type[ChannelAdapter]] = {}


def register(cls: type[ChannelAdapter]) -> type[ChannelAdapter]:
    ADAPTERS[cls.type] = cls
    return cls
