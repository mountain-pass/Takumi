"""
In-process async message bus for inter-agent communication.
Agents publish messages; other agents (and the WS broadcaster) subscribe.
"""
from __future__ import annotations
import asyncio
from collections import defaultdict
from typing import Callable, Awaitable
from .models import AgentMessage


MessageHandler = Callable[[AgentMessage], Awaitable[None]]


class MessageBus:
    def __init__(self) -> None:
        # agent_id -> list of handler coroutines
        self._subscribers: dict[str, list[MessageHandler]] = defaultdict(list)
        # broadcast subscribers receive every message
        self._broadcast_subscribers: list[MessageHandler] = []
        self._history: list[AgentMessage] = []
        self._max_history = 500

    def subscribe(self, agent_id: str, handler: MessageHandler) -> None:
        """Subscribe handler to messages addressed to agent_id."""
        self._subscribers[agent_id].append(handler)

    def subscribe_all(self, handler: MessageHandler) -> None:
        """Subscribe handler to ALL messages (for WS broadcast)."""
        self._broadcast_subscribers.append(handler)

    def unsubscribe(self, agent_id: str, handler: MessageHandler) -> None:
        if handler in self._subscribers[agent_id]:
            self._subscribers[agent_id].remove(handler)

    async def publish(self, message: AgentMessage) -> None:
        """Publish a message; deliver to target agent and all broadcast subs."""
        self._history.append(message)
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history:]

        handlers: list[MessageHandler] = []

        if message.to_agent == "broadcast":
            for subs in self._subscribers.values():
                handlers.extend(subs)
        else:
            handlers.extend(self._subscribers.get(message.to_agent, []))

        handlers.extend(self._broadcast_subscribers)

        # deduplicate while preserving order
        seen: set[int] = set()
        unique: list[MessageHandler] = []
        for h in handlers:
            if id(h) not in seen:
                seen.add(id(h))
                unique.append(h)

        await asyncio.gather(*[h(message) for h in unique], return_exceptions=True)

    def get_history(
        self,
        agent_id: str | None = None,
        limit: int = 50,
    ) -> list[AgentMessage]:
        if agent_id is None:
            return self._history[-limit:]
        return [
            m for m in self._history
            if m.from_agent == agent_id or m.to_agent in (agent_id, "broadcast")
        ][-limit:]


# Singleton
message_bus = MessageBus()
