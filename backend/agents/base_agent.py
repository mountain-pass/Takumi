"""
BaseAgent — all specialist agents extend this.
Each agent has a bounded conversation history (max_context_messages) so
context stays lean as the organisation scales.

Agents own their tasks: receive → execute internally (with tools) → report results.
Tool usage is internal — only the final deliverable is sent back to the assignor.
"""
from __future__ import annotations
import asyncio
import json
import logging
import re
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from ..models import AgentConfig, AgentState, AgentStatus, AgentMessage, MessageRole
from ..llm_adapters import get_adapter, LLMResponse
from ..message_bus import MessageBus
from .. import database

if TYPE_CHECKING:
    from ..config import Settings

logger = logging.getLogger(__name__)

# ── Prompt fragments injected into every specialist agent ──────────────────

AGENT_WORK_SOP = """

## Standard Operating Procedure

You are an autonomous agent in an organisation. You OWN every task assigned to you.

### When you receive a task:
1. **Understand it.** Read the instruction carefully. If it's clear enough to act on, start working.
2. **Execute it yourself.** Use your tools (web_search, web_fetch, etc.) to gather information, then synthesize.
3. **Deliver results.** Write your findings/analysis as a clear, structured response.
4. **If something fails**, report what you attempted and what went wrong — don't just say "error".
5. **If the task is unclear**, reply with a specific clarification question — not a vague "what do you mean?"

### Rules:
- Your tool usage is INTERNAL. The person who assigned you this task does NOT see your tool calls — they only see your final answer.
- **ALWAYS use web_search/web_fetch for any factual or current information.** Your training data is outdated. Never quote dates, prices, valuations, statistics, or news from memory — search the web first. If the task is about research, market data, current events, or any real-world facts, you MUST use your tools.
- Stay on topic. Only address what was asked.
- Be concise but thorough. Deliver the actual findings, not a description of your process.
- NEVER respond with just an acknowledgment ("Sure!", "On it!", "I'll look into this"). Those waste time.
- NEVER say you are "waiting for results" — your tools return results immediately.
- If you used tools and got results, synthesize them into a proper answer.
- Cite your sources when presenting research findings (include URLs where possible).
"""

