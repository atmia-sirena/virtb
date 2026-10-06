"""The engine interface every speech model adapter implements."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np


@dataclass
class Word:
    w: str
    start: float | None = None
    end: float | None = None
    conf: float | None = None


@dataclass
class Transcript:
    text: str
    words: list[Word] = field(default_factory=list)
    language: str | None = None
    # Mean word confidence in [0, 1] when the model exposes it.
    confidence: float | None = None
    model: str = ""
    # Extra signals, e.g. Qwen3-ASR's detected language list ("Hindi,English").
    detail: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        value = asdict(self)
        value["words"] = [{key: item for key, item in asdict(word).items() if item is not None} for word in self.words]
        return value


class Engine:
    """One loaded speech model."""

    kind = "base"

    def __init__(self, engine_id: str, config: dict[str, Any]) -> None:
        self.id = engine_id
        self.config = config
        self.languages: list[str] = list(config.get("languages", []))
        self.device: str = config.get("device", "cuda")

    def available(self) -> bool:
        """Whether its packages and weights are present (cheap check, no loading)."""
        return True

    def load(self) -> None:
        """Load weights (called once, lazily)."""

    def transcribe(self, audio: np.ndarray, language: str, context: list[str]) -> Transcript:
        raise NotImplementedError

    def detect_language(self, audio: np.ndarray) -> dict[str, float] | None:
        """Language probabilities, for engines that can do language ID."""
        return None


def words_from_text(text: str) -> list[Word]:
    return [Word(token) for token in text.split()]


def mean(values: list[float]) -> float | None:
    return float(np.mean(values)) if values else None


def module_available(name: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False
