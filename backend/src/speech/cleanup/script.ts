// Output script. Hinglish is typed in Latin letters the way people chat
// ("kal meeting 5 baje hai"), so any Devanagari the speech model emits for a
// Hinglish utterance is romanized word by word: first the casual-spelling
// table (shared/speech/lexicon/hinglish-roman.json), then IndicXlit in the
// speech server when it's running, then the rule-based fallback below.
import fs from "node:fs";
import path from "node:path";
import { sharedDirectory } from "../../config.js";
import type { Token } from "./tokens.js";

const devanagari = /[ऀ-ॿ]/u;

export function hasDevanagari(text: string): boolean {
  return devanagari.test(text);
}

let table: Map<string, string> | undefined;

function romanTable(): Map<string, string> {
  if (table) return table;
  table = new Map();
  try {
    const file = JSON.parse(fs.readFileSync(path.join(sharedDirectory, "speech", "lexicon", "hinglish-roman.json"), "utf8")) as { words?: Record<string, string> };
    for (const [key, value] of Object.entries(file.words ?? {})) table.set(key.normalize("NFC"), value);
  } catch {
    // table is optional
  }
  return table;
}

// --- rule-based Devanagari -> casual Latin ------------------------------------

const consonants: Record<string, string> = {
  क: "k", ख: "kh", ग: "g", घ: "gh", ङ: "n", च: "ch", छ: "chh", ज: "j", झ: "jh", ञ: "n",
  ट: "t", ठ: "th", ड: "d", ढ: "dh", ण: "n", त: "t", थ: "th", द: "d", ध: "dh", न: "n",
  प: "p", फ: "ph", ब: "b", भ: "bh", म: "m", य: "y", र: "r", ल: "l", व: "v", श: "sh",
  ष: "sh", स: "s", ह: "h", ळ: "l",
  // precomposed nukta letters
  क़: "q", ख़: "kh", ग़: "g", ज़: "z", ड़: "d", ढ़: "dh", फ़: "f", य़: "y",
};
const nuktaForms: Record<string, string> = { क: "q", ख: "kh", ग: "g", ज: "z", ड: "d", ढ: "dh", फ: "f", य: "y" };

type Vowel = "a" | "aa" | "i" | "ii" | "u" | "uu" | "e" | "ai" | "o" | "au" | "ri";
const matras: Record<string, Vowel> = { "ा": "aa", "ि": "i", "ी": "ii", "ु": "u", "ू": "uu", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ृ": "ri", "ॉ": "o", "ॅ": "e", "ॆ": "e", "ॊ": "o" };
const independentVowels: Record<string, Vowel> = { अ: "a", आ: "aa", इ: "i", ई: "ii", उ: "u", ऊ: "uu", ए: "e", ऐ: "ai", ओ: "o", औ: "au", ऋ: "ri", ऑ: "o", ऍ: "e" };
const digits: Record<string, string> = { "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9" };

interface Syllable {
  consonants: string[];
  vowel: Vowel;
  /** Inherent vowel (no matra): a candidate for schwa deletion. */
  schwa: boolean;
  dropped: boolean;
  nasal: boolean;
  visarga: boolean;
  independent: boolean;
}

function parse(word: string): { syllables: Syllable[]; tail: string } {
  const characters = [...word.normalize("NFC")];
  const syllables: Syllable[] = [];
  let pending: string[] = [];
  let tail = "";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character in consonants) {
      let roman = consonants[character];
      if (characters[index + 1] === "़") {
        roman = nuktaForms[character] ?? roman;
        index += 1;
      }
      pending.push(roman);
      const next = characters[index + 1];
      if (next === "्") {
        index += 1;
        continue;
      }
      if (next && next in matras) {
        syllables.push({ consonants: pending, vowel: matras[next], schwa: false, dropped: false, nasal: false, visarga: false, independent: false });
        index += 1;
      } else {
        syllables.push({ consonants: pending, vowel: "a", schwa: true, dropped: false, nasal: false, visarga: false, independent: false });
      }
      pending = [];
    } else if (character in independentVowels) {
      syllables.push({ consonants: [], vowel: independentVowels[character], schwa: false, dropped: false, nasal: false, visarga: false, independent: true });
    } else if (character === "ं" || character === "ँ") {
      const last = syllables.at(-1);
      if (last) last.nasal = true;
    } else if (character === "ः") {
      const last = syllables.at(-1);
      if (last) last.visarga = true;
    } else if (character in digits) {
      tail += digits[character];
    } else if (!/[ऀ-ॿ]/u.test(character)) {
      tail += character;
    }
  }
  if (pending.length > 0) syllables.push({ consonants: pending, vowel: "a", schwa: true, dropped: true, nasal: false, visarga: false, independent: false });
  return { syllables, tail };
}

