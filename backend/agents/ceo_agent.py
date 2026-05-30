"""
CEO Agent — the orchestrator agent.
Receives tasks from the user, breaks them down, and delegates to specialist agents.
"""
from __future__ import annotations
import json
import logging
from typing import TYPE_CHECKING

from ..models import AgentConfig, AgentMessage, AgentStatus, LLMProvider, Task
from .base_agent import BaseAgent

if TYPE_CHECKING:
    from ..orchestrator import Orchestrator

logger = logging.getLogger(__name__)

CEO_SYSTEM_PROMPT = """You are the CEO of an AI organisation. Your job is to:
1. Receive tasks from the user
2. Analyse what specialists are needed
3. Delegate sub-tasks to the right agents in your organisation
4. Review their responses and synthesise a final answer for the user

You have the following agents available (provided in each message).
When delegating, respond with a JSON block like:
```json
{
  "delegate": [
    {"agent_id": "<id>", "instruction": "<what to do>"}
  ],
  "message_to_user": "<optional message to user while agents work>"
}
```
If you can answer directly without delegation, just respond normally without the JSON block.
Always be decisive and clear. Keep delegations specific and focused."""


class CEOAgent(BaseAgent):
    def __init__(self, config: AgentConfig, message_bus, settings) -> None:
        super().__init__(config, message_bus, settings)
        self._orchestrator: "Orchestrator | None" = None

    def set_orchestrator(self, orchestrator: "Orchestrator") -> None:
        self._orchestrator = orchestrator

    async def handle_user_task(self, task: Task) -> str:
        """Entry point: user sends a task to the CEO."""
        await self._set_status(AgentStatus.THINKING, current_task=task.id, action="Analysing task")

        # Build context about available agents
        agent_roster = self._build_agent_roster()
        user_message = (
            f"Task from user: {task.title}\n\n"
            f"Details: {task.description}\n\n"
            f"Available agents:\n{agent_roster}"
        )
        self._add_to_conversation("user", user_message)

        await self._set_status(AgentStatus.WORKING, action="Deciding delegation strategy")
        response = await self._llm_complete()
        self._add_to_conversation("assistant", response.content)
        self.state.token_count += response.input_tokens + response.output_tokens

        # Parse delegation instructions
        delegations = self._parse_delegation(response.content)
        if delegations and self._orchestrator:
            await self._delegate_tasks(delegations, task)

        await self._set_status(AgentStatus.IDLE, current_task=None, action=None)
        return response.content

    def _build_agent_roster(self) -> str:
        if not self._orchestrator:
            return "No agents available."
        lines = []
        for agent in self._orchestrator.get_agents():
            if not agent.config.is_ceo:
                lines.append(f"- {agent.config.name} (id: {agent.config.id}) — {agent.config.role}: {agent.config.description}")
        return "\n".join(lines) if lines else "No specialist agents yet."

    def _parse_delegation(self, content: str) -> list[dict] | None:
        try:
            start = content.find("```json")
            end = content.find("```", start + 6)
            if start != -1 and end != -1:
                raw = content[start + 7:end].strip()
                data = json.loads(raw)
                return data.get("delegate", [])
        except Exception:
            pass
        return None

    async def _delegate_tasks(self, delegations: list[dict], parent_task: Task) -> None:
        for d in delegations:
            agent_id = d.get("agent_id", "")
            instruction = d.get("instruction", "")
            if not agent_id or not instruction:
                continue
            msg = AgentMessage(
                from_agent=self.config.id,
                to_agent=agent_id,
                content=instruction,
                task_id=parent_task.id,
            )
            logger.info(f"[CEO] Delegating to {agent_id}: {instruction[:60]}...")
            await self.bus.publish(msg)


def make_ceo_config() -> AgentConfig:
    return AgentConfig(
        name="CEO",
        role="Chief Executive Officer",
        description="Orchestrates the organisation: breaks down tasks, delegates to specialists, synthesises results.",
        system_prompt=CEO_SYSTEM_PROMPT,
        llm_provider=LLMProvider.ANTHROPIC,
        llm_model="claude-sonnet-4-6",
        is_ceo=True,
        avatar_color="#DC2626",
        max_context_messages=30,
    )
