import { useEffect, useState, type ReactNode } from "react";
import { api, host, playVoicePreview, type Connector, type Settings, type SpeechModelInfo } from "../api";

const tabs = ["general", "voice", "shortcuts", "dictation", "cursor", "agents", "integrations", "models", "memory"] as const;
type Tab = (typeof tabs)[number];

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return <button role="switch" aria-checked={checked} className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}

export function SettingsView({ tab, onTab }: { tab: string; onTab: (tab: string) => void }) {
  const activeTab = (tabs.includes(tab as Tab) ? tab : "general") as Tab;
  const [settings, setSettings] = useState<Settings>();
  const [message, setMessage] = useState("");

  useEffect(() => {
    void api.settings().then(setSettings);
  }, []);

  const save = async (patch: unknown) => {
    const updated = await api.saveSettings(patch);
    setSettings(updated);
    host.send({ type: "settings-changed" });
    setMessage("saved");
    window.setTimeout(() => setMessage(""), 1200);
  };

  if (!settings) return <div className="settings loading">loading…</div>;

  return (
    <div className="settings">
      <nav className="settings-tabs">
        {tabs.map((name) => (
          <button key={name} className={name === activeTab ? "active" : ""} onClick={() => onTab(name)}>{name}</button>
        ))}
      </nav>
      <div className="settings-panel">
        <h1>{activeTab}</h1>
        {message && <div className="saved-note">{message}</div>}
        {activeTab === "general" && <GeneralTab settings={settings} save={save} />}
        {activeTab === "voice" && <VoiceTab settings={settings} save={save} />}
        {activeTab === "shortcuts" && <ShortcutsTab settings={settings} save={save} />}
        {activeTab === "dictation" && <DictationTab settings={settings} save={save} />}
        {activeTab === "cursor" && <CursorTab settings={settings} save={save} />}
        {activeTab === "agents" && <AgentsTab settings={settings} save={save} />}
        {activeTab === "integrations" && <IntegrationsTab />}
        {activeTab === "models" && <ModelsTab settings={settings} save={save} />}
        {activeTab === "memory" && <MemoryTab />}
      </div>
    </div>
  );
}

type TabProps = { settings: Settings; save: (patch: unknown) => Promise<void> };

function GeneralTab({ settings, save }: TabProps) {
  return (
    <>
      <Row label="replay the tour" hint="the two-minute hands-on tutorial">
        <button className="ghost-button" onClick={() => { host.send({ type: "start-onboarding" }); void save({ onboarding: { completed: false } }); }}>start</button>
      </Row>
      <Row label="language" hint="what you usually speak; auto lets the speech model detect it">
        <select value={settings.voice.language} onChange={(event) => void save({ voice: { language: event.target.value } })}>
          {["auto", "en", "es", "fr", "de", "it", "pt", "nl", "pl"].map((language) => <option key={language}>{language}</option>)}
        </select>
      </Row>
      <p className="setting-hint">pip runs entirely on this pc: ollama for thinking and seeing, parakeet for listening, kokoro for talking. nothing you say or show leaves your machine, except web pages agents open.</p>
    </>
  );
}

function VoiceTab({ settings, save }: TabProps) {
  const [voices, setVoices] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState("");
  useEffect(() => {
    void api.speechModels().then((result) => setVoices(result.voices));
  }, []);
  const englishVoices = voices.filter((voice) => /^[ab][fm]_/.test(voice));
  const otherVoices = voices.filter((voice) => !/^[ab][fm]_/.test(voice));
  const preview = (voice: string) => {
    setPreviewError("");
    void playVoicePreview("hey, i'm pip. hold the keys and ask me anything.", voice, settings.voice.speed).catch((error) => setPreviewError((error as Error).message));
  };
  return (
    <>
      <Row label="voice" hint="kokoro voices: af/am american, bf/bm british">
        <select value={settings.voice.voiceName} onChange={(event) => void save({ voice: { voiceName: event.target.value } })}>
          <optgroup label="english">{englishVoices.map((voice) => <option key={voice}>{voice}</option>)}</optgroup>
          <optgroup label="other languages">{otherVoices.map((voice) => <option key={voice}>{voice}</option>)}</optgroup>
        </select>
        <button className="ghost-button small" onClick={() => preview(settings.voice.voiceName)}>▶ preview</button>
      </Row>
      <Row label="speed" hint={`${settings.voice.speed.toFixed(2)}x`}>
        <input type="range" min={0.5} max={1.5} step={0.05} value={settings.voice.speed} onChange={(event) => void save({ voice: { speed: Number(event.target.value) } })} />
      </Row>
      {previewError && <div className="error-line">{previewError}</div>}
    </>
  );
}

