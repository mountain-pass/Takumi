# Takumi — AI Organisation Platform

Run a full AI organisation on your PC. Each agent has a specific role, its own system prompt, and its own LLM — keeping context lean and costs low.

## Quick start

```bash
# 1. Copy and fill in your API keys
cp .env.example .env

# 2. Launch everything
chmod +x start.sh
./start.sh
```

Open **http://localhost:5173** in your browser.

## Structure

```
takumi/
├── backend/                 # Python / FastAPI
│   ├── main.py              # FastAPI app + WebSocket
│   ├── orchestrator.py      # 24/7 engine, agent lifecycle
│   ├── agents/
│   │   ├── base_agent.py    # All specialist agents extend this
│   │   └── ceo_agent.py     # CEO — delegates tasks to specialists
│   ├── llm_adapters/        # Anthropic · OpenAI · Ollama · Gemini · GLM · MiniMax
│   ├── message_bus.py       # Async inter-agent message routing
│   ├── models.py            # Pydantic data models
│   └── persistence.py       # JSON persistence (data/)
└── frontend/                # React / Vite / Tailwind
    └── src/
        ├── App.jsx
        ├── stores/orgStore.js   # Zustand state (WebSocket + REST)
        └── components/
            ├── OfficeView.jsx       # Marvis-style agent desks
            ├── AgentDesk.jsx        # Single agent card + avatar
            ├── MessageFeed.jsx      # Live inter-agent conversation
            ├── TaskPanel.jsx        # Submit tasks + status list
            ├── AgentDetailPanel.jsx # Slide-in agent inspector
            └── AgentModal.jsx       # Add agent form
```

## Adding an agent

Click **+** in the left nav, fill in:
- **Name** — e.g. "Data Analyst"
- **Role** — one-line job title
- **System Prompt** — what this agent specialises in and how it should behave
- **LLM Provider + Model** — pick the cheapest model that can do the job
- **Max context messages** — keep this low for simple agents to save tokens

## How it works

1. You submit a task → goes to the **CEO** agent
2. CEO analyses it and delegates sub-tasks to specialist agents via the **Message Bus**
3. Specialist agents work independently with their own bounded context
4. Results flow back to the CEO who synthesises a final answer
5. The frontend receives all state changes in real-time via WebSocket

## Supported LLM providers

| Provider   | Key env var         | Example models                          |
|------------|---------------------|-----------------------------------------|
| Anthropic  | `ANTHROPIC_API_KEY` | claude-haiku-4-5, claude-sonnet-4-6     |
| OpenAI     | `OPENAI_API_KEY`    | gpt-4o-mini, gpt-4o                     |
| Ollama     | *(no key)*          | llama3, mistral, phi3                   |
| Gemini     | `GOOGLE_API_KEY`    | gemini-1.5-flash, gemini-1.5-pro        |
| GLM        | `GLM_API_KEY`       | glm-4-flash, glm-4                      |
| MiniMax    | `MINIMAX_API_KEY`   | abab6.5s-chat                           |
