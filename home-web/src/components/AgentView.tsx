import { useCallback, useEffect, useRef, useState } from "react";
import { api, fileUrl, host, type Agent, type AgentMessage, type OutputFile, type Routine, type Run } from "../api";
import type { PipEvent } from "../events";
import { Markdown } from "./Markdown";

const cadences = [
  { label: "every hour", minutes: 60 },
  { label: "every morning", minutes: 24 * 60 },
  { label: "every week", minutes: 7 * 24 * 60 },
  { label: "every 15 min", minutes: 15 },
];

function formatCadence(minutes: number): string {
  if (minutes % (7 * 24 * 60) === 0) return minutes === 7 * 24 * 60 ? "weekly" : `every ${minutes / (7 * 24 * 60)} weeks`;
  if (minutes % (24 * 60) === 0) return minutes === 24 * 60 ? "daily" : `every ${minutes / (24 * 60)} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "hourly" : `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function AgentView({ agentId, lastEvent }: { agentId: string; lastEvent?: PipEvent }) {
  const [agent, setAgent] = useState<Agent>();
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [files, setFiles] = useState<OutputFile[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [hasOlder, setHasOlder] = useState(true);
  const [newRoutine, setNewRoutine] = useState<{ prompt: string; minutes: number } | undefined>();
  const [talking, setTalking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    const [details, page] = await Promise.all([api.agent(agentId), api.messages(agentId)]);
    setAgent(details.agent);
    setRuns(details.runs);
    setFiles(details.files);
    setRoutines(details.routines);
    setMessages(page.messages);
    setHasOlder(page.messages.length >= 60);
    if (details.agent.unread > 0) void api.updateAgent(agentId, { unread: 0 });
  }, [agentId]);

  useEffect(() => {
    setMessages([]);
    void reload().catch((reason) => setError(String(reason)));
  }, [reload]);

  useEffect(() => {
    if (!lastEvent) return;
    const eventAgentId = lastEvent.data.agent?.id ?? lastEvent.data.run?.agentId ?? lastEvent.data.agentId;
    if (eventAgentId === agentId || lastEvent.type === "routine.changed") void reload();
  }, [lastEvent, agentId, reload]);

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [messages.length]);

  const loadOlder = async () => {
    const page = await api.messages(agentId, messages[0]?.id);
    setMessages((current) => [...page.messages, ...current]);
    setHasOlder(page.messages.length >= 60);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setError("");
    try {
      await api.send(agentId, text);
      await reload();
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const activeRun = runs.find((run) => ["pending", "running", "needs_you"].includes(run.status));
  const lastFailed = runs[0]?.status === "failed" ? runs[0] : undefined;

  if (!agent) return <div className="agent-view loading">{error || "loading…"}</div>;

  return (
    <div className="agent-view">
      <header className="agent-header">
        <span className="agent-face large" aria-hidden>{agent.face}</span>
        <div className="agent-title">
          <h1>{agent.name}</h1>
          <p>{agent.role || "one of your agents"}</p>
        </div>
        <div className="header-actions">
          <button className="ghost-button" onClick={() => void api.updateAgent(agent.id, { pinned: !agent.pinned }).then(reload)}>{agent.pinned ? "unpin" : "pin"}</button>
          <button className="ghost-button" onClick={() => void api.updateAgent(agent.id, { archived: !agent.archived }).then(reload)}>{agent.archived ? "unarchive" : "archive"}</button>
        </div>
      </header>

      <div className="agent-body">
        <section className="conversation">
          {hasOlder && messages.length > 0 && (
            <button className="link-button center" onClick={() => void loadOlder()}>load older</button>
          )}
          {messages.length === 0 && <p className="empty-note">say what you want {agent.name} to do. it works in the background and tells you when it's done.</p>}
          {messages.map((message) =>
            message.role === "step" ? (
              <div key={message.id} className="step-line"><span className="step-dot" />{message.text}</div>
            ) : message.role === "system" ? (
              <div key={message.id} className="system-line">{message.text}</div>
            ) : (
              <div key={message.id} className={`bubble ${message.role === "user" ? "from-user" : "from-agent"}`}>
                {message.role === "agent" ? <Markdown text={message.text} /> : <p>{message.text}</p>}
                {message.files && message.files.length > 0 && <div className="bubble-files">{message.files.length} file{message.files.length > 1 ? "s" : ""} in the pile →</div>}
                <div className="bubble-meta">
                  {timeAgo(message.at)}
                  {message.role === "agent" && (
                    <button className="copy-button" onClick={() => void navigator.clipboard.writeText(message.text)}>copy</button>
                  )}
                </div>
              </div>
            ),
          )}

          {activeRun && (
            <div className={`run-card ${activeRun.status}`}>
              <div className="run-card-head">
                <span className="spinner" aria-hidden />
                <strong>{activeRun.status === "pending" ? "starting in a few seconds" : activeRun.status === "needs_you" ? "needs you" : "working"}</strong>
                <button className="ghost-button small" onClick={() => void api.cancelRun(activeRun.id).then(reload)}>cancel</button>
              </div>
              {activeRun.steps.slice(-4).map((step, index) => (
                <div key={index} className="step-line"><span className="step-dot" />{step.text}</div>
              ))}
              {activeRun.permission && (
                <div className={`permission ${activeRun.permission.risk}`}>
                  <p>
                    <strong>{agent.name} wants to:</strong> {activeRun.permission.summary}
                  </p>
                  <div className="permission-buttons">
                    <button className="gel-button" onClick={() => void api.answerPermission(activeRun.id, "once").then(reload)}>allow once</button>
                    <button className="ghost-button" onClick={() => void api.answerPermission(activeRun.id, "always").then(reload)}>always allow</button>
                    <button className="ghost-button" onClick={() => void api.answerPermission(activeRun.id, "deny").then(reload)}>not now</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {lastFailed && !activeRun && (
            <div className="run-card failed">
              <strong>got stuck:</strong> {lastFailed.error}
              <button className="ghost-button small" onClick={() => void api.retryRun(lastFailed.id).then(reload)}>retry</button>
            </div>
          )}
          <div ref={bottomRef} />
        </section>

        <aside className="agent-side">
          <h2>files</h2>
          {files.length === 0 ? (
            <p className="empty-note small">nothing yet</p>
          ) : (
            <div className="file-pile">
              {files.slice(0, 12).map((file) => (
                <a key={file.name} className="file-chip" href={fileUrl(agent.id, file.name)} target="_blank" rel="noreferrer" title={file.path}>
                  <span className="file-ext">{file.name.split(".").pop()}</span>
                  <span className="file-name">{file.name}</span>
                </a>
              ))}
            </div>
          )}

          <h2>routines</h2>
          {routines.map((routine) => (
            <div key={routine.id} className={`routine ${routine.paused ? "paused" : ""}`}>
              <p>{routine.prompt}</p>
              <div className="routine-meta">
                {formatCadence(routine.everyMinutes)} · {routine.paused ? "paused" : `next ${new Date(routine.nextRunAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
              </div>
              <div className="routine-actions">
                <button className="link-button" onClick={() => void api.runRoutineNow(routine.id).then(reload)}>run now</button>
                <button className="link-button" onClick={() => void api.updateRoutine(routine.id, { paused: !routine.paused }).then(reload)}>{routine.paused ? "resume" : "pause"}</button>
                <button className="link-button danger" onClick={() => void api.deleteRoutine(routine.id).then(reload)}>delete</button>
              </div>
            </div>
          ))}
          {newRoutine ? (
            <div className="routine-form">
              <textarea placeholder="what should it do each time?" value={newRoutine.prompt} onChange={(event) => setNewRoutine({ ...newRoutine, prompt: event.target.value })} />
              <select value={newRoutine.minutes} onChange={(event) => setNewRoutine({ ...newRoutine, minutes: Number(event.target.value) })}>
                {cadences.map((cadence) => <option key={cadence.minutes} value={cadence.minutes}>{cadence.label}</option>)}
              </select>
              <div className="routine-actions">
                <button className="gel-button small" disabled={!newRoutine.prompt.trim()} onClick={() => void api.createRoutine(agent.id, newRoutine.prompt, newRoutine.minutes).then(() => { setNewRoutine(undefined); return reload(); })}>add</button>
                <button className="link-button" onClick={() => setNewRoutine(undefined)}>cancel</button>
              </div>
            </div>
          ) : (
            <button className="ghost-button small" onClick={() => setNewRoutine({ prompt: "", minutes: 24 * 60 })}>+ routine</button>
          )}
        </aside>
      </div>

      <footer className="composer">
        {error && <div className="error-line">{error}</div>}
        {host.available() && (
          <button
            className={`talk-pill ${talking ? "talking" : ""}`}
            onPointerDown={() => { setTalking(true); host.send({ type: "talk-start", agentId: agent.id }); }}
            onPointerUp={() => { setTalking(false); host.send({ type: "talk-stop", agentId: agent.id }); }}
            onPointerLeave={() => { if (talking) { setTalking(false); host.send({ type: "talk-stop", agentId: agent.id }); } }}
          >
            {talking ? "listening…" : "hold to talk"}
          </button>
        )}
        <textarea
          rows={1}
          placeholder={`message ${agent.name.toLowerCase()}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button className="gel-button" onClick={() => void send()} disabled={!draft.trim()}>send</button>
      </footer>
    </div>
  );
}
