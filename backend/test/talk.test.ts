import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetSettingsCacheForTests, updateSettings } from "../src/config.js";
import { installEngineResolver } from "../src/agents/engines.js";
import { refreshInstalledModels } from "../src/lib/models.js";
import { parseSse, startFakeOllama, type FakeOllama } from "./fake-ollama.js";

let ollama: FakeOllama;
const app = createApp();

beforeAll(async () => {
  ollama = await startFakeOllama(["pip-fast:latest", "pip-vision:latest", "pip-jev:latest", "llama3.2:3b", "llava:13b"]);
  process.env.OLLAMA_HOST_URL = ollama.url;
  resetSettingsCacheForTests();
  updateSettings({ agents: { engine: "builtin", cancelWindowSeconds: 0 } });
  installEngineResolver();
  await refreshInstalledModels();
});
afterAll(async () => ollama.close());
beforeEach(() => ollama.requests.splice(0));

const screens = [{ index: 0, width: 1280, height: 720, image: Buffer.from("fake").toString("base64"), isCursorScreen: true, cursor: { x: 600, y: 300 } }];
const elements = [{ id: "e7", name: "Export", role: "button", rect: [1180, 20, 80, 30], screen: 0 }];

async function talk(body: Record<string, unknown>) {
  const response = await app.request("/v2/chat", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  expect(response.status).toBe(200);
  return parseSse(await response.text());
}

describe("/v2/chat", () => {
  it("routes, describes the screen with the vision model, and streams resolved beats", async () => {
    ollama.setHandler((request) => {
      if (request.model === "pip-vision") return { content: "a photo editor with an export button at the top right" };
      if (request.format) return { content: JSON.stringify({ route: "quick", reason: "simple" }) };
      return { content: "[POINT:#e7:export] hit export up here.\nthen pick png in the menu." };
    });
    const events = await talk({ transcript: "where do i export this as a png", screens, elements, cursor: { screen: 0, x: 600, y: 300 } });
    const route = events.find((event) => event.event === "route")!.data;
    expect(route.route).toBe("quick");
    const beats = events.filter((event) => event.event === "beat").map((event) => event.data);
    expect(beats[0]).toMatchObject({ text: "hit export up here.", visual: { kind: "point", points: [[1220, 35]] } });
    expect(beats[1].text).toBe("then pick png in the menu.");
    expect(events.at(-1)!.event).toBe("done");
    // The screen description reached the answer model as untrusted data.
    const answerRequest = ollama.requests.find((request) => request.model === "pip-fast" && !request.format)!;
    expect(answerRequest.messages.at(-1)!.content).toContain("<untrusted_content");
    expect(answerRequest.messages.at(-1)!.content).toContain("a photo editor");
    expect(answerRequest.keep_alive).toBe(-1);
  });

  it("uses the prefetched description instead of describing twice", async () => {
    let visionCalls = 0;
    ollama.setHandler((request) => {
      if (request.model === "pip-vision") {
        visionCalls += 1;
        return { content: "a terminal window" };
      }
      return { content: "that's a terminal." };
    });
    const prefetch = await app.request("/v2/vision/prefetch", { method: "POST", body: JSON.stringify({ turnId: "turn-1", screens }), headers: { "content-type": "application/json" } });
    expect(prefetch.status).toBe(200);
    await talk({ turnId: "turn-1", transcript: "what is this?", elements: [] });
    expect(visionCalls).toBe(1);
  });

  it("walks through a task step by step and continues on click", async () => {
    ollama.setHandler((request) => {
      if (request.model === "pip-vision") return { content: "settings app" };
      const last = request.messages.at(-1)!.content;
      if (last.includes("write step 2")) return { content: "that's it, dark mode is on. [DONE]" };
      return { content: "[TARGET:#e7:personalization] click personalization." };
    });
    const first = await talk({ transcript: "walk me through turning on dark mode", screens, elements });
    const guide = first.find((event) => event.event === "guide")!.data;
    expect(guide).toMatchObject({ step: 1, done: false, waitForClick: true });
    expect(first.find((event) => event.event === "beat")!.data.visual.kind).toBe("target");
    const second = await talk({ transcript: "", guide: { sessionId: guide.sessionId, event: "clicked" }, screens, elements });
    expect(second.find((event) => event.event === "guide")!.data).toMatchObject({ step: 2, done: true });
  });

  it("remembers facts into PROFILE.md", async () => {
    const events = await talk({ transcript: "remember that i prefer metric units" });
    expect(events.find((event) => event.event === "beat")!.data.text).toContain("remember");
    const memory = await (await app.request("/me/memory")).json();
    expect(memory.profile).toContain("I prefer metric units");
  });

  it("drafts text for the focused field", async () => {
    ollama.setHandler((request) => (request.model === "pip-vision" ? { content: "a chat with sam asking about friday" } : { content: "Friday works for me — see you then!" }));
    const events = await talk({ transcript: "reply to this saying friday works", screens, elements: [] });
    expect(events.find((event) => event.event === "insert_text")!.data.text).toBe("Friday works for me, see you then!");
  });

  it("spawns a background agent and finishes it with the built-in loop", async () => {
    ollama.setHandler((request) => {
      if (request.model === "pip-vision") return { content: "desktop" };
      if (request.messages[0]?.content.includes("name a helpful ai agent")) return { content: "Deal Hunter" };
      return { content: "The cheapest flight is $212 on Tuesday. Want me to hold it?" };
    });
    const events = await talk({ transcript: "research the cheapest flight to denver in the background", screens });
    const agentEvent = events.find((event) => event.event === "agent")!.data;
    expect(agentEvent.agentName).toBe("Deal Hunter");
    let run;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      run = (await (await app.request(`/runs/${agentEvent.runId}`)).json()).run;
      if (run.status === "done" || run.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(run.status).toBe("done");
    expect(run.summary).toBe("The cheapest flight is $212 on Tuesday.");
    const messages = (await (await app.request(`/agents/${agentEvent.agentId}/messages`)).json()).messages;
    expect(messages.at(-1).text).toContain("$212");
  });
});

describe("/agent/jev/systemone", () => {
  it("returns one candidate with probabilities from logprobs", async () => {
    ollama.setHandler(() => ({
      content: JSON.stringify({ choice: "2", done: false, blocked: false }),
      logprobs: [
        { token: '{"', logprob: 0 },
        { token: "choice", logprob: 0 },
        { token: '":"', logprob: 0 },
        { token: "2", logprob: Math.log(0.8), top_logprobs: [{ token: "2", logprob: Math.log(0.8) }, { token: "1", logprob: Math.log(0.15) }, { token: "3", logprob: Math.log(0.05) }] },
      ],
    }));
    const response = await app.request("/agent/jev/systemone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: { window: "Settings" },
        questions: { driver_action: { instructions: "the Reduce motion switch is on", criteria: { "button:back": 'button "Back"', "toggle:reduce_motion": 'toggle "Reduce motion"', reobserve: "look again" } } },
      }),
    });
    const body = await response.json();
    expect(body.choices.driver_action.choice).toBe("toggle:reduce_motion");
    expect(body.choices.driver_action.confidence).toBeCloseTo(0.8, 2);
    expect(body.choices.driver_action.probabilities["button:back"]).toBeCloseTo(0.15, 2);
    const request = ollama.requests.at(-1)!;
    expect(request.logprobs).toBe(true);
    expect((request.format as any).properties.choice.enum).toEqual(["1", "2", "3"]);
  });
});

