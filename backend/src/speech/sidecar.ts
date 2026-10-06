// Client for the local GPU speech server (speech-server/, Python, 127.0.0.1:8790),
// and the process that runs it. Everything here degrades to "not available"
// quickly so dictation never waits on a server that isn't running.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readSettings, stateDirectory } from "../config.js";
import { modelsDirectory } from "./catalog.js";

export function speechServerUrl(): string {
  return (process.env.PIP_SPEECH_SERVER_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
}

let healthy: boolean | undefined;
let checkedAt = 0;

export async function speechServerHealthy(maxAgeMs = 10_000): Promise<boolean> {
  if (process.env.PIP_SPEECH_SERVER === "off") return false;
  if (healthy !== undefined && Date.now() - checkedAt < maxAgeMs) return healthy;
  try {
    const response = await fetch(`${speechServerUrl()}/health`, { signal: AbortSignal.timeout(400) });
    healthy = response.ok;
  } catch {
    healthy = false;
  }
  checkedAt = Date.now();
  return healthy;
}

export function markSpeechServer(state: boolean | undefined): void {
  healthy = state;
  checkedAt = state === undefined ? 0 : Date.now();
}

/** IndicXlit in the speech server: native-script words -> Latin. Undefined when the server isn't up. */
export async function transliterateToLatin(words: string[], language = "hi"): Promise<(string | undefined)[] | undefined> {
  if (words.length === 0 || !(await speechServerHealthy())) return undefined;
  try {
    const response = await fetch(`${speechServerUrl()}/xlit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ words, source: language, target: "en" }),
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { words?: (string | null)[] };
    return body.words?.map((word) => word ?? undefined);
  } catch {
    return undefined;
  }
}

export class SpeechServerError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** JSON (or raw bytes) to the speech server; marks it unhealthy on connection errors. */
export async function speechServerRequest<T>(route: string, body: unknown, timeoutMs: number): Promise<T> {
  const isBytes = body instanceof Uint8Array;
  let response: Response;
  try {
    response = await fetch(`${speechServerUrl()}${route}`, {
      method: "POST",
      headers: { "content-type": isBytes ? "application/octet-stream" : "application/json" },
      body: isBytes ? new Uint8Array(body as Uint8Array) : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    markSpeechServer(false);
    throw new SpeechServerError(`speech server unreachable: ${(error as Error).message}`);
  }
  if (!response.ok) throw new SpeechServerError(`speech server ${route}: ${response.status} ${await response.text()}`, response.status);
  return (await response.json()) as T;
}

// --- running it ----------------------------------------------------------------

let child: ChildProcess | undefined;

/**
 * Starts speech-server/ when PIP_SPEECH_SERVER points at it (scripts/setup.ps1
 * sets this after `uv sync`). Uses its venv's Python; warms the models for
 * your languages.
 */
export function startSpeechServer(): boolean {
  const folder = process.env.PIP_SPEECH_SERVER;
  if (!folder || folder === "off" || child) return false;
  const python = [path.join(folder, ".venv", "Scripts", "python.exe"), path.join(folder, ".venv", "bin", "python")].find((candidate) => fs.existsSync(candidate));
  if (!python) {
    console.warn(`[pip] PIP_SPEECH_SERVER=${folder} has no .venv; run \`uv sync --extra gpu --extra qwen\` there.`);
    return false;
  }
  const port = new URL(speechServerUrl()).port || "8790";
  const languages = readSettings().speech.languages.join(",");
  child = spawn(python, ["-m", "pip_speech", "--port", port, "--warm-languages", languages], {
    cwd: folder,
    env: { ...process.env, PIP_STATE_DIR: stateDirectory, PIP_MODELS_DIR: modelsDirectory() },
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  child.on("exit", (code) => {
    console.warn(`[pip] speech server exited (${code}); dictation falls back to Parakeet on the CPU.`);
    child = undefined;
    markSpeechServer(false);
  });
  // index.ts exits on SIGINT/SIGTERM; take the speech server down with it.
  process.once("exit", () => child?.kill());
  return true;
}
