// One talk turn, streamed as Server-Sent Events. This replaces HeyClicky's
// Realtime voice session: the client already has the transcript (Deepgram),
// so the backend routes it, looks at the screen (llava, prefetched at
// key-down), answers with a local model, and streams "tag-first beat lines"
// the client speaks one sentence at a time while the buddy points and draws.
import crypto from "node:crypto";
import { readSettings, updateSettings } from "../config.js";
import { startTask } from "../agents/runner.js";
import { findAgentByName, getAgent, listAgents } from "../agents/store.js";
import { eventBus } from "../lib/events.js";
import { appendConversation, appendProfileFact } from "../lib/memory.js";
import { resolveModel, type ResolvedModel } from "../lib/models.js";
import { ollamaChat, ollamaChatStream, type OllamaMessage } from "../lib/ollama.js";
import { loadPrompt } from "../lib/prompts.js";
import type { ActiveApp } from "../lib/skills.js";
import { buildContextMessage, historyMessages } from "./context.js";
import { routeTurn, type Route, type RouteDecision } from "./router.js";
import { BeatStreamParser, buildResolveContext, stripTags, type Beat, type ScreenElement } from "./tags.js";
import { groundDescription, visionForTurn, type ScreenCapture } from "./vision.js";

export interface TalkRequest {
  turnId?: string;
  transcript: string;
  mode?: "voice" | "text";
  screens?: ScreenCapture[];
  elements?: ScreenElement[];
  cursor?: { screen: number; x: number; y: number };
  activeApp?: ActiveApp;
  selectedText?: string;
  documentText?: string;
  /** Talking to one persistent agent (Home chat, or "tell Launch Scout ..."). */
  agentId?: string;
  forceRoute?: Route;
  /** Continue a walkthrough: the user clicked the target, or said "continue". */
  guide?: { sessionId: string; event: "clicked" | "continue" | "skip" | "stop" };
}

export type TalkEvent =
  | { event: "route"; data: RouteDecision & { model?: string } }
  | { event: "beat"; data: Beat }
  | { event: "delta"; data: { text: string } }
  | { event: "insert_text"; data: { text: string } }
  | { event: "guide"; data: { sessionId: string; step: number; maxSteps: number; goal: string; done: boolean; waitForClick: boolean } }
  | { event: "agent"; data: { agentId: string; agentName: string; runId: string; cancelWindowSeconds: number } }
  | { event: "settings"; data: Record<string, unknown> }
  | { event: "done"; data: { text: string; elapsedMs: number } }
  | { event: "error"; data: { message: string } };

type Emit = (event: TalkEvent) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Walkthrough sessions (up to 15 steps; the goal survives pauses and "continue").

interface GuideSession {
  id: string;
  goal: string;
  stepsDone: string[];
  lastInstruction?: string;
  plan?: string[];
  maxSteps: number;
  updatedAt: number;
  finished: boolean;
}

const guideSessions = new Map<string, GuideSession>();
const guideResumeWindowMs = 30 * 60_000;

