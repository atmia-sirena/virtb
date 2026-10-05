// The judgment half of the cleanup layer. The LLM never writes text: it sees
// numbered words and returns edit operations (delete words, set punctuation,
// change case, replace a span with a dictionary spelling or digits). The
// verifier applies only ops that can't introduce a new word, so the output is
// faithful by construction; anything else is rejected and the deterministic
// result is kept.
import { isWord, looseKey, tokenize, type Token } from "./tokens.js";

export interface EditOps {
  /** Inclusive word-index ranges to drop: fillers, false starts, the replaced half of a self-correction. */
  delete?: [number, number][];
  /** Punctuation right after word `after`; "" removes what's there. */
  punctuation?: { after: number; mark: string }[];
  capitalize?: number[];
  lowercase?: number[];
  /** A word span written differently: a DICTIONARY spelling, digits for number words, or a joined word ("e mail" -> "email"). */
  replace?: { from: number; to: number; with: string }[];
}

export interface EditContext {
  dictionary: string[];
  /** Share of words the LLM may delete in one utterance. */
  maxDeleteShare?: number;
}

export type VerifyResult = { ok: true; tokens: Token[]; changes: string[] } | { ok: false; reason: string };

export const allowedMarks = new Set(["", ",", ".", "?", "!", ":", ";", "।"]);

/** JSON schema for Ollama's structured output. */
export const editOpsSchema = {
  type: "object",
  properties: {
    delete: { type: "array", items: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 } },
    punctuation: {
      type: "array",
      items: { type: "object", properties: { after: { type: "integer" }, mark: { type: "string", enum: [...allowedMarks] } }, required: ["after", "mark"] },
    },
    capitalize: { type: "array", items: { type: "integer" } },
    lowercase: { type: "array", items: { type: "integer" } },
    replace: {
      type: "array",
      items: { type: "object", properties: { from: { type: "integer" }, to: { type: "integer" }, with: { type: "string" } }, required: ["from", "to", "with"] },
    },
  },
} as const;

/** "[0]kal [1]meeting [2]5 [3]baje, [4]actually ..." Words are numbered; punctuation stays attached. */
export function renderNumbered(tokens: Token[]): string {
  let output = "";
  let wordIndex = 0;
  for (const token of tokens) {
    if (token.kind === "newline") output += token.text === "\n" ? " ⏎ " : " ⏎⏎ ";
    else if (token.kind === "punct") output += token.text;
    else {
      output += `${output && !output.endsWith(" ") ? " " : ""}[${wordIndex}]${token.text}`;
      wordIndex += 1;
    }
  }
  return output.trim();
}

/** Positions of word tokens, so word index -> token index. */
function wordPositions(tokens: Token[]): number[] {
  return tokens.flatMap((token, index) => (isWord(token) ? [index] : []));
}

// --- number words ("twenty five thousand" -> 25000) ---------------------------

const units: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const scales: Record<string, number> = { hundred: 100, thousand: 1_000, lakh: 1_00_000, lakhs: 1_00_000, lac: 1_00_000, crore: 1_00_00_000, crores: 1_00_00_000, million: 1_000_000, billion: 1_000_000_000 };

export function parseNumberWords(words: string[]): number | undefined {
  if (words.length === 0) return undefined;
  let total = 0;
  let current = 0;
  let sawAny = false;
  for (const raw of words) {
    const word = looseKey(raw).replace(/-/g, " ");
    for (const part of word.split(" ")) {
      if (part === "and" && sawAny) continue;
      if (/^\d+$/.test(part)) {
        current += Number(part);
      } else if (part in units) {
        current += units[part];
      } else if (part === "hundred") {
        current = (current || 1) * 100;
      } else if (part in scales) {
        total += (current || 1) * scales[part];
        current = 0;
      } else {
        return undefined;
      }
      sawAny = true;
    }
  }
  return sawAny ? total + current : undefined;
}

function digitsOf(text: string): string {
  return text.replace(/[,\s]/g, "");
}

// --- similarity for dictionary spellings --------------------------------------

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

const lettersOnly = (text: string) => looseKey(text).replace(/[^\p{L}\p{M}\p{N}]/gu, "");

