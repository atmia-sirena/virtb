// Local speech-to-text with NVIDIA Parakeet (via sherpa-onnx). Parakeet is an
// offline model, so live text comes from re-decoding the recent audio every
// ~600 ms while the key is held (it decodes several seconds of speech in a
// few hundred milliseconds on CPU); the final decode runs at key-up. Long
// dictation is committed in segments at pauses so each decode stays small.
import crypto from "node:crypto";
import { readSettings, updateSettings } from "../config.js";
import type { ActiveApp } from "../lib/skills.js";
import type { TimedWord } from "./cleanup/tokens.js";
import { speechServerHealthy, speechServerRequest, speechServerUrl } from "./sidecar.js";
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
// With the GPU speech server running (speech-server/), sessions are proxied to it:
// language ID across your languages, the best model per language, timed words.
// Otherwise (or if it fails mid-utterance) Parakeet decodes on the CPU here.

export interface AsrSessionOptions {
  /** Languages to consider; defaults to settings.speech.languages. */
  languages?: string[];
  /** Forced language (the language-cycle hotkey). */
  language?: string;
  app?: ActiveApp;
  /** Extra spellings to bias towards (names on screen); the personal dictionary is always sent. */
  context?: string[];
}

export interface AsrFinal {
  text: string;
  language?: string;
  words?: TimedWord[];
  confidence?: number;
  model?: string;
  engine: "sidecar" | "local";
}

interface AsrSession {
  id: string;
  committedText: string;
  pending: Float32Array[];
  pendingLength: number;
  lastInterimAt: number;
  interimText: string;
  decoding?: Promise<void>;
  createdAt: number;
  options: AsrSessionOptions;
  /** Speech-server session id while proxying. */
  remoteId?: string;
  /** Raw audio kept while proxying, so the CPU can take over if the server fails. */
  raw: Uint8Array[];
  language?: string;
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

const appKey = (app: ActiveApp | undefined) => (app?.process ?? "").toLowerCase().replace(/\.exe$/, "");

export async function startAsrSession(options: AsrSessionOptions = {}): Promise<{ id: string; engine: "sidecar" | "local" }> {
  for (const [sessionId, session] of sessions) if (Date.now() - session.createdAt > 30 * 60_000) sessions.delete(sessionId);
  const settings = readSettings();
  const id = crypto.randomUUID();
  const session: AsrSession = { id, committedText: "", pending: [], pendingLength: 0, lastInterimAt: 0, interimText: "", createdAt: Date.now(), options, raw: [] };
  if (settings.speech.asrEngine !== "local" && (await speechServerHealthy())) {
    try {
      const created = await speechServerRequest<{ sessionId: string }>(
        "/sessions",
        {
          languages: options.languages ?? settings.speech.languages,
          language: options.language,
          prior: settings.speech.perApp[appKey(options.app)],
          context: [...settings.dictation.dictionary.slice(-150), ...(options.context ?? []).slice(0, 50)],
        },
        1500,
      );
      session.remoteId = created.sessionId;
    } catch (error) {
      console.warn("[asr] speech server didn't start a session, using the CPU:", (error as Error).message);
    }
  }
  sessions.set(id, session);
  // Load the CPU model now so the first decode (or a fallback) doesn't pay for it.
  if (!session.remoteId) void getRecognizer().catch(() => undefined);
  return { id, engine: session.remoteId ? "sidecar" : "local" };
}

/** Moves a proxied session onto the CPU path, replaying the audio received so far. */
function fallBackToLocal(session: AsrSession): void {
  session.remoteId = undefined;
  for (const chunk of session.raw) {
    const samples = pcm16ToFloat32(chunk);
    session.pending.push(samples);
    session.pendingLength += samples.length;
  }
  session.raw = [];
  void getRecognizer().catch(() => undefined);
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
export async function appendAsrAudio(sessionId: string, pcm16: Uint8Array): Promise<{ text: string; language?: string } | undefined> {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (session.remoteId) {
    session.raw.push(pcm16.slice());
    try {
      const live = await speechServerRequest<{ text: string; language?: string | null }>(`/sessions/${session.remoteId}/audio`, pcm16, 3000);
      session.interimText = live.text;
      if (live.language) session.language = live.language;
      return { text: live.text, ...(session.language ? { language: session.language } : {}) };
    } catch (error) {
      console.warn("[asr] speech server dropped the session, continuing on the CPU:", (error as Error).message);
      fallBackToLocal(session);
      return { text: session.interimText };
    }
  }
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

// Finished transcripts (with language and timed words) for the cleanup call that follows.
const finished = new Map<string, { result: AsrFinal; at: number }>();

export function takeAsrResult(sessionId: string | undefined): AsrFinal | undefined {
  if (!sessionId) return undefined;
  const entry = finished.get(sessionId);
  finished.delete(sessionId);
  return entry && Date.now() - entry.at < 5 * 60_000 ? entry.result : undefined;
}

function remember(sessionId: string, result: AsrFinal, app: ActiveApp | undefined): AsrFinal {
  for (const [key, entry] of finished) if (Date.now() - entry.at > 5 * 60_000) finished.delete(key);
  finished.set(sessionId, { result, at: Date.now() });
  // Learn this app's language, the prior for its next dictation.
  const key = appKey(app);
  if (key && result.language && result.text && readSettings().speech.perApp[key] !== result.language) {
    updateSettings({ speech: { perApp: { [key]: result.language } } });
  }
  return result;
}

/** `language` overrides language ID for this utterance (the language-cycle hotkey pressed mid-dictation). */
export async function finishAsrSession(sessionId: string, language?: string): Promise<AsrFinal | undefined> {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  sessions.delete(sessionId);
  if (session.remoteId) {
    try {
      const remote = await speechServerRequest<{ text: string; language?: string; words?: TimedWord[]; confidence?: number | null; model?: string }>(`/sessions/${session.remoteId}/finish`, language ? { language } : {}, 20_000);
      const result: AsrFinal = { text: remote.text.trim(), language: remote.language, words: remote.words, model: remote.model, engine: "sidecar", ...(remote.confidence != null ? { confidence: remote.confidence } : {}) };
      return remember(sessionId, result, session.options.app);
    } catch (error) {
      console.warn("[asr] speech server failed to finish, decoding on the CPU:", (error as Error).message);
      fallBackToLocal(session);
    }
  }
  if (session.decoding) await session.decoding.catch(() => undefined);
  await decodePending(session, true);
  const result: AsrFinal = { text: joinText(session.committedText, session.interimText).trim(), engine: "local", model: readSettings().speech.asrModel, ...(language ? { language } : {}) };
  return remember(sessionId, result, undefined);
}

export function cancelAsrSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (session?.remoteId) void fetch(`${speechServerUrl()}/sessions/${session.remoteId}`, { method: "DELETE" }).catch(() => undefined);
}
