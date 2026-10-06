// The deterministic half of the dictation cleanup ("Flow layer"): explicit
// commands ("scratch that", "nahi nahi", "new line", "at the rate"), strong
// backtracks, unambiguous fillers, stutters, lists, ₹ amounts, casing and the
// final full stop. Everything here is rule-based, instant and testable;
// anything that needs judgment is flagged for the LLM edit pass.
import { lexiconLanguageFor, loadLexicon, type FormatKind, type Lexicon } from "./lexicon.js";
import { isWord, looseKey, matchPhrase, sentenceEnders, splitPhrase, type Token } from "./tokens.js";

export interface DeterministicResult {
  tokens: Token[];
  applied: string[];
  /** Weak backtrack markers or context fillers remain: the LLM pass should look. */
  needsJudgment: boolean;
}

export interface DeterministicOptions {
  language: string;
  /** "native" keeps Indic script punctuation (।) for hi/pa. */
  script?: "native" | "roman";
  finalPunctuation?: boolean;
  /** Sentence-start capitals and "I" (off in terminals). */
  casing?: boolean;
  /** Seconds of silence that count as a clause boundary. */
  pauseBoundary?: number;
}

const usesDanda = (language: string, script: string | undefined) => (language === "hi" || language === "pa") && script !== "roman";

function isBoundary(token: Token | undefined): boolean {
  return token?.kind === "newline" || (token?.kind === "punct" && sentenceEnders.has(token.text));
}

/** Index where the clause ending just before `index` starts (after the last sentence end, newline or long pause). */
function clauseStart(tokens: Token[], index: number, pauseBoundary: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (isBoundary(tokens[cursor])) return cursor + 1;
    if ((tokens[cursor].pauseBefore ?? 0) >= pauseBoundary && cursor < index - 1) return cursor;
  }
  return 0;
}

function trimTrailingSoftPunct(tokens: Token[], end: number, start: number): number {
  let cursor = end;
  while (cursor > start && tokens[cursor - 1].kind === "punct" && !sentenceEnders.has(tokens[cursor - 1].text)) cursor -= 1;
  return cursor;
}

function findPhrase(tokens: Token[], phrases: string[][], from = 0): { index: number; end: number; phrase: string[] } | undefined {
  for (let index = from; index < tokens.length; index += 1) {
    if (!isWord(tokens[index])) continue;
    for (const phrase of phrases) {
      const end = matchPhrase(tokens, index, phrase);
      if (end !== undefined) return { index, end, phrase };
    }
  }
  return undefined;
}

// --- 1. Delete commands: "scratch that", "mita do", "அதை நீக்கு" -----------------

export function applyDeleteCommands(tokens: Token[], lexicon: Lexicon, pauseBoundary: number, applied: string[]): Token[] {
  let result = tokens;
  for (let guard = 0; guard < 20; guard += 1) {
    const found = findPhrase(result, lexicon.deleteCommands);
    if (!found) break;
    let start = clauseStart(result, found.index, pauseBoundary);
    const contentEnd = trimTrailingSoftPunct(result, found.index, start);
    const hasContent = result.slice(start, contentEnd).some(isWord);
    if (!hasContent && start > 0) {
      // "…sentence one. Scratch that." deletes the whole previous sentence.
      start = clauseStart(result, start - 1, pauseBoundary);
    }
    let end = found.end;
    // Swallow the command's own trailing punctuation.
    while (result[end]?.kind === "punct" && result[end].text !== "(" ) end += 1;
    applied.push(`delete:${found.phrase.join(" ")}`);
    result = [...result.slice(0, start), ...result.slice(end)];
  }
  return result;
}

// --- 2. Strong backtracks: "meet at 5, no wait, meet at 6" / "5 baje nahi nahi 6 baje" ---

function nextBoundary(tokens: Token[], from: number): number {
  for (let cursor = from; cursor < tokens.length; cursor += 1) if (isBoundary(tokens[cursor])) return cursor;
  return tokens.length;
}

const spokenNumbers = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "fifteen", "twenty", "thirty", "forty", "fifty", "hundred", "thousand", "lakh", "crore"]);

