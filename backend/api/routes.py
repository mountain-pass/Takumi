"""
REST API routes for agent & task management.
"""
from __future__ import annotations
import logging
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel

logger = logging.getLogger(__name__)
from ..orchestrator import orchestrator
from ..models import AgentConfig, LLMProvider
from ..agents.ceo_agent import make_ceo_config
from .. import runtime_settings
from .. import database

router = APIRouter(prefix="/api")

import re
import json as _json

def _strip_ceo_json(content: str) -> str:
    """Remove JSON blocks from CEO responses and extract the human-readable message.

    Handles multiple formats:
    1. ```json { "actions": [...] } ``` — fenced code block
    2. ```json { "delegate": [...], "message_to_user": "..." } ``` — legacy fenced
    3. Raw JSON object with message_to_user field
    """
    if not content:
        return content

    # Try to extract message_to_user from anywhere in the content
    extracted_msg = None

    # Check fenced json blocks first
    fenced = re.search(r'```json\s*\n(.*?)```', content, re.DOTALL)
    if fenced:
        try:
            data = _json.loads(fenced.group(1).strip())
            if isinstance(data, dict) and "message_to_user" in data:
                extracted_msg = data["message_to_user"]
        except Exception:
            pass
        # Strip the fenced block
        content = re.sub(r'\s*```json\s*\n.*?```\s*', '', content, flags=re.DOTALL).strip()
        if extracted_msg and not content:
            return extracted_msg
        return content or extracted_msg or ""

    # Check for raw JSON object (no fences) — entire content is JSON
    stripped = content.strip()
    if stripped.startswith('{') and stripped.endswith('}'):
        try:
            data = _json.loads(stripped)
            if isinstance(data, dict):
                if "message_to_user" in data:
                    return data["message_to_user"]
                # It's a JSON object but no message — strip it
                return ""
        except Exception:
            pass

    # Check if content has a JSON object somewhere in the middle/end
    json_match = re.search(r'(\{[\s\S]*"(?:actions|delegate)"[\s\S]*\})\s*$', content)
    if json_match:
        before = content[:json_match.start()].strip()
        try:
            data = _json.loads(json_match.group(1))
            if isinstance(data, dict) and "message_to_user" in data:
                extracted_msg = data["message_to_user"]
        except Exception:
            pass
        return before or extracted_msg or content

    return content


# ── Request bodies ────────────────────────────────────────────────────────────

class CreateAgentRequest(BaseModel):
    name: str
    role: str
    description: str
    system_prompt: str
    llm_provider: LLMProvider = LLMProvider.ANTHROPIC
    llm_model: str = "claude-haiku-4-5-20251001"
    skills: list[str] = []
    avatar_color: str = "#4F46E5"
    max_context_messages: int = 20
    # Advanced
    personality: str = ""
    max_iterations: int = 10
    token_budget: int = 0
    hitl_enabled: bool = False
    hitl_triggers: list[str] = []
    extra_models: list[dict] = []


class UpdateAgentRequest(BaseModel):
    name: str | None = None
    role: str | None = None
    description: str | None = None
    system_prompt: str | None = None
    llm_provider: LLMProvider | None = None
    llm_model: str | None = None
    skills: list[str] | None = None
    avatar_color: str | None = None
    api_provider_id: str | None = None
    # Advanced
    personality: str | None = None
    max_iterations: int | None = None
    token_budget: int | None = None
    hitl_enabled: bool | None = None
    hitl_triggers: list[str] | None = None
    extra_models: list[dict] | None = None


class SubmitTaskRequest(BaseModel):
    title: str
    description: str


# ── Agents ────────────────────────────────────────────────────────────────────

@router.get("/agents")
async def list_agents():
    return orchestrator.get_agent_states()


@router.post("/agents", status_code=201)
async def create_agent(req: CreateAgentRequest):
    config = AgentConfig(**req.model_dump())
    agent = await orchestrator.add_agent(config)
    return agent.state.model_dump(mode="json")


@router.post("/agents/bootstrap-ceo", status_code=201)
async def bootstrap_ceo():
    existing = [a for a in orchestrator.get_agents() if a.config.is_ceo]
    if existing:
        return existing[0].state.model_dump(mode="json")
    rt = runtime_settings.get()
    ceo = make_ceo_config()
    ceo.llm_provider = LLMProvider(rt.get("llm_provider", "anthropic"))
    ceo.llm_model = rt.get("llm_model", "claude-sonnet-4-6")
    agent = await orchestrator.add_agent(ceo)
    return agent.state.model_dump(mode="json")


@router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str):
    agent = next((a for a in orchestrator.get_agents() if a.config.id == agent_id), None)
    if not agent:
        raise HTTPException(404, "Agent not found")
    if agent.config.is_ceo:
        raise HTTPException(400, "Cannot remove the Manager agent")
    await orchestrator.remove_agent(agent_id)
    return {"ok": True}


@router.put("/agents/{agent_id}")
@router.patch("/agents/{agent_id}")
async def update_agent(agent_id: str, req: UpdateAgentRequest):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    # api_provider_id can legitimately be set to empty string to clear it
    if "api_provider_id" in req.model_fields_set:
        updates["api_provider_id"] = req.api_provider_id
    config = await orchestrator.update_agent(agent_id, updates)
    if not config:
        raise HTTPException(404, "Agent not found")
    return config.model_dump(mode="json")


# ── Tasks ─────────────────────────────────────────────────────────────────────

@router.get("/tasks")
async def list_tasks():
    return [t.model_dump(mode="json") for t in orchestrator.get_tasks()]


@router.post("/tasks", status_code=201)
async def submit_task(req: SubmitTaskRequest):
    task = await orchestrator.submit_task(req.title, req.description)
    return task.model_dump(mode="json")


# ── Agent Tasks ───────────────────────────────────────────────────────────────

class CreateTaskRequest(BaseModel):
    agent_id: str
    assigned_by: str = "user"
    title: str
    instruction: str = ""
    task_type: str = "adhoc"
    priority: str = "normal"
    schedule_cron: str | None = None
    schedule_human: str | None = None
    parent_task_id: str | None = None
    conversation_id: str | None = None


class UpdateTaskRequest(BaseModel):
    title: str | None = None
    instruction: str | None = None
    task_type: str | None = None
    priority: str | None = None
    status: str | None = None
    schedule_cron: str | None = None
    schedule_human: str | None = None
    result: str | None = None


@router.get("/agent-tasks")
async def list_agent_tasks(agent_id: str | None = None, status: str | None = None, limit: int = 100):
    if agent_id:
        return await database.get_tasks_for_agent(agent_id, status)
    return await database.get_all_tasks(status, limit)


@router.get("/agent-tasks/{task_id}")
async def get_agent_task(task_id: str):
    task = await database.get_task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return task


@router.post("/agent-tasks", status_code=201)
async def create_agent_task(req: CreateTaskRequest):
    import uuid
    # Validate connection: assigned_by must have a connection to agent_id
    if not await database.can_assign_task(req.assigned_by, req.agent_id):
        raise HTTPException(
            403,
            f"Agent '{req.assigned_by}' has no connection to agent '{req.agent_id}'. "
            "Tasks can only be assigned through existing connections."
        )
    # Validate agent exists
    agents = await database.get_all_agents()
    if not any(a["id"] == req.agent_id for a in agents):
        raise HTTPException(404, "Target agent not found")

    task_id = str(uuid.uuid4())
    task = {
        "id": task_id,
        **req.model_dump(),
    }
    await database.create_task(task)

    # Create initial log entry
    await database.create_task_log({
        "id": str(uuid.uuid4()),
        "task_id": task_id,
        "agent_id": req.assigned_by,
        "action": "created",
        "detail": f"Task assigned to agent by {req.assigned_by}",
    })

    return await database.get_task(task_id)


@router.patch("/agent-tasks/{task_id}")
async def update_agent_task(task_id: str, req: UpdateTaskRequest):
    import uuid
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(400, "No updates provided")

    task = await database.update_task(task_id, updates)
    if not task:
        raise HTTPException(404, "Task not found")

    # Log status changes
    if "status" in updates:
        await database.create_task_log({
            "id": str(uuid.uuid4()),
            "task_id": task_id,
            "agent_id": task["agent_id"],
            "action": updates["status"],
            "detail": updates.get("result", ""),
        })

    return task


@router.delete("/agent-tasks/{task_id}")
async def delete_agent_task(task_id: str):
    task = await database.get_task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    await database.delete_task(task_id)
    return {"ok": True}


@router.get("/agent-tasks/{task_id}/logs")
async def get_task_logs(task_id: str, limit: int = 50):
    return await database.get_task_logs(task_id, limit)


