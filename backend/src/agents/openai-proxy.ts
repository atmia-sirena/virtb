// /agent/openai/v1/* — the model endpoint Codex talks to (HeyClicky's Codex
// uses its Worker's /agent/openai/v1 with wire_api = "responses"). Pip forwards
// to Ollama's OpenAI-compatible API (/v1/responses since Ollama 0.13.3), maps
// Pip model names to installed models, and strips fields local models reject.
import { environment } from "../config.js";
import { jobDefaults, isModelInstalled, refreshInstalledModels } from "../lib/models.js";

const aliasToJob: Record<string, keyof typeof jobDefaults> = {
  "pip-agent": "agent",
  "pip-deep": "deep",
  "pip-fast": "talk",
  "pip-vision": "vision",
  "pip-jev": "jev",
};

export async function mapModelName(requested: string | undefined): Promise<string> {
  const name = requested || "pip-agent";
  await refreshInstalledModels();
  if (isModelInstalled(name)) return name;
  const job = aliasToJob[name];
  if (job && isModelInstalled(jobDefaults[job].baseModel)) return jobDefaults[job].baseModel;
  // Unknown names (gpt-*) or a missing 70B: use the strongest text model that is installed.
  const fallbackChain = ["pip-agent", jobDefaults.agent.baseModel, "pip-deep", jobDefaults.deep.baseModel, "pip-fast", jobDefaults.talk.baseModel];
  return fallbackChain.find((candidate) => isModelInstalled(candidate)) ?? jobDefaults.agent.baseModel;
}

export function sanitizeRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...body };
  // Llama 3.x models aren't thinking models; Ollama errors if asked to reason.
  delete sanitized.reasoning;
  delete sanitized.include;
  delete sanitized.store;
  delete sanitized.prompt_cache_key;
  delete sanitized.service_tier;
  delete sanitized.parallel_tool_calls;
  return sanitized;
}

export async function proxyOpenAiRequest(subPath: string, request: Request): Promise<Response> {
  const target = `${environment.ollamaBaseUrl}/v1/${subPath}`;
  if (request.method === "GET") {
    const upstream = await fetch(target);
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
  }
  const body = sanitizeRequestBody((await request.json()) as Record<string, unknown>);
  body.model = await mapModelName(body.model as string | undefined);
  const upstream = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: request.signal,
  });
  const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
  if (body.stream) headers.set("cache-control", "no-cache");
  return new Response(upstream.body, { status: upstream.status, headers });
}