function isNumeric(text: string): boolean {
  return /^[\d.,:]+$/.test(text) || spokenNumbers.has(looseKey(text));
}

export function applyStrongBacktracks(tokens: Token[], lexicon: Lexicon, pauseBoundary: number, applied: string[]): Token[] {
  let result = tokens;
  let searchFrom = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const found = findPhrase(result, lexicon.strongBacktrack, searchFrom);
    if (!found) break;
    const clause = clauseStart(result, found.index, pauseBoundary);
    const beforeEnd = trimTrailingSoftPunct(result, found.index, clause);
    let afterStart = found.end;
    while (result[afterStart]?.kind === "punct" && result[afterStart].text === ",") afterStart += 1;
    const afterEnd = nextBoundary(result, afterStart);
    const before = result.slice(clause, beforeEnd);
    const after = result.slice(afterStart, afterEnd);
    const beforeWords = before.filter(isWord);
    const afterWords = after.filter(isWord);
    if (beforeWords.length === 0 || afterWords.length === 0) {
      // Nothing to correct ("Nahi nahi, main nahi aaunga"): the words are meant, keep them.
      searchFrom = found.end;
      continue;
    }
    let deleteFrom: number;
    const firstAfter = looseKey(afterWords[0].text);
    let restatedAt = -1;
    for (let cursor = beforeEnd - 1; cursor >= clause; cursor -= 1) {
      if (isWord(result[cursor]) && looseKey(result[cursor].text) === firstAfter) {
        restatedAt = cursor;
        break;
      }
    }
    if (restatedAt >= 0) {
      // The correction restates from a word already said: replace from there.
      deleteFrom = restatedAt;
    } else if (afterWords.length <= 3 && beforeWords.length >= afterWords.length) {
      // A short correction replaces the same number of trailing words ("at 5 pm, no wait, 6 pm").
      let remaining = afterWords.length;
      deleteFrom = beforeEnd;
      while (deleteFrom > clause && remaining > 0) {
        deleteFrom -= 1;
        if (isWord(result[deleteFrom])) remaining -= 1;
      }
      // "by 3 30 pm, sorry I mean 4 pm": a numeric correction replaces the whole number before it.
      if (isNumeric(afterWords[0].text)) {
        while (deleteFrom > clause && isWord(result[deleteFrom - 1]) && isNumeric(result[deleteFrom - 1].text)) deleteFrom -= 1;
      }
    } else {
      // A long correction restarts the clause.
      deleteFrom = clause;
    }
    applied.push(`backtrack:${found.phrase.join(" ")}`);
    result = [...result.slice(0, deleteFrom), ...result.slice(afterStart)];
    searchFrom = deleteFrom;
  }
  return result;
}

// --- 3. Fillers, fragments, stutters ----------------------------------------

export function removeFillers(tokens: Token[], lexicon: Lexicon, applied: string[]): Token[] {
  const output: Token[] = [];
  // A pause before a dropped filler still separates clauses: carry it to the next word.
  let carriedPause: number | undefined;
  const push = (token: Token) => {
    output.push(carriedPause !== undefined ? { ...token, pauseBefore: (token.pauseBefore ?? 0) + carriedPause } : token);
    carriedPause = undefined;
  };
  const carry = (token: Token) => {
    if (token.pauseBefore !== undefined) carriedPause = (carriedPause ?? 0) + token.pauseBefore;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isWord(token)) {
      const key = looseKey(token.text);
      // Elongated fillers: "ummmm", "uhhhh", "hmmmmm".
      const squashed = key.replace(/(.)\1{2,}/gu, "$1$1");
      if (lexicon.fillers.has(key) || lexicon.fillers.has(squashed)) {
        applied.push(`filler:${token.text}`);
        carry(token);
        // Drop a comma that only framed the filler: "so, um, yes" -> "so, yes".
        if (tokens[index + 1]?.text === "," && (output.length === 0 || output.at(-1)?.text === ",")) index += 1;
        continue;
      }
      // Cut-off fragments: "ka- kal", "tom- tomorrow".
      const next = tokens[index + 1];
      const afterDash = tokens[index + 2];
      if (next?.kind === "punct" && next.text === "-" && isWord(afterDash) && key.length <= 4 && looseKey(afterDash.text).startsWith(key)) {
        applied.push(`fragment:${token.text}`);
        carry(token);
        index += 1;
        continue;
      }
      // Stutters of function words ("I I think", "the the"). Indian languages use
      // reduplication grammatically (dheere dheere), so only listed words collapse.
      const previous = output.at(-1);
      if (previous && isWord(previous) && looseKey(previous.text) === key && lexicon.stutterCollapse.has(key)) {
        applied.push(`stutter:${token.text}`);
        carry(token);
        continue;
      }
    }
    push(token);
  }
  return output;
}

