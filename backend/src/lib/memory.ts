// HeyClicky keeps two Markdown memory files, PROFILE.md (stable habits) and
// VOLATILE.md (the current project), injected into the voice model and agents,
// plus the last 40 messages. Pip keeps the same files on local disk.
import fs from "node:fs";
import path from "node:path";
import { memoryDirectory, stateDirectory } from "../config.js";
import { eventBus } from "./events.js";
import { resolveModel } from "./models.js";
import { ollamaChat } from "./ollama.js";
import { loadPrompt } from "./prompts.js";

export const profilePath = () => path.join(memoryDirectory, "PROFILE.md");
export const volatilePath = () => path.join(memoryDirectory, "VOLATILE.md");
const conversationPath = () => path.join(stateDirectory, "conversation.jsonl");

const profileTemplate = "# PROFILE\n\n(Durable facts and preferences about the user. One per line.)\n";
const volatileTemplate = "# VOLATILE\n\n(What the user is working on right now.)\n";

export interface MemoryFiles {
  profile: string;
  volatile: string;
}

export function readMemory(): MemoryFiles {
  fs.mkdirSync(memoryDirectory, { recursive: true });
  if (!fs.existsSync(profilePath())) fs.writeFileSync(profilePath(), profileTemplate);
  if (!fs.existsSync(volatilePath())) fs.writeFileSync(volatilePath(), volatileTemplate);
  return { profile: fs.readFileSync(profilePath(), "utf8"), volatile: fs.readFileSync(volatilePath(), "utf8") };
}

export function writeMemory(files: Partial<MemoryFiles>): MemoryFiles {
  readMemory();
  if (files.profile !== undefined) fs.writeFileSync(profilePath(), files.profile);
  if (files.volatile !== undefined) fs.writeFileSync(volatilePath(), files.volatile);
  eventBus.publish("memory.changed", {});
  return readMemory();
}

export function appendProfileFact(fact: string): void {
  const memory = readMemory();
  const line = fact.startsWith("- ") ? fact : `- ${fact}`;
  if (memory.profile.includes(line)) return;
  writeMemory({ profile: `${memory.profile.trimEnd()}\n${line}\n` });
}

export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
  mode?: string;
}

const maxConversationMessages = 40;

export function readConversation(limit = maxConversationMessages): ConversationMessage[] {
  if (!fs.existsSync(conversationPath())) return [];
  const lines = fs.readFileSync(conversationPath(), "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line) as ConversationMessage);
}

export function appendConversation(message: Omit<ConversationMessage, "at">): void {
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.appendFileSync(conversationPath(), `${JSON.stringify({ ...message, at: new Date().toISOString() })}\n`);
  // Keep the file bounded: rewrite with the newest 400 lines once it grows past 800.
  const lines = fs.readFileSync(conversationPath(), "utf8").trim().split("\n");
  if (lines.length > 800) fs.writeFileSync(conversationPath(), `${lines.slice(-400).join("\n")}\n`);
  scheduleMemoryUpdate();
}

let memoryUpdateTimer: NodeJS.Timeout | undefined;
let messagesSinceMemoryUpdate = 0;

/** After a talk session goes quiet for 90 s, the fast model folds it into the memory files. */
function scheduleMemoryUpdate(): void {
  messagesSinceMemoryUpdate += 1;
  if (memoryUpdateTimer) clearTimeout(memoryUpdateTimer);
  memoryUpdateTimer = setTimeout(() => {
    void updateMemoryFromConversation().catch((error) => console.warn("[memory] update failed:", error.message));
  }, 90_000);
  memoryUpdateTimer.unref?.();
}

export async function updateMemoryFromConversation(): Promise<MemoryFiles | undefined> {
  if (messagesSinceMemoryUpdate === 0) return undefined;
  const recentMessages = readConversation(Math.min(40, messagesSinceMemoryUpdate + 6));
  messagesSinceMemoryUpdate = 0;
  const memory = readMemory();
  const model = await resolveModel("memory");
  const transcript = recentMessages.map((message) => `${message.role}: ${message.text}`).join("\n");
  const response = await ollamaChat({
    model: model.model,
    keep_alive: model.keepAlive,
    options: model.options,
    format: {
      type: "object",
      properties: {
        profile_additions: { type: "array", items: { type: "string" } },
        profile_removals: { type: "array", items: { type: "string" } },
        volatile: { type: "string" },
      },
      required: ["profile_additions", "profile_removals", "volatile"],
    },
    messages: [
      { role: "system", content: loadPrompt("memory") },
      {
        role: "user",
        content: `PROFILE.md:\n${memory.profile}\n\nVOLATILE.md:\n${memory.volatile}\n\nRECENT CONVERSATION (user and assistant turns; screen text is excluded):\n${transcript}`,
      },
    ],
  });
  const update = JSON.parse(response.message.content) as { profile_additions: string[]; profile_removals: string[]; volatile: string };
  const secretPattern = /(password|passcode|api[_ -]?key|token|secret|\b\d{6}\b)/i;
  let profileLines = memory.profile.split("\n");
  profileLines = profileLines.filter((line) => !update.profile_removals.includes(line.trim()));
  for (const addition of update.profile_additions) {
    const line = addition.trim().startsWith("- ") ? addition.trim() : `- ${addition.trim()}`;
    if (line.length > 3 && !secretPattern.test(line) && !profileLines.includes(line)) profileLines.push(line);
  }
  const volatileText = update.volatile.trim().startsWith("# VOLATILE") ? update.volatile.trim() : `# VOLATILE\n\n${update.volatile.trim()}`;
  return writeMemory({ profile: `${profileLines.join("\n").trimEnd()}\n`, volatile: `${volatileText}\n` });
}
