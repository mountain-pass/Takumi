from __future__ import annotations
from typing import AsyncIterator
import anthropic
from .base import BaseLLMAdapter, LLMResponse


class AnthropicAdapter(BaseLLMAdapter):
    def __init__(self, api_key: str) -> None:
        self._client = anthropic.AsyncAnthropic(api_key=api_key)

    async def complete(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> LLMResponse:
        resp = await self._client.messages.create(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system_prompt,
            messages=messages,
        )
        return LLMResponse(
            content=resp.content[0].text,
            input_tokens=resp.usage.input_tokens,
            output_tokens=resp.usage.output_tokens,
            model=model,
        )

    async def stream(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> AsyncIterator[str]:
        async with self._client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system_prompt,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text
