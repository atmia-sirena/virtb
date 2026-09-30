// Local speech-to-text with NVIDIA Parakeet (via sherpa-onnx). Parakeet is an
// offline model, so live text comes from re-decoding the recent audio every
// ~600 ms while the key is held (it decodes several seconds of speech in a
// few hundred milliseconds on CPU); the final decode runs at key-up. Long
// dictation is committed in segments at pauses so each decode stays small.
import crypto from "node:crypto";
import { readSettings } from "../config.js";
import { findModelFile, getSpeechModel, isSpeechModelInstalled, speechModelDirectory } from "./catalog.js";
import { decodeWav, loadSherpa, pcm16ToFloat32, type SherpaOfflineRecognizer } from "./sherpa.js";

export const asrSampleRate = 16000;

let recognizerPromise: Promise<SherpaOfflineRecognizer> | undefined;
let loadedModelId: string | undefined;

export function asrStatus(): { model: string; installed: boolean } {
  const modelId = readSettings().speech.asrModel;
  const model = getSpeechModel(modelId);
  return { model: modelId, installed: Boolean(model && isSpeechModelInstalled(model)) };
}

export function getRecognizer(): Promise<SherpaOfflineRecognizer> {
  const modelId = readSettings().speech.asrModel;
  if (recognizerPromise && loadedModelId === modelId) return recognizerPromise;
  const model = getSpeechModel(modelId);
  if (!model || !isSpeechModelInstalled(model)) {
    return Promise.reject(new Error(`speech model ${modelId} isn't downloaded. Run: npm run setup:speech`));
  }
  const directory = speechModelDirectory(model);
  const threads = Math.max(2, Math.min(8, readSettings().speech.threads));
  loadedModelId = modelId;
  recognizerPromise = loadSherpa().OfflineRecognizer.createAsync({
    featConfig: { sampleRate: asrSampleRate, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: findModelFile(directory, /^encoder.*\.onnx$/),
        decoder: findModelFile(directory, /^decoder.*\.onnx$/),
        joiner: findModelFile(directory, /^joiner.*\.onnx$/),
      },
      tokens: `${directory}/tokens.txt`,
      numThreads: threads,
      provider: "cpu",
      modelType: "nemo_transducer",
      debug: 0,
    },
    decodingMethod: "greedy_search",
  });
  recognizerPromise.catch(() => {
    recognizerPromise = undefined;
  });
  return recognizerPromise;
}

export async function transcribeSamples(samples: Float32Array, sampleRate: number): Promise<string> {
  if (samples.length < sampleRate * 0.15) return "";
  const recognizer = await getRecognizer();
  let audio = samples;
  if (sampleRate !== asrSampleRate) audio = new (loadSherpa().LinearResampler)(sampleRate, asrSampleRate).resample(samples);
  // A short tail of silence helps the transducer flush its last word.
  const padded = new Float32Array(audio.length + Math.round(asrSampleRate * 0.3));
  padded.set(audio);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples: padded, sampleRate: asrSampleRate });
  const result = await recognizer.decodeAsync(stream);
  return result.text.trim();
}

export async function transcribeWavFile(bytes: Uint8Array): Promise<string> {
  const waveform = decodeWav(bytes);
  return transcribeSamples(waveform.samples, waveform.sampleRate);
}

// ---------------------------------------------------------------------------
// Push-to-talk sessions: the client posts 16 kHz PCM16 chunks while the key is held.

interface AsrSession {
  id: string;
  committedText: string;
  pending: Float32Array[];
  pendingLength: number;
  lastInterimAt: number;
  interimText: string;
  decoding?: Promise<void>;
  createdAt: number;
}

const sessions = new Map<string, AsrSession>();
const interimIntervalMs = 600;
const maxSegmentSeconds = 20;

function concatenate(chunks: Float32Array[], length: number): Float32Array {
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** Index of the quietest 200 ms window in the last third of the audio, used to cut long dictation at a pause. */
export function findPauseIndex(samples: Float32Array, sampleRate: number): number {
  const windowSize = Math.round(sampleRate * 0.2);
  let bestIndex = samples.length;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let start = Math.floor(samples.length * 0.66); start + windowSize <= samples.length; start += Math.round(windowSize / 2)) {
    let energy = 0;
    for (let index = start; index < start + windowSize; index += 1) energy += samples[index] * samples[index];
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestIndex = start + Math.round(windowSize / 2);
    }
  }
  return bestIndex;
}

function joinText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

export function startAsrSession(): string {
  for (const [sessionId, session] of sessions) if (Date.now() - session.createdAt > 30 * 60_000) sessions.delete(sessionId);
  const id = crypto.randomUUID();
  sessions.set(id, { id, committedText: "", pending: [], pendingLength: 0, lastInterimAt: 0, interimText: "", createdAt: Date.now() });
  // Load the model now so the first decode doesn't pay for it.
  void getRecognizer().catch(() => undefined);
  return id;
}

async function decodePending(session: AsrSession, final: boolean): Promise<void> {
  const audio = concatenate(session.pending, session.pendingLength);
  if (!final && audio.length > maxSegmentSeconds * asrSampleRate) {
    const cut = findPauseIndex(audio, asrSampleRate);
    const committedAudio = audio.subarray(0, cut);
    const remaining = audio.slice(cut);
    session.committedText = joinText(session.committedText, await transcribeSamples(committedAudio, asrSampleRate));
    session.pending = [remaining];
    session.pendingLength = remaining.length;
    session.interimText = "";
    return;
  }
  session.interimText = await transcribeSamples(audio, asrSampleRate);
}

/** Appends a chunk; returns the live transcript (re-decoded at most every 600 ms). */
export async function appendAsrAudio(sessionId: string, pcm16: Uint8Array): Promise<{ text: string } | undefined> {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  const samples = pcm16ToFloat32(pcm16);
  session.pending.push(samples);
  session.pendingLength += samples.length;
  if (!session.decoding && Date.now() - session.lastInterimAt >= interimIntervalMs) {
    session.lastInterimAt = Date.now();
    session.decoding = decodePending(session, false).finally(() => {
      session.decoding = undefined;
    });
  }
  return { text: joinText(session.committedText, session.interimText) };
}

export async function finishAsrSession(sessionId: string): Promise<{ text: string } | undefined> {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  sessions.delete(sessionId);
  if (session.decoding) await session.decoding.catch(() => undefined);
  await decodePending(session, true);
  return { text: joinText(session.committedText, session.interimText).trim() };
}

export function cancelAsrSession(sessionId: string): void {
  sessions.delete(sessionId);
}
