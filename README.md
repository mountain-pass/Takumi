<p align="center">
  <img src="frontend/public/TAKUMI background.png" alt="Takumi Banner" width="100%" />
</p>

<p align="center">
  <img src="frontend/public/takumi-logo.png" alt="Takumi Logo" width="160" />
</p>

# Takumi — AI Organisation Platform

> **Takumi** (匠) — *artisan* or *craftsman* in Japanese. A Takumi is a master of their craft, combining deep expertise with meticulous attention to detail. This platform embodies that spirit: each AI agent is a specialist, crafted with purpose, working together as a skilled organisation.

Run a full AI organisation on your machine. A **Manager** agent receives your request, delegates to specialist agents, and presents the finished work back to you. Each agent has its own role, system prompt, and LLM — so context stays lean and costs stay low. Agents can use the web, your files, the shell, external tools via MCP, and even specialist image/video models — and the system can patch its own code when a provider breaks.

---

## Highlights

- 🧠 **Manager-led organisation** — one lead agent plans the work and delegates to specialists; you just chat.
- 🔗 **System-level orchestration** — task completion, dependency chains, and **direct agent-to-agent hand-off** are enforced in code (not left to the LLM). The Manager presents only the final deliverable.
- 🛠️ **Tools & skills** — web search/fetch (SearXNG), file read/write/list, shell, and rich-HTML artifact generation.
- 🔌 **MCP servers** — connect agents to Model Context Protocol tool servers (filesystem, GitHub, Xero, …) over **stdio, HTTP, or SSE**, including **OAuth 2.0** (PKCE + dynamic client registration) for hosted servers.
- 🎨 **Multi-model agents** — give an agent a main "brain" plus optional specialist models (**text / vision / image / video**) it invokes as tools. Image/video tasks are **routed in code** to a capable agent.
- 📊 **Rich output** — agents build **HTML dashboards/reports** shown in a resizable viewer pane; generated **images and videos render inline** in chat with expand & download.
- 📎 **Attachments & vision** — drop images and documents into chat; vision-capable models see images, documents are extracted to text for any model.
- ⚙️ **Advanced agent settings** — personality ("soul"), persistent memory, autonomy boundaries (max iterations, token budget), human-in-the-loop flags, MCP grants, and extra models.
- ⏰ **Scheduled jobs & SOPs** — recurring routines and standing procedures.
- 🩹 **Self-healing** — when invoking a new/unknown provider fails with a code-fixable error, the system asks you, and (on approval) the **CTO agent patches the codebase** on a dedicated `self-heal/<id>` git branch.
- 🏢 **Live observability** — an "Office" view shows agents at their desks with real-time status and per-agent token usage; everything updates over WebSocket (with a polling safety net).

---

## Prerequisites

- **Python 3.12+**
- **Node.js 18+**
- **Docker** — required for web search (SearXNG). Make sure Docker Desktop is running before starting Takumi.

---

## Quick start

### Option A — one command (recommended)

```bash
chmod +x start.sh
./start.sh
```

This starts SearXNG (web search), creates the Python venv, installs all dependencies, and launches both servers.

> **Note:** Docker Desktop must be running first. If Docker is not available, Takumi still works but agents won't be able to search the web.

### Option B — manual (run each in a separate terminal)

**Terminal 1 — Backend**

```bash
# Run from the project root

# First run only: create venv and install packages
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt

# Start the server
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir backend
```

**Terminal 2 — Frontend**

```bash
cd frontend

# First run only: install node packages
npm install

# Start the dev server
npm run dev
```

**Terminal 3 — SearXNG (web search engine)**

```bash
docker compose up -d
```

Open **http://localhost:5173** in your browser.

> The backend API runs on **port 8000**. The frontend dev server on **port 5173** proxies all `/api` and `/ws` requests to the backend automatically.

---

## First run — setup wizard

On first launch the app shows a 3-step setup wizard:

1. **Organisation** — give your AI company a name
2. **LLM** — pick a provider, enter credentials, and test the connection
3. **Team** — add specialist agents (use **✨ Enhance with AI** to generate system prompts)

Organisation, agents, API keys, conversations, tasks, and artifacts are all persisted to a local SQLite database (`data/takumi.db`, gitignored). The wizard is skipped on subsequent launches.