function ShortcutsTab({ settings, save }: TabProps) {
  const field = (key: keyof Settings["shortcuts"], label: string, hint: string) => (
    <Row label={label} hint={hint}>
      <input value={settings.shortcuts[key]} onChange={(event) => void save({ shortcuts: { [key]: event.target.value } })} />
    </Row>
  );
  return (
    <>
      {field("talk", "talk to pip", "hold to talk; pip sees your screen. e.g. Ctrl+Win (hold)")}
      {field("dictate", "dictate", "hold to type with your voice into any app. e.g. RightCtrl (hold)")}
      {field("textMode", "text box", "type instead of talking. e.g. Ctrl (double-tap)")}
      <p className="setting-hint">format: keys joined by +, then (hold) or (double-tap). keys: Ctrl, LeftCtrl, RightCtrl, Alt, Shift, Win, or a letter. avoid Ctrl+Alt, which is AltGr on many keyboards.</p>
    </>
  );
}

function DictationTab({ settings, save }: TabProps) {
  const [word, setWord] = useState("");
  return (
    <>
      <Row label="clean up dictation" hint="removes ums, fixes punctuation; never adds words">
        <Toggle checked={settings.dictation.cleanup} onChange={(value) => void save({ dictation: { cleanup: value } })} />
      </Row>
      <Row label="personal dictionary" hint="names and words pip should always spell your way. it also learns from your fixes.">
        <div className="chip-input">
          <input placeholder="add a word" value={word} onChange={(event) => setWord(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && word.trim()) {
              void api.dictionary({ add: [word.trim()] }).then(() => api.settings()).then(() => save({}));
              setWord("");
            }
          }} />
        </div>
      </Row>
      <div className="chips">
        {settings.dictation.dictionary.map((entry) => (
          <span key={entry} className="chip">{entry}<button onClick={() => void api.dictionary({ remove: [entry] }).then(() => save({}))}>×</button></span>
        ))}
      </div>
    </>
  );
}

function CursorTab({ settings, save }: TabProps) {
  return (
    <>
      <Row label="show pip" hint="the little buddy next to your cursor">
        <Toggle checked={settings.cursor.showBuddy} onChange={(value) => void save({ cursor: { showBuddy: value } })} />
      </Row>
      <Row label="follow my cursor" hint="off docks pip where it is">
        <Toggle checked={settings.cursor.followCursor} onChange={(value) => void save({ cursor: { followCursor: value } })} />
      </Row>
      <Row label="colour">
        <input type="color" value={settings.cursor.color} onChange={(event) => void save({ cursor: { color: event.target.value } })} />
      </Row>
    </>
  );
}

function AgentsTab({ settings, save }: TabProps) {
  return (
    <>
      <Row label="announce when done" hint="pip says it out loud, and stays quiet during calls">
        <Toggle checked={settings.agents.announceWhenDone} onChange={(value) => void save({ agents: { announceWhenDone: value } })} />
      </Row>
      <Row label="always approve" hint="skip permission prompts except deletes, sends and payments">
        <Toggle checked={settings.agents.alwaysApprove} onChange={(value) => void save({ agents: { alwaysApprove: value } })} />
      </Row>
      <Row label="engine" hint="codex (open source) when installed; pip's own loop otherwise">
        <select value={settings.agents.engine} onChange={(event) => void save({ agents: { engine: event.target.value } })}>
          <option value="auto">auto</option>
          <option value="codex">codex</option>
          <option value="builtin">built-in</option>
        </select>
      </Row>
      <Row label="cancel window" hint={`${settings.agents.cancelWindowSeconds} seconds before an agent starts`}>
        <input type="range" min={0} max={10} value={settings.agents.cancelWindowSeconds} onChange={(event) => void save({ agents: { cancelWindowSeconds: Number(event.target.value) } })} />
      </Row>
    </>
  );
}