describe("/v2/dictation/cleanup", () => {
  it("cleans with the fast model, strips dashes, and collapses newlines for terminals", async () => {
    ollama.setHandler(() => ({ content: "git status —\nthen git push" }));
    const response = await app.request("/v2/dictation/cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "um git status then uh git push", app: { process: "WindowsTerminal.exe" } }) });
    expect(await response.json()).toEqual({ text: "git status, then git push", cleaned: true });
  });

  it("keeps the raw transcript when cleanup adds words", async () => {
    ollama.setHandler(() => ({ content: "Sure! Here is your cleaned up text with many extra words added for no reason at all." }));
    const response = await app.request("/v2/dictation/cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "see you at five tomorrow" }) });
    expect(await response.json()).toEqual({ text: "see you at five tomorrow", cleaned: false });
  });

  it("skips cleanup for very short utterances", async () => {
    const before = ollama.requests.length;
    const response = await app.request("/v2/dictation/cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "sounds good" }) });
    expect((await response.json()).cleaned).toBe(false);
    expect(ollama.requests.length).toBe(before);
  });
});

describe("/agent/openai/v1", () => {
  it("maps pip-agent to an installed model and strips reasoning", async () => {
    const response = await app.request("/agent/openai/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "pip-agent", input: "hi", reasoning: { effort: "low" } }) });
    const body = await response.json();
    expect(body.echoed.model).toBe("pip-fast");
    expect(body.echoed.reasoning).toBeUndefined();
  });
});

describe("runs", () => {
  it("honours the cancel window", async () => {
    updateSettings({ agents: { cancelWindowSeconds: 5 } });
    ollama.setHandler(() => ({ content: "done" }));
    const launch = await (await app.request("/codex-thread-launch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "tidy my downloads", agentName: "Tidy Bot" }) })).json();
    expect(launch.run.status).toBe("pending");
    const cancelled = await (await app.request(`/runs/${launch.run.id}/cancel`, { method: "POST" })).json();
    expect(cancelled.run.status).toBe("cancelled");
    updateSettings({ agents: { cancelWindowSeconds: 0 } });
  });
});