@router.get("/agents/{agent_id}/tasks")
async def get_agent_tasks(agent_id: str, status: str | None = None):
    return await database.get_tasks_for_agent(agent_id, status)


@router.get("/agents/{agent_id}/task-logs")
async def get_agent_task_log_history(agent_id: str, limit: int = 100):
    return await database.get_agent_task_logs(agent_id, limit)


# ── Messages ──────────────────────────────────────────────────────────────────

@router.get("/messages")
async def get_messages(agent_id: str | None = None, limit: int = 100):
    from ..message_bus import message_bus
    msgs = message_bus.get_history(agent_id=agent_id, limit=limit)
    return [m.model_dump(mode="json") for m in msgs]


# ── LLM model catalogue ───────────────────────────────────────────────────────

@router.get("/models")
async def get_model_catalogue():
    return {
        "anthropic": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
        "openai": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
        "ollama": ["llama3", "mistral", "mixtral", "phi3", "gemma2"],
        "gemini": ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],
        "glm": ["glm-4", "glm-4-flash", "glm-4-air", "glm-4-airx"],
        "minimax": ["abab6.5s-chat", "abab5.5-chat"],
        "custom": [],
    }


# ── Live Ollama model list ────────────────────────────────────────────────────

@router.get("/ollama/models")
async def get_ollama_models(base_url: str | None = None, api_key: str | None = None):
    import httpx
    rt = runtime_settings.get()
    base_url = (base_url or rt.get("llm_base_url", "")).rstrip("/")
    api_key = api_key if api_key is not None else rt.get("llm_api_key", "")
    if not base_url:
        return {"models": []}
    try:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        is_cloud = "ollama.com" in base_url
        if is_cloud:
            url = "https://ollama.com/v1/models"
        else:
            url = f"{base_url}/api/tags"
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            if is_cloud:
                models = [m["id"] for m in data.get("data", data.get("models", []))]
            else:
                models = [m["name"] for m in data.get("models", [])]
            return {"models": models}
    except Exception:
        return {"models": []}


# ── Organisation settings ─────────────────────────────────────────────────────

class OrgRequest(BaseModel):
    org_name: str
    org_description: str = ""


@router.get("/org")
async def get_org():
    return runtime_settings.get()


@router.post("/org")
async def save_org(req: OrgRequest):
    runtime_settings.update({"org_name": req.org_name, "org_description": req.org_description})
    await database.set_many_settings({"org_name": req.org_name, "org_description": req.org_description})
    return runtime_settings.get()


class HeartbeatRequest(BaseModel):
    seconds: int


@router.post("/settings/heartbeat")
async def set_heartbeat(req: HeartbeatRequest):
    """Configure how often the platform heartbeat checks for due agent tasks."""
    secs = max(30, int(req.seconds))
    runtime_settings.update({"heartbeat_interval": secs})
    return {"ok": True, "heartbeat_interval": secs}


# ── LLM provider settings ─────────────────────────────────────────────────────

class LLMSettingsRequest(BaseModel):
    llm_provider: str
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_model: str = ""


@router.post("/settings/llm")
async def save_llm_settings(req: LLMSettingsRequest):
    data = req.model_dump()
    runtime_settings.update(data)
    await database.set_many_settings({
        "llm_provider": data["llm_provider"],
        "llm_model": data["llm_model"],
        "llm_base_url": data["llm_base_url"],
    })
    if data["llm_api_key"]:
        await database.save_api_key(data["llm_provider"], data["llm_api_key"], data["llm_base_url"])
    return {"ok": True}


# ── LLM connection test ───────────────────────────────────────────────────────

class LLMTestRequest(BaseModel):
    llm_provider: str
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_model: str = ""


@router.post("/llm/models")
async def fetch_llm_models(req: LLMTestRequest):
    """Return available models for a provider given credentials — no saved provider needed."""
    import httpx
    provider = req.llm_provider
    api_key = req.llm_api_key or ""
    base_url = (req.llm_base_url or "").rstrip("/")

    static = {
        "anthropic": ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
        "gemini":    ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
    }
    if provider in static:
        return {"models": static[provider]}

    if provider in ("openai", "openrouter", "custom"):
        default_base = {
            "openai": "https://api.openai.com/v1",
            "openrouter": "https://openrouter.ai/api/v1",
        }
        url = (base_url or default_base.get(provider, "")) + "/models"
        try:
            headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                all_models = [m["id"] for m in data.get("data", [])]
                if provider == "openai":
                    filtered = sorted([m for m in all_models if any(k in m for k in ("gpt", "o1", "o3", "o4"))])
                    return {"models": filtered or all_models[:30]}
                return {"models": sorted(all_models[:50])}
        except Exception:
            if provider == "openai":
                return {"models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"]}
            return {"models": []}

    if provider == "ollama":
        is_cloud = "ollama.com" in base_url
        url = "https://ollama.com/v1/models" if is_cloud else f"{base_url}/api/tags"
        try:
            headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
            async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                models = [m["id"] for m in data.get("data", data.get("models", []))] if is_cloud else [m["name"] for m in data.get("models", [])]
                return {"models": models}
        except Exception:
            return {"models": []}

    return {"models": []}


@router.post("/llm/test")
async def test_llm(req: LLMTestRequest):
    from ..llm_adapters.factory import get_adapter
    from ..config import get_settings

    rt = req.model_dump()
    try:
        provider = LLMProvider(req.llm_provider)

        # Custom / OpenAI-compatible gateway with no explicit model → validate via
        # /models (avoids 404s from picking an unprovisioned model).
        if req.llm_provider in ("custom", "openai", "openrouter") and not req.llm_model:
            try:
                models = await _list_models_raw(rt.get("llm_base_url", ""), rt.get("llm_api_key", ""))
            except Exception as e:
                raise HTTPException(400, f"Could not reach the provider: {e}")
            if not models:
                raise HTTPException(400, "Connected, but no models were returned. Specify a model name.")
            return {"ok": True, "models_available": len(models)}

        adapter = get_adapter(provider, get_settings(), rt)
        model = req.llm_model or await _resolve_test_model(
            req.llm_provider, rt.get("llm_base_url", ""), rt.get("llm_api_key", ""))
        if not model:
            raise HTTPException(400, "No model specified and none could be discovered from this provider.")
        resp = await adapter.complete(
            system_prompt="You are a helpful assistant.",
            messages=[{"role": "user", "content": "Reply with only the word: ready"}],
            model=model,
            max_tokens=10,
        )
        return {"ok": True, "response": resp.content.strip()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))


def _default_model(provider: str) -> str:
    defaults = {
        "anthropic": "claude-haiku-4-5-20251001",
        "openai": "gpt-4o-mini",
        "ollama": "gemma3:4b",
        "gemini": "gemini-1.5-flash",
        "glm": "glm-4-flash",
        "minimax": "abab6.5s-chat",
        "openrouter": "openai/gpt-4o-mini",
        "custom": "",
    }
    return defaults.get(provider, "")


async def _list_models_raw(base_url: str, api_key: str) -> list[str]:
    """Fetch model ids from an OpenAI-compatible /models endpoint."""
    import httpx
    url = (base_url.rstrip("/") if base_url else "") + "/models"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient(timeout=12) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        return [m.get("id") for m in resp.json().get("data", []) if m.get("id")]


async def _resolve_test_model(provider: str, base_url: str, api_key: str) -> str:
    """Pick a real model name to test with, discovered from /models when possible."""
    if provider in ("custom", "openai", "openrouter"):
        try:
            models = await _list_models_raw(base_url, api_key)
            if models:
                return models[0]
        except Exception:
            pass
    return _default_model(provider)


# ── AI prompt enhancement ─────────────────────────────────────────────────────

class PromptEnhanceRequest(BaseModel):
    agent_name: str
    agent_role: str
    agent_description: str = ""
    current_prompt: str = ""
    mode: str = "system_prompt"   # 'system_prompt' | 'personality'


