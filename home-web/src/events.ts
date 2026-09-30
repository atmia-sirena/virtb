// Live updates from GET /events (Server-Sent Events): agent progress, permission prompts, notifications.
import { useEffect, useRef } from "react";

export interface PipEvent {
  type: string;
  at: string;
  data: Record<string, any>;
}

const eventTypes = [
  "agent.created",
  "agent.updated",
  "run.started",
  "run.step",
  "run.message",
  "run.permission",
  "run.done",
  "run.failed",
  "run.cancelled",
  "announce",
  "notification",
  "settings.changed",
  "memory.changed",
  "routine.changed",
];

export function usePipEvents(onEvent: (event: PipEvent) => void): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  useEffect(() => {
    let source: EventSource | undefined;
    let retryTimer: number | undefined;
    const connect = () => {
      source = new EventSource("/events");
      for (const type of eventTypes) source.addEventListener(type, (message) => handlerRef.current(JSON.parse((message as MessageEvent).data) as PipEvent));
      source.onerror = () => {
        source?.close();
        retryTimer = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      source?.close();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, []);
}
