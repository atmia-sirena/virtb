"""Where models and settings live (same folder the backend uses)."""

from __future__ import annotations

import os
from pathlib import Path


def state_dir() -> Path:
    if os.environ.get("PIP_STATE_DIR"):
        return Path(os.environ["PIP_STATE_DIR"])
    if os.name == "nt" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "Pip"
    return Path.home() / ".config" / "pip"


def models_dir() -> Path:
    return Path(os.environ["PIP_MODELS_DIR"]) if os.environ.get("PIP_MODELS_DIR") else state_dir() / "models"


def resolve_model(reference: str) -> str:
    """A model reference is a folder/file under the models dir, an absolute path, or a Hugging Face id."""
    candidate = Path(reference)
    if candidate.is_absolute():
        return str(candidate)
    local = models_dir() / reference
    if local.exists():
        return str(local)
    return reference


def is_local(reference: str) -> bool:
    return Path(resolve_model(reference)).exists()
