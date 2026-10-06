"""NVIDIA NeMo checkpoints (.nemo or NGC/HF names): SraVaani-1.0 (IISc/ARTPARK,
MIT, 65 Indian languages), Parakeet, and your fine-tunes before ONNX export.
Gives word timestamps."""

from __future__ import annotations

import numpy as np

from ..paths import resolve_model
from .base import Engine, Transcript, Word, module_available, words_from_text


class NemoEngine(Engine):
    kind = "nemo"

    def __init__(self, engine_id, config):
        super().__init__(engine_id, config)
        self.model = None

    def available(self) -> bool:
        return module_available("nemo")

    def load(self) -> None:
        import nemo.collections.asr as nemo_asr

        reference = resolve_model(self.config["model"])
        if reference.endswith(".nemo"):
            self.model = nemo_asr.models.ASRModel.restore_from(reference, map_location=self.device)
        else:
            self.model = nemo_asr.models.ASRModel.from_pretrained(reference, map_location=self.device)
        self.model.eval()
        decoder = self.config.get("decoder")
        if decoder and hasattr(self.model, "change_decoding_strategy"):
            # Hybrid TDT-CTC models: "ctc" for speed, "rnnt"/"tdt" for accuracy.
            try:
                self.model.change_decoding_strategy(decoder_type=decoder)
            except TypeError:
                pass

    def transcribe(self, audio: np.ndarray, language: str, context: list[str]) -> Transcript:
        kwargs = {"batch_size": 1, "timestamps": True}
        if self.config.get("language_argument"):
            kwargs[self.config["language_argument"]] = language
        output = self.model.transcribe([audio.astype(np.float32)], **kwargs)
        hypothesis = output[0][0] if isinstance(output, tuple) else output[0]
        text = hypothesis.text if hasattr(hypothesis, "text") else str(hypothesis)
        words: list[Word] = []
        stamps = getattr(hypothesis, "timestamp", None) or {}
        for item in stamps.get("word", []) if isinstance(stamps, dict) else []:
            words.append(Word(item.get("word", ""), item.get("start"), item.get("end")))
        return Transcript(text=text.strip(), words=words or words_from_text(text), language=language, model=self.id)
