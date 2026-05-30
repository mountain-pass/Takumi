"""
Configuration management — reads from environment or .env file
"""
from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # LLM API Keys
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    google_api_key: str = ""
    glm_api_key: str = ""
    minimax_api_key: str = ""
    minimax_group_id: str = ""

    # Ollama
    ollama_base_url: str = "http://localhost:11434"
    ollama_api_key: str = ""

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    # Orchestration
    heartbeat_interval: float = 5.0       # seconds
    agent_think_interval: float = 10.0    # how often idle agents self-check
    max_parallel_agents: int = 10

    # Persistence
    data_dir: str = "./data"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache
def get_settings() -> Settings:
    return Settings()
