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
    AgentConfig, AgentState, AgentStatus, Task, WSEvent, WSEventType
)
from .agents.base_agent import BaseAgent
from .agents.ceo_agent import CEOAgent, make_ceo_config
from .message_bus import MessageBus, message_bus
from .config import Settings, get_settings
from . import database
from .agent_folders import ensure_agent_folder, remove_agent_folder, remove_all_agent_folders
from .task_scheduler import TaskScheduler

logger = logging.getLogger(__name__)

BroadcastFn = Callable[[str], Awaitable[None]]

# Fields that belong to AgentConfig (the agents table has extra columns like
# created_at that pydantic should not receive).
_AGENT_CONFIG_FIELDS = set(AgentConfig.model_fields.keys())


def _agent_config_from_row(row: dict) -> AgentConfig:
    """Build an AgentConfig from a DB agents row, ignoring extra columns."""
    return AgentConfig(**{k: v for k, v in row.items() if k in _AGENT_CONFIG_FIELDS})


class Orchestrator:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.bus = message_bus
        self._agents: dict[str, BaseAgent] = {}   # agent_id -> BaseAgent
        self._tasks: dict[str, Task] = {}
        self._ws_broadcast: BroadcastFn | None = None
        self._running = False
        self._ceo: CEOAgent | None = None
        self._scheduler = TaskScheduler(self)

    # ── Boot / Shutdown ───────────────────────────────────────────────────────

    async def start(self) -> None:
        self._running = True

        # Agents live in SQLite (the agents table). Load them from there.
        agent_rows = await database.get_all_agents()
        configs = [_agent_config_from_row(r) for r in agent_rows]

        if not configs:
            # Bootstrap with a CEO and persist it to the DB.
            ceo = make_ceo_config()
            await database.save_agent(ceo.model_dump(mode="json"))
            configs = [ceo]

        for cfg in configs:
            await self._spawn_agent(cfg)

        # Subscribe bus to WS broadcaster
        self.bus.subscribe_all(self._on_any_message)

        asyncio.create_task(self._heartbeat_loop(), name="orchestrator-heartbeat")
        await self._scheduler.start()
        logger.info("Orchestrator started with %d agents", len(self._agents))

    async def stop(self) -> None:
        self._running = False
        await self._scheduler.stop()
        for agent in list(self._agents.values()):
            await agent.stop()

    # ── Agent management ──────────────────────────────────────────────────────

    async def add_agent(self, config: AgentConfig) -> BaseAgent:
        agent = await self._spawn_agent(config)
        ensure_agent_folder(self.settings.data_dir, config.name, config.role, config.description, config.system_prompt)
        await database.save_agent(config.model_dump(mode="json"))
        await self._broadcast(WSEvent(
            type=WSEventType.AGENT_ADDED,
            payload=config.model_dump(mode="json"),
        ))
        return agent

    async def remove_agent(self, agent_id: str) -> None:
        agent = self._agents.get(agent_id)
        if agent:
            remove_agent_folder(self.settings.data_dir, agent.config.name)
            await agent.stop()
            del self._agents[agent_id]
            await database.delete_agent(agent_id)
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
        await database.save_agent(new_config.model_dump(mode="json"))
        return new_config

    def reset(self) -> None:
        for agent in list(self._agents.values()):
            import asyncio
            try:
                asyncio.get_event_loop().create_task(agent.stop())
            except Exception:
                pass
        self._agents.clear()
        self._tasks.clear()
        self._ceo = None
        remove_all_agent_folders(self.settings.data_dir)

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
            self._ceo = agent
        else:
            agent = BaseAgent(config, self.bus, self.settings)

        # Resolve api_provider_id → adapter with correct api_key/base_url
        if config.api_provider_id:
            await self._resolve_agent_adapter(agent, config.api_provider_id)

        agent.set_orchestrator(self)
        agent.set_status_callback(self._on_agent_status_change)
        self._agents[config.id] = agent
        ensure_agent_folder(self.settings.data_dir, config.name, config.role, config.description, config.system_prompt)
        await agent.start()
        return agent

    async def _resolve_agent_adapter(self, agent: BaseAgent, provider_id: str) -> None:
        """Look up the API provider and re-init the agent's LLM adapter with the correct credentials."""
        from .llm_adapters import get_adapter
        from .models import LLMProvider
        prov = await database.get_api_provider(provider_id)
        if not prov:
            logger.warning("API provider %s not found for agent %s", provider_id, agent.config.name)
            return
        runtime = {
            "llm_api_key": prov.get("api_key", ""),
            "llm_base_url": prov.get("base_url", ""),
        }
        # Use the provider record's provider type, not the agent's stale llm_provider
        provider_type = prov.get("provider", "") or agent.config.llm_provider
        try:
            llm_provider = LLMProvider(provider_type)
        except ValueError:
            logger.warning("[%s] Unknown provider type '%s', falling back to agent config", agent.config.name, provider_type)
            llm_provider = agent.config.llm_provider
        try:
            agent._adapter = get_adapter(llm_provider, self.settings, runtime)
            logger.info("[%s] Using provider '%s' (%s, base_url=%s)", agent.config.name, prov["name"], provider_type, prov.get("base_url", "")[:40])
        except Exception as e:
            logger.error("[%s] Failed to resolve provider %s: %s", agent.config.name, provider_id, e)

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
                    # Full state snapshot so the UI self-heals if it missed an
                    # agent_status event (e.g. a brief WS hiccup left an agent
                    # stuck showing "Thinking").
                    "agents": self.get_agent_states(),
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

# Singleton
orchestrator = Orchestrator()
