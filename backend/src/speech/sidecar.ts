// Client for the local GPU speech server (speech-server/, Python, 127.0.0.1:8790).
// Everything here degrades to "not available" quickly so dictation never waits
// on a server that isn't running.

export function speechServerUrl(): string {
  return (process.env.PIP_SPEECH_SERVER_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
}

let healthy: boolean | undefined;
let checkedAt = 0;

export async function speechServerHealthy(maxAgeMs = 10_000): Promise<boolean> {
  if (process.env.PIP_SPEECH_SERVER === "off") return false;
  if (healthy !== undefined && Date.now() - checkedAt < maxAgeMs) return healthy;
  try {
    const response = await fetch(`${speechServerUrl()}/health`, { signal: AbortSignal.timeout(400) });
    healthy = response.ok;
  } catch {
    healthy = false;
  }
  checkedAt = Date.now();
  return healthy;
}

export function markSpeechServer(state: boolean | undefined): void {
  healthy = state;
  checkedAt = state === undefined ? 0 : Date.now();
}

/** IndicXlit in the speech server: native-script words -> Latin. Undefined when the server isn't up. */
export async function transliterateToLatin(words: string[], language = "hi"): Promise<(string | undefined)[] | undefined> {
  if (words.length === 0 || !(await speechServerHealthy())) return undefined;
  try {
    const response = await fetch(`${speechServerUrl()}/xlit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ words, source: language, target: "en" }),
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { words?: (string | null)[] };
    return body.words?.map((word) => word ?? undefined);
  } catch {
    return undefined;
  }
}
