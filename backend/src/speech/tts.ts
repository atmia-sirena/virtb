// Local text-to-speech with Kokoro-82M (or Piper for slow CPUs) via
// sherpa-onnx. The client asks for one beat sentence at a time and fetches the
// next one while the current one plays, so the first words start fast.
import { readSettings } from "../config.js";
import { findModelFile, getSpeechModel, isSpeechModelInstalled, kokoroVoices, speechModelDirectory } from "./catalog.js";
import { float32ToPcm16, loadSherpa, type SherpaOfflineTts } from "./sherpa.js";
import fs from "node:fs";
import path from "node:path";

let ttsPromise: Promise<SherpaOfflineTts> | undefined;
let loadedModelId: string | undefined;

export function ttsStatus(): { model: string; installed: boolean; voices: readonly string[] } {
  const modelId = readSettings().speech.ttsModel;
  const model = getSpeechModel(modelId);
  return { model: modelId, installed: Boolean(model && isSpeechModelInstalled(model)), voices: model?.engine === "kokoro" ? kokoroVoices : ["default"] };
}

export function getTts(): Promise<SherpaOfflineTts> {
  const modelId = readSettings().speech.ttsModel;
  if (ttsPromise && loadedModelId === modelId) return ttsPromise;
  const model = getSpeechModel(modelId);
  if (!model || !isSpeechModelInstalled(model)) return Promise.reject(new Error(`voice model ${modelId} isn't downloaded. Run: npm run setup:speech`));
  const directory = speechModelDirectory(model);
  const threads = Math.max(2, Math.min(8, readSettings().speech.threads));
  const modelConfig =
    model.engine === "kokoro"
      ? {
          kokoro: {
            model: findModelFile(directory, /^model.*\.onnx$/),
            voices: path.join(directory, "voices.bin"),
            tokens: path.join(directory, "tokens.txt"),
            dataDir: path.join(directory, "espeak-ng-data"),
            lexicon: ["lexicon-us-en.txt", "lexicon-zh.txt"].map((file) => path.join(directory, file)).filter((file) => fs.existsSync(file)).join(","),
          },
        }
      : {
          vits: {
            model: findModelFile(directory, /\.onnx$/),
            tokens: path.join(directory, "tokens.txt"),
            dataDir: path.join(directory, "espeak-ng-data"),
          },
        };
  loadedModelId = modelId;
  ttsPromise = loadSherpa().OfflineTts.createAsync({ model: { ...modelConfig, numThreads: threads, provider: "cpu", debug: 0 }, maxNumSentences: 1 });
  ttsPromise.catch(() => {
    ttsPromise = undefined;
  });
  return ttsPromise;
}

export function speakerIdFor(voiceName: string): number {
  const index = kokoroVoices.indexOf(voiceName as (typeof kokoroVoices)[number]);
  return index >= 0 ? index : kokoroVoices.indexOf("af_heart");
}

/** Spoken text only: no tags, markdown or symbols the voice would read out. */
export function prepareForSpeech(text: string): string {
  return text
    .replace(/\[[A-Z]+(:[^\]]*)?\]/g, " ")
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/[*_#`>|]/g, " ")
    .replace(/[—–]/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function synthesize(text: string, options: { voice?: string; speed?: number } = {}): Promise<{ pcm: Buffer; sampleRate: number }> {
  const settings = readSettings();
  const tts = await getTts();
  const spoken = prepareForSpeech(text);
  if (!spoken) return { pcm: Buffer.alloc(0), sampleRate: tts.sampleRate };
  const sid = tts.numSpeakers > 1 ? speakerIdFor(options.voice ?? settings.voice.voiceName) : 0;
  const speed = Math.max(0.5, Math.min(1.5, options.speed ?? settings.voice.speed));
  const audio = await tts.generateAsync({ text: spoken, sid, speed });
  return { pcm: float32ToPcm16(audio.samples), sampleRate: audio.sampleRate };
}

/** Loads the voice and runs one tiny generation so the first real sentence is fast. */
export async function warmTts(): Promise<void> {
  await synthesize("ok.");
}