// --- 4. Spoken formatting ----------------------------------------------------

const punctuationFor: Partial<Record<FormatKind, string>> = {
  comma: ",",
  question: "?",
  exclamation: "!",
  colon: ":",
  openBracket: "(",
  closeBracket: ")",
};

const numberWords: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function applyFormatting(tokens: Token[], lexicon: Lexicon, options: DeterministicOptions, applied: string[]): Token[] {
  const danda = usesDanda(lexiconLanguageFor(options.language), options.script);
  const formats = lexicon.format.map((entry) => ({ kind: entry.kind, phrases: entry.words.map(splitPhrase).sort((left, right) => right.length - left.length) }));
  const output: Token[] = [];
  const hasEmailContext = tokens.some((token, index) => formats.find((format) => format.kind === "at")?.phrases.some((phrase) => matchPhrase(tokens, index, phrase) !== undefined) || token.text.includes("@") || looseKey(token.text) === "www");

  for (let index = 0; index < tokens.length; ) {
    let matched: { kind: FormatKind; end: number } | undefined;
    if (isWord(tokens[index])) {
      for (const format of formats) {
        for (const phrase of format.phrases) {
          const end = matchPhrase(tokens, index, phrase);
          if (end !== undefined && (!matched || end > matched.end)) matched = { kind: format.kind, end };
        }
      }
    }
    if (!matched) {
      output.push(tokens[index]);
      index += 1;
      continue;
    }
    const { kind, end } = matched;
    const previous = output.at(-1);
    const next = tokens[end];
    const atTextEnd = end >= tokens.length || tokens[end].kind === "newline";
    const dropSoftPunct = () => {
      while (output.at(-1)?.kind === "punct" && !sentenceEnders.has(output.at(-1)!.text)) output.pop();
    };
    switch (kind) {
      case "newline":
      case "paragraph":
        dropSoftPunct();
        output.push({ text: kind === "newline" ? "\n" : "\n\n", kind: "newline" });
        break;
      case "fullStop":
      case "period":
        if (kind === "period" && !atTextEnd && !(next?.pauseBefore !== undefined && next.pauseBefore > 0.3)) {
          // "the trial period ends" — only a period at the end of what was said counts.
          output.push(...tokens.slice(index, end));
          index = end;
          continue;
        }
        dropSoftPunct();
        output.push({ text: danda ? "।" : ".", kind: "punct" });
        break;
      case "at":
      case "dot":
      case "underscore": {
        const joiner = kind === "at" ? "@" : kind === "dot" ? "." : "_";
        const nextIsWord = isWord(next);
        const domainNext = nextIsWord && lexicon.domains.has(looseKey(next!.text));
        const joinable = previous && isWord(previous) && nextIsWord && (kind !== "dot" || hasEmailContext || domainNext);
        if (!joinable) {
          output.push(...tokens.slice(index, end));
          index = end;
          continue;
        }
        output.pop();
        output.push({ text: `${previous!.text}${joiner}${next!.text}`.replace(/\s+/g, ""), kind: "word", pauseBefore: previous!.pauseBefore });
        applied.push(`format:${kind}`);
        index = end + 1;
        continue;
      }
      case "bullet":
        dropSoftPunct();
        if (output.length > 0) output.push({ text: "\n", kind: "newline" });
        output.push({ text: "-", kind: "punct" });
        break;
      default: {
        const mark = punctuationFor[kind];
        if (mark) {
          if (mark !== "(") dropSoftPunct();
          output.push({ text: mark, kind: "punct" });
        }
      }
    }
    applied.push(`format:${kind}`);
    index = end;
  }
  return applyNumberedLists(output, applied);
}

