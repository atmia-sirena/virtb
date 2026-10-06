// Your own test set: short clips recorded in Home with the text you meant.
// eval/run.py --set personal scores every engine and cleanup setting on them,
// and training/recipes/personal_adapt.py can fine-tune on them. Stays on the PC.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDirectory } from "../config.js";

export const personalEvalDirectory = () => path.join(stateDirectory, "eval", "personal");

export function savePersonalClip(clip: { audio: string; reference: string; language?: string; app?: string }): { id: string; count: number } {
  const directory = personalEvalDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const audio = Buffer.from(clip.audio, "base64");
  if (audio.subarray(0, 4).toString("ascii") !== "RIFF") throw new Error("audio must be a WAV file");
  fs.writeFileSync(path.join(directory, `${id}.wav`), audio);
  const entry = { id, audio: `${id}.wav`, reference: clip.reference.trim(), language: clip.language ?? "en-IN", app: clip.app ?? null, recordedAt: new Date().toISOString() };
  fs.appendFileSync(path.join(directory, "manifest.jsonl"), `${JSON.stringify(entry)}\n`);
  const count = fs.readFileSync(path.join(directory, "manifest.jsonl"), "utf8").split("\n").filter(Boolean).length;
  return { id, count };
}
