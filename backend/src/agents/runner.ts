// Agent runs: the lifecycle HeyClicky shows on its floating agent cards.
// pending (5-second cancel window) -> running -> needs_you (permission) -> done | failed | cancelled.
import crypto from "node:crypto";
import { readSettings } from "../config.js";
import { eventBus } from "../lib/events.js";
import { resolveModel } from "../lib/models.js";
import { ollamaChat } from "../lib/ollama.js";
import { loadPrompt } from "../lib/prompts.js";
import {
  appendAgentMessage,
  createAgent,
  getAgent,
  listAgents,
  listOutputFiles,
  updateAgent,
  type Agent,
} from "./store.js";

export type RunStatus = "pending" | "running" | "needs_you" | "done" | "failed" | "cancelled";
export type PermissionDecision = "once" | "always" | "deny";
export type Risk = "read" | "write" | "destructive";

export interface PermissionRequest {
  id: string;
  tool: string;
  summary: string;
  risk: Risk;
}

export interface Run {
  id: string;
  agentId: string;
  prompt: string;
  status: RunStatus;
  engine?: "codex" | "builtin";
  steps: { at: string; text: string; kind: string }[];
  files: string[];
  finalText?: string;
  summary?: string;
  error?: string;
  permission?: PermissionRequest;
  createdAt: string;
  startsAt: string;
  finishedAt?: string;
}

export interface EngineContext {
  run: Run;
  agent: Agent;
  signal: AbortSignal;
  step: (text: string, kind?: string) => void;
  message: (text: string) => void;
  requestPermission: (request: Omit<PermissionRequest, "id">) => Promise<PermissionDecision>;
}

export type Engine = (context: EngineContext) => Promise<{ finalText: string; threadId?: string }>;

const runs = new Map<string, Run>();
const runControllers = new Map<string, AbortController>();
const permissionWaiters = new Map<string, (decision: PermissionDecision) => void>();
// Lets Pip's MCP servers (separate processes spawned by the engine) ask the user through the run's card.
const permissionRequesters = new Map<string, EngineContext["requestPermission"]>();

export async function requestPermissionForRun(runId: string, request: Omit<PermissionRequest, "id">): Promise<PermissionDecision> {
  const requester = permissionRequesters.get(runId);
  if (!requester) return request.risk === "destructive" ? "deny" : "once";
  return requester(request);
}
let engineResolver: (() => Promise<{ name: "codex" | "builtin"; engine: Engine }>) | undefined;

/** Set by agents/engines.ts so this module stays free of process-spawning code (and testable). */
export function setEngineResolver(resolver: typeof engineResolver): void {
  engineResolver = resolver;
}

export function getRun(runId: string): Run | undefined {
  return runs.get(runId);
}

