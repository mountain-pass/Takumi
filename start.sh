#!/bin/bash
# Start Takumi — runs backend and frontend concurrently.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Web search needs no external service: it uses a headless browser (Playwright,
# installed below) with Jina/DuckDuckGo HTTP fallbacks. No Docker required.

# Backend
echo "▶ Starting backend..."
cd "$ROOT"
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
# Install/update Python deps every start (idempotent, fast once satisfied) so a
# pre-existing venv still picks up new requirements like Playwright. Use
# `python -m pip` (not the `pip` shim) so a stale pip shebang can't break startup.
.venv/bin/python -m pip install -r backend/requirements.txt -q || \
  echo "   ⚠ Dependency install had issues — continuing with what's installed"

# Playwright browser — required for the agent browser-control skills. The install
# is idempotent: it downloads Chromium (~150 MB) the first time, then no-ops.
echo "▶ Ensuring Playwright browser is installed..."
if .venv/bin/python -m playwright install chromium; then
  echo "   ✓ Playwright Chromium ready"
else
  echo "   ⚠ Playwright browser install failed — browser-control skills will be unavailable"
fi

.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir backend &
BACKEND_PID=$!

# Frontend
echo "▶ Starting frontend..."
cd "$ROOT/frontend"
if [ ! -d "node_modules" ]; then
  npm install -q
fi
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✅ Takumi is running"
echo "   Backend  → http://localhost:8000"
echo "   Frontend → http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