@router.post("/prompt-enhance")
async def enhance_prompt(req: PromptEnhanceRequest):
    from ..llm_adapters.factory import get_adapter
    from ..config import get_settings

    rt = runtime_settings.get()
    provider_str = rt.get("llm_provider", "")
    if not provider_str:
        raise HTTPException(400, "No LLM configured. Complete setup first.")

    try:
        provider = LLMProvider(provider_str)
        adapter = get_adapter(provider, get_settings(), rt)
        model = rt.get("llm_model") or _default_model(provider_str)

        if req.mode == "personality":
            meta = (
                "You are an expert at crafting the PERSONALITY ('soul') of an AI agent — its character, "
                "not its job. Given the agent's name, role, and description, write a vivid personality "
                "profile covering: tone of voice, temperament, values, communication quirks, and how it "
                "makes the people it works with feel. Keep it to a few tight sentences or short bullets. "
                "Write in second person (\"You are...\"). Do NOT describe responsibilities, tasks, or tools — "
                "only character and tone. Return ONLY the personality text, no preamble."
            )
            user_msg = (
                f"Agent name: {req.agent_name}\n"
                f"Role: {req.agent_role}\n"
                f"Description: {req.agent_description}\n"
                + (f"\nCurrent personality (refine this):\n{req.current_prompt}" if req.current_prompt else "")
            )
        else:
            meta = (
                "You are an expert at crafting system prompts for AI agents in a multi-agent organisation. "
                "Given the agent's name, role, and description, write a comprehensive system prompt that covers:\n"
                "1. **Identity & Expertise** — who the agent is, their domain knowledge, and professional background\n"
                "2. **Core Responsibilities** — specific tasks and duties this agent handles\n"
                "3. **Behavioural Guidelines** — communication style, tone, and how they interact with other agents and users\n"
                "4. **Decision-Making Principles** — how they prioritise, what they escalate, and when they ask for help\n"
                "5. **Output Standards** — quality expectations, formats, and deliverables they produce\n\n"
                "Write the prompt in second person (\"You are...\"). Be specific and actionable, not generic. "
                "Tailor every detail to the role described. Return ONLY the system prompt text, no preamble or explanation."
            )
            user_msg = (
                f"Agent name: {req.agent_name}\n"
                f"Role: {req.agent_role}\n"
                f"Description: {req.agent_description}\n"
                + (f"\nCurrent prompt (improve and expand on this):\n{req.current_prompt}" if req.current_prompt else "")
            )

        resp = await adapter.complete(
            system_prompt=meta,
            messages=[{"role": "user", "content": user_msg}],
            model=model,
            max_tokens=600,
            temperature=0.7,
        )
        return {"prompt": resp.content.strip()}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Setup completion ──────────────────────────────────────────────────────────

@router.post("/org/reset")
async def reset_org():
    """Wipe all data and return to onboarding."""
    db = database._conn()
    for table in ("agent_task_logs", "agent_tasks", "messages", "conversations",
                  "agent_connections", "agents", "api_providers", "api_keys", "org_settings"):
        await db.execute(f"DELETE FROM {table}")
    await db.commit()
    runtime_settings.reset()
    orchestrator.reset()

    # Remove the legacy organisation.json so the one-time JSON migration can't
    # resurrect the wiped org/agents on the next restart (the DB is now the
    # source of truth for organisation details).
    import os
    legacy = os.path.join(orchestrator.settings.data_dir, "organisation.json")
    try:
        if os.path.exists(legacy):
            os.remove(legacy)
    except OSError as e:
        logger.warning("Could not remove legacy organisation.json: %s", e)

    return {"ok": True}


@router.post("/setup/complete")
async def complete_setup():
    runtime_settings.update({"configured": True})
    await database.set_setting("configured", "True")
    return {"ok": True}


# ── Agent connections ─────────────────────────────────────────────────────────

class ConnectionRequest(BaseModel):
    from_id: str
    to_id: str
    label: str = ""


class UpdateConnectionRequest(BaseModel):
    label: str = ""


@router.get("/connections")
async def list_connections():
    return await database.get_all_connections()


@router.post("/connections", status_code=201)
async def create_connection(req: ConnectionRequest):
    conn_id = await database.save_connection(req.from_id, req.to_id, req.label)
    return {"id": conn_id, "from_id": req.from_id, "to_id": req.to_id, "label": req.label}


@router.put("/connections/{from_id}/{to_id}")
async def update_connection(from_id: str, to_id: str, req: UpdateConnectionRequest):
    await database.update_connection_label(from_id, to_id, req.label)
    return {"ok": True}


@router.delete("/connections/{from_id}/{to_id}")
async def remove_connection(from_id: str, to_id: str):
    await database.delete_connection(from_id, to_id)
    return {"ok": True}


# ── Canvas positions ──────────────────────────────────────────────────────────

class CanvasPositionsRequest(BaseModel):
    positions: dict[str, dict]


@router.post("/canvas/positions")
async def save_positions(req: CanvasPositionsRequest):
    await database.save_all_canvas_positions(req.positions)
    for agent in orchestrator.get_agents():
        pos = req.positions.get(agent.config.id)
        if pos:
            agent.config.canvas_x = pos.get("x", 0)
            agent.config.canvas_y = pos.get("y", 0)
    return {"ok": True}


# ── Conversations ─────────────────────────────────────────────────────────────

@router.get("/conversations")
async def list_conversations(limit: int = 50):
    return await database.get_conversations(limit)


@router.get("/conversations/{conv_id}/messages")
async def get_conversation_messages(conv_id: str, limit: int = 200):
    messages = await database.get_messages(conversation_id=conv_id, limit=limit)
    agents_by_id = {a.config.id: a.config.name for a in orchestrator.get_agents()}
    for msg in messages:
        if msg.get("role") == "assistant":
            msg["content"] = _strip_ceo_json(msg.get("content", ""))
            # Reconstruct action_summaries from stored metadata
            actions = msg.get("metadata", {}).get("actions", [])
            summaries = []
            for act in actions:
                atype = act.get("action", "")
                if act.get("status") != "ok":
                    continue
                if atype == "create_task":
                    name = agents_by_id.get(act.get("agent_id", ""), act.get("agent", "agent"))
                    summaries.append(f"📋 Task created for **{name}**")
                elif atype == "delegate":
                    name = agents_by_id.get(act.get("agent_id", ""), "agent")
                    summaries.append(f"💬 Message sent to **{name}**")
            if summaries:
                msg["action_summaries"] = summaries
    return messages


@router.delete("/conversations/{conv_id}")
async def delete_conversation(conv_id: str):
    await database.delete_conversation(conv_id)
    return {"ok": True}


# ── Chat (user ↔ CEO) ────────────────────────────────────────────────────────

class ChatAttachment(BaseModel):
    name: str
    mime_type: str = ""
    data: str  # base64 (raw or data: URI)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatSendRequest(BaseModel):
    conversation_id: str
    message: str
    is_temporary: bool = False
    attachments: list[ChatAttachment] = []
    # For temporary chats: prior in-screen messages (never persisted).
    history: list[ChatMessage] = []


