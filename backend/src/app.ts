// The Pip backend: HeyClicky's thin Worker, run locally. Route names follow the
// ones compiled into HeyClicky v1.0.52 where a matching feature exists.
import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { environment, homeWebDistDirectory, readSettings, updateSettings } from "./config.js";
import { checkConnector, deleteConnector, listUserConnectors, saveConnector, connectorsForRun, type ConnectorConfig } from "./agents/connectors.js";
import { findCodex } from "./agents/codex.js";
import { proxyOpenAiRequest } from "./agents/openai-proxy.js";
import { createRoutine, deleteRoutine, listRoutines, runRoutineNow, updateRoutine } from "./agents/routines.js";
import { answerPermission, cancelRun, getRun, listRuns, requestPermissionForRun, retryRun, startTask, type PermissionDecision, type Risk } from "./agents/runner.js";
import { agentWorkspace, createAgent, getAgent, listAgents, listOutputFiles, readAgentMessages, updateAgent } from "./agents/store.js";
import { eventBus, type PipEvent } from "./lib/events.js";
import { readConversation, readMemory, writeMemory } from "./lib/memory.js";
import { describeModelPolicy } from "./lib/models.js";
import { webSearch } from "./lib/websearch.js";
import { runTalkTurn, type TalkRequest } from "./talk/chat.js";
import { clickyChat, type AnthropicRequest } from "./talk/clicky-compat.js";
import { cleanupDictation, updateDictionary } from "./talk/dictation.js";
import { appendAsrAudio, asrStatus, cancelAsrSession, finishAsrSession, startAsrSession, transcribeWavFile } from "./speech/asr.js";
import { speechModels, isSpeechModelInstalled, kokoroVoices } from "./speech/catalog.js";
import { synthesize, ttsStatus } from "./speech/tts.js";
import { systemOne, type SystemOneRequest } from "./talk/jev.js";
import { prefetchVision, type ScreenCapture } from "./talk/vision.js";

export const pipVersion = "0.1.0";

