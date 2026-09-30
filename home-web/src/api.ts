// Typed calls to the local backend (same origin: http://127.0.0.1:8787).

export type AgentStatus = "idle" | "pending" | "running" | "needs_you" | "done" | "failed";

export interface Agent {
  id: string;
  name: string;
  role: string;
  face: string;
  persistent: boolean;
  pinned: boolean;
  archived: boolean;
  unread: number;
  status: AgentStatus;
  lastMessage?: string;
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "agent" | "step" | "system";
  text: string;
  runId?: string;
  at: string;
  files?: string[];
}

export interface PermissionRequest {
  id: string;
  tool: string;
  summary: string;
  risk: "read" | "write" | "destructive";
}

export interface Run {
  id: string;
  agentId: string;
  prompt: string;
  status: "pending" | "running" | "needs_you" | "done" | "failed" | "cancelled";
  steps: { at: string; text: string; kind: string }[];
  summary?: string;
  error?: string;
  permission?: PermissionRequest;
  startsAt: string;
  createdAt: string;
}

export interface Routine {
  id: string;
  agentId: string;
  prompt: string;
  everyMinutes: number;
  nextRunAt: string;
  paused: boolean;
  lastStatus?: string;
  lastRunAt?: string;
}

export interface OutputFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export interface Connector {
  id: string;
  name: string;
  kind: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  enabled: boolean;
  builtIn?: boolean;
}

export interface Settings {
  voice: { voiceName: string; speed: number; language: string };
  speech: { asrModel: string; ttsModel: string; threads: number };
  shortcuts: { talk: string; dictate: string; textMode: string };
  dictation: { cleanup: boolean; skipCleanupUnderWords: number; dictionary: string[] };
  cursor: { color: string; followCursor: boolean; showBuddy: boolean };
  agents: { engine: "auto" | "codex" | "builtin"; announceWhenDone: boolean; alwaysApprove: boolean; cancelWindowSeconds: number; maxConcurrent: number };
  models: Record<string, string>;
  onboarding: { completed: boolean };
}

export interface SpeechModelInfo {
  id: string;
  kind: "asr" | "tts";
  description: string;
  license: string;
  approximateMegabytes: number;
  installed: boolean;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${response.status}`;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // not json
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export const api = {
  appConfig: () => request<{ version: string; settings: Settings; agents: { codexInstalled: boolean }; speech: { asr: { model: string; installed: boolean }; tts: { model: string; installed: boolean } } }>("GET", "/app-config"),
  settings: () => request<Settings>("GET", "/me/settings"),
  saveSettings: (patch: unknown) => request<Settings>("PUT", "/me/settings", patch),
  agents: (archived = false) => request<{ agents: Agent[] }>("GET", `/agents${archived ? "?archived=1" : ""}`),
  agent: (agentId: string) => request<{ agent: Agent; runs: Run[]; routines: Routine[]; files: OutputFile[] }>("GET", `/agents/${agentId}`),
  createAgent: (name: string, role: string) => request<{ agent: Agent }>("POST", "/agents", { name, role }),
  updateAgent: (agentId: string, changes: Partial<Agent>) => request<{ agent: Agent }>("PATCH", `/agents/${agentId}`, changes),
  messages: (agentId: string, before?: string) => request<{ messages: AgentMessage[] }>("GET", `/agents/${agentId}/messages?limit=60${before ? `&before=${before}` : ""}`),
  send: (agentId: string, text: string) => request<{ agent: Agent; run: Run }>("POST", `/agents/${agentId}/messages`, { text }),
  launch: (prompt: string) => request<{ agent: Agent; run: Run }>("POST", "/codex-thread-launch", { prompt }),
  cancelRun: (runId: string) => request<{ run: Run }>("POST", `/runs/${runId}/cancel`),
  retryRun: (runId: string) => request<{ run: Run }>("POST", `/runs/${runId}/retry`),
  answerPermission: (runId: string, decision: "once" | "always" | "deny") => request<{ ok: boolean }>("POST", `/runs/${runId}/permission`, { decision }),
  routines: (agentId: string) => request<{ routines: Routine[] }>("GET", `/agent/cron/list?agentId=${agentId}`),
  createRoutine: (agentId: string, prompt: string, everyMinutes: number) => request<{ routine: Routine }>("POST", "/agent/cron", { agentId, prompt, everyMinutes }),
  updateRoutine: (routineId: string, changes: Partial<Routine>) => request<{ routine: Routine }>("PATCH", `/agent/cron/${routineId}`, changes),
  deleteRoutine: (routineId: string) => request<{ ok: boolean }>("DELETE", `/agent/cron/${routineId}`),
  runRoutineNow: (routineId: string) => request<{ routine: Routine }>("POST", `/agent/cron/${routineId}/run-now`),
  integrations: () => request<{ integrations: Connector[]; builtIn: Connector[] }>("GET", "/agent/integrations"),
  saveIntegration: (connector: Partial<Connector>) => request<{ integration: Connector }>("POST", "/agent/integrations", connector),
  deleteIntegration: (connectorId: string) => request<{ ok: boolean }>("DELETE", `/agent/integrations/${connectorId}`),
  checkIntegration: (connectorId: string) => request<{ ok: boolean; toolCount?: number; error?: string }>("POST", `/agent/integrations/${connectorId}/check`),
  memory: () => request<{ profile: string; volatile: string; conversation: { role: string; text: string; at: string }[] }>("GET", "/me/memory"),
  saveMemory: (files: { profile?: string; volatile?: string }) => request<{ profile: string; volatile: string }>("POST", "/me/memory/save", files),
  modelPolicy: () => request<{ installed: string[]; jobs: Record<string, { model: string; available: boolean }> }>("GET", "/runtime/model-policy"),
  speechModels: () => request<{ models: SpeechModelInfo[]; voices: string[] }>("GET", "/v2/speech/models"),
  dictionary: (change: { add?: string[]; remove?: string[] }) => request<{ dictionary: string[] }>("POST", "/v2/dictation/dictionary", change),
  readAll: () => request<{ ok: boolean }>("POST", "/agent/notifications/read-all"),
};

export function fileUrl(agentId: string, fileName: string): string {
  return `/agents/${agentId}/files/${encodeURIComponent(fileName)}`;
}

let previewContext: AudioContext | undefined;

/** Plays the backend's raw PCM16 voice audio (used for voice previews). */
export async function playVoicePreview(text: string, voice: string, speed: number): Promise<void> {
  const response = await fetch("/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice, speed }) });
  if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "voice unavailable");
  const sampleRate = Number(response.headers.get("x-sample-rate") ?? 24000);
  const bytes = new DataView(await response.arrayBuffer());
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.getInt16(index * 2, true) / 32768;
  previewContext ??= new AudioContext();
  const buffer = previewContext.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = previewContext.createBufferSource();
  source.buffer = buffer;
  source.connect(previewContext.destination);
  source.start();
}

// ---------------------------------------------------------------------------
// Host bridge: messages to the Windows client hosting this page in WebView2.

interface WebViewHost {
  postMessage: (message: unknown) => void;
  addEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
}

function webviewHost(): WebViewHost | undefined {
  return (window as unknown as { chrome?: { webview?: WebViewHost } }).chrome?.webview;
}

export const host = {
  available: () => Boolean(webviewHost()),
  send: (message: { type: string; [key: string]: unknown }) => webviewHost()?.postMessage(message),
  onMessage: (listener: (message: { type: string; [key: string]: unknown }) => void) => webviewHost()?.addEventListener("message", (event) => listener(event.data as { type: string })),
};
