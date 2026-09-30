// Clickys (persistent agents) on disk. Each agent owns a folder with its
// identity/memory file AGENTS.md, a chat log, and output/ + tmp/ for files,
// exactly the workspace contract HeyClicky's agent instructions describe.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentsDirectory, readJsonFile, writeJsonFile } from "../config.js";
import { eventBus } from "../lib/events.js";

export type AgentStatus = "idle" | "pending" | "running" | "needs_you" | "done" | "failed";

export interface Agent {
  id: string;
  name: string;
  role: string;
  /** Kaomoji face shown on cards and in the sidebar. */
  face: string;
  persistent: boolean;
  pinned: boolean;
  archived: boolean;
  unread: number;
  status: AgentStatus;
  lastMessage?: string;
  codexThreadId?: string;
  alwaysAllowedTools: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "agent" | "step" | "system";
  text: string;
  runId?: string;
  at: string;
  files?: string[];
}

const faces = ["(^_^)", "(•‿•)", "(=^･ω･^=)", "(⌐■_■)", "(ᵔᴥᵔ)", "(o^▽^o)", "(◕‿◕)", "(¬‿¬)", "ʕ•ᴥ•ʔ", "(✿◠‿◠)"];

export function agentDirectory(agentId: string): string {
  return path.join(agentsDirectory, agentId);
}

export function agentWorkspace(agentId: string): string {
  return path.join(agentDirectory(agentId), "workspace");
}

function agentJsonPath(agentId: string): string {
  return path.join(agentDirectory(agentId), "agent.json");
}

function chatLogPath(agentId: string): string {
  return path.join(agentDirectory(agentId), "chat.jsonl");
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "agent";
}

export function listAgents(options: { includeArchived?: boolean } = {}): Agent[] {
  if (!fs.existsSync(agentsDirectory)) return [];
  return fs
    .readdirSync(agentsDirectory)
    .map((agentId) => readJsonFile<Agent | undefined>(agentJsonPath(agentId), undefined))
    .filter((agent): agent is Agent => agent !== undefined)
    .filter((agent) => options.includeArchived || !agent.archived)
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt.localeCompare(left.updatedAt));
}

export function getAgent(agentId: string): Agent | undefined {
  return readJsonFile<Agent | undefined>(agentJsonPath(agentId), undefined);
}

export function findAgentByName(name: string): Agent | undefined {
  const wanted = name.trim().toLowerCase();
  return listAgents().find((agent) => agent.name.toLowerCase() === wanted);
}

export function saveAgent(agent: Agent): Agent {
  agent.updatedAt = new Date().toISOString();
  writeJsonFile(agentJsonPath(agent.id), agent);
  eventBus.publish("agent.updated", { agent });
  return agent;
}

export function createAgent(input: { name: string; role?: string; persistent?: boolean }): Agent {
  let agentId = slugify(input.name);
  if (fs.existsSync(agentDirectory(agentId))) agentId = `${agentId}-${crypto.randomBytes(2).toString("hex")}`;
  const now = new Date().toISOString();
  const agent: Agent = {
    id: agentId,
    name: input.name,
    role: input.role ?? "",
    face: faces[crypto.randomInt(faces.length)],
    persistent: input.persistent ?? true,
    pinned: false,
    archived: false,
    unread: 0,
    status: "idle",
    alwaysAllowedTools: [],
    createdAt: now,
    updatedAt: now,
  };
  const workspace = agentWorkspace(agentId);
  fs.mkdirSync(path.join(workspace, "output"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "tmp"), { recursive: true });
  const identity = [
    `# ${agent.name}`,
    "",
    `You ARE ${agent.name}, one of the user's Pip agents.${agent.role ? ` Your job: ${agent.role}` : ""}`,
    "",
    "## Standing preferences",
    "",
    "## Notes",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), identity);
  writeJsonFile(agentJsonPath(agentId), agent);
  eventBus.publish("agent.created", { agent });
  return agent;
}

export function updateAgent(agentId: string, changes: Partial<Pick<Agent, "name" | "role" | "pinned" | "archived" | "unread" | "status" | "lastMessage" | "codexThreadId" | "alwaysAllowedTools">>): Agent | undefined {
  const agent = getAgent(agentId);
  if (!agent) return undefined;
  return saveAgent({ ...agent, ...changes });
}

export function appendAgentMessage(agentId: string, message: Omit<AgentMessage, "id" | "at">): AgentMessage {
  const fullMessage: AgentMessage = { ...message, id: crypto.randomUUID(), at: new Date().toISOString() };
  fs.mkdirSync(agentDirectory(agentId), { recursive: true });
  fs.appendFileSync(chatLogPath(agentId), `${JSON.stringify(fullMessage)}\n`);
  return fullMessage;
}

/** Newest-first paging, like HeyClicky's history that loads newest first. */
export function readAgentMessages(agentId: string, options: { limit?: number; before?: string } = {}): AgentMessage[] {
  if (!fs.existsSync(chatLogPath(agentId))) return [];
  const all = fs
    .readFileSync(chatLogPath(agentId), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentMessage);
  const endIndex = options.before ? all.findIndex((message) => message.id === options.before) : all.length;
  const sliceEnd = endIndex < 0 ? all.length : endIndex;
  const limit = options.limit ?? 50;
  return all.slice(Math.max(0, sliceEnd - limit), sliceEnd);
}

export function listOutputFiles(agentId: string): { name: string; path: string; size: number; modifiedAt: string }[] {
  const outputDirectory = path.join(agentWorkspace(agentId), "output");
  if (!fs.existsSync(outputDirectory)) return [];
  return fs
    .readdirSync(outputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(outputDirectory, entry.name);
      const stat = fs.statSync(filePath);
      return { name: entry.name, path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}
