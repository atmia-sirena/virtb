// Typed access to the sherpa-onnx native addon (CommonJS, no bundled types).
import { createRequire } from "node:module";

export interface SherpaWaveform {
  samples: Float32Array;
  sampleRate: number;
}

export interface SherpaOfflineStream {
  acceptWaveform(waveform: SherpaWaveform): void;
}

export interface SherpaOfflineRecognizer {
  createStream(hotwords?: string): SherpaOfflineStream;
  decodeAsync(stream: SherpaOfflineStream): Promise<{ text: string; lang?: string }>;
}

export interface SherpaOfflineTts {
  sampleRate: number;
  numSpeakers: number;
  generateAsync(request: { text: string; sid: number; speed: number; onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void }): Promise<SherpaWaveform>;
}

export interface SherpaModule {
  OfflineRecognizer: { createAsync(config: unknown): Promise<SherpaOfflineRecognizer> };
  OfflineTts: { createAsync(config: unknown): Promise<SherpaOfflineTts> };
  LinearResampler: new (inputRate: number, outputRate: number) => { resample(samples: Float32Array): Float32Array };
  version: string;
}

let sherpaModule: SherpaModule | undefined;

export function loadSherpa(): SherpaModule {
  if (!sherpaModule) {
    const require = createRequire(import.meta.url);
    sherpaModule = require("sherpa-onnx-node") as SherpaModule;
  }
  return sherpaModule;
}

/** 16-bit little-endian PCM bytes -> float samples in [-1, 1]. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}

/** Float samples -> 16-bit little-endian PCM bytes. */
export function float32ToPcm16(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(clamped * 32767), index * 2);
  }
  return buffer;
}

/** Reads a mono or stereo 16-bit PCM WAV file (what the client uploads). */
export function decodeWav(bytes: Uint8Array): SherpaWaveform {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") throw new Error("not a WAV file");
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bitsPerSample = 16;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = text(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === "fmt ") {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === "data") {
      if (bitsPerSample !== 16) throw new Error("only 16-bit WAV is supported");
      const interleaved = pcm16ToFloat32(bytes.subarray(offset + 8, offset + 8 + chunkSize));
      if (channels === 1) return { samples: interleaved, sampleRate };
      const mono = new Float32Array(Math.floor(interleaved.length / channels));
      for (let frame = 0; frame < mono.length; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) sum += interleaved[frame * channels + channel];
        mono[frame] = sum / channels;
      }
      return { samples: mono, sampleRate };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error("WAV has no data chunk");
}
