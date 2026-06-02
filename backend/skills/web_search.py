"""
Web search and fetch skills for agents.
Uses SearXNG (self-hosted) for search and httpx for page fetching.
"""
from __future__ import annotations
import os
import logging
import httpx
from html.parser import HTMLParser

logger = logging.getLogger(__name__)

SEARXNG_URL = os.environ.get("SEARXNG_URL", "http://localhost:8888")


async def web_search(query: str, max_results: int = 5) -> str:
    """Search the web using SearXNG and return results as text."""
    try:
        url = f"{SEARXNG_URL}/search"
        params = {
            "q": query,
            "format": "json",
            "categories": "general",
        }
        headers = {
            "Accept": "application/json",
            "User-Agent": "Takumi-Agent/1.0",
        }
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params=params, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        results = data.get("results", [])[:max_results]
        if not results:
            return f"No search results found for: {query}"

        output = f"Search results for: {query}\n\n"
        for i, r in enumerate(results, 1):
            title = r.get("title", "No title")
            link = r.get("url", "")
            snippet = r.get("content", "No description")
            output += f"{i}. {title}\n   {link}\n   {snippet}\n\n"
        return output.strip()

    except httpx.ConnectError:
        logger.error("SearXNG not reachable at %s — is it running?", SEARXNG_URL)
        return f"Search unavailable: SearXNG is not running at {SEARXNG_URL}. Start it with: docker compose up -d"
    except Exception as e:
        logger.error("Web search failed: %s", e)
        return f"Search failed: {e}"


async def web_fetch(url: str, max_chars: int = 5000) -> str:
    """Fetch a web page and extract its text content."""
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        }
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            text = _extract_text(resp.text)
            if len(text) > max_chars:
                text = text[:max_chars] + "\n\n[Content truncated...]"
            return f"Content from {url}:\n\n{text}"
    except Exception as e:
        logger.error("Web fetch failed for %s: %s", url, e)
        return f"Failed to fetch {url}: {e}"


# ── Simple text extractor ────────────────────────────────────────────────────

class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.text_parts = []
        self._skip = False
        self._skip_tags = {"script", "style", "nav", "header", "footer", "noscript"}

    def handle_starttag(self, tag, attrs):
        if tag in self._skip_tags:
            self._skip = True
        if tag in ("p", "div", "h1", "h2", "h3", "h4", "li", "br", "tr"):
            self.text_parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._skip_tags:
            self._skip = False

    def handle_data(self, data):
        if not self._skip:
            text = data.strip()
            if text:
                self.text_parts.append(text)


def _extract_text(html: str) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(html)
    except Exception:
        pass
    text = " ".join(parser.text_parts)
    import re
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r' {2,}', ' ', text)
    return text.strip()
