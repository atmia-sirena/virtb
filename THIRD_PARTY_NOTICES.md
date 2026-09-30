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
