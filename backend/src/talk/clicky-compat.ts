// Clicky-compatible /chat: the open-source Mac app (farzaa/clicky) posts an
// Anthropic Messages request and reads Anthropic SSE back. Pip answers it with
// the local models so the Mac fork works by just changing its Worker URL.
import { resolveModel } from "../lib/models.js";
import { ollamaChat, ollamaChatStream, type OllamaMessage } from "../lib/ollama.js";
import { loadPrompt, wrapUntrusted } from "../lib/prompts.js";

type AnthropicContent = string | ({ type: "text"; text: string } | { type: "image"; source: { data: string; media_type?: string } })[];

export interface AnthropicRequest {
  system?: string | { type: "text"; text: string }[];
  messages: { role: "user" | "assistant"; content: AnthropicContent }[];
  max_tokens?: number;
  stream?: boolean;
}

async function describeImages(images: string[]): Promise<string> {
  if (images.length === 0) return "";
  const model = await resolveModel("vision");
  if (!model.available) return "";
  const descriptions: string[] = [];
  for (const [index, image] of images.entries()) {
    const response = await ollamaChat({
      model: model.model,
      keep_alive: model.keepAlive,
      options: model.options,
      messages: [{ role: "user", content: loadPrompt("vision-describe"), images: [image] }],
    });
    descriptions.push(`screen${index}: ${response.message.content.trim()}`);
  }
  return descriptions.join("\n\n");
}

export async function toOllamaMessages(request: AnthropicRequest): Promise<OllamaMessage[]> {
  const systemText = typeof request.system === "string" ? request.system : (request.system ?? []).map((part) => part.text).join("\n");
  const messages: OllamaMessage[] = systemText ? [{ role: "system", content: systemText }] : [];
  for (const [messageIndex, message] of request.messages.entries()) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    const text = message.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n");
    const images = message.content.filter((part) => part.type === "image").map((part) => (part as { source: { data: string } }).source.data);
    // Only the newest message's screenshots are described; older ones are history.
    const isLast = messageIndex === request.messages.length - 1;
    const screenNotes = isLast ? await describeImages(images) : "";
    messages.push({ role: message.role, content: screenNotes ? `${wrapUntrusted("screen", screenNotes)}\n\n${text}` : text });
  }
  return messages;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function clickyChat(request: AnthropicRequest): Promise<Response> {
  const model = await resolveModel("talk", { num_predict: request.max_tokens ?? 600 });
  const messages = await toOllamaMessages(request);
  const messageId = `msg_pip_${Date.now()}`;
  if (!request.stream) {
    const response = await ollamaChat({ model: model.model, keep_alive: model.keepAlive, options: model.options, messages });
    return Response.json({
      id: messageId,
      type: "message",
      role: "assistant",
      model: model.model,
      content: [{ type: "text", text: response.message.content }],
      stop_reason: "end_turn",
    });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(sse("message_start", { type: "message_start", message: { id: messageId, type: "message", role: "assistant", model: model.model, content: [] } })));
      controller.enqueue(encoder.encode(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })));
      try {
        for await (const chunk of ollamaChatStream({ model: model.model, keep_alive: model.keepAlive, options: model.options, messages })) {
          const text = chunk.message?.content ?? "";
          if (text) controller.enqueue(encoder.encode(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })));
        }
      } catch (error) {
        controller.enqueue(encoder.encode(sse("error", { type: "error", error: { type: "api_error", message: (error as Error).message } })));
      }
      controller.enqueue(encoder.encode(sse("content_block_stop", { type: "content_block_stop", index: 0 })));
      controller.enqueue(encoder.encode(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } })));
      controller.enqueue(encoder.encode(sse("message_stop", { type: "message_stop" })));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
