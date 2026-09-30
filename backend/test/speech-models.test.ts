// Runs the real open-source models when they're downloaded (npm run setup:speech,
// or PIP_MODELS_DIR pointing at them). Skipped otherwise.
import { describe, expect, it } from "vitest";
import { resetSettingsCacheForTests } from "../src/config.js";
import { appendAsrAudio, finishAsrSession, startAsrSession } from "../src/speech/asr.js";
import { getSpeechModel, isSpeechModelInstalled } from "../src/speech/catalog.js";
import { loadSherpa, float32ToPcm16 } from "../src/speech/sherpa.js";
import { synthesize } from "../src/speech/tts.js";

resetSettingsCacheForTests();
const installed = [getSpeechModel("parakeet-tdt-0.6b-v3")!, getSpeechModel("kokoro-v1.0")!].every(isSpeechModelInstalled);

describe.skipIf(!installed)("local speech models", () => {
  it("Kokoro speaks a sentence and Parakeet transcribes it back through a push-to-talk session", async () => {
    const spoken = await synthesize("hit export up here, then pick png in the menu.");
    expect(spoken.sampleRate).toBe(24000);
    const samples = new Float32Array(spoken.pcm.length / 2);
    for (let index = 0; index < samples.length; index += 1) samples[index] = spoken.pcm.readInt16LE(index * 2) / 32768;
    const at16k = new (loadSherpa().LinearResampler)(24000, 16000).resample(samples);
    const pcm = float32ToPcm16(at16k);
    const sessionId = startAsrSession();
    const chunkBytes = 16000 * 2 * 0.25; // 250 ms chunks, like the client sends
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) await appendAsrAudio(sessionId, new Uint8Array(pcm.subarray(offset, offset + chunkBytes)));
    const result = await finishAsrSession(sessionId);
    expect(result!.text.toLowerCase()).toContain("export");
    expect(result!.text.toLowerCase()).toContain("menu");
  }, 120000);
});
