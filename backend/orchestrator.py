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
        elif await database.get_setting("_ceo_prompt_v2") != "1":
            # One-time: upgrade the lead agent from the legacy delegate prompt
            # (uses the deprecated "delegate" array, no depends_on / multi-step
            # workflow support) to the current actions-based prompt. Detect the
            # legacy default specifically, and never run again (flag-guarded), so a
            # user's custom prompt is never clobbered.
            from .agents.ceo_agent import CEO_SYSTEM_PROMPT
            for cfg in configs:
                sp = cfg.system_prompt or ""
                is_legacy = cfg.is_ceo and '"delegate"' in sp and '"actions"' not in sp
                if is_legacy:
                    cfg.system_prompt = CEO_SYSTEM_PROMPT
                    await database.save_agent(cfg.model_dump(mode="json"))
                    logger.info("[orchestrator] Upgraded '%s' from legacy delegate prompt to current CEO prompt", cfg.name)
            await database.set_setting("_ceo_prompt_v2", "1")

        # Ensure the Manager can read the activity log (added after first spawn).
        for cfg in configs:
            if cfg.is_ceo and "activity_log" not in (cfg.skills or []):
                cfg.skills = list(cfg.skills or []) + ["activity_log"]
                await database.save_agent(cfg.model_dump(mode="json"))

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

    async def reload_agents(self) -> None:
        """Tear down running agents and respawn from the DB (used after a restore)."""
        for agent in list(self._agents.values()):
            await agent.stop()
        self._agents.clear()
        self._ceo = None
        agent_rows = await database.get_all_agents()
        for cfg in [_agent_config_from_row(r) for r in agent_rows]:
            await self._spawn_agent(cfg)
        logger.info("[orchestrator] Reloaded %d agents from DB", len(self._agents))

    async def post_daily_update(self) -> None:
        """Manager's daily check-up: summarise every daily-SOP task's latest
        outcome and post it into a 'Daily update' chat conversation."""
        import uuid
        from datetime import date
        from . import compliance
        sops = await database.get_daily_sop_tasks()
        due_policies = await compliance.policies_due_for_review()
        if (not sops and not due_policies) or not self._ceo:
            return
        today = date.today().isoformat()
        names = {a.config.id: a.config.name for a in self.get_agents()}
        failed = [t for t in sops if t.get("status") == "failed"]

        lines = [f"## Daily update — {today}", ""]
        # Policy review reminders first — these need the user's action.
        if due_policies:
            lines.append("### 📋 Policy reviews due")
            for p in due_policies:
                why = (" — " + p["reason"]) if p.get("reason") else (
                    f" — last reviewed {p.get('last_reviewed') or 'never'}" if p.get("last_reviewed") else " — never reviewed")
                lines.append(f"- **{p['name']}** is due for review{why}. Please review and mark it reviewed in Risk & Compliance.")
            lines.append("")
        lines.append(f"Tracking **{len(sops)}** daily SOP task(s) across the team.")
        by_agent: dict[str, list] = {}
        for t in sops:
            by_agent.setdefault(t["agent_id"], []).append(t)
        for aid, ts in by_agent.items():
            lines.append(f"\n**{names.get(aid, aid[:8])}**")
            for t in ts:
                icon = {"completed": "✅", "failed": "❌", "in_progress": "⏳",
                        "pending": "🕗"}.get(t.get("status"), "•")
                last = (t.get("last_run_at") or "not yet run")[:16].replace("T", " ")
                lines.append(f"- {icon} {t['title']} — last run {last}")
                res = (t.get("result") or "").strip()
                if res and t.get("status") == "failed":
                    lines.append(f"    ⚠️ {res[:180]}")
                elif res and t.get("status") == "completed":
                    lines.append(f"    → {res[:180]}")
        if failed:
            lines.append(f"\n⚠️ **{len(failed)} task(s) need attention.**")
        summary = "\n".join(lines)

        conv_id = f"daily-{today}"
        if not await database.get_conversation(conv_id):
            await database.create_conversation(conv_id, title=f"Daily update — {today}")
        await database.save_message({
            "id": uuid.uuid4().hex,
            "conversation_id": conv_id,
            "from_agent_id": self._ceo.config.id,
            "to_agent_id": "user",
            "content": summary,
            "role": "assistant",
            "metadata": {"daily_update": True},
        })
        if self._ws_broadcast:
            from .models import WSEvent, WSEventType
            await self._ws_broadcast(WSEvent(
                type=WSEventType.TASK_COMPLETED,
                payload={"message": summary, "conversation_id": conv_id, "daily_update": True},
            ).model_dump_json())
        logger.info("[orchestrator] Posted daily update covering %d SOP task(s)", len(sops))

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

    # ── Task graph orchestration (system-level) ────────────────────────────────

    def _agent_name(self, agent_id: str) -> str:
        a = self._agents.get(agent_id)
        return a.config.name if a else agent_id

    async def on_task_completed(self, task_id: str, result: str, from_agent_id: str) -> None:
        """A specialist finished a task. The SYSTEM (not the Manager's LLM) now:
          1. validates + records the result,
          2. hands its output directly to any dependent task's agent (agent→agent),
          3. when the whole plan is done, asks the Manager to present it to the user.

        This is the explicit 'rule of engagement': check the task graph, then act.
        """
        from datetime import datetime as _dt
        task = await database.get_task(task_id)
        if not task or task["status"] != "in_progress":
            return

        # Self-heal fix task: the CTO finished patching the code → commit + notify.
        try:
            import json as _json
            ctx = _json.loads(task.get("context") or "{}")
        except Exception:
            ctx = {}
        if ctx.get("heal_incident_id"):
            await database.update_task(task_id, {
                "status": "completed", "result": result[:2000],
                "completed_at": _dt.utcnow().isoformat(),
            })
            from . import self_heal
            await self_heal.finalize_heal(self, ctx["heal_incident_id"], result)
            return

        quality = self._ceo._evaluate_result(result, task) if self._ceo else "good"
        now = _dt.utcnow().isoformat()
        # A task that produced an artifact (image / video / dashboard) is a real
        # deliverable even if its text reply is short — don't fail it as "empty".
        produced_artifact = False
        try:
            produced_artifact = bool(await database.get_artifacts_for_tasks([task_id]))
        except Exception:
            pass
        if quality == "empty" and not produced_artifact:
            await database.update_task(task_id, {
                "status": "failed",
                "result": f"Agent returned no useful result: {result[:200]}",
                "completed_at": now,
            })
            logger.warning("[orchestrator] Task '%s' returned empty result — failed", task.get("title", "")[:40])
            return

        # Risk & Compliance gate — assess the output before finalising it.
        gate = await self._compliance_gate(task, result, from_agent_id, ctx)
        if gate != "proceed":
            return  # remediation re-dispatched, or held for human approval

        await database.update_task(task_id, {
            "status": "completed", "result": result[:2000], "completed_at": now,
            "last_run_at": now, "run_count": task.get("run_count", 0) + 1,
        })
        await database.create_task_log({
            "id": __import__("uuid").uuid4().hex, "task_id": task_id,
            "agent_id": from_agent_id, "action": "completed", "detail": result[:500],
        })
        logger.info("[orchestrator] Task '%s' completed by %s", task.get("title", "")[:40], self._agent_name(from_agent_id))
        await database.log_activity({
            "agent_id": from_agent_id, "agent_name": self._agent_name(from_agent_id),
            "kind": "task", "action": "completed task", "task_id": task_id,
            "summary": f"{task.get('title','')[:80]} → {result[:120]}", "ok": 1,
        })

        await self._handoff_to_dependents(task, result, from_agent_id)
        await self._present_if_plan_complete(task)

    async def _compliance_gate(self, task: dict, result: str, from_agent_id: str, ctx: dict) -> str:
        """Assess a finished task's output via the Risk & Compliance agent.
        Returns 'proceed' (safe), 'remediate' (sent back once), or 'hold' (awaiting
        human approval)."""
        import json as _json
        from datetime import datetime as _dt
        from . import compliance
        rc = compliance.find_rc_agent(self)
        # Don't gate: no R&C agent, the R&C agent's own work, or compliance off.
        if not rc or rc.config.id == from_agent_id:
            return "proceed"
        mode = compliance.get_mode()
        comp = ctx.get("compliance") or {}
        if mode == "off":
            return "proceed"
        # In 'match' mode only gate tasks the Manager flagged as policy-relevant.
        if mode == "match" and not comp.get("required"):
            return "proceed"
        # Use the strictest matched named policy (lowest threshold), else baseline.
        named_policy = None
        try:
            rows = [r for r in [await database.get_risk_policy_row(pid)
                                for pid in (comp.get("policy_ids") or [])] if r]
            if rows:
                named_policy = min(rows, key=lambda r: r.get("threshold", 10))
            else:
                # No specific match → assess against the default policy if one is set.
                named_policy = await database.get_default_risk_policy()
        except Exception:
            named_policy = None
        attempt = int(comp.get("attempt", 0))
        try:
            rec = await compliance.assess(rc, subject=task.get("title", ""), content=result,
                                          task_id=task["id"], attempt=attempt, named_policy=named_policy)
        except Exception as e:
            logger.error("[compliance] gate assessment failed: %s", e)
            return "proceed"  # fail-open so a broken assessor can't block all work
        if rec["verdict"] == "proceed":
            return "proceed"

        details = rec.get("rationale", "")
        if rec.get("findings"):
            details += " Findings: " + ", ".join(f["type"] for f in rec["findings"])

        if attempt == 0:
            # Give the agent ONE chance to self-remediate below the threshold.
            ctx2 = dict(ctx); ctx2.setdefault("compliance", {})["attempt"] = 1
            await database.update_task(task["id"], {
                "status": "in_progress", "context": _json.dumps(ctx2),
                "started_at": _dt.utcnow().isoformat(),
            })
            instruction = (
                f"⚠️ Compliance hold: your output for '{task.get('title','')}' was assessed as "
                f"**{rec['level'].upper()}** risk (score {rec['score']}/25, threshold {rec['threshold']}). "
                f"{details}\n\nRevise your output to reduce the risk below the threshold — remove any "
                "secrets/PII, soften exposure, and address the flagged categories — then resubmit. "
                "This is your one remediation attempt."
            )
            from .models import AgentMessage
            await self.bus.publish(AgentMessage(
                from_agent=rc.config.id, to_agent=from_agent_id,
                content=instruction, task_id=task["id"]))
            logger.info("[compliance] Task '%s' flagged %s — sent back for remediation",
                        task.get("title", "")[:40], rec["level"])
            return "remediate"

        # Second time still over threshold → hold for human approval.
        await database.update_task(task["id"], {"status": "on_hold", "result": result[:2000]})
        await self._notify_risk_hold(task, rec)
        # A compliance hold is a "major incident" — flag the governing policy for
        # review (orgs review policies annually AND after an incident).
        if named_policy and named_policy.get("id"):
            try:
                await database.flag_policy_for_review(
                    named_policy["id"], f"After incident: '{task.get('title','')[:60]}' held at {rec['level']} risk")
            except Exception:
                pass
        logger.info("[compliance] Task '%s' HELD for human approval (%s)",
                    task.get("title", "")[:40], rec["level"])
        return "hold"

    async def _notify_risk_hold(self, task: dict, rec: dict) -> None:
        if not self._ws_broadcast:
            return
        from .models import WSEvent, WSEventType
        payload = {
            "task_id": task["id"], "title": task.get("title", ""),
            "level": rec["level"], "score": rec["score"], "threshold": rec["threshold"],
            "rationale": rec.get("rationale", ""),
            "findings": [f["type"] for f in rec.get("findings", [])],
            "conversation_id": task.get("conversation_id"),
        }
        await self._ws_broadcast(WSEvent(type=WSEventType.RISK_HOLD, payload=payload).model_dump_json())

    async def resolve_risk_hold(self, task_id: str, approve: bool) -> dict:
        """User approves or rejects a held task."""
        task = await database.get_task(task_id)
        if not task or task["status"] != "on_hold":
            return {"ok": False, "error": "Task is not awaiting approval"}
        from datetime import datetime as _dt
        rec = await database.get_latest_risk_for_task(task_id)
        if approve:
            now = _dt.utcnow().isoformat()
            await database.update_task(task_id, {"status": "completed", "completed_at": now, "last_run_at": now})
            if rec:
                rec["decision"] = "approved"; rec["id"] = __import__("uuid").uuid4().hex
                await database.save_risk_assessment(rec)
            fresh = await database.get_task(task_id)
            await self._handoff_to_dependents(fresh, fresh.get("result", ""), fresh["agent_id"])
            await self._present_if_plan_complete(fresh)
            logger.info("[compliance] Held task '%s' APPROVED by user", task.get("title", "")[:40])
        else:
            await database.update_task(task_id, {
                "status": "failed",
                "result": "Rejected by user on compliance review.",
            })
            if rec:
                rec["decision"] = "rejected"; rec["id"] = __import__("uuid").uuid4().hex
                await database.save_risk_assessment(rec)
            logger.info("[compliance] Held task '%s' REJECTED by user", task.get("title", "")[:40])
        return {"ok": True, "decision": "approved" if approve else "rejected"}

    async def on_task_failed(self, task_id: str, error: str, from_agent_id: str) -> None:
        """A task errored. Record it, fail any tasks that depended on it (their
        prerequisite is gone), and present whatever the plan produced."""
        from datetime import datetime as _dt
        task = await database.get_task(task_id)
        if not task:
            return
        now = _dt.utcnow().isoformat()
        await database.update_task(task_id, {
            "status": "failed", "result": f"Agent error: {error}"[:2000], "completed_at": now,
        })
        logger.warning("[orchestrator] Task '%s' failed: %s", task.get("title", "")[:40], str(error)[:120])
        # Cascade: tasks blocked on this one can never run.
        title = (task.get("title") or "").lower()
        try:
            for bt in await database.get_all_tasks(limit=100):
                dep = (bt.get("depends_on") or "").lower()
                if bt.get("status") == "blocked" and dep and (dep in title or title in dep):
                    await database.update_task(bt["id"], {
                        "status": "failed",
                        "result": f"Skipped — prerequisite '{task.get('title','')}' failed.",
                        "completed_at": now,
                    })
        except Exception:
            pass
        await self._present_if_plan_complete(task)

    async def _handoff_to_dependents(self, task: dict, result: str, from_agent_id: str) -> None:
        """Pass a completed task's output DIRECTLY into each dependent task's
        agent (Scarlett → Niss), recording it as structured context input."""
        import json as _json
        from .models import AgentMessage
        from datetime import datetime as _dt
        title = (task.get("title") or "").lower()
        from_name = self._agent_name(from_agent_id)
        try:
            all_tasks = await database.get_all_tasks(limit=100)
        except Exception:
            return
        for bt in all_tasks:
            dep = (bt.get("depends_on") or "").lower()
            if bt.get("status") != "blocked" or not dep:
                continue
            if not (dep in title or title in dep):
                continue
            # Record the upstream output as a named context input for this agent.
            try:
                ctx = _json.loads(bt.get("context") or "{}")
            except Exception:
                ctx = {}
            ctx.setdefault("inputs", []).append({
                "from": from_name, "task": task.get("title", ""), "output": result[:4000],
            })
            objective = ctx.get("objective", "")
            inputs_block = "\n\n".join(
                f"### Input from {i['from']} — \"{i['task']}\"\n{i['output']}" for i in ctx["inputs"]
            )
            enriched = (
                f"{bt['instruction']}\n\n"
                f"--- TASK CONTEXT ---\n"
                + (f"Overall objective: {objective}\n\n" if objective else "")
                + f"You have received the following input(s) to work from:\n\n{inputs_block}"
            )
            now = _dt.utcnow().isoformat()
            await database.update_task(bt["id"], {
                "status": "pending", "instruction": enriched, "context": ctx, "next_run_at": now,
            })
            # Dispatch straight to the downstream agent — FROM the upstream agent,
            # so it is a genuine agent-to-agent hand-off, not a Manager round-trip.
            await self.bus.publish(AgentMessage(
                from_agent=from_agent_id, to_agent=bt["agent_id"],
                content=f"[Task: {bt['title']}]\n\n{enriched}", task_id=bt["id"],
            ))
            await database.update_task(bt["id"], {"status": "in_progress", "started_at": now})
            logger.info("[orchestrator] Handed '%s' output directly to %s for '%s'",
                        from_name, self._agent_name(bt["agent_id"]), bt["title"][:40])

    async def _present_if_plan_complete(self, task: dict) -> None:
        """When every task in the plan (conversation) is finished, ask the Manager
        to present the terminal deliverable(s) to the user."""
        if not self._ceo:
            return
        conv_id = task.get("conversation_id")
        if conv_id:
            plan = await database.get_tasks_for_conversation(conv_id)
        else:
            plan = [task]
        if any(t.get("status") in ("pending", "in_progress", "blocked") for t in plan):
            return  # plan still running
        completed = [t for t in plan if t.get("status") == "completed"]
        if completed:
            await self._ceo.present_results(completed, conv_id)

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
        if getattr(config, "personality", ""):
            from .agent_folders import write_soul
            write_soul(self.settings.data_dir, config.name, config.personality)
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