/** "number one X number two Y" -> "1. X\n2. Y" when at least two numbered items follow each other. */
function applyNumberedLists(tokens: Token[], applied: string[]): Token[] {
  const markers: { index: number; number: number }[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const word = isWord(tokens[index]) ? looseKey(tokens[index].text) : "";
    if (word !== "number" && word !== "point") continue;
    const next = tokens[index + 1];
    if (!isWord(next)) continue;
    const value = numberWords[looseKey(next.text)] ?? (/^\d+$/.test(next.text) ? Number(next.text) : undefined);
    if (value !== undefined) markers.push({ index, number: value });
  }
  const sequence = markers.filter((marker, position) => marker.number === position + 1);
  if (sequence.length < 2) return tokens;
  const output: Token[] = [];
  let cursor = 0;
  for (const marker of sequence) {
    output.push(...tokens.slice(cursor, marker.index));
    while (output.at(-1)?.kind === "punct" && output.at(-1)!.text === ",") output.pop();
    if (output.length > 0 && output.at(-1)?.kind !== "newline") output.push({ text: "\n", kind: "newline" });
    output.push({ text: `${marker.number}.`, kind: "word" });
    cursor = marker.index + 2;
    while (tokens[cursor]?.kind === "punct" && tokens[cursor].text !== "(") cursor += 1;
  }
  output.push(...tokens.slice(cursor));
  applied.push("format:numbered-list");
  return output;
}

// --- 5. Money in rupees -----------------------------------------------------

const rupeeWords = new Set(["rupees", "rupee", "rupaye", "rupaiye", "rupay", "rs", "inr", "रुपये", "रुपए", "रूपये", "ரூபாய்", "రూపాయలు", "రూపాయి", "ਰੁਪਏ"].map(looseKey));

