"""
MiniMax adapter — uses their chat completions API.
Models: abab6.5s-chat, abab5.5-chat, etc.
"""
from __future__ import annotations
from typing import AsyncIterator
import httpx
import json
from .base import BaseLLMAdapter, LLMResponse


class MiniMaxAdapter(BaseLLMAdapter):
    BASE_URL = "https://api.minimax.chat/v1"

    def __init__(self, api_key: str, group_id: str) -> None:
        self._api_key = api_key
        self._group_id = group_id

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

    def _build_payload(self, system_prompt: str, messages: list[dict], model: str, max_tokens: int, temperature: float) -> dict:
        mm_messages = [{"sender_type": "SYSTEM", "sender_name": "System", "text": system_prompt}]
        for m in messages:
            mm_messages.append({
                "sender_type": "USER" if m["role"] == "user" else "BOT",
                "sender_name": "User" if m["role"] == "user" else "Assistant",
                "text": m["content"],
            })
        return {
            "model": model,
            "tokens_to_generate": max_tokens,
            "temperature": temperature,
            "messages": mm_messages,
        }

    async def complete(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> LLMResponse:
        url = f"{self.BASE_URL}/text/chatcompletion_v2?GroupId={self._group_id}"
        payload = self._build_payload(system_prompt, messages, model, max_tokens, temperature)
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, headers=self._headers(), json=payload)
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["messages"][0]["text"]
            return LLMResponse(content=content, model=model)

    async def stream(self, system_prompt, messages, model, max_tokens=2048, temperature=0.7) -> AsyncIterator[str]:
        url = f"{self.BASE_URL}/text/chatcompletion_v2?GroupId={self._group_id}"
        payload = {**self._build_payload(system_prompt, messages, model, max_tokens, temperature), "stream": True}
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream("POST", url, headers=self._headers(), json=payload) as resp:
                async for line in resp.aiter_lines():
                    if line.startswith("data:"):
                        raw = line[5:].strip()
                        if raw and raw != "[DONE]":
                            data = json.loads(raw)
                            delta = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
                            if delta:
                                yield delta
