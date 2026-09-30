import { useEffect, useState } from "react";
import { api, type Agent } from "../api";
import type { PipEvent } from "../events";

interface HomeViewProps {
  agents: Agent[];
  activity: PipEvent[];
  onOpenAgent: (agentId: string) => void;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "up late? (・_・;)";
  if (hour < 12) return "morning (^_^)/";
  if (hour < 18) return "hey there (•‿•)";
  return "evening ( ˘ω˘ )";
}

function describeEvent(event: PipEvent): string {
  const name = event.data.agent?.name ?? "an agent";
  switch (event.type) {
    case "run.done":
      return `${name} finished: ${event.data.run?.summary ?? "done"}`;
    case "run.failed":
      return `${name} got stuck: ${event.data.run?.error ?? ""}`;
    case "run.permission":
      return `${name} needs you: ${event.data.permission?.summary ?? ""}`;
    case "run.started":
      return `${name} started: ${event.data.run?.prompt ?? ""}`;
    case "notification":
      return String(event.data.text ?? "");
    default:
      return event.type;
  }
}

export function HomeView({ agents, activity, onOpenAgent }: HomeViewProps) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [setupIssues, setSetupIssues] = useState<string[]>([]);

  useEffect(() => {
    void Promise.all([api.appConfig(), api.modelPolicy()])
      .then(([config, policy]) => {
        const issues: string[] = [];
        if (!config.speech.asr.installed) issues.push(`speech-to-text model ${config.speech.asr.model} isn't downloaded (npm run setup:speech --prefix backend)`);
        if (!config.speech.tts.installed) issues.push(`voice model ${config.speech.tts.model} isn't downloaded (npm run setup:speech --prefix backend)`);
        if (policy.installed.length === 0) issues.push("ollama isn't running or has no models (start it with: ollama serve)");
        else {
          const missing = Object.entries(policy.jobs).filter(([job, info]) => !info.available && job !== "grounding").map(([job, info]) => `${job} (${info.model})`);
          if (missing.length > 0) issues.push(`missing in ollama: ${missing.join(", ")}. run scripts/setup-models.ps1`);
        }
        if (!config.agents.codexInstalled) issues.push("codex cli isn't installed, so agents use pip's built-in loop (npm i -g @openai/codex)");
        setSetupIssues(issues);
      })
      .catch(() => setSetupIssues(["the pip backend isn't reachable"]));
  }, []);

  const launch = async () => {
    if (!task.trim()) return;
    setBusy(true);
    setError("");
    try {
      const { agent } = await api.launch(task.trim());
      setTask("");
      onOpenAgent(agent.id);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const working = agents.filter((agent) => ["pending", "running", "needs_you"].includes(agent.status));

  return (
    <div className="home-view">
      <section className="hero">
        <h1>{greeting()}</h1>
        <p>hold <kbd>ctrl</kbd> + <kbd>win</kbd> and talk, or give an agent something to do.</p>
        <div className="launch">
          <textarea
            rows={2}
            placeholder="research the best standing desks under $500 and make me a short table"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void launch();
              }
            }}
          />
          <button className="gel-button" disabled={busy || !task.trim()} onClick={() => void launch()}>{busy ? "starting…" : "start"}</button>
        </div>
        {error && <div className="error-line">{error}</div>}
      </section>

      {setupIssues.length > 0 && (
        <section className="card warn">
          <h2>almost set up</h2>
          <ul>{setupIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
        </section>
      )}

      {working.length > 0 && (
        <section>
          <h2>working now</h2>
          <div className="agent-cards">
            {working.map((agent) => (
              <button key={agent.id} className={`agent-card ${agent.status}`} onClick={() => onOpenAgent(agent.id)}>
                <span className="agent-face">{agent.face}</span>
                <strong>{agent.name}</strong>
                <span>{agent.status === "needs_you" ? "needs you" : agent.lastMessage}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>recent</h2>
        {activity.length === 0 ? (
          <p className="empty-note">nothing yet today.</p>
        ) : (
          <ul className="activity">
            {activity.slice(0, 12).map((event, index) => (
              <li key={index}>
                <button className="link-button left" onClick={() => event.data.agent?.id && onOpenAgent(event.data.agent.id)}>{describeEvent(event)}</button>
                <span className="activity-time">{new Date(event.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function NewAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (agentId: string) => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h2>new agent</h2>
        <label>
          name
          <input autoFocus placeholder="launch scout" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          its job
          <textarea placeholder="keeps an eye on competitors and tells me what they ship" value={role} onChange={(event) => setRole(event.target.value)} />
        </label>
        <div className="dialog-actions">
          <button className="link-button" onClick={onClose}>cancel</button>
          <button className="gel-button" disabled={!name.trim()} onClick={() => void api.createAgent(name.trim(), role.trim()).then(({ agent }) => onCreated(agent.id))}>create</button>
        </div>
      </div>
    </div>
  );
}
