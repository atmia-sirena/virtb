// Languages Pip dictates in: English, Hinglish and the 22 scheduled languages
// of India. `cleanup` marks the ones with a full command/filler lexicon in
// shared/speech/lexicon; the rest get the common rules plus the LLM pass.
import { readSettings, updateSettings, type PipSettings } from "../config.js";
import { speechServerHealthy, speechServerUrl } from "./sidecar.js";

export interface SpeechLanguage {
  code: string;
  name: string;
  native: string;
  /** Short label for the dictation bubble's language chip. */
  chip: string;
  cleanup: boolean;
  scripts: ("native" | "roman")[];
}

export const speechLanguages: SpeechLanguage[] = [
  { code: "en-IN", name: "English (India)", native: "English", chip: "EN", cleanup: true, scripts: ["native"] },
  { code: "hinglish", name: "Hinglish", native: "Hinglish", chip: "Hinglish", cleanup: true, scripts: ["roman", "native"] },
  { code: "hi", name: "Hindi", native: "हिन्दी", chip: "हिं", cleanup: true, scripts: ["native", "roman"] },
  { code: "ta", name: "Tamil", native: "தமிழ்", chip: "த", cleanup: true, scripts: ["native"] },
  { code: "te", name: "Telugu", native: "తెలుగు", chip: "తె", cleanup: true, scripts: ["native"] },
  { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ", chip: "ਪੰ", cleanup: true, scripts: ["native"] },
  { code: "bn", name: "Bengali", native: "বাংলা", chip: "বা", cleanup: false, scripts: ["native"] },
  { code: "mr", name: "Marathi", native: "मराठी", chip: "मरा", cleanup: false, scripts: ["native"] },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી", chip: "ગુ", cleanup: false, scripts: ["native"] },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ", chip: "ಕ", cleanup: false, scripts: ["native"] },
  { code: "ml", name: "Malayalam", native: "മലയാളം", chip: "മ", cleanup: false, scripts: ["native"] },
  { code: "or", name: "Odia", native: "ଓଡ଼ିଆ", chip: "ଓ", cleanup: false, scripts: ["native"] },
  { code: "as", name: "Assamese", native: "অসমীয়া", chip: "অ", cleanup: false, scripts: ["native"] },
  { code: "ur", name: "Urdu", native: "اردو", chip: "اردو", cleanup: false, scripts: ["native"] },
  { code: "ne", name: "Nepali", native: "नेपाली", chip: "ने", cleanup: false, scripts: ["native"] },
  { code: "kok", name: "Konkani", native: "कोंकणी", chip: "को", cleanup: false, scripts: ["native"] },
  { code: "mai", name: "Maithili", native: "मैथिली", chip: "मै", cleanup: false, scripts: ["native"] },
  { code: "sa", name: "Sanskrit", native: "संस्कृतम्", chip: "सं", cleanup: false, scripts: ["native"] },
  { code: "sd", name: "Sindhi", native: "سنڌي", chip: "سن", cleanup: false, scripts: ["native"] },
  { code: "ks", name: "Kashmiri", native: "کٲشُر", chip: "کٲ", cleanup: false, scripts: ["native"] },
  { code: "doi", name: "Dogri", native: "डोगरी", chip: "डो", cleanup: false, scripts: ["native"] },
  { code: "mni", name: "Manipuri", native: "মৈতৈলোন্", chip: "মৈ", cleanup: false, scripts: ["native"] },
  { code: "brx", name: "Bodo", native: "बड़ो", chip: "बड़", cleanup: false, scripts: ["native"] },
  { code: "sat", name: "Santali", native: "ᱥᱟᱱᱛᱟᱲᱤ", chip: "ᱥᱟ", cleanup: false, scripts: ["native"] },
];

/** "en-IN" and the speech server's "en" are the same language. */
export function baseCode(code: string): string {
  const value = code.toLowerCase();
  return value === "hinglish" ? value : value.split(/[-_]/)[0];
}

export async function describeSpeechLanguages() {
  const { speech } = readSettings();
  let server: unknown = { running: false };
  if (await speechServerHealthy(2000)) {
    try {
      server = { running: true, ...((await (await fetch(`${speechServerUrl()}/health`, { signal: AbortSignal.timeout(1000) })).json()) as object) };
    } catch {
      server = { running: false };
    }
  }
  return {
    available: speechLanguages,
    selected: speech.languages,
    primary: speech.primaryLanguage,
    script: speech.script,
    perApp: speech.perApp,
    asrEngine: speech.asrEngine,
    server,
  };
}

export type LanguageSettingsUpdate = Partial<Pick<PipSettings["speech"], "languages" | "primaryLanguage" | "script" | "asrEngine">>;

export function updateSpeechLanguages(update: LanguageSettingsUpdate): PipSettings["speech"] {
  const known = new Set(speechLanguages.map((language) => language.code));
  const change: LanguageSettingsUpdate = {};
  if (Array.isArray(update.languages)) {
    const languages = update.languages.filter((code) => known.has(code));
    if (languages.length > 0) change.languages = languages;
  }
  const languages = change.languages ?? readSettings().speech.languages;
  if (update.primaryLanguage && languages.includes(update.primaryLanguage)) change.primaryLanguage = update.primaryLanguage;
  else if (change.languages && !change.languages.includes(readSettings().speech.primaryLanguage)) change.primaryLanguage = change.languages[0];
  if (update.script && typeof update.script === "object") change.script = update.script;
  if (update.asrEngine && ["auto", "sidecar", "local"].includes(update.asrEngine)) change.asrEngine = update.asrEngine;
  return updateSettings({ speech: change }).speech;
}

/** The language-cycle hotkey: the next selected language after `current`, remembered for this app. */
export function cycleLanguage(app: string | undefined, current: string | undefined): string {
  const { speech } = readSettings();
  const languages = speech.languages.length > 0 ? speech.languages : ["en-IN"];
  const key = (app ?? "").toLowerCase().replace(/\.exe$/, "");
  const from = current ?? speech.perApp[key] ?? speech.primaryLanguage;
  const position = languages.findIndex((code) => baseCode(code) === baseCode(from));
  const next = languages[(position + 1) % languages.length];
  if (key) updateSettings({ speech: { perApp: { [key]: next } } });
  return next;
}
