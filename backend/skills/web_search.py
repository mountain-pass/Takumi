"""
Web search and fetch skills for agents.

Search tries providers in order and returns the first with results:
  1. browser_search — a real (headless) browser; PRIMARY, since a real engine
                       isn't bot-blocked the way raw-HTTP scrapers are.
  2. Tavily          (if TAVILY_API_KEY is set) — AI-grade results, free tier
  3. Brave           (if BRAVE_API_KEY is set)
  4. Jina (s.jina.ai)— LLM-friendly search (needs JINA_API_KEY — auth now required)
  5. DuckDuckGo      — keyless HTML scraper, last-ditch fallback

This guarantees agents can reach live information out of the box, so they never
silently fall back to stale training data. When every provider fails the result
string begins with "SEARCH_UNAVAILABLE" so callers can react explicitly.
"""
from __future__ import annotations
import os
import re
import html as _html
import logging
import urllib.parse
import httpx
from html.parser import HTMLParser

logger = logging.getLogger(__name__)

TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY", "")
BRAVE_API_KEY = os.environ.get("BRAVE_API_KEY", "")
JINA_API_KEY = os.environ.get("JINA_API_KEY", "")

UNAVAILABLE_PREFIX = "SEARCH_UNAVAILABLE"


def _format_results(query: str, results: list[dict]) -> str:
    out = f"Search results for: {query}\n\n"
    for i, r in enumerate(results, 1):
        out += f"{i}. {r.get('title') or 'No title'}\n   {r.get('url', '')}\n   {r.get('snippet') or ''}\n\n"
    return out.strip()


async def web_search(query: str, max_results: int = 5) -> str:
    """Search the web via the first working provider. Returns results as text."""
    errors: list[str] = []

    for name, fn in (("Browser", _browser), ("Tavily", _tavily), ("Brave", _brave),
                     ("Jina", _jina), ("DuckDuckGo", _duckduckgo)):
        if name == "Tavily" and not TAVILY_API_KEY:
            continue
        if name == "Brave" and not BRAVE_API_KEY:
            continue
        if name == "Jina" and not JINA_API_KEY:
            # s.jina.ai now requires auth (keyless returns 401) — only use it with a key.
            continue
        try:
            results = await fn(query, max_results)
        except httpx.ConnectError as e:
            errors.append(f"{name}: unreachable")
            logger.debug("web_search provider %s unreachable: %s", name, e)
            continue
        except Exception as e:
            errors.append(f"{name}: {e}")
            logger.warning("web_search provider %s failed: %s", name, e)
            continue
        if results:
            logger.info("web_search '%s' → %d results via %s", query[:60], len(results), name)
            return _format_results(query, results)
        errors.append(f"{name}: no results")

    # Everything failed — be LOUD so the agent reports uncertainty instead of
    # answering from outdated memory.
    detail = "; ".join(errors) or "no providers configured"
    logger.error("web_search exhausted all providers for %r (%s)", query, detail)
    return (f"{UNAVAILABLE_PREFIX}: live web search could not be completed for "
            f"'{query}' ({detail}). Do NOT answer time-sensitive questions from memory — "
            "state clearly that you could not retrieve current data.")


# ── Providers ─────────────────────────────────────────────────────────────────

async def _browser(query: str, max_results: int) -> list[dict]:
    """Primary: real headless browser (Playwright). Defined in browser_search.py."""
    from .browser_search import browser_search
    return await browser_search(query, max_results)


async def _tavily(query: str, max_results: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post("https://api.tavily.com/search", json={
            "api_key": TAVILY_API_KEY, "query": query,
            "max_results": max_results, "search_depth": "basic",
        })
        resp.raise_for_status()
        data = resp.json()
    return [{"title": r.get("title"), "url": r.get("url"), "snippet": r.get("content")}
            for r in data.get("results", [])[:max_results]]


async def _brave(query: str, max_results: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get("https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": max_results},
            headers={"Accept": "application/json", "X-Subscription-Token": BRAVE_API_KEY})
        resp.raise_for_status()
        data = resp.json()
    return [{"title": r.get("title"), "url": r.get("url"), "snippet": r.get("description")}
            for r in data.get("web", {}).get("results", [])[:max_results]]


async def _jina(query: str, max_results: int) -> list[dict]:
    """Jina AI search (s.jina.ai) — keyless LLM-friendly results; an API key in
    JINA_API_KEY raises the rate limits but isn't required."""
    headers = {"Accept": "application/json", "X-Respond-With": "no-content",
               "User-Agent": _BROWSER_UA}
    if JINA_API_KEY:
        headers["Authorization"] = f"Bearer {JINA_API_KEY}"
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        resp = await client.get("https://s.jina.ai/", params={"q": query}, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    items = data.get("data") or []
    return [{"title": it.get("title"), "url": it.get("url"),
             "snippet": it.get("description") or (it.get("content") or "")[:200]}
            for it in items[:max_results]]


async def _duckduckgo(query: str, max_results: int) -> list[dict]:
    """Keyless fallback — scrapes the DuckDuckGo HTML endpoint."""
    async with httpx.AsyncClient(timeout=15, follow_redirects=True,
                                 headers={"User-Agent": _BROWSER_UA}) as client:
        resp = await client.post("https://html.duckduckgo.com/html/", data={"q": query})
        resp.raise_for_status()
        page = resp.text
    results: list[dict] = []
    # Each result: <a ... class="result__a" href="<link>">Title</a> followed by a
    # <a class="result__snippet" ...>snippet</a>.
    for m in re.finditer(
        r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>'
        r'(?:.*?<a[^>]*class="result__snippet"[^>]*>(.*?)</a>)?',
        page, re.DOTALL,
    ):
        link = _ddg_unwrap(m.group(1))
        title = _strip_tags(m.group(2))
        snippet = _strip_tags(m.group(3) or "")
        # Skip sponsored/ad links (DDG serves these as y.js redirects) and any
        # internal DuckDuckGo URLs — they aren't real organic results.
        if "duckduckgo.com/y.js" in link or "ad_provider=" in link \
                or link.startswith(("https://duckduckgo.com", "http://duckduckgo.com")):
            continue
        if link and title:
            results.append({"title": title, "url": link, "snippet": snippet})
        if len(results) >= max_results:
            break
    return results


_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def _ddg_unwrap(href: str) -> str:
    """DDG wraps targets as //duckduckgo.com/l/?uddg=<encoded>&..."""
    if "uddg=" in href:
        try:
            q = urllib.parse.urlparse(href if href.startswith("http") else "https:" + href).query
            uddg = urllib.parse.parse_qs(q).get("uddg", [])
            if uddg:
                return urllib.parse.unquote(uddg[0])
        except Exception:
            pass
    if href.startswith("//"):
        return "https:" + href
    return href


def _strip_tags(s: str) -> str:
    return _html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


async def web_fetch(url: str, max_chars: int = 5000) -> str:
    """Fetch a web page and extract its text content."""
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True,
                                     headers={"User-Agent": _BROWSER_UA}) as client:
            resp = await client.get(url)
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
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r' {2,}', ' ', text)
    return text.strip()
