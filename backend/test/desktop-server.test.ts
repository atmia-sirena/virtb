import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hono } from "hono";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
let backend: ServerType;
let backendUrl = "";
const jevAnswers: string[] = [];

beforeAll(async () => {
  // A fake backend: Jev says "type the note", then "save", then "done".
  const app = new Hono();
  let call = 0;
  app.post("/agent/jev/systemone", async (context) => {
    const body = await context.req.json();
    const criteria = Object.keys(body.questions.driver_action.criteria);
    jevAnswers.push(criteria.join(","));
    call += 1;
    const choice = call === 1 ? "text_input:note" : "button:save";
    const done = call >= 3;
    return context.json({ choices: { driver_action: { choice, confidence: 0.9, probabilities: { [choice]: 0.9 }, done, blocked: false } } });
  });
  backendUrl = await new Promise((resolve) => {
    backend = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => resolve(`http://127.0.0.1:${info.port}`));
  });
});
afterAll(() => backend.close());

it.skipIf(process.platform === "win32")("drive_until types from values, clicks Save, never offers Send, and reports done", async () => {
  const wrapper = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pip-cua-")), "cua-driver");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" --import tsx "${path.join(testDirectory, "fake-cua-driver.ts")}"\n`, { mode: 0o755 });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(testDirectory, "..", "src", "mcp", "desktop-server.ts"), "jev-use"],
      env: { ...(process.env as Record<string, string>), PIP_BACKEND_URL: backendUrl, PIP_CUA_DRIVER: wrapper },
      cwd: path.join(testDirectory, ".."),
    }),
  );
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(["drive_until"]);
  const result = await client.callTool({ name: "drive_until", arguments: { pid: 1, window_id: 1, goal: "the note says hello and is saved", values: { Note: "hello" } } });
  expect(result.structuredContent).toMatchObject({ status: "done" });
  expect(jevAnswers[0]).not.toContain("send");
  expect(jevAnswers[0]).toContain("reobserve");
  await client.close();
}, 30000);
