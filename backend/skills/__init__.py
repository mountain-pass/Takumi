"""
Agent skills — tools that agents can invoke during task execution.
Each skill is a callable that takes parameters and returns a string result.
"""
from .web_search import web_search, web_fetch
from .registry import SKILL_REGISTRY, get_skill, get_skills_for_agent

__all__ = ["web_search", "web_fetch", "SKILL_REGISTRY", "get_skill", "get_skills_for_agent"]
