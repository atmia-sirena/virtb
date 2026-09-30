import { useCallback, useEffect, useState } from "react";
import { api, host, type Agent } from "./api";
import { AgentView } from "./components/AgentView";
import { HomeView, NewAgentDialog } from "./components/HomeView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { usePipEvents, type PipEvent } from "./events";

function initialView(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash || "home";
}

export function App() {
  const [view, setView] = useState(initialView);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [activity, setActivity] = useState<PipEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<PipEvent>();
  const [creating, setCreating] = useState(false);

  const reloadAgents = useCallback(() => void api.agents(showArchived).then((result) => setAgents(result.agents)).catch(() => undefined), [showArchived]);
  useEffect(reloadAgents, [reloadAgents]);

  const navigate = useCallback((next: string) => {
    setView(next);
    window.location.hash = next;
  }, []);

  useEffect(() => {
    const onHashChange = () => setView(initialView());
    window.addEventListener("hashchange", onHashChange);
    // The client can open Home on a given agent or settings page.
    host.onMessage((message) => {
      if (message.type === "navigate" && typeof message.view === "string") navigate(message.view);
    });
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [navigate]);

  usePipEvents((event) => {
    setLastEvent(event);
    if (event.type.startsWith("agent.") || event.type.startsWith("run.")) reloadAgents();
    if (["run.done", "run.failed", "run.permission", "run.started", "notification"].includes(event.type)) setActivity((current) => [event, ...current].slice(0, 50));
  });

  const agentId = view.startsWith("agent:") ? view.slice("agent:".length) : undefined;

  return (
    <div className="app">
      <Sidebar agents={agents} selected={view} onSelect={navigate} onNewAgent={() => setCreating(true)} showArchived={showArchived} onToggleArchived={() => setShowArchived((value) => !value)} />
      <main className="main">
        {view === "home" && <HomeView agents={agents} activity={activity} onOpenAgent={(id) => navigate(`agent:${id}`)} />}
        {agentId && <AgentView key={agentId} agentId={agentId} lastEvent={lastEvent} />}
        {view.startsWith("settings") && <SettingsView tab={view.split(":")[1] ?? "general"} onTab={(tab) => navigate(`settings:${tab}`)} />}
      </main>
      {creating && (
        <NewAgentDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            reloadAgents();
            navigate(`agent:${id}`);
          }}
        />
      )}
    </div>
  );
}
