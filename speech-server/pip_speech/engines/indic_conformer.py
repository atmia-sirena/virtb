"""AI4Bharat IndicConformer-600M multilingual (MIT): all 22 scheduled
languages, CTC (fast, live text) and RNNT (final) decoders in one model,
loaded with transformers' remote code."""

from __future__ import annotations

import numpy as np

from ..languages import INDIC, base
from ..paths import resolve_model
from .base import Engine, Transcript, module_available, words_from_text


class IndicConformerEngine(Engine):
    kind = "indic-conformer"

    def __init__(self, engine_id, config):
        super().__init__(engine_id, config)
        self.model = None
        if not self.languages:
            self.languages = [*INDIC, "hinglish"]

    def available(self) -> bool:
        return module_available("transformers") and module_available("torch")

    def load(self) -> None:
        import torch
        from transformers import AutoModel

        self.model = AutoModel.from_pretrained(resolve_model(self.config.get("model", "ai4bharat/indic-conformer-600m-multilingual")), trust_remote_code=True)
        if self.device == "cuda" and torch.cuda.is_available() and hasattr(self.model, "to"):
            try:
                self.model = self.model.to("cuda")
            except Exception:
                pass

    def transcribe(self, audio: np.ndarray, language: str, context: list[str]) -> Transcript:
        import torch

        decoder = self.config.get("decoder", "rnnt")
        waveform = torch.from_numpy(audio.astype(np.float32)).unsqueeze(0)
        text = self.model(waveform, base(language), decoder)
        if isinstance(text, (list, tuple)):
            text = text[0]
        text = str(text).strip()
        return Transcript(text=text, words=words_from_text(text), language=language, model=self.id)