/** Is `replacement` an allowed rewrite of `spanWords`? Never a new word. */
export function replacementAllowed(spanWords: string[], replacement: string, dictionary: string[]): boolean {
  const spanLetters = lettersOnly(spanWords.join(""));
  const replacementLetters = lettersOnly(replacement);
  if (!replacementLetters) return false;
  // Same letters, different spacing/case: "e mail" -> "email", "whats app" -> "WhatsApp".
  if (spanLetters === replacementLetters) return true;
  // Digits for number words: "twenty five" -> "25", "5 lakh" -> "5,00,000", "ten percent" -> "10%".
  const percent = looseKey(spanWords.at(-1) ?? "") === "percent" && replacement.trim().endsWith("%");
  const numberSpan = percent ? spanWords.slice(0, -1) : spanWords;
  const value = parseNumberWords(numberSpan);
  if (value !== undefined && /^\d[\d,]*%?$/.test(replacement.trim()) && Number(digitsOf(replacement.replace("%", ""))) === value) return true;
  // A personal-dictionary spelling of what was heard ("cloudy" -> "Clicky"), only when close.
  if (spanWords.length <= 3) {
    const entry = dictionary.find((word) => lettersOnly(word) === replacementLetters);
    if (entry) {
      const distance = editDistance(spanLetters, replacementLetters);
      if (distance <= Math.max(2, Math.ceil(Math.max(spanLetters.length, replacementLetters.length) * 0.5))) return true;
    }
  }
  return false;
}

// --- verify and apply ---------------------------------------------------------

export function verifyAndApply(tokens: Token[], ops: EditOps, context: EditContext): VerifyResult {
  const positions = wordPositions(tokens);
  const wordCount = positions.length;
  const inRange = (index: unknown): index is number => Number.isInteger(index) && (index as number) >= 0 && (index as number) < wordCount;
  const changes: string[] = [];

  // Word-level plan: deleted words, replacements, case, punctuation after.
  const deleted = new Set<number>();
  for (const range of ops.delete ?? []) {
    if (!Array.isArray(range) || range.length !== 2 || !inRange(range[0]) || !inRange(range[1]) || range[0] > range[1]) return { ok: false, reason: `bad delete range ${JSON.stringify(range)}` };
    for (let index = range[0]; index <= range[1]; index += 1) deleted.add(index);
  }
  const maxDelete = Math.max(2, Math.ceil(wordCount * (context.maxDeleteShare ?? 0.5)));
  if (deleted.size > maxDelete) return { ok: false, reason: `deletes ${deleted.size} of ${wordCount} words` };
  if (deleted.size === wordCount) return { ok: false, reason: "deletes everything" };

  const replacements = new Map<number, { to: number; with: string }>();
  for (const replace of ops.replace ?? []) {
    if (!inRange(replace?.from) || !inRange(replace?.to) || replace.from > replace.to || typeof replace.with !== "string") return { ok: false, reason: "bad replace" };
    if (replace.to - replace.from > 5) return { ok: false, reason: "replace span too long" };
    for (let index = replace.from; index <= replace.to; index += 1) {
      if (deleted.has(index)) return { ok: false, reason: "replace overlaps delete" };
      if ([...replacements.entries()].some(([from, value]) => index >= from && index <= value.to)) return { ok: false, reason: "overlapping replace" };
    }
    const spanWords = positions.slice(replace.from, replace.to + 1).map((position) => tokens[position].text);
    if (!replacementAllowed(spanWords, replace.with, context.dictionary)) return { ok: false, reason: `replacement "${spanWords.join(" ")}" -> "${replace.with}" would add a word` };
    replacements.set(replace.from, { to: replace.to, with: replace.with.trim() });
  }

  const punctuationAfter = new Map<number, string>();
  for (const entry of ops.punctuation ?? []) {
    if (!inRange(entry?.after) || typeof entry.mark !== "string" || !allowedMarks.has(entry.mark)) return { ok: false, reason: `bad punctuation ${JSON.stringify(entry)}` };
    punctuationAfter.set(entry.after, entry.mark);
  }
  const caseChange = new Map<number, "upper" | "lower">();
  for (const index of ops.capitalize ?? []) {
    if (!inRange(index)) return { ok: false, reason: "bad capitalize index" };
    caseChange.set(index, "upper");
  }
  for (const index of ops.lowercase ?? []) {
    if (!inRange(index)) return { ok: false, reason: "bad lowercase index" };
    caseChange.set(index, "lower");
  }

  // Rebuild the token list.
  const output: Token[] = [];
  let wordIndex = -1;
  let replacedThrough = -1;
  for (const token of tokens) {
    if (token.kind !== "word") {
      if (token.kind === "punct" && wordIndex >= 0) {
        // Punctuation between two deleted words, or inside a replaced span, goes with them.
        if (deleted.has(wordIndex) && deleted.has(wordIndex + 1)) continue;
        if (wordIndex < replacedThrough) continue;
        // An explicit punctuation op replaces the soft punctuation after its word.
        const unitEnd = Math.max(wordIndex, replacedThrough);
        if (unitEnd === wordIndex && punctuationAfter.has(wordIndex) && !deleted.has(wordIndex) && !["(", ")", "-", "₹"].includes(token.text)) continue;
      }
      output.push(token);
      continue;
    }
    wordIndex += 1;
    if (wordIndex <= replacedThrough) continue;
    if (deleted.has(wordIndex)) {
      changes.push(`llm:delete:${token.text}`);
      continue;
    }
    const replacement = replacements.get(wordIndex);
    let unitEnd = wordIndex;
    if (replacement) {
      output.push(...tokenize(replacement.with).map((piece, index) => (index === 0 ? { ...piece, pauseBefore: token.pauseBefore } : piece)));
      changes.push(`llm:replace:${replacement.with}`);
      replacedThrough = replacement.to;
      unitEnd = replacement.to;
    } else {
      const change = caseChange.get(wordIndex);
      let text = token.text;
      if (change === "upper") text = text.charAt(0).toUpperCase() + text.slice(1);
      if (change === "lower") text = text.charAt(0).toLowerCase() + text.slice(1);
      if (text !== token.text) changes.push(`llm:case:${text}`);
      output.push({ ...token, text });
    }
    const mark = punctuationAfter.get(unitEnd);
    if (mark !== undefined) {
      if (mark) output.push({ text: mark, kind: "punct" });
      changes.push(`llm:punct:${mark || "none"}`);
    }
  }

  // Final guard: every output word is an input word, or an allowed replacement.
  const inputWords = new Set(tokens.filter(isWord).map((token) => looseKey(token.text)));
  const replacementWords = new Set([...replacements.values()].flatMap((value) => tokenize(value.with).filter(isWord).map((token) => looseKey(token.text))));
  for (const token of output) {
    if (isWord(token) && !inputWords.has(looseKey(token.text)) && !replacementWords.has(looseKey(token.text))) return { ok: false, reason: `new word "${token.text}"` };
  }
  return { ok: true, tokens: output, changes };
}

