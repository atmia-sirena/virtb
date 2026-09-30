// HeyClicky bundles the Codex CLI and points it at its own Worker as a custom
// model provider ("clicky", base_url = Worker /agent/openai/v1, wire_api =
// "responses"). Pip does the same with provider "pip" = this backend's
// /agent/openai/v1, which forwards to Ollama.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { codexHomeDirectory, environment } from "../config.js";
import { loadPrompt } from "../lib/prompts.js";
import { codexMcpServersToml, connectorsForRun } from "./connectors.js";
import type { Engine } from "./runner.js";
import { agentWorkspace } from "./store.js";

interface CodexLaunch {
  command: string;
  prefixArgs: string[];
  useShell: boolean;
}

let cachedLaunch: CodexLaunch | null | undefined;

/** Finds Codex: PIP_CODEX_PATH, then the npm global package's JS entry (no shell needed), then `codex` on PATH. */
export function findCodex(): CodexLaunch | null {
  if (cachedLaunch !== undefined) return cachedLaunch;
  const explicitPath = process.env.PIP_CODEX_PATH;
  if (explicitPath && fs.existsSync(explicitPath)) {
    cachedLaunch = explicitPath.endsWith(".js")
      ? { command: process.execPath, prefixArgs: [explicitPath], useShell: false }
      : { command: explicitPath, prefixArgs: [], useShell: false };
    return cachedLaunch;
  }
  try {
    const npmRoot = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32", timeout: 8000 }).trim();
    const entry = path.join(npmRoot, "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(entry)) {
      cachedLaunch = { command: process.execPath, prefixArgs: [entry], useShell: false };
      return cachedLaunch;
    }
  } catch {
    // npm missing or slow; try PATH below.
  }
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore", shell: process.platform === "win32", timeout: 8000 });
    cachedLaunch = { command: "codex", prefixArgs: [], useShell: process.platform === "win32" };
  } catch {
    cachedLaunch = null;
  }
  return cachedLaunch;
}

/** Writes CODEX_HOME/config.toml and the global AGENTS.md (Pip's agent contract). */
export function writeCodexHome(): void {
  fs.mkdirSync(codexHomeDirectory, { recursive: true });
  const sandboxMode = process.env.PIP_CODEX_SANDBOX ?? "workspace-write";
  const config = [
    "# Written by Pip on every agent launch. Edit backend/src/agents/codex.ts instead.",
    `model = "pip-agent"`,
    `model_provider = "pip"`,
    `approval_policy = "never"`,
    `sandbox_mode = ${JSON.stringify(sandboxMode)}`,
    `model_reasoning_effort = "low"`,
    "",
    "[model_providers.pip]",
    `name = "Pip local (Ollama)"`,
    `base_url = ${JSON.stringify(`http://127.0.0.1:${environment.port}/agent/openai/v1`)}`,
    `wire_api = "responses"`,
    "stream_idle_timeout_ms = 600000",
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
    codexMcpServersToml(connectorsForRun()),
  ].join("\n");
  fs.writeFileSync(path.join(codexHomeDirectory, "config.toml"), config);
  fs.writeFileSync(path.join(codexHomeDirectory, "AGENTS.md"), loadPrompt("agent-contract"));
}

function quoteForWindowsShell(argument: string): string {
  return /[\s"&|<>^]/.test(argument) ? `"${argument.replace(/"/g, '\\"')}"` : argument;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    status?: string;
    server?: string;
    tool?: string;
    exit_code?: number;
    changes?: { path: string; kind: string }[];
    query?: string;
    items?: { text: string; completed: boolean }[];
  };
}

export const codexEngine: Engine = async (context) => {
  const launch = findCodex();
  if (!launch) throw new Error("Codex CLI isn't installed. Run: npm install -g @openai/codex");
  writeCodexHome();
  const workspace = agentWorkspace(context.agent.id);
  const runId = context.run.id;
  const perRunOverrides = ["computer-use", "jev-use"].flatMap((server) => ["-c", `mcp_servers.${server}.env.PIP_RUN_ID=${JSON.stringify(runId)}`]);
  const commonArgs = ["--json", "--skip-git-repo-check", "-C", workspace, ...perRunOverrides];
  const args = [
    ...launch.prefixArgs,
    "exec",
    ...commonArgs,
    ...(context.agent.codexThreadId ? ["resume", context.agent.codexThreadId] : []),
    "-",
  ];
  const child = spawn(launch.useShell ? quoteForWindowsShell(launch.command) : launch.command, launch.useShell ? args.map(quoteForWindowsShell) : args, {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: codexHomeDirectory },
    shell: launch.useShell,
    windowsHide: true,
  });
  context.signal.addEventListener("abort", () => child.kill(), { once: true });
  const identity = context.agent.persistent ? `You ARE ${context.agent.name}. ` : "";
  child.stdin.end(`${identity}${context.run.prompt}`);

  let threadId: string | undefined = context.agent.codexThreadId;
  let lastAgentMessage = "";
  let failure: string | undefined;
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  let pendingText = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pendingText += chunk.toString();
    let newlineIndex: number;
    while ((newlineIndex = pendingText.indexOf("\n")) >= 0) {
      const line = pendingText.slice(0, newlineIndex).trim();
      pendingText = pendingText.slice(newlineIndex + 1);
      if (!line.startsWith("{")) continue;
      let event: CodexEvent;
      try {
        event = JSON.parse(line) as CodexEvent;
      } catch {
        continue;
      }
      if (event.type === "thread.started" && event.thread_id) threadId = event.thread_id;
      if (event.type === "turn.failed") failure = event.error?.message ?? "turn failed";
      if (event.type === "error") failure = event.message ?? "codex error";
      const item = event.item;
      if (!item) continue;
      if (event.type === "item.started" && item.type === "command_execution" && item.command) context.step(`running ${item.command.slice(0, 120)}`, "command");
      if (event.type === "item.started" && item.type === "mcp_tool_call") context.step(`using ${item.server}.${item.tool}`, "tool");
      if (event.type === "item.started" && item.type === "web_search") context.step(`searching ${item.query ?? "the web"}`, "search");
      if (event.type === "item.completed" && item.type === "file_change" && item.changes) {
        for (const change of item.changes) context.step(`${change.kind} ${path.basename(change.path)}`, "file");
      }
      if (event.type === "item.completed" && item.type === "agent_message" && item.text) {
        lastAgentMessage = item.text;
        context.message(item.text);
      }
      if (event.type === "item.completed" && item.type === "reasoning" && item.text) context.step(item.text.split("\n")[0].replace(/\*\*/g, "").slice(0, 140), "thinking");
      if (item.type === "todo_list" && item.items) {
        const next = item.items.find((todo) => !todo.completed);
        if (next) context.step(next.text, "plan");
      }
    }
  });

  const exitCode: number = await new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  if (context.signal.aborted) return { finalText: "", threadId };
  if (failure || (exitCode !== 0 && !lastAgentMessage)) {
    throw new Error(failure ?? `codex exited with ${exitCode}: ${stderrTail.split("\n").slice(-3).join(" ")}`);
  }
  return { finalText: lastAgentMessage || "done.", threadId };
};
