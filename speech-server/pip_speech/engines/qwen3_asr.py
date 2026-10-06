"""Qwen3-ASR (Apache-2.0) through the official qwen-asr package: an LLM-style
decoder that handles Hindi-English code-switching and takes context text
(your dictionary, names on screen) to bias spellings. 1.7B for the final pass,
0.6B for live text. Fine-tuned checkpoints from training/ load the same way."""

from __future__ import annotations

import numpy as np

from ..audio import SAMPLE_RATE
from ..languages import NAMES, base
from ..paths import resolve_model
from .base import Engine, Transcript, module_available, words_from_text

# Languages Qwen3-ASR accepts by name (the rest are left to auto-detect).
SUPPORTED = {"en": "English", "hi": "Hindi"}


class Qwen3AsrEngine(Engine):
    kind = "qwen3-asr"

    def __init__(self, engine_id, config):
        super().__init__(engine_id, config)
        self.model = None

    def available(self) -> bool:
        return module_available("qwen_asr") and module_available("torch")

    def load(self) -> None:
        import torch
        from qwen_asr import Qwen3ASRModel

        kwargs = {
            "dtype": torch.bfloat16 if self.device.startswith("cuda") else torch.float32,
            "device_map": "cuda:0" if self.device == "cuda" else self.device,
            "max_inference_batch_size": 8,
            "max_new_tokens": int(self.config.get("max_new_tokens", 448)),
        }
        if self.config.get("flash_attention"):
            kwargs["attn_implementation"] = "flash_attention_2"
        self.model = Qwen3ASRModel.from_pretrained(resolve_model(self.config["model"]), **kwargs)

    def transcribe(self, audio: np.ndarray, language: str, context: list[str]) -> Transcript:
        # Hinglish is left unforced so the model can write English words in Latin script.
        forced = None if language == "hinglish" else SUPPORTED.get(base(language))
        context_text = ""
        if context:
            context_text = "Names and terms that may appear: " + ", ".join(context[:80])
        result = self.model.transcribe(audio=(audio, SAMPLE_RATE), context=context_text, language=forced)[0]
        detected = [NAMES_REVERSE.get(name.strip(), name.strip()) for name in (result.language or "").split(",") if name.strip()]
        return Transcript(text=result.text.strip(), words=words_from_text(result.text), language=language, model=self.id, detail={"detected": detected})


NAMES_REVERSE = {name: code for code, name in NAMES.items()}
