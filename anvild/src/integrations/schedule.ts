import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AutopilotSchedule } from "@protocol";
import { writeFileAtomic } from "../util/atomic";

/**
 * The autopilot's in-daemon schedule: when the unattended run fires, and what it does
 * (anvil-autopilot-ui.md → Scheduling). Pure due-logic lives here too (no agent-SDK import) so it
 * can be unit-tested deterministically by passing `now` — see [[anvil-sdk-test-extraction-flake]].
 * Persisted to `<stateDir>/integrations/autopilot-schedule.json`.
 */

export const DEFAULT_SCHEDULE: AutopilotSchedule = {
  enabled: false,
  timeOfDay: "02:00",
  // Review-only by default: the nightly run plans and holds, and a human starts the build. Auto-start
  // an unattended build only when the operator explicitly opts in — an underspecified task should never
  // reach a bypass-permission build session without someone having chosen that trade-off. See the
  // intake gate + adversarial-consensus gate that also guard auto-start when it IS enabled.
  autoStart: false,
  usePipeline: false,
  maxAutoStart: 3,
  label: "Autopilot",
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

/**
 * Whether a run that began at `startedAt` (epoch ms) still counts as live, given a `budgetMs` ceiling.
 * The live-run state the daemon broadcasts is DERIVED from this rather than stored as a boolean: a run
 * older than the budget reports not-running automatically, so a hung run (an await that never settles,
 * a finally that never fires) can never latch the "autopilot running" spinner. `undefined` = idle.
 */
export function runWithinBudget(startedAt: number | undefined, now: number, budgetMs: number): boolean {
  return startedAt !== undefined && now - startedAt < budgetMs;
}

/**
 * Should the daemon fire the scheduled run *right now*? This is edge-triggered, NOT catch-up: it's true
 * only when `now` is within `windowMs` of the most recent scheduled fire AND we haven't already run
 * since that fire. So the run happens as the clock crosses the scheduled time while the daemon is
 * running — a restart hours later sees the fire is long past (outside the window) and does NOT run.
 *
 * This deliberately drops the old "catch-up on (re)start" behaviour: that fired a brand-new run — and
 * its "autopilot running" spinner — every time the daemon was restarted, which is surprising and was
 * read as a stuck spinner. Trade-off: if the Mac is off/asleep through the whole window, that day is
 * skipped. The window must exceed the scheduler's tick interval so a tick always lands inside it.
 */
export function scheduledFireDue(sched: AutopilotSchedule, now: Date, windowMs: number, lastRunAt?: string): boolean {
  const fire = lastScheduledFire(sched, now);
  if (!fire) return false;
  if (now.getTime() - fire.getTime() >= windowMs) return false; // fire is in the past, not now → no catch-up
  if (lastRunAt && new Date(lastRunAt).getTime() >= fire.getTime()) return false; // already ran this window
  return true;
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
    if (patch.usePipeline !== undefined) next.usePipeline = patch.usePipeline;
    if (patch.maxAutoStart !== undefined) next.maxAutoStart = Math.max(0, Math.round(patch.maxAutoStart));
    // Empty string clears label sourcing / the catch-all env; a value sets it.
    if (patch.label !== undefined) next.label = patch.label.trim() || undefined;
    if (patch.defaultEnvironmentId !== undefined) next.defaultEnvironmentId = patch.defaultEnvironmentId || undefined;
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
    // [BE-9] atomic (tmp+rename): a torn write here silently reverted the schedule to disabled,
    // killing the user's nightly autopilot with no notice.
    writeFileAtomic(this.file, JSON.stringify(this.state, null, 2));
  }
}
