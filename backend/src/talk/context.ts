// Builds the context message every talk-style prompt shares: memory files,
// the matched app skill, llava's screen notes, the UI element list and the
// cursor, with all screen-derived text wrapped as untrusted data.
import { readMemory, readConversation, type ConversationMessage } from "../lib/memory.js";
import { wrapUntrusted } from "../lib/prompts.js";
import { matchSkill, type ActiveApp } from "../lib/skills.js";
import type { OllamaMessage } from "../lib/ollama.js";
import type { ScreenElement } from "./tags.js";
import type { ScreenCapture } from "./vision.js";

export interface TurnContextInput {
  screenDescription: string;
  screens: ScreenCapture[];
  elements: ScreenElement[];
  cursor?: { screen: number; x: number; y: number };
  activeApp?: ActiveApp;
  selectedText?: string;
  documentText?: string;
}

export function formatElements(elements: ScreenElement[], limit = 150): string {
  return elements
    .slice(0, limit)
    .map((element) => {
      const [x, y, width, height] = element.rect;
      const centerX = Math.round(x + width / 2);
      const centerY = Math.round(y + height / 2);
      const value = element.value ? ` value="${element.value.slice(0, 60)}"` : "";
      const disabled = element.enabled === false ? " (disabled)" : "";
      return `${element.id} ${element.role} "${element.name.slice(0, 80)}"${value} at (${centerX},${centerY}) screen${element.screen}${disabled}`;
    })
    .join("\n");
}

export function buildContextMessage(input: TurnContextInput): string {
  const memory = readMemory();
  const skill = matchSkill(input.activeApp);
  const parts: string[] = [];
  parts.push(`PROFILE.md:\n${memory.profile.trim()}`);
  parts.push(`VOLATILE.md:\n${memory.volatile.trim()}`);
  parts.push(`NOW: ${new Date().toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`);
  if (input.activeApp) {
    const app = input.activeApp;
    parts.push(`ACTIVE APP: ${app.name ?? app.process ?? "unknown"}${app.url ? ` (${app.url})` : ""}`);
  }
  if (skill) parts.push(`APP SKILL (${skill.name}):\n${skill.body}`);
  const screenLines = input.screens.map((screen) => `screen${screen.index}${screen.label ? ` (${screen.label})` : ""}: ${screen.width}x${screen.height}${screen.isCursorScreen ? ", cursor here" : ""}`);
  if (screenLines.length > 0) parts.push(`SCREENS:\n${screenLines.join("\n")}`);
  if (input.cursor) parts.push(`CURSOR: (${Math.round(input.cursor.x)},${Math.round(input.cursor.y)}) screen${input.cursor.screen}`);
  if (input.screenDescription) parts.push(`SCREEN NOTES:\n${wrapUntrusted("screen", input.screenDescription)}`);
  if (input.elements.length > 0) parts.push(`ELEMENTS (id role "name" at center):\n${wrapUntrusted("elements", formatElements(input.elements))}`);
  else parts.push("ELEMENTS: none available for this app. describe what you mean in the tag instead of an id.");
  if (input.selectedText) parts.push(`SELECTED TEXT:\n${wrapUntrusted("selection", input.selectedText.slice(0, 4000))}`);
  if (input.documentText) parts.push(`WHOLE DOCUMENT:\n${wrapUntrusted("document", input.documentText)}`);
  return parts.join("\n\n");
}

/** Recent conversation as chat messages, trimmed to a character budget so small models keep room to answer. */
export function historyMessages(characterBudget: number, history: ConversationMessage[] = readConversation(40)): OllamaMessage[] {
  const messages: OllamaMessage[] = [];
  let used = 0;
  for (const message of [...history].reverse()) {
    used += message.text.length;
    if (used > characterBudget) break;
    messages.unshift({ role: message.role, content: message.text });
  }
  return messages;
}
