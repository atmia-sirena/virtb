# Building and running Pip

## What you need

| Tool | Why | Get it |
| --- | --- | --- |
| Windows 10 22H2+ or 11 | the client | — |
| Ollama | runs the LLMs and vision model | https://ollama.com |
| `llama3.2:3b`, `llava:13b`, `llama3.3:70b` | fast, vision and deep models | `ollama pull <name>` |
| Node.js 20+ | backend, Home, Codex | `winget install OpenJS.NodeJS.LTS` |
| .NET 8 SDK | the Windows client | `winget install Microsoft.DotNet.SDK.8` |
| WebView2 Runtime | the Home window | ships with Windows 11 and updated Windows 10 |
| Codex CLI (optional) | agents, as HeyClicky bundles it | `npm i -g @openai/codex` |
| Cua Driver (optional) | agents using apps in the background | `irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 \| iex` |
| `qwen2.5vl:7b` (optional) | precise pointing in apps with no UI tree | `ollama pull qwen2.5vl:7b` |
| `qwen3:8b` | dictation cleanup in Indian languages (setup pulls it) | `ollama pull qwen3:8b` |
| NVIDIA GPU + [uv](https://docs.astral.sh/uv/) | the speech server for Hindi, Hinglish, Tamil, Telugu, Punjabi and more | setup installs uv; driver from NVIDIA |

## One-time setup

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

It does six things:

1. Creates `pip-fast`, `pip-jev`, `pip-cleanup`, `pip-vision`, `pip-deep` and `pip-agent` in Ollama (`scripts/modelfiles`), pulling `qwen3:8b` for cleanup. It also sets Ollama's server options as user environment variables. **Restart Ollama afterwards.**
2. Builds the backend and downloads the CPU speech models (Parakeet v3 ~490 MB, Kokoro v1.0 ~135 MB) into `%APPDATA%\Pip\models`.
3. With an NVIDIA GPU, it sets up the speech server:
   - `uv sync` (PyTorch for CUDA 12.8, faster-whisper, sherpa-onnx, Qwen3-ASR);
   - downloads Qwen3-ASR, IndicConformer, Whisper large-v3 and Omnilingual (~12 GB);
   - sets `PIP_SPEECH_SERVER` so the backend starts it.

   Skip this step with `-SkipSpeechServer`.
4. Builds Home.
5. Offers to install Codex CLI and Cua Driver.
6. Builds `clients\windows\Pip`.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

The client starts the backend, and the backend stops when you quit Pip (quit from the pill's hover panel). The first launch plays a short spoken tour.

| Default shortcut | What it does |
| --- | --- |
| hold Ctrl + Win | talk to Pip about your screen |
| hold Right Ctrl | dictate into any app; double-tap for hands-free, Esc to cancel |
| double-tap Left Ctrl | text box |
| double-tap Right Shift | switch dictation language (re-hears what you just said; remembered per app) |
| Esc | stop talking, cancel dictation, stop a walkthrough |

Change them in Home → Settings → Shortcuts.

## Where things live

`%APPDATA%\Pip\` holds all state; there is no database.

| Path | Contents |
| --- | --- |
| `settings.json` | settings |
| `memory\PROFILE.md`, `memory\VOLATILE.md` | memory |
| `conversation.jsonl` | the last talk turns |
| `agents\<id>\` | each agent's `agent.json`, `chat.jsonl` and `workspace\` (its `AGENTS.md`, `output\`, `tmp\`) |
| `routines.json`, `connectors.json` | routines and connectors |
| `codex\` | `CODEX_HOME`, written on every agent launch |
| `models\` | speech models (CPU ones, the speech server's, and your fine-tunes) |
| `speech-routing.json` | which model handles which language, written by the eval bake-off (overrides `speech-server/routing.json`) |
| `eval\personal\` | your recorded test clips (Home → Settings → Languages) |
| `pip-client.log`, `dictation-backup.txt` | logs and dictation backups |

Screenshots are never written to disk.

## Configuration

`backend\.env` is optional; see `backend\.env.example`. No API keys are used anywhere. Optional settings:

- `PIP_SEARXNG_URL`: a self-hosted SearXNG for web search. The default is DuckDuckGo, with no key.
- `PIP_MODELS_DIR`: where the speech models live.
- `PIP_SPEECH_SERVER`: the `speech-server` folder (set by setup). `off` disables it.
- `PIP_SPEECH_SERVER_URL`: where it listens (default `http://127.0.0.1:8790`).
- `PIP_CUA_DRIVER`: the path to Cua Driver.
- `PIP_CODEX_PATH`: the path to Codex CLI.

## Tests

```bash
cd backend && npm test                                   # routing, tags, vision prefetch, walkthroughs, agents, Jev, MCP servers, speech
cd clients/windows && dotnet test Pip.Core.Tests         # hotkeys, multi-monitor/mixed-DPI mapping, shapes, text rules
cd clients/windows && dotnet build Pip.BuildCheck        # compiles the whole WPF client on any OS
cd speech-server && uv run pytest                        # routing, language ID, sessions, with fake engines
cd eval && uv run pytest                                 # benchmark metrics and bake-off logic
cd training && uv run pytest                             # data mix, edit-op derivation, ship rule
```

The speech test runs the real Parakeet and Kokoro models when they're downloaded (or `PIP_MODELS_DIR` points at them).

## Indian languages

Pick your languages in Home → Settings → Languages.

| Setting | Default |
| --- | --- |
| Hinglish | typed in Latin letters ("kal meeting 5 baje hai") |
| Hindi, Tamil, Telugu, Punjabi | native script; Hindi can be switched to Latin |

How well each language works depends on which models are installed and how they score on your audio:

1. Run the bake-off (`eval/README.md`). It ranks every installed model per language and writes `speech-routing.json`.
2. Record 50+ clips per language in Home, so the numbers reflect your voice and your mic.
3. Fine-tune (`training/README.md`) when a language misses its target.

Without a GPU, dictation stays on Parakeet (CPU), which covers English and European languages only.

## Known limits in build 1

- **70B speed.** `llama3.3:70b` needs roughly 40 GB+ of GPU memory to answer at conversational speed. With less, keep it for agents and "look closer" questions; everything interactive runs on the 3B model and llava.
- **Voice latency.** Kokoro runs on the CPU. On a modern 8-core CPU a sentence starts in about 0.3 s. On slower machines, switch to Piper (Settings → Models) after `npm run setup:speech -- piper-amy`.
- **Admin windows.** Windows can't be read or typed into from a normal process; Pip says so out loud.
- **Agent tool calls.** Codex tool calls through Ollama can be flaky with local models. Pip falls back to its built-in agent loop automatically.
