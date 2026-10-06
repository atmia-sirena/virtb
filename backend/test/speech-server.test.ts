// The backend against a stand-in GPU speech server: session proxying, language
// and timed words flowing into cleanup, per-app language learning, CPU fallback,
// and the language settings routes.
import fs from "node:fs";
import path from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { readSettings, resetSettingsCacheForTests, stateDirectory, updateSettings } from "../src/config.js";
import { markSpeechServer } from "../src/speech/sidecar.js";

const app = createApp();
let server: ServerType;
const calls: { path: string; body: unknown }[] = [];
let failFinish = false;

beforeAll(async () => {
  const fake = new Hono();
  fake.get("/health", (context) => context.json({ ok: true, device: "cuda", engines: {} }));
  fake.post("/sessions", async (context) => {
    calls.push({ path: "/sessions", body: await context.req.json() });
    return context.json({ sessionId: "remote-1" });
  });
  fake.post("/sessions/:id/audio", async (context) => {
    const bytes = new Uint8Array(await context.req.arrayBuffer());
    calls.push({ path: "audio", body: bytes.length });
    return context.json({ text: "कल meeting", language: "hi" });
  });
  fake.post("/sessions/:id/finish", async (context) => {
    calls.push({ path: "finish", body: await context.req.json().catch(() => ({})) });
    if (failFinish) return context.json({ error: "gpu fell over" }, 500);
    return context.json({
      text: "कल meeting पांच बजे है नहीं नहीं छह बजे है",
      language: "hinglish",
      model: "qwen3-asr-1.7b",
      confidence: 0.93,
      words: ["कल", "meeting", "पांच", "बजे", "है", "नहीं", "नहीं", "छह", "बजे", "है"].map((w, index) => ({ w, start: index * 0.4, end: index * 0.4 + 0.3, conf: 0.9 })),
    });
  });
  fake.delete("/sessions/:id", (context) => context.json({ ok: true }));
  fake.post("/xlit", async (context) => {
    const body = (await context.req.json()) as { words: string[] };
    return context.json({ words: body.words.map((word) => (word === "स्लो" ? "slow" : null)) });
  });
  const port: number = await new Promise((resolve) => {
    server = serve({ fetch: fake.fetch, hostname: "127.0.0.1", port: 0 }, (info) => resolve(info.port));
  });
  process.env.PIP_SPEECH_SERVER = "";
  process.env.PIP_SPEECH_SERVER_URL = `http://127.0.0.1:${port}`;
  resetSettingsCacheForTests();
  updateSettings({ dictation: { llmPass: "off", dictionary: ["Pip"] } });
});
afterAll(() => {
  process.env.PIP_SPEECH_SERVER = "off";
  server.close();
});
beforeEach(() => {
  markSpeechServer(undefined);
  calls.splice(0);
  failFinish = false;
});

