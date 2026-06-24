import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutopilotSchedule } from "@protocol";

/**
 * The autopilot's in-daemon schedule: when the unattended run fires, and what it does
 * (anvil-autopilot-ui.md → Scheduling). Pure due-logic lives here too (no agent-SDK import) so it
 * can be unit-tested deterministically by passing `now` — see [[anvil-sdk-test-extraction-flake]].
 * Persisted to `<stateDir>/integrations/autopilot-schedule.json`.
 */

export const DEFAULT_SCHEDULE: AutopilotSchedule = {
  enabled: false,
  timeOfDay: "02:00",
  autoStart: true,
  maxAutoStart: 3,
};

/** Parse "HH:MM" → minutes since midnight, or undefined if malformed / out of range. */
export function parseTimeOfDay(s: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

/** Whether `day` (0=Sun..6=Sat) is an enabled day; absent/empty `days` means every day. */
function dayEnabled(sched: AutopilotSchedule, day: number): boolean {
  return !sched.days || sched.days.length === 0 || sched.days.includes(day);
}

/** A copy of `now` set to the schedule's time-of-day, `offsetDays` away (server-local). */
function fireOn(now: Date, minutes: number, offsetDays: number): Date {
  const d = new Date(now);
  d.setDate(now.getDate() + offsetDays);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d;
}

/** The most recent scheduled fire at or before `now`, or undefined if the schedule never fires
 *  (disabled, bad time, or no enabled day in the last week). Server-local. */
export function lastScheduledFire(sched: AutopilotSchedule, now: Date): Date | undefined {
  if (!sched.enabled) return undefined;
  const minutes = parseTimeOfDay(sched.timeOfDay);
  if (minutes === undefined) return undefined;
  for (let back = 0; back < 8; back++) {
    const d = fireOn(now, minutes, -back);
    if (d.getTime() > now.getTime()) continue; // today's time hasn't arrived yet
    if (dayEnabled(sched, d.getDay())) return d;
  }
  return undefined;
}

/** The next scheduled fire strictly after `now`, or undefined if disabled / unparseable. */
export function nextScheduledFire(sched: AutopilotSchedule, now: Date): Date | undefined {
  if (!sched.enabled) return undefined;
  const minutes = parseTimeOfDay(sched.timeOfDay);
  if (minutes === undefined) return undefined;
  for (let fwd = 0; fwd < 8; fwd++) {
    const d = fireOn(now, minutes, fwd);
    if (d.getTime() <= now.getTime()) continue;
    if (dayEnabled(sched, d.getDay())) return d;
  }
  return undefined;
}

/** Due = enabled, a fire time has passed, and we haven't run since that fire (catch-up included). */
export function isRunDue(sched: AutopilotSchedule, now: Date, lastRunAt?: string): boolean {
  const fire = lastScheduledFire(sched, now);
  if (!fire) return false;
  if (!lastRunAt) return true; // never run, and a fire time has already passed
  return new Date(lastRunAt).getTime() < fire.getTime();
}

export class AutopilotScheduleStore {
  private readonly file: string;
  private state: AutopilotSchedule;

  constructor(stateDir: string) {
    const dir = join(stateDir, "integrations");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "autopilot-schedule.json");
    this.state = this.load();
  }

  get(): AutopilotSchedule {
    return { ...this.state };
  }

  /** Merge user-settable fields (lastRunAt is server-owned and ignored here). */
  set(patch: Partial<Omit<AutopilotSchedule, "lastRunAt">>): AutopilotSchedule {
    const next: AutopilotSchedule = { ...this.state };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.timeOfDay !== undefined) next.timeOfDay = patch.timeOfDay;
    if (patch.days !== undefined) next.days = patch.days;
    if (patch.autoStart !== undefined) next.autoStart = patch.autoStart;
    if (patch.maxAutoStart !== undefined) next.maxAutoStart = Math.max(0, Math.round(patch.maxAutoStart));
    this.state = next;
    this.save();
    return this.get();
  }

  markRun(at: string): void {
    this.state = { ...this.state, lastRunAt: at };
    this.save();
  }

  private load(): AutopilotSchedule {
    if (!existsSync(this.file)) return { ...DEFAULT_SCHEDULE };
    try {
      return { ...DEFAULT_SCHEDULE, ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<AutopilotSchedule>) };
    } catch {
      return { ...DEFAULT_SCHEDULE };
    }
  }
  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}