async function jsonBody<T>(context: Context): Promise<T> {
  try {
    return (await context.req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function createApp(): Hono {
  const app = new Hono();

  app.onError((error, context) => {
    console.error("[pip]", context.req.method, context.req.path, error);
    return context.json({ error: error.message }, 500);
  });

  // --- health, config, policy -------------------------------------------------
  app.get("/health", (context) => context.json({ ok: true, version: pipVersion }));

  app.get("/app-config", async (context) => {
    const settings = readSettings();
    return context.json({
      version: pipVersion,
      settings,
      speech: { asr: asrStatus(), tts: ttsStatus() },
      agents: { codexInstalled: Boolean(findCodex()), engine: settings.agents.engine },
      search: { provider: environment.searxngUrl ? "searxng" : "duckduckgo" },
    });
  });

  app.get("/flags", (context) => context.json({ alwaysOnMode: false, suggestions: false, skillsLibrary: false }));
  app.get("/runtime/model-policy", async (context) => context.json(await describeModelPolicy()));
  app.get("/runtime/tool-policy", (context) =>
    context.json({ destructiveNeedsApproval: true, alwaysApprove: readSettings().agents.alwaysApprove, risks: ["read", "write", "destructive"] }),
  );

  app.get("/me/settings", (context) => context.json(readSettings()));
  app.put("/me/settings", async (context) => {
    const settings = updateSettings(await jsonBody(context));
    eventBus.publish("settings.changed", { settings });
    return context.json(settings);
  });

  // --- memory -----------------------------------------------------------------
  app.get("/me/memory", (context) => context.json({ ...readMemory(), conversation: readConversation(40) }));
  app.post("/me/memory/save", async (context) => context.json(writeMemory(await jsonBody<{ profile?: string; volatile?: string }>(context))));

  // --- talk -------------------------------------------------------------------
  app.post("/v2/vision/prefetch", async (context) => {
    const body = await jsonBody<{ turnId: string; screens: ScreenCapture[] }>(context);
    if (!body.turnId || !Array.isArray(body.screens)) return context.json({ error: "turnId and screens required" }, 400);
    prefetchVision(body.turnId, body.screens);
    return context.json({ ok: true });
  });

  app.post("/v2/chat", async (context) => {
    const request = await jsonBody<TalkRequest>(context);
    if (typeof request.transcript !== "string") return context.json({ error: "transcript required" }, 400);
    return streamSSE(context, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      try {
        await runTalkTurn(request, (talkEvent) => stream.writeSSE({ event: talkEvent.event, data: JSON.stringify(talkEvent.data) }), abort.signal);
      } catch (error) {
        if (!abort.signal.aborted) await stream.writeSSE({ event: "error", data: JSON.stringify({ message: (error as Error).message }) });
      }
    });
  });

  // Clicky-compatible routes (the open-source Mac app's Worker contract).
  app.post("/chat", async (context) => clickyChat(await jsonBody<AnthropicRequest>(context)));
  // --- local speech (sherpa-onnx: Parakeet in, Kokoro out) ----------------------
  app.get("/v2/speech/models", (context) =>
    context.json({ models: speechModels.map((model) => ({ ...model, installed: isSpeechModelInstalled(model) })), voices: kokoroVoices, asr: asrStatus(), tts: ttsStatus() }),
  );
  const ttsHandler = async (context: Context) => {
    const body = await jsonBody<{ text: string; voice?: string; speed?: number }>(context);
    if (!body.text) return context.json({ error: "text required" }, 400);
    try {
      const audio = await synthesize(body.text, { voice: body.voice, speed: body.speed });
      return new Response(new Uint8Array(audio.pcm), { headers: { "content-type": "audio/l16", "x-sample-rate": String(audio.sampleRate), "x-channels": "1" } });
    } catch (error) {
      return context.json({ error: (error as Error).message }, 503);
    }
  };
  app.post("/tts", ttsHandler);
  app.post("/v2/tts", ttsHandler);
  app.post("/v2/asr/sessions", (context) => context.json({ sessionId: startAsrSession(), sampleRate: 16000, encoding: "pcm_s16le" }));
  app.post("/v2/asr/sessions/:id/audio", async (context) => {
    const result = await appendAsrAudio(context.req.param("id"), new Uint8Array(await context.req.arrayBuffer()));
    return result ? context.json(result) : context.json({ error: "unknown session" }, 404);
  });
  app.post("/v2/asr/sessions/:id/finish", async (context) => {
    try {
      const result = await finishAsrSession(context.req.param("id"));
      return result ? context.json(result) : context.json({ error: "unknown session" }, 404);
    } catch (error) {
      return context.json({ error: (error as Error).message }, 503);
    }
  });
  app.delete("/v2/asr/sessions/:id", (context) => {
    cancelAsrSession(context.req.param("id"));
    return context.json({ ok: true });
  });
  app.post("/v2/dictation/transcribe", async (context) => {
    try {
      return context.json({ text: await transcribeWavFile(new Uint8Array(await context.req.arrayBuffer())) });
    } catch (error) {
      return context.json({ error: (error as Error).message }, 503);
    }
  });

  // --- dictation ----------------------------------------------------------------
  app.post("/v2/dictation/cleanup", async (context) => context.json(await cleanupDictation(await jsonBody(context))));
  app.get("/v2/dictation/dictionary", (context) => context.json({ dictionary: readSettings().dictation.dictionary }));
  app.post("/v2/dictation/dictionary", async (context) => context.json({ dictionary: updateDictionary(await jsonBody(context)) }));

  // --- Jev + the model endpoint agents use ------------------------------------
  app.post("/agent/jev/systemone", async (context) => {
    const body = await jsonBody<SystemOneRequest>(context);
    if (!body.questions || typeof body.questions !== "object") return context.json({ error: "questions required" }, 400);
    return context.json(await systemOne(body));
  });
  app.all("/agent/openai/v1/*", async (context) => {
    const subPath = context.req.path.replace(/^\/agent\/openai\/v1\//, "");
    return proxyOpenAiRequest(subPath, context.req.raw);
  });

  // --- agents (Clickys) and runs ------------------------------------------------
  app.get("/agents", (context) => context.json({ agents: listAgents({ includeArchived: context.req.query("archived") === "1" }) }));
  app.post("/agents", async (context) => {
    const body = await jsonBody<{ name: string; role?: string }>(context);
    if (!body.name) return context.json({ error: "name required" }, 400);
    return context.json({ agent: createAgent({ name: body.name, role: body.role }) });
  });
  app.get("/agents/:id", (context) => {
    const agent = getAgent(context.req.param("id"));
    if (!agent) return context.json({ error: "not found" }, 404);
    return context.json({ agent, runs: listRuns(agent.id).slice(0, 20), routines: listRoutines(agent.id), files: listOutputFiles(agent.id).slice(0, 30) });
  });
  app.patch("/agents/:id", async (context) => {
    const agent = updateAgent(context.req.param("id"), await jsonBody(context));
    return agent ? context.json({ agent }) : context.json({ error: "not found" }, 404);
  });
  app.get("/agents/:id/messages", (context) =>
    context.json({ messages: readAgentMessages(context.req.param("id"), { limit: Number(context.req.query("limit") ?? 50), before: context.req.query("before") }) }),
  );
  app.post("/agents/:id/messages", async (context) => {
    const body = await jsonBody<{ text: string }>(context);
    if (!body.text) return context.json({ error: "text required" }, 400);
    const result = await startTask({ prompt: body.text, agentId: context.req.param("id"), source: "home", skipCancelWindow: true });
    return context.json(result);
  });
  app.get("/agents/:id/files", (context) => context.json({ files: listOutputFiles(context.req.param("id")) }));
  app.get("/agents/:id/files/:name", (context) => {
    const outputDirectory = path.join(agentWorkspace(context.req.param("id")), "output");
    const filePath = path.resolve(outputDirectory, context.req.param("name"));
    if (!filePath.startsWith(path.resolve(outputDirectory)) || !fs.existsSync(filePath)) return context.json({ error: "not found" }, 404);
    return new Response(fs.readFileSync(filePath), { headers: { "content-disposition": `inline; filename="${path.basename(filePath)}"` } });
  });
  app.post("/codex-thread-launch", async (context) => {
    const body = await jsonBody<{ prompt: string; agentId?: string; agentName?: string }>(context);
    if (!body.prompt) return context.json({ error: "prompt required" }, 400);
    return context.json(await startTask({ prompt: body.prompt, agentId: body.agentId, agentName: body.agentName, source: "text" }));
  });

  app.get("/runs", (context) => context.json({ runs: listRuns(context.req.query("agentId")).slice(0, 50) }));
  app.get("/runs/:id", (context) => {
    const run = getRun(context.req.param("id"));
    return run ? context.json({ run }) : context.json({ error: "not found" }, 404);
  });
  app.post("/runs/:id/cancel", (context) => {
    const run = cancelRun(context.req.param("id"));
    return run ? context.json({ run }) : context.json({ error: "not found" }, 404);
  });
  app.post("/runs/:id/permission", async (context) => {
    const body = await jsonBody<{ decision: PermissionDecision }>(context);
    if (!["once", "always", "deny"].includes(body.decision)) return context.json({ error: "decision must be once, always or deny" }, 400);
    return context.json({ ok: answerPermission(context.req.param("id"), body.decision) });
  });
  app.post("/runs/:id/retry", async (context) => context.json(await retryRun(context.req.param("id"))));
  // Called by Pip's MCP servers; resolves when the user answers the card.
  app.post("/agent/runs/:id/permission-requests", async (context) => {
    const body = await jsonBody<{ tool: string; summary: string; risk: Risk }>(context);
    const decision = await requestPermissionForRun(context.req.param("id"), { tool: body.tool, summary: body.summary, risk: body.risk ?? "write" });
    return context.json({ decision });
  });

  // --- routines -------------------------------------------------------------------
  app.get("/agent/cron/list", (context) => context.json({ routines: listRoutines(context.req.query("agentId")) }));
  app.post("/agent/cron", async (context) => {
    const body = await jsonBody<{ agentId: string; prompt: string; everyMinutes: number; runNow?: boolean }>(context);
    if (!body.agentId || !body.prompt || !body.everyMinutes) return context.json({ error: "agentId, prompt and everyMinutes required" }, 400);
    return context.json({ routine: createRoutine(body) });
  });
  app.patch("/agent/cron/:id", async (context) => {
    const routine = updateRoutine(context.req.param("id"), await jsonBody(context));
    return routine ? context.json({ routine }) : context.json({ error: "not found" }, 404);
  });
  app.delete("/agent/cron/:id", (context) => context.json({ ok: deleteRoutine(context.req.param("id")) }));
  app.post("/agent/cron/:id/run-now", async (context) => {
    const routine = await runRoutineNow(context.req.param("id"));
    return routine ? context.json({ routine }) : context.json({ error: "not found" }, 404);
  });

  // --- integrations (MCP connectors) --------------------------------------------
  app.get("/agent/integrations", (context) =>
    context.json({
      integrations: listUserConnectors(),
      builtIn: connectorsForRun().filter((connector) => connector.builtIn).map(({ env: _env, headers: _headers, ...rest }) => rest),
    }),
  );
  app.post("/agent/integrations", async (context) => {
    const body = await jsonBody<Omit<ConnectorConfig, "id"> & { id?: string }>(context);
    if (!body.name || !body.kind) return context.json({ error: "name and kind required" }, 400);
    return context.json({ integration: saveConnector({ ...body, enabled: body.enabled ?? true }) });
  });
  app.delete("/agent/integrations/:id", (context) => context.json({ ok: deleteConnector(context.req.param("id")) }));
  app.post("/agent/integrations/:id/check", async (context) => {
    const connector = [...listUserConnectors(), ...connectorsForRun()].find((candidate) => candidate.id === context.req.param("id"));
    if (!connector) return context.json({ error: "not found" }, 404);
    return context.json(await checkConnector(connector));
  });

  // --- notifications, search ------------------------------------------------------
  app.get("/agent/notifications", (context) =>
    context.json({ notifications: eventBus.recent().filter((event) => ["run.done", "run.failed", "notification", "run.permission"].includes(event.type)).reverse() }),
  );
  app.post("/agent/notifications/read-all", (context) => {
    for (const agent of listAgents()) if (agent.unread > 0) updateAgent(agent.id, { unread: 0 });
    return context.json({ ok: true });
  });
  app.post("/web-search", async (context) => {
    const body = await jsonBody<{ query: string }>(context);
    if (!body.query) return context.json({ error: "query required" }, 400);
    return context.json({ results: await webSearch(body.query) });
  });

  // --- live events for the client's cards and Home --------------------------------
  app.get("/events", (context) =>
    streamSSE(context, async (stream) => {
      const send = (event: PipEvent) => void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      eventBus.on("event", send);
      const keepAlive = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 15_000);
      await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
      clearInterval(keepAlive);
      eventBus.off("event", send);
    }),
  );

  // --- Home (the React app, built into home-web/dist) -----------------------------
  app.get("/home", (context) => context.redirect("/home/"));
  app.get("/home/*", (context) => {
    const relativePath = context.req.path.replace(/^\/home\/?/, "") || "index.html";
    let filePath = path.resolve(homeWebDistDirectory, relativePath);
    if (!filePath.startsWith(path.resolve(homeWebDistDirectory))) return context.text("not found", 404);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(homeWebDistDirectory, "index.html");
    if (!fs.existsSync(filePath)) return context.text("Home isn't built yet. Run: npm run build --prefix home-web", 503);
    const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".wav": "audio/wav" };
    return new Response(fs.readFileSync(filePath), { headers: { "content-type": contentTypes[path.extname(filePath)] ?? "application/octet-stream" } });
  });

  return app;
}
