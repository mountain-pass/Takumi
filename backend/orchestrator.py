"""
Orchestrator — the 24/7 engine that manages all agents.
Handles agent lifecycle, heartbeat, task routing, and WebSocket broadcasting.
"""
from __future__ import annotations
import asyncio
import json
import logging
from datetime import datetime
from typing import Any, Callable, Awaitable

from .models import (
    AgentConfig, AgentState, AgentStatus, Task, WSEvent, WSEventType, OrganisationConfig
)
from .agents.base_agent import BaseAgent
from .agents.ceo_agent import CEOAgent, make_ceo_config
from .message_bus import MessageBus, message_bus
from .config import Settings, get_settings
from .persistence import save_org, load_org

logger = logging.getLogger(__name__)

BroadcastFn = Callable[[str], Awaitable[None]]


class Orchestrator:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.bus = message_bus
        self._agents: dict[str, BaseAgent] = {}   # agent_id -> BaseAgent
        self._tasks: dict[str, Task] = {}
        self._ws_broadcast: BroadcastFn | None = None
        self._running = False
        self._ceo: CEOAgent | None = None

    # ── Boot / Shutdown ───────────────────────────────────────────────────────

    async def start(self) -> None:
        self._running = True
        org = load_org(self.settings.data_dir)

        if not org.agents:
            # Bootstrap with a CEO
            org.agents.append(make_ceo_config())

        for cfg in org.agents:
            await self._spawn_agent(cfg)

        # Subscribe bus to WS broadcaster
        self.bus.subscribe_all(self._on_any_message)

        asyncio.create_task(self._heartbeat_loop(), name="orchestrator-heartbeat")
        logger.info("Orchestrator started with %d agents", len(self._agents))

    async def stop(self) -> None:
        self._running = False
        for agent in list(self._agents.values()):
            await agent.stop()

    # ── Agent management ──────────────────────────────────────────────────────

    async def add_agent(self, config: AgentConfig) -> BaseAgent:
        agent = await self._spawn_agent(config)
        self._persist()
        await self._broadcast(WSEvent(
            type=WSEventType.AGENT_ADDED,
            payload=config.model_dump(mode="json"),
        ))
        return agent

    async def remove_agent(self, agent_id: str) -> None:
        agent = self._agents.get(agent_id)
        if agent:
            await agent.stop()
            del self._agents[agent_id]
            self._persist()
            await self._broadcast(WSEvent(
                type=WSEventType.AGENT_REMOVED,
                payload={"agent_id": agent_id},
            ))

    async def update_agent(self, agent_id: str, updates: dict) -> AgentConfig | None:
        agent = self._agents.get(agent_id)
        if not agent:
            return None
        new_config = agent.config.model_copy(update=updates)
        await agent.stop()
        del self._agents[agent_id]
        await self._spawn_agent(new_config)
        self._persist()
        return new_config

    def get_agents(self) -> list[BaseAgent]:
        return list(self._agents.values())

    def get_agent_states(self) -> list[dict]:
        return [a.state.model_dump(mode="json") for a in self._agents.values()]

    # ── Task routing ──────────────────────────────────────────────────────────

    async def submit_task(self, title: str, description: str) -> Task:
        task = Task(title=title, description=description)
        self._tasks[task.id] = task

        if self._ceo:
            task.status = "in_progress"
            task.assigned_to = self._ceo.config.id
            asyncio.create_task(self._run_task(task))
        else:
            task.status = "failed"
            task.result = "No CEO agent available."

        await self._broadcast(WSEvent(
            type=WSEventType.TASK_UPDATE,
            payload=task.model_dump(mode="json"),
        ))
        return task

    async def _run_task(self, task: Task) -> None:
        try:
            result = await self._ceo.handle_user_task(task)
            task.status = "completed"
            task.result = result
        except Exception as e:
            task.status = "failed"
            task.result = str(e)
            logger.error(f"Task {task.id} failed: {e}", exc_info=True)
        finally:
            task.updated_at = datetime.utcnow()
            await self._broadcast(WSEvent(
                type=WSEventType.TASK_UPDATE,
                payload=task.model_dump(mode="json"),
            ))

    def get_tasks(self) -> list[Task]:
        return list(self._tasks.values())

    # ── Internals ─────────────────────────────────────────────────────────────

    async def _spawn_agent(self, config: AgentConfig) -> BaseAgent:
        if config.is_ceo:
            agent = CEOAgent(config, self.bus, self.settings)
            agent.set_orchestrator(self)
            self._ceo = agent
        else:
            agent = BaseAgent(config, self.bus, self.settings)

        agent.set_status_callback(self._on_agent_status_change)
        self._agents[config.id] = agent
        await agent.start()
        return agent

    async def _on_agent_status_change(self, agent: BaseAgent) -> None:
        await self._broadcast(WSEvent(
            type=WSEventType.AGENT_STATUS,
            payload=agent.state.model_dump(mode="json"),
        ))

    async def _on_any_message(self, msg) -> None:
        await self._broadcast(WSEvent(
            type=WSEventType.AGENT_MESSAGE,
            payload=msg.model_dump(mode="json"),
        ))

    async def _heartbeat_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self.settings.heartbeat_interval)
            await self._broadcast(WSEvent(
                type=WSEventType.HEARTBEAT,
                payload={
                    "agent_count": len(self._agents),
                    "timestamp": datetime.utcnow().isoformat(),
                },
            ))

    async def _broadcast(self, event: WSEvent) -> None:
        if self._ws_broadcast:
            try:
                await self._ws_broadcast(event.model_dump_json())
            except Exception as e:
                logger.debug(f"WS broadcast error: {e}")

    def set_ws_broadcast(self, fn: BroadcastFn) -> None:
        self._ws_broadcast = fn

    def _persist(self) -> None:
        org = OrganisationConfig(
            agents=[a.config for a in self._agents.values()]
        )
        save_org(org, self.settings.data_dir)


# Singleton
orchestrator = Orchestrator()
