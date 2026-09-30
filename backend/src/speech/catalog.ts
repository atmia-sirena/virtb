// Open-source speech models Pip runs locally through sherpa-onnx (Apache-2.0).
// HeyClicky streams speech to Deepgram and speaks with OpenAI Realtime voices;
// Pip keeps every byte of audio on the PC instead.
import fs from "node:fs";
import path from "node:path";
import { stateDirectory } from "../config.js";

export const modelsDirectory = () => process.env.PIP_MODELS_DIR ?? path.join(stateDirectory, "models");

const releaseBase = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export interface SpeechModel {
  id: string;
  kind: "asr" | "tts";
  engine: "nemo_transducer" | "whisper" | "kokoro" | "vits";
  description: string;
  license: string;
  url: string;
  /** Folder name inside the archive. */
  folder: string;
  approximateMegabytes: number;
}

export const speechModels: SpeechModel[] = [
  {
    id: "parakeet-tdt-0.6b-v3",
    kind: "asr",
    engine: "nemo_transducer",
    description: "NVIDIA Parakeet TDT 0.6B v3, int8: fast and accurate on CPU, 25 European languages with auto-detect",
    license: "CC-BY-4.0",
    url: `${releaseBase}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    folder: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    approximateMegabytes: 490,
  },
  {
    id: "parakeet-tdt-0.6b-v2",
    kind: "asr",
    engine: "nemo_transducer",
    description: "NVIDIA Parakeet TDT 0.6B v2, int8: English only, the most accurate English option",
    license: "CC-BY-4.0",
    url: `${releaseBase}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    folder: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    approximateMegabytes: 480,
  },
  {
    id: "kokoro-v1.0",
    kind: "tts",
    engine: "kokoro",
    description: "Kokoro-82M v1.0, int8: natural voices (af_heart, am_michael, bf_emma...), English plus 8 languages",
    license: "Apache-2.0",
    url: `${releaseBase}/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2`,
    folder: "kokoro-int8-multi-lang-v1_0",
    approximateMegabytes: 135,
  },
  {
    id: "piper-amy",
    kind: "tts",
    engine: "vits",
    description: "Piper en_US amy (medium): a less natural but very fast voice for slow CPUs",
    license: "MIT",
    url: `${releaseBase}/tts-models/vits-piper-en_US-amy-medium.tar.bz2`,
    folder: "vits-piper-en_US-amy-medium",
    approximateMegabytes: 65,
  },
];

// Speaker ids in Kokoro v1.0's voices.bin (from the model's speaker_names metadata).
export const kokoroVoices = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  "ef_dora", "em_alex", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola",
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa",
  "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang", "em_santa",
] as const;

export function getSpeechModel(modelId: string): SpeechModel | undefined {
  return speechModels.find((model) => model.id === modelId);
}

export function speechModelDirectory(model: SpeechModel): string {
  return path.join(modelsDirectory(), model.folder);
}

export function isSpeechModelInstalled(model: SpeechModel): boolean {
  const directory = speechModelDirectory(model);
  if (!fs.existsSync(directory)) return false;
  return fs.existsSync(path.join(directory, "tokens.txt"));
}

/** Finds the first file in a model folder matching a pattern (int8 builds name files differently). */
export function findModelFile(directory: string, pattern: RegExp): string {
  const match = fs.readdirSync(directory).find((fileName) => pattern.test(fileName));
  if (!match) throw new Error(`no file matching ${pattern} in ${directory}`);
  return path.join(directory, match);
}
