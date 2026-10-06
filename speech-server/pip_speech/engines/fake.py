"""A scripted engine for tests and for trying the API without models."""

from __future__ import annotations

import numpy as np

from ..audio import SAMPLE_RATE
from .base import Engine, Transcript, Word


class FakeEngine(Engine):
    kind = "fake"

    def transcribe(self, audio: np.ndarray, language: str, context: list[str]) -> Transcript:
        replies = self.config.get("replies", {})
        text = replies.get(language, replies.get("*", f"{self.id} {language}"))
        tokens = text.split()
        duration = max(audio.size / SAMPLE_RATE, 0.1)
        step = duration / max(len(tokens), 1)
        confidence = float(self.config.get("confidence", 0.9))
        words = [Word(token, round(index * step, 3), round((index + 1) * step, 3), confidence) for index, token in enumerate(tokens)]
        return Transcript(text=text, words=words, language=language, confidence=confidence if tokens else None, model=self.id, detail=dict(self.config.get("detail", {})))

    def detect_language(self, audio: np.ndarray) -> dict[str, float] | None:
        return dict(self.config["lid"]) if "lid" in self.config else None
