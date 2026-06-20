"""
Task Scheduler — checks for due tasks every 60s and dispatches them to agents.
Runs as a background asyncio task started by the orchestrator.
"""
from __future__ import annotations
import asyncio
import logging
import uuid
from datetime import datetime, timedelta

from . import database
from . import runtime_settings

logger = logging.getLogger(__name__)

# Default heartbeat: how often the platform checks for due tasks (seconds).
# Configurable in Settings via runtime_settings['heartbeat_interval'].
DEFAULT_HEARTBEAT = 300  # 5 minutes


def _heartbeat_interval() -> int:
    try:
        return max(30, int(runtime_settings.get().get("heartbeat_interval", DEFAULT_HEARTBEAT)))
    except Exception:
        return DEFAULT_HEARTBEAT


class TaskScheduler:
    def __init__(self, orchestrator) -> None:
        self._orch = orchestrator
        self._running = False

    async def start(self) -> None:
        self._running = True
        asyncio.create_task(self._loop(), name="task-scheduler")
        logger.info("Task scheduler started (heartbeat=%ds)", _heartbeat_interval())

    async def stop(self) -> None:
        self._running = False

    async def _loop(self) -> None:
        while self._running:
            try:
                await self._tick()
            except Exception as e:
                logger.error("Task scheduler tick error: %s", e, exc_info=True)
            await asyncio.sleep(_heartbeat_interval())  # re-read each cycle so a settings change takes effect

    async def _tick(self) -> None:
        now = datetime.utcnow()

        # Recover stale in_progress tasks (stuck for >5 minutes)
        await self._recover_stale_tasks(now)

        # Once a day, have the Manager post a daily update across all SOPs.
        await self._maybe_daily_update(now)

        due = await database.get_due_tasks(now.isoformat())
        if not due:
            return

        logger.info("Task scheduler found %d due tasks", len(due))
        for task in due:
            asyncio.create_task(self._execute_task(task))

    async def _maybe_daily_update(self, now: datetime) -> None:
        """Auto-post the Manager's daily update once per calendar day."""
        try:
            today = now.date().isoformat()
            if await database.get_setting("_last_daily_update") == today:
                return
            from . import compliance
            sops = await database.get_daily_sop_tasks()
            due = await compliance.policies_due_for_review()
            if not sops and not due:
                return
            if hasattr(self._orch, "post_daily_update"):
                await self._orch.post_daily_update()
            await database.set_setting("_last_daily_update", today)
        except Exception as e:
            logger.error("Daily update failed: %s", e, exc_info=True)

    async def _recover_stale_tasks(self, now: datetime) -> None:
        """Reset in_progress tasks that have been running too long (likely from a crashed process)."""
        try:
            all_tasks = await database.get_all_tasks(limit=100)
            stale_cutoff = (now - timedelta(minutes=5)).isoformat()
            for task in all_tasks:
                if task["status"] == "in_progress" and task.get("started_at", "") < stale_cutoff:
                    logger.warning("Recovering stale task %s ('%s') — resetting to pending",
                                   task["id"][:8], task["title"][:40])
                    await database.update_task(task["id"], {
                        "status": "pending",
                        "next_run_at": now.isoformat(),
                    })
                    await database.create_task_log({
                        "id": str(uuid.uuid4()),
                        "task_id": task["id"],
                        "agent_id": task["agent_id"],
                        "action": "recovered",
                        "detail": "Reset stale in_progress task to pending",
                    })
        except Exception as e:
            logger.error("Stale task recovery failed: %s", e)

    async def _execute_task(self, task: dict) -> None:
        task_id = task["id"]
        agent_id = task["agent_id"]

        # Find the agent in orchestrator
        agent = next(
            (a for a in self._orch.get_agents() if a.config.id == agent_id),
            None,
        )
        if not agent:
            logger.warning("Task %s: agent %s not found, marking failed", task_id, agent_id)
            await database.update_task(task_id, {
                "status": "failed",
                "result": f"Agent {agent_id} not found",
                "completed_at": datetime.utcnow().isoformat(),
            })
            await database.create_task_log({
                "id": str(uuid.uuid4()),
                "task_id": task_id,
                "agent_id": agent_id,
                "action": "failed",
                "detail": "Agent not found in orchestrator",
            })
            return

        # Mark in_progress
        await database.update_task(task_id, {
            "status": "in_progress",
            "started_at": datetime.utcnow().isoformat(),
        })
        await database.create_task_log({
            "id": str(uuid.uuid4()),
            "task_id": task_id,
            "agent_id": agent_id,
            "action": "started",
            "detail": f"Executing: {task['title']}",
        })

        try:
            # Build prompt from task
            prompt = self._build_prompt(task)
            agent._add_to_conversation("user", prompt)
            # Use internal work loop if agent has skills
            if agent.config.skills:
                response = await agent._do_work_with_tools(prompt)
            else:
                response = await agent._llm_complete()
            agent._add_to_conversation("assistant", response.content)

            tokens = response.input_tokens + response.output_tokens
            agent.state.token_count += tokens

            # Update task
            update = {
                "status": "completed",
                "result": response.content,
                "last_run_at": datetime.utcnow().isoformat(),
                "completed_at": datetime.utcnow().isoformat(),
                "token_count": task.get("token_count", 0) + tokens,
                "run_count": task.get("run_count", 0) + 1,
            }

            # For routine/standing tasks, reschedule instead of completing
            if task["task_type"] in ("routine", "standing") and task.get("schedule_cron"):
                update["status"] = "pending"
                update["completed_at"] = None
                next_run = self._compute_next_run(task["schedule_cron"])
                if next_run:
                    update["next_run_at"] = next_run

            await database.update_task(task_id, update)
            await database.create_task_log({
                "id": str(uuid.uuid4()),
                "task_id": task_id,
                "agent_id": agent_id,
                "action": "completed",
                "detail": response.content[:500],
                "token_count": tokens,
            })

            logger.info("Task %s completed by agent %s", task_id, agent.config.name)

        except Exception as e:
            logger.error("Task %s execution failed: %s", task_id, e, exc_info=True)
            await database.update_task(task_id, {
                "status": "failed",
                "result": str(e),
                "completed_at": datetime.utcnow().isoformat(),
            })
            await database.create_task_log({
                "id": str(uuid.uuid4()),
                "task_id": task_id,
                "agent_id": agent_id,
                "action": "failed",
                "detail": str(e),
            })

    def _build_prompt(self, task: dict) -> str:
        parts = [f"[Task: {task['title']}]"]
        if task.get("instruction"):
            parts.append(task["instruction"])
        if task["task_type"] == "routine":
            parts.append(f"(This is a recurring {task.get('schedule_human', 'scheduled')} task.)")
        return "\n\n".join(parts)

    def _compute_next_run(self, cron_expr: str) -> str | None:
        """Simple cron-like next run computation.
        Supports: @hourly, @daily, @weekly, @monthly, or interval like '60m', '24h'.
        For full cron expressions, a library like croniter would be needed.
        """
        now = datetime.utcnow()
        shortcuts = {
            "@hourly": timedelta(hours=1),
            "@daily": timedelta(days=1),
            "@weekly": timedelta(weeks=1),
            "@monthly": timedelta(days=30),
        }
        if cron_expr in shortcuts:
            return (now + shortcuts[cron_expr]).isoformat()

        # Parse interval: "60m", "24h", "7d"
        try:
            if cron_expr.endswith("m"):
                return (now + timedelta(minutes=int(cron_expr[:-1]))).isoformat()
            elif cron_expr.endswith("h"):
                return (now + timedelta(hours=int(cron_expr[:-1]))).isoformat()
            elif cron_expr.endswith("d"):
                return (now + timedelta(days=int(cron_expr[:-1]))).isoformat()
        except ValueError:
            pass

        return None