@router.post("/chat/send")
async def chat_send(req: ChatSendRequest):
    import uuid
    from .. import attachments as attach

    ceo = next((a for a in orchestrator.get_agents() if a.config.is_ceo), None)
    if not ceo:
        raise HTTPException(400, "No Manager agent available")

    provider = ceo.config.llm_provider.value if hasattr(ceo.config.llm_provider, "value") else str(ceo.config.llm_provider)
    model = ceo.config.llm_model
    can_see = attach.model_supports_vision(provider, model)

    # ── Temporary chat: fully ephemeral. Nothing is saved to disk, DB, or the
    #    CEO's memory. Attachments are decoded in-memory only. ──────────────────
    if req.is_temporary:
        image_parts = []
        doc_sections = []
        for a in req.attachments:
            try:
                raw, b64, mime = attach.decode_b64(a.data, a.mime_type)
            except Exception as e:
                logger.error("Failed to decode temporary attachment %s: %s", a.name, e)
                continue
            if attach.kind_for(mime or "") == "image":
                image_parts.append({"type": "image", "media_type": mime or "image/png", "data": b64})
            else:
                text = attach.extract_text_from_bytes(raw, mime)
                if text.strip():
                    doc_sections.append(f"\n\n--- Attached file: {a.name} ---\n{text[:attach.MAX_DOC_CHARS]}")
                else:
                    doc_sections.append(f"\n\n--- Attached file: {a.name} (could not extract text) ---")

        message_for_llm = req.message + "".join(doc_sections)
        vision_warning = ""
        llm_image_parts = None
        if image_parts:
            if can_see:
                llm_image_parts = image_parts
            else:
                adapter = getattr(ceo, "_adapter", None)
                is_ollama_cloud = (provider == "ollama" and getattr(adapter, "_cloud", False))
                described = ""
                if is_ollama_cloud and adapter is not None:
                    for vmodel in attach.OLLAMA_CLOUD_VISION_MODELS:
                        described = await attach.describe_images(adapter, image_parts, vmodel, prompt_hint=req.message)
                        if described.strip():
                            break
                if described.strip():
                    message_for_llm += f"\n\n--- Image analysis (auto-decoded by a vision model) ---\n{described}"
                else:
                    vision_warning = attach.vision_unsupported_message(provider, model)
                    message_for_llm += f"\n\n[Note: {len(image_parts)} image(s) were attached but the current model cannot view them.]"

        history = [{"role": m.role, "content": m.content} for m in req.history if m.role in ("user", "assistant")]
        try:
            response_content, _ = await ceo.chat_with_context(
                message_for_llm, image_parts=llm_image_parts, ephemeral=True, history=history
            )
        except Exception as e:
            logger.error(f"CEO LLM call failed: {e}", exc_info=True)
            raise HTTPException(502, f"CEO LLM call failed: {e}")

        display_content = _strip_ceo_json(response_content)
        if vision_warning:
            display_content = f"{vision_warning}\n\n{display_content}"
        return {
            "id": str(uuid.uuid4()),
            "content": display_content,
            "from_agent_id": ceo.config.id,
            "role": "assistant",
            "actions": [],
            "action_summaries": [],
        }

    conv = await database.get_conversation(req.conversation_id)
    if not conv:
        await database.create_conversation(
            req.conversation_id,
            title=req.message[:80],
            is_temporary=req.is_temporary,
        )

    # ── Process attachments: persist to disk, extract document text, and
    #    prepare image parts for vision-capable models ────────────────────────
    data_dir = orchestrator.settings.data_dir

    saved_meta = []      # stored on the user message for display/history
    image_parts = []     # native image blocks (normalized)
    doc_sections = []     # extracted document text appended to the message
    for a in req.attachments:
        try:
            meta = attach.save_attachment(data_dir, req.conversation_id, a.name, a.mime_type, a.data)
        except Exception as e:
            logger.error("Failed to save attachment %s: %s", a.name, e)
            continue
        saved_meta.append({k: meta[k] for k in ("id", "name", "mime_type", "kind", "url", "size")})

        if meta["kind"] == "image":
            image_parts.append({
                "type": "image",
                "media_type": meta["mime_type"],
                "data": attach.read_base64(meta["path"]),
            })
        else:
            text = attach.extract_text(meta["path"], meta["mime_type"])
            if text.strip():
                doc_sections.append(f"\n\n--- Attached file: {meta['name']} ---\n{text[:attach.MAX_DOC_CHARS]}")
            else:
                doc_sections.append(f"\n\n--- Attached file: {meta['name']} (could not extract text) ---")

    message_for_llm = req.message + "".join(doc_sections)
    vision_warning = ""
    llm_image_parts = None  # passed to the CEO only when its own model can see

    if image_parts:
        if can_see:
            # CEO's own model is multimodal — send images natively.
            llm_image_parts = image_parts
        else:
            # CEO's model can't see images. If it's on Ollama Cloud, transparently
            # decode the image(s) with a cloud vision model and inject the
            # description as text — no need for the user to switch models.
            adapter = getattr(ceo, "_adapter", None)
            is_ollama_cloud = (
                provider == "ollama" and getattr(adapter, "_cloud", False)
            )
            described = ""
            if is_ollama_cloud and adapter is not None:
                for vmodel in attach.OLLAMA_CLOUD_VISION_MODELS:
                    described = await attach.describe_images(
                        adapter, image_parts, vmodel, prompt_hint=req.message
                    )
                    if described.strip():
                        logger.info("[chat] Decoded %d image(s) via Ollama Cloud vision model '%s'",
                                    len(image_parts), vmodel)
                        break
            if described.strip():
                message_for_llm += (
                    f"\n\n--- Image analysis (auto-decoded by a vision model) ---\n{described}"
                )
            else:
                vision_warning = attach.vision_unsupported_message(provider, model)
                message_for_llm += (
                    f"\n\n[Note: {len(image_parts)} image(s) were attached but the current model cannot view them.]"
                )

    user_msg_id = str(uuid.uuid4())
    await database.save_message({
        "id": user_msg_id,
        "conversation_id": req.conversation_id,
        "from_agent_id": "user",
        "to_agent_id": ceo.config.id,
        "content": req.message,
        "role": "user",
        "metadata": {"attachments": saved_meta} if saved_meta else {},
    })

    try:
        response_content, executed_actions = await ceo.chat_with_context(
            message_for_llm, image_parts=llm_image_parts,
            conversation_id=req.conversation_id,
        )
    except Exception as e:
        logger.error(f"CEO LLM call failed: {e}", exc_info=True)
        raise HTTPException(502, f"CEO LLM call failed: {e}")

    # Artifacts (rich HTML) the Manager produced this turn → side-panel viewer.
    artifacts = list(getattr(ceo, "_pending_artifacts", []) or [])

    assistant_msg_id = str(uuid.uuid4())
    msg_metadata = {}
    if executed_actions:
        msg_metadata["actions"] = executed_actions
    if artifacts:
        msg_metadata["artifacts"] = artifacts
    await database.save_message({
        "id": assistant_msg_id,
        "conversation_id": req.conversation_id,
        "from_agent_id": ceo.config.id,
        "to_agent_id": "user",
        "content": response_content,
        "role": "assistant",
        "metadata": msg_metadata,
    })

    if not req.is_temporary:
        first_msg = req.message[:80]
        await database.update_conversation(req.conversation_id, first_msg)

    # Strip JSON action block from the content shown to user
    import re
    display_content = _strip_ceo_json(response_content)
    if vision_warning:
        display_content = f"{vision_warning}\n\n{display_content}"

    # Build human-readable action summaries
    action_summaries = []
    agents_by_id = {a.config.id: a.config.name for a in orchestrator.get_agents()}
    for act in executed_actions:
        atype = act.get("action", "")
        status = act.get("status", "")
        if status != "ok":
            continue
        if atype == "create_task":
            agent_name = agents_by_id.get(act.get("agent_id", ""), act.get("agent", "agent"))
            action_summaries.append(f"📋 Task created for **{agent_name}**")
        elif atype == "delegate":
            agent_name = agents_by_id.get(act.get("agent_id", ""), "agent")
            action_summaries.append(f"💬 Message sent to **{agent_name}**")
        elif atype in ("pause_task", "resume_task", "cancel_task"):
            action_summaries.append(f"⏸️ Task {atype.replace('_task', '')}d")

    return {
        "id": assistant_msg_id,
        "content": display_content,
        "from_agent_id": ceo.config.id,
        "role": "assistant",
        "actions": executed_actions,
        "action_summaries": action_summaries,
        "artifacts": artifacts,
    }


# ── Uploaded attachment files ────────────────────────────────────────────────

@router.get("/uploads/{conversation_id}/{filename}")
async def get_upload(conversation_id: str, filename: str):
    import os
    import re as _re
    from fastapi.responses import FileResponse

    # Prevent path traversal — only allow plain filename/conversation segments.
    safe_conv = _re.sub(r"[^A-Za-z0-9_-]", "_", conversation_id)
    safe_name = os.path.basename(filename)
    path = os.path.join(orchestrator.settings.data_dir, "uploads", safe_conv, safe_name)
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    return FileResponse(path)


# ── Artifacts (rich HTML viewer) ──────────────────────────────────────────────

@router.get("/artifacts/{artifact_id}")
async def get_artifact_meta(artifact_id: str):
    a = await database.get_artifact(artifact_id)
    if not a:
        raise HTTPException(404, "Artifact not found")
    return {
        "id": a["id"], "title": a["title"], "kind": a["kind"],
        "agent_id": a["agent_id"], "created_at": a["created_at"],
        "content": a["content"],
    }


@router.get("/artifacts/{artifact_id}/raw")
async def get_artifact_raw(artifact_id: str):
    """Serve an artifact: HTML inline, image/video as the media itself."""
    from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse, Response
    a = await database.get_artifact(artifact_id)
    if not a:
        raise HTTPException(404, "Artifact not found")
    kind = a["kind"]
    content = a["content"]
    if kind in ("image", "video"):
        # content is either a remote URL or a data: URI.
        if content.startswith("data:"):
            try:
                header, b64 = content.split(",", 1)
                media_type = header.split(":", 1)[1].split(";", 1)[0]
                import base64 as _b64
                return Response(_b64.b64decode(b64), media_type=media_type)
            except Exception:
                raise HTTPException(500, "Bad media data URI")
        return RedirectResponse(content)
    if kind == "html":
        return HTMLResponse(_guard_html_artifact(content))
    return PlainTextResponse(content)


# Guard injected into served HTML artifacts. Chart.js (and similar) with
# responsive:true + maintainAspectRatio:false grows the <canvas> to fill its
# parent every frame; if the parent has no bounded height the page grows forever.
# This caps each canvas's parent to a fixed, sane height so it can't run away.
_ARTIFACT_GUARD = """
<style>html,body{max-width:100%}canvas{max-height:75vh!important}</style>
<script>
(function(){
  function clamp(){
    document.querySelectorAll('canvas').forEach(function(cv){
      var p = cv.parentElement; if(!p) return;
      if(!p.dataset._clamped){
        p.dataset._clamped='1';
        var h = Math.round(Math.min(window.innerHeight*0.6, 520));
        p.style.height = h+'px';
        p.style.maxHeight = '75vh';
        if(getComputedStyle(p).position==='static') p.style.position='relative';
      }
    });
  }
  if(document.readyState!=='loading') clamp();
  document.addEventListener('DOMContentLoaded', clamp);
  window.addEventListener('load', function(){ clamp(); setTimeout(clamp,300); });
})();
</script>
"""