/** Hindi schwa deletion: the final inherent "a", and medial ones in a VC_CV context (right to left). */
function deleteSchwas(syllables: Syllable[]): void {
  const count = syllables.length;
  if (count === 0) return;
  const last = syllables[count - 1];
  // Keep the final "a" after a conjunct ending in r/y/v (mitra, kavya) and in one-syllable words (na, ka).
  const finalCluster = last.consonants.length > 1 && ["r", "y", "v"].includes(last.consonants.at(-1)!);
  if (count > 1 && last.schwa && !last.nasal && !finalCluster) last.dropped = true;
  for (let index = count - 2; index >= 1; index -= 1) {
    const syllable = syllables[index];
    const previous = syllables[index - 1];
    const next = syllables[index + 1];
    if (!syllable.schwa || syllable.dropped || syllable.nasal || syllable.consonants.length !== 1) continue;
    if (previous.dropped || next.dropped || next.consonants.length === 0) continue;
    syllable.dropped = true;
  }
}

const labials = new Set(["p", "ph", "b", "bh", "m"]);

function cluster(roman: string[]): string {
  // व after a consonant is "w" (swar, dwar); "chch" reads as "cch" (accha, bachcha).
  return roman
    .map((consonant, index) => (consonant === "v" && index > 0 ? "w" : consonant))
    .join("")
    .replace(/chchh/g, "cch")
    .replace(/chch/g, "cch");
}

export function romanizeDevanagariWord(word: string): string {
  const { syllables, tail } = parse(word);
  if (syllables.length === 0) return tail;
  deleteSchwas(syllables);
  let output = "";
  syllables.forEach((syllable, index) => {
    const next = syllables[index + 1];
    const closed = next !== undefined && (next.dropped || next.consonants.length > 1);
    const isLast = index === syllables.length - 1;
    let consonantText = cluster(syllable.consonants);
    // व is "w" before a/aa/e/o (wala, wahan, woh), "v" before i (vikas).
    if (syllable.consonants.length === 1 && syllable.consonants[0] === "v") consonantText = ["i", "ii"].includes(syllable.vowel) ? "v" : "w";
    let vowelText = "";
    if (!syllable.dropped) {
      switch (syllable.vowel) {
        case "aa":
          vowelText = syllable.independent && index === 0 ? "aa" : closed && !isLast ? "aa" : "a";
          break;
        case "ii":
          vowelText = closed && !isLast ? "ee" : "i";
          break;
        case "uu":
          vowelText = closed && !isLast ? "oo" : "u";
          break;
        default:
          vowelText = syllable.vowel;
      }
    }
    let nasalText = "";
    if (syllable.nasal) {
      const following = next?.consonants[0];
      nasalText = following && labials.has(following) ? "m" : "n";
    }
    output += consonantText + vowelText + nasalText + (syllable.visarga ? "h" : "");
  });
  return output + tail;
}

// --- token-level romanization -----------------------------------------------

/** Batch transliterator (IndicXlit in the speech server): Devanagari words in, Latin out, or undefined if unavailable. */
export type Transliterator = (words: string[]) => Promise<(string | undefined)[] | undefined>;

export async function romanizeTokens(tokens: Token[], transliterate?: Transliterator): Promise<{ tokens: Token[]; changed: boolean }> {
  const words = romanTable();
  const pendingIndexes: number[] = [];
  const output = tokens.map((token) => ({ ...token }));
  output.forEach((token, index) => {
    if (token.kind === "punct" && (token.text === "।" || token.text === "॥")) token.text = ".";
    if (token.kind !== "word" || !hasDevanagari(token.text)) return;
    const known = words.get(token.text.normalize("NFC"));
    if (known) token.text = known;
    else pendingIndexes.push(index);
  });
  if (pendingIndexes.length > 0) {
    let fromModel: (string | undefined)[] | undefined;
    if (transliterate) {
      try {
        fromModel = await transliterate(pendingIndexes.map((index) => output[index].text));
      } catch {
        fromModel = undefined;
      }
    }
    pendingIndexes.forEach((tokenIndex, position) => {
      const candidate = fromModel?.[position];
      output[tokenIndex].text = candidate && !hasDevanagari(candidate) ? candidate.toLowerCase() : romanizeDevanagariWord(output[tokenIndex].text);
    });
  }
  const changed = output.some((token, index) => token.text !== tokens[index].text);
  return { tokens: output, changed };
}
