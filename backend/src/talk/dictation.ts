// Dictation, HeyClicky's two-model pipeline: speech-to-text streams the words
// (they use Deepgram nova-3, ~450 ms; Pip runs Parakeet locally, speech/asr.ts),
// then a second model does a faithful cleanup. If cleanup fails, the raw
// transcript is inserted.
import { readSettings, updateSettings } from "../config.js";
import { resolveModel } from "../lib/models.js";
import { ollamaChat } from "../lib/ollama.js";
import { loadPrompt } from "../lib/prompts.js";
import type { ActiveApp } from "../lib/skills.js";

const terminalProcesses = new Set(["windowsterminal", "conhost", "cmd", "powershell", "pwsh", "wt", "alacritty", "wezterm-gui", "mintty", "openconsole"]);

export function isTerminalApp(app: ActiveApp | undefined): boolean {
  const processName = (app?.process ?? "").toLowerCase().replace(/\.exe$/, "");
  return terminalProcesses.has(processName);
}

export interface CleanupRequest {
  text: string;
  app?: ActiveApp;
}

export function collapseForTerminal(text: string): string {
  // Never let dictation press Enter in a terminal: newlines become spaces.
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export function removeDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ");
}

export async function cleanupDictation(request: CleanupRequest): Promise<{ text: string; cleaned: boolean }> {
  const settings = readSettings();
  const raw = request.text.trim();
  const terminal = isTerminalApp(request.app);
  const finish = (text: string, cleaned: boolean) => ({ text: terminal ? collapseForTerminal(removeDashes(text)) : removeDashes(text), cleaned });
  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  if (!settings.dictation.cleanup || wordCount < settings.dictation.skipCleanupUnderWords) return finish(raw, false);
  try {
    const model = await resolveModel("cleanup", { num_predict: Math.min(1200, Math.round(raw.length / 2) + 60) });
    if (!model.available) return finish(raw, false);
    const dictionary = settings.dictation.dictionary.length > 0 ? `\nDICTIONARY: ${settings.dictation.dictionary.join(", ")}` : "";
    const target = `\nTARGET APP: ${request.app?.name ?? request.app?.process ?? "unknown"}${terminal ? " (a terminal)" : ""}`;
    const response = await ollamaChat({
      model: model.model,
      keep_alive: model.keepAlive,
      options: model.options,
      messages: [
        { role: "system", content: `${loadPrompt("dictation-cleanup")}${dictionary}${target}` },
        { role: "user", content: raw },
      ],
    });
    const cleaned = response.message.content.trim().replace(/^["“]|["”]$/g, "");
    // Faithfulness guard: a cleanup that grows the text a lot added words; keep the raw text instead.
    const cleanedWordCount = cleaned.split(/\s+/).filter(Boolean).length;
    if (!cleaned || cleanedWordCount > wordCount * 1.25 + 3) return finish(raw, false);
    return finish(cleaned, true);
  } catch (error) {
    console.warn("[dictation] cleanup failed, inserting raw transcript:", (error as Error).message);
    return finish(raw, false);
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