DELEGATION_INSTRUCTIONS = """

## Delegation

If a task genuinely requires another agent's expertise, create a tracked task:

```json
{
  "actions": [
    {"type": "create_task", "agent_id": "<id>", "title": "...", "instruction": "..."}
  ]
}
```

Rules:
- Only delegate if you truly lack the skills yourself.
- Do NOT delegate just to chat — work independently first.
- Only delegate to agents you are connected to."""


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
        from .. import runtime_settings as _rt
        self._adapter = get_adapter(config.llm_provider, settings, _rt.get())
        self._conversation: list[dict] = []   # rolling window (agent's long-term memory)
        self._task_queue: asyncio.Queue[AgentMessage] = asyncio.Queue()
        self._running = False
        self._on_status_change_cb = None  # injected by orchestrator
        self._orchestrator = None  # set by orchestrator for agents that need it

    def set_orchestrator(self, orchestrator) -> None:
        self._orchestrator = orchestrator

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
                await self._on_idle_tick()
            except Exception as e:
                logger.error(f"[{self.config.name}] loop error: {e}", exc_info=True)

    async def _handle_message(self, msg: AgentMessage) -> None:
        """Process an incoming message. If it's a task, execute it fully and report back."""
        await self._set_status(AgentStatus.THINKING, current_task=msg.task_id, action="Reading message")

        # Resolve sender name
        sender_name = msg.from_agent
        if self._orchestrator:
            sender = next((a for a in self._orchestrator.get_agents() if a.config.id == msg.from_agent), None)
            if sender:
                sender_name = sender.config.name

        try:
            if msg.task_id:
                await self._execute_task(msg, sender_name)
            else:
                # Non-task direct message — process but do NOT reply (prevents chatter)
                self._add_to_conversation("user", f"[From {sender_name}]: {msg.content}")
                await self._set_status(AgentStatus.WORKING, action="Processing...")
                if self.config.skills:
                    response = await self._do_work_with_tools(msg.content)
                else:
                    response = await self._llm_complete()
                self._add_to_conversation("assistant", response.content)
                self.state.token_count += response.input_tokens + response.output_tokens
                self.state.messages_processed += 1
                logger.debug("[%s] Processed direct message from %s (no reply)", self.config.name, sender_name)
        except Exception as e:
            if msg.task_id:
                # Report failure back to assignor
                await self._report_task_failure(msg, str(e))
            logger.error("[%s] Message handling failed: %s", self.config.name, e, exc_info=True)
        finally:
            await self._set_status(AgentStatus.IDLE, current_task=None, action=None)

    async def _execute_task(self, msg: AgentMessage, sender_name: str) -> None:
        """Own a task: execute it fully, then report results back to assignor."""
        task_id = msg.task_id

        # Log that we've received the task
        await database.create_task_log({
            "id": str(uuid.uuid4()),
            "task_id": task_id,
            "agent_id": self.config.id,
            "action": "accepted",
            "detail": f"{self.config.name} accepted task",
        })

        # Add task context to our conversation memory
        self._add_to_conversation("user", f"[Task from {sender_name}]: {msg.content}")

        # Execute — this is where all the work happens internally
        await self._set_status(AgentStatus.WORKING, current_task=task_id, action="Working...")

        if self.config.skills:
            response = await self._do_work_with_tools(msg.content)
        else:
            response = await self._llm_complete()

        final_result = response.content
        tokens = response.input_tokens + response.output_tokens

        # Add result to our conversation memory
        self._add_to_conversation("assistant", final_result)
        self.state.token_count += tokens
        self.state.messages_processed += 1

        # Process any delegation actions in the response
        await self._process_actions(final_result)

        # Store result in DB (but do NOT mark as completed — assignor decides that)
        try:
            task = await database.get_task(task_id)
            if task and task["status"] == "in_progress":
                await database.update_task(task_id, {
                    "result": final_result[:2000],
                    "last_run_at": datetime.utcnow().isoformat(),
                    "token_count": task.get("token_count", 0) + tokens,
                    "run_count": task.get("run_count", 0) + 1,
                })
                await database.create_task_log({
                    "id": str(uuid.uuid4()),
                    "task_id": task_id,
                    "agent_id": self.config.id,
                    "action": "result_submitted",
                    "detail": final_result[:500],
                    "token_count": tokens,
                })
        except Exception as e:
            logger.error("[%s] Failed to update task %s: %s", self.config.name, task_id[:8], e)

        # Send result back to assignor
        logger.info("[%s] Task %s completed, sending result (%d chars) to %s",
                    self.config.name, task_id[:8], len(final_result), sender_name)
        reply = AgentMessage(
            from_agent=self.config.id,
            to_agent=msg.from_agent,
            content=final_result,
            task_id=task_id,
        )
        await self.bus.publish(reply)

    async def _report_task_failure(self, msg: AgentMessage, error: str) -> None:
        """Report a task failure: update DB and notify assignor."""
        try:
            await database.update_task(msg.task_id, {
                "status": "failed",
                "result": f"Agent error: {error}",
                "completed_at": datetime.utcnow().isoformat(),
            })
            await database.create_task_log({
                "id": str(uuid.uuid4()),
                "task_id": msg.task_id,
                "agent_id": self.config.id,
                "action": "failed",
                "detail": error[:500],
            })
        except Exception:
            pass

        # Notify assignor about the failure
        reply = AgentMessage(
            from_agent=self.config.id,
            to_agent=msg.from_agent,
            content=f"[Task Failed] Error: {error}",
            task_id=msg.task_id,
        )
        await self.bus.publish(reply)

    async def _on_idle_tick(self) -> None:
        """Override in subclasses for proactive behaviour."""
        self.state.last_heartbeat = datetime.utcnow()

    # ── Work execution (internal tool loop) ─────────────────────────────────

    async def _do_work_with_tools(self, task_content: str, max_rounds: int = 10) -> LLMResponse:
        """Execute work using tools. All tool calls happen INTERNALLY.
        Only the final synthesized result is returned.

        Uses an isolated work_messages list so intermediate tool calls
        don't leak into the agent's shared conversation or the message bus.
        """
        system = await self._build_system_prompt()
        total_input = 0
        total_output = 0

        # Start with the agent's existing conversation context
        # (includes prior messages for context) but tool rounds go into work_messages
        work_messages = list(self._conversation[-self.config.max_context_messages:])
        tools_used = 0

        for round_num in range(max_rounds):
            await self._set_status(
                AgentStatus.WORKING,
                action=f"Working... (step {round_num + 1})" if tools_used > 0 else "Working..."
            )

            response = await self._adapter.complete(
                system_prompt=system,
                messages=work_messages,
                model=self.config.llm_model,
            )
            total_input += response.input_tokens
            total_output += response.output_tokens

            # Check for tool call
            tool_call = self._parse_tool_call(response.content)

            if not tool_call:
                # No tool call — this might be the final answer
                if self._is_confused_response(response.content) and tools_used > 0:
                    # LLM is confused — nudge it to synthesize
                    logger.warning("[%s] Confused response at round %d, nudging", self.config.name, round_num)
                    work_messages.append({"role": "assistant", "content": response.content})
                    work_messages.append({"role": "user", "content":
                        "[System] You already have all tool results above. "
                        "Write your final answer NOW. Plain text, no JSON."})
                    continue
                # Genuine final answer
                return LLMResponse(content=response.content, input_tokens=total_input,
                                   output_tokens=total_output, model=self.config.llm_model)

            # Execute tool internally
            tool_name = tool_call.get("name", "")
            tool_args = tool_call.get("arguments", {})
            logger.info("[%s] Tool %d: %s(%s)", self.config.name, tools_used + 1, tool_name,
                        json.dumps(tool_args)[:100])

            await self._set_status(AgentStatus.WORKING, action=f"Using {tool_name}...")
            tool_result = await self._execute_tool(tool_name, tool_args)
            tools_used += 1

            # Add to WORK messages only (not to self._conversation)
            work_messages.append({"role": "assistant", "content": response.content})
            work_messages.append({"role": "user", "content": f"[Tool Result — {tool_name}]:\n{tool_result}"})

        # Exhausted all rounds — force a final summary
        logger.info("[%s] Forcing summary after %d tool calls", self.config.name, tools_used)
        work_messages.append({"role": "user", "content":
            "[System] You have used all your tool calls. Write your FINAL ANSWER now "
            "synthesizing everything you learned from the tool results above. "
            "Plain text only — no JSON, no tool calls."})

        summary = await self._adapter.complete(
            system_prompt=system,
            messages=work_messages,
            model=self.config.llm_model,
        )
        total_input += summary.input_tokens
        total_output += summary.output_tokens

        return LLMResponse(content=summary.content, input_tokens=total_input,
                           output_tokens=total_output, model=self.config.llm_model)

    # ── LLM helpers ──────────────────────────────────────────────────────────

    async def _build_system_prompt(self) -> str:
        """Build the full system prompt with SOP, tools, and connections."""
        system = self.config.system_prompt

        # Core work SOP for all non-CEO agents
        if not self.config.is_ceo:
            system += AGENT_WORK_SOP

        # Add tools prompt if agent has skills
        if self.config.skills:
            from ..skills.registry import build_tools_prompt
            tools_section = build_tools_prompt(self.config.skills)
            if tools_section:
                system += tools_section

        # Append delegation instructions if agent has connections
        if not self.config.is_ceo:
            connections = await self._get_outbound_connections()
            if connections:
                system += DELEGATION_INSTRUCTIONS
                system += "\n\n## Your connections\n" + connections

        return system

    async def _llm_complete(self) -> LLMResponse:
        messages = self._conversation[-self.config.max_context_messages:]
        system = await self._build_system_prompt()
        return await self._adapter.complete(
            system_prompt=system,
            messages=messages,
            model=self.config.llm_model,
        )

    def _is_confused_response(self, content: str) -> bool:
        """Detect if the LLM is confused about the tool protocol."""
        lower = content.lower()
        confused = [
            "waiting for", "wait for the", "let me wait", "results will be",
            "i'll wait", "once i receive", "when the results", "pending results",
            "awaiting", "i need to wait",
        ]
        return any(phrase in lower for phrase in confused)

    def _parse_tool_call(self, content: str) -> dict | None:
        """Extract a tool_call JSON from the agent's response."""
        try:
            # Fenced json block (with or without newline after ```json)
            match = re.search(r'```json\s*(.*?)```', content, re.DOTALL)
            if match:
                data = json.loads(match.group(1).strip())
                if isinstance(data, dict) and "tool_call" in data:
                    return data["tool_call"]

            # Bare JSON with tool_call key
            match = re.search(r'\{"tool_call"\s*:', content)
            if match:
                # Find the matching closing brace
                start = match.start()
                depth = 0
                for i in range(start, len(content)):
                    if content[i] == '{':
                        depth += 1
                    elif content[i] == '}':
                        depth -= 1
                        if depth == 0:
                            try:
                                data = json.loads(content[start:i + 1])
                                if "tool_call" in data:
                                    return data["tool_call"]
                            except json.JSONDecodeError:
                                pass
                            break
            return None
        except Exception:
            return None

    async def _execute_tool(self, name: str, arguments: dict) -> str:
        """Execute a registered skill/tool and return its result."""
        from ..skills.registry import get_skill
        skill = get_skill(name)
        if not skill:
            return f"Error: Unknown tool '{name}'"

        if name not in self.config.skills:
            return f"Error: You don't have access to tool '{name}'"

        try:
            fn = skill["callable"]
            result = await fn(**arguments)
            return result
        except Exception as e:
            logger.error("[%s] Tool %s failed: %s", self.config.name, name, e)
            return f"Tool error: {e}"

    def _add_to_conversation(self, role: str, content: str) -> None:
        self._conversation.append({"role": role, "content": content})
        if len(self._conversation) > self.config.max_context_messages * 2:
            self._conversation = self._conversation[-self.config.max_context_messages:]

    # ── Delegation / Actions ─────────────────────────────────────────────────

    async def _get_outbound_connections(self) -> str:
        """Get agents this agent can delegate to."""
        try:
            connections = await database.get_all_connections()
            outbound = [c for c in connections if c["from_id"] == self.config.id]
            if not outbound:
                return ""
            agents_by_id = {}
            if self._orchestrator:
                agents_by_id = {a.config.id: a for a in self._orchestrator.get_agents()}
            lines = []
            for c in outbound:
                agent = agents_by_id.get(c["to_id"])
                if agent:
                    label = f' ({c["label"]})' if c.get("label") else ""
                    lines.append(f"- **{agent.config.name}** (id: `{agent.config.id}`) — {agent.config.role}{label}")
            return "\n".join(lines)
        except Exception:
            return ""

    async def _process_actions(self, content: str) -> list[dict]:
        """Parse and execute action JSON from the agent's response."""
        actions = self._parse_actions(content)
        if not actions:
            return []

        results = []
        for action in actions:
            action_type = action.get("type", "")
            try:
                if action_type == "create_task":
                    result = await self._action_create_task(action)
                else:
                    result = {"status": "skipped", "detail": f"Unknown action: {action_type}"}
                results.append({"action": action_type, **result})
            except Exception as e:
                logger.error("[%s] Action %s failed: %s", self.config.name, action_type, e)
                results.append({"action": action_type, "status": "error", "detail": str(e)})

        if results:
            logger.info("[%s] Executed %d actions", self.config.name, len(results))
        return results

    def _parse_actions(self, content: str) -> list[dict]:
        try:
            match = re.search(r'```json\s*(.*?)```', content, re.DOTALL)
            if not match:
                return []
            data = json.loads(match.group(1).strip())
            if isinstance(data, dict) and "actions" in data:
                return data["actions"]
            return []
        except Exception:
            return []

    async def _action_create_task(self, action: dict) -> dict:
        agent_id = action.get("agent_id", "")
        title = action.get("title", "")
        if not agent_id or not title:
            return {"status": "error", "detail": "Missing agent_id or title"}

        can = await database.can_assign_task(self.config.id, agent_id)
        if not can:
            return {"status": "error", "detail": f"No connection to agent {agent_id}"}

        task_id = str(uuid.uuid4())
        task = {
            "id": task_id,
            "agent_id": agent_id,
            "assigned_by": self.config.id,
            "title": title,
            "instruction": action.get("instruction", ""),
            "task_type": action.get("task_type", "adhoc"),
            "priority": action.get("priority", "normal"),
            "status": "pending",
            "next_run_at": datetime.utcnow().isoformat(),
        }
        await database.create_task(task)
        await database.create_task_log({
            "id": str(uuid.uuid4()),
            "task_id": task_id,
            "agent_id": self.config.id,
            "action": "created",
            "detail": f"{self.config.name} assigned: {title}",
        })
        logger.info("[%s] Created task '%s' for agent %s", self.config.name, title, agent_id)
        return {"status": "ok", "task_id": task_id}

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
