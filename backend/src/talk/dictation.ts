// Dictation, HeyClicky's two-model pipeline: speech-to-text streams the words
// (they use Deepgram nova-3, ~450 ms; Pip runs local models, speech/asr.ts),
// then a faithful cleanup (speech/cleanup: rules, then LLM edit ops that can't
// add words, then romanized Hinglish). If cleanup fails, the raw transcript is
// inserted.
import { readSettings, updateSettings } from "../config.js";
import type { ActiveApp } from "../lib/skills.js";
import { takeAsrResult } from "../speech/asr.js";
import { cleanTranscript, type CleanTranscriptResult, type Editor } from "../speech/cleanup/index.js";
import type { TimedWord } from "../speech/cleanup/tokens.js";

const terminalProcesses = new Set(["windowsterminal", "conhost", "cmd", "powershell", "pwsh", "wt", "alacritty", "wezterm-gui", "mintty", "openconsole"]);

export function isTerminalApp(app: ActiveApp | undefined): boolean {
  const processName = (app?.process ?? "").toLowerCase().replace(/\.exe$/, "");
  return terminalProcesses.has(processName);
}

export interface CleanupRequest {
  text: string;
  app?: ActiveApp;
  /** The language the speech model detected (en-IN, hi, hinglish, ta, te, pa...). */
  language?: string;
  /** Timed words with confidences from the speech model, when it gave them. */
  words?: TimedWord[];
  /** The /v2/asr session the text came from: its detected language and timed words are used. */
  sessionId?: string;
}

export interface CleanupResponse {
  text: string;
  cleaned: boolean;
  language?: string;
  applied?: string[];
  llm?: CleanTranscriptResult["llm"];
}

export function collapseForTerminal(text: string): string {
  // Never let dictation press Enter in a terminal: newlines become spaces.
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export function removeDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ");
}

export async function cleanupDictation(request: CleanupRequest, editor?: Editor): Promise<CleanupResponse> {
  const settings = readSettings();
  const raw = (request.text ?? "").trim();
  const terminal = isTerminalApp(request.app);
  const finish = (text: string) => (terminal ? collapseForTerminal(removeDashes(text)) : removeDashes(text));
  if (!settings.dictation.cleanup || !raw) return { text: finish(raw), cleaned: false };
  const recognized = takeAsrResult(request.sessionId);
  const appKey = (request.app?.process ?? "").toLowerCase().replace(/\.exe$/, "");
  const language = request.language ?? recognized?.language ?? settings.speech.perApp[appKey] ?? settings.speech.primaryLanguage;
  // Timed words only describe the text if the client didn't change it.
  const words = request.words ?? (recognized?.words && recognized.text.trim() === raw ? recognized.words : undefined);
  try {
    const result = await cleanTranscript({
      text: raw,
      words,
      language,
      script: settings.speech.script[language],
      appName: request.app?.name ?? request.app?.process,
      terminal,
      dictionary: settings.dictation.dictionary,
      llmPass: settings.dictation.llmPass,
      minWordsForLlm: settings.dictation.skipCleanupUnderWords,
      editor,
    });
    if (result.reason) console.warn(`[dictation] LLM edit ${result.llm}: ${result.reason}`);
    const text = finish(result.text);
    // Empty means the speaker deleted everything ("…scratch that") or said only fillers: type nothing.
    return { text, cleaned: text !== finish(raw), language: result.language, applied: result.applied, llm: result.llm };
  } catch (error) {
    console.warn("[dictation] cleanup failed, inserting raw transcript:", (error as Error).message);
    return { text: finish(raw), cleaned: false };
  }
}

export function updateDictionary(change: { add?: string[]; remove?: string[] }): string[] {
  const current = new Set(readSettings().dictation.dictionary);
  for (const word of change.add ?? []) if (word.trim()) current.add(word.trim());
  for (const word of change.remove ?? []) current.delete(word.trim());
  const dictionary = [...current].slice(-500);
  updateSettings({ dictation: { dictionary } });
  return dictionary;
}
