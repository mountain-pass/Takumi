"""
BaseAgent — all specialist agents extend this.
Each agent has a bounded conversation history (max_context_messages) so
context stays lean as the organisation scales.
"""
from __future__ import annotations
import asyncio
import logging
from datetime import datetime
from typing import TYPE_CHECKING

from ..models import AgentConfig, AgentState, AgentStatus, AgentMessage, MessageRole
from ..llm_adapters import get_adapter, LLMResponse
from ..message_bus import MessageBus

if TYPE_CHECKING:
    from ..config import Settings

logger = logging.getLogger(__name__)


class BaseAgent:
    def __init__(
        self,
        config: AgentConfig,
        message_bus: MessageBus,
        settings: "Settings",
    ) -> None:
        self.config = config
        self.bus = message_bus
        self.settings = settings
        self.state = AgentState(config=config)
        self._adapter = get_adapter(config.llm_provider, settings)
        self._conversation: list[dict] = []   # rolling window
        self._task_queue: asyncio.Queue[AgentMessage] = asyncio.Queue()
        self._running = False
        self._on_status_change_cb = None  # injected by orchestrator

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        self._running = True
        self.bus.subscribe(self.config.id, self._on_message)
        asyncio.create_task(self._run_loop(), name=f"agent-{self.config.id}")
        logger.info(f"[{self.config.name}] started")

    async def stop(self) -> None:
        self._running = False
        self.bus.unsubscribe(self.config.id, self._on_message)
        await self._set_status(AgentStatus.OFFLINE)

    # ── Message handling ─────────────────────────────────────────────────────

    async def _on_message(self, msg: AgentMessage) -> None:
        await self._task_queue.put(msg)

    async def _run_loop(self) -> None:
        await self._set_status(AgentStatus.IDLE)
        while self._running:
            try:
                msg = await asyncio.wait_for(self._task_queue.get(), timeout=self.settings.agent_think_interval)
                await self._handle_message(msg)
            except asyncio.TimeoutError:
                # Periodic self-check / heartbeat
                await self._on_idle_tick()
            except Exception as e:
                logger.error(f"[{self.config.name}] loop error: {e}", exc_info=True)

    async def _handle_message(self, msg: AgentMessage) -> None:
        await self._set_status(AgentStatus.THINKING, current_task=msg.task_id, action="Reading message")
        self._add_to_conversation("user", f"[From {msg.from_agent}]: {msg.content}")

        await self._set_status(AgentStatus.WORKING, action="Thinking...")
        try:
            response = await self._llm_complete()
            self._add_to_conversation("assistant", response.content)
            self.state.token_count += response.input_tokens + response.output_tokens
            self.state.messages_processed += 1

            # Reply back to sender
            reply = AgentMessage(
                from_agent=self.config.id,
                to_agent=msg.from_agent,
                content=response.content,
                task_id=msg.task_id,
            )
            await self.bus.publish(reply)
        finally:
            await self._set_status(AgentStatus.IDLE, current_task=None, action=None)

    async def _on_idle_tick(self) -> None:
        """Override in subclasses for proactive behaviour."""
        self.state.last_heartbeat = datetime.utcnow()

    # ── LLM helpers ──────────────────────────────────────────────────────────

    async def _llm_complete(self) -> LLMResponse:
        messages = self._conversation[-self.config.max_context_messages:]
        return await self._adapter.complete(
            system_prompt=self.config.system_prompt,
            messages=messages,
            model=self.config.llm_model,
        )

    def _add_to_conversation(self, role: str, content: str) -> None:
        self._conversation.append({"role": role, "content": content})
        # Keep rolling window
        if len(self._conversation) > self.config.max_context_messages * 2:
            self._conversation = self._conversation[-self.config.max_context_messages:]

    # ── Status helpers ───────────────────────────────────────────────────────

    async def _set_status(
        self,
        status: AgentStatus,
        current_task: str | None = ...,  # type: ignore
        action: str | None = ...,        # type: ignore
    ) -> None:
        self.state.status = status
        if current_task is not ...:
            self.state.current_task = current_task
        if action is not ...:
            self.state.current_action = action
        if self._on_status_change_cb:
            await self._on_status_change_cb(self)

    def set_status_callback(self, cb) -> None:
        self._on_status_change_cb = cb
