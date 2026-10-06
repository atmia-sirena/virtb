"""Whisper family through faster-whisper (CTranslate2): Whisper large-v3 (best
open model on Indian-accented English), IndicWhisper and Shunya Hinglish after
`ct2-transformers-converter`. Also Pip's language-ID model."""

from __future__ import annotations

import numpy as np

from ..languages import base
from ..paths import resolve_model
from .base import Engine, Transcript, Word, mean, module_available

# Whisper has no "hinglish" or code for some scheduled languages.
WHISPER_CODES = {"en", "hi", "ta", "te", "pa", "bn", "mr", "gu", "kn", "ml", "ur", "ne", "sa", "sd", "as", "or"}


class WhisperEngine(Engine):
    kind = "faster-whisper"

    def __init__(self, engine_id, config):
        super().__init__(engine_id, config)
        self.model = None

    def available(self) -> bool:
        return module_available("faster_whisper")

    def load(self) -> None:
        from faster_whisper import WhisperModel

        compute_type = self.config.get("compute_type", "float16" if self.device == "cuda" else "int8")
        self.model = WhisperModel(resolve_model(self.config["model"]), device=self.device, compute_type=compute_type)

    def transcribe(self, audio: np.ndarray, language: str, context: list[str]) -> Transcript:
        spoken = base(language)
        prompt = self.config.get("prompt", {}).get(language)
        if context:
            prompt = f"{prompt + ' ' if prompt else ''}{', '.join(context[:60])}."
        segments, info = self.model.transcribe(
            audio,
            language=spoken if spoken in WHISPER_CODES else None,
            initial_prompt=prompt,
            hotwords=", ".join(context[:60]) if context and not prompt else None,
            beam_size=int(self.config.get("beam_size", 5)),
            word_timestamps=True,
            condition_on_previous_text=False,
            vad_filter=False,
            without_timestamps=False,
        )
        words: list[Word] = []
        texts: list[str] = []
        for segment in segments:
            texts.append(segment.text.strip())
            for word in segment.words or []:
                words.append(Word(word.word.strip(), round(word.start, 3), round(word.end, 3), round(float(word.probability), 3)))
        return Transcript(
            text=" ".join(texts).strip(),
            words=[word for word in words if word.w],
            language=language,
            confidence=mean([word.conf for word in words if word.conf is not None]),
            model=self.id,
            detail={"detected": info.language, "detected_probability": info.language_probability},
        )

    def detect_language(self, audio: np.ndarray) -> dict[str, float] | None:
        if hasattr(self.model, "detect_language"):
            result = self.model.detect_language(audio=audio)
            pairs = result[2] if isinstance(result, tuple) and len(result) >= 3 else []
        else:
            _, info = self.model.transcribe(audio[: 16000 * 30], language=None, beam_size=1, without_timestamps=True)
            pairs = info.all_language_probs or []
        return {code: float(probability) for code, probability in pairs}
