"""
OAuth 2.0 support for MCP HTTP/SSE servers.

Wraps the MCP SDK's OAuthClientProvider with:
- a SQLite-backed TokenStorage (tokens + dynamically-registered client info),
- a redirect/callback handler pair that drives an interactive browser consent
  through Takumi's own callback endpoint.

The flow: the SDK calls our ``redirect_handler(url)`` with the provider's
authorization URL; we surface that URL to the UI and return immediately. The user
opens it, authorizes, and the provider redirects their browser to
``/api/mcp/oauth/callback`` — which resolves the future our ``callback_handler``
is awaiting, letting the SDK exchange the code for tokens.
"""
from __future__ import annotations

import asyncio
import logging
import os
from urllib.parse import urlparse, parse_qs

from mcp.client.auth import OAuthClientProvider, TokenStorage
from mcp.shared.auth import OAuthToken, OAuthClientInformationFull, OAuthClientMetadata

from . import database

logger = logging.getLogger(__name__)


def redirect_base() -> str:
    """Public base URL the OAuth provider should redirect back to."""
    return os.environ.get("OAUTH_REDIRECT_BASE", "http://localhost:8000").rstrip("/")


def callback_url() -> str:
    return f"{redirect_base()}/api/mcp/oauth/callback"


# state -> Future[(code, state)] awaiting the browser callback.
_pending: dict[str, asyncio.Future] = {}


def resolve_callback(state: str, code: str) -> bool:
    """Called by the callback route. Returns True if a flow was waiting on `state`."""
    fut = _pending.pop(state, None)
    if fut and not fut.done():
        fut.set_result((code, state))
        return True
    return False


def cancel_pending_for(predicate) -> None:
    for state in list(_pending):
        if predicate(state):
            fut = _pending.pop(state, None)
            if fut and not fut.done():
                fut.cancel()


class DBTokenStorage(TokenStorage):
    """Persist OAuth tokens + client registration per MCP server in SQLite."""

    def __init__(self, server_id: str) -> None:
        self.server_id = server_id

    async def get_tokens(self) -> OAuthToken | None:
        row = await database.get_mcp_oauth(self.server_id)
        if row["tokens"]:
            try:
                return OAuthToken.model_validate_json(row["tokens"])
            except Exception:
                return None
        return None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        await database.set_mcp_oauth(self.server_id, tokens=tokens.model_dump_json())

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        row = await database.get_mcp_oauth(self.server_id)
        if row["client_info"]:
            try:
                return OAuthClientInformationFull.model_validate_json(row["client_info"])
            except Exception:
                return None
        return None

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        await database.set_mcp_oauth(self.server_id, client_info=client_info.model_dump_json())


def build_oauth_provider(conn) -> OAuthClientProvider:
    """Build an OAuthClientProvider for a server connection (`conn` is _ServerConn)."""
    metadata = OAuthClientMetadata(
        client_name="Takumi",
        redirect_uris=[callback_url()],
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
        token_endpoint_auth_method="client_secret_post",
        scope=conn.config.get("oauth_scope") or None,
    )

    async def redirect_handler(authorization_url: str) -> None:
        # Capture the CSRF state so the callback route can find this flow.
        try:
            qs = parse_qs(urlparse(authorization_url).query)
            state = (qs.get("state") or [""])[0]
        except Exception:
            state = ""
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        if state:
            _pending[state] = fut
        conn._auth_state = state
        conn._auth_future = fut
        conn.authorize_url = authorization_url
        conn.status = "awaiting_auth"
        conn.error = ""
        conn._ready.set()   # unblock the API call that triggered the connect
        logger.info("[mcp:%s] awaiting OAuth authorization", conn.slug)

    async def callback_handler() -> tuple[str, str | None]:
        fut = getattr(conn, "_auth_future", None)
        if fut is None:
            raise RuntimeError("No pending OAuth callback")
        code, state = await fut
        return code, state

    return OAuthClientProvider(
        server_url=conn.config.get("url", ""),
        client_metadata=metadata,
        storage=DBTokenStorage(conn.id),
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
    )
