"""The speech pipeline: voice activity -> language ID -> best model for that
language (with your context words) -> a second model when unsure -> Hindi vs
Hinglish. Returns words with timings and confidences for the cleanup layer."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from . import lid
from .audio import SAMPLE_RATE, Segment, Vad, chunk
from .engines.base import Transcript, Word
from .languages import base, normalize
from .registry import Registry


@dataclass
class Request:
    languages: list[str] = field(default_factory=lambda: ["en"])
    # Forced language (the language-cycle hotkey), else detected.
    language: str | None = None
    # This app's last language: a prior for language ID.
    prior: str | None = None
    # Dictionary words and names on screen, to bias spellings.
    context: list[str] = field(default_factory=list)
    # Force one engine (the eval bake-off); skips routing and the second opinion.
    engine: str | None = None


class Router:
    def __init__(self, registry: Registry, vad: Vad | None = None) -> None:
        self.registry = registry
        self.vad = vad or Vad()
        self.settings = registry.routing

    # --- language -----------------------------------------------------------

    def route_language(self, spoken: str, request: Request) -> str:
        """Which route Hindi audio takes: Hinglish (code-switch friendly) when you use Hinglish."""
        allowed = [normalize(code) for code in request.languages]
        if spoken == "hi" and "hinglish" in allowed:
            return "hinglish"
        return spoken

    def detect(self, audio: np.ndarray, request: Request) -> tuple[str, dict[str, float]]:
        allowed = [normalize(code) for code in request.languages] or ["en"]
        prior = normalize(request.prior) if request.prior else None
        if request.language:
            return base(normalize(request.language)), {}
        spoken = {base(code) for code in allowed}
        if len(spoken) == 1:
            return next(iter(spoken)), {}
        probabilities: dict[str, float] = {}
        if audio.size >= SAMPLE_RATE * 0.6:
            for engine_id in self.settings.get("lid", []):
                engine = self.registry.get(engine_id)
                if engine is None:
                    continue
                with self.registry.gpu:
                    raw = engine.detect_language(lid.window(audio))
                if raw:
                    probabilities = lid.restrict(raw, allowed)
                    break
        probabilities = lid.apply_prior(probabilities, prior, float(self.settings.get("priorWeight", 2.0)))
        return lid.choose(probabilities, allowed, prior), probabilities

    # --- transcription ------------------------------------------------------

    def _run(self, engine_role: str, route: str, audio: np.ndarray, request: Request, exclude: set[str] | None = None) -> Transcript | None:
        if request.engine:
            engine = self.registry.get(request.engine)
            if engine is None:
                raise RuntimeError(f"engine {request.engine} isn't usable: {self.registry.broken.get(request.engine, 'not installed')}")
        else:
            engine = self.registry.pick(route, engine_role, exclude)
        if engine is None:
            return None
        if engine.config.get("longAudio") or audio.size <= SAMPLE_RATE * 25:
            with self.registry.gpu:
                return engine.transcribe(audio, route, request.context)
        # Long audio for models with a ~30 s window: decode speech chunks and stitch.
        pieces = chunk(self.vad.speech(audio), max_seconds=20) or [Segment(0, audio.size)]
        texts: list[str] = []
        words: list[Word] = []
        confidences: list[float] = []
        for piece in pieces:
            with self.registry.gpu:
                part = engine.transcribe(audio[piece.start : piece.end], route, request.context)
            offset = piece.start / SAMPLE_RATE
            texts.append(part.text)
            for word in part.words:
                words.append(Word(word.w, None if word.start is None else round(word.start + offset, 3), None if word.end is None else round(word.end + offset, 3), word.conf))
            if part.confidence is not None:
                confidences.append(part.confidence)
        return Transcript(" ".join(text for text in texts if text), words, route, float(np.mean(confidences)) if confidences else None, engine.id)

    def partial(self, audio: np.ndarray, request: Request, language: str | None) -> Transcript | None:
        """Live text while the key is held: the fast model on the last ~12 s."""
        forced = normalize(request.language) if request.language else None
        spoken = language or self.detect(audio, request)[0]
        route = forced or self.route_language(spoken, request)
        recent = audio[-int(SAMPLE_RATE * 12) :]
        if recent.size < SAMPLE_RATE * 0.3:
            return None
        return self._run("partial", route, recent, request)

    def final(self, audio: np.ndarray, request: Request, language: str | None = None) -> dict[str, Any]:
        timings: dict[str, float] = {}
        started = time.perf_counter()
        segments = self.vad.speech(audio)
        timings["vad"] = time.perf_counter() - started
        if not segments:
            return {"text": "", "words": [], "language": base(normalize(request.language or (request.languages or ["en"])[0])), "model": None, "confidence": None, "timings": timings}
        # Trim leading/trailing silence; keep the pauses in between (they mark clauses).
        start, end = segments[0].start, segments[-1].end
        speech = audio[start:end]
        offset = start / SAMPLE_RATE

        mark = time.perf_counter()
        spoken, probabilities = (language, {}) if language else self.detect(speech, request)
        timings["lid"] = time.perf_counter() - mark
        forced = normalize(request.language) if request.language else None
        route = forced or self.route_language(spoken, request)

        mark = time.perf_counter()
        result = self._run("final", route, speech, request)
        timings["final"] = time.perf_counter() - mark
        if result is None:
            raise RuntimeError(f"no speech model is installed for {route}; run speech-server/setup")

        # Unsure? Ask a second, different model and keep the more confident answer.
        threshold = float(self.settings.get("ensembleBelow", 0.6))
        if result.confidence is not None and result.confidence < threshold and not request.engine:
            mark = time.perf_counter()
            second = self._run("second", route, speech, request, exclude={result.model})
            timings["second"] = time.perf_counter() - mark
            if second is not None and second.text and (second.confidence or 0) > result.confidence:
                second.detail["replaced"] = result.model
                result = second

        language_out = route
        if base(route) == "hi" and not forced:
            detected = [base(normalize(code)) for code in result.detail.get("detected", [])] if isinstance(result.detail.get("detected"), list) else []
            language_out = lid.hinglish_or_hindi(result.text, detected, [normalize(code) for code in request.languages], normalize(request.prior) if request.prior else None, float(self.settings.get("hinglishLatinShare", 0.15)))

        words = [Word(word.w, None if word.start is None else round(word.start + offset, 3), None if word.end is None else round(word.end + offset, 3), word.conf) for word in result.words]
        timings["total"] = time.perf_counter() - started
        transcript = Transcript(result.text, words, language_out, result.confidence, result.model, result.detail)
        return {**transcript.to_json(), "probabilities": probabilities, "timings": {key: round(value, 4) for key, value in timings.items()}}
