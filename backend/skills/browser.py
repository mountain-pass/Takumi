"""
Browser-control skills — let an agent drive a real desktop Chrome window.
Thin async wrappers over the shared BrowserManager.
"""
from __future__ import annotations

from ..browser_manager import browser_manager
from ..config import get_settings


async def browser_navigate(url: str) -> str:
    return await browser_manager.navigate(url)


async def browser_read() -> str:
    return await browser_manager.read()


async def browser_click(target: str) -> str:
    return await browser_manager.click(target)


async def browser_type(text: str, target: str = "", submit: bool = False) -> str:
    # tolerate string "true"/"false" coming from the LLM
    if isinstance(submit, str):
        submit = submit.strip().lower() in ("true", "1", "yes")
    return await browser_manager.type_text(text, target, submit)


async def browser_back() -> str:
    return await browser_manager.back()


async def browser_screenshot() -> str:
    return await browser_manager.screenshot(get_settings().data_dir)
