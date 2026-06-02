"""
REST API routes for agent & task management.
"""
from __future__ import annotations
import logging
from fastapi import APIRouter, HTTPException
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
        raise HTTPException(400, "Cannot remove the CEO agent")
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
        adapter = get_adapter(provider, get_settings(), rt)
        model = req.llm_model or _default_model(req.llm_provider)
        resp = await adapter.complete(
            system_prompt="You are a helpful assistant.",
            messages=[{"role": "user", "content": "Reply with only the word: ready"}],
            model=model,
            max_tokens=10,
        )
        return {"ok": True, "response": resp.content.strip()}
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
        "custom": "default",
    }
    return defaults.get(provider, "default")


# ── AI prompt enhancement ─────────────────────────────────────────────────────

class PromptEnhanceRequest(BaseModel):
    agent_name: str
    agent_role: str
    agent_description: str = ""
    current_prompt: str = ""


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
        raise HTTPException(400, "No CEO agent available")

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
            message_for_llm, image_parts=llm_image_parts
        )
    except Exception as e:
        logger.error(f"CEO LLM call failed: {e}", exc_info=True)
        raise HTTPException(502, f"CEO LLM call failed: {e}")

    assistant_msg_id = str(uuid.uuid4())
    await database.save_message({
        "id": assistant_msg_id,
        "conversation_id": req.conversation_id,
        "from_agent_id": ceo.config.id,
        "to_agent_id": "user",
        "content": response_content,
        "role": "assistant",
        "metadata": {"actions": executed_actions} if executed_actions else {},
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
        adapter = get_adapter(provider, get_settings(), rt)
        model = _default_model(rec["provider"])
        resp = await adapter.complete(
            system_prompt="You are a helpful assistant.",
            messages=[{"role": "user", "content": "Reply with only the word: ready"}],
            model=model,
            max_tokens=10,
        )
        return {"ok": True, "response": resp.content.strip()}
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
