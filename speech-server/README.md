# Pip speech server

A local GPU sidecar for Pip's dictation in Indian languages. It runs on `127.0.0.1:8790` and Pip's backend starts it. The backend falls back to Parakeet on the CPU when the server isn't running.

```
mic chunks ─▶ backend /v2/asr/sessions ─▶ speech server
   VAD (Silero) ─▶ language ID (Whisper, limited to your languages, plus this app's last language)
   ─▶ that language's best model, given your dictionary words as context
   ─▶ a second model when the first is unsure ─▶ Hindi or Hinglish?
   ─▶ words + timings + confidences ─▶ backend cleanup layer ─▶ typed text
```

## Install (Windows, NVIDIA GPU)

```powershell
cd speech-server
uv sync --extra gpu --extra qwen --extra dev     # PyTorch cu128 (Blackwell), faster-whisper, sherpa-onnx, Qwen3-ASR
uv run python -m pip_speech.download            # recommended models (~12 GB) into %APPDATA%\Pip\models
uv run pytest                                   # adapters and routing, with fake engines
```

Optional extras:

- `--extra xlit`: IndicXlit for romanized Hinglish. It is fairseq based and may not build on Windows; the backend has its own fallback.
- `--extra nemo`: raw `.nemo` checkpoints (SraVaani, fine-tunes). It can't share a venv with `qwen`. Export NeMo models to ONNX instead (`training/export/`), and sherpa-onnx runs them.

To run it by hand: `uv run pip-speech --warm qwen3-asr-1.7b,indicconformer-rnnt`. The backend does this for you when `PIP_SPEECH_SERVER` points at this folder.

## Which model handles which language

`routing.json` lists, per language, the engines for the final pass, live text and a second opinion. The first installed engine in each list wins. The defaults come from published results until you run the bake-off:

| Language | Final pass | Live text | Second opinion |
| --- | --- | --- | --- |
| English (Indian) | your fine-tune → Qwen3-ASR 1.7B → Whisper large-v3 → Parakeet v2 | Qwen3-ASR 0.6B | Whisper large-v3 |
| Hindi | your fine-tune → Qwen3-ASR 1.7B → IndicConformer → IndicWhisper | IndicConformer CTC | IndicConformer RNNT |
| Hinglish | your fine-tune → Qwen3-ASR 1.7B → Shunya Hinglish → Whisper large-v3 | Qwen3-ASR 0.6B | Shunya / Whisper |
| Tamil, Telugu, Punjabi | your SraVaani fine-tune → SraVaani → IndicConformer RNNT | IndicConformer CTC | IndicConformer RNNT |
| other Indian languages | SraVaani → IndicConformer → Omnilingual 300M | IndicConformer CTC | Omnilingual |

`uv run python ../eval/run.py --bakeoff` measures every installed engine on every eval set. It writes the winning order to `%APPDATA%\Pip\speech-routing.json`, which overrides the file here.

## API

| Method and path | Body | Returns |
| --- | --- | --- |
| `POST /sessions` | `{languages, language?, prior?, context?}` | `{sessionId}` |
| `POST /sessions/{id}/audio` | raw PCM16, 16 kHz, mono | `{text, language}` (live) |
| `POST /sessions/{id}/finish` | | `{text, words:[{w,start,end,conf}], language, confidence, model, timings}` |
| `DELETE /sessions/{id}` | | |
| `POST /transcribe?languages=hi,en&language=` | WAV or FLAC | same as finish |
| `POST /lid?languages=...` | WAV | `{language, probabilities}` |
| `POST /xlit` | `{words, source:"hi"}` | `{words}` in Latin script |
| `GET /health` | | engines, device, VAD backend |

## Licenses

| Component | License |
| --- | --- |
| Qwen3-ASR | Apache-2.0 |
| IndicConformer | MIT |
| SraVaani-1.0 | MIT |
| Whisper | MIT |
| IndicWhisper | MIT |
| Shunya zero-stt-hinglish | OpenRAIL-M |
| Parakeet | CC-BY-4.0 |
| Omnilingual ASR | Apache-2.0 |
| Silero VAD | MIT |
| IndicXlit | MIT |
| sherpa-onnx | Apache-2.0 |
| faster-whisper | MIT |

Everything runs locally. No audio leaves the PC.
