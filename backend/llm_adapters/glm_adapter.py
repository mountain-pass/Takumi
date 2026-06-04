"""
GLM (Zhipu AI) adapter — uses OpenAI-compatible API.
Models: glm-4, glm-4-flash, glm-4-air, etc.
"""
from __future__ import annotations
from typing import AsyncIterator
from openai import AsyncOpenAI
from .base import BaseLLMAdapter, LLMResponse
from ._content import to_openai


class GLMAdapter(BaseLLMAdapter):
    BASE_URL = "https://open.bigmodel.cn/api/paas/v4/"

    def __init__(self, api_key: str) -> None:
        self._client = AsyncOpenAI(api_key=api_key, base_url=self.BASE_URL)

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
