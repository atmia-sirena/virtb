// The dictation cleanup layer (Pip's take on Wispr Flow's formatting):
//   A. deterministic rules: commands, backtracks, fillers, spoken formatting, ₹
//   B. LLM edit ops for judgment calls (implicit corrections, context fillers,
//      punctuation for models that don't emit it), checked so no word is added
//   C. output script: romanized Hinglish
// Each stage only ever removes words, adds punctuation or changes case, so the
// typed text stays what was said.
import { resolveModel } from "../../lib/models.js";
import { ollamaChat } from "../../lib/ollama.js";
import { loadPrompt } from "../../lib/prompts.js";
import { transliterateToLatin } from "../sidecar.js";
import { runDeterministic, tidy, type DeterministicOptions } from "./deterministic.js";
import { lexiconLanguageFor, loadLexicon } from "./lexicon.js";
import { buildEditPrompt, editOpsSchema, parseEditOps, verifyAndApply } from "./llm-edit.js";
import { hasDevanagari, romanizeTokens, type Transliterator } from "./script.js";
import { detokenize, isWord, splitPhrase, tokenize, tokenizeTimed, type TimedWord, type Token } from "./tokens.js";

/** Runs the LLM with the edit prompt; returns its raw reply or undefined when no model is available. */
export type Editor = (system: string, user: string) => Promise<string | undefined>;

export interface CleanTranscriptRequest {
  text: string;
  /** Timed words from the speech model; when given they replace `text` and pauses become clause boundaries. */
  words?: TimedWord[];
  language?: string;
  script?: "native" | "roman";
  appName?: string;
  terminal?: boolean;
  dictionary?: string[];
  llmPass?: "auto" | "always" | "off";
  /** Utterances shorter than this never go to the LLM. */
  minWordsForLlm?: number;
  editor?: Editor;
  transliterate?: Transliterator;
}

export interface CleanTranscriptResult {
  text: string;
  language: string;
  applied: string[];
  llm: "skipped" | "applied" | "rejected" | "unavailable" | "failed";
  reason?: string;
}

const lowConfidence = 0.5;

/** Default editor: the cleanup model in Ollama, JSON-schema constrained, thinking off. */
export const ollamaEditor: Editor = async (system, user) => {
  const model = await resolveModel("cleanup", { num_predict: 400 });
  if (!model.available) return undefined;
  const thinks = /qwen3|cleanup|deepseek-r1|gpt-oss|magistral/i.test(model.model);
  const response = await ollamaChat({
    model: model.model,
    keep_alive: model.keepAlive,
    options: model.options,
    format: editOpsSchema as unknown as Record<string, unknown>,
    ...(thinks ? { think: false } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return response.message.content;
};

function shouldUseLlm(request: CleanTranscriptRequest, tokens: Token[], sourceTokens: Token[], needsJudgment: boolean): boolean {
  const mode = request.llmPass ?? "auto";
  if (mode === "off") return false;
  const wordCount = tokens.filter(isWord).length;
  if (wordCount < (request.minWordsForLlm ?? 4)) return false;
  if (mode === "always") return true;
  if (needsJudgment) return true;
  if (request.terminal) return false;
  // Many Indic speech models emit no punctuation at all: let the LLM place it.
  const sourceHasPunctuation = sourceTokens.some((token) => token.kind === "punct" && /[.,?!।]/.test(token.text));
  if (!sourceHasPunctuation && wordCount >= 6) return true;
  // Unsure words plus a personal dictionary: the LLM may fix a spelling.
  return (request.dictionary?.length ?? 0) > 0 && tokens.some((token) => isWord(token) && (token.conf ?? 1) < lowConfidence);
}

export async function cleanTranscript(request: CleanTranscriptRequest): Promise<CleanTranscriptResult> {
  const language = lexiconLanguageFor(request.language);
  const script = request.script ?? (language === "hinglish" ? "roman" : "native");
  const sourceTokens = request.words && request.words.length > 0 ? tokenizeTimed(request.words) : tokenize(request.text);
  const options: DeterministicOptions = { language, script, finalPunctuation: !request.terminal, casing: !request.terminal };
  const deterministic = runDeterministic(sourceTokens, options);
  const applied = [...deterministic.applied];
  let tokens = deterministic.tokens;
  let llm: CleanTranscriptResult["llm"] = "skipped";
  let reason: string | undefined;

  if (shouldUseLlm(request, tokens, sourceTokens, deterministic.needsJudgment)) {
    const lexicon = loadLexicon(language);
    const lowConfidenceWords = tokens.filter(isWord).flatMap((token, index) => ((token.conf ?? 1) < lowConfidence ? [index] : []));
    const user = buildEditPrompt({
      tokens,
      language,
      app: request.appName,
      terminal: request.terminal,
      dictionary: request.dictionary ?? [],
      contextFillers: lexicon.llmFillers.filter((filler) => splitPhrase(filler).length > 0),
      lowConfidence: lowConfidenceWords,
    });
    try {
      const reply = await (request.editor ?? ollamaEditor)(loadPrompt("dictation-cleanup"), user);
      if (reply === undefined) {
        llm = "unavailable";
      } else {
        const ops = parseEditOps(reply);
        const verified = ops ? verifyAndApply(tokens, ops, { dictionary: request.dictionary ?? [] }) : ({ ok: false, reason: "reply isn't edit JSON" } as const);
        if (verified.ok) {
          tokens = tidy(verified.tokens, options);
          applied.push(...verified.changes);
          llm = "applied";
        } else {
          llm = "rejected";
          reason = verified.reason;
        }
      }
    } catch (error) {
      llm = "failed";
      reason = (error as Error).message;
    }
  }

  if (language === "hinglish" && script === "roman" && tokens.some((token) => hasDevanagari(token.text))) {
    const romanized = await romanizeTokens(tokens, request.transliterate ?? ((words) => transliterateToLatin(words, "hi")));
    if (romanized.changed) {
      tokens = tidy(romanized.tokens, options);
      applied.push("script:roman");
    }
  }

  return { text: detokenize(tokens), language, applied, llm, ...(reason ? { reason } : {}) };
}
