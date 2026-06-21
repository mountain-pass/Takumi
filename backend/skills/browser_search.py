"""
Real-browser web search via Chromium (Playwright).

This is the PRIMARY search path. The major engines (Google/Bing/DDG-main) serve
CAPTCHA/bot-challenge pages even to a real browser, so we target engines that
render results for automated browsers without challenges:

  • Mojeek            — independent index, scraping-friendly, clean direct links
  • DuckDuckGo Lite   — lightweight HTML results, no challenge

A real browser engine renders/executes the page like a human visitor, so it gets
results where raw-HTTP scrapers get 202/429. Runs headless (nothing pops up) and
reuses one browser process. Falls back to the API/HTTP providers in web_search.py
if the browser engine is unavailable or returns nothing.
"""
from __future__ import annotations
import asyncio
import logging
import urllib.parse

logger = logging.getLogger(__name__)

_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

_ENGINE_URLS = {
    "mojeek": "https://www.mojeek.com/search?q=",
    "ddglite": "https://lite.duckduckgo.com/lite/?q=",
}
_RESULT_SELECTOR = {
    "mojeek": "ul.results-standard li",
    "ddglite": "a.result-link",
}
_EXTRACT_JS = {
    "mojeek": """() => {
        const out = [];
        document.querySelectorAll('ul.results-standard > li').forEach(li => {
            const a = li.querySelector('a.title');
            if (!a || !a.href) return;
            const sn = li.querySelector('p.s, p');
            out.push({title: a.innerText.trim(), url: a.href, snippet: sn ? sn.innerText.trim() : ''});
        });
        return out;
    }""",
    "ddglite": """() => {
        const out = [];
        const snips = document.querySelectorAll('td.result-snippet');
        let i = 0;
        document.querySelectorAll('a.result-link').forEach(a => {
            if (!a.href) return;
            const sn = snips[i] ? snips[i].innerText.trim() : '';
            i++;
            out.push({title: a.innerText.trim(), url: a.href, snippet: sn});
        });
        return out;
    }""",
}

_STEALTH = """Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});"""


def _unwrap_ddg(href: str) -> str:
    """DDG-lite wraps targets as //duckduckgo.com/l/?uddg=<encoded>."""
    if "uddg=" in href:
        try:
            q = urllib.parse.urlparse(href if href.startswith("http") else "https:" + href).query
            uddg = urllib.parse.parse_qs(q).get("uddg", [])
            if uddg:
                return urllib.parse.unquote(uddg[0])
        except Exception:
            pass
    return href


class _SearchBrowser:
    """Lazily-launched, reused headless browser for search. Prefers real Chrome
    (less bot-detected); falls back to the bundled Chromium."""

    def __init__(self) -> None:
        self._pw = None
        self._browser = None
        self._launch_lock = asyncio.Lock()

    async def _ensure_browser(self):
        if self._browser and self._browser.is_connected():
            return self._browser
        async with self._launch_lock:
            if self._browser and self._browser.is_connected():
                return self._browser
            from playwright.async_api import async_playwright
            if self._pw is None:
                self._pw = await async_playwright().start()
            args = ["--no-sandbox", "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled"]
            try:
                self._browser = await self._pw.chromium.launch(channel="chrome", headless=True, args=args)
            except Exception:
                self._browser = await self._pw.chromium.launch(headless=True, args=args)
            logger.info("[browser_search] headless browser ready")
            return self._browser

    async def search(self, query: str, max_results: int, engine: str) -> list[dict]:
        browser = await self._ensure_browser()
        ctx = await browser.new_context(user_agent=_UA, locale="en-US",
                                        extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
                                        viewport={"width": 1280, "height": 900})
        await ctx.add_init_script(_STEALTH)
        try:
            page = await ctx.new_page()
            url = _ENGINE_URLS[engine] + urllib.parse.quote(query)
            await page.goto(url, wait_until="domcontentloaded", timeout=20000)
            try:
                await page.wait_for_selector(_RESULT_SELECTOR[engine], timeout=8000)
            except Exception:
                await page.wait_for_timeout(800)
            try:
                results = await page.evaluate(_EXTRACT_JS[engine])
            except Exception:
                await page.wait_for_timeout(800)
                results = await page.evaluate(_EXTRACT_JS[engine])
            cleaned = []
            for r in (results or []):
                url_ = _unwrap_ddg(r.get("url") or "")
                title = r.get("title") or ""
                if url_ and title and not url_.startswith(("https://duckduckgo.com", "http://duckduckgo.com")):
                    cleaned.append({"title": title, "url": url_, "snippet": r.get("snippet") or ""})
            return cleaned[:max_results]
        finally:
            await ctx.close()

    async def close(self) -> None:
        try:
            if self._browser:
                await self._browser.close()
            if self._pw:
                await self._pw.stop()
        except Exception:
            pass
        self._browser = self._pw = None


_searcher = _SearchBrowser()


async def browser_search(query: str, max_results: int = 5, timeout: float = 30.0) -> list[dict]:
    """Search via a real (headless) browser. Tries Mojeek, then DuckDuckGo Lite.
    Bounded by `timeout`. Raises on hard failure (e.g. Playwright missing) so
    web_search can fall through to its HTTP/API providers."""
    last_exc = None
    for engine in ("mojeek", "ddglite"):
        try:
            results = await asyncio.wait_for(_searcher.search(query, max_results, engine), timeout=timeout)
            if results:
                logger.info("[browser_search] '%s' → %d results via %s", query[:60], len(results), engine)
                return results
        except Exception as e:
            last_exc = e
            logger.debug("[browser_search] %s failed for %r: %s", engine, query[:60], e)
    if last_exc:
        raise last_exc
    return []
