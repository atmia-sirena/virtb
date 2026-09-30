// Routines: a task an agent repeats every N minutes/hours/days, posting each
// result in its chat. Like HeyClicky's, they run on this PC while it's awake
// and Pip is open (never in the cloud), wait for an internet connection, catch
// up once after sleep rather than replaying every missed run, and pause after
// three failures in a row.
import crypto from "node:crypto";
import path from "node:path";
import { readJsonFile, stateDirectory, writeJsonFile } from "../config.js";
import { eventBus } from "../lib/events.js";
import { getRun, startTask } from "./runner.js";

export interface Routine {
  id: string;
  agentId: string;
  prompt: string;
  everyMinutes: number;
  nextRunAt: string;
  paused: boolean;
  consecutiveFailures: number;
  lastRunAt?: string;
  lastRunId?: string;
  lastStatus?: "done" | "failed" | "running";
  createdAt: string;
}

const routinesPath = () => path.join(stateDirectory, "routines.json");

export function listRoutines(agentId?: string): Routine[] {
  return readJsonFile<Routine[]>(routinesPath(), []).filter((routine) => !agentId || routine.agentId === agentId);
}

function saveRoutines(routines: Routine[]): void {
  writeJsonFile(routinesPath(), routines);
  eventBus.publish("routine.changed", {});
}

export function createRoutine(input: { agentId: string; prompt: string; everyMinutes: number; runNow?: boolean }): Routine {
  const routines = listRoutines();
  const everyMinutes = Math.max(5, Math.round(input.everyMinutes));
  const routine: Routine = {
    id: crypto.randomUUID(),
    agentId: input.agentId,
    prompt: input.prompt,
    everyMinutes,
    // The first run happens right away unless asked otherwise.
    nextRunAt: new Date(input.runNow === false ? Date.now() + everyMinutes * 60_000 : Date.now()).toISOString(),
    paused: false,
    consecutiveFailures: 0,
    createdAt: new Date().toISOString(),
  };
  saveRoutines([...routines, routine]);
  return routine;
}

export function updateRoutine(routineId: string, changes: Partial<Pick<Routine, "prompt" | "everyMinutes" | "paused" | "nextRunAt">>): Routine | undefined {
  const routines = listRoutines();
  const routine = routines.find((candidate) => candidate.id === routineId);
  if (!routine) return undefined;
  Object.assign(routine, changes);
  if (changes.paused === false) routine.consecutiveFailures = 0;
  saveRoutines(routines);
  return routine;
}

export function deleteRoutine(routineId: string): boolean {
  const routines = listRoutines();
  const remaining = routines.filter((routine) => routine.id !== routineId);
  saveRoutines(remaining);
  return remaining.length !== routines.length;
}

async function isOnline(): Promise<boolean> {
  try {
    const response = await fetch("https://www.google.com/generate_204", { method: "HEAD", signal: AbortSignal.timeout(3000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

export async function runRoutineNow(routineId: string): Promise<Routine | undefined> {
  const routines = listRoutines();
  const routine = routines.find((candidate) => candidate.id === routineId);
  if (!routine) return undefined;
  const { run } = await startTask({ prompt: `(routine, every ${routine.everyMinutes} min) ${routine.prompt}`, agentId: routine.agentId, source: "routine" });
  routine.lastRunAt = new Date().toISOString();
  routine.lastRunId = run.id;
  routine.lastStatus = "running";
  // Catch up once: the next run is one interval from now, not from the missed slot.
  routine.nextRunAt = new Date(Date.now() + routine.everyMinutes * 60_000).toISOString();
  saveRoutines(routines);
  return routine;
}

function recordFinishedRuns(): void {
  const routines = listRoutines();
  let changed = false;
  for (const routine of routines) {
    if (routine.lastStatus !== "running" || !routine.lastRunId) continue;
    const run = getRun(routine.lastRunId);
    if (!run || !["done", "failed", "cancelled"].includes(run.status)) continue;
    routine.lastStatus = run.status === "done" ? "done" : "failed";
    routine.consecutiveFailures = run.status === "done" ? 0 : routine.consecutiveFailures + 1;
    if (routine.consecutiveFailures >= 3) {
      routine.paused = true;
      eventBus.publish("notification", { text: `paused a routine after 3 failures: ${routine.prompt.slice(0, 80)}`, agentId: routine.agentId });
    }
    changed = true;
  }
  if (changed) saveRoutines(routines);
}

let schedulerTimer: NodeJS.Timeout | undefined;

export function startRoutineScheduler(intervalMs = 30_000): void {
  if (schedulerTimer) return;
  const tick = async () => {
    recordFinishedRuns();
    const due = listRoutines().filter((routine) => !routine.paused && routine.lastStatus !== "running" && Date.parse(routine.nextRunAt) <= Date.now());
    if (due.length === 0 || !(await isOnline())) return;
    for (const routine of due) {
      try {
        await runRoutineNow(routine.id);
      } catch (error) {
        console.warn("[routines] couldn't start:", (error as Error).message);
      }
    }
  };
  schedulerTimer = setInterval(() => void tick(), intervalMs);
  schedulerTimer.unref?.();
}
