// HeyClicky's "little router": on every turn a cheap model decides whether a
// fast model can answer or a frontier model should. Pip adds the other
// intents its voice brain handles with tools (spawn an agent, guide, draft,
// remember, change settings). Obvious phrasings are routed by rule in
// microseconds; everything else goes to llama3.2:3b with a JSON schema.
import { resolveModel } from "../lib/models.js";
import { ollamaChat } from "../lib/ollama.js";
import { loadPrompt } from "../lib/prompts.js";

export const routes = ["quick", "deep", "guide", "agent", "draft", "memory", "settings"] as const;
export type Route = (typeof routes)[number];

export interface RouteDecision {
  route: Route;
  reason: string;
  by: "rule" | "model" | "fallback";
}

const ruleTable: { route: Route; pattern: RegExp }[] = [
  { route: "memory", pattern: /^(please\s+)?(remember|don'?t forget|note) (that|this|my)\b|^my name is\b|^call me\b/i },
  { route: "settings", pattern: /\b(talk|speak) (slower|faster|more slowly|quicker)\b|\b(change|switch) (your|the) voice\b|\b(turn|switch) (off|on) (the )?(buddy|cursor|announcements|dictation cleanup)\b|\bslow down\b.*\b(voice|talking)\b/i },
  { route: "guide", pattern: /\b(walk me through|show me how|step by step|teach me how|guide me|help me (set up|find|do|get))\b/i },
  { route: "draft", pattern: /\b(reply to (this|him|her|them)|write (a |an )?(reply|response|email|message) (to|saying|for)|type (a |an )?(reply|response|message)|draft (a |an )?(reply|response|email))\b/i },
  { route: "agent", pattern: /\b(in the background|for me while|go (and )?(research|find|build)|every (morning|day|hour|week|monday)|make me a (spreadsheet|doc|report|website|pdf)|research (the|a|about|who|what)|book (a|me)|send (an? )?(email|message) to|put (this|it) in (my )?(notion|sheet|calendar))\b/i },
  { route: "deep", pattern: /\b(think (hard|carefully|deeply)|look closer|in depth|detailed|compare|review (this|my) code|the whole (document|file|page|pdf)|summari[sz]e (this|the) (document|pdf|paper|article))\b/i },
];

export function routeByRule(transcript: string): RouteDecision | undefined {
  const text = transcript.trim();
  for (const rule of ruleTable) {
    if (rule.pattern.test(text)) return { route: rule.route, reason: "matched phrasing", by: "rule" };
  }
  // Very short questions are almost always quick.
  if (text.split(/\s+/).length <= 6 && /\?$|^(what|where|who|how|why|which|is|can|does|do)\b/i.test(text)) {
    return { route: "quick", reason: "short question", by: "rule" };
  }
  return undefined;
}

export async function routeTurn(transcript: string, activeAppName?: string): Promise<RouteDecision> {
  const ruled = routeByRule(transcript);
  if (ruled) return ruled;
  const model = await resolveModel("router");
  if (!model.available) return { route: "quick", reason: "router model missing", by: "fallback" };
  try {
    const response = await ollamaChat({
      model: model.model,
      keep_alive: model.keepAlive,
      options: model.options,
      format: {
        type: "object",
        properties: { route: { type: "string", enum: [...routes] }, reason: { type: "string" } },
        required: ["route", "reason"],
      },
      messages: [
        { role: "system", content: loadPrompt("router") },
        { role: "user", content: `active app: ${activeAppName ?? "unknown"}\nrequest: ${transcript}` },
      ],
    });
    const parsed = JSON.parse(response.message.content) as { route: Route; reason: string };
    if (!routes.includes(parsed.route)) return { route: "quick", reason: "invalid route", by: "fallback" };
    return { route: parsed.route, reason: parsed.reason ?? "", by: "model" };
  } catch (error) {
    console.warn("[router] failed, answering quick:", (error as Error).message);
    return { route: "quick", reason: "router error", by: "fallback" };
  }
}
