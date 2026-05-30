from __future__ import annotations
from typing import AsyncIterator
import httpx
import json
from .base import BaseLLMAdapter, LLMResponse


class OllamaAdapter(BaseLLMAdapter):
    def __init__(self, base_url: str = "http://localhost:11434", api_key: str = "") -> None:
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def _build_messages(self, system_prompt: str, messages: list[dict]) -> list[dict]:
        return [{"role": "system", "content": system_prompt}] + messages

    async def complete(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> LLMResponse:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{self._base_url}/api/chat",
                headers=self._headers,
                json={
                    "model": model,
                    "messages": self._build_messages(system_prompt, messages),
                    "stream": False,
                    "options": {"temperature": temperature, "num_predict": max_tokens},
                },
            )
            resp.raise_for_status()
            data = resp.json()
            content = data.get("message", {}).get("content", "")
            return LLMResponse(content=content, model=model)

    async def stream(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST",
                f"{self._base_url}/api/chat",
                headers=self._headers,
                json={
                    "model": model,
                    "messages": self._build_messages(system_prompt, messages),
                    "stream": True,
                    "options": {"temperature": temperature, "num_predict": max_tokens},
                },
            ) as resp:
                async for line in resp.aiter_lines():
                    if line:
                        data = json.loads(line)
                        chunk = data.get("message", {}).get("content", "")
                        if chunk:
                            yield chunk
