"""IndicXlit (AI4Bharat, MIT): native script -> Latin, for romanized Hinglish."""

from __future__ import annotations

import threading

from .engines.base import module_available

_engine = None
_lock = threading.Lock()
_error: str | None = None


def available() -> bool:
    return module_available("ai4bharat")


def _load():
    global _engine, _error
    with _lock:
        if _engine is None and _error is None:
            try:
                from ai4bharat.transliteration import XlitEngine

                _engine = XlitEngine(beam_width=4, rescore=False, src_script_type="indic")
            except Exception as error:
                _error = str(error)
    return _engine


def to_latin(words: list[str], language: str = "hi") -> list[str | None]:
    engine = _load()
    if engine is None:
        raise RuntimeError(_error or "IndicXlit isn't installed (uv sync --extra xlit)")
    output: list[str | None] = []
    for word in words:
        try:
            result = engine.translit_word(word, lang_code=language, topk=1)
            if isinstance(result, dict):
                result = next(iter(result.values()), [])
            output.append(result[0] if result else None)
        except Exception:
            output.append(None)
    return output