def _guard_html_artifact(html: str) -> str:
    """Inject the runaway-canvas guard into an HTML artifact."""
    if "</body>" in html:
        return html.replace("</body>", _ARTIFACT_GUARD + "</body>", 1)
    return html + _ARTIFACT_GUARD


# ── Agent interview wizard ────────────────────────────────────────────────────

class InterviewQuestionsReq(BaseModel):
    role: str = ""
    description: str = ""
    system_prompt: str = ""
    constraints: dict = {}


class InterviewRunReq(BaseModel):
    role: str = ""
    description: str = ""
    system_prompt: str = ""
    questions: list[str] = []
    model_ids: list[str] = []
    constraints: dict = {}
    max_cost_per_model: float = 1.0
    max_tokens_per_model: int = 10000


@router.get("/openrouter/models")
async def openrouter_models():
    """List OpenRouter models (requires a configured OpenRouter provider)."""
    from .. import interview
    prov = await interview.get_openrouter_provider()
    if not prov:
        raise HTTPException(400, "No OpenRouter provider configured")
    try:
        models = await interview.list_models(prov.get("api_key", ""), prov.get("base_url", ""))
    except Exception as e:
        raise HTTPException(502, f"Could not reach OpenRouter: {e}")
    present = {m["id"] for m in models}
    curated = [mid for mid in interview.CURATED_MODEL_IDS if mid in present]
    return {"provider_id": prov["id"], "models": models, "curated": curated}


@router.post("/interview/questions")
async def interview_questions(req: InterviewQuestionsReq):
    from .. import interview
    qs = await interview.generate_questions(
        orchestrator, req.role, req.description, req.system_prompt, req.constraints)
    return {"questions": qs}


@router.post("/interview/run")
async def interview_run(req: InterviewRunReq):
    """Interview each selected model and have the Manager rank them."""
    import asyncio
    from .. import interview
    prov = await interview.get_openrouter_provider()
    if not prov:
        raise HTTPException(400, "No OpenRouter provider configured")
    if not req.model_ids or not req.questions:
        raise HTTPException(400, "Need at least one model and one question")
    base, key = prov.get("base_url", ""), prov.get("api_key", "")
    transcripts = await asyncio.gather(*[
        interview.interview_model(base, key, mid, req.system_prompt, req.questions,
                                  req.max_cost_per_model, req.max_tokens_per_model)
        for mid in req.model_ids[:12]
    ])
    recommendation = await interview.evaluate(
        orchestrator, req.role, req.description, req.constraints, list(transcripts))
    total_cost = round(sum(t.get("cost", 0) for t in transcripts), 4)
    return {"transcripts": list(transcripts), "recommendation": recommendation,
            "total_cost": total_cost}


# ── Backup / Restore ──────────────────────────────────────────────────────────

@router.get("/backup")
async def backup_export():
    """Download a zip of the org config (agents, connections, providers/keys, MCP
    servers, org settings) plus each agent's folder files (agent.md, soul.md, …)."""
    import io, os, zipfile, json as _json
    from datetime import datetime
    from fastapi.responses import Response

    data = await database.export_tables(database.BACKUP_TABLES)
    manifest = {"app": "takumi", "format": 1, "created_at": datetime.utcnow().isoformat()}

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", _json.dumps(manifest, indent=2))
        z.writestr("data.json", _json.dumps(data, indent=2, default=str))
        # Agent folder files (agent.md / soul.md / memory.md / skills.md).
        agents_root = os.path.join(orchestrator.settings.data_dir, "agents")
        if os.path.isdir(agents_root):
            for root, _dirs, files in os.walk(agents_root):
                for f in files:
                    if f.startswith("."):  # skip .DS_Store and other dotfiles
                        continue
                    full = os.path.join(root, f)
                    arc = os.path.relpath(full, orchestrator.settings.data_dir)  # agents/<slug>/file
                    z.write(full, arcname=arc)
    buf.seek(0)
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    return Response(
        buf.read(), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="takumi-backup-{stamp}.zip"'},
    )


@router.post("/restore")
async def backup_restore(file: UploadFile = File(...)):
    """Restore from a backup zip (replaces config + agent folders), then reload."""
    import io, os, zipfile, json as _json

    raw = await file.read()
    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
    except Exception:
        raise HTTPException(400, "Not a valid zip file")
    if "data.json" not in z.namelist():
        raise HTTPException(400, "Backup is missing data.json")
    try:
        data = _json.loads(z.read("data.json"))
    except Exception as e:
        raise HTTPException(400, f"Corrupt data.json: {e}")

    # 1. Replace config tables.
    counts = await database.import_tables(data, database.BACKUP_TABLES)

    # 2. Restore agent folder files (zip-slip guarded).
    data_dir = os.path.abspath(orchestrator.settings.data_dir)
    files_written = 0
    for name in z.namelist():
        if not name.startswith("agents/") or name.endswith("/"):
            continue
        target = os.path.abspath(os.path.join(data_dir, name))
        if not target.startswith(data_dir + os.sep):
            continue  # path traversal — skip
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as fp:
            fp.write(z.read(name))
        files_written += 1

    # 3. Refresh runtime settings (org name etc.) from the restored DB.
    db_settings = await database.get_all_settings()
    patch = {}
    for key in ("org_name", "org_description", "llm_provider", "llm_model", "llm_base_url", "configured"):
        if key in db_settings:
            patch[key] = db_settings[key] if key != "configured" else (db_settings[key] == "True")
    if patch:
        runtime_settings.update(patch)

    # 4. Reload live agents + MCP connections.
    await orchestrator.reload_agents()
    try:
        from ..mcp_manager import mcp_manager
        await mcp_manager.stop()
        await mcp_manager.start()
    except Exception as e:
        logger.warning("MCP reconnect after restore failed: %s", e)

    return {"ok": True, "imported": counts, "agent_files": files_written}


# ── Activity log (system-wide) ────────────────────────────────────────────────

@router.get("/activity")
async def get_activity_log(hours: float = 24, agent_id: str | None = None, limit: int = 200):
    from datetime import datetime, timedelta
    since = (datetime.utcnow() - timedelta(hours=hours)).isoformat()
    return await database.get_activity(since_iso=since, agent_id=agent_id, limit=limit)


# ── Risk & Compliance ─────────────────────────────────────────────────────────

@router.get("/risk/register")
async def risk_register(limit: int = 50):
    return await database.get_risk_assessments(limit)


@router.get("/risk/audit")
async def risk_audit(days: float = 30, limit: int = 500):
    """Audit trail of executed tasks and compliance governance events."""
    from datetime import datetime, timedelta
    since = (datetime.utcnow() - timedelta(days=days)).isoformat()
    return await database.get_activity(since_iso=since, limit=limit)


# ── Notifications ─────────────────────────────────────────────────────────────

@router.get("/notifications")
async def list_notifications(limit: int = 50):
    items = await database.get_notifications(limit=limit)
    unread = sum(1 for n in items if not n.get("read"))
    return {"notifications": items, "unread": unread}


@router.post("/notifications/read")
async def read_all_notifications():
    await database.mark_all_notifications_read()
    return {"ok": True}


@router.post("/notifications/{nid}/read")
async def read_notification(nid: str):
    await database.mark_notification_read(nid)
    return {"ok": True}


@router.delete("/notifications/{nid}")
async def dismiss_notification_route(nid: str):
    await database.dismiss_notification(nid)
    return {"ok": True}


@router.delete("/notifications")
async def clear_notifications_route():
    await database.clear_notifications()
    return {"ok": True}


@router.get("/risk/policy")
async def get_risk_policy():
    from .. import compliance
    policy = compliance.get_policy()
    return {**policy, "mode": compliance.get_mode(), "all_categories": compliance.CATEGORIES,
            "levels": {"low": "1-4", "medium": "5-9", "high": "10-15", "critical": "16-25"}}


class RiskPolicyReq(BaseModel):
    threshold: int | None = None
    appetite: str | None = None
    categories: list[str] | None = None
    likelihood_scale: list | None = None       # [{label, definition}]
    consequence_scale: list | None = None       # [{label, definition}]
    mode: str | None = None   # 'all' | 'unless_excluded' | 'off'