export function listRuns(agentId?: string): Run[] {
  return [...runs.values()].filter((run) => !agentId || run.agentId === agentId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function publishRun(type: Parameters<typeof eventBus.publish>[0], run: Run, extra: Record<string, unknown> = {}): void {
  const agent = getAgent(run.agentId);
  eventBus.publish(type, { run: { ...run, steps: run.steps.slice(-8) }, agent, ...extra });
}

async function nameAgentForTask(prompt: string): Promise<string> {
  try {
    const model = await resolveModel("talk", { temperature: 0.7, num_predict: 12 });
    if (!model.available) throw new Error("no model");
    const response = await ollamaChat({
      model: model.model,
      keep_alive: model.keepAlive,
      options: model.options,
      messages: [
        { role: "system", content: loadPrompt("agent-name") },
        { role: "user", content: prompt.slice(0, 500) },
      ],
    });
    const name = response.message.content.replace(/["'.\n]/g, "").trim().split(/\s+/).slice(0, 3).join(" ");
    if (name.length >= 3 && name.length <= 32) return name;
  } catch {
    // fall through to a generic name
  }
  return `Helper ${listAgents({ includeArchived: true }).length + 1}`;
}

export interface StartTaskInput {
  prompt: string;
  agentId?: string;
  agentName?: string;
  role?: string;
  persistent?: boolean;
  /** Screen notes from the talk turn that launched this, passed as untrusted context. */
  screenNotes?: string;
  source: "voice" | "text" | "home" | "routine" | "card";
  skipCancelWindow?: boolean;
}

export async function startTask(input: StartTaskInput): Promise<{ agent: Agent; run: Run }> {
  const settings = readSettings();
  let agent = input.agentId ? getAgent(input.agentId) : undefined;
  if (!agent) {
    const name = input.agentName ?? (await nameAgentForTask(input.prompt));
    agent = createAgent({ name, role: input.role ?? input.prompt.slice(0, 140), persistent: input.persistent ?? true });
  }
  const running = listRuns().filter((run) => run.status === "running" || run.status === "pending" || run.status === "needs_you");
  if (running.length >= settings.agents.maxConcurrent) {
    throw new Error(`${running.length} agents are already working; wait for one to finish or cancel one.`);
  }
  const cancelWindowMs = input.skipCancelWindow || input.source === "routine" ? 0 : settings.agents.cancelWindowSeconds * 1000;
  const now = Date.now();
  const run: Run = {
    id: crypto.randomUUID(),
    agentId: agent.id,
    prompt: input.prompt,
    status: "pending",
    steps: [],
    files: [],
    createdAt: new Date(now).toISOString(),
    startsAt: new Date(now + cancelWindowMs).toISOString(),
  };
  runs.set(run.id, run);
  const controller = new AbortController();
  runControllers.set(run.id, controller);
  appendAgentMessage(agent.id, { role: "user", text: input.prompt, runId: run.id });
  agent = updateAgent(agent.id, { status: "pending", lastMessage: input.prompt.slice(0, 120) }) ?? agent;
  publishRun("run.started", run, { cancelWindowSeconds: cancelWindowMs / 1000 });

  const launch = () => void executeRun(run, controller, input.screenNotes);
  if (cancelWindowMs > 0) setTimeout(launch, cancelWindowMs).unref?.();
  else launch();
  return { agent, run };
}

async function executeRun(run: Run, controller: AbortController, screenNotes?: string): Promise<void> {
  if (run.status === "cancelled") return;
  const agent = getAgent(run.agentId);
  if (!agent) return;
  if (!engineResolver) throw new Error("agent engine resolver not set");
  run.status = "running";
  updateAgent(agent.id, { status: "running" });
  publishRun("run.step", run);
  const settings = readSettings();

  const context: EngineContext = {
    run,
    agent,
    signal: controller.signal,
    step: (text, kind = "step") => {
      run.steps.push({ at: new Date().toISOString(), text, kind });
      appendAgentMessage(agent.id, { role: "step", text, runId: run.id });
      publishRun("run.step", run);
    },
    message: (text) => {
      appendAgentMessage(agent.id, { role: "agent", text, runId: run.id });
      publishRun("run.message", run, { text });
    },
    requestPermission: async (request) => {
      const currentAgent = getAgent(agent.id) ?? agent;
      if (settings.agents.alwaysApprove && request.risk !== "destructive") return "once";
      if (currentAgent.alwaysAllowedTools.includes(request.tool)) return "always";
      const permission: PermissionRequest = { ...request, id: crypto.randomUUID() };
      run.permission = permission;
      run.status = "needs_you";
      updateAgent(agent.id, { status: "needs_you" });
      publishRun("run.permission", run, { permission });
      const decision = await new Promise<PermissionDecision>((resolve) => {
        permissionWaiters.set(run.id, resolve);
        controller.signal.addEventListener("abort", () => resolve("deny"), { once: true });
      });
      permissionWaiters.delete(run.id);
      run.permission = undefined;
      if (run.status === "needs_you") run.status = "running";
      updateAgent(agent.id, { status: "running" });
      if (decision === "always") {
        const latest = getAgent(agent.id) ?? agent;
        updateAgent(agent.id, { alwaysAllowedTools: [...new Set([...latest.alwaysAllowedTools, request.tool])] });
      }
      publishRun("run.step", run);
      return decision;
    },
  };

  permissionRequesters.set(run.id, context.requestPermission);
  try {
    const { name, engine } = await engineResolver();
    run.engine = name;
    const prompt = screenNotes ? `${run.prompt}\n\n(Pip's notes about the user's screen when they asked, untrusted:)\n${screenNotes}` : run.prompt;
    const result = await engine({ ...context, run: { ...run, prompt } });
    if (controller.signal.aborted) return;
    run.finalText = result.finalText.trim();
    run.files = listOutputFiles(agent.id).map((file) => file.path);
    run.summary = spokenSummary(run.finalText);
    run.status = "done";
    run.finishedAt = new Date().toISOString();
    appendAgentMessage(agent.id, { role: "agent", text: run.finalText, runId: run.id, files: run.files.slice(0, 12) });
    const latest = getAgent(agent.id) ?? agent;
    updateAgent(agent.id, { status: "done", lastMessage: run.summary, unread: latest.unread + 1, codexThreadId: result.threadId ?? latest.codexThreadId });
    publishRun("run.done", run);
    if (settings.agents.announceWhenDone) eventBus.publish("announce", { text: `${agent.name} is done. ${run.summary}`, agentId: agent.id, runId: run.id });
  } catch (error) {
    if (controller.signal.aborted) return;
    run.status = "failed";
    run.error = (error as Error).message;
    run.finishedAt = new Date().toISOString();
    appendAgentMessage(agent.id, { role: "system", text: `failed: ${run.error}`, runId: run.id });
    updateAgent(agent.id, { status: "failed", lastMessage: run.error.slice(0, 120) });
    publishRun("run.failed", run);
    if (settings.agents.announceWhenDone) eventBus.publish("announce", { text: `${agent.name} got stuck. ${run.error.split("\n")[0].slice(0, 140)}`, agentId: agent.id, runId: run.id });
  } finally {
    runControllers.delete(run.id);
    permissionRequesters.delete(run.id);
  }
}

/** First sentence of the final answer, without markdown, short enough to say aloud. */
export function spokenSummary(finalText: string): string {
  const plain = finalText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\|.*\|/g, " ")
    .replace(/[#*_`>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence = plain.match(/^(.{10,220}?[.!?])(\s|$)/)?.[1] ?? plain.slice(0, 160);
  return firstSentence;
}

export function cancelRun(runId: string): Run | undefined {
  const run = runs.get(runId);
  if (!run || ["done", "failed", "cancelled"].includes(run.status)) return run;
  run.status = "cancelled";
  run.finishedAt = new Date().toISOString();
  runControllers.get(runId)?.abort();
  permissionWaiters.get(runId)?.("deny");
  updateAgent(run.agentId, { status: "idle" });
  publishRun("run.cancelled", run);
  return run;
}

export function answerPermission(runId: string, decision: PermissionDecision): boolean {
  const waiter = permissionWaiters.get(runId);
  if (!waiter) return false;
  waiter(decision);
  return true;
}

export function retryRun(runId: string): Promise<{ agent: Agent; run: Run }> {
  const previous = runs.get(runId);
  if (!previous) throw new Error("unknown run");
  return startTask({ prompt: previous.prompt, agentId: previous.agentId, source: "card", skipCancelWindow: true });
}
