from __future__ import annotations
from ..models import LLMProvider
from .base import BaseLLMAdapter


def get_adapter(provider: LLMProvider, settings, runtime: dict | None = None) -> BaseLLMAdapter:
    """Return the right adapter for a given provider.

    Priority: runtime dict (request body / wizard values) > env vars.
    This ensures the test-connection endpoint always tests the credentials
    the user actually typed, not whatever is cached in the environment.
    """
    rt = runtime or {}

    def _key(rt_key: str, env_val: str) -> str:
        """Runtime value wins over env var."""
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
