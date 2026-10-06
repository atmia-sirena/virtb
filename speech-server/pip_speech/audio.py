"""Audio helpers: PCM16 decode, resampling, voice activity and chunking."""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16000


def pcm16_to_float(data: bytes) -> np.ndarray:
    if len(data) % 2:
        data = data[:-1]
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def resample(samples: np.ndarray, rate: int, target: int = SAMPLE_RATE) -> np.ndarray:
    if rate == target or samples.size == 0:
        return samples.astype(np.float32)
    try:
        import torch
        import torchaudio.functional as F

        return F.resample(torch.from_numpy(samples.astype(np.float32)), rate, target).numpy()
    except ImportError:
        duration = samples.size / rate
        positions = np.linspace(0, samples.size - 1, int(round(duration * target)))
        return np.interp(positions, np.arange(samples.size), samples).astype(np.float32)


def decode_file(data: bytes) -> np.ndarray:
    """WAV/FLAC/OGG bytes -> mono float32 at 16 kHz."""
    import soundfile

    samples, rate = soundfile.read(io.BytesIO(data), dtype="float32", always_2d=True)
    return resample(samples.mean(axis=1), rate)


@dataclass
class Segment:
    start: int  # samples
    end: int


class Vad:
    """Silero VAD when installed (MIT), otherwise an energy gate."""

    def __init__(self) -> None:
        self._model = None
        self._tried = False

    def _load(self):
        if not self._tried:
            self._tried = True
            try:
                from silero_vad import load_silero_vad

                self._model = load_silero_vad(onnx=True)
            except Exception:
                self._model = None
        return self._model

    @property
    def backend(self) -> str:
        return "silero" if self._load() is not None else "energy"

    def speech(self, samples: np.ndarray, min_silence_ms: int = 300) -> list[Segment]:
        if samples.size == 0:
            return []
        model = self._load()
        if model is not None:
            import torch
            from silero_vad import get_speech_timestamps

            stamps = get_speech_timestamps(torch.from_numpy(samples), model, sampling_rate=SAMPLE_RATE, min_silence_duration_ms=min_silence_ms, speech_pad_ms=120)
            return [Segment(int(stamp["start"]), int(stamp["end"])) for stamp in stamps]
        return energy_segments(samples, min_silence_ms)


def energy_segments(samples: np.ndarray, min_silence_ms: int = 300) -> list[Segment]:
    frame = int(SAMPLE_RATE * 0.03)
    if samples.size < frame:
        return [Segment(0, samples.size)] if np.abs(samples).max(initial=0) > 0.01 else []
    frames = samples[: samples.size - samples.size % frame].reshape(-1, frame)
    energy = np.sqrt((frames**2).mean(axis=1))
    # Above the room's noise floor, but never above half the loudest frame (all-speech clips).
    threshold = max(0.008, min(float(np.percentile(energy, 10)) * 3, float(energy.max()) * 0.5))
    voiced = energy > threshold
    segments: list[Segment] = []
    gap_frames = max(1, int(min_silence_ms / 30))
    start = None
    silent = 0
    for index, is_voiced in enumerate(voiced):
        if is_voiced:
            if start is None:
                start = index
            silent = 0
        elif start is not None:
            silent += 1
            if silent >= gap_frames:
                segments.append(Segment(start * frame, (index - silent + 1) * frame))
                start = None
                silent = 0
    if start is not None:
        segments.append(Segment(start * frame, len(voiced) * frame))
    pad = int(SAMPLE_RATE * 0.12)
    return [Segment(max(0, segment.start - pad), min(samples.size, segment.end + pad)) for segment in segments]


def chunk(segments: list[Segment], max_seconds: float = 20.0) -> list[Segment]:
    """Merge speech segments into chunks no longer than max_seconds (cut only in silences)."""
    limit = int(max_seconds * SAMPLE_RATE)
    chunks: list[Segment] = []
    for segment in segments:
        # A single very long segment is cut hard.
        pieces = [Segment(position, min(segment.end, position + limit)) for position in range(segment.start, segment.end, limit)]
        for piece in pieces:
            if chunks and piece.end - chunks[-1].start <= limit:
                chunks[-1] = Segment(chunks[-1].start, piece.end)
            else:
                chunks.append(piece)
    return chunks
