#!/usr/bin/env node
// Pip's desktop MCP servers, launched by the agent engine (Codex or built-in):
//
//   node desktop-server.js computer-use   Cua Driver's tools, proxied through Pip's permission gate
//   node desktop-server.js jev-use        drive_until: the Jev fast lane for one window
//
// HeyClicky registers the same two names: `computer-use` (its bundled
// cua-driver) and `jev-use` (a loopback MCP server inside the app).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildCandidates, isDenied, type Candidate, type DriverElement } from "./jev-candidates.js";

const serverName = process.argv[2] === "jev-use" ? "jev-use" : "computer-use";
const backendUrl = process.env.PIP_BACKEND_URL ?? "http://127.0.0.1:8787";
const runId = process.env.PIP_RUN_ID;
const cuaDriverCommand = process.env.PIP_CUA_DRIVER ?? "cua-driver";

const defaultDenyList = ["send", "delete", "pay", "purchase", "buy now", "place order", "empty trash", "remove", "unsubscribe", "transfer", "publish", "post"];
const readOnlyToolPattern = /^(get_|list_|verify_state|parse_visual_regions|get$)/;
// Tokens seen in recent snapshots -> label, so a click on a token can be checked against the deny list.
const labelByElementToken = new Map<string, string>();

let cuaClientPromise: Promise<Client> | undefined;

function cuaClient(): Promise<Client> {
  cuaClientPromise ??= (async () => {
    const client = new Client({ name: `pip-${serverName}`, version: "0.1.0" });
    await client.connect(new StdioClientTransport({ command: cuaDriverCommand, args: ["mcp"], stderr: "ignore" }));
    return client;
  })();
  cuaClientPromise.catch(() => {
    cuaClientPromise = undefined;
  });
  return cuaClientPromise;
}

const cuaMissingText =
  "Cua Driver isn't installed or couldn't start, so desktop control is unavailable. Install it from PowerShell: irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex  then run `cua-driver doctor`. Tell the user this; don't try other GUI automation.";

