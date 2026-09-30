// Picks the agent engine. HeyClicky always runs its bundled Codex; Pip runs
// Codex when it's installed and falls back to the built-in loop when it isn't,
// or when Codex can't drive the local model (Codex + Ollama tool calls are a
// known weak spot).
import { readSettings } from "../config.js";
import { builtinEngine } from "./builtin.js";
import { codexEngine, findCodex } from "./codex.js";
import { setEngineResolver, type Engine } from "./runner.js";

const codexWithFallback: Engine = async (context) => {
  try {
    return await codexEngine(context);
  } catch (error) {
    if (context.signal.aborted) throw error;
    const message = (error as Error).message;
    context.step(`codex stopped (${message.split("\n")[0].slice(0, 100)}); switching to pip's own agent loop`, "warning");
    return await builtinEngine(context);
  }
};

export function installEngineResolver(): void {
  setEngineResolver(async () => {
    const preference = readSettings().agents.engine;
    if (preference === "builtin") return { name: "builtin", engine: builtinEngine };
    if (findCodex()) return { name: "codex", engine: preference === "codex" ? codexEngine : codexWithFallback };
    if (preference === "codex") throw new Error("Codex CLI isn't installed. Run: npm install -g @openai/codex");
    return { name: "builtin", engine: builtinEngine };
  });
}