const post = async (route: string, body?: unknown) => {
  const response = await app.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const postBytes = async (route: string, bytes: Uint8Array) => (await app.request(route, { method: "POST", body: bytes })).json();

describe("dictation through the speech server", () => {
  it("proxies the session and passes language, prior and dictionary", async () => {
    updateSettings({ speech: { perApp: { "whatsapp": "hinglish" } } });
    const created = await post("/v2/asr/sessions", { app: { process: "WhatsApp.exe" } });
    expect(created.body.engine).toBe("sidecar");
    expect(calls[0].body).toMatchObject({ languages: ["en-IN", "hi", "hinglish"], prior: "hinglish", context: ["Pip"] });
    const live = await postBytes(`/v2/asr/sessions/${created.body.sessionId}/audio`, new Uint8Array(3200));
    expect(live).toEqual({ text: "कल meeting", language: "hi" });
    const final = await post(`/v2/asr/sessions/${created.body.sessionId}/finish`);
    expect(final.body).toMatchObject({ language: "hinglish", engine: "sidecar", model: "qwen3-asr-1.7b" });
    expect(final.body.words).toHaveLength(10);

    // Cleanup picks up the session's language and words: backtrack + romanized Hinglish.
    const cleaned = await post("/v2/dictation/cleanup", { text: final.body.text, sessionId: created.body.sessionId, app: { process: "WhatsApp.exe" } });
    expect(cleaned.body).toMatchObject({ text: "Kal meeting chhe baje hai.", language: "hinglish" });
  });

  it("passes a mid-utterance language switch to the speech server", async () => {
    const created = await post("/v2/asr/sessions", {});
    await post(`/v2/asr/sessions/${created.body.sessionId}/finish`, { language: "ta" });
    expect(calls.find((call) => call.path === "finish")?.body).toEqual({ language: "ta" });
  });

  it("learns the app's language for next time", async () => {
    const created = await post("/v2/asr/sessions", { app: { process: "slack.exe" } });
    await post(`/v2/asr/sessions/${created.body.sessionId}/finish`);
    expect(readSettings().speech.perApp.slack).toBe("hinglish");
  });

  it("falls back to the CPU when the speech server fails mid-utterance", async () => {
    failFinish = true;
    const created = await post("/v2/asr/sessions", {});
    await postBytes(`/v2/asr/sessions/${created.body.sessionId}/audio`, new Uint8Array(1000));
    const final = await post(`/v2/asr/sessions/${created.body.sessionId}/finish`);
    expect(final.status).toBe(200);
    expect(final.body).toMatchObject({ engine: "local", text: "" });
  });

  it("uses the CPU when asrEngine is local", async () => {
    updateSettings({ speech: { asrEngine: "local" } });
    const created = await post("/v2/asr/sessions", {});
    expect(created.body.engine).toBe("local");
    expect(calls).toHaveLength(0);
    updateSettings({ speech: { asrEngine: "auto" } });
  });

  it("romanizes unknown Hinglish words with IndicXlit from the server", async () => {
    const cleaned = await post("/v2/dictation/cleanup", { text: "मेरा लैपटॉप स्लो चल रहा है", language: "hinglish" });
    expect(cleaned.body.text).toBe("Mera laptop slow chal raha hai.");
  });
});

describe("language settings", () => {
  it("lists languages and the server state", async () => {
    const body = await (await app.request("/v2/speech/languages")).json();
    expect(body.available.find((language: { code: string }) => language.code === "ta").native).toBe("தமிழ்");
    expect(body.server.running).toBe(true);
  });

  it("keeps only known languages and a valid primary", async () => {
    const response = await app.request("/v2/speech/languages", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ languages: ["ta", "te", "xx"] }) });
    expect(await response.json()).toMatchObject({ languages: ["ta", "te"], primaryLanguage: "ta" });
    updateSettings({ speech: { languages: ["en-IN", "hi", "hinglish"], primaryLanguage: "en-IN" } });
  });

  it("cycles the language for an app", async () => {
    expect((await post("/v2/speech/language-cycle", { app: { process: "Code.exe" }, current: "en" })).body).toEqual({ language: "hi", chip: "हिं" });
    expect(readSettings().speech.perApp.code).toBe("hi");
    expect((await post("/v2/speech/language-cycle", { app: { process: "Code.exe" } })).body.language).toBe("hinglish");
    await app.request("/v2/speech/languages", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ forgetPerApp: true }) });
    expect(readSettings().speech.perApp).toEqual({});
  });

  it("saves personal test clips", async () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40)]);
    const saved = await post("/v2/eval/clips", { audio: wav.toString("base64"), reference: "kal milte hain", language: "hinglish" });
    expect(saved.body.count).toBe(1);
    const manifest = fs.readFileSync(path.join(stateDirectory, "eval", "personal", "manifest.jsonl"), "utf8");
    expect(JSON.parse(manifest.trim())).toMatchObject({ reference: "kal milte hain", language: "hinglish" });
    expect((await post("/v2/eval/clips", { audio: "bm90IGEgd2F2", reference: "x" })).status).toBe(400);
  });
});
