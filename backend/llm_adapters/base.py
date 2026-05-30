"""
Base interface all LLM adapters must implement.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator


@dataclass
class LLMResponse:
    content: str
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""


class BaseLLMAdapter(ABC):
    """Unified async interface for any LLM provider."""

    @abstractmethod
    async def complete(
        self,
        system_prompt: str,
        messages: list[dict],   # [{role, content}]
        model: str,
        max_tokens: int = 2048,
        temperature: float = 0.7,
    ) -> LLMResponse:
        """Single-shot completion."""
        ...

    @abstractmethod
    async def stream(
        self,
        system_prompt: str,
        messages: list[dict],
        model: str,
        max_tokens: int = 2048,
        temperature: float = 0.7,
    ) -> AsyncIterator[str]:
        """Streaming completion — yields text chunks."""
        ...
