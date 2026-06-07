"""
CEO Agent — the orchestrator agent.
Receives tasks from the user, breaks them down, and delegates to specialist agents.
Can create/pause/cancel tasks for connected agents via structured actions in its responses.
"""
from __future__ import annotations
import asyncio
import json
import logging
import re
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from ..models import AgentConfig, AgentMessage, AgentStatus, LLMProvider, Task
from .base_agent import BaseAgent
from .. import database

if TYPE_CHECKING:
    from ..orchestrator import Orchestrator

logger = logging.getLogger(__name__)

CEO_SYSTEM_PROMPT = """You are the Manager of an AI organisation. You manage a team of specialist agents and delegate work to them.

## Your capabilities

You can have normal conversations with the user. When the user asks you to assign work, schedule tasks, or manage your team, you embed **actions** in your response using a JSON block.

## Available actions

Use a ```json block containing an "actions" array. Each action has a "type":

1. **create_task** — Assign a new task to an agent
   - agent_id (required): the target agent's ID
   - title (required): short task title
   - instruction: detailed instructions for the agent
   - task_type: "adhoc" (one-off), "routine" (recurring), or "standing" (ongoing scheduled)
   - priority: "low", "normal", "high", or "urgent"
   - schedule_cron: for recurring tasks — "@daily", "@weekly", "@hourly", "60m", "24h", etc.
   - schedule_human: human-readable schedule description (e.g. "Every weekday at 9am")

2. **pause_task** — Pause a running/pending task
   - task_id (required)

3. **resume_task** — Resume a paused task
   - task_id (required)

4. **cancel_task** — Cancel a task
   - task_id (required)

## Response format

CRITICAL: Your response must have TWO parts:
1. A natural, friendly message to the user FIRST (plain text, no JSON).
2. Then, ONLY if actions are needed, a fenced ```json block at the very end.

Example response:

Great question! I've asked Nami to research that for you. She'll have a summary ready shortly! 🚀

```json
{
  "actions": [
    {"type": "create_task", "agent_id": "...", "title": "...", "instruction": "...", "priority": "normal"}
  ]
}
```

The JSON block is automatically hidden from the user — they only see your plain text message above it.

If no actions are needed, just respond normally without any JSON block.

## Multi-agent coordination

When a request requires multiple agents, think about the **workflow** and create ALL the steps NOW, in a single actions array:

- **Parallel tasks**: If agents can work independently (e.g. "research X" + "research Y"), create separate tasks — no hand-off needed.
- **Sequential/dependent tasks**: If Agent B needs Agent A's output (e.g. one agent gathers data, another formats it into a report/HTML), create BOTH tasks right now. Give Agent B's task a `depends_on` field set to Agent A's task title — the system will automatically run B once A finishes and pass A's output to B.

**CRITICAL — plan the whole workflow upfront.** If you tell the user you'll "hand the results to [Agent] to produce X", you MUST create that follow-up task in the SAME actions array with `depends_on`. NEVER promise a hand-off you don't create — there is no later step where you re-decide; the system only ever runs the tasks you create now. After a task completes you do NOT get another turn to delegate, so chain everything in one go.

Example for dependent work:
```json
{
  "actions": [
    {"type": "create_task", "agent_id": "nami-id", "title": "Research SpaceX financials", "instruction": "Research SpaceX's latest financials and valuation. Your findings will be passed to Bao for analysis."},
    {"type": "create_task", "agent_id": "bao-id", "title": "Analyse SpaceX data", "instruction": "Analyse the SpaceX financial data gathered by Nami. Provide investment insights.", "depends_on": "Research SpaceX financials"}
  ]
}
```

## Critical: Delegate FIRST — only do it yourself as a last resort

Your PRIMARY job is to delegate work to your specialist agents. Follow this order of preference for EVERY request — do not skip ahead:

1. **Find the right specialist and delegate.** Look at your connected agents (listed below) and their roles/skills. If ANY of them is a reasonable fit for the task — including agents that have the specific tool needed (e.g. a finance agent connected to an accounting/Xero MCP, a data analyst, a researcher) — create a task for that agent. This is the default; prefer it almost always.
2. **Only take the task on yourself if delegation is not possible**, specifically when:
   - There is NO connected agent suited to the task (no one has the right role, skills, or tools), OR
   - You already delegated and the agent's task FAILED or returned an unusable result and you must step in, OR
   - It is a trivial quick check (a single factual lookup) that does not warrant creating a full task.

When you DO take it on yourself and the request needs one of your own connected tools (web_search/web_fetch, or an MCP tool such as Xero/accounting, GitHub, or a database), call the tool directly (emit the tool_call JSON) and answer from the result. Never tell the user to go check the system themselves, and never claim you lack access if you have a matching tool under "Available Tools".

Before answering anything from your own knowledge or tools, ask yourself: "Is there a specialist who should do this instead?" If yes, delegate.

Your training data is outdated. When answering ANY factual question (market data, news, prices, valuations, current events), you or your agents MUST use web_search — never answer from training data alone.

When creating research tasks, explicitly instruct agents: "Use web_search and web_fetch to find the LATEST information. Do NOT rely on your training data."

## Rules
- NEVER use the old "delegate" format or "message_to_user" field. ONLY use the "actions" array format shown above.
- ALWAYS use "create_task" when the user asks you to assign work to an agent.
- ALWAYS write your natural language response BEFORE the JSON block, never inside it.
- Only assign tasks to agents you are connected to (listed below).
- ALWAYS delegate research/data tasks — never answer them yourself with potentially outdated info.
- For recurring work (daily reports, weekly reviews), use task_type "routine" with a schedule.
- Keep task instructions **specific, self-contained, and actionable**. The agent should be able to complete the task without asking follow-up questions.
- Include all relevant context in the instruction — don't assume the agent knows background from prior conversations.
- Never show raw agent IDs to the user — use agent names instead.
- Do NOT create multiple tasks for the same request unless the work genuinely requires parallel specialists. One clear task is better than three vague ones.
- You are responsible for monitoring your delegated tasks. If tasks are taking too long, you will be prompted to check in on them and report status to the user."""


