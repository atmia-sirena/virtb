// A tiny stand-in for Ollama's HTTP API so the backend can be tested without
// GPUs. Tests decide each reply from the request.
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { OllamaChatRequest, OllamaTokenLogprob, OllamaToolCall } from "../src/lib/ollama.js";

export interface FakeReply {
  content?: string;
  toolCalls?: OllamaToolCall[];
  logprobs?: OllamaTokenLogprob[];
}

export interface FakeOllama {
  url: string;
  requests: OllamaChatRequest[];
  setHandler: (handler: (request: OllamaChatRequest) => FakeReply) => void;
  close: () => Promise<void>;
}

export async function startFakeOllama(models: string[]): Promise<FakeOllama> {
  const requests: OllamaChatRequest[] = [];
  let handler: (request: OllamaChatRequest) => FakeReply = () => ({ content: "ok" });
  const app = new Hono();
  app.get("/api/tags", (context) => context.json({ models: models.map((name) => ({ name })) }));
  app.post("/api/chat", async (context) => {
    const body = (await context.req.json()) as OllamaChatRequest & { stream?: boolean };
    requests.push(body);
    if (body.messages.length === 0) return context.json({ model: body.model, message: { role: "assistant", content: "" }, done: true });
    const reply = handler(body);
    if (!body.stream) {
      return context.json({ model: body.model, message: { role: "assistant", content: reply.content ?? "", tool_calls: reply.toolCalls }, done: true, logprobs: reply.logprobs });
    }
    // Stream in small pieces, the way Ollama does, splitting lines mid-way to exercise the parsers.
    const text = reply.content ?? "";
    const pieces = text.match(/.{1,7}/gs) ?? [];
    const lines = pieces.map((piece) => JSON.stringify({ model: body.model, message: { role: "assistant", content: piece }, done: false }));
    lines.push(JSON.stringify({ model: body.model, message: { role: "assistant", content: "", tool_calls: reply.toolCalls }, done: true }));
    return new Response(lines.join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
  });
  app.post("/v1/responses", async (context) => {
    const body = await context.req.json();
    return context.json({ echoed: body });
  });
  app.get("/v1/models", (context) => context.json({ data: models.map((id) => ({ id })) }));

  let server: ServerType;
  const port: number = await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => resolve(info.port));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler: (next) => {
      handler = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Parses an SSE body into [event, data] pairs. */
export function parseSse(text: string): { event: string; data: any }[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.*)$/m)?.[1] ?? "message";
      const dataLines = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
      const raw = dataLines.join("\n");
      let data: unknown = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        // keep raw
      }
      return { event, data };
    });
}
