"""Paths and manifest helpers shared by the data scripts and recipes."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable, Iterator

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent


def state_dir() -> Path:
    if os.environ.get("PIP_STATE_DIR"):
        return Path(os.environ["PIP_STATE_DIR"])
    if os.name == "nt" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "Pip"
    return Path.home() / ".config" / "pip"


def train_dir() -> Path:
    """Training audio lives outside the repo (hundreds of GB): PIP_TRAIN_DATA or a sibling of the eval data."""
    return Path(os.environ["PIP_TRAIN_DATA"]) if os.environ.get("PIP_TRAIN_DATA") else state_dir() / "train" / "data"


def eval_data_dir() -> Path:
    return Path(os.environ["PIP_EVAL_DATA"]) if os.environ.get("PIP_EVAL_DATA") else state_dir() / "eval" / "data"


def models_dir() -> Path:
    return Path(os.environ["PIP_MODELS_DIR"]) if os.environ.get("PIP_MODELS_DIR") else state_dir() / "models"


def load_sources() -> dict[str, Any]:
    return yaml.safe_load((ROOT / "sources.yaml").read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
    return count


# Qwen3-ASR's language names (its prompt prefix "language Hindi<asr_text>...").
QWEN_LANGUAGE = {"en": "English", "hi": "Hindi", "hinglish": "Hinglish", "ta": "Tamil", "te": "Telugu", "pa": "Punjabi", "bn": "Bengali", "mr": "Marathi", "gu": "Gujarati", "kn": "Kannada", "ml": "Malayalam", "ur": "Urdu"}
