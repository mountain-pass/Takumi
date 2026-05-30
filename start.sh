#!/bin/bash
# Start Takumi — runs backend and frontend concurrently.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Backend
echo "▶ Starting backend..."
cd "$ROOT"
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r backend/requirements.txt -q
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