@router.post("/risk/policy")
async def set_risk_policy(req: RiskPolicyReq):
    from .. import compliance
    policy = compliance.get_policy()
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if "mode" in updates:
        m = updates.pop("mode")
        if m == "match":  # legacy alias
            m = "unless_excluded"
        if m in ("all", "unless_excluded", "off"):
            runtime_settings.update({"compliance_mode": m})
    if "threshold" in updates:
        updates["threshold"] = max(1, min(25, int(updates["threshold"])))
    policy.update(updates)
    runtime_settings.update({"risk_policy": policy})
    return {"ok": True, "policy": policy, "mode": compliance.get_mode()}


# ── Named risk policies (matchable) ──────────────────────────────────────────

@router.get("/risk/policies")
async def list_named_policies():
    from .. import compliance
    rows = await database.list_risk_policies()
    return [{**p, **compliance.review_status(p)} for p in rows]


class NamedPolicyReq(BaseModel):
    id: str | None = None
    name: str = ""
    body: str = ""
    threshold: int = 10
    enabled: bool = True
    transcript: list = []     # the interview Q&A this policy was derived from
    make_default: bool = False
    review_frequency_months: int = 12
    rationale: str = ""       # how the block-at-score was derived
    impact_table: list = []   # per-category severity (1-5) definitions = the appetite


@router.post("/risk/policies")
async def save_named_policy(req: NamedPolicyReq):
    import uuid
    from .. import compliance
    pid = req.id or uuid.uuid4().hex
    mgr = next((a for a in orchestrator.get_agents() if a.config.is_ceo), None)
    summary = await compliance.summarise_policy(mgr, req.name, req.body)
    if not summary:  # fall back to the policy text so matching still works
        summary = (req.body or "").strip()[:240]
    # Preserve rationale/impact_table/transcript on edits if the client didn't
    # resend them — e.g. "Save policy" only posts body/threshold, and must NOT
    # wipe the interview transcript the policy was derived from.
    rationale = req.rationale
    impact_table = compliance._norm_impact_table(req.impact_table) if req.impact_table else []
    transcript = req.transcript or []
    if req.id:
        existing = await database.get_risk_policy_row(req.id)
        if not rationale:
            rationale = (existing or {}).get("rationale", "")
        if not impact_table:
            try:
                impact_table = compliance._norm_impact_table(_json.loads((existing or {}).get("impact_table") or "[]"))
            except Exception:
                impact_table = []
        if not transcript:
            try:
                transcript = _json.loads((existing or {}).get("transcript") or "[]")
            except Exception:
                transcript = []
    if not impact_table:  # always store a full table so the document renders
        impact_table = compliance._norm_impact_table([])
    await database.save_risk_policy({
        "id": pid, "name": req.name, "body": req.body, "summary": summary,
        "threshold": max(1, min(25, int(req.threshold))), "enabled": int(req.enabled),
        "transcript": transcript, "review_frequency_months": req.review_frequency_months,
        "rationale": rationale, "impact_table": impact_table,
    })
    # First policy becomes the active (default) global policy; or if requested.
    existing = await database.list_risk_policies()
    if req.make_default or len(existing) == 1:
        await database.set_default_risk_policy(pid)
    return await database.get_risk_policy_row(pid)


@router.post("/risk/policies/{policy_id}/reviewed")
async def mark_policy_reviewed(policy_id: str):
    if not await database.get_risk_policy_row(policy_id):
        raise HTTPException(404, "Policy not found")
    await database.mark_policy_reviewed(policy_id)
    return {"ok": True}


@router.post("/risk/policies/{policy_id}/default")
async def set_default_policy(policy_id: str):
    if not await database.get_risk_policy_row(policy_id):
        raise HTTPException(404, "Policy not found")
    await database.set_default_risk_policy(policy_id)
    return {"ok": True, "default": policy_id}


@router.delete("/risk/policies/{policy_id}")
async def delete_named_policy(policy_id: str):
    row = await database.get_risk_policy_row(policy_id)
    was_default = bool(row and row.get("is_default"))
    await database.delete_risk_policy(policy_id)
    # If we deleted the active policy, promote another so the agent still has one.
    if was_default:
        remaining = await database.list_risk_policies()
        if remaining:
            await database.set_default_risk_policy(remaining[0]["id"])
    return {"ok": True}


class InterviewReq(BaseModel):
    history: list = []   # [{role:'assistant'|'user', content:str}]


@router.post("/risk/interview")
async def risk_interview(req: InterviewReq):
    """One turn of the policy interview, driven by the Manager."""
    from .. import compliance
    mgr = next((a for a in orchestrator.get_agents() if a.config.is_ceo), None)
    return await compliance.policy_interview(mgr, req.history)


class RiskDecisionReq(BaseModel):
    approve: bool


@router.post("/tasks/{task_id}/risk-decision")
async def risk_decision(task_id: str, req: RiskDecisionReq):
    res = await orchestrator.resolve_risk_hold(task_id, req.approve)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error", "Could not resolve"))
    return res


# ── Self-heal ─────────────────────────────────────────────────────────────────

@router.get("/self-heal")
async def list_heal_incidents():
    return await database.get_heal_incidents()


@router.post("/self-heal/{incident_id}/approve")
async def approve_heal(incident_id: str):
    from .. import self_heal
    inc = await database.get_heal_incident(incident_id)
    if not inc:
        raise HTTPException(404, "Incident not found")
    res = await self_heal.run_heal(orchestrator, incident_id)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error", "Could not start self-heal"))
    return res


@router.post("/self-heal/{incident_id}/dismiss")
async def dismiss_heal(incident_id: str):
    await database.update_heal_incident(incident_id, {"status": "dismissed"})
    return {"ok": True}


# ── API Providers ────────────────────────────────────────────────────────────

class ApiProviderCreate(BaseModel):
    name: str
    type: str = "llm"
    provider: str = ""
    api_key: str = ""
    base_url: str = ""


class ApiProviderUpdate(BaseModel):
    name: str | None = None
    provider: str | None = None
    api_key: str | None = None
    base_url: str | None = None


@router.get("/providers")
async def list_providers():
    providers = await database.get_all_api_providers()
    # Mask api_key in list response
    for p in providers:
        if p.get("api_key"):
            p["api_key_set"] = True
            p["api_key"] = ""
        else:
            p["api_key_set"] = False
    return providers


@router.post("/providers", status_code=201)
async def create_provider(req: ApiProviderCreate):
    import uuid
    provider_id = str(uuid.uuid4())
    record = await database.create_api_provider({
        "id": provider_id,
        "name": req.name,
        "type": req.type,
        "provider": req.provider,
        "api_key": req.api_key,
        "base_url": req.base_url,
    })
    record["api_key_set"] = bool(req.api_key)
    record["api_key"] = ""
    return record


@router.put("/providers/{provider_id}")
async def update_provider(provider_id: str, req: ApiProviderUpdate):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    record = await database.update_api_provider(provider_id, updates)
    if not record:
        raise HTTPException(404, "Provider not found")
    record["api_key_set"] = bool(record.get("api_key"))
    record["api_key"] = ""
    return record


@router.delete("/providers/{provider_id}")
async def delete_provider(provider_id: str):
    await database.delete_api_provider(provider_id)
    return {"ok": True}


@router.get("/providers/{provider_id}/models")
async def list_provider_models(provider_id: str):
    """Fetch available models for a specific api_provider record."""
    import httpx
    rows = await database.get_all_api_providers()
    rec = next((r for r in rows if r["id"] == provider_id), None)
    if not rec:
        raise HTTPException(404, "Provider not found")

    provider = rec["provider"]
    api_key = rec["api_key"]
    base_url = rec["base_url"].rstrip("/") if rec["base_url"] else ""

    # Static catalogues for providers that don't expose a model-list endpoint
    static = {
        "anthropic": ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
        "gemini": ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
        "glm": ["glm-4", "glm-4-flash", "glm-4-air", "glm-4-airx"],
        "minimax": ["abab6.5s-chat", "abab5.5-chat"],
    }
    if provider in static:
        return {"models": static[provider]}

    # OpenAI-compatible: GET /v1/models
    if provider in ("openai", "openrouter", "custom"):
        default_base = {"openai": "https://api.openai.com/v1", "openrouter": "https://openrouter.ai/api/v1"}
        url = (base_url or default_base.get(provider, "")) + "/models"
        try:
            headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                all_models = [m["id"] for m in data.get("data", [])]
                if provider == "openai":
                    filtered = sorted([m for m in all_models if any(k in m for k in ("gpt", "o1", "o3", "o4"))])
                    return {"models": filtered or all_models[:30]}
                return {"models": sorted(all_models[:50])}
        except Exception:
            if provider == "openai":
                return {"models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"]}
            return {"models": []}

    # Ollama
    if provider == "ollama":
        is_cloud = "ollama.com" in base_url
        url = "https://ollama.com/v1/models" if is_cloud else f"{base_url}/api/tags"
        try:
            headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
            async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                if is_cloud:
                    models = [m["id"] for m in data.get("data", data.get("models", []))]
                else:
                    models = [m["name"] for m in data.get("models", [])]
                return {"models": models}
        except Exception:
            return {"models": []}

    return {"models": []}


