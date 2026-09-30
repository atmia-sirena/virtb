import { describe, expect, it } from "vitest";
import { buildCandidates } from "../src/mcp/jev-candidates.js";
import { parseSkill, matchSkill } from "../src/lib/skills.js";
import { spokenSummary } from "../src/agents/runner.js";
import { codexMcpServersToml } from "../src/agents/connectors.js";
import { findPauseIndex } from "../src/speech/asr.js";
import { prepareForSpeech, speakerIdFor } from "../src/speech/tts.js";
import { decodeWav, float32ToPcm16, pcm16ToFloat32 } from "../src/speech/sherpa.js";

describe("Jev candidates", () => {
  const elements = [
    { role: "Button", label: "Close", element_token: "t0" },
    { role: "Button", label: "Save", element_token: "t1" },
    { role: "Button", label: "Send", element_token: "t2" },
    { role: "Edit", label: "Note", value: "", element_token: "t3" },
    { role: "CheckBox", label: "I agree", element_token: "t4", enabled: false },
    { role: "Text", label: "Just a label", element_token: "t5" },
    { role: "Button", label: "Save", element_token: "t6" },
  ];
  it("keeps enabled labeled controls, drops chrome, static text and denied labels", () => {
    const candidates = buildCandidates(elements, "set the note and save", ["send"]);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["button:save", "text_input:note", "button:save_2"]);
    expect(candidates[1].description).toBe('text_input "Note" (empty)');
  });
});

describe("app skills", () => {
  const skills = [
    parseSkill("---\nname: chrome\nmatch_processes: [chrome, msedge]\n---\n# Chrome", "chrome"),
    parseSkill("---\nname: youtube\nmatch_domains: [youtube.com]\n---\n# YouTube", "youtube"),
  ];
  it("prefers a domain match over the browser's own playbook", () => {
    expect(matchSkill({ process: "chrome.exe", url: "https://www.youtube.com/watch?v=1" }, skills)?.name).toBe("youtube");
    expect(matchSkill({ process: "msedge.exe", url: "https://example.com" }, skills)?.name).toBe("chrome");
    expect(matchSkill({ process: "notepad.exe" }, skills)).toBeUndefined();
  });
});

it("spokenSummary takes the first sentence without markdown", () => {
  expect(spokenSummary("**Found 3 options.** The best is [Acme](https://acme.com) at $10.")).toBe("Found 3 options.");
});

it("writes Codex MCP server TOML with escaped Windows paths", () => {
  const toml = codexMcpServersToml([{ id: "computer-use", name: "computer-use", kind: "stdio", command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\pip\\desktop-server.js", "computer-use"], env: { PIP_BACKEND_URL: "http://127.0.0.1:8787" }, enabled: true }]);
  expect(toml).toContain('[mcp_servers.computer-use]');
  expect(toml).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
  expect(toml).toContain("[mcp_servers.computer-use.env]");
});

describe("speech helpers", () => {
  it("round-trips PCM16 and reads WAV", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const pcm = float32ToPcm16(samples);
    const back = pcm16ToFloat32(new Uint8Array(pcm));
    expect(Array.from(back).map((value) => Math.round(value * 100) / 100)).toEqual([0, 0.5, -0.5, 1, -1]);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
    header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    const wav = decodeWav(new Uint8Array(Buffer.concat([header, pcm])));
    expect(wav.sampleRate).toBe(16000);
    expect(wav.samples.length).toBe(5);
  });

  it("cuts long dictation at the quietest point near the end", () => {
    const samples = new Float32Array(16000 * 3).map((_, index) => (index > 40000 && index < 43000 ? 0 : Math.sin(index)));
    const cut = findPauseIndex(samples, 16000);
    expect(cut).toBeGreaterThan(40000);
    expect(cut).toBeLessThan(43000);
  });

  it("speaks clean text and maps voices", () => {
    expect(prepareForSpeech("[POINT:#e7:x] hit **export** — see https://a.b/c")).toBe("hit export , see the link");
    expect(speakerIdFor("af_heart")).toBe(3);
    expect(speakerIdFor("nobody")).toBe(3);
  });
});
