// Built-in agent loop, the fallback when Codex isn't installed or can't drive
// the local model. HeyClicky also runs "its own lightweight harness" next to
// Codex. Tools: web search and fetch, workspace files, a gated shell, and every
// MCP tool from Pip's desktop servers and the user's connectors.
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { resolveModel } from "../lib/models.js";
import { ollamaChat, type OllamaMessage, type OllamaTool } from "../lib/ollama.js";
import { loadPrompt, wrapUntrusted } from "../lib/prompts.js";
import { fetchReadableText, webSearch } from "../lib/websearch.js";
import { connectMcp, connectorsForRun } from "./connectors.js";
import type { Engine, EngineContext } from "./runner.js";
import { agentWorkspace } from "./store.js";

const maxSteps = 30;
const maxToolResultCharacters = 6000;
const destructiveNamePattern = /(send|delete|remove|trash|archive|pay|purchase|buy|transfer|publish|post_|cancel_subscription|drop)/i;

interface ToolHandler {
  definition: OllamaTool;
  run: (args: Record<string, unknown>) => Promise<string>;
}

function insideWorkspace(workspace: string, requestedPath: string): string {
  const resolved = path.resolve(workspace, requestedPath);
  return resolved;
}

function localTools(context: EngineContext, workspace: string): ToolHandler[] {
  const ask = async (tool: string, summary: string, risk: "write" | "destructive") => {
    const decision = await context.requestPermission({ tool, summary, risk });
    if (decision === "deny") throw new Error("the user said not now");
  };
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web. Returns titles, urls and snippets.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      },
      run: async (args) => {
        context.step(`searching ${String(args.query)}`, "search");
        const results = await webSearch(String(args.query));
        return wrapUntrusted("search", results.map((result) => `${result.title}\n${result.url}\n${result.snippet}`).join("\n\n"));
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "fetch_url",
          description: "Fetch a web page and return its readable text.",
          parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        },
      },
      run: async (args) => {
        context.step(`reading ${String(args.url).slice(0, 80)}`, "fetch");
        return wrapUntrusted("page", await fetchReadableText(String(args.url)));
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_files",
          description: "List files in a folder. Relative paths are inside your workspace.",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: [] },
        },
      },
      run: async (args) => {
        const folder = insideWorkspace(workspace, String(args.path ?? "."));
        return fs.readdirSync(folder, { withFileTypes: true }).map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`).join("\n");
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a text file. Relative paths are inside your workspace.",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
      run: async (args) => wrapUntrusted("file", fs.readFileSync(insideWorkspace(workspace, String(args.path)), "utf8")),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "write_file",
          description: "Write a text file. New files go in output/ inside your workspace.",
          parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
        },
      },
      run: async (args) => {
        const target = insideWorkspace(workspace, String(args.path));
        const outsideWorkspace = !target.startsWith(path.resolve(workspace));
        if (outsideWorkspace || fs.existsSync(target)) await ask("write_file", `write ${target}`, outsideWorkspace ? "destructive" : "write");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(args.content));
        context.step(`wrote ${path.basename(target)}`, "file");
        return `wrote ${target}`;
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "run_command",
          description: "Run a shell command in your workspace (PowerShell on Windows). The user approves each command.",
          parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        },
      },
      run: async (args) => {
        const command = String(args.command);
        await ask("run_command", command, destructiveNamePattern.test(command) || /\b(rm|del|rmdir|format|Remove-Item)\b/i.test(command) ? "destructive" : "write");
        context.step(`running ${command.slice(0, 100)}`, "command");
        return await new Promise((resolve) => {
          exec(command, { cwd: workspace, timeout: 120_000, shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve(`${error ? `exit ${error.code ?? "error"}\n` : ""}${stdout}${stderr ? `\nstderr:\n${stderr}` : ""}`);
          });
        });
      },
    },
  ];
}

async function mcpTools(context: EngineContext): Promise<{ tools: ToolHandler[]; clients: Client[] }> {
  const tools: ToolHandler[] = [];
  const clients: Client[] = [];
  for (const connector of connectorsForRun(context.run.id)) {
    try {
      const client = await connectMcp(connector);
      clients.push(client);
      const { tools: serverTools } = await client.listTools();
      for (const tool of serverTools) {
        const qualifiedName = `${connector.id.replace(/[^A-Za-z0-9_]/g, "_")}__${tool.name}`;
        tools.push({
          definition: {
            type: "function",
            function: { name: qualifiedName, description: (tool.description ?? "").slice(0, 600), parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} } },
          },
          run: async (args) => {
            // Pip's own desktop servers run their own permission gate; other connectors are gated here.
            if (!connector.builtIn) {
              if (destructiveNamePattern.test(tool.name)) {
                const decision = await context.requestPermission({ tool: qualifiedName, summary: `${tool.name} ${JSON.stringify(args).slice(0, 200)}`, risk: "destructive" });
                if (decision === "deny") return "the user said not now; don't retry this action.";
              }
            }
            context.step(`using ${connector.name}.${tool.name}`, "tool");
            const result = await client.callTool({ name: tool.name, arguments: args });
            const text = (result.content as { type: string; text?: string }[] | undefined)?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
            const structured = result.structuredContent ? `\n${JSON.stringify(result.structuredContent).slice(0, 4000)}` : "";
            return wrapUntrusted(connector.id, `${result.isError ? "ERROR: " : ""}${text}${structured}`);
          },
        });
      }
    } catch (error) {
      context.step(`${connector.name} unavailable: ${(error as Error).message.slice(0, 80)}`, "warning");
    }
  }
  return { tools, clients };
}

export const builtinEngine: Engine = async (context) => {
  const workspace = agentWorkspace(context.agent.id);
  let model = await resolveModel("agent");
  if (!model.available) model = await resolveModel("deep");
  if (!model.available) model = await resolveModel("talk", { num_ctx: 8192, num_predict: 1024 });
  const { tools: connectorTools, clients } = await mcpTools(context);
  const tools = [...localTools(context, workspace), ...connectorTools];
  const toolByName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
  const agentsFile = path.join(workspace, "AGENTS.md");
  const identity = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, "utf8") : "";
  const messages: OllamaMessage[] = [
    { role: "system", content: `${loadPrompt("agent-contract")}\n\nYour workspace: ${workspace}\n\n${identity}` },
    { role: "user", content: context.run.prompt },
  ];
  try {
    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      if (context.signal.aborted) return { finalText: "" };
      const response = await ollamaChat({ model: model.model, keep_alive: model.keepAlive, options: model.options, messages, tools: tools.map((tool) => tool.definition) }, context.signal);
      const assistantMessage = response.message;
      messages.push(assistantMessage);
      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0) return { finalText: assistantMessage.content };
      if (assistantMessage.content.trim()) context.message(assistantMessage.content.trim());
      for (const toolCall of toolCalls) {
        const handler = toolByName.get(toolCall.function.name);
        let result: string;
        try {
          result = handler ? await handler.run(toolCall.function.arguments ?? {}) : `unknown tool ${toolCall.function.name}`;
        } catch (error) {
          result = `error: ${(error as Error).message}`;
        }
        messages.push({ role: "tool", tool_name: toolCall.function.name, content: result.slice(0, maxToolResultCharacters) });
      }
    }
    return { finalText: "i ran out of steps before finishing. here's where i got to: " + (messages.at(-1)?.content ?? "").slice(0, 400) };
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }
};
