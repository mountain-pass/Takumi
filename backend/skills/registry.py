"""
Skill registry — maps skill names to callables and their descriptions.
Agents reference skills by name; the runtime resolves and calls them.
"""
from __future__ import annotations
from typing import Callable, Any

from .web_search import web_search, web_fetch
from .files import read_file, write_file, list_files
from .shell import run_shell
from .browser import (
    browser_navigate, browser_read, browser_click, browser_type,
    browser_back, browser_screenshot,
)
from .risk import assess_risk, scan_secrets, review_outbound, risk_register


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
    "read_file": {
        "name": "read_file",
        "description": "Read the contents of a text file on the local filesystem.",
        "parameters": {"path": "Absolute or relative file path", "max_chars": "(optional) Max characters to return"},
        "callable": read_file,
    },
    "write_file": {
        "name": "write_file",
        "description": "Write text to a file (creates parent folders). Use to save output or create files.",
        "parameters": {"path": "Destination file path", "content": "Text to write", "mode": "(optional) 'overwrite' (default) or 'append'"},
        "callable": write_file,
    },
    "list_files": {
        "name": "list_files",
        "description": "List the files and folders in a directory.",
        "parameters": {"path": "(optional) Directory path, default current directory"},
        "callable": list_files,
    },
    "run_shell": {
        "name": "run_shell",
        "description": "Run a shell command and return its stdout/stderr and exit code. Use for builds, scripts, git, file ops, etc.",
        "parameters": {"command": "The shell command to run", "timeout": "(optional) Seconds before timeout, default 60", "cwd": "(optional) Working directory"},
        "callable": run_shell,
    },
    "create_artifact": {
        "name": "create_artifact",
        "description": (
            "Produce a rich, self-contained HTML document (dashboard, report, chart, table) that the user "
            "views in a side panel. Use this for visual or content-rich deliverables instead of plain text. "
            "The HTML must be a complete standalone document (inline CSS; you may use inline <script> and CDN "
            "libraries like Chart.js). After calling it, tell the user you've created it and they can open it."
        ),
        "parameters": {"title": "Short title for the artifact", "html": "A complete standalone HTML document"},
        "callable": None,  # execution is intercepted by the agent (needs conversation/task context)
    },
    # ── Browser control (drives a real, visible desktop Chrome window) ─────────
    "browser_navigate": {
        "name": "browser_navigate",
        "description": "Open a URL in the controlled desktop Chrome browser and return the page's title, URL, visible text, and clickable links. Use this to browse real sites like a human (keeps your logins/cookies).",
        "parameters": {"url": "The URL to open"},
        "callable": browser_navigate,
    },
    "browser_read": {
        "name": "browser_read",
        "description": "Re-read the CURRENT browser page — returns its title, URL, visible text, and clickable links. Use after the page changes.",
        "parameters": {},
        "callable": browser_read,
    },
    "browser_click": {
        "name": "browser_click",
        "description": "Click something on the current page by its visible link/button text (or a CSS selector). Returns the resulting page.",
        "parameters": {"target": "Visible text of the link/button to click, or a CSS selector"},
        "callable": browser_click,
    },
    "browser_type": {
        "name": "browser_type",
        "description": "Type text into a field on the current page (e.g. a search or login box). Optionally submit with Enter.",
        "parameters": {"text": "Text to type", "target": "(optional) field label, placeholder, or CSS selector; omit to type into the focused field", "submit": "(optional) true to press Enter after typing"},
        "callable": browser_type,
    },
    "browser_back": {
        "name": "browser_back",
        "description": "Go back to the previous page in the browser.",
        "parameters": {},
        "callable": browser_back,
    },
    "browser_screenshot": {
        "name": "browser_screenshot",
        "description": "Save a screenshot of the current browser page to disk (useful as proof or for a vision step). Returns the file path.",
        "parameters": {},
        "callable": browser_screenshot,
    },
    # ── Risk & Compliance (ISO 31000 risk scoring) ────────────────────────────
    "assess_risk": {
        "name": "assess_risk",
        "description": "Score a piece of work against ISO 31000. Provide a 'categories' object mapping each relevant risk category (security, data_privacy, financial, legal_compliance, reputational, operational) to {likelihood: 1-5, consequence: 1-5, note}. Returns the overall risk level, score, and a proceed/block verdict against the org threshold, and logs it to the risk register.",
        "parameters": {"subject": "What is being assessed", "categories": "Object of category → {likelihood, consequence, note}", "content": "(optional) the actual text/output to also scan for secrets"},
        "callable": assess_risk,
    },
    "scan_secrets": {
        "name": "scan_secrets",
        "description": "Detect leaked secrets, API keys, credentials, or PII in a block of text (secret-leak gate).",
        "parameters": {"text": "The text to scan"},
        "callable": scan_secrets,
    },
    "review_outbound": {
        "name": "review_outbound",
        "description": "Review an outbound communication (email/message/post) before it is sent — scans for secrets/PII and returns a compliance checklist.",
        "parameters": {"message": "The outbound message text", "recipient": "(optional) who it's going to"},
        "callable": review_outbound,
    },
    "risk_register": {
        "name": "risk_register",
        "description": "List recent entries from the organisation's risk register.",
        "parameters": {"limit": "(optional) how many entries, default 15"},
        "callable": risk_register,
    },
}

