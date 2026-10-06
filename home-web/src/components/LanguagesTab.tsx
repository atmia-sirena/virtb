// Settings → Languages: which languages Pip listens for, how each is written,
// which speech engine runs, and a recorder for your own test clips (eval/run.py
// --set personal scores every model on them; training/recipes/personal_adapt.py
// learns your voice from them). Audio stays on this PC.
import { useEffect, useRef, useState } from "react";
import { api, type Settings, type SpeechLanguages } from "../api";

type Props = { settings: Settings; save: (patch: unknown) => Promise<void> };

export function LanguagesTab({ settings, save }: Props) {
  const [info, setInfo] = useState<SpeechLanguages>();
  const [error, setError] = useState("");

  const refresh = () => api.speechLanguages().then(setInfo).catch((reason: Error) => setError(reason.message));
  useEffect(() => {
    void refresh();
  }, []);

  if (!info) return <div className="setting-hint">{error || "loading…"}</div>;

  const selected = new Set(info.selected);
  const update = async (change: Parameters<typeof api.saveSpeechLanguages>[0]) => {
    await api.saveSpeechLanguages(change);
    await save({});
    await refresh();
  };
  const toggle = (code: string) => {
    const next = selected.has(code) ? info.selected.filter((item) => item !== code) : [...info.selected, code];
    if (next.length > 0) void update({ languages: next });
  };
  const engines = Object.entries(info.server.engines ?? {});
  const usable = engines.filter(([, engine]) => engine.usable);

  return (
    <>
      <p className="setting-hint languages-intro">
        Pip detects which of these you're speaking, per utterance, and remembers each app's usual language. Double-tap Right Shift while dictating to switch if it guessed wrong.
      </p>
      <div className="language-grid">
        {info.available.map((language) => (
          <button key={language.code} className={`language-card ${selected.has(language.code) ? "on" : ""}`} onClick={() => toggle(language.code)} aria-pressed={selected.has(language.code)}>
            <span className="language-native">{language.native}</span>
            <span className="language-name">{language.name}</span>
            {!language.cleanup && <span className="language-note">basic cleanup</span>}
          </button>
        ))}
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-label">main language</div>
          <div className="setting-hint">used when there's too little speech to tell</div>
        </div>
        <div className="setting-control">
          <select value={info.primary} onChange={(event) => void update({ primaryLanguage: event.target.value })}>
            {info.available.filter((language) => selected.has(language.code)).map((language) => (
              <option key={language.code} value={language.code}>{language.name}</option>
            ))}
          </select>
        </div>
      </div>

      {info.available.filter((language) => selected.has(language.code) && language.scripts.length > 1).map((language) => (
        <div className="setting-row" key={language.code}>
          <div>
            <div className="setting-label">{language.name} is typed in</div>
            <div className="setting-hint">{language.code === "hinglish" ? "\"kal meeting 5 baje hai\" or \"कल meeting 5 बजे है\"" : "native script or Latin letters"}</div>
          </div>
          <div className="setting-control segmented">
            {(["roman", "native"] as const).map((script) => (
              <button key={script} className={(info.script[language.code] ?? language.scripts[0]) === script ? "active" : ""} onClick={() => void update({ script: { ...info.script, [language.code]: script } })}>
                {script === "roman" ? "Latin" : "native"}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="setting-row">
        <div>
          <div className="setting-label">speech engine</div>
          <div className="setting-hint">
            {info.server.running
              ? `GPU speech server running on ${info.server.device ?? "?"} · ${usable.length} of ${engines.length} models ready · ${info.server.vad ?? ""} VAD`
              : "GPU speech server not running: Indian languages need it (see speech-server/README.md). English works on the CPU."}
          </div>
        </div>
        <div className="setting-control">
          <select value={info.asrEngine} onChange={(event) => void update({ asrEngine: event.target.value })}>
            <option value="auto">automatic</option>
            <option value="sidecar">GPU speech server</option>
            <option value="local">CPU (Parakeet, English and European)</option>
          </select>
        </div>
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-label">smart cleanup</div>
          <div className="setting-hint">a local model resolves "actually…", "matlab…" and adds punctuation. it can only delete, punctuate and fix case, never add words.</div>
        </div>
        <div className="setting-control">
          <select value={settings.dictation.llmPass} onChange={(event) => void save({ dictation: { llmPass: event.target.value } })}>
            <option value="auto">when needed</option>
            <option value="always">always</option>
            <option value="off">off (rules only)</option>
          </select>
        </div>
      </div>

      {Object.keys(info.perApp).length > 0 && (
        <div className="setting-row">
          <div>
            <div className="setting-label">learned per app</div>
            <div className="setting-hint">{Object.entries(info.perApp).map(([app, code]) => `${app}: ${info.available.find((language) => language.code === code || language.code.split("-")[0] === code)?.name ?? code}`).join(" · ")}</div>
          </div>
          <div className="setting-control">
            <button className="link-button" onClick={() => void update({ forgetPerApp: true })}>forget</button>
          </div>
        </div>
      )}

      <Recorder languages={info.available.filter((language) => selected.has(language.code))} />
    </>
  );
}

// --- personal test set recorder -----------------------------------------------------

function encodeWav(samples: Float32Array, sampleRate: number): string {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true));
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

const prompts: Record<string, string[]> = {
  "en-IN": ["Hey, can you send me the deck by 4 pm? Actually, make it 5.", "My email is your name at gmail dot com, new line, thanks!"],
  hinglish: ["Bhai kal ki meeting 11 baje hai, nahi nahi, 12 baje hai.", "Rent 15000 rupaye hai, pichhla hata do, rent 16000 hai."],
  hi: ["मैं कल ऑफिस नहीं आ पाऊंगा, पूर्ण विराम", "क्या आप शाम को फ्री हैं?"],
  ta: ["நாளைக்கு மீட்டிங் பத்து மணிக்கு, இல்ல இல்ல, பதினொரு மணிக்கு", "நான் வீட்டுக்கு வந்துட்டேன், புதிய வரி, சாப்பிட்டியா?"],
  te: ["రేపు మీటింగ్ పది గంటలకు, కాదు కాదు, పదకొండు గంటలకు", "నేను ఇంటికి వచ్చేశాను, కొత్త లైన్, భోజనం చేశావా?"],
  pa: ["ਕੱਲ੍ਹ ਮੀਟਿੰਗ ਦਸ ਵਜੇ ਹੈ, ਨਹੀਂ ਨਹੀਂ, ਗਿਆਰਾਂ ਵਜੇ", "ਮੈਂ ਘਰ ਪਹੁੰਚ ਗਿਆ ਹਾਂ, ਨਵੀਂ ਲਾਈਨ, ਖਾਣਾ ਖਾ ਲਿਆ?"],
};

function Recorder({ languages }: { languages: { code: string; name: string }[] }) {
  const [language, setLanguage] = useState(languages[0]?.code ?? "en-IN");
  const [reference, setReference] = useState("");
  const [recording, setRecording] = useState(false);
  const [clip, setClip] = useState<{ samples: Float32Array; seconds: number }>();
  const [status, setStatus] = useState("");
  const stopRef = useRef<(() => void) | undefined>(undefined);

  const start = async () => {
    setStatus("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      const context = new AudioContext({ sampleRate: 16000 });
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      source.connect(processor);
      processor.connect(context.destination);
      setRecording(true);
      stopRef.current = () => {
        processor.disconnect();
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
        const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
        const samples = new Float32Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          samples.set(chunk, offset);
          offset += chunk.length;
        }
        setClip({ samples, seconds: length / 16000 });
        setRecording(false);
      };
    } catch (reason) {
      setStatus(`can't use the microphone: ${(reason as Error).message}`);
    }
  };

  const saveClip = async () => {
    if (!clip || !reference.trim()) return;
    const result = await api.saveClip({ audio: encodeWav(clip.samples, 16000), reference: reference.trim(), language });
    setStatus(`saved · ${result.count} clips in your test set`);
    setClip(undefined);
    setReference("");
  };

  const suggestion = prompts[language]?.[Math.floor(Date.now() / 60000) % 2];

  return (
    <div className="recorder">
      <div className="setting-label">record your own test set</div>
      <div className="setting-hint">
        Say something you'd really dictate, then type exactly what you wanted typed. 50+ clips per language make the benchmarks about your voice; 100+ let Pip fine-tune on it.
      </div>
      <div className="recorder-row">
        <select value={language} onChange={(event) => setLanguage(event.target.value)}>
          {languages.map((item) => (
            <option key={item.code} value={item.code}>{item.name}</option>
          ))}
        </select>
        {recording ? (
          <button className="record-button recording" onClick={() => stopRef.current?.()}>stop</button>
        ) : (
          <button className="record-button" onClick={() => void start()}>{clip ? "record again" : "record"}</button>
        )}
        {clip && <span className="setting-hint">{clip.seconds.toFixed(1)} s</span>}
      </div>
      {suggestion && !clip && !recording && <div className="setting-hint">try: “{suggestion}”</div>}
      {clip && (
        <div className="recorder-row">
          <input className="recorder-text" placeholder="what you wanted typed" value={reference} onChange={(event) => setReference(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void saveClip()} />
          <button className="record-button" disabled={!reference.trim()} onClick={() => void saveClip()}>save</button>
        </div>
      )}
      {status && <div className="setting-hint">{status}</div>}
    </div>
  );
}
