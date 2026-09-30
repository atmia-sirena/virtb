// Paths, environment and user settings for the local backend.
// State lives in plain files, like HeyClicky's Markdown memory: no database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisFileDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (backend/src or backend/dist -> repo). */
export const repositoryRootDirectory = path.resolve(thisFileDirectory, "..", "..");
export const sharedDirectory = path.join(repositoryRootDirectory, "shared");
export const homeWebDistDirectory = path.join(repositoryRootDirectory, "home-web", "dist");

function defaultStateDirectory(): string {
  if (process.env.PIP_STATE_DIR) return process.env.PIP_STATE_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "Pip");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Pip");
  return path.join(os.homedir(), ".pip");
}

export const stateDirectory = defaultStateDirectory();
export const memoryDirectory = path.join(stateDirectory, "memory");
export const agentsDirectory = path.join(stateDirectory, "agents");
export const codexHomeDirectory = path.join(stateDirectory, "codex");

export function ensureStateDirectories(): void {
  for (const directory of [stateDirectory, memoryDirectory, agentsDirectory, codexHomeDirectory]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

/** Loads backend/.env (KEY=value lines) without overriding real environment variables. */
export function loadDotEnvFile(): void {
  const dotEnvPath = path.join(repositoryRootDirectory, "backend", ".env");
  if (!fs.existsSync(dotEnvPath)) return;
  for (const rawLine of fs.readFileSync(dotEnvPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const environment = {
  get port(): number {
    return Number(process.env.PIP_PORT ?? 8787);
  },
  get ollamaBaseUrl(): string {
    return (process.env.OLLAMA_HOST_URL ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "").replace(/^(?!https?:\/\/)/, "http://");
  },
  /** Optional self-hosted SearXNG (open source) for web search; DuckDuckGo otherwise. No API keys anywhere. */
  get searxngUrl(): string | undefined {
    return process.env.PIP_SEARXNG_URL || undefined;
  },
};

export type ModelJob = "router" | "talk" | "deep" | "vision" | "grounding" | "jev" | "cleanup" | "memory" | "agent";

export interface PipSettings {
  voice: {
    /** Kokoro speaker name (af_heart, am_michael, bf_emma...). */
    voiceName: string;
    speed: number;
    language: string;
  };
  speech: {
    /** Local speech models from speech/catalog.ts, run in-process with sherpa-onnx. */
    asrModel: string;
    ttsModel: string;
    threads: number;
  };
  shortcuts: {
    talk: string;
    dictate: string;
    textMode: string;
  };
  dictation: {
    cleanup: boolean;
    skipCleanupUnderWords: number;
    dictionary: string[];
  };
  cursor: {
    color: string;
    followCursor: boolean;
    showBuddy: boolean;
  };
  agents: {
    engine: "auto" | "codex" | "builtin";
    announceWhenDone: boolean;
    alwaysApprove: boolean;
    cancelWindowSeconds: number;
    maxConcurrent: number;
  };
  models: Record<ModelJob, string>;
  onboarding: { completed: boolean };
}

export const defaultSettings: PipSettings = {
  voice: { voiceName: "af_heart", speed: 1, language: "auto" },
  speech: { asrModel: "parakeet-tdt-0.6b-v3", ttsModel: "kokoro-v1.0", threads: 4 },
  shortcuts: { talk: "Ctrl+Win (hold)", dictate: "RightCtrl (hold)", textMode: "Ctrl (double-tap)" },
  dictation: { cleanup: true, skipCleanupUnderWords: 4, dictionary: [] },
  cursor: { color: "#3380FF", followCursor: true, showBuddy: true },
  agents: { engine: "auto", announceWhenDone: true, alwaysApprove: false, cancelWindowSeconds: 5, maxConcurrent: 5 },
  // Named Ollama models created by scripts/setup-models (options baked in); the
  // model policy falls back to the base model plus inline options when an alias is missing.
  models: {
    router: "pip-fast",
    talk: "pip-fast",
    deep: "pip-deep",
    vision: "pip-vision",
    grounding: "qwen2.5vl:7b",
    jev: "pip-jev",
    cleanup: "pip-fast",
    memory: "pip-fast",
    agent: "pip-agent",
  },
  onboarding: { completed: false },
};

const settingsPath = () => path.join(stateDirectory, "settings.json");

function deepMerge<T>(base: T, override: unknown): T {
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return (override === undefined ? base : (override as T));
  }
  if (typeof override !== "object" || override === null) return base;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result as T;
}

let cachedSettings: PipSettings | undefined;

export function readSettings(): PipSettings {
  if (cachedSettings) return cachedSettings;
  try {
    const stored = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    cachedSettings = deepMerge(defaultSettings, stored);
  } catch {
    cachedSettings = structuredClone(defaultSettings);
  }
  return cachedSettings;
}

export function updateSettings(partialSettings: unknown): PipSettings {
  const merged = deepMerge(readSettings(), partialSettings);
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
  cachedSettings = merged;
  return merged;
}

export function resetSettingsCacheForTests(): void {
  cachedSettings = undefined;
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
  fs.renameSync(temporaryPath, filePath);
}