function latestOpenGuideSession(): GuideSession | undefined {
  const open = [...guideSessions.values()].filter((session) => !session.finished && Date.now() - session.updatedAt < guideResumeWindowMs);
  return open.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

const continuePattern = /^(ok(ay)?[, ]*)?(continue|next|keep going|done|i did it|what'?s next|go on)\b/i;
const tellAgentPattern = /^(tell|ask|have)\s+([a-z0-9][a-z0-9 ]{1,30}?)\s+(to\s+)?(.+)$/i;
const preambles = ["let me look closer.", "one sec, thinking.", "hmm, let me check.", "okay, looking closely."];

// ---------------------------------------------------------------------------

function streamBeatsFactory(emit: Emit, screens: ScreenCapture[], elements: ScreenElement[], defaultScreen: number) {
  const parser = new BeatStreamParser(buildResolveContext(elements, defaultScreen));
  const spokenLines: string[] = [];

  async function resolveAndEmit(beat: Beat): Promise<void> {
    if (beat.unresolved && beat.unresolved.label && screens.length > 0) {
      const grounded = await groundDescription(screens, beat.unresolved.screen, beat.unresolved.label);
      if (grounded) {
        const tag = beat.unresolved.tag.toLowerCase();
        const kind = tag === "shape:circle" ? "circle" : tag === "highlight" ? "highlight" : tag === "target" ? "target" : tag === "hover" ? "hover" : "point";
        const centerX = Math.round(grounded.x + grounded.width / 2);
        const centerY = Math.round(grounded.y + grounded.height / 2);
        const radius = Math.max(18, Math.round(Math.hypot(grounded.width, grounded.height) / 2) + 6);
        beat = {
          text: beat.text,
          visual: {
            kind,
            screen: grounded.screen,
            points: kind === "circle" ? [[centerX, centerY], [centerX + radius, centerY]] : [[centerX, centerY]],
            radius,
            rect: kind === "highlight" ? [grounded.x, grounded.y, grounded.width, grounded.height] : undefined,
            label: beat.unresolved.label,
          },
        };
      } else {
        beat = { text: beat.text };
      }
    }
    if (beat.text) spokenLines.push(beat.text);
    await emit({ event: "beat", data: beat });
  }

  return {
    async push(delta: string) {
      await emit({ event: "delta", data: { text: delta } });
      for (const beat of parser.push(delta)) await resolveAndEmit(beat);
    },
    async flush() {
      for (const beat of parser.flush()) await resolveAndEmit(beat);
      return spokenLines.join("\n");
    },
  };
}

async function streamAnswer(model: ResolvedModel, messages: OllamaMessage[], sink: { push: (delta: string) => Promise<void> }, signal?: AbortSignal): Promise<string> {
  let fullText = "";
  for await (const chunk of ollamaChatStream({ model: model.model, keep_alive: model.keepAlive, options: model.options, messages }, signal)) {
    const delta = chunk.message?.content ?? "";
    if (!delta) continue;
    fullText += delta;
    await sink.push(delta);
  }
  return fullText;
}

export async function runTalkTurn(request: TalkRequest, emit: Emit, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  const transcript = request.transcript.trim();
  const elements = request.elements ?? [];
  const defaultScreen = request.cursor?.screen ?? request.screens?.find((screen) => screen.isCursorScreen)?.index ?? 0;

  // Walkthrough continuation (explicit, or a spoken "continue" while a walkthrough is open).
  let guideSession = request.guide ? guideSessions.get(request.guide.sessionId) : undefined;
  if (!guideSession && transcript && continuePattern.test(transcript)) guideSession = latestOpenGuideSession();
  if (guideSession && request.guide?.event === "stop") {
    guideSession.finished = true;
    await emit({ event: "done", data: { text: "", elapsedMs: Date.now() - startedAt } });
    return;
  }

  // "tell Launch Scout to ..." routes to that agent from anywhere.
  let agentId = request.agentId;
  let agentPrompt = transcript;
  const tellMatch = !agentId && transcript.match(tellAgentPattern);
  if (tellMatch) {
    const agent = findAgentByName(tellMatch[2]);
    if (agent) {
      agentId = agent.id;
      agentPrompt = tellMatch[4];
    }
  }

  let decision: RouteDecision;
  if (guideSession) decision = { route: "guide", reason: "continuing walkthrough", by: "rule" };
  else if (agentId) decision = { route: "agent", reason: "addressed to an agent", by: "rule" };
  else if (request.forceRoute) decision = { route: request.forceRoute, reason: "forced", by: "rule" };
  else decision = await routeTurn(transcript, request.activeApp?.name ?? request.activeApp?.process);

  if (transcript) appendConversation({ role: "user", text: transcript, mode: request.mode });

  switch (decision.route) {
    case "memory":
      return handleMemory(transcript, decision, emit, startedAt);
    case "settings":
      return handleSettings(transcript, decision, emit, startedAt);
    case "agent":
      return handleAgent(request, agentPrompt, agentId, decision, emit, startedAt);
    default:
      break;
  }

  const vision = await visionForTurn(request.turnId, request.screens);
  const contextMessage = buildContextMessage({
    screenDescription: vision.description,
    screens: vision.screens,
    elements,
    cursor: request.cursor,
    activeApp: request.activeApp,
    selectedText: request.selectedText,
    documentText: request.documentText,
  });
  const beats = streamBeatsFactory(emit, vision.screens, elements, defaultScreen);

  if (decision.route === "draft") return handleDraft(transcript, contextMessage, decision, emit, startedAt);
  if (decision.route === "guide") return handleGuide(request, transcript, guideSession, contextMessage, beats, decision, emit, startedAt, signal);

  // quick / deep answers.
  let model = await resolveModel(decision.route === "deep" ? "deep" : "talk");
  if (decision.route === "deep" && !model.available) model = await resolveModel("talk", { num_predict: 600 });
  await emit({ event: "route", data: { ...decision, model: model.model } });
  if (decision.route === "deep") {
    // Speak early while the big model loads, like HeyClicky's five-word preamble.
    await emit({ event: "beat", data: { text: preambles[crypto.randomInt(preambles.length)] } });
  }
  const historyBudget = decision.route === "deep" ? 24000 : 5000;
  const history = historyMessages(historyBudget);
  // The current transcript was just appended to the log; it goes in below with the screen context instead.
  if (transcript && history.at(-1)?.role === "user" && history.at(-1)?.content === transcript) history.pop();
  const messages: OllamaMessage[] = [
    { role: "system", content: loadPrompt("talk") },
    ...history,
    { role: "user", content: `${contextMessage}\n\nUSER SAID: ${transcript}` },
  ];
  const fullText = await streamAnswer(model, messages, beats, signal);
  const spoken = await beats.flush();
  appendConversation({ role: "assistant", text: stripTags(fullText) || spoken, mode: request.mode });
  await emit({ event: "done", data: { text: spoken, elapsedMs: Date.now() - startedAt } });
}

async function handleMemory(transcript: string, decision: RouteDecision, emit: Emit, startedAt: number) {
  await emit({ event: "route", data: decision });
  const fact = transcript.replace(/^(please\s+)?(remember|don'?t forget|note)\s+(that\s+)?/i, "").replace(/[.!]+$/, "").trim();
  if (fact) appendProfileFact(fact.charAt(0).toUpperCase() + fact.slice(1));
  const reply = "got it, i'll remember that.";
  await emit({ event: "beat", data: { text: reply } });
  appendConversation({ role: "assistant", text: reply });
  await emit({ event: "done", data: { text: reply, elapsedMs: Date.now() - startedAt } });
}

async function handleSettings(transcript: string, decision: RouteDecision, emit: Emit, startedAt: number) {
  await emit({ event: "route", data: decision });
  const model = await resolveModel("router", { num_predict: 120 });
  let spoken = "you can change that in settings, in home.";
  try {
    const settings = readSettings();
    const response = await ollamaChat({
      model: model.model,
      keep_alive: model.keepAlive,
      options: model.options,
      format: "json",
      messages: [
        { role: "system", content: loadPrompt("settings") },
        { role: "user", content: `SETTINGS: ${JSON.stringify({ voice: settings.voice, cursor: settings.cursor, agents: { announceWhenDone: settings.agents.announceWhenDone }, dictation: { cleanup: settings.dictation.cleanup } })}\nREQUEST: ${transcript}` },
      ],
    });
    const changes = JSON.parse(response.message.content) as Record<string, unknown>;
    spoken = typeof changes.spoken === "string" && changes.spoken ? changes.spoken : spoken;
    const patch: Record<string, Record<string, unknown>> = {};
    const allowedKeys = ["voice.speed", "voice.voiceName", "cursor.showBuddy", "cursor.followCursor", "agents.announceWhenDone", "dictation.cleanup"];
    for (const key of allowedKeys) {
      if (!(key in changes)) continue;
      const [section, field] = key.split(".");
      let value = changes[key];
      if (key === "voice.speed") value = Math.max(0.5, Math.min(1.5, Number(value) || 1));
      patch[section] = { ...(patch[section] ?? {}), [field]: value };
    }
    if (Object.keys(patch).length > 0) {
      const updated = updateSettings(patch);
      eventBus.publish("settings.changed", { settings: updated });
      await emit({ event: "settings", data: { settings: updated } });
    }
  } catch (error) {
    console.warn("[settings] failed:", (error as Error).message);
  }
  await emit({ event: "beat", data: { text: spoken } });
  appendConversation({ role: "assistant", text: spoken });
  await emit({ event: "done", data: { text: spoken, elapsedMs: Date.now() - startedAt } });
}

async function handleAgent(request: TalkRequest, prompt: string, agentId: string | undefined, decision: RouteDecision, emit: Emit, startedAt: number) {
  await emit({ event: "route", data: decision });
  let screenNotes: string | undefined;
  if (request.turnId || request.screens?.length) {
    screenNotes = (await visionForTurn(request.turnId, request.screens).catch(() => ({ description: "" }))).description || undefined;
  }
  try {
    const existing = agentId ? getAgent(agentId) : undefined;
    const { agent, run } = await startTask({ prompt, agentId: existing?.id, screenNotes, source: request.mode === "text" ? "text" : "voice" });
    const cancelWindowSeconds = readSettings().agents.cancelWindowSeconds;
    await emit({ event: "agent", data: { agentId: agent.id, agentName: agent.name, runId: run.id, cancelWindowSeconds } });
    const reply = existing ? `okay, passing that to ${agent.name}.` : `on it. ${agent.name} is starting now.`;
    await emit({ event: "beat", data: { text: reply } });
    appendConversation({ role: "assistant", text: reply });
    await emit({ event: "done", data: { text: reply, elapsedMs: Date.now() - startedAt } });
  } catch (error) {
    const reply = `i couldn't start that. ${(error as Error).message}`;
    await emit({ event: "beat", data: { text: reply } });
    await emit({ event: "done", data: { text: reply, elapsedMs: Date.now() - startedAt } });
  }
}

async function handleDraft(transcript: string, contextMessage: string, decision: RouteDecision, emit: Emit, startedAt: number) {
  const model = await resolveModel("talk", { temperature: 0.5, num_predict: 500 });
  await emit({ event: "route", data: { ...decision, model: model.model } });
  const response = await ollamaChat({
    model: model.model,
    keep_alive: model.keepAlive,
    options: model.options,
    messages: [
      { role: "system", content: loadPrompt("draft") },
      { role: "user", content: `${contextMessage}\n\nWHAT TO WRITE: ${transcript}` },
    ],
  });
  const draft = response.message.content.trim().replace(/^["“]|["”]$/g, "").replace(/\s*[—–]\s*/g, ", ");
  await emit({ event: "insert_text", data: { text: draft } });
  const reply = "there you go, take a look before you send it.";
  await emit({ event: "beat", data: { text: reply } });
  appendConversation({ role: "assistant", text: `(drafted) ${draft}` });
  await emit({ event: "done", data: { text: reply, elapsedMs: Date.now() - startedAt } });
}

async function handleGuide(
  request: TalkRequest,
  transcript: string,
  existingSession: GuideSession | undefined,
  contextMessage: string,
  beats: ReturnType<typeof streamBeatsFactory>,
  decision: RouteDecision,
  emit: Emit,
  startedAt: number,
  signal?: AbortSignal,
) {
  let session = existingSession;
  if (!session) {
    session = { id: crypto.randomUUID(), goal: transcript, stepsDone: [], maxSteps: 15, updatedAt: Date.now(), finished: false };
    guideSessions.set(session.id, session);
    // The deep model writes a plan in the background when it's available; steps use it once ready.
    void planWalkthrough(session, contextMessage);
  } else if (session.lastInstruction && request.guide?.event !== "skip") {
    session.stepsDone.push(session.lastInstruction);
  }
  session.updatedAt = Date.now();
  const stepNumber = session.stepsDone.length + 1;
  const model = await resolveModel("talk", { num_predict: 120, temperature: 0.2 });
  await emit({ event: "route", data: { ...decision, model: model.model } });

  if (stepNumber > session.maxSteps) {
    session.finished = true;
    const reply = "that's fifteen steps, so let's pause here. ask me again if you're still stuck.";
    await emit({ event: "beat", data: { text: reply } });
    await emit({ event: "guide", data: { sessionId: session.id, step: stepNumber, maxSteps: session.maxSteps, goal: session.goal, done: true, waitForClick: false } });
    await emit({ event: "done", data: { text: reply, elapsedMs: Date.now() - startedAt } });
    return;
  }

  const planText = session.plan ? `\nPLAN (a guide, the screen wins): ${session.plan.map((step, index) => `${index + 1}. ${step}`).join(" ")}` : "";
  const messages: OllamaMessage[] = [
    { role: "system", content: loadPrompt("guide") },
    {
      role: "user",
      content: `${contextMessage}\n\nGOAL: ${session.goal}\nSTEPS DONE: ${session.stepsDone.length ? session.stepsDone.map((step, index) => `${index + 1}. ${step}`).join(" ") : "none yet"}${planText}\n${request.guide || continuePattern.test(transcript) ? "" : `USER SAID: ${transcript}`}\nwrite step ${stepNumber}.`,
    },
  ];
  const fullText = await streamAnswer(model, messages, beats, signal);
  const spoken = await beats.flush();
  const finished = /\[DONE\]/i.test(fullText);
  const waitsForClick = /\[(TARGET|HOVER):/i.test(fullText);
  session.lastInstruction = stripTags(fullText).split("\n")[0] ?? "";
  session.finished = finished;
  appendConversation({ role: "assistant", text: stripTags(fullText) });
  await emit({ event: "guide", data: { sessionId: session.id, step: stepNumber, maxSteps: session.maxSteps, goal: session.goal, done: finished, waitForClick: waitsForClick && !finished } });
  await emit({ event: "done", data: { text: spoken, elapsedMs: Date.now() - startedAt } });
}

async function planWalkthrough(session: GuideSession, contextMessage: string): Promise<void> {
  try {
    const model = await resolveModel("deep", { num_predict: 500 });
    if (!model.available) return;
    const response = await ollamaChat({
      model: model.model,
      keep_alive: model.keepAlive,
      options: model.options,
      format: { type: "object", properties: { app: { type: "string" }, steps: { type: "array", items: { type: "string" }, maxItems: 15 } }, required: ["steps"] },
      messages: [
        { role: "system", content: loadPrompt("guide-plan") },
        { role: "user", content: `${contextMessage}\n\nGOAL: ${session.goal}` },
      ],
    });
    session.plan = (JSON.parse(response.message.content) as { steps: string[] }).steps.slice(0, 15);
  } catch (error) {
    console.warn("[guide] planning failed:", (error as Error).message);
  }
}

export function listOpenAgentsForPrompt(): string {
  return listAgents().map((agent) => `${agent.name} (${agent.status})`).join(", ");
}
