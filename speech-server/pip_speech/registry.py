"""Loads routing.json and hands out engines (lazily loaded, one GPU lock)."""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

from .engines.base import Engine
from .paths import state_dir

log = logging.getLogger("pip-speech")

DEFAULT_ROUTING = Path(__file__).resolve().parent.parent / "routing.json"


def engine_class(kind: str) -> type[Engine]:
    if kind == "faster-whisper":
        from .engines.whisper import WhisperEngine

        return WhisperEngine
    if kind == "qwen3-asr":
        from .engines.qwen3_asr import Qwen3AsrEngine

        return Qwen3AsrEngine
    if kind == "indic-conformer":
        from .engines.indic_conformer import IndicConformerEngine

        return IndicConformerEngine
    if kind == "nemo":
        from .engines.nemo import NemoEngine

        return NemoEngine
    if kind == "sherpa":
        from .engines.sherpa import SherpaEngine

        return SherpaEngine
    if kind == "fake":
        from .engines.fake import FakeEngine

        return FakeEngine
    raise ValueError(f"unknown engine kind {kind}")


def load_routing(path: Path | None = None) -> dict[str, Any]:
    """The user's override in the state dir wins over the shipped defaults."""
    override = state_dir() / "speech-routing.json"
    chosen = path or (override if override.exists() else DEFAULT_ROUTING)
    return json.loads(chosen.read_text(encoding="utf-8"))


class Registry:
    def __init__(self, routing: dict[str, Any], device: str = "cuda") -> None:
        self.routing = routing
        self.device = device
        self.engines: dict[str, Engine] = {}
        self.loaded: set[str] = set()
        self.broken: dict[str, str] = {}
        # One model runs on the GPU at a time; requests queue (each takes ~100-400 ms).
        self.gpu = threading.RLock()
        for engine_id, config in routing.get("engines", {}).items():
            try:
                self.engines[engine_id] = engine_class(config["kind"])(engine_id, {"device": device, **config})
            except Exception as error:  # unknown kind etc.
                self.broken[engine_id] = str(error)

    def serves(self, engine: Engine, language: str) -> bool:
        return not engine.languages or "*" in engine.languages or language in engine.languages

    def usable(self, engine_id: str) -> bool:
        engine = self.engines.get(engine_id)
        if engine is None or engine_id in self.broken:
            return False
        try:
            return engine.available()
        except Exception:
            return False

    def get(self, engine_id: str) -> Engine | None:
        """Loaded engine or None (a failed load marks it broken and the router moves on)."""
        if not self.usable(engine_id):
            return None
        engine = self.engines[engine_id]
        if engine_id not in self.loaded:
            with self.gpu:
                if engine_id not in self.loaded:
                    try:
                        log.info("loading %s", engine_id)
                        engine.load()
                        self.loaded.add(engine_id)
                    except Exception as error:
                        log.warning("couldn't load %s: %s", engine_id, error)
                        self.broken[engine_id] = str(error)
                        return None
        return engine

    def route(self, language: str, role: str) -> list[str]:
        routes = self.routing.get("routes", {})
        entry = routes.get(language) or routes.get("*", {})
        return list(entry.get(role) or routes.get("*", {}).get(role, []))

    def pick(self, language: str, role: str, exclude: set[str] | None = None) -> Engine | None:
        for engine_id in self.route(language, role):
            if exclude and engine_id in exclude:
                continue
            engine = self.engines.get(engine_id)
            if engine is None or not self.serves(engine, language):
                continue
            loaded = self.get(engine_id)
            if loaded is not None:
                return loaded
        return None

    def status(self) -> dict[str, Any]:
        return {
            engine_id: {"kind": engine.kind, "usable": self.usable(engine_id), "loaded": engine_id in self.loaded, **({"error": self.broken[engine_id]} if engine_id in self.broken else {})}
            for engine_id, engine in self.engines.items()
        }
