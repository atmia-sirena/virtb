# Pip

A personal, local clone of [HeyClicky](https://www.heyclicky.com) for Windows: a voice-first AI buddy next to your cursor. It sees your screen when you hold a hotkey, answers out loud, points and draws on screen, walks you through tasks step by step, dictates into any app, and runs background agents.

Every model runs on your PC: Ollama for thinking and seeing, sherpa-onnx for listening and talking. There are no accounts, no API keys, and no cloud AI.

| You do | Pip does |
| --- | --- |
| Hold **Ctrl + Win** and talk | Looks at your screen, answers out loud, and points at things or draws on screen |
| Say "walk me through…" | Gives one step at a time and waits for you to click each target (up to 15 steps) |
| Hold **Right Ctrl** and talk | Types what you said into the app you're in, cleaned up (double-tap for hands-free) |
| Double-tap **Left Ctrl** | Opens a text box by the cursor; the reply streams in and is read aloud |
| Say "research… / make me… / every morning…" | Starts a background agent (Codex or the built-in loop) that reports back |
| Hover the pill at the top of the screen | Shows all your agents; click to open Home (chat, files, routines, settings) |

## How it's built

HeyClicky's architecture, verified from the shipped v1.0.52 app bundle, with every cloud model swapped for a local one:

- **Windows client** (`clients/windows`): C# / .NET 8 with WPF. It uses low-level keyboard hooks, GDI capture excluded from its own overlays, UI Automation, WASAPI audio (NAudio), click-through overlays and WebView2 for Home.
- **Backend** (`backend`): the same thin TypeScript "Worker" design, built with Hono on Node, on `127.0.0.1:8787`. It uses HeyClicky's route names (`/v2/chat`, `/v2/dictation/cleanup`, `/agent/jev/systemone`, `/agent/openai/v1`, …).
- **Home** (`home-web`): React, loaded in the client's WebView2 window.
- **Models** (all local):

| Job | Model | Runs in |
| --- | --- | --- |
| Router, quick answers, walkthrough steps, dictation cleanup, memory | `llama3.2:3b` | Ollama |
| Jev (picks the next click for agents) | `llama3.2:3b` | Ollama |
| Seeing the screen | `llava:13b` (`qwen2.5vl:7b` optional, for pixel pointing) | Ollama |
| Deep answers and agents | `llama3.3:70b` | Ollama |
| Speech-to-text | NVIDIA Parakeet TDT 0.6B v3 | sherpa-onnx, in the backend |
| Text-to-speech | Kokoro-82M (Piper optional) | sherpa-onnx, in the backend |
| Background computer use | Cua Driver | local MCP server |

The full plan, research and stack comparison are in the build-plan doc; `docs/BUILD.md` covers setup.

## Quick start (Windows 10 22H2+ / 11)

```powershell
# prerequisites: Node 20+, .NET 8 SDK, Ollama with llama3.2:3b, llava:13b, llama3.3:70b pulled
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

## Develop and test

```bash
cd backend && npm test          # 38 tests; runs the real speech models when downloaded
cd home-web && npm run build
cd clients/windows && dotnet test Pip.Core.Tests && dotnet build Pip.BuildCheck   # builds on Linux/macOS too
```
