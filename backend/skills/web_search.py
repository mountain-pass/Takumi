"""
Web search and fetch skills for agents.
Uses DuckDuckGo (no API key required) and httpx for page fetching.
"""
from __future__ import annotations
import logging
import httpx
from html.parser import HTMLParser

logger = logging.getLogger(__name__)


async def web_search(query: str, max_results: int = 5) -> str:
    """Search the web using DuckDuckGo and return results as text."""
    try:
        url = "https://html.duckduckgo.com/html/"
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        }
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            resp = await client.post(url, data={"q": query}, headers=headers)
            resp.raise_for_status()
            results = _parse_ddg_html(resp.text, max_results)
            if not results:
                return f"No search results found for: {query}"
            output = f"Search results for: {query}\n\n"
            for i, r in enumerate(results, 1):
                output += f"{i}. {r['title']}\n   {r['url']}\n   {r['snippet']}\n\n"
            return output.strip()
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


# ── DuckDuckGo HTML parser ───────────────────────────────────────────────────

class _DDGParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.results = []
        self._current = {}
        self._capture = None
        self._in_result = False

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        cls = attrs_dict.get("class", "")

        if tag == "a" and "result__a" in cls:
            self._in_result = True
            self._current = {"title": "", "url": attrs_dict.get("href", ""), "snippet": ""}
            self._capture = "title"
        elif tag == "a" and "result__snippet" in cls:
            self._capture = "snippet"
        elif tag == "td" and "result-sponsored" in cls:
            self._in_result = False  # skip ads

    def handle_endtag(self, tag):
        if tag == "a" and self._capture in ("title", "snippet"):
            self._capture = None
        if tag == "tr" and self._in_result and self._current.get("title"):
            # Clean up URL
            url = self._current.get("url", "")
            if "uddg=" in url:
                import urllib.parse
                parsed = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                url = parsed.get("uddg", [url])[0]
            self._current["url"] = url
            self.results.append(self._current)
            self._current = {}
            self._in_result = False

    def handle_data(self, data):
        if self._capture == "title":
            self._current["title"] = self._current.get("title", "") + data.strip()
        elif self._capture == "snippet":
            self._current["snippet"] = self._current.get("snippet", "") + data.strip()


def _parse_ddg_html(html: str, max_results: int) -> list[dict]:
    parser = _DDGParser()
    try:
        parser.feed(html)
    except Exception:
        pass
    return parser.results[:max_results]


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
    # Collapse whitespace
    import re
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r' {2,}', ' ', text)
    return text.strip()
