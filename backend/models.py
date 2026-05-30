"""
Core data models for Takumi AI Organisation Platform
"""
from __future__ import annotations
from enum import Enum
from typing import Any, Optional
from datetime import datetime
from uuid import uuid4
from pydantic import BaseModel, Field


class AgentStatus(str, Enum):
    IDLE = "idle"
    THINKING = "thinking"
    WORKING = "working"
    WAITING = "waiting"
    OFFLINE = "offline"


class LLMProvider(str, Enum):
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    OLLAMA = "ollama"
    GEMINI = "gemini"
    GLM = "glm"
    MINIMAX = "minimax"
    CUSTOM = "custom"


class MessageRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"


class AgentMessage(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    from_agent: str          # agent id or "user"
    to_agent: str            # agent id or "broadcast"
    content: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    task_id: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentConfig(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    role: str                # e.g. "Data Analyst", "Browser Agent"
    description: str
    system_prompt: str
    llm_provider: LLMProvider = LLMProvider.ANTHROPIC
    llm_model: str = "claude-haiku-4-5-20251001"
    skills: list[str] = Field(default_factory=list)   # skill names
    is_ceo: bool = False
    avatar_color: str = "#4F46E5"   # for UI
    max_context_messages: int = 20  # keeps context lean


class AgentState(BaseModel):
    config: AgentConfig
    status: AgentStatus = AgentStatus.IDLE
    current_task: Optional[str] = None
    current_action: Optional[str] = None
    token_count: int = 0
    messages_processed: int = 0
    last_heartbeat: datetime = Field(default_factory=datetime.utcnow)


class Task(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    title: str
    description: str
    created_by: str = "user"
    assigned_to: Optional[str] = None   # agent id
    status: str = "pending"             # pending|in_progress|reviewing|completed|failed
    result: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    metadata: dict[str, Any] = Field(default_factory=dict)


class OrganisationConfig(BaseModel):
    name: str = "My AI Organisation"
    description: str = ""
    agents: list[AgentConfig] = Field(default_factory=list)


# ── WebSocket event types broadcast to frontend ──────────────────────────────

class WSEventType(str, Enum):
    AGENT_STATUS = "agent_status"
    AGENT_MESSAGE = "agent_message"
    TASK_UPDATE = "task_update"
    AGENT_ADDED = "agent_added"
    AGENT_REMOVED = "agent_removed"
    HEARTBEAT = "heartbeat"
    ERROR = "error"


class WSEvent(BaseModel):
    type: WSEventType
    payload: dict[str, Any]
    timestamp: datetime = Field(default_factory=datetime.utcnow)