async function askPermission(tool: string, summary: string, risk: "write" | "destructive"): Promise<"once" | "always" | "deny"> {
  if (!runId) return risk === "destructive" ? "deny" : "once";
  const response = await fetch(`${backendUrl}/agent/runs/${runId}/permission-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, summary, risk }),
  });
  if (!response.ok) return "deny";
  return ((await response.json()) as { decision: "once" | "always" | "deny" }).decision;
}

function textResult(text: string, structuredContent?: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(structuredContent ? { structuredContent } : {}), isError };
}

function rememberLabels(structuredContent: unknown): void {
  const elements = (structuredContent as { elements?: DriverElement[] } | undefined)?.elements;
  if (!Array.isArray(elements)) return;
  for (const element of elements) {
    if (element.element_token && element.label) labelByElementToken.set(element.element_token, element.label);
  }
  if (labelByElementToken.size > 5000) labelByElementToken.clear();
}

// ---------------------------------------------------------------------------
// computer-use: proxy Cua Driver with the permission gate.

async function computerUseTools(): Promise<Tool[]> {
  try {
    const { tools } = await (await cuaClient()).listTools();
    return tools;
  } catch {
    return [{ name: "cua_driver_status", description: cuaMissingText, inputSchema: { type: "object", properties: {} } }];
  }
}

async function callComputerUse(name: string, args: Record<string, unknown>) {
  if (name === "cua_driver_status") return textResult(cuaMissingText, undefined, true);
  // HeyClicky's runtime rejects browser address-bar navigation fallbacks; URLs go through launch_app.
  if (name === "hotkey" || name === "press_key") {
    const keys = JSON.stringify(args).toLowerCase();
    if (/"(l|d)"/.test(keys) && /(ctrl|control|alt|cmd)/.test(keys)) {
      return textResult("Address-bar hotkeys are refused. Open URLs with launch_app and a urls list in a new window of your own.", undefined, true);
    }
  }
  if (!readOnlyToolPattern.test(name)) {
    const token = typeof args.element_token === "string" ? args.element_token : undefined;
    const label = token ? labelByElementToken.get(token) : undefined;
    const typedText = typeof args.text === "string" ? args.text : "";
    const destructive = label !== undefined && isDenied(label, defaultDenyList);
    if (destructive) {
      const decision = await askPermission(`computer-use.${name}`, `${name} "${label}"`, "destructive");
      if (decision === "deny") return textResult(`The user said not now to ${name} "${label}". Don't retry it; tell the user what's ready instead.`, undefined, true);
    } else if (typedText.length > 0 && /password|passcode/i.test(label ?? "")) {
      return textResult("Typing into password fields is refused. Ask the user to sign in themselves.", undefined, true);
    }
  }
  const client = await cuaClient();
  const result = await client.callTool({ name, arguments: args });
  rememberLabels(result.structuredContent);
  return result;
}

// ---------------------------------------------------------------------------
// jev-use: drive_until, the fast lane.

const driveUntilTool: Tool = {
  name: "drive_until",
  description:
    "FAST LANE for any GUI goal inside one window: snapshots the window's accessibility tree (no screenshot), asks Jev which element is next, clicks or types it in the background, and repeats until the goal is true or it can't proceed. Returns a typed status: done, blocked, needs_text, low_confidence or max_steps. Jev never writes text: text fields are filled only from `values`.",
  inputSchema: {
    type: "object",
    properties: {
      pid: { type: "integer", description: "Process id of the window's app (from list_windows)." },
      window_id: { type: "integer", description: "Window id (from list_windows)." },
      goal: { type: "string", description: 'ONE literal sentence for one window: what should be true when done ("the Reduce motion switch is on"). Name controls exactly as they appear.' },
      deny: { type: "array", items: { type: "string" }, description: 'Labels that must never be pressed, as case-insensitive substrings ("Send", "Delete", "Pay", "Empty Trash"). Name every irreversible control on the screen.' },
      values: { type: "object", additionalProperties: { type: "string" }, description: 'Text to type, keyed by the field label ("Search": "quarterly report").' },
      max_steps: { type: "integer", minimum: 1, maximum: 25, default: 12 },
    },
    required: ["pid", "window_id", "goal"],
  },
};

interface JevAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  done: boolean;
  blocked: boolean;
}

async function askJev(goal: string, windowTitle: string, candidates: Candidate[], history: { step: number; selected_id: string; outcome: string }[]): Promise<JevAnswer> {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) criteria[candidate.id] = candidate.description;
  criteria.reobserve = "the window is still changing; look again";
  criteria.abstain = "none of these helps, or something is in the way";
  const response = await fetch(`${backendUrl}/agent/jev/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      state: { window: windowTitle, history, controls: candidates.map((candidate) => candidate.description) },
      questions: { driver_action: { instructions: goal, criteria } },
    }),
  });
  if (!response.ok) throw new Error(`Jev request failed (${response.status}): ${await response.text()}`);
  return ((await response.json()) as { choices: Record<string, JevAnswer> }).choices.driver_action;
}

function valueForField(values: Record<string, string>, label: string): string | undefined {
  const lowered = label.toLowerCase();
  const key = Object.keys(values).find((candidate) => candidate.toLowerCase() === lowered) ?? Object.keys(values).find((candidate) => lowered.includes(candidate.toLowerCase()));
  return key ? values[key] : undefined;
}

