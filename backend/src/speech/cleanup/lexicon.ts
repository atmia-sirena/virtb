// Per-language cleanup vocabulary from shared/speech/lexicon/*.json, merged
// with common.json. Edit the JSON to tune; no code change needed.
import fs from "node:fs";
import path from "node:path";
import { sharedDirectory } from "../../config.js";
import { splitPhrase } from "./tokens.js";

export type FormatKind =
  | "newline"
  | "paragraph"
  | "comma"
  | "fullStop"
  | "period"
  | "question"
  | "exclamation"
  | "colon"
  | "openBracket"
  | "closeBracket"
  | "at"
  | "dot"
  | "underscore"
  | "bullet";

interface LexiconFile {
  fillers?: string[];
  stutterCollapse?: string[];
  deleteCommands?: string[];
  strongBacktrack?: string[];
  weakBacktrack?: string[];
  format?: Partial<Record<FormatKind, string[]>>;
  domains?: string[];
  llmFillers?: string[];
}

export interface Lexicon {
  language: string;
  fillers: Set<string>;
  stutterCollapse: Set<string>;
  deleteCommands: string[][];
  strongBacktrack: string[][];
  weakBacktrack: string[][];
  format: { kind: FormatKind; words: string[] }[];
  domains: Set<string>;
  llmFillers: string[];
}

/** Languages Pip knows; anything else gets the common lexicon only. */
export const lexiconLanguages = ["en", "hi", "hinglish", "ta", "te", "pa"] as const;

function lexiconDirectory(): string {
  return path.join(sharedDirectory, "speech", "lexicon");
}

function readLexiconFile(name: string): LexiconFile {
  const filePath = path.join(lexiconDirectory(), `${name}.json`);
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as LexiconFile;
}

/** Maps settings/ASR language codes (en-IN, hi-IN, hi-Latn...) to a lexicon name. */
export function lexiconLanguageFor(language: string | undefined): string {
  const code = (language ?? "en").toLowerCase();
  if (code === "hinglish" || code.startsWith("hi-latn") || code === "hi_en") return "hinglish";
  const base = code.split(/[-_]/)[0];
  return (lexiconLanguages as readonly string[]).includes(base) ? base : base;
}

const cache = new Map<string, Lexicon>();

export function loadLexicon(language: string | undefined): Lexicon {
  const name = lexiconLanguageFor(language);
  const cached = cache.get(name);
  if (cached) return cached;
  const common = readLexiconFile("common");
  const specific = name === "common" ? {} : readLexiconFile(name);
  // Hinglish speakers also say Hindi commands in Devanagari when the model emits it, and English ones.
  const extra = name === "hinglish" ? readLexiconFile("hi") : {};
  const files = [common, specific, extra];
  const phrases = (key: "deleteCommands" | "strongBacktrack" | "weakBacktrack") =>
    files.flatMap((file) => file[key] ?? []).map(splitPhrase).filter((words) => words.length > 0).sort((left, right) => right.length - left.length);
  const formatKinds = new Map<FormatKind, string[]>();
  for (const file of files) {
    for (const [kind, words] of Object.entries(file.format ?? {}) as [FormatKind, string[]][]) {
      formatKinds.set(kind, [...(formatKinds.get(kind) ?? []), ...words]);
    }
  }
  const lexicon: Lexicon = {
    language: name,
    fillers: new Set(files.flatMap((file) => file.fillers ?? []).map((word) => splitPhrase(word).join(" "))),
    stutterCollapse: new Set((specific.stutterCollapse ?? (name === "en" ? [] : [])).map((word) => word.toLowerCase())),
    deleteCommands: phrases("deleteCommands"),
    strongBacktrack: phrases("strongBacktrack"),
    weakBacktrack: phrases("weakBacktrack"),
    format: [...formatKinds.entries()].map(([kind, words]) => ({ kind, words })),
    domains: new Set(common.domains ?? []),
    llmFillers: [...(specific.llmFillers ?? []), ...(extra.llmFillers ?? [])],
  };
  cache.set(name, lexicon);
  return lexicon;
}

export function clearLexiconCacheForTests(): void {
  cache.clear();
}
