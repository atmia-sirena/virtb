import { useMemo, useState } from "react";
import type { Agent } from "../api";

const statusLabel: Record<Agent["status"], string> = {
  idle: "",
  pending: "starting",
  running: "working",
  needs_you: "needs you",
  done: "done",
  failed: "stuck",
};

interface SidebarProps {
  agents: Agent[];
  selected: string;
  onSelect: (view: string) => void;
  onNewAgent: () => void;
  showArchived: boolean;
  onToggleArchived: () => void;
}

export function Sidebar({ agents, selected, onSelect, onNewAgent, showArchived, onToggleArchived }: SidebarProps) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const lowered = query.trim().toLowerCase();
    return agents.filter((agent) => !lowered || agent.name.toLowerCase().includes(lowered) || agent.role.toLowerCase().includes(lowered));
  }, [agents, query]);
  const pinned = visible.filter((agent) => agent.pinned);
  const others = visible.filter((agent) => !agent.pinned);

  const row = (agent: Agent) => (
    <button key={agent.id} className={`agent-row ${selected === `agent:${agent.id}` ? "active" : ""} ${agent.archived ? "archived" : ""}`} onClick={() => onSelect(`agent:${agent.id}`)}>
      <span className="agent-face" aria-hidden>{agent.face}</span>
      <span className="agent-row-text">
        <span className="agent-row-name">{agent.name}</span>
        <span className="agent-row-last">{statusLabel[agent.status] || agent.lastMessage || agent.role || "ready when you are"}</span>
      </span>
      {agent.status === "running" || agent.status === "pending" ? <span className="status-dot working" title="working" /> : null}
      {agent.status === "needs_you" ? <span className="status-dot needs-you" title="needs you" /> : null}
      {agent.unread > 0 ? <span className="unread-gel">{agent.unread}</span> : null}
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className={`brand ${selected === "home" ? "active" : ""}`} onClick={() => onSelect("home")}>
          <span className="brand-cursor" aria-hidden />
          pip
        </button>
        <button className="gel-button small" onClick={onNewAgent} title="new agent">
          + new
        </button>
      </div>
      <input className="search" placeholder="search agents" value={query} onChange={(event) => setQuery(event.target.value)} />
      <nav className="agent-list">
        {pinned.length > 0 && <div className="list-label">pinned</div>}
        {pinned.map(row)}
        {others.length > 0 && <div className="list-label">agents</div>}
        {others.map(row)}
        {visible.length === 0 && <p className="empty-note">no agents yet. ask pip to do something and one appears here.</p>}
      </nav>
      <div className="sidebar-bottom">
        <button className="link-button" onClick={onToggleArchived}>{showArchived ? "hide archived" : "show archived"}</button>
        <button className={`link-button ${selected.startsWith("settings") ? "active" : ""}`} onClick={() => onSelect("settings:general")}>settings</button>
      </div>
    </aside>
  );
}
