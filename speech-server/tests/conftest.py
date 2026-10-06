import os
import tempfile

import numpy as np
import pytest

os.environ.setdefault("PIP_STATE_DIR", tempfile.mkdtemp(prefix="pip-speech-test-"))

from pip_speech.registry import Registry  # noqa: E402


def tone(seconds: float, gap_after: float = 0.0, rate: int = 16000) -> np.ndarray:
    """Loud 220 Hz 'speech' followed by silence: enough for the energy VAD."""
    t = np.arange(int(seconds * rate)) / rate
    voiced = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    return np.concatenate([voiced, np.zeros(int(gap_after * rate), dtype=np.float32)])


def pcm16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def routing(**overrides):
    value = {
        "lid": ["lid"],
        "ensembleBelow": 0.6,
        "hinglishLatinShare": 0.15,
        "priorWeight": 2.0,
        "engines": {
            "lid": {"kind": "fake", "lid": {"hi": 0.5, "en": 0.3, "ta": 0.15, "ur": 0.05}},
            "qwen": {"kind": "fake", "languages": ["en", "hi", "hinglish"], "replies": {"hinglish": "kal meeting 5 baje hai", "en": "see you tomorrow", "hi": "कल मिलते हैं"}, "detail": {"detected": ["Hindi", "English"]}, "confidence": 0.9},
            "conformer": {"kind": "fake", "replies": {"ta": "நாளைக்கு வரேன்", "*": "conformer"}, "confidence": 0.5},
            "sravaani": {"kind": "fake", "languages": ["*"], "replies": {"ta": "நாளைக்கு வருவேன்"}, "confidence": 0.8},
            "missing": {"kind": "sherpa", "model": "does-not-exist", "family": "nemo-ctc"},
            "fast": {"kind": "fake", "replies": {"*": "live text"}},
        },
        "routes": {
            "en": {"final": ["missing", "qwen"], "partial": ["fast"], "second": []},
            "hinglish": {"final": ["qwen"], "partial": ["fast"], "second": []},
            "*": {"final": ["conformer"], "partial": ["fast"], "second": ["sravaani"]},
        },
    }
    value.update(overrides)
    return value


@pytest.fixture
def registry():
    return Registry(routing(), device="cpu")
