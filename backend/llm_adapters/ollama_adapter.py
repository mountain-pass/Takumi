from __future__ import annotations
from typing import AsyncIterator
import httpx
import json
from .base import BaseLLMAdapter, LLMResponse


def _is_cloud(base_url: str) -> bool:
    return "ollama.com" in base_url


class OllamaAdapter(BaseLLMAdapter):
    def __init__(self, base_url: str = "http://localhost:11434", api_key: str = "") -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._cloud = _is_cloud(self._base_url)

        if self._cloud:
            self._chat_url = "https://ollama.com/v1/chat/completions"
            self._headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        else:
            self._chat_url = f"{self._base_url}/api/chat"
            self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def _build_messages(self, system_prompt: str, messages: list[dict]) -> list[dict]:
        return [{"role": "system", "content": system_prompt}] + messages

    async def complete(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> LLMResponse:
        msgs = self._build_messages(system_prompt, messages)

        if self._cloud:
            body = {
                "model": model,
                "messages": msgs,
                "max_tokens": max_tokens,
                "temperature": temperature,
            }
        else:
            body = {
                "model": model,
                "messages": msgs,
                "stream": False,
                "options": {"temperature": temperature, "num_predict": max_tokens},
            }

        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            resp = await client.post(self._chat_url, headers=self._headers, json=body)
            if resp.status_code >= 400:
                try:
                    err = resp.json()
                    msg = err.get("error", {}).get("message", "") if isinstance(err.get("error"), dict) else err.get("error", "") or resp.text
                except Exception:
                    msg = resp.text
                raise ValueError(msg or f"HTTP {resp.status_code}")
            data = resp.json()

            if self._cloud:
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            else:
                content = data.get("message", {}).get("content", "")

            return LLMResponse(content=content, model=model)

    async def stream(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> AsyncIterator[str]:
        msgs = self._build_messages(system_prompt, messages)

        if self._cloud:
            body = {"model": model, "messages": msgs, "max_tokens": max_tokens, "temperature": temperature, "stream": True}
        else:
            body = {"model": model, "messages": msgs, "stream": True, "options": {"temperature": temperature, "num_predict": max_tokens}}

        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            async with client.stream("POST", self._chat_url, headers=self._headers, json=body) as resp:
                async for line in resp.aiter_lines():
                    if not line or line.strip() == "data: [DONE]":
                        continue
                    text = line.removeprefix("data: ").strip() if self._cloud else line
                    if not text:
                        continue
                    data = json.loads(text)
                    if self._cloud:
                        chunk = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    else:
                        chunk = data.get("message", {}).get("content", "")
                    if chunk:
                        yield chunk
