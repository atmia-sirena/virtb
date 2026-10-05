// Every test file gets its own throwaway state directory (%APPDATA%\Pip stand-in).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PIP_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pip-test-"));
process.env.PIP_SPEECH_SERVER = "off"; // tests never reach a real speech server
