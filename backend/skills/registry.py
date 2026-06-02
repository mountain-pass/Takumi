"""
Skill registry — maps skill names to callables and their descriptions.
Agents reference skills by name; the runtime resolves and calls them.
"""
from __future__ import annotations
from typing import Callable, Any

from .web_search import web_search, web_fetch


# Each skill: { name, description, parameters (for the LLM prompt), callable }
SKILL_REGISTRY: dict[str, dict[str, Any]] = {
    "web_search": {
        "name": "web_search",
        "description": "Search the web for information. Returns top results with titles, URLs, and snippets.",
        "parameters": {"query": "The search query string", "max_results": "(optional) Max results, default 5"},
        "callable": web_search,
    },
    "web_fetch": {
        "name": "web_fetch",
        "description": "Fetch and read the text content of a web page given its URL.",
        "parameters": {"url": "The full URL to fetch", "max_chars": "(optional) Max characters to return, default 5000"},
        "callable": web_fetch,
    },
}


def get_skill(name: str) -> dict | None:
    return SKILL_REGISTRY.get(name)


def get_skills_for_agent(skill_names: list[str]) -> list[dict]:
    """Get skill definitions for skills an agent has access to."""
    return [SKILL_REGISTRY[n] for n in skill_names if n in SKILL_REGISTRY]


def build_tools_prompt(skill_names: list[str]) -> str:
    """Build the tools section for an agent's system prompt."""
    skills = get_skills_for_agent(skill_names)
    if not skills:
        return ""
    lines = ["\n\n## Available Tools"]
    lines.append("")
    lines.append("You can use tools ONE AT A TIME. To call a tool, output ONLY this JSON block:")
    lines.append("")
    lines.append("```json")
    lines.append('{"tool_call": {"name": "<tool_name>", "arguments": {<args>}}}')
    lines.append("```")
    lines.append("")
    lines.append("### How tools work (IMPORTANT — read carefully):")
    lines.append("1. You output ONE tool call in a ```json block.")
    lines.append("2. The system executes it and gives you the result in the next message.")
    lines.append("3. You can then call ANOTHER tool or write your final answer.")
    lines.append("4. You get up to 5 tool calls per task.")
    lines.append("5. When you have enough information, write your final answer as plain text (NO json block).")
    lines.append("")
    lines.append("### Rules:")
    lines.append("- ONE tool call per response. Never put multiple tool calls in one message.")
    lines.append("- Never say 'waiting for results' — results come automatically after each call.")
    lines.append("- After receiving tool results, either call another tool OR write your final answer.")
    lines.append("- Your final answer must be plain text with NO ```json block.")
    lines.append("")
    lines.append("### Available tools:")
    lines.append("")
    for s in skills:
        params = ", ".join(f'"{k}": {v}' for k, v in s["parameters"].items())
        lines.append(f'- **{s["name"]}**: {s["description"]}')
        lines.append(f'  Parameters: {{{params}}}')
    lines.append("")
    lines.append("CRITICAL: Your training data is outdated. For ANY factual information (dates, prices, valuations, news, company info, market data), you MUST use web_search first. NEVER answer from memory when tools are available.")
    return "\n".join(lines)
