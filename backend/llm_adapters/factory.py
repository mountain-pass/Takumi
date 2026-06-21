from __future__ import annotations
import logging
from ..models import LLMProvider
from .base import BaseLLMAdapter

logger = logging.getLogger(__name__)


def get_adapter(provider: LLMProvider, settings, runtime: dict | None = None) -> BaseLLMAdapter:
    """Return the right adapter for a given provider.

    Priority: runtime dict (from api_providers table or request body) > env vars.
    """
    rt = runtime or {}

    def _key(rt_key: str, env_val: str) -> str:
        return rt.get(rt_key) or env_val or ""

    def _url(rt_key: str, env_val: str, fallback: str) -> str:
        return rt.get(rt_key) or env_val or fallback

    if provider == LLMProvider.ANTHROPIC:
        from .anthropic_adapter import AnthropicAdapter
        return AnthropicAdapter(api_key=_key("llm_api_key", settings.anthropic_api_key))

    elif provider == LLMProvider.OPENAI:
        from .openai_adapter import OpenAIAdapter
        return OpenAIAdapter(api_key=_key("llm_api_key", settings.openai_api_key))

    elif provider == LLMProvider.OLLAMA:
        from .ollama_adapter import OllamaAdapter
        base_url = _url("llm_base_url", settings.ollama_base_url, "http://localhost:11434")
        api_key = _key("llm_api_key", settings.ollama_api_key)
        return OllamaAdapter(base_url=base_url, api_key=api_key)

    elif provider == LLMProvider.GEMINI:
        from .gemini_adapter import GeminiAdapter
        return GeminiAdapter(api_key=_key("llm_api_key", settings.google_api_key))

    elif provider == LLMProvider.GLM:
        from .glm_adapter import GLMAdapter
        return GLMAdapter(api_key=_key("llm_api_key", settings.glm_api_key))

    elif provider == LLMProvider.MINIMAX:
        from .minimax_adapter import MiniMaxAdapter
        return MiniMaxAdapter(api_key=_key("llm_api_key", settings.minimax_api_key), group_id=settings.minimax_group_id)

    elif provider == LLMProvider.OPENROUTER:
        from .custom_adapter import CustomAdapter
        base_url = _url("llm_base_url", "", "https://openrouter.ai/api/v1")
        api_key = _key("llm_api_key", "")
        return CustomAdapter(base_url=base_url, api_key=api_key)

    elif provider == LLMProvider.CUSTOM:
        from .custom_adapter import CustomAdapter
        base_url = rt.get("llm_base_url", "")
        api_key = rt.get("llm_api_key", "none")
        if not base_url:
            raise ValueError("Custom provider requires a base URL")
        return CustomAdapter(base_url=base_url, api_key=api_key)

    raise ValueError(f"Unknown LLM provider: {provider}")


def get_adapter_for_provider(provider_id: str, settings) -> BaseLLMAdapter:
    """Build an adapter from a saved api_providers record (its provider type,
    key and base_url). Used by workflow LLM nodes that override which provider
    runs the task."""
    import sqlite3
    db_path = settings.data_dir + "/takumi.db"
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT provider, api_key, base_url FROM api_providers WHERE id = ?", (provider_id,)
    ).fetchone()
    conn.close()
    if not row:
        raise ValueError(f"api_provider '{provider_id}' not found")
    rt = {"llm_api_key": row["api_key"], "llm_base_url": row["base_url"]}
    return get_adapter(LLMProvider(row["provider"]), settings, rt)


def get_adapter_for_agent(config, settings) -> BaseLLMAdapter:
    """Create an LLM adapter using the agent's linked api_provider record.

    Looks up the agent's api_provider_id in the DB to get the correct
    base_url, api_key, and provider — so each agent uses its own credentials.
    Falls back to global settings if no provider is linked.
    """
    import sqlite3

    provider_id = config.api_provider_id
    rt = {}

    if provider_id:
        try:
            db_path = settings.data_dir + "/takumi.db"
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT provider, api_key, base_url FROM api_providers WHERE id = ?",
                (provider_id,)
            ).fetchone()
            conn.close()

            if row:
                rt["llm_api_key"] = row["api_key"]
                rt["llm_base_url"] = row["base_url"]
                logger.info(
                    "[%s] Using api_provider '%s': provider=%s, base_url=%s",
                    config.name, provider_id[:8], row["provider"], row["base_url"]
                )
            else:
                logger.warning(
                    "[%s] api_provider_id '%s' not found in DB, using global settings",
                    config.name, provider_id[:8]
                )
        except Exception as e:
            logger.error("[%s] Failed to load api_provider: %s", config.name, e)

    return get_adapter(config.llm_provider, settings, rt)