class CEOAgent(BaseAgent):
    def __init__(self, config: AgentConfig, message_bus, settings) -> None:
        super().__init__(config, message_bus, settings)
        self._orchestrator: "Orchestrator | None" = None
        # Task ids already included in a synthesis pushed to the user, so we
        # don't re-synthesize the same results on every later task completion.
        self._reported_task_ids: set[str] = set()
        # Only tasks that complete AFTER this point are eligible for synthesis.
        # Without this, a restart (which clears _reported_task_ids) would re-report
        # the entire historical backlog of already-completed tasks.
        self._started_at = datetime.utcnow()
        # Guard against overlapping synthesis runs (which leave the CEO
        # appearing stuck in "Synthesizing results...").
        self._synthesizing: bool = False

    def set_orchestrator(self, orchestrator: "Orchestrator") -> None:
        self._orchestrator = orchestrator

    async def _handle_message(self, msg: AgentMessage) -> None:
        """The Manager receives an agent reply for awareness only. Task completion,
        dependency hand-off, and presenting results are now driven at the SYSTEM
        level by the orchestrator (orchestrator.on_task_completed), so there is no
        per-reply orchestration to do here."""
        if msg.task_id:
            logger.debug("[CEO] Saw reply for task %s from %s", msg.task_id[:8], msg.from_agent)

    def _evaluate_result(self, content: str, task: dict) -> str:
        """Evaluate if an agent's result is useful. Returns 'good', 'short', or 'empty'."""
        if not content or not content.strip():
            return "empty"

        lower = content.strip().lower()

        # Detect confused/empty responses
        garbage_indicators = [
            "waiting for all tool",
            "waiting for the result",
            "i'll wait for",
            "let me wait",
            "once i receive",
            "pending results",
            "[waiting for",
        ]
        for indicator in garbage_indicators:
            if indicator in lower:
                return "empty"

        # Too short to be a real result (but allow short error messages)
        stripped = content.strip()
        if len(stripped) < 30:
            # Very short — might be an error or acknowledgment
            if any(w in lower for w in ["error", "failed", "cannot", "unable"]):
                return "short"  # Accept error reports
            return "empty"

        return "good"

    def _completed_after_start(self, completed_at: str | None) -> bool:
        """True if completed_at is after the Manager started this run."""
        if not completed_at:
            return False
        try:
            dt = datetime.fromisoformat(str(completed_at).replace("Z", ""))
            return dt >= self._started_at
        except Exception:
            # Unparseable timestamp — treat as recent to avoid dropping real results.
            return True

    async def present_results(self, completed_tasks: list[dict], conv_id: str | None) -> None:
        """Present a finished plan's terminal deliverable(s) to the user.

        Called by the orchestrator once every task in a plan is complete. The
        Manager does NOT redo the work — it forwards the specialists' output, only
        the terminal results (intermediate inputs in a chain are skipped).
        """
        acquired = False
        try:
            # Only present tasks we completed during this run and haven't reported.
            new_completed = [
                t for t in completed_tasks
                if t.get("status") == "completed"
                and t["id"] not in self._reported_task_ids
                and self._completed_after_start(t.get("completed_at"))
            ]
            if not new_completed:
                return
            if self._synthesizing:
                return
            self._synthesizing = True
            acquired = True

            for t in new_completed:
                self._reported_task_ids.add(t["id"])

            agents_by_id = {}
            if self._orchestrator:
                agents_by_id = {a.config.id: a.config.name for a in self._orchestrator.get_agents()}

            # In a dependency chain, intermediate results (an agent whose output
            # only feeds another task) are inputs, not deliverables — present only
            # the terminal output(s), not the raw upstream data.
            upstream_titles = {t.get("depends_on") for t in new_completed if t.get("depends_on")}
            terminal = [t for t in new_completed if t.get("title") not in upstream_titles]
            new_completed = terminal or new_completed

            # The Manager PRESENTS the specialists' work — it does NOT redo or
            # re-summarize it (that just adds a slow LLM call and risks mangling
            # the real figures). Forward each completed result directly. This makes
            # reporting near-instant.
            from ..api.routes import _strip_ceo_json
            await self._set_status(AgentStatus.THINKING, action="Presenting results...")
            if len(new_completed) == 1:
                display_content = (_strip_ceo_json(new_completed[0].get("result") or "")).strip() \
                    or "The task completed but didn't return any content."
            else:
                parts = []
                for t in new_completed:
                    aname = agents_by_id.get(t["agent_id"], t["agent_id"])
                    body = (_strip_ceo_json(t.get("result") or "")).strip() or "(no content)"
                    parts.append(f"## {aname} — {t['title']}\n\n{body}")
                display_content = "\n\n---\n\n".join(parts)

            # Collect any rich artifacts the specialists produced for these tasks,
            # so the user gets a "View" button in the synthesized reply.
            artifacts = await database.get_artifacts_for_tasks([t["id"] for t in new_completed])
            artifact_meta = [{"id": a["id"], "title": a["title"], "kind": a["kind"]} for a in artifacts]

            # Save to the plan's own conversation (fall back to most recent).
            if not conv_id:
                conversations = await database.get_conversations(limit=1)
                conv_id = conversations[0]["id"] if conversations else None

            if conv_id:
                msg_id = str(uuid.uuid4())
                await database.save_message({
                    "id": msg_id,
                    "conversation_id": conv_id,
                    "from_agent_id": self.config.id,
                    "to_agent_id": "user",
                    "content": display_content,
                    "role": "assistant",
                    "metadata": {"artifacts": artifact_meta} if artifact_meta else {},
                })

            # Broadcast to WebSocket so frontend picks it up
            if self._orchestrator and self._orchestrator._ws_broadcast:
                from ..models import WSEvent, WSEventType
                await self._orchestrator._ws_broadcast(WSEvent(
                    type=WSEventType.TASK_COMPLETED,
                    payload={
                        "message": display_content,
                        "conversation_id": conv_id,
                        "task_count": len(new_completed),
                        "artifacts": artifact_meta,
                    },
                ))

            await self._set_status(AgentStatus.IDLE, action=None)
            logger.info("[CEO] Presented %d completed task result(s) to user", len(new_completed))

        except Exception as e:
            logger.error("[CEO] Error presenting results: %s", e, exc_info=True)
            await self._set_status(AgentStatus.IDLE, action=None)
        finally:
            if acquired:
                self._synthesizing = False

    async def _unblock_dependents(self, completed_task: dict, result: str) -> None:
        """When a task completes, find blocked tasks that depend on it and dispatch them."""
        try:
            all_tasks = await database.get_all_tasks(limit=200)
            blocked = [t for t in all_tasks if t.get("status") == "blocked" and t.get("depends_on")]
            completed_title = completed_task.get("title", "")

            for bt in blocked:
                dep = bt.get("depends_on", "")
                # Match by title (case-insensitive partial match)
                if dep and completed_title and (dep.lower() in completed_title.lower() or completed_title.lower() in dep.lower()):
                    # Inject the predecessor's result into the instruction
                    enriched_instruction = (
                        f"{bt['instruction']}\n\n"
                        f"--- Results from prerequisite task \"{completed_title}\" ---\n"
                        f"{result[:1500]}"
                    )
                    await database.update_task(bt["id"], {
                        "status": "pending",
                        "instruction": enriched_instruction,
                        "next_run_at": datetime.utcnow().isoformat(),
                    })
                    # Dispatch immediately
                    bus_msg = AgentMessage(
                        from_agent=self.config.id,
                        to_agent=bt["agent_id"],
                        content=f"[Task: {bt['title']}]\n\n{enriched_instruction}",
                        task_id=bt["id"],
                    )
                    await self.bus.publish(bus_msg)
                    await database.update_task(bt["id"], {
                        "status": "in_progress",
                        "started_at": datetime.utcnow().isoformat(),
                    })
                    logger.info("[CEO] Unblocked dependent task '%s' with results from '%s'",
                                bt["title"], completed_title)
        except Exception as e:
            logger.error("[CEO] Error unblocking dependents: %s", e)

    # ── Monitoring: CEO checks on outstanding tasks periodically ─────────

    async def _on_idle_tick(self) -> None:
        """CEO periodically checks for completed tasks that need reporting to user."""
        self.state.last_heartbeat = datetime.utcnow()

        if not hasattr(self, '_last_monitor_check'):
            self._last_monitor_check = datetime.utcnow()
            self._reported_task_ids: set[str] = set()
            return

        # Check every ~60 seconds (6 idle ticks at 10s interval)
        elapsed = (datetime.utcnow() - self._last_monitor_check).total_seconds()
        if elapsed < 60:
            return

        self._last_monitor_check = datetime.utcnow()

        try:
            all_tasks = await database.get_all_tasks(limit=50)
            # NOTE: we deliberately do NOT inject completed-task results into the
            # Manager's conversation memory here. Doing so accumulated every old,
            # unrelated result (e.g. a previous research request) and bled it into
            # later chats. Completed work is reported to the user via the synthesis
            # push in _check_all_tasks_done, which is scoped to the current batch.

            # Check for stuck tasks (in_progress for >10 minutes)
            stuck = []
            for t in all_tasks:
                if (t.get("assigned_by") == self.config.id
                    and t["status"] == "in_progress"
                    and t.get("started_at")):
                    try:
                        started = datetime.fromisoformat(t["started_at"])
                        if (datetime.utcnow() - started).total_seconds() > 600:  # 10 min
                            stuck.append(t)
                    except Exception:
                        pass

            if stuck:
                for t in stuck:
                    agent_name = t["agent_id"]
                    if self._orchestrator:
                        a = next((a for a in self._orchestrator.get_agents() if a.config.id == t["agent_id"]), None)
                        if a:
                            agent_name = a.config.name
                    logger.warning("[CEO] Task '%s' assigned to %s has been running for >10 minutes",
                                   t['title'], agent_name)

            # Prune old reported IDs to avoid memory growth
            if len(self._reported_task_ids) > 200:
                self._reported_task_ids = set(list(self._reported_task_ids)[-100:])

        except Exception as e:
            logger.error("[CEO] Monitor tick error: %s", e)

    async def build_context_prompt(self) -> str:
        """Build context about available agents and their connections for the CEO."""
        roster = self._build_agent_roster()
        connections = await self._build_connection_map_async()
        return (
            f"## Your team\n{roster}\n\n"
            f"## Connections (who you can assign to)\n{connections}"
        )

    async def _connected_mcp_server_ids(self) -> set[str]:
        """MCP server ids granted to agents the Manager is connected to."""
        if not self._orchestrator:
            return set()
        try:
            conns = await database.get_all_connections()
        except Exception:
            return set()
        out_ids = {c["to_id"] for c in conns if c["from_id"] == self.config.id}
        owned: set[str] = set()
        for a in self._orchestrator.get_agents():
            if a.config.id in out_ids:
                for s in a.config.skills:
                    if s.startswith("mcp:") and ":" in s:
                        owned.add(s.split(":", 1)[1])
        return owned

    async def _effective_skills(self) -> list[str]:
        """Hide MCP tools that a connected specialist owns, so the Manager
        delegates to them instead of running the tool itself. The grant is kept
        only as a fallback when no connected agent has that server."""
        delegatable = await self._connected_mcp_server_ids()
        if not delegatable:
            return self.config.skills
        result = []
        for s in self.config.skills:
            if s.startswith("mcp:") and ":" in s and s.split(":", 1)[1] in delegatable:
                continue  # owned by a specialist — delegate instead
            result.append(s)
        return result

    async def _complete_with_tools(
        self, msgs: list[dict], system: str, max_rounds: int | None = None,
    ):
        """Run a bounded tool-calling loop, returning the final LLMResponse.

        Lets the Manager use its OWN tools (web_search/web_fetch, file/shell, and
        any granted MCP tools such as Xero) directly within a chat turn, instead of
        only being able to delegate. Intermediate tool calls are appended to `msgs`
        but the returned response is the final plain-text answer.
        """
        if max_rounds is None:
            max_rounds = self.config.max_iterations if self.config.max_iterations > 0 else 6
        from .base_agent import AGENT_MAX_TOKENS
        last = None
        for _ in range(max_rounds):
            resp = await self._adapter.complete(
                system_prompt=system, messages=msgs, model=self.config.llm_model,
                max_tokens=AGENT_MAX_TOKENS,
            )
            last = resp
            self.state.token_count += resp.input_tokens + resp.output_tokens
            tool_call = self._parse_tool_call(resp.content)
            if not tool_call:
                return resp
            name = tool_call.get("name", "")
            args = tool_call.get("arguments", {}) or {}
            await self._set_status(AgentStatus.WORKING, action=f"Using {name}…")
            result = await self._execute_tool(name, args)
            logger.info("[Manager] tool %s -> %s", name, str(result)[:120])
            msgs.append({"role": "assistant", "content": resp.content})
            msgs.append({"role": "user", "content": f"[Tool Result — {name}]:\n{result}"})
        # Exhausted rounds — force a final synthesis.
        msgs.append({"role": "user", "content":
            "[System] You have used your tool calls. Write your FINAL answer to the "
            "user now in plain text, using the tool results above. No tool calls, no JSON."})
        resp = await self._adapter.complete(
            system_prompt=system, messages=msgs, model=self.config.llm_model,
            max_tokens=AGENT_MAX_TOKENS,
        )
        self.state.token_count += resp.input_tokens + resp.output_tokens
        return resp

    async def chat_with_context(
        self,
        user_message: str,
        image_parts: list | None = None,
        ephemeral: bool = False,
        history: list[dict] | None = None,
        conversation_id: str | None = None,
    ) -> tuple[str, list[dict]]:
        """Chat with full org context. Returns (response_text, executed_actions).

        `image_parts` is an optional list of normalized image content parts
        ({"type": "image", "media_type", "data"}) for vision-capable models.

        When `ephemeral` is True (temporary chat), NOTHING is persisted: the
        CEO's conversation memory is left untouched, no tasks are created or
        delegated, and the only context is the in-screen `history` provided by
        the caller. This keeps temporary chats fully private and transient.
        """
        # Artifacts created in this turn link to the active conversation.
        self._artifact_ctx = {"conversation_id": conversation_id}
        self._pending_artifacts = []
        # The user's objective + conversation, so tasks created this turn record
        # which plan they belong to (used for system-level orchestration).
        self._active_conversation_id = conversation_id
        self._active_objective = user_message

        # Build full context
        roster = self._build_agent_roster()
        connections = await self._build_connection_map_async()
        active_tasks_text = await self._build_active_tasks_summary()

        context = (
            f"\n\n---\n## Organisation context\n\n"
            f"### Your team\n{roster}\n\n"
            f"### Connections\n{connections}\n\n"
            f"### Active tasks\n{active_tasks_text}"
        )

        text = user_message + context
        user_content = [{"type": "text", "text": text}, *image_parts] if image_parts else text

        if ephemeral:
            # Stateless, private turn — do not touch self._conversation.
            text = (
                user_message
                + "\n\n[This is a private, temporary chat. Answer the user directly. "
                "Do NOT create tasks, delegate to agents, or output any action JSON — "
                "nothing here is saved.]"
                + context
            )
            user_content = [{"type": "text", "text": text}, *image_parts] if image_parts else text
            msgs = []
            for h in (history or []):
                if h.get("role") in ("user", "assistant") and h.get("content"):
                    msgs.append({"role": h["role"], "content": h["content"]})
            msgs.append({"role": "user", "content": user_content})
            system = await self._build_system_prompt()
            response = await self._complete_with_tools(msgs, system)
            return response.content, []

        # Memory is scoped to THIS conversation only — load its own history from
        # the DB rather than a shared in-memory blob, so an unrelated earlier chat
        # (e.g. a research request) never bleeds into this one. The caller saves
        # the current user message before calling us, so drop that trailing entry
        # and use our richer user_content (which includes any attachment context).
        msgs: list[dict] = []
        if conversation_id:
            try:
                rows = await database.get_messages(
                    conversation_id=conversation_id,
                    limit=self.config.max_context_messages * 2,
                )
            except Exception:
                rows = []
            if rows and rows[-1].get("role") == "user":
                rows = rows[:-1]
            for m in rows:
                if not m.get("content"):
                    continue
                role = "user" if m.get("role") == "user" else "assistant"
                msgs.append({"role": role, "content": m["content"]})
        msgs.append({"role": "user", "content": user_content})

        # Run a tool loop so the Manager can use its own tools (web/file/shell +
        # granted MCP tools) directly. Persistence is handled by the caller (the
        # chat endpoint saves both messages to this conversation).
        system = await self._build_system_prompt()
        response = await self._complete_with_tools(msgs, system)

        # If the Manager produced a rich HTML deliverable inline, turn it into a
        # viewable artifact instead of dumping raw markup into the chat.
        response_text = await self._maybe_extract_html_artifact(response.content)

        # Parse and execute actions
        actions = self._parse_actions(response_text)
        executed = []
        if actions:
            executed = await self._execute_actions(actions)

        return response_text, executed

    async def handle_user_task(self, task: Task) -> str:
        """Entry point: user sends a task to the CEO via the task system."""
        await self._set_status(AgentStatus.THINKING, current_task=task.id, action="Analysing task")

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

        # Execute any actions in the response
        actions = self._parse_actions(response.content)
        if actions:
            await self._execute_actions(actions)

        await self._set_status(AgentStatus.IDLE, current_task=None, action=None)
        return response.content

    # ── Context builders ─────────────────────────────────────────────────────

    @staticmethod
    def _agent_capabilities(config) -> list[str]:
        """Human-readable special capabilities so the Manager knows who to use for
        image/video/vision/etc. tasks."""
        caps = []
        kinds = {(m.get("kind") or "text").lower() for m in (getattr(config, "extra_models", None) or [])}
        if "image" in kinds:
            caps.append("generate images")
        if "video" in kinds:
            caps.append("generate video")
        if "vision" in kinds:
            caps.append("analyse images (vision)")
        text_labels = [m.get("label") for m in (getattr(config, "extra_models", None) or [])
                       if (m.get("kind") or "text").lower() == "text" and m.get("label")]
        if text_labels:
            caps.append("specialist models: " + ", ".join(text_labels))
        if "create_artifact" in (config.skills or []):
            caps.append("build rich HTML dashboards/reports")
        return caps

    def _build_agent_roster(self) -> str:
        if not self._orchestrator:
            return "No agents available."
        lines = []
        for agent in self._orchestrator.get_agents():
            if not agent.config.is_ceo:
                status = agent.state.status.value if hasattr(agent.state.status, 'value') else agent.state.status
                caps = self._agent_capabilities(agent.config)
                cap_str = f" — CAN: {', '.join(caps)}" if caps else ""
                lines.append(
                    f"- **{agent.config.name}** (id: `{agent.config.id}`) — "
                    f"{agent.config.role}: {agent.config.description} [status: {status}]{cap_str}"
                )
        return "\n".join(lines) if lines else "No specialist agents yet."

    async def _build_connection_map_async(self) -> str:
        if not self._orchestrator:
            return "No connections."
        agents_by_id = {a.config.id: a.config.name for a in self._orchestrator.get_agents()}
        try:
            connections = await database.get_all_connections()
        except Exception:
            return "Could not load connections."
        if not connections:
            return "No connections defined yet."
        lines = []
        for c in connections:
            from_name = agents_by_id.get(c["from_id"], c["from_id"])
            to_name = agents_by_id.get(c["to_id"], c["to_id"])
            label = f' "{c["label"]}"' if c.get("label") else ""
            lines.append(f"- {from_name} → {to_name}{label}")
        return "\n".join(lines)

    async def _build_active_tasks_summary(self) -> str:
        try:
            tasks = await database.get_all_tasks(limit=20)
            if not tasks:
                return "No active tasks."
            lines = []
            agents_by_id = {}
            if self._orchestrator:
                agents_by_id = {a.config.id: a.config.name for a in self._orchestrator.get_agents()}
            for t in tasks:
                if t["status"] in ("completed", "failed"):
                    continue
                agent_name = agents_by_id.get(t["agent_id"], t["agent_id"])
                lines.append(
                    f"- [{t['status']}] \"{t['title']}\" → {agent_name} "
                    f"(id: `{t['id'][:8]}…`, type: {t['task_type']}, priority: {t['priority']})"
                )
            return "\n".join(lines) if lines else "No active tasks."
        except Exception:
            return "Could not load tasks."

    # ── Action parsing ───────────────────────────────────────────────────────

    def _parse_actions(self, content: str) -> list[dict]:
        """Extract actions from a ```json block in the CEO's response."""
        try:
            # Find JSON code block
            match = re.search(r'```json\s*\n(.*?)```', content, re.DOTALL)
            if not match:
                return []
            raw = match.group(1).strip()
            data = json.loads(raw)

            # Support both old "delegate" format and new "actions" format
            if isinstance(data, dict):
                if "actions" in data:
                    return data["actions"]
                if "delegate" in data:
                    # Legacy format — convert to create_task so work is tracked
                    return [
                        {
                            "type": "create_task",
                            "agent_id": d.get("agent_id", ""),
                            "title": d.get("instruction", "")[:80],
                            "instruction": d.get("instruction", ""),
                        }
                        for d in data["delegate"]
                    ]
            return []
        except Exception as e:
            logger.debug("Failed to parse CEO actions: %s", e)
            return []

    # ── Action execution ─────────────────────────────────────────────────────

    def _agent_name_map(self) -> dict[str, str]:
        """Map agent_id -> display name for agents the orchestrator knows about."""
        names: dict[str, str] = {}
        if self._orchestrator:
            for a in self._orchestrator.get_agents():
                names[a.config.id] = a.config.name
        return names

    def _autowire_dependencies(self, actions: list[dict]) -> list[dict]:
        """Infer sequential dependencies across a batch of create_task actions.

        The CEO LLM is not reliable about populating the structured `depends_on`
        field, so when it assigns work to several agents in one batch we detect
        when one task references another agent (by name) that is also being
        assigned work in the same batch. We then:
          1. Set the dependent task's `depends_on` to the upstream task's title
             (so it is created as `blocked` and unblocked when the upstream
             agent reports back), and
          2. Augment the upstream task's instruction so that agent KNOWS its
             output is a prerequisite and will be handed to the downstream agent.
        """
        creates = [a for a in actions if a.get("type") == "create_task" and a.get("agent_id")]
        if len(creates) < 2:
            return actions

        name_map = self._agent_name_map()
        # Build a lookup of agent_name (lower) -> task for tasks in this batch
        by_agent_name = {}
        for a in creates:
            nm = name_map.get(a.get("agent_id", ""), "")
            if nm:
                by_agent_name[nm.lower()] = a

        # Phrases that signal "this task consumes another agent's output"
        dep_signals = (
            "once ", "after ", "based on", "using ", "use the", "take ",
            "from ", "findings", "research", "results", "output", "provided by",
            "hand off", "handoff", "organize", "organise", "compile", "summari",
        )

        for task in creates:
            if task.get("depends_on"):
                continue  # CEO already wired this one
            text = f"{task.get('title','')} {task.get('instruction','')}".lower()
            my_agent = task.get("agent_id", "")

            for other_name_lower, other_task in by_agent_name.items():
                if other_task is task:
                    continue
                if other_task.get("agent_id") == my_agent:
                    continue
                # Does this task mention the other agent by name?
                if other_name_lower not in text:
                    continue
                # And does it look like it consumes their output?
                if not any(sig in text for sig in dep_signals):
                    continue

                upstream_title = other_task.get("title", "")
                if not upstream_title:
                    continue

                # 1. Mark this (downstream) task as dependent
                task["depends_on"] = upstream_title
                downstream_name = name_map.get(my_agent, "the next agent")

                # 2. Tell the upstream agent its output feeds the downstream agent
                handoff_note = (
                    f"\n\nIMPORTANT — HANDOFF: When you finish, your output is a "
                    f"prerequisite for {downstream_name}'s task "
                    f"(\"{upstream_title}\" → \"{task.get('title','')}\"). "
                    f"Report your complete findings back to the Manager; the Manager will "
                    f"forward them to {downstream_name} so they can continue."
                )
                upstream_instruction = other_task.get("instruction", "")
                if "HANDOFF" not in upstream_instruction:
                    other_task["instruction"] = upstream_instruction + handoff_note

                logger.info(
                    "[CEO] Auto-wired dependency: '%s' (%s) depends on '%s'",
                    task.get("title", ""), downstream_name, upstream_title,
                )
                break  # one upstream dependency is enough

        # Cycle/deadlock guard: a task may only depend on one created EARLIER in
        # this batch. Drop any depends_on that points to a same-batch task at a
        # later index (which is what creates A↔B deadlocks where both are blocked).
        title_index = {}
        for i, a in enumerate(creates):
            t = a.get("title", "")
            if t and t not in title_index:
                title_index[t] = i
        for i, a in enumerate(creates):
            dep = a.get("depends_on")
            if dep and dep in title_index and title_index[dep] >= i:
                logger.warning("[CEO] Dropping forward/circular dependency: '%s' depended on later task '%s'",
                               a.get("title", ""), dep)
                a["depends_on"] = None

        return actions

    async def _execute_actions(self, actions: list[dict]) -> list[dict]:
        """Execute parsed actions and return results."""
        actions = self._autowire_dependencies(actions)
        results = []
        for action in actions:
            action_type = action.get("type", "")
            try:
                if action_type == "create_task":
                    result = await self._action_create_task(action)
                elif action_type == "pause_task":
                    result = await self._action_update_task_status(action.get("task_id", ""), "paused")
                elif action_type == "resume_task":
                    result = await self._action_update_task_status(action.get("task_id", ""), "pending")
                elif action_type == "cancel_task":
                    result = await self._action_update_task_status(action.get("task_id", ""), "failed")
                elif action_type == "delegate":
                    result = await self._action_delegate(action)
                else:
                    result = {"status": "error", "detail": f"Unknown action type: {action_type}"}
                results.append({"action": action_type, **result})
            except Exception as e:
                logger.error("CEO action %s failed: %s", action_type, e, exc_info=True)
                results.append({"action": action_type, "status": "error", "detail": str(e)})
        return results

    async def _action_create_task(self, action: dict) -> dict:
        agent_id = action.get("agent_id", "")
        title = action.get("title", "")
        if not agent_id or not title:
            return {"status": "error", "detail": "Missing agent_id or title"}

        # Validate connection
        can_assign = await database.can_assign_task(self.config.id, agent_id)
        if not can_assign:
            return {"status": "error", "detail": f"No connection to agent {agent_id}"}

        task_id = str(uuid.uuid4())
        task_type = action.get("task_type", "adhoc")
        schedule_cron = action.get("schedule_cron")

        # Compute next_run_at for scheduled tasks
        next_run_at = None
        if task_type in ("routine", "standing") and schedule_cron:
            from ..task_scheduler import TaskScheduler
            ts = TaskScheduler.__new__(TaskScheduler)
            next_run_at = ts._compute_next_run(schedule_cron)

        depends_on = action.get("depends_on", "")
        # If task depends on another, mark it as blocked until the dependency completes
        is_blocked = bool(depends_on)

        task = {
            "id": task_id,
            "agent_id": agent_id,
            "assigned_by": self.config.id,
            "title": title,
            "instruction": action.get("instruction", ""),
            "task_type": task_type,
            "priority": action.get("priority", "normal"),
            "status": "blocked" if is_blocked else "pending",
            "schedule_cron": schedule_cron,
            "schedule_human": action.get("schedule_human"),
            "depends_on": depends_on,
            "next_run_at": next_run_at or datetime.utcnow().isoformat(),
            # Plan membership + the overall objective this task serves.
            "conversation_id": getattr(self, "_active_conversation_id", None),
            "context": {"objective": getattr(self, "_active_objective", "")[:600], "inputs": []},
        }
        await database.create_task(task)

        # Log
        await database.create_task_log({
            "id": str(uuid.uuid4()),
            "task_id": task_id,
            "agent_id": self.config.id,
            "action": "created",
            "detail": f"CEO assigned: {title}",
        })

        agent_name = agent_id
        if self._orchestrator:
            a = next((a for a in self._orchestrator.get_agents() if a.config.id == agent_id), None)
            if a:
                agent_name = a.config.name

        logger.info("[CEO] Created task '%s' for %s", title, agent_name)

        # For adhoc tasks that aren't blocked, send an immediate bus message
        # (don't wait for the 60s scheduler tick)
        if task_type == "adhoc" and not is_blocked:
            instruction = action.get("instruction", title)
            msg = AgentMessage(
                from_agent=self.config.id,
                to_agent=agent_id,
                content=f"[Task: {title}]\n\n{instruction}",
                task_id=task_id,
            )
            await self.bus.publish(msg)
            await database.update_task(task_id, {"status": "in_progress", "started_at": datetime.utcnow().isoformat()})
            await database.create_task_log({
                "id": str(uuid.uuid4()),
                "task_id": task_id,
                "agent_id": agent_id,
                "action": "started",
                "detail": "Immediate execution via CEO",
            })

        return {"status": "ok", "task_id": task_id, "agent": agent_name, "agent_id": agent_id}

    async def _action_update_task_status(self, task_id: str, new_status: str) -> dict:
        if not task_id:
            return {"status": "error", "detail": "Missing task_id"}

        # Support partial task IDs (first 8 chars)
        if len(task_id) < 36:
            all_tasks = await database.get_all_tasks(limit=200)
            match = next((t for t in all_tasks if t["id"].startswith(task_id)), None)
            if match:
                task_id = match["id"]

        task = await database.get_task(task_id)
        if not task:
            return {"status": "error", "detail": "Task not found"}

        await database.update_task(task_id, {"status": new_status})
        await database.create_task_log({
            "id": str(uuid.uuid4()),
            "task_id": task_id,
            "agent_id": self.config.id,
            "action": new_status,
            "detail": f"CEO set status to {new_status}",
        })
        logger.info("[CEO] Task %s → %s", task_id[:8], new_status)
        return {"status": "ok", "task_id": task_id, "new_status": new_status}

    async def _action_delegate(self, action: dict) -> dict:
        agent_id = action.get("agent_id", "")
        instruction = action.get("instruction", "")
        if not agent_id or not instruction:
            return {"status": "error", "detail": "Missing agent_id or instruction"}

        msg = AgentMessage(
            from_agent=self.config.id,
            to_agent=agent_id,
            content=instruction,
        )
        logger.info("[CEO] Delegating to %s: %s", agent_id, instruction[:60])
        await self.bus.publish(msg)
        return {"status": "ok", "agent_id": agent_id}


def make_ceo_config() -> AgentConfig:
    return AgentConfig(
        name="Manager",
        role="Manager",
        description="Orchestrates the organisation: breaks down tasks, delegates to specialists, and presents their results back to you.",
        system_prompt=CEO_SYSTEM_PROMPT,
        llm_provider=LLMProvider.ANTHROPIC,
        llm_model="claude-sonnet-4-6",
        skills=["web_search", "web_fetch", "create_artifact"],  # fallback if agents fail
        is_ceo=True,
        avatar_color="#DC2626",
        max_context_messages=30,
    )
