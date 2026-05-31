"""
REST API routes for agent & task management.
"""
from __future__ import annotations
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..orchestrator import orchestrator
from ..models import AgentConfig, LLMProvider
from .. import runtime_settings
from .. import database

router = APIRouter(prefix="/api")


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
            "You are an expert at writing system prompts for AI agents. "
            "Write a clear, specific, and effective system prompt for the agent described below. "
            "The prompt should define the agent's personality, expertise, responsibilities, and how it should behave. "
            "Return ONLY the system prompt text, nothing else."
        )
        user_msg = (
            f"Agent name: {req.agent_name}\n"
            f"Role: {req.agent_role}\n"
            f"Description: {req.agent_description}\n"
            + (f"Current prompt (improve this): {req.current_prompt}" if req.current_prompt else "")
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
    return await database.get_messages(conversation_id=conv_id, limit=limit)


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
