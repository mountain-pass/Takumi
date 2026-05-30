"""
Simple JSON persistence for organisation config and tasks.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
from .models import OrganisationConfig


def _org_path(data_dir: str) -> Path:
    p = Path(data_dir)
    p.mkdir(parents=True, exist_ok=True)
    return p / "organisation.json"


def save_org(org: OrganisationConfig, data_dir: str) -> None:
    path = _org_path(data_dir)
    path.write_text(org.model_dump_json(indent=2))


def load_org(data_dir: str) -> OrganisationConfig:
    path = _org_path(data_dir)
    if path.exists():
        try:
            return OrganisationConfig.model_validate_json(path.read_text())
        except Exception:
            pass
    return OrganisationConfig()
