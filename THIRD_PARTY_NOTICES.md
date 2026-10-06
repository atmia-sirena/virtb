# Third-party components

Pip is a personal, non-commercial build. Everything it runs is local, and every component below is open source unless the "Open source?" column says otherwise.

| Component | Used for | License | Open source? |
| --- | --- | --- | --- |
| [Ollama](https://github.com/ollama/ollama) | runs the LLMs and vision models | MIT | yes |
| Llama 3.2 3B, Llama 3.3 70B | fast and deep models | Llama Community License | open weights, not OSI open source |
| [LLaVA 1.6 13B](https://ollama.com/library/llava) | seeing the screen | Apache-2.0 (built on Vicuna/Llama weights) | open weights |
| [Qwen2.5-VL 7B](https://ollama.com/library/qwen2.5vl) (optional) | pixel pointing | Apache-2.0 | yes |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | speech runtime (Node addon) | Apache-2.0 | yes |
| [NVIDIA Parakeet TDT 0.6B v3/v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | speech-to-text | CC-BY-4.0 | yes (attribution) |
| [Qwen3-ASR 1.7B / 0.6B](https://github.com/QwenLM/Qwen3-ASR) and the `qwen-asr` package | speech-to-text for English, Hindi and Hinglish; base for Pip's fine-tune (official SFT script vendored in `training/third_party`) | Apache-2.0 | yes |
| IndicConformer-600M multilingual (AI4Bharat) | speech-to-text for the 22 scheduled languages | MIT | yes |
| SraVaani-1.0 (IISc / ARTPARK) | Indic speech-to-text, fine-tune base | MIT | yes |
| [Whisper large-v3 / medium](https://github.com/openai/whisper) via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Indian-accented English, language ID | MIT | yes |
| IndicWhisper ([AI4Bharat/vistaar](https://github.com/AI4Bharat/vistaar)) (optional) | Hindi speech-to-text | MIT | yes |
| Shunya Labs zero-stt-hinglish (optional) | Hinglish speech-to-text | OpenRAIL-M | open weights, use restrictions |
| Omnilingual ASR 300M (Meta) | rare languages | Apache-2.0 | yes |
| [Silero VAD](https://github.com/snakers4/silero-vad) | voice activity | MIT | yes |
| [IndicXlit](https://github.com/AI4Bharat/IndicXlit) (optional) | romanized Hinglish | MIT | yes |
| [Qwen3-8B](https://ollama.com/library/qwen3) | dictation cleanup (`pip-cleanup`) | Apache-2.0 | yes |
| [Indic Parler-TTS](https://huggingface.co/ai4bharat/indic-parler-tts) | voicing the synthetic benchmark/training set | Apache-2.0 | yes |
| [FastAPI](https://github.com/fastapi/fastapi), [uvicorn](https://github.com/encode/uvicorn), [PyTorch](https://github.com/pytorch/pytorch), [NeMo](https://github.com/NVIDIA/NeMo), [transformers](https://github.com/huggingface/transformers), [PEFT](https://github.com/huggingface/peft), [TRL](https://github.com/huggingface/trl) | speech server, training | MIT / BSD-3 / Apache-2.0 | yes |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | voice | Apache-2.0 | yes |
| [Piper](https://github.com/rhasspy/piper) voices (optional) | fast voice | MIT | yes |
| [Codex CLI](https://github.com/openai/codex) (optional) | agent runtime, as HeyClicky bundles it | Apache-2.0 | yes |
| [Cua Driver](https://github.com/trycua/cua) (optional) | background computer use | MIT | yes |
| [Hono](https://github.com/honojs/hono), [@hono/node-server](https://github.com/honojs/node-server) | backend HTTP | MIT | yes |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | connectors and desktop servers | MIT | yes |
| [sharp](https://github.com/lovell/sharp) | image crops for grounding | Apache-2.0 | yes |
| [React](https://github.com/facebook/react), [Vite](https://github.com/vitejs/vite) | Home | MIT | yes |
| [Nunito](https://github.com/googlefonts/nunito) via @fontsource | Home's font | OFL-1.1 | yes |
| [.NET](https://github.com/dotnet/runtime), [WPF](https://github.com/dotnet/wpf) | Windows client | MIT | yes |
| [NAudio](https://github.com/naudio/NAudio) | microphone and playback | MIT | yes |
| Microsoft.Web.WebView2 | Home window host | Microsoft WebView2 SDK license | no. The runtime ships with Windows; Home also works in any browser at http://127.0.0.1:8787/home/ |
| [SearXNG](https://github.com/searxng/searxng) (optional, self-hosted) | web search | AGPL-3.0 | yes |
| DuckDuckGo HTML results | default web search | web service, no key | no |

## Design references

- [farzaa/clicky](https://github.com/farzaa/clicky) (MIT, © Farza): the open-source original of HeyClicky. Pip reimplements its ideas (push-to-talk, `[POINT:x,y:label:screenN]` tags, cursor overlay, the Worker proxy routes) for Windows. No Swift code is copied.
- HeyClicky v1.0.52 (closed source): studied for architecture only (route names, the tag grammar, the Jev and Codex wiring). None of its prompts, assets or code are included.

## Datasets (training and evaluation, downloaded on your PC, not shipped)

| Dataset | Use | License |
| --- | --- | --- |
| IndicVoices, Kathbath, Shrutilipi, Svarah, Lahaja (AI4Bharat) | training (train splits) and evaluation (test splits) | CC-BY-4.0 |
| FLEURS (Google) | training and evaluation | CC-BY-4.0 |
| MUCS 2021 Hindi-English, HiACC | Hinglish | per their releases |
| DISCO | disfluency correction for the cleanup model | per its release |
