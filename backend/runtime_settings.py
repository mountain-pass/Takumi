"""
Mutable runtime settings — org info and LLM credentials that can be updated
via the setup wizard without restarting the server.
"""
from __future__ import annotations
import json
from pathlib import Path

_FILENAME = "runtime_settings.json"
_data_dir: str = "./data"

_state: dict = {}


def init(data_dir: str, env_settings=None) -> None:
    """Load persisted settings, then backfill any missing keys from env vars."""
    global _data_dir, _state
    _data_dir = data_dir
    _state = _load()

    # Seed from env if runtime has no key yet (first run)
    if env_settings and not _state.get("llm_api_key"):
        for env_key, rt_key in [
            ("ollama_api_key", "llm_api_key"),
            ("ollama_base_url", "llm_base_url"),
        ]:
            val = getattr(env_settings, env_key, "")
            if val:
                _state[rt_key] = val
        if env_settings.ollama_base_url:
            _state["llm_base_url"] = env_settings.ollama_base_url
        _save()


def get() -> dict:
    return _state


def update(patch: dict) -> None:
    _state.update(patch)
    _save()


def _path() -> Path:
    p = Path(_data_dir)
    p.mkdir(parents=True, exist_ok=True)
    return p / _FILENAME


def _load() -> dict:
    p = _path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {
        "org_name": "",
        "org_description": "",
        "configured": False,
        "llm_provider": "ollama",
        "llm_api_key": "",
        "llm_base_url": "",
        "llm_model": "",
    }


def _save() -> None:
    _path().write_text(json.dumps(_state, indent=2))
