"""ONNX models through sherpa-onnx (Apache-2.0), on the GPU with the CUDA build
or on the CPU: NeMo transducers/CTC (Parakeet, IndicConformer exports,
SraVaani exports), Qwen3-ASR exports, and Meta's Omnilingual ASR for rare
languages. Fine-tuned models from training/ are exported to these formats."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from ..audio import SAMPLE_RATE
from ..paths import resolve_model
from .base import Engine, Transcript, Word, module_available, words_from_text


def _find(directory: Path, prefix: str) -> str:
    matches = sorted(directory.glob(f"{prefix}*.onnx"), key=lambda path: ("int8" not in path.name, path.name))
    if not matches:
        raise FileNotFoundError(f"no {prefix}*.onnx in {directory}")
    return str(matches[0])


class SherpaEngine(Engine):
    kind = "sherpa"

    def __init__(self, engine_id, config):
        super().__init__(engine_id, config)
        self.recognizer = None

    def available(self) -> bool:
        return module_available("sherpa_onnx") and Path(resolve_model(self.config["model"])).exists()

    def load(self) -> None:
        import sherpa_onnx

        directory = Path(resolve_model(self.config["model"]))
        common = {"num_threads": int(self.config.get("threads", 4)), "provider": "cuda" if self.device == "cuda" else "cpu"}
        tokens = str(directory / "tokens.txt")
        family = self.config.get("family", "nemo-transducer")
        if family == "nemo-transducer":
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=_find(directory, "encoder"), decoder=_find(directory, "decoder"), joiner=_find(directory, "joiner"), tokens=tokens, model_type="nemo_transducer", **common
            )
        elif family == "nemo-ctc":
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(model=_find(directory, "model"), tokens=tokens, **common)
        elif family == "omnilingual-ctc":
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_omnilingual_asr_ctc(model=_find(directory, "model"), tokens=tokens, **common)
        elif family == "qwen3-asr":
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
                conv_frontend=_find(directory, "conv_frontend"), encoder=_find(directory, "encoder"), decoder=_find(directory, "decoder"), tokenizer=str(directory / "tokenizer"), **common
            )
        else:
            raise ValueError(f"unknown sherpa family {family}")

    def transcribe(self, audio: np.ndarray, language: str, context: list[str]) -> Transcript:
        stream = self.recognizer.create_stream()
        padded = np.concatenate([audio.astype(np.float32), np.zeros(int(SAMPLE_RATE * 0.3), dtype=np.float32)])
        stream.accept_waveform(SAMPLE_RATE, padded)
        self.recognizer.decode_stream(stream)
        result = stream.result
        words = merge_tokens(list(getattr(result, "tokens", []) or []), list(getattr(result, "timestamps", []) or []))
        text = result.text.strip()
        return Transcript(text=text, words=words or words_from_text(text), language=language, model=self.id)


def merge_tokens(tokens: list[str], timestamps: list[float]) -> list[Word]:
    """BPE pieces ("▁kal", "▁mee", "ting") with start times -> words with start/end."""
    if not tokens or len(tokens) != len(timestamps):
        return []
    words: list[Word] = []
    for token, start in zip(tokens, timestamps):
        starts_word = token.startswith("▁") or token.startswith(" ") or not words
        piece = token.replace("▁", "").strip()
        if not piece:
            continue
        if starts_word:
            if words:
                words[-1].end = round(float(start), 3)
            words.append(Word(piece, round(float(start), 3)))
        else:
            words[-1].w += piece
    if words and words[-1].start is not None:
        words[-1].end = round(words[-1].start + 0.4, 3)
    return words
