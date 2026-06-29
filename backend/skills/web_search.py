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


_QUOTE_HINT = re.compile(r"\b(stock|share|shares|ticker|nasdaq|nyse|quote)\b|\$[A-Za-z]{1,5}\b"
                         r"|\bstock price\b|\bshare price\b", re.I)
_QUOTE_STOP = re.compile(r"\b(what|is|the|of|a|current|latest|today|todays|now|price|stock|share|"
                         r"shares|quote|value|much|how|for|me|get|tell)\b", re.I)
_SYMBOL_CACHE: dict[str, str] = {}   # name terms → ticker; Yahoo search rate-limits, so cache hits


async def _finance_quote(query: str) -> str:
    """Exact, real-time-ish equity quote from a keyless finance feed — the
    high-confidence path for 'X stock price' questions that search snippets get wrong
    (snippets quote stale headlines; the live number is JS-rendered and unscrapable).
    Returns "" for non-equity queries or any failure, so it's a bonus signal only."""
    if not _QUOTE_HINT.search(query):
        return ""
    try:
        # Yahoo's finance endpoints 429 the full desktop-Chrome UA (commonly spoofed by
        # bots) but accept a plain Mozilla/5.0 token.
        headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
        async with httpx.AsyncClient(timeout=10, follow_redirects=True, headers=headers) as client:
            # Resolve a company name / loose query to a ticker (explicit $SYM wins).
            m = re.search(r"\$([A-Za-z]{1,5})\b", query)
            if m:
                symbol = m.group(1).upper()
            else:
                terms = _QUOTE_STOP.sub(" ", query)
                terms = re.sub(r"[^\w\s.&-]", " ", terms).strip() or query
                key = terms.lower()
                symbol = _SYMBOL_CACHE.get(key)
                # query2 first — query1's search endpoint rate-limits (429) more readily.
                for host in ("query2.finance.yahoo.com", "query1.finance.yahoo.com"):
                    if symbol:
                        break
                    try:
                        r = await client.get(f"https://{host}/v1/finance/search",
                                             params={"q": terms, "quotesCount": 1, "newsCount": 0})
                        r.raise_for_status()
                        quotes = r.json().get("quotes") or []
                        if quotes and quotes[0].get("symbol"):
                            symbol = quotes[0]["symbol"]
                            _SYMBOL_CACHE[key] = symbol
                    except Exception:
                        continue
                if not symbol:
                    return ""
            q = await client.get(f"https://query2.finance.yahoo.com/v8/finance/chart/{symbol}",
                                 params={"interval": "1d", "range": "1d"})
            q.raise_for_status()
            meta = q.json()["chart"]["result"][0]["meta"]
    except Exception as e:
        logger.debug("finance quote failed for %r: %s", query, e)
        return ""
    price = meta.get("regularMarketPrice")
    if price is None:
        return ""
    cur = meta.get("currency") or ""
    prev = meta.get("chartPreviousClose")
    name = meta.get("longName") or meta.get("shortName") or meta.get("symbol")
    chg = ""
    if isinstance(price, (int, float)) and isinstance(prev, (int, float)) and prev:
        d = price - prev
        chg = f", {d:+.2f} ({d / prev * 100:+.2f}%) vs prev close {prev}"
    ts = meta.get("regularMarketTime")
    when = ""
    if ts:
        from datetime import datetime, timezone
        when = " as of " + datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return f"{name} ({meta.get('symbol')}): {price} {cur}{chg}{when} [source: Yahoo Finance]"


async def _ddg_instant_answer(query: str) -> str:
    """DuckDuckGo Instant Answer API — keyless, returns a STRUCTURED direct answer
    (definition/abstract/computed answer) when one exists. Far higher confidence than
    an article snippet, but empty for many queries (e.g. live stock quotes), so it's a
    bonus signal, not a provider."""
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True,
                                     headers={"User-Agent": _BROWSER_UA}) as client:
            resp = await client.get("https://api.duckduckgo.com/", params={
                "q": query, "format": "json", "no_html": "1", "skip_disambig": "1"})
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.debug("instant-answer failed for %r: %s", query, e)
        return ""
    return (data.get("Answer") or data.get("AbstractText") or data.get("Definition") or "").strip()


async def web_search(query: str, max_results: int = 5) -> str:
    """Search the web via the first working provider. Returns results as text."""
    errors: list[str] = []
    # Exact equity quote first (highest confidence), then DDG's structured answer.
    answer = await _finance_quote(query) or await _ddg_instant_answer(query)
    prefix = f"Direct answer: {answer}\n\n" if answer else ""

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
            return prefix + _format_results(query, results)
        errors.append(f"{name}: no results")

    if answer:   # providers all dry but we still have a structured direct answer
        return prefix.rstrip()

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