function IntegrationsTab() {
  const [integrations, setIntegrations] = useState<Connector[]>([]);
  const [builtIn, setBuiltIn] = useState<Connector[]>([]);
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ name: "", kind: "stdio" as "stdio" | "http", command: "", url: "" });
  const reload = () => void api.integrations().then((result) => { setIntegrations(result.integrations); setBuiltIn(result.builtIn); });
  useEffect(reload, []);
  const check = (connectorId: string) => {
    setChecks((current) => ({ ...current, [connectorId]: "checking…" }));
    void api.checkIntegration(connectorId).then((result) => setChecks((current) => ({ ...current, [connectorId]: result.ok ? `✓ ${result.toolCount} tools` : `✗ ${result.error}` })));
  };
  const add = async () => {
    const [command, ...args] = form.command.trim().split(/\s+/);
    await api.saveIntegration(form.kind === "stdio" ? { name: form.name, kind: "stdio", command, args, enabled: true } : { name: form.name, kind: "http", url: form.url, enabled: true });
    setForm({ name: "", kind: "stdio", command: "", url: "" });
    reload();
  };
  return (
    <>
      <p className="setting-hint">agents reach your apps through MCP servers. use open-source servers that run on this pc (a local command) or any MCP url. pip's own desktop control is always on.</p>
      {[...builtIn, ...integrations].map((connector) => (
        <Row key={connector.id} label={connector.name} hint={connector.kind === "stdio" ? `${connector.command?.split(/[\\/]/).pop()} ${(connector.args ?? []).slice(-1).join(" ")}` : connector.url}>
          <span className="check-result">{checks[connector.id]}</span>
          <button className="ghost-button small" onClick={() => check(connector.id)}>check</button>
          {!connector.builtIn && <button className="link-button danger" onClick={() => void api.deleteIntegration(connector.id).then(reload)}>remove</button>}
        </Row>
      ))}
      <div className="add-integration">
        <input placeholder="name, e.g. filesystem" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as "stdio" | "http" })}>
          <option value="stdio">local command</option>
          <option value="http">url</option>
        </select>
        {form.kind === "stdio" ? (
          <input placeholder="npx -y @modelcontextprotocol/server-filesystem C:\Users\me\Documents" value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} />
        ) : (
          <input placeholder="http://127.0.0.1:3000/mcp" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} />
        )}
        <button className="gel-button small" disabled={!form.name || (form.kind === "stdio" ? !form.command : !form.url)} onClick={() => void add()}>add</button>
      </div>
    </>
  );
}

function ModelsTab({ settings, save }: TabProps) {
  const [installed, setInstalled] = useState<string[]>([]);
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [speechModels, setSpeechModels] = useState<SpeechModelInfo[]>([]);
  useEffect(() => {
    void api.modelPolicy().then((policy) => {
      setInstalled(policy.installed);
      setAvailability(Object.fromEntries(Object.entries(policy.jobs).map(([job, info]) => [job, info.available])));
    });
    void api.speechModels().then((result) => setSpeechModels(result.models));
  }, [settings]);
  const jobHints: Record<string, string> = {
    router: "decides quick vs deep on every turn",
    talk: "quick spoken answers",
    deep: "hard questions and walkthrough plans",
    vision: "looks at your screen",
    grounding: "finds things by pixels in apps with no ui tree (optional)",
    jev: "picks the next click for agents",
    cleanup: "dictation cleanup",
    memory: "keeps PROFILE.md and VOLATILE.md",
    agent: "background agents",
  };
  return (
    <>
      <p className="setting-hint">every model runs locally in ollama. pip-* names are created by scripts/setup-models with the right context size and keep-alive.</p>
      {Object.entries(settings.models).map(([job, model]) => (
        <Row key={job} label={`${job} ${availability[job] === false ? "(missing)" : ""}`} hint={jobHints[job]}>
          <input list="installed-models" value={model} onChange={(event) => void save({ models: { [job]: event.target.value } })} />
        </Row>
      ))}
      <datalist id="installed-models">{installed.map((name) => <option key={name} value={name} />)}</datalist>
      <h2>speech</h2>
      {speechModels.map((model) => (
        <Row key={model.id} label={`${model.id} ${model.installed ? "✓" : ""}`} hint={`${model.description} · ${model.license} · ~${model.approximateMegabytes} MB`}>
          {model.kind === "asr" ? (
            <button className={settings.speech.asrModel === model.id ? "gel-button small" : "ghost-button small"} disabled={!model.installed} onClick={() => void save({ speech: { asrModel: model.id } })}>{settings.speech.asrModel === model.id ? "listening with this" : "use"}</button>
          ) : (
            <button className={settings.speech.ttsModel === model.id ? "gel-button small" : "ghost-button small"} disabled={!model.installed} onClick={() => void save({ speech: { ttsModel: model.id } })}>{settings.speech.ttsModel === model.id ? "talking with this" : "use"}</button>
          )}
        </Row>
      ))}
      <p className="setting-hint">download more with: npm run setup:speech --prefix backend -- parakeet-tdt-0.6b-v2 piper-amy</p>
    </>
  );
}

function MemoryTab() {
  const [profile, setProfile] = useState("");
  const [volatile, setVolatile] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void api.memory().then((memory) => { setProfile(memory.profile); setVolatile(memory.volatile); });
  }, []);
  const save = async () => {
    await api.saveMemory({ profile, volatile });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  };
  return (
    <>
      <p className="setting-hint">what pip remembers about you. it reads both files on every turn and every agent run.</p>
      <label className="memory-file">PROFILE.md <span>stable habits and preferences</span><textarea value={profile} onChange={(event) => setProfile(event.target.value)} rows={10} /></label>
      <label className="memory-file">VOLATILE.md <span>what you're working on right now</span><textarea value={volatile} onChange={(event) => setVolatile(event.target.value)} rows={7} /></label>
      <button className="gel-button" onClick={() => void save()}>{saved ? "saved" : "save"}</button>
    </>
  );
}
