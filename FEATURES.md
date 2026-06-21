# Takumi — Feature Roadmap

## Core (Built)

- 24/7 orchestration engine with CEO + specialist agents
- Multi-provider LLM support (Anthropic, OpenAI, Gemini, Ollama, GLM, MiniMax, Custom)
- Per-agent model assignment — each agent can run a different LLM
- Agent-to-agent message bus with real-time delegation
- Live frontend: animated org view, agent desks, chat, WebSocket state sync
- Setup wizard: org name → LLM config → team builder with AI-enhanced prompts
- Scheduled tasks (cron jobs)
- Web search skill via headless browser (Jina/DuckDuckGo fallbacks)
- Skill marketplace
- Workflow view
- Channel integrations (Telegram, WhatsApp, etc.)

---

## Onboarding: Agent Hiring Interview ✨

> *Suggested by Tom Howard — 2026-06-02*

**The idea:** When a user adds a new agent to their organisation, instead of asking them to pick a provider or model (which most users don't understand or care about), the **CEO agent runs a live "job interview"**.

### How it works

1. User defines the role — name, responsibilities, what success looks like
2. CEO sends a **role-specific test prompt** to each available model/provider in parallel
3. Each model "pitches itself" — responding as if applying for the job
4. CEO evaluates each response on:
   - Quality / suitability for the role
   - Response latency
   - Cost per task (estimated from token usage × pricing)
5. CEO presents a **ranked shortlist** to the user with a recommendation
6. User can accept the pick or override

### Why this matters

- Users care about **outcome** and **cost** — not about "Claude Haiku vs GPT-4o-mini"
- Some roles (CEO, Strategist) justify premium models; others (Formatter, Summariser) should be as cheap as possible
- Makes model selection **delightful and automatic** — a key product differentiator
- Cost-awareness is baked in from the start, preventing runaway spend

### Frontend vision

- Animated "interview room" — each model candidate walks in, gives their pitch
- CEO agent is shown deliberating (thinking animation)
- Final verdict card: winner shown with score breakdown (quality, speed, cost)
- User can accept or pick a different candidate

### Backend requirements

- Parallel LLM calls across all configured providers for a given role prompt
- Token counting + cost estimation per provider (price table in config)
- CEO scoring logic (structured output: quality 0–10, latency, cost estimate)
- Interview session stored — can be re-run when new providers are added or pricing changes

---

## Backlog / Ideas

- Agent performance tracking over time (quality drift detection)
- Re-interview trigger when a model's pricing changes significantly
- "Trial period" — run new agent in shadow mode before fully hiring
- Cost budget per agent per month with auto-downgrade if exceeded
