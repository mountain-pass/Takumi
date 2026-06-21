"""
Desktop browser control for agents — drives a REAL, visible Chrome window via
Playwright so agents can navigate sites like a human (keeping logins/cookies and
avoiding much of the friction headless browsers hit).

By default it launches your installed Google Chrome (channel="chrome") headed,
with a persistent profile under data/browser-profile so logins stick across runs.
Set BROWSER_CDP_URL to attach to an already-running Chrome started with
--remote-debugging-port instead (uses that browser's real profile).

One shared session/page is used; operations are serialised with a lock.
"""
from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger(__name__)

MAX_TEXT = 6000  # chars of page text returned to the agent


class BrowserManager:
    def __init__(self) -> None:
        self._pw = None
        self._ctx = None        # BrowserContext (persistent) or browser.contexts[0]
        self._browser = None    # only set when attaching over CDP
        self._page = None
        self._lock = asyncio.Lock()
        self._profile_dir = None

    def configure(self, data_dir: str) -> None:
        self._profile_dir = os.path.join(data_dir, "browser-profile")

    async def _ensure(self):
        if self._page and not self._page.is_closed():
            return self._page
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise RuntimeError(
                "Browser control needs Playwright. Install it: `.venv/bin/python -m pip install playwright`")

        if self._pw is None:
            self._pw = await async_playwright().start()

        cdp = os.environ.get("BROWSER_CDP_URL", "").strip()
        if cdp:
            # Attach to a Chrome already running with --remote-debugging-port.
            self._browser = await self._pw.chromium.connect_over_cdp(cdp)
            self._ctx = self._browser.contexts[0] if self._browser.contexts else await self._browser.new_context()
        else:
            # Launch real installed Chrome, headed, with a persistent profile.
            if not self._profile_dir:
                from .config import get_settings
                self._profile_dir = os.path.join(get_settings().data_dir, "browser-profile")
            os.makedirs(self._profile_dir, exist_ok=True)
            launch_args = dict(
                user_data_dir=self._profile_dir,
                headless=False,
                viewport={"width": 1366, "height": 900},
                args=["--no-first-run", "--no-default-browser-check"],
            )
            try:
                # Prefer the user's real Google Chrome (best site compatibility).
                self._ctx = await self._pw.chromium.launch_persistent_context(
                    channel="chrome", **launch_args)
            except Exception as e:
                # No system Chrome — fall back to Playwright's bundled Chromium
                # (provisioned by `playwright install chromium` at startup).
                logger.warning("[browser] system Chrome unavailable (%s) — using bundled Chromium", e)
                self._ctx = await self._pw.chromium.launch_persistent_context(**launch_args)
        self._page = self._ctx.pages[0] if self._ctx.pages else await self._ctx.new_page()
        logger.info("[browser] Chrome session ready (%s)", "CDP" if cdp else "persistent profile")
        return self._page

    async def ensure_installed(self) -> None:
        """Best-effort provisioning so browser skills are ready out of the box.
        Verifies the Playwright package and a Chromium build are present, and
        downloads Chromium if missing. Runs in the background at startup; never
        raises and short-circuits quickly once everything is in place."""
        import sys
        notified = False  # only tell the user when we actually install something

        # 1) Python package present?
        try:
            from playwright.async_api import async_playwright  # noqa: F401
        except ImportError:
            logger.info("[browser] Playwright not installed — installing package…")
            await self._notify_setup("info", "Setting up browser automation",
                                     "Installing the Playwright package so agents can browse the web…")
            notified = True
            if not await self._run([sys.executable, "-m", "pip", "install", "playwright"]):
                logger.warning("[browser] Playwright package install failed — browser skills unavailable")
                await self._notify_setup("alert", "Browser automation setup failed",
                                         "Couldn't install Playwright — browser-control skills are unavailable.")
                return

        # 2) Chromium build present? (executable_path is known even when not downloaded)
        try:
            from playwright.async_api import async_playwright
            pw = await async_playwright().start()
            try:
                path = pw.chromium.executable_path
            finally:
                await pw.stop()
            if path and os.path.exists(path):
                if notified:
                    await self._notify_setup("success", "Browser automation ready",
                                             "Agents can now navigate websites.")
                return  # already provisioned — fast path on every restart
        except Exception:
            pass

        logger.info("[browser] Downloading Chromium for Playwright (first run, ~150 MB)…")
        await self._notify_setup("info", "Setting up browser automation",
                                 "Downloading the browser engine (~150 MB) — this one-time step runs "
                                 "in the background; agents can browse once it finishes.")
        if await self._run([sys.executable, "-m", "playwright", "install", "chromium"]):
            logger.info("[browser] Playwright Chromium ready")
            await self._notify_setup("success", "Browser automation ready",
                                     "Setup complete — agents can now navigate websites.")
        else:
            logger.warning("[browser] Chromium download failed — browser skills may be unavailable")
            await self._notify_setup("alert", "Browser automation setup failed",
                                     "Couldn't download the browser engine — browser-control skills are unavailable.")

    @staticmethod
    async def _notify_setup(type: str, title: str, body: str) -> None:
        """Surface provisioning progress in the notification center. Best-effort."""
        try:
            from . import notifications
            await notifications.push(type=type, title=title, body=body,
                                     dedupe_key="setup:playwright")
        except Exception:
            pass

    @staticmethod
    async def _run(cmd: list[str]) -> bool:
        """Run a provisioning subprocess; return True on exit code 0."""
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            _, err = await proc.communicate()
            if proc.returncode != 0:
                logger.warning("[browser] `%s` failed: %s", " ".join(cmd[-3:]),
                               (err or b"").decode(errors="replace")[:300])
            return proc.returncode == 0
        except Exception as e:
            logger.warning("[browser] provisioning command errored: %s", e)
            return False

    async def stop(self) -> None:
        try:
            if self._ctx:
                await self._ctx.close()
            if self._browser:
                await self._browser.close()
            if self._pw:
                await self._pw.stop()
        except Exception:
            pass
        self._pw = self._ctx = self._browser = self._page = None

    # ── Actions ───────────────────────────────────────────────────────────────

    async def navigate(self, url: str) -> str:
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
        async with self._lock:
            page = await self._ensure()
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
            await self._settle(page)
            return await self._describe(page, header=f"Navigated to {url}")

    async def read(self) -> str:
        async with self._lock:
            page = await self._ensure()
            return await self._describe(page, header="Current page")

    async def click(self, target: str) -> str:
        async with self._lock:
            page = await self._ensure()
            looks_like_selector = any(c in target for c in (".", "#", "[", ">", "="))
            try:
                # Prefer matching a link/button by its visible text.
                loc = page.get_by_role("link", name=target, exact=False).or_(
                    page.get_by_role("button", name=target, exact=False)).first
                if await loc.count() == 0:
                    loc = page.get_by_text(target, exact=False).first
                if await loc.count() == 0 and looks_like_selector:
                    loc = page.locator(target).first  # treat as a CSS selector
                if await loc.count() == 0:
                    # Don't hang — tell the agent what IS clickable.
                    return await self._describe(
                        page, header=f"Couldn't find anything matching '{target}' to click.")
                await loc.click(timeout=10000)
            except Exception as e:
                return f"Could not click '{target}': {e}"
            await self._settle(page)
            return await self._describe(page, header=f"Clicked '{target}'")

    async def type_text(self, text: str, target: str = "", submit: bool = False) -> str:
        async with self._lock:
            page = await self._ensure()
            try:
                if target:
                    loc = page.get_by_label(target, exact=False).first
                    if await loc.count() == 0:
                        loc = page.get_by_placeholder(target, exact=False).first
                    if await loc.count() == 0:
                        loc = page.locator(target).first
                    await loc.fill(text, timeout=10000)
                    if submit:
                        await loc.press("Enter")
                else:
                    await page.keyboard.type(text)
                    if submit:
                        await page.keyboard.press("Enter")
            except Exception as e:
                return f"Could not type into '{target or 'focused field'}': {e}"
            await self._settle(page)
            return await self._describe(page, header=f"Typed text{' and submitted' if submit else ''}")

    async def back(self) -> str:
        async with self._lock:
            page = await self._ensure()
            await page.go_back(wait_until="domcontentloaded")
            await self._settle(page)
            return await self._describe(page, header="Went back")

    async def screenshot(self, data_dir: str) -> str:
        async with self._lock:
            page = await self._ensure()
            import time
            shots = os.path.join(data_dir, "browser-shots")
            os.makedirs(shots, exist_ok=True)
            path = os.path.join(shots, f"shot-{int(time.time())}.png")
            await page.screenshot(path=path, full_page=False)
            return f"Screenshot saved to {path} (current page: {page.url})"

    # ── Helpers ───────────────────────────────────────────────────────────────

    async def _settle(self, page) -> None:
        try:
            await page.wait_for_load_state("networkidle", timeout=4000)
        except Exception:
            pass

    async def _describe(self, page, header: str) -> str:
        title = await page.title()
        url = page.url
        try:
            text = await page.inner_text("body")
        except Exception:
            text = ""
        text = " ".join(text.split())
        # A few interactable affordances so the agent knows what it can click.
        links = []
        try:
            for el in await page.get_by_role("link").all():
                name = (await el.inner_text()).strip().replace("\n", " ")
                if name and len(name) < 60:
                    links.append(name)
                if len(links) >= 25:
                    break
        except Exception:
            pass
        out = [f"{header}", f"Title: {title}", f"URL: {url}", "", text[:MAX_TEXT]]
        if links:
            out += ["", "Clickable links on the page: " + " | ".join(dict.fromkeys(links))]
        return "\n".join(out)


browser_manager = BrowserManager()
