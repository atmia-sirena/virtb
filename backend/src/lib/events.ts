// One in-process event bus. The Windows client and Home subscribe to GET /events
// (Server-Sent Events) for agent progress, permission prompts, announcements
// and notifications, like HeyClicky's floating agent cards.
import { EventEmitter } from "node:events";

export type PipEventType =
  | "agent.created"
  | "agent.updated"
  | "run.started"
  | "run.step"
  | "run.message"
  | "run.permission"
  | "run.file"
  | "run.done"
  | "run.failed"
  | "run.cancelled"
  | "announce"
  | "notification"
  | "settings.changed"
  | "memory.changed"
  | "routine.changed";

export interface PipEvent {
  type: PipEventType;
  at: string;
  data: Record<string, unknown>;
}

class PipEventBus extends EventEmitter {
  private recentEvents: PipEvent[] = [];

  publish(type: PipEventType, data: Record<string, unknown>): PipEvent {
    const event: PipEvent = { type, at: new Date().toISOString(), data };
    this.recentEvents.push(event);
    if (this.recentEvents.length > 200) this.recentEvents.shift();
    this.emit("event", event);
    return event;
  }

  recent(): PipEvent[] {
    return [...this.recentEvents];
  }
}

export const eventBus = new PipEventBus();
eventBus.setMaxListeners(100);