async function driveUntil(args: Record<string, unknown>) {
  const pid = Number(args.pid);
  const windowId = Number(args.window_id);
  const goal = String(args.goal ?? "");
  const deny = [...defaultDenyList, ...((args.deny as string[] | undefined) ?? [])];
  const values = (args.values as Record<string, string> | undefined) ?? {};
  const maxSteps = Math.min(25, Number(args.max_steps ?? 12));
  let client: Client;
  try {
    client = await cuaClient();
  } catch {
    return textResult(cuaMissingText, { status: "unavailable" }, true);
  }
  const target = { kind: "window", pid, window_id: windowId };
  const history: { step: number; selected_id: string; outcome: string }[] = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    const snapshot = await client.callTool({ name: "get_window_state", arguments: { pid, window_id: windowId, include_screenshot: false, include_accessibility_tree: true, max_elements: 400 } });
    const structured = (snapshot.structuredContent ?? {}) as { elements?: DriverElement[]; title?: string; window?: { title?: string } };
    rememberLabels(structured);
    const candidates = buildCandidates(structured.elements ?? [], goal, deny);
    if (candidates.length === 0) {
      return textResult("Jev sees no interactive, labeled controls it may use in this window. Look at the window yourself with get_window_state.", { status: "blocked", steps: history });
    }
    let answer: JevAnswer;
    try {
      answer = await askJev(goal, structured.window?.title ?? structured.title ?? "", candidates, history);
    } catch (error) {
      return textResult(`${(error as Error).message}. Decide this step yourself with get_window_state.`, { status: "jev_unavailable", steps: history }, true);
    }
    if (answer.done) return textResult(`done in ${history.length} steps: ${goal}`, { status: "done", steps: history });
    if (answer.blocked || answer.choice === "abstain") {
      return textResult("Jev reads a login wall, dialog, permission prompt, or missing information in the way. Look at the window yourself.", { status: "blocked", steps: history });
    }
    if (answer.choice === "reobserve") {
      history.push({ step, selected_id: "reobserve", outcome: "waited" });
      await new Promise((resolve) => setTimeout(resolve, 400));
      continue;
    }
    if (answer.confidence < 0.5) {
      const top = Object.entries(answer.probabilities).sort((left, right) => right[1] - left[1]).slice(0, 3);
      return textResult(`Jev is guessing (confidence ${answer.confidence.toFixed(2)}). Read the tree yourself. Top picks: ${top.map(([id, probability]) => `${id} ${probability.toFixed(2)}`).join(", ")}`, { status: "low_confidence", steps: history, top });
    }
    const chosen = candidates.find((candidate) => candidate.id === answer.choice);
    if (!chosen) return textResult(`Jev picked an unknown control ${answer.choice}.`, { status: "blocked", steps: history }, true);
    // The deny list is enforced again on Jev's answer, in code.
    if (isDenied(chosen.label, deny)) return textResult(`Stopped before pressing "${chosen.label}", which is on the deny list. Ask the user.`, { status: "blocked", steps: history });
    if (chosen.roleClass === "text_input") {
      const text = valueForField(values, chosen.label);
      if (text === undefined) return textResult(`Jev picked the text field "${chosen.label}" but no value was given for it. Call again with values["${chosen.label}"].`, { status: "needs_text", field: chosen.label, steps: history });
      await client.callTool({ name: "click", arguments: { target, element_token: chosen.elementToken, delivery_mode: "background" } });
      await client.callTool({ name: "type_text", arguments: { target, text } });
      history.push({ step, selected_id: chosen.id, outcome: "typed" });
    } else {
      const clickResult = await client.callTool({ name: "click", arguments: { target, element_token: chosen.elementToken, delivery_mode: "background" } });
      const refused = clickResult.isError || JSON.stringify(clickResult.structuredContent ?? {}).includes("background_unavailable");
      if (refused) {
        await client.callTool({ name: "click", arguments: { target, element_token: chosen.elementToken, delivery_mode: "foreground" } });
        history.push({ step, selected_id: chosen.id, outcome: "clicked (foreground)" });
      } else {
        history.push({ step, selected_id: chosen.id, outcome: "clicked" });
      }
    }
  }
  return textResult(`Stopped after ${maxSteps} steps without confirming: ${goal}. Check the window with get_window_state.`, { status: "max_steps", steps: history });
}

// ---------------------------------------------------------------------------

const server = new Server({ name: serverName, version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: serverName === "jev-use" ? [driveUntilTool] : await computerUseTools(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  try {
    if (serverName === "jev-use") {
      if (request.params.name !== "drive_until") return textResult(`Unknown jev-use tool ${request.params.name}`, undefined, true);
      return await driveUntil(args);
    }
    return (await callComputerUse(request.params.name, args)) as never;
  } catch (error) {
    return textResult(`${request.params.name} failed: ${(error as Error).message}`, undefined, true);
  }
});

await server.connect(new StdioServerTransport());