@router.post("/providers/{provider_id}/test")
async def test_provider(provider_id: str):
    """Test connectivity for a saved api_provider."""
    rows = await database.get_all_api_providers()
    rec = next((r for r in rows if r["id"] == provider_id), None)
    if not rec:
        raise HTTPException(404, "Provider not found")

    from ..llm_adapters.factory import get_adapter
    from ..config import get_settings

    rt = {
        "llm_provider": rec["provider"],
        "llm_api_key": rec["api_key"],
        "llm_base_url": rec["base_url"],
        "llm_model": "",
    }
    try:
        provider = LLMProvider(rec["provider"])

        # For custom / OpenAI-compatible gateways (NVIDIA, Agnes, etc.), validate by
        # listing models. A successful /models call proves the endpoint + key work.
        # We do NOT run a completion with an arbitrary model — many gateways list
        # hundreds of models, most not provisioned for a given account (→ 404).
        if rec["provider"] in ("custom", "openai", "openrouter"):
            try:
                models = await _list_models_raw(rec["base_url"], rec["api_key"])
            except Exception as e:
                raise HTTPException(400, f"Could not reach the provider: {e}")
            if not models:
                raise HTTPException(400, "Connected, but the provider returned no models. "
                                         "Set an explicit model name on the agent.")
            return {"ok": True, "models_available": len(models), "sample_models": models[:8]}

        adapter = get_adapter(provider, get_settings(), rt)
        model = await _resolve_test_model(rec["provider"], rec["base_url"], rec["api_key"])
        resp = await adapter.complete(
            system_prompt="You are a helpful assistant.",
            messages=[{"role": "user", "content": "Reply with only the word: ready"}],
            model=model,
            max_tokens=10,
        )
        return {"ok": True, "model": model, "response": resp.content.strip()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))


# ── Message history (agent-to-agent) ──────────────────────────────────────────

@router.get("/messages/history")
async def get_message_history(
    from_agent: str | None = None,
    to_agent: str | None = None,
    limit: int = 100,
):
    if from_agent and to_agent:
        return await database.get_agent_to_agent_messages(from_agent, to_agent, limit)
    return await database.get_messages(from_agent_id=from_agent, to_agent_id=to_agent, limit=limit)


# ── MCP servers ───────────────────────────────────────────────────────────────

class MCPServerBody(BaseModel):
    name: str
    transport: str = "stdio"            # 'stdio' | 'http' | 'sse'
    command: str = ""
    args: list[str] = []
    env: dict[str, str] = {}
    url: str = ""
    headers: dict[str, str] = {}
    auth: str = "none"                  # 'none' | 'oauth'
    enabled: bool = True


def _mcp_public(s: dict) -> dict:
    """Server record + live connection status/tools."""
    from ..mcp_manager import mcp_manager
    status = mcp_manager.status_for(s["id"])
    return {**s, "status": status.get("status", "disconnected"),
            "error": status.get("error", ""),
            "authorize_url": status.get("authorize_url", ""),
            "tools": status.get("tools", [])}


@router.get("/mcp/servers")
async def list_mcp_servers():
    servers = await database.get_all_mcp_servers()
    return [_mcp_public(s) for s in servers]


@router.post("/mcp/servers", status_code=201)
async def create_mcp_server(req: MCPServerBody):
    import uuid
    from ..mcp_manager import mcp_manager
    record = {"id": str(uuid.uuid4()), **req.model_dump()}
    await database.save_mcp_server(record)
    await mcp_manager.refresh(record)
    try:
        from .. import notifications
        await notifications.push(
            type="info",
            title="New MCP server connected",
            body=f"“{record.get('name', 'A server')}” is now available to your agents.",
            action="View servers",
            link_view="skills",
        )
    except Exception:
        pass
    return _mcp_public(record)


@router.put("/mcp/servers/{server_id}")
async def update_mcp_server(server_id: str, req: MCPServerBody):
    from ..mcp_manager import mcp_manager
    existing = await database.get_mcp_server(server_id)
    if not existing:
        raise HTTPException(404, "MCP server not found")
    record = {"id": server_id, **req.model_dump()}
    await database.save_mcp_server(record)
    await mcp_manager.refresh(record)
    return _mcp_public(record)


@router.delete("/mcp/servers/{server_id}")
async def delete_mcp_server(server_id: str):
    from ..mcp_manager import mcp_manager
    await mcp_manager.remove(server_id)
    await database.clear_mcp_oauth(server_id)
    await database.delete_mcp_server(server_id)
    return {"ok": True}


@router.post("/mcp/servers/{server_id}/refresh")
async def refresh_mcp_server(server_id: str):
    from ..mcp_manager import mcp_manager
    record = await database.get_mcp_server(server_id)
    if not record:
        raise HTTPException(404, "MCP server not found")
    await mcp_manager.refresh(record)
    return _mcp_public(record)


@router.post("/mcp/servers/{server_id}/signout")
async def signout_mcp_server(server_id: str):
    """Forget stored OAuth tokens and disconnect (forces re-authorization)."""
    from ..mcp_manager import mcp_manager
    await mcp_manager.remove(server_id)
    await database.clear_mcp_oauth(server_id)
    return {"ok": True}


@router.get("/mcp/oauth/callback")
async def mcp_oauth_callback(code: str = "", state: str = "", error: str = ""):
    """OAuth redirect target. Resolves the pending flow and reconnects the server."""
    from fastapi.responses import HTMLResponse
    from ..mcp_oauth import resolve_callback

    def page(title: str, msg: str, ok: bool) -> HTMLResponse:
        colour = "#059669" if ok else "#DC2626"
        return HTMLResponse(
            f"""<!doctype html><html><head><meta charset='utf-8'><title>{title}</title>
            <style>body{{font-family:-apple-system,system-ui,sans-serif;display:flex;
            height:100vh;margin:0;align-items:center;justify-content:center;background:#f9fafb}}
            .card{{text-align:center;padding:2rem 2.5rem;background:#fff;border-radius:1rem;
            box-shadow:0 1px 3px rgba(0,0,0,.1)}}h1{{color:{colour};font-size:1.1rem;margin:0 0 .5rem}}
            p{{color:#6b7280;font-size:.85rem;margin:0}}</style></head>
            <body><div class='card'><h1>{title}</h1><p>{msg}</p></div>
            <script>setTimeout(()=>window.close(),2500)</script></body></html>"""
        )

    if error:
        return page("Authorization failed", error, False)
    if not code or not state:
        return page("Authorization failed", "Missing code or state.", False)
    if resolve_callback(state, code):
        return page("Authorized ✓", "You can close this window and return to Takumi.", True)
    return page("Authorization expired", "This request was not recognised. Please try connecting again.", False)


# ── Workflows ─────────────────────────────────────────────────────────────────

class WorkflowReq(BaseModel):
    name: str | None = None
    description: str | None = None
    graph: dict | None = None
    status: str | None = None
    require_compliance: bool | None = None
    trigger_type: str | None = None
    trigger_config: dict | None = None


@router.get("/workflows")
async def list_workflows_route():
    workflows = await database.list_workflows()
    # Attach last-run status for the list view.
    for wf in workflows:
        runs = await database.list_runs(wf["id"], limit=1)
        wf["last_run"] = runs[0] if runs else None
    return {"workflows": workflows}


@router.post("/workflows")
async def create_workflow_route(req: WorkflowReq):
    import uuid as _uuid
    wf = {
        "id": _uuid.uuid4().hex,
        "name": req.name or "Untitled workflow",
        "description": req.description or "",
        "graph": req.graph or {"nodes": [], "edges": []},
        "status": "draft",
        "require_compliance": True if req.require_compliance is None else req.require_compliance,
        "trigger_type": req.trigger_type or "manual",
        "trigger_config": req.trigger_config or {},
    }
    return await database.create_workflow(wf)


