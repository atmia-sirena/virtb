// Entry point: loads backend/.env, prepares %APPDATA%\Pip, warms the fast
// models (HeyClicky warms its session and network paths at launch), and
// serves on localhost only.
import { serve } from "@hono/node-server";
import { ensureStateDirectories, environment, loadDotEnvFile } from "./config.js";
import { installEngineResolver } from "./agents/engines.js";
import { startRoutineScheduler } from "./agents/routines.js";
import { createApp, pipVersion } from "./app.js";
import { refreshInstalledModels, resolveModel } from "./lib/models.js";
import { warmModel } from "./lib/ollama.js";
import { asrStatus, getRecognizer } from "./speech/asr.js";
import { startSpeechServer } from "./speech/sidecar.js";
import { ttsStatus, warmTts } from "./speech/tts.js";

loadDotEnvFile();
ensureStateDirectories();
installEngineResolver();

const app = createApp();
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: environment.port }, (info) => {
  console.log(`pip backend ${pipVersion} on http://127.0.0.1:${info.port}  (ollama: ${environment.ollamaBaseUrl})`);
});

async function warmUp(): Promise<void> {
  const installed = await refreshInstalledModels();
  if (installed.size === 0) {
    console.warn("[pip] Ollama isn't reachable or has no models. Start it with `ollama serve` and run scripts/setup-models.");
    return;
  }
  for (const job of ["talk", "vision"] as const) {
    const model = await resolveModel(job);
    if (!model.available) {
      console.warn(`[pip] ${job} model ${model.model} isn't installed.`);
      continue;
    }
    await warmModel(model.model, model.keepAlive).catch(() => undefined);
    console.log(`[pip] warmed ${model.model} for ${job}`);
  }
}

async function warmSpeech(): Promise<void> {
  if (!asrStatus().installed || !ttsStatus().installed) {
    console.warn("[pip] speech models aren't downloaded yet. Run: npm run setup:speech --prefix backend");
    return;
  }
  const startedAt = Date.now();
  await Promise.all([getRecognizer(), warmTts()]);
  console.log(`[pip] speech ready (${asrStatus().model}, ${ttsStatus().model}) in ${Date.now() - startedAt} ms`);
}

// The GPU speech server for Indian languages, when installed (speech-server/).
if (startSpeechServer()) console.log("[pip] starting the speech server (Indian-language dictation on the GPU)");
void warmUp();
void warmSpeech().catch((error) => console.warn("[pip] speech warm-up failed:", error.message));
startRoutineScheduler();

// Nothing runs after quit: closing the app stops the backend and its agent runs.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
