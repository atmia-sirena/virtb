// Jev, locally. HeyClicky's agents hand single-window clicking to "TypeSafe
// Jev" (/agent/jev/systemone, ~250 ms a step): given one window's interactive
// elements and a goal, it picks one candidate id and returns a confidence, the
// full probabilities, and independent done/blocked readings. It never writes
// text. Pip runs the same contract on llama3.2:3b: the answer is constrained
// to numbered candidates by a JSON schema, and probabilities come from the
// token logprobs at the position where the model writes the number.
import { resolveModel } from "../lib/models.js";
import { ollamaChat, type OllamaTokenLogprob } from "../lib/ollama.js";
import { loadPrompt, wrapUntrusted } from "../lib/prompts.js";

export interface ChoiceQuestion {
  instructions: string;
  /** candidate id -> description */
  criteria: Record<string, string>;
}

export interface SystemOneRequest {
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
}

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  done: boolean;
  blocked: boolean;
}

export interface SystemOneResponse {
  choices: Record<string, ChoiceAnswer>;
  model: string;
  elapsed_ms: number;
}

const maxCandidates = 64;

/**
 * Converts the logprobs at the choice position into a normalized probability
 * per candidate. Labels are the numbers "1".."N", which Llama 3's tokenizer
 * keeps as single tokens for values under 1000.
 */
export function probabilitiesFromLogprobs(
  logprobs: OllamaTokenLogprob[] | undefined,
  labelToId: Map<string, string>,
  chosenLabel: string,
): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (const candidateId of labelToId.values()) probabilities[candidateId] = 0;
  const chosenId = labelToId.get(chosenLabel);
  if (!logprobs || logprobs.length === 0) {
    if (chosenId) probabilities[chosenId] = 1;
    return probabilities;
  }
  // Find the token that carries the chosen label (the first token after `"choice":"`).
  const position = logprobs.findIndex((entry, index) => {
    const precedingText = logprobs.slice(Math.max(0, index - 4), index).map((previous) => previous.token).join("");
    return entry.token.trim() === chosenLabel && /choice"\s*:\s*"?\s*$/.test(precedingText);
  });
  const entry = position >= 0 ? logprobs[position] : logprobs.find((candidate) => candidate.token.trim() === chosenLabel);
  const alternatives = entry?.top_logprobs ?? (entry ? [{ token: entry.token, logprob: entry.logprob }] : []);
  let total = 0;
  for (const alternative of alternatives) {
    const candidateId = labelToId.get(alternative.token.trim());
    if (!candidateId) continue;
    const probability = Math.exp(alternative.logprob);
    probabilities[candidateId] = Math.max(probabilities[candidateId], probability);
  }
  for (const value of Object.values(probabilities)) total += value;
  if (total <= 0) {
    if (chosenId) probabilities[chosenId] = 1;
    return probabilities;
  }
  for (const key of Object.keys(probabilities)) probabilities[key] = probabilities[key] / total;
  return probabilities;
}

async function answerQuestion(state: Record<string, unknown>, question: ChoiceQuestion): Promise<ChoiceAnswer & { model: string }> {
  const candidateIds = Object.keys(question.criteria).slice(0, maxCandidates);
  if (candidateIds.length === 0) throw new Error("question has no candidates");
  const labelToId = new Map(candidateIds.map((candidateId, index) => [String(index + 1), candidateId]));
  const candidateLines = candidateIds.map((candidateId, index) => `${index + 1}. ${candidateId}: ${question.criteria[candidateId]}`).join("\n");
  const model = await resolveModel("jev");
  if (!model.available) throw new Error(`jev model ${model.model} is not installed`);
  const response = await ollamaChat({
    model: model.model,
    keep_alive: model.keepAlive,
    options: model.options,
    logprobs: true,
    top_logprobs: 20,
    format: {
      type: "object",
      properties: {
        choice: { type: "string", enum: [...labelToId.keys()] },
        done: { type: "boolean" },
        blocked: { type: "boolean" },
      },
      required: ["choice", "done", "blocked"],
    },
    messages: [
      { role: "system", content: loadPrompt("jev") },
      {
        role: "user",
        content: `GOAL: ${question.instructions}\n\nSTATE:\n${wrapUntrusted("window", JSON.stringify(state).slice(0, 12000))}\n\nCANDIDATES:\n${candidateLines}\n\nreply as json {"choice": "<number>", "done": true|false, "blocked": true|false}`,
      },
    ],
  });
  const parsed = JSON.parse(response.message.content) as { choice: string; done: boolean; blocked: boolean };
  const chosenId = labelToId.get(String(parsed.choice).trim());
  if (!chosenId) throw new Error(`jev chose an unknown candidate: ${parsed.choice}`);
  const probabilities = probabilitiesFromLogprobs(response.logprobs, labelToId, String(parsed.choice).trim());
  return { choice: chosenId, confidence: probabilities[chosenId] ?? 0, probabilities, done: Boolean(parsed.done), blocked: Boolean(parsed.blocked), model: model.model };
}

export async function systemOne(request: SystemOneRequest): Promise<SystemOneResponse> {
  const startedAt = Date.now();
  const entries = await Promise.all(Object.entries(request.questions).map(async ([name, question]) => [name, await answerQuestion(request.state, question)] as const));
  const choices: Record<string, ChoiceAnswer> = {};
  let modelName = "";
  for (const [name, answer] of entries) {
    const { model, ...rest } = answer;
    choices[name] = rest;
    modelName = model;
  }
  return { choices, model: modelName, elapsed_ms: Date.now() - startedAt };
}