# The single "Browser" toggle in the UI maps to this set of tool names.
BROWSER_TOOLS = ["browser_navigate", "browser_read", "browser_click",
                 "browser_type", "browser_back", "browser_screenshot"]

# The single "Risk & Compliance" toggle maps to this set.
RISK_TOOLS = ["assess_risk", "scan_secrets", "review_outbound", "risk_register"]


def get_skill(name: str) -> dict | None:
    return SKILL_REGISTRY.get(name)


def mcp_server_ids(skill_names: list[str]) -> list[str]:
    """Extract MCP server ids an agent has been granted (tokens 'mcp:<id>')."""
    return [n.split(":", 1)[1] for n in skill_names if n.startswith("mcp:") and ":" in n]


def build_mcp_tools_prompt(skill_names: list[str]) -> str:
    """Build the tools section for any MCP servers granted to this agent."""
    from ..mcp_manager import mcp_manager
    server_ids = mcp_server_ids(skill_names)
    if not server_ids:
        return ""
    lines: list[str] = []
    for sid in server_ids:
        status = mcp_manager.status_for(sid)
        tools = status.get("tools", [])
        if not tools:
            continue
        name = status.get("slug", sid)
        lines.append(f"\n#### MCP server: {name} ({status.get('status', '')})")
        for t in tools:
            lines.append(f'- **{t["full_name"]}**: {t["description"]}')
    if not lines:
        return ""
    return "\n".join(["\n### MCP tools (call exactly like other tools, by full name):", *lines])


def get_skills_for_agent(skill_names: list[str]) -> list[dict]:
    """Get skill definitions for skills an agent has access to."""
    return [SKILL_REGISTRY[n] for n in skill_names if n in SKILL_REGISTRY]


def build_tools_prompt(skill_names: list[str]) -> str:
    """Build the tools section for an agent's system prompt."""
    skills = get_skills_for_agent(skill_names)
    mcp_section = build_mcp_tools_prompt(skill_names)
    if not skills and not mcp_section:
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
    lines.append("4. You get up to 8 tool calls per task.")
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
    has_artifact = False
    for s in skills:
        # create_artifact is NOT a JSON tool call — large HTML doesn't survive
        # JSON escaping. It's handled via a fenced ```html block instead (below).
        if s["name"] == "create_artifact":
            has_artifact = True
            continue
        params = ", ".join(f'"{k}": {v}' for k, v in s["parameters"].items())
        lines.append(f'- **{s["name"]}**: {s["description"]}')
        lines.append(f'  Parameters: {{{params}}}')
    if mcp_section:
        lines.append(mcp_section)
    if has_artifact:
        lines.append("")
        lines.append("### Producing a rich HTML deliverable (dashboard / report / chart):")
        lines.append("- Do NOT use a JSON tool call for this. Instead, write your FINAL answer with the "
                     "complete standalone HTML document inside a single fenced ```html code block.")
        lines.append("- It is saved automatically as a viewable artifact (the user gets a 'View' button).")
        lines.append("- Inline CSS; you may use inline <script> and CDN libraries (e.g. Chart.js). Add a "
                     "one-line note like \"I've prepared the dashboard.\" before or after the block.")
    lines.append("")
    lines.append("### Search best practices:")
    lines.append("- Your training data is OUTDATED. For ANY factual information (dates, prices, valuations, news, company info, market data), you MUST use web_search first. NEVER answer from memory.")
    lines.append("- Write specific, targeted queries. Bad: 'SpaceX'. Good: 'SpaceX IPO 2025 valuation filing date'.")
    lines.append("- If search results have useful URLs but not enough detail, use web_fetch to read the full page.")
    lines.append("- A good research workflow: web_search to find sources → web_fetch on the best 1-2 URLs → synthesize findings.")
    lines.append("- If the first search returns poor results, try rephrasing with different keywords.")
    return "\n".join(lines)