---

## How it works

1. You send a message → it goes to the **Manager** agent.
2. The Manager analyses the request and, for anything beyond a quick answer, **delegates** to the right specialist(s). It plans the whole workflow up front, including dependent steps (`depends_on`).
3. When a task finishes, the **orchestrator** (in code) validates it, hands its output **directly to the next agent** in the chain, and runs the dependent task — no chatty round-trips through the Manager.
4. When the plan is complete, the Manager **presents the terminal deliverable** back to you (a summary, an HTML dashboard, an inline image, …).
5. The frontend reflects all state changes in real time via WebSocket, with a polling fallback so nothing goes stale.

Agents communicate **only through tasks** — there is no free-form agent chit-chat — and each task carries a structured context (the objective and the named outputs of its prerequisites).

---

## Capabilities in depth

### Tools & skills
Per-agent, toggle in the agent editor:
- **Web Search / Web Fetch** — research via self-hosted SearXNG, then read the best pages.
- **Read / Write / List Files**, **Run Shell** — local filesystem and command execution.
- **Create Artifact** — produce a complete HTML document (dashboard, report, chart) rendered in the side viewer. (Agents can also just emit a fenced ```html block, which is auto-saved as an artifact.)

### MCP servers (Model Context Protocol)
Add servers under **MCP Servers**. Supports **stdio** (local subprocess), **streamable-HTTP**, and **SSE** transports, with **OAuth 2.0** (browser consent, PKCE, dynamic client registration) for hosted/protected servers. Grant a server to an agent and its tools become callable in that agent's loop.

### Multi-model agents
In an agent's **Advanced** tab, attach specialist models alongside the main one:
- **Text** — route a sub-task to a stronger/cheaper/coding model (`ask_<label>`).
- **Vision** — analyse an image (`see_<label>`).
- **Image** — generate an image (`draw_<label>`), shown inline with expand/download.
- **Video** — generate a video (`film_<label>`), shown inline.

The Manager's roster surfaces each agent's special capabilities, and image/video tasks are **rerouted in code** to an agent that actually has that model.

### Rich output & artifacts
HTML dashboards/reports open in a **resizable viewer pane**; generated images and videos render **inline in the chat** with **Expand** (full-screen) and **Download**.

### Chat
Image and document **attachments** (vision for images, text extraction for PDFs/DOCX/etc.), **temporary chats** that persist nothing, conversation **history** in the sidebar, and local-time timestamps with date dividers.

### Advanced agent settings
Personality ("soul", stored in the agent's `soul.md` and read back each run), persistent **memory**, **autonomy boundaries** (max tool-call iterations, hard token budget), human-in-the-loop flags, MCP grants, and additional models.

### Scheduled jobs & SOPs
Create recurring routines and standing operating procedures with cron-like schedules (`@daily`, `@hourly`, intervals like `4h`). The dashboard shows status, schedules, and per-job agent/token usage.

### Self-healing
If invoking an LLM/provider fails in a **code-fixable** way (a new/unknown provider or format mismatch — not auth or transient errors), Takumi proposes a fix in chat. On your approval, the **CTO agent** reads and patches the backend source and the change is committed to a dedicated **`self-heal/<incident>` git branch** (only the files it touched), applied live via `--reload`, and rollback-able.

---

## Environment variables

Copy `.env.example` to `.env` and fill in the keys you need:

```bash
cp .env.example .env
```

| Variable            | Provider         | Notes                                      |
|---------------------|------------------|--------------------------------------------|
| `ANTHROPIC_API_KEY` | Anthropic        | `sk-ant-...`                               |
| `OPENAI_API_KEY`    | OpenAI           | `sk-...`                                   |
| `GOOGLE_API_KEY`    | Google Gemini    | `AIza...`                                  |
| `GLM_API_KEY`       | Zhipu GLM        |                                            |
| `MINIMAX_API_KEY`   | MiniMax          | Also set `MINIMAX_GROUP_ID`                |
| `OLLAMA_BASE_URL`   | Ollama / Cloud   | Default `http://localhost:11434`           |
| `OLLAMA_API_KEY`    | Ollama Cloud     | Bearer key from ollama.com/settings/keys   |
| `OAUTH_REDIRECT_BASE` | MCP OAuth      | Base URL for the OAuth callback (default `http://localhost:8000`) |

Keys can also be entered through the setup wizard or **Settings → API** — no `.env` file required. API providers (including custom OpenAI-compatible gateways) are managed in-app.

---

## Supported LLM providers

| Provider        | Notes                                                          |
|-----------------|----------------------------------------------------------------|
| Anthropic       | Claude Haiku, Sonnet, Opus                                     |
| OpenAI          | GPT-4o, GPT-4o-mini, GPT-5, o-series, …                        |
| Ollama          | Local models (llama3, mistral, gemma, …)                       |
| Ollama Cloud    | Hosted models via ollama.com — requires API key                |
| Google Gemini   | gemini-2.0-flash, gemini-1.5-pro/flash                         |
| GLM (Zhipu)     | glm-4-flash, glm-4, …                                          |
| MiniMax         | abab6.5s-chat                                                  |
| OpenRouter      | Any model routed through openrouter.ai                         |
| Custom / Gateway | Any OpenAI-compatible endpoint — LMStudio, vLLM, NVIDIA NIM, Agnes, etc. Connectivity is validated via the provider's `/models` list. |

---

## Project structure

```
takumi/
├── docker-compose.yml            # SearXNG search engine
├── searxng/                      # SearXNG config (settings.yml, limiter.toml)
├── backend/                      # Python / FastAPI
│   ├── main.py                   # FastAPI app + WebSocket lifespan
│   ├── orchestrator.py           # Engine: agent lifecycle + system-level task graph
│   ├── task_scheduler.py         # Recurring task scheduler
│   ├── database.py               # SQLite persistence (agents, tasks, artifacts, …)
│   ├── runtime_settings.py       # Mutable org/LLM config
│   ├── config.py                 # Env-var settings (pydantic-settings)
│   ├── models.py                 # Pydantic data models
│   ├── message_bus.py            # Async inter-agent message routing
│   ├── attachments.py            # Image/document handling + vision helpers
│   ├── mcp_manager.py            # MCP server connections & tool discovery
│   ├── mcp_oauth.py              # OAuth 2.0 for MCP HTTP/SSE servers
│   ├── self_heal.py              # CTO self-heal flow (incidents + git branch)
│   ├── agent_folders.py          # Per-agent soul.md / memory.md / skills.md
│   ├── agents/
│   │   ├── base_agent.py         # Base class: tool loop, artifacts, self-heal hook
│   │   ├── ceo_agent.py          # Manager — delegation, capability routing, presenting
│   │   └── model_tools.py        # Secondary models (text/vision/image/video) as tools
│   ├── skills/                   # Built-in agent tools
│   │   ├── registry.py           # Skill registry + tools-prompt builder
│   │   ├── web_search.py         # web_search & web_fetch via SearXNG
│   │   ├── files.py              # read_file / write_file / list_files
│   │   └── shell.py              # run_shell
│   ├── llm_adapters/             # One adapter per provider (+ factory, content converters)
│   └── api/
│       └── routes.py             # REST endpoints (/api/...)
└── frontend/                     # React / Vite / Tailwind
    └── src/
        ├── App.jsx               # Layout, sidebar nav, chat history
        ├── stores/orgStore.js    # Zustand state (WebSocket + REST)
        └── components/
            ├── SetupWizard.jsx
            ├── ChatView.jsx          # Chat, attachments, inline media, artifact pane
            ├── CronJobView.jsx       # Scheduled jobs & SOPs
            ├── SkillMarketplaceView.jsx  # MCP server manager
            ├── WorkflowView.jsx
            ├── OfficeView.jsx        # Live agent desks + token stats
            ├── APISettingsView.jsx   # API providers
            ├── ChannelView.jsx
            ├── OrganisationView.jsx  # Agent canvas, roles, Advanced settings
            └── AgentModal.jsx
```

---

## Tech stack

- **Backend** — Python, FastAPI, WebSockets, SQLite (aiosqlite), the `mcp` SDK, httpx.
- **Frontend** — React, Vite, Tailwind, Zustand, TanStack Query.
- **Search** — self-hosted SearXNG (Docker).