@router.get("/workflows/{wf_id}")
async def get_workflow_route(wf_id: str):
    wf = await database.get_workflow(wf_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    wf["runs"] = await database.list_runs(wf_id, limit=20)
    return wf


@router.put("/workflows/{wf_id}")
async def update_workflow_route(wf_id: str, req: WorkflowReq):
    import uuid as _uuid
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    # Webhook workflows get a stable token at save time so a test URL is available
    # before publishing (otherwise there's no URL to POST to while test-listening).
    if updates.get("trigger_type") == "webhook":
        cfg = dict(updates.get("trigger_config") or {})
        if not cfg.get("token"):
            existing = await database.get_workflow(wf_id)
            cfg["token"] = ((existing or {}).get("trigger_config") or {}).get("token") or _uuid.uuid4().hex
        updates["trigger_config"] = cfg
    wf = await database.update_workflow(wf_id, updates)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return wf


@router.delete("/workflows/{wf_id}")
async def delete_workflow_route(wf_id: str):
    await database.delete_workflow(wf_id)
    return {"ok": True}


class WorkflowTestReq(BaseModel):
    payload: dict | None = None
    until: str | None = None   # node id — run up to this node only ('Execute step')
    single: bool = False       # with `until`: run ONLY that node using `payload` as its input
    context: dict | None = None  # with `single`: upstream outputs (by node id/label) for {{token}} resolution


WEBHOOK_TEST_TIMEOUT = 60  # seconds to wait for a real webhook call during a test
_running_tests: dict = {}  # wf_id -> asyncio.Task for the in-flight editor test run


@router.post("/workflows/{wf_id}/test")
async def test_workflow_route(req: WorkflowTestReq, wf_id: str):
    import asyncio
    from ..workflows import run_workflow
    from ..workflows import webhook_wait
    wf = await database.get_workflow(wf_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")

    payload = req.payload
    # Webhook trigger with no sample payload → wait for a real call to the hook URL.
    if wf.get("trigger_type") == "webhook" and not payload:
        fut = webhook_wait.arm(wf_id)
        try:
            payload = await asyncio.wait_for(fut, timeout=WEBHOOK_TEST_TIMEOUT)
        except (asyncio.TimeoutError, asyncio.CancelledError) as e:
            webhook_wait.disarm(wf_id)
            cancelled = isinstance(e, asyncio.CancelledError)
            return {"run_id": None, "timeout": not cancelled, "cancelled": cancelled,
                    "message": "Test stopped." if cancelled else
                               f"No webhook call received within {WEBHOOK_TEST_TIMEOUT}s. "
                               f"POST to the webhook URL, then test again."}

    # Run as a cancellable task and register it so /stop-test can cancel an actually
    # executing run (not just a webhook wait).
    task = asyncio.ensure_future(run_workflow(
        wf, payload or {}, mode="test", trigger_source="editor", orchestrator=orchestrator,
        until_node=None if req.single else req.until,
        only_node=req.until if req.single else None,
        seed_context=req.context if req.single else None))
    _running_tests[wf_id] = task
    try:
        run_id = await task
    except asyncio.CancelledError:
        return {"run_id": None, "cancelled": True, "message": "Execution stopped."}
    finally:
        if _running_tests.get(wf_id) is task:
            _running_tests.pop(wf_id, None)
    return {"run_id": run_id, "run": await database.get_run(run_id)}


@router.post("/workflows/{wf_id}/stop-test")
async def stop_test_route(wf_id: str):
    """Stop a test: cancel a webhook wait AND an in-progress execution."""
    from ..workflows import webhook_wait
    webhook_wait.disarm(wf_id)
    task = _running_tests.get(wf_id)
    if task and not task.done():
        task.cancel()
    return {"ok": True}


class CodeFormatReq(BaseModel):
    code: str
    language: str = "python"


@router.post("/workflows/format")
async def format_code_route(req: CodeFormatReq):
    """Pretty-print code for the Code node. Python uses the stdlib AST (zero-dep);
    JavaScript uses a lightweight brace-based re-indenter."""
    code = req.code or ""
    lang = (req.language or "python").lower()
    try:
        if lang in ("javascript", "js", "node"):
            return {"code": _format_braces(code), "ok": True}
        import ast
        return {"code": ast.unparse(ast.parse(code)), "ok": True}
    except Exception as e:
        return {"code": code, "ok": False, "error": str(e)[:200]}


def _format_braces(code: str) -> str:
    """Re-indent C-style code by net bracket depth. Good enough for the Code node."""
    out, depth = [], 0
    for raw in code.split("\n"):
        line = raw.strip()
        closers = line[:1] in ("}", ")", "]")
        indent = max(0, depth - (1 if closers else 0))
        out.append(("  " * indent) + line if line else "")
        depth += line.count("{") - line.count("}") + line.count("(") - line.count(")") + line.count("[") - line.count("]")
        depth = max(0, depth)
    return "\n".join(out)


@router.get("/workflows/{wf_id}/runs")
async def list_workflow_runs_route(wf_id: str):
    return {"runs": await database.list_runs(wf_id, limit=30)}


@router.get("/workflows/runs/{run_id}")
async def get_workflow_run_route(run_id: str):
    run = await database.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@router.delete("/workflows/runs/{run_id}")
async def delete_workflow_run_route(run_id: str):
    await database.delete_run(run_id)
    return {"ok": True}


@router.delete("/workflows/{wf_id}/runs")
async def delete_workflow_runs_route(wf_id: str):
    await database.delete_runs(wf_id)
    return {"ok": True}


@router.post("/workflows/{wf_id}/publish")
async def publish_workflow_route(wf_id: str):
    import uuid as _uuid
    from datetime import datetime as _dt
    wf = await database.get_workflow(wf_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    cfg = dict(wf.get("trigger_config") or {})
    ttype = wf.get("trigger_type")
    # Webhook workflows get a stable secret token (used to build the public URL).
    if ttype == "webhook" and not cfg.get("token"):
        cfg["token"] = _uuid.uuid4().hex
    # Schedule workflows start counting from publish time (don't fire instantly).
    if ttype == "schedule" and cfg.get("cron"):
        cfg["next_run_at"] = _dt.utcnow().isoformat()
    wf = await database.update_workflow(wf_id, {"status": "live", "trigger_config": cfg})
    return wf


@router.post("/workflows/{wf_id}/unpublish")
async def unpublish_workflow_route(wf_id: str):
    wf = await database.update_workflow(wf_id, {"status": "draft"})
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return wf


@router.get("/workflows/fs/list")
async def workflow_fs_list(path: str = ""):
    """List a server directory so the editor's file browser can pick a path for the
    Read/Write File nodes (those nodes already accept any server path). Hides dotfiles."""
    import os
    base = os.path.expanduser(path or "~")
    if not os.path.isdir(base):
        base = os.path.dirname(base) or os.path.expanduser("~")
    base = os.path.abspath(base)
    try:
        names = sorted(os.listdir(base), key=str.lower)
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"Cannot list {base}: {e}")
    entries = []
    for n in names:
        if n.startswith("."):
            continue
        full = os.path.join(base, n)
        try:
            is_dir = os.path.isdir(full)
            entries.append({"name": n, "type": "dir" if is_dir else "file",
                            "size": 0 if is_dir else os.path.getsize(full)})
        except OSError:
            continue
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    parent = os.path.dirname(base)
    return {"path": base, "parent": parent if parent != base else None,
            "home": os.path.expanduser("~"), "entries": entries}


@router.post("/hooks/workflow/{wf_id}")
async def workflow_webhook_route(wf_id: str, payload: dict | None = None, token: str = ""):
    """Public webhook trigger. Fires live workflows (guarded by the secret token),
    or — if a test is currently listening — delivers the payload to that test."""
    from ..workflows import run_workflow
    from ..workflows import webhook_wait
    wf = await database.get_workflow(wf_id)
    if not wf or wf.get("trigger_type") != "webhook":
        raise HTTPException(status_code=404, detail="No webhook workflow here")
    expected = (wf.get("trigger_config") or {}).get("token")
    if expected and token != expected:
        raise HTTPException(status_code=403, detail="Invalid webhook token")
    # A test in the editor is listening → hand it the payload instead of running live.
    if webhook_wait.deliver(wf_id, payload or {}):
        return {"ok": True, "captured_for_test": True}
    if wf.get("status") != "live":
        raise HTTPException(status_code=404, detail="Workflow is not live")
    run_id = await run_workflow(wf, payload or {}, mode="live",
                                trigger_source="webhook", orchestrator=orchestrator)
    run = await database.get_run(run_id)
    steps = (run or {}).get("steps", [])

    def _respond_output():
        for step in steps:
            if step.get("node_type") == "respond" and step.get("status") == "success":
                return step.get("output")
        return None

    def _last_output():
        for step in reversed(steps):
            if step.get("status") == "success" and step.get("output") is not None:
                return step.get("output")
        return None

    # response_mode: 'respond' = return the Respond-to-Webhook node's payload (falling
    # back to the last node if there's no respond node); 'auto' (default) = return the
    # workflow's final node output. Fall back to a run summary if there's nothing.
    mode = (wf.get("trigger_config") or {}).get("response_mode") or "auto"
    body = (_respond_output() or _last_output()) if mode == "respond" else _last_output()
    if body is not None:
        return body
    return {"run_id": run_id, "status": (run or {}).get("status")}