/** Indian digit grouping: 150000 -> 1,50,000. */
export function indianGrouping(digits: string): string {
  const [whole, fraction] = digits.split(".");
  if (whole.length <= 3) return fraction ? `${whole}.${fraction}` : whole;
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${lastThree}${fraction ? `.${fraction}` : ""}`;
}

export function applyCurrency(tokens: Token[], language: string, applied: string[]): Token[] {
  // In native Hindi/Tamil/Telugu/Punjabi text "500 रुपये" reads naturally; ₹ is for English and Hinglish.
  if (!["en", "hinglish"].includes(lexiconLanguageFor(language))) return tokens;
  const output: Token[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const amount = (text: string) => text.replace(/,/g, "");
    const isAmount = (candidate: Token | undefined) => isWord(candidate) && /^\d[\d,]*(\.\d+)?$/.test(candidate.text);
    if (isAmount(token) && isWord(next) && rupeeWords.has(looseKey(next.text))) {
      // Keep "5 lakh rupees" as "₹5 lakh".
      output.push({ ...token, text: `₹${indianGrouping(amount(token.text))}` });
      applied.push("format:rupees");
      index += 1;
      continue;
    }
    if (isWord(token) && rupeeWords.has(looseKey(token.text)) && isAmount(next)) {
      output.push({ ...next!, text: `₹${indianGrouping(amount(next!.text))}` });
      applied.push("format:rupees");
      index += 1;
      continue;
    }
    output.push(token);
  }
  // "₹5 lakh rupees" leftovers: "5 lakh rupees" -> "₹5 lakh".
  for (let index = 0; index + 2 < output.length; index += 1) {
    if (isWord(output[index]) && /^\d/.test(output[index].text) && ["lakh", "lakhs", "crore", "crores", "lac"].includes(looseKey(output[index + 1].text)) && isWord(output[index + 2]) && rupeeWords.has(looseKey(output[index + 2].text))) {
      output[index] = { ...output[index], text: `₹${output[index].text}` };
      output.splice(index + 2, 1);
      applied.push("format:rupees");
    }
  }
  return output;
}

// --- 6. Tidy punctuation, casing and the final full stop --------------------------

export function tidy(tokens: Token[], options: DeterministicOptions): Token[] {
  const language = lexiconLanguageFor(options.language);
  const lexicon = loadLexicon(options.language);
  const output: Token[] = [];
  for (const token of tokens) {
    const previous = output.at(-1);
    if (token.kind === "punct" && token.text !== "(" && token.text !== "-" && token.text !== "₹") {
      // No punctuation at the very start or right after a line break.
      if (!previous || previous.kind === "newline") continue;
      if (previous.kind === "punct" && previous.text !== ")" && previous.text !== "-") {
        // ", ." -> "." ; ". ," -> "."
        if (sentenceEnders.has(token.text) || (previous.text === "," && token.text !== ",")) output.pop();
        else continue;
      }
    }
    if (token.kind === "newline" && previous?.kind === "punct" && previous.text === ",") output.pop();
    output.push(token);
  }
  while (output.at(-1)?.kind === "punct" && output.at(-1)!.text === ",") output.pop();
  while (output.at(-1)?.kind === "newline") output.pop();

  // Latin-script casing for English and Hinglish.
  if ((options.casing ?? true) && (language === "en" || language === "hinglish" || options.script === "roman")) {
    let capitalizeNext = true;
    for (const token of output) {
      if (token.kind === "newline" || (token.kind === "punct" && sentenceEnders.has(token.text))) {
        capitalizeNext = true;
        continue;
      }
      if (isWord(token)) {
        if (looseKey(token.text) === "i") token.text = "I";
        else if (looseKey(token.text).startsWith("i'")) token.text = `I${token.text.slice(1)}`;
        if (capitalizeNext && /^[a-z]/.test(token.text) && !/[@./:]/.test(token.text)) token.text = token.text[0].toUpperCase() + token.text.slice(1);
        capitalizeNext = false;
      }
    }
  }

  const wordCount = output.filter(isWord).length;
  const last = output.at(-1);
  if ((options.finalPunctuation ?? true) && wordCount >= 4 && isWord(last) && !/[@/]/.test(last.text)) {
    const question = lexicon ? isQuestion(output, lexicon) : false;
    output.push({ text: question ? "?" : usesDanda(language, options.script) ? "।" : ".", kind: "punct" });
  }
  return output;
}

/** Is the last sentence a question? English by its opening words, Hindi/Hinglish by a question word anywhere. */
function isQuestion(tokens: Token[], lexicon: Lexicon): boolean {
  let start = tokens.length;
  while (start > 0 && !isBoundary(tokens[start - 1])) start -= 1;
  const sentence = tokens.slice(start);
  const firstWord = sentence.findIndex(isWord);
  if (firstWord < 0) return false;
  if (lexicon.questionStarts.some((phrase) => matchPhrase(sentence, firstWord, phrase) !== undefined)) return true;
  return sentence.some((token) => isWord(token) && lexicon.questionWords.has(looseKey(token.text)));
}

// --- the whole deterministic pass ------------------------------------------

export function runDeterministic(tokens: Token[], options: DeterministicOptions): DeterministicResult {
  const lexicon = loadLexicon(options.language);
  const pauseBoundary = options.pauseBoundary ?? 0.7;
  const applied: string[] = [];
  // Fillers and spoken punctuation first, so "full stop" / "new line" already
  // mark the sentence a later "scratch that" deletes.
  let result = removeFillers(tokens, lexicon, applied);
  result = applyFormatting(result, lexicon, options, applied);
  result = applyDeleteCommands(result, lexicon, pauseBoundary, applied);
  result = applyStrongBacktracks(result, lexicon, pauseBoundary, applied);
  result = applyCurrency(result, options.language, applied);
  result = tidy(result, options);
  const weak = findPhrase(result, lexicon.weakBacktrack) !== undefined;
  const contextFillers = lexicon.llmFillers.map(splitPhrase).filter((phrase) => phrase.length > 0);
  const hasContextFiller = findPhrase(result, contextFillers) !== undefined;
  return { tokens: result, applied, needsJudgment: weak || hasContextFiller };
}
