// Minimal Ollama client for the native API (/api/chat), which is the only one
// that honours per-request options, keep_alive, JSON-schema formats and logprobs.
import { environment } from "../config.js";

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OllamaOptions {
  temperature?: number;
  num_ctx?: number;
  num_predict?: number;
  top_p?: number;
  stop?: string[];
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  options?: OllamaOptions;
  keep_alive?: string | number;
  format?: "json" | Record<string, unknown>;
  tools?: OllamaTool[];
  logprobs?: boolean;
  top_logprobs?: number;
  think?: boolean;
}

export interface OllamaTokenLogprob {
  token: string;
  logprob: number;
  top_logprobs?: { token: string; logprob: number }[];
}

export interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  logprobs?: OllamaTokenLogprob[];
  total_duration?: number;
  eval_count?: number;
}

export class OllamaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

function baseUrl(): string {
  return environment.ollamaBaseUrl;
}

export async function ollamaChat(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResponse> {
  const response = await fetch(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, stream: false }),
    signal,
  });
  if (!response.ok) {
    throw new OllamaError(`Ollama ${request.model} failed: ${response.status} ${await response.text()}`, response.status);
  }
  return (await response.json()) as OllamaChatResponse;
}

/** Streams assistant text deltas (and tool calls on the final chunk). */
export async function* ollamaChatStream(
  request: OllamaChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<OllamaChatResponse> {
  const response = await fetch(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new OllamaError(`Ollama ${request.model} failed: ${response.status} ${await response.text()}`, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pendingText = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pendingText += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = pendingText.indexOf("\n")) >= 0) {
      const line = pendingText.slice(0, newlineIndex).trim();
      pendingText = pendingText.slice(newlineIndex + 1);
      if (!line) continue;
      const chunk = JSON.parse(line) as OllamaChatResponse & { error?: string };
      if (chunk.error) throw new OllamaError(chunk.error);
      yield chunk;
    }
  }
  if (pendingText.trim()) yield JSON.parse(pendingText) as OllamaChatResponse;
}

export async function listInstalledModels(): Promise<string[]> {
  const response = await fetch(`${baseUrl()}/api/tags`);
  if (!response.ok) throw new OllamaError(`Ollama /api/tags failed: ${response.status}`, response.status);
  const body = (await response.json()) as { models: { name: string }[] };
  return body.models.map((model) => model.name);
}

/** Loads a model into memory without generating (empty chat), so the first real turn is fast. */
export async function warmModel(model: string, keepAlive: string | number): Promise<void> {
  await fetch(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [], keep_alive: keepAlive, stream: false }),
  });
}
