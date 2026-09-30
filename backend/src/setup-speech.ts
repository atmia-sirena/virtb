// Downloads Pip's open-source speech models (sherpa-onnx builds on GitHub) into
// %APPDATA%\Pip\models. Usage: npm run setup:speech [-- model-id ...]
// Defaults: parakeet-tdt-0.6b-v3 (speech-to-text) and kokoro-v1.0 (voice).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getSpeechModel, isSpeechModelInstalled, modelsDirectory, speechModels } from "./speech/catalog.js";

const requested = process.argv.slice(2);
const modelIds = requested.length > 0 ? requested : ["parakeet-tdt-0.6b-v3", "kokoro-v1.0"];

fs.mkdirSync(modelsDirectory(), { recursive: true });
for (const modelId of modelIds) {
  const model = getSpeechModel(modelId);
  if (!model) {
    console.error(`unknown model ${modelId}. choose from: ${speechModels.map((candidate) => candidate.id).join(", ")}`);
    process.exitCode = 1;
    continue;
  }
  if (isSpeechModelInstalled(model)) {
    console.log(`✓ ${model.id} already in ${modelsDirectory()}`);
    continue;
  }
  const archivePath = path.join(modelsDirectory(), path.basename(model.url));
  console.log(`↓ ${model.id} (~${model.approximateMegabytes} MB, ${model.license}) ...`);
  const response = await fetch(model.url);
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status} ${model.url}`);
  await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(archivePath));
  // Windows 10+ ships bsdtar as tar.exe, which reads .tar.bz2.
  execFileSync("tar", ["-xjf", archivePath, "-C", modelsDirectory()], { stdio: "inherit" });
  fs.rmSync(archivePath);
  console.log(`✓ ${model.id} ready`);
}
