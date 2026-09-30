// Model policy: which local model and options serve each job.
// Mirrors HeyClicky's /runtime/model-policy, but every entry is an Ollama model.
import { readSettings, type ModelJob } from "../config.js";
import { listInstalledModels, type OllamaOptions } from "./ollama.js";

interface JobDefaults {
  /** Base model the pip-* alias is built from (scripts/Modelfiles). */
  baseModel: string;
  keepAlive: string | number;
  options: OllamaOptions;
}

// Parameter choices documented in the build plan's model table.
export const jobDefaults: Record<ModelJob, JobDefaults> = {
  router: { baseModel: "llama3.2:3b", keepAlive: -1, options: { temperature: 0, num_ctx: 8192, num_predict: 64 } },
  talk: { baseModel: "llama3.2:3b", keepAlive: -1, options: { temperature: 0.4, num_ctx: 8192, num_predict: 300 } },
  cleanup: { baseModel: "llama3.2:3b", keepAlive: -1, options: { temperature: 0, num_ctx: 8192, num_predict: 400 } },
  memory: { baseModel: "llama3.2:3b", keepAlive: -1, options: { temperature: 0, num_ctx: 8192, num_predict: 600 } },
  jev: { baseModel: "llama3.2:3b", keepAlive: -1, options: { temperature: 0, num_ctx: 4096, num_predict: 24 } },
  vision: { baseModel: "llava:13b", keepAlive: "30m", options: { temperature: 0.1, num_ctx: 4096, num_predict: 400 } },
  grounding: { baseModel: "qwen2.5vl:7b", keepAlive: "30m", options: { temperature: 0, num_ctx: 8192, num_predict: 200 } },
  deep: { baseModel: "llama3.3:70b", keepAlive: "10m", options: { temperature: 0.3, num_ctx: 16384, num_predict: 1024 } },
  agent: { baseModel: "llama3.3:70b", keepAlive: "10m", options: { temperature: 0.2, num_ctx: 32768, num_predict: 4096 } },
};

let installedModelNames: Set<string> | undefined;
let installedModelsCheckedAt = 0;

export async function refreshInstalledModels(): Promise<Set<string>> {
  try {
    installedModelNames = new Set(await listInstalledModels());
  } catch {
    installedModelNames = new Set();
  }
  installedModelsCheckedAt = Date.now();
  return installedModelNames;
}

function normalizeModelName(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

export function isModelInstalled(name: string): boolean {
  if (!installedModelNames) return false;
  return installedModelNames.has(name) || installedModelNames.has(normalizeModelName(name));
}

export interface ResolvedModel {
  job: ModelJob;
  model: string;
  keepAlive: string | number;
  options: OllamaOptions;
  available: boolean;
}

/**
 * Resolves the configured model for a job. When the pip-* alias hasn't been
 * created yet, falls back to the base model so the app still works before
 * scripts/setup-models has run.
 */
export async function resolveModel(job: ModelJob, optionOverrides: OllamaOptions = {}): Promise<ResolvedModel> {
  if (!installedModelNames || Date.now() - installedModelsCheckedAt > 60_000) await refreshInstalledModels();
  const defaults = jobDefaults[job];
  const configuredModel = readSettings().models[job] ?? defaults.baseModel;
  let model = configuredModel;
  if (!isModelInstalled(configuredModel) && isModelInstalled(defaults.baseModel)) model = defaults.baseModel;
  return {
    job,
    model,
    keepAlive: defaults.keepAlive,
    options: { ...defaults.options, ...optionOverrides },
    available: isModelInstalled(model),
  };
}

/** The model policy the client and Home read (like HeyClicky's /runtime/model-policy). */
export async function describeModelPolicy() {
  await refreshInstalledModels();
  const jobs = Object.keys(jobDefaults) as ModelJob[];
  const policy: Record<string, unknown> = {};
  for (const job of jobs) {
    const resolved = await resolveModel(job);
    policy[job] = { model: resolved.model, available: resolved.available, keepAlive: resolved.keepAlive, options: resolved.options };
  }
  return { installed: [...(installedModelNames ?? [])].sort(), jobs: policy };
}

export function setInstalledModelsForTests(names: string[]): void {
  installedModelNames = new Set(names);
  installedModelsCheckedAt = Date.now();
}
