"""Spoken language ID, restricted to the languages you speak, with a per-app prior."""

from __future__ import annotations

import numpy as np

from .languages import base, latin_share


def restrict(probabilities: dict[str, float], allowed: list[str]) -> dict[str, float]:
    """Keep only the spoken languages you use. Hindi and Urdu are the same speech
    (Hindustani), so Urdu's mass counts as Hindi unless you also speak Urdu."""
    spoken = {base(code) for code in allowed}
    folded: dict[str, float] = {}
    for code, probability in probabilities.items():
        target = code
        if code == "ur" and "ur" not in spoken and "hi" in spoken:
            target = "hi"
        if target in spoken:
            folded[target] = folded.get(target, 0.0) + probability
    total = sum(folded.values())
    if total <= 0:
        return {}
    return {code: probability / total for code, probability in folded.items()}


def apply_prior(probabilities: dict[str, float], prior: str | None, weight: float) -> dict[str, float]:
    if not prior or not probabilities:
        return probabilities
    spoken_prior = base(prior)
    boosted = {code: probability * (weight if code == spoken_prior else 1.0) for code, probability in probabilities.items()}
    total = sum(boosted.values())
    return {code: probability / total for code, probability in boosted.items()}


def choose(probabilities: dict[str, float], allowed: list[str], prior: str | None) -> str:
    """Best spoken language; falls back to the prior, then your first language."""
    if probabilities:
        return max(probabilities.items(), key=lambda item: item[1])[0]
    if prior and base(prior) in {base(code) for code in allowed}:
        return base(prior)
    return base(allowed[0]) if allowed else "en"


def hinglish_or_hindi(text: str, detected: list[str], allowed: list[str], prior: str | None, latin_threshold: float) -> str:
    """Hindi audio is written as Hinglish when it mixes in English, or when Hinglish is all you use."""
    wants_hinglish = "hinglish" in allowed
    wants_hindi = "hi" in allowed
    if wants_hinglish and not wants_hindi:
        return "hinglish"
    if not wants_hinglish:
        return "hi"
    # Qwen3-ASR reports "Hindi,English" for code-switched speech; a Pip fine-tune reports "Hinglish".
    mixed = "hinglish" in detected or ("en" in detected and "hi" in detected) or latin_share(text) >= latin_threshold
    if mixed:
        return "hinglish"
    return "hinglish" if prior == "hinglish" and latin_share(text) > 0 else "hi"


def window(audio: np.ndarray, seconds: float = 8.0, sample_rate: int = 16000) -> np.ndarray:
    return audio[: int(seconds * sample_rate)]
