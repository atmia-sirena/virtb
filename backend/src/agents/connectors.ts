// Connectors are MCP servers, like HeyClicky's. HeyClicky's app catalog runs
// through Composio (a hosted service); Pip uses only MCP servers you add
// yourself (open-source servers run as local commands, or any URL), plus its
// own desktop servers (computer-use via Cua Driver, jev-use), always attached.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { environment, readJsonFile, stateDirectory, writeJsonFile } from "../config.js";

export interface ConnectorConfig {
  id: string;
  name: string;
  kind: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  builtIn?: boolean;
}

const connectorsPath = () => path.join(stateDirectory, "connectors.json");

export function listUserConnectors(): ConnectorConfig[] {
  return readJsonFile<ConnectorConfig[]>(connectorsPath(), []);
}

export function saveConnector(input: Omit<ConnectorConfig, "id"> & { id?: string }): ConnectorConfig {
  const connectors = listUserConnectors();
  const connector: ConnectorConfig = { ...input, id: input.id ?? (input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || crypto.randomUUID()) };
  const index = connectors.findIndex((existing) => existing.id === connector.id);
  if (index >= 0) connectors[index] = connector;
  else connectors.push(connector);
  writeJsonFile(connectorsPath(), connectors);
  return connector;
}

export function deleteConnector(connectorId: string): boolean {
  const connectors = listUserConnectors();
  const remaining = connectors.filter((connector) => connector.id !== connectorId);
  writeJsonFile(connectorsPath(), remaining);
  return remaining.length !== connectors.length;
}

const thisFilePath = fileURLToPath(import.meta.url);
const runningFromTypeScript = thisFilePath.endsWith(".ts");

/** Command that launches Pip's own stdio MCP servers (desktop-server.ts/js). */
export function desktopServerCommand(serverName: "computer-use" | "jev-use", runId?: string, backendUrl = `http://127.0.0.1:${environment.port}`): ConnectorConfig {
  const scriptPath = path.join(path.dirname(thisFilePath), "..", "mcp", runningFromTypeScript ? "desktop-server.ts" : "desktop-server.js");
  const args = runningFromTypeScript ? ["--import", "tsx", scriptPath, serverName] : [scriptPath, serverName];
  return {
    id: serverName,
    name: serverName,
    kind: "stdio",
    command: process.execPath,
    args,
    env: { PIP_BACKEND_URL: backendUrl, ...(runId ? { PIP_RUN_ID: runId } : {}) },
    enabled: true,
    builtIn: true,
  };
}

/** Everything attached to an agent run: Pip's desktop servers and the user's own connectors. */
export function connectorsForRun(runId?: string): ConnectorConfig[] {
  const attached: ConnectorConfig[] = [desktopServerCommand("computer-use", runId), desktopServerCommand("jev-use", runId)];
  const userConnectors = listUserConnectors().filter((connector) => connector.enabled);
  return [...attached, ...userConnectors];
}

export async function connectMcp(connector: ConnectorConfig): Promise<Client> {
  const client = new Client({ name: "pip", version: "0.1.0" });
  if (connector.kind === "http") {
    if (!connector.url) throw new Error(`${connector.name}: missing url`);
    const transport = new StreamableHTTPClientTransport(new URL(connector.url), {
      requestInit: connector.headers ? { headers: connector.headers } : undefined,
    });
    await client.connect(transport);
  } else {
    if (!connector.command) throw new Error(`${connector.name}: missing command`);
    const transport = new StdioClientTransport({
      command: connector.command,
      args: connector.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(connector.env ?? {}) },
      stderr: "ignore",
    });
    await client.connect(transport);
  }
  return client;
}

/** HeyClicky's "live token checks": connect, list tools, report. */
export async function checkConnector(connector: ConnectorConfig): Promise<{ ok: boolean; toolCount?: number; tools?: string[]; error?: string }> {
  let client: Client | undefined;
  try {
    client = await connectMcp(connector);
    const { tools } = await client.listTools();
    return { ok: true, toolCount: tools.length, tools: tools.slice(0, 40).map((tool) => tool.name) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    await client?.close().catch(() => undefined);
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** config.toml fragment registering connectors as Codex MCP servers. */
export function codexMcpServersToml(connectors: ConnectorConfig[]): string {
  const blocks: string[] = [];
  for (const connector of connectors) {
    const key = connector.id.replace(/[^A-Za-z0-9_-]/g, "_");
    if (connector.kind === "stdio" && connector.command) {
      blocks.push(`[mcp_servers.${key}]`);
      blocks.push(`command = ${tomlString(connector.command)}`);
      blocks.push(`args = [${(connector.args ?? []).map(tomlString).join(", ")}]`);
      blocks.push("startup_timeout_sec = 30");
      blocks.push("tool_timeout_sec = 600");
      if (connector.env && Object.keys(connector.env).length > 0) {
        blocks.push(`[mcp_servers.${key}.env]`);
        for (const [envKey, envValue] of Object.entries(connector.env)) blocks.push(`${envKey} = ${tomlString(envValue)}`);
      }
    } else if (connector.kind === "http" && connector.url) {
      blocks.push(`[mcp_servers.${key}]`);
      blocks.push(`url = ${tomlString(connector.url)}`);
      if (connector.headers && Object.keys(connector.headers).length > 0) {
        blocks.push(`[mcp_servers.${key}.http_headers]`);
        for (const [headerKey, headerValue] of Object.entries(connector.headers)) blocks.push(`${tomlString(headerKey)} = ${tomlString(headerValue)}`);
      }
    }
    blocks.push("");
  }
  return blocks.join("\n");
}
