from __future__ import annotations
from typing import AsyncIterator
from openai import AsyncOpenAI
from .base import BaseLLMAdapter, LLMResponse
from ._content import to_openai


class CustomAdapter(BaseLLMAdapter):
    """OpenAI-compatible adapter for local or self-hosted LLM endpoints."""

    def __init__(self, base_url: str, api_key: str = "none") -> None:
        self._client = AsyncOpenAI(api_key=api_key or "none", base_url=base_url)

    def _build_messages(self, system_prompt: str, messages: list[dict]) -> list[dict]:
        conv = [{"role": m["role"], "content": to_openai(m["content"])} for m in messages]
        return [{"role": "system", "content": system_prompt}] + conv

    async def complete(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> LLMResponse:
        resp = await self._client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=self._build_messages(system_prompt, messages),
        )
        return LLMResponse(
            content=resp.choices[0].message.content or "",
            input_tokens=resp.usage.prompt_tokens if resp.usage else 0,
            output_tokens=resp.usage.completion_tokens if resp.usage else 0,
            model=model,
        )

    async def stream(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> AsyncIterator[str]:
        stream = await self._client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=self._build_messages(system_prompt, messages),
            stream=True,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
