"""
Takumi backend — FastAPI entrypoint with WebSocket real-time broadcast.
"""
from __future__ import annotations
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .orchestrator import orchestrator
from .api.routes import router
from . import runtime_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ── WebSocket connection manager ──────────────────────────────────────────────

class ConnectionManager:
    def __init__(self) -> None:
        self.active: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.active.discard(ws)

    async def broadcast(self, message: str) -> None:
        dead: list[WebSocket] = []
        for ws in list(self.active):
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active.discard(ws)


manager = ConnectionManager()


# ── App lifecycle ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    runtime_settings.init(settings.data_dir, env_settings=settings)
    orchestrator.set_ws_broadcast(manager.broadcast)
    await orchestrator.start()
    logger.info(f"Takumi backend running on {settings.host}:{settings.port}")
    yield
    await orchestrator.stop()


# ── App ───────────────────────────────────────────────────────────────────────

settings = get_settings()

app = FastAPI(
    title="Takumi AI Organisation",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        import json
        states = orchestrator.get_agent_states()
        await ws.send_text(json.dumps({
            "type": "init",
            "payload": {
                "agents": states,
                "tasks": [t.model_dump(mode="json") for t in orchestrator.get_tasks()],
                "messages": [],
            }
        }))
        while True:
            # Accept any frame (text, binary, or ping) to keep the connection alive
            await ws.receive()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning(f"WebSocket error: {exc}")
    finally:
        manager.disconnect(ws)


@app.get("/health")
async def health():
    return {"status": "ok", "agents": len(orchestrator.get_agents())}
