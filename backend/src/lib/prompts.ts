// Prompt files live in shared/prompts so they can be tuned without code changes.
import fs from "node:fs";
import path from "node:path";
import { sharedDirectory } from "../config.js";

const promptCache = new Map<string, { text: string; modifiedAt: number }>();

export function loadPrompt(name: string): string {
  const promptPath = path.join(sharedDirectory, "prompts", `${name}.md`);
  const modifiedAt = fs.statSync(promptPath).mtimeMs;
  const cached = promptCache.get(name);
  if (cached && cached.modifiedAt === modifiedAt) return cached.text;
  const text = fs.readFileSync(promptPath, "utf8").trim();
  promptCache.set(name, { text, modifiedAt });
  return text;
}

let untrustedCounter = 0;

/**
 * Wraps text from the screen, web pages, files or connectors so the local
 * models treat it as data. Small models are easier to hijack than frontier
 * ones, so every prompt that carries such text uses this.
 */
export function wrapUntrusted(source: string, text: string): string {
  untrustedCounter += 1;
  const safeText = text.replace(/<\/?untrusted_content[^>]*>/gi, "");
  return `<untrusted_content id="${source}-${untrustedCounter}">\n${safeText}\n</untrusted_content>`;
}
