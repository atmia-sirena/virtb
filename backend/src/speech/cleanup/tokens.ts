// Tokens for the cleanup layer: words and punctuation with optional timing
// from the speech model, so commands and restarts can use pauses as clause
// boundaries. Works across Latin, Devanagari, Tamil, Telugu and Gurmukhi.

export interface TimedWord {
  w: string;
  start?: number;
  end?: number;
  conf?: number;
}

export interface Token {
  text: string;
  kind: "word" | "punct" | "newline";
  /** Seconds of silence before this token, when the speech model gave timestamps. */
  pauseBefore?: number;
  conf?: number;
}

const tokenPattern = /\n+|[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’@._+\-/:]*[\p{L}\p{M}\p{N}]|[\p{L}\p{M}\p{N}]|[^\s\p{L}\p{M}\p{N}]/gu;

export const sentenceEnders = new Set([".", "?", "!", "।", "॥"]);
const noSpaceBefore = new Set([".", ",", "?", "!", ":", ";", ")", "]", "।", "॥", "%"]);
const noSpaceAfter = new Set(["(", "[", "₹", "@", "#"]);

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.normalize("NFC").matchAll(tokenPattern)) {
    const value = match[0];
    if (value.startsWith("\n")) tokens.push({ text: value.length > 1 ? "\n\n" : "\n", kind: "newline" });
    else if (/^[\p{L}\p{M}\p{N}]/u.test(value)) tokens.push({ text: value, kind: "word" });
    else tokens.push({ text: value, kind: "punct" });
  }
  return tokens;
}

/** Tokens from timed words (speech-server output), keeping pauses between words. */
export function tokenizeTimed(words: TimedWord[]): Token[] {
  const tokens: Token[] = [];
  let previousEnd: number | undefined;
  for (const word of words) {
    const pieces = tokenize(word.w);
    const pause = word.start !== undefined && previousEnd !== undefined ? Math.max(0, word.start - previousEnd) : undefined;
    pieces.forEach((piece, index) => {
      if (index === 0 && pause !== undefined) piece.pauseBefore = pause;
      if (word.conf !== undefined) piece.conf = word.conf;
      tokens.push(piece);
    });
    if (word.end !== undefined) previousEnd = word.end;
  }
  return tokens;
}

export function detokenize(tokens: Token[]): string {
  let output = "";
  for (const [index, token] of tokens.entries()) {
    if (token.kind === "newline") {
      output = output.replace(/[ \t]+$/, "") + token.text;
      continue;
    }
    const previous = tokens[index - 1];
    const needsSpace = output.length > 0 && !output.endsWith("\n") && !noSpaceBefore.has(token.text) && !(previous && noSpaceAfter.has(previous.text));
    output += (needsSpace ? " " : "") + token.text;
  }
  return output.replace(/[ \t]+\n/g, "\n").trim();
}

/** A comparison key that ignores case, nukta, chandrabindu/anusvara spelling and joiners. */
export function looseKey(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‌‍]/g, "")
    .replace(/़/g, "") // Devanagari nukta
    .replace(/਼/g, "") // Gurmukhi nukta
    .replace(/ँ/g, "ं") // chandrabindu -> anusvara
    .replace(/[’']/g, "'");
}

export function isWord(token: Token | undefined): token is Token {
  return token?.kind === "word";
}

/** Does the phrase (already split into loose words) start at token index `start`? Returns the index after it. */
export function matchPhrase(tokens: Token[], start: number, phraseWords: string[]): number | undefined {
  let index = start;
  for (const phraseWord of phraseWords) {
    // Allow commas between the words of a command ("no, wait").
    while (tokens[index]?.kind === "punct" && tokens[index].text === "," && index > start) index += 1;
    const token = tokens[index];
    if (!isWord(token) || looseKey(token.text) !== phraseWord) return undefined;
    index += 1;
  }
  return index;
}

export function splitPhrase(phrase: string): string[] {
  return tokenize(phrase).filter((token) => token.kind === "word").map((token) => looseKey(token.text));
}

export function hasWords(tokens: Token[]): boolean {
  return tokens.some((token) => token.kind === "word");
}