/** Parse the model's reply; tolerate a code fence or prose around the JSON object. */
export function parseEditOps(reply: string): EditOps | undefined {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(reply.slice(start, end + 1)) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as EditOps) : undefined;
  } catch {
    return undefined;
  }
}

const languageNames: Record<string, string> = {
  en: "English (Indian English)",
  hi: "Hindi in Devanagari",
  hinglish: "Hinglish: Hindi-English code-switched speech",
  ta: "Tamil",
  te: "Telugu",
  pa: "Punjabi in Gurmukhi",
  bn: "Bengali",
  mr: "Marathi",
  gu: "Gujarati",
  kn: "Kannada",
  ml: "Malayalam",
  ur: "Urdu",
};

export function describeLanguage(language: string): string {
  return languageNames[language] ?? language;
}

export interface EditPromptInput {
  tokens: Token[];
  language: string;
  app?: string;
  terminal?: boolean;
  dictionary: string[];
  contextFillers: string[];
  /** Word indices the speech model was unsure about. */
  lowConfidence?: number[];
}

export function buildEditPrompt(input: EditPromptInput): string {
  const lines = [
    `LANGUAGE: ${describeLanguage(input.language)}`,
    `APP: ${input.app ?? "unknown"}${input.terminal ? " (a terminal: no punctuation inside commands)" : ""}`,
  ];
  if (input.dictionary.length > 0) lines.push(`DICTIONARY: ${input.dictionary.slice(-200).join(", ")}`);
  if (input.contextFillers.length > 0) lines.push(`MAYBE FILLERS (delete only when they carry no meaning): ${input.contextFillers.join(", ")}`);
  if (input.lowConfidence && input.lowConfidence.length > 0) lines.push(`UNSURE WORDS: ${input.lowConfidence.join(", ")}`);
  lines.push(`WORDS: ${renderNumbered(input.tokens)}`);
  return lines.join("\n");
}
