// App skills: Markdown teaching playbooks matched by foreground process or
// browser domain (HeyClicky ships ~89; build 1 ships a handful in shared/skills).
import fs from "node:fs";
import path from "node:path";
import { sharedDirectory } from "../config.js";

export interface AppSkill {
  name: string;
  processes: string[];
  domains: string[];
  titles: string[];
  body: string;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter(Boolean);
}

export function parseSkill(fileText: string, fallbackName: string): AppSkill {
  const frontMatter = fileText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fields: Record<string, string> = {};
  if (frontMatter) {
    for (const line of frontMatter[1].split(/\r?\n/)) {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex > 0) fields[line.slice(0, separatorIndex).trim()] = line.slice(separatorIndex + 1).trim();
    }
  }
  return {
    name: fields.name ?? fallbackName,
    processes: parseList(fields.match_processes),
    domains: parseList(fields.match_domains),
    titles: parseList(fields.match_titles),
    body: (frontMatter ? fileText.slice(frontMatter[0].length) : fileText).trim(),
  };
}

let loadedSkills: AppSkill[] | undefined;

export function loadSkills(): AppSkill[] {
  if (loadedSkills) return loadedSkills;
  const skillsDirectory = path.join(sharedDirectory, "skills");
  loadedSkills = fs.existsSync(skillsDirectory)
    ? fs
        .readdirSync(skillsDirectory)
        .filter((fileName) => fileName.endsWith(".md"))
        .map((fileName) => parseSkill(fs.readFileSync(path.join(skillsDirectory, fileName), "utf8"), fileName.replace(/\.md$/, "")))
    : [];
  return loadedSkills;
}

export interface ActiveApp {
  name?: string;
  process?: string;
  title?: string;
  url?: string;
}

export function matchSkill(activeApp: ActiveApp | undefined, skills: AppSkill[] = loadSkills()): AppSkill | undefined {
  if (!activeApp) return undefined;
  const processName = (activeApp.process ?? "").toLowerCase().replace(/\.exe$/, "");
  let domain = "";
  try {
    domain = activeApp.url ? new URL(activeApp.url).hostname.toLowerCase() : "";
  } catch {
    domain = "";
  }
  // A domain match beats the browser's own playbook.
  const byDomain = domain ? skills.find((skill) => skill.domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))) : undefined;
  if (byDomain) return byDomain;
  const byProcess = skills.find((skill) => skill.processes.includes(processName));
  if (byProcess) return byProcess;
  const title = (activeApp.title ?? "").toLowerCase();
  return skills.find((skill) => skill.titles.some((candidate) => title.includes(candidate)));
}
