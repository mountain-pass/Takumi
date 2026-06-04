from __future__ import annotations
from typing import AsyncIterator
import google.generativeai as genai
from .base import BaseLLMAdapter, LLMResponse
from ._content import to_gemini


class GeminiAdapter(BaseLLMAdapter):
    def __init__(self, api_key: str) -> None:
        genai.configure(api_key=api_key)

    def _get_model(self, model: str, system_prompt: str):
        return genai.GenerativeModel(
            model_name=model,
            system_instruction=system_prompt,
        )

    def _to_gemini_messages(self, messages: list[dict]) -> list[dict]:
        role_map = {"user": "user", "assistant": "model"}
        return [{"role": role_map.get(m["role"], "user"), "parts": to_gemini(m["content"])} for m in messages]

    async def complete(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> LLMResponse:
        m = self._get_model(model, system_prompt)
        config = genai.types.GenerationConfig(max_output_tokens=max_tokens, temperature=temperature)
        resp = await m.generate_content_async(
            self._to_gemini_messages(messages), generation_config=config
        )
        return LLMResponse(content=resp.text, model=model)

    async def stream(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> AsyncIterator[str]:
        m = self._get_model(model, system_prompt)
        config = genai.types.GenerationConfig(max_output_tokens=max_tokens, temperature=temperature)
        async for chunk in await m.generate_content_async(
            self._to_gemini_messages(messages), generation_config=config, stream=True
        ):
            if chunk.text:
                yield chunk.text
