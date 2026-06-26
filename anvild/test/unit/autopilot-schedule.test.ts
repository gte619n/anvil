import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutopilotSchedule } from "../../protocol";
import {
  AutopilotScheduleStore,
  DEFAULT_SCHEDULE,
  isRunDue,
  lastScheduledFire,
  nextScheduledFire,
  parseTimeOfDay,
  runWithinBudget,
} from "../../src/integrations/schedule";

const sched = (over: Partial<AutopilotSchedule> = {}): AutopilotSchedule => ({ ...DEFAULT_SCHEDULE, enabled: true, timeOfDay: "02:00", ...over });
// A fixed local clock so the day-of-week / time math is deterministic.
const at = (s: string): Date => new Date(s);

test("parseTimeOfDay accepts valid, rejects junk", () => {
  expect(parseTimeOfDay("02:00")).toBe(120);
  expect(parseTimeOfDay("23:59")).toBe(23 * 60 + 59);
  expect(parseTimeOfDay("9:05")).toBe(9 * 60 + 5);
  expect(parseTimeOfDay("24:00")).toBeUndefined();
  expect(parseTimeOfDay("8")).toBeUndefined();
  expect(parseTimeOfDay("ab:cd")).toBeUndefined();
});

test("a disabled schedule never fires", () => {
  const s = sched({ enabled: false });
  expect(lastScheduledFire(s, at("2026-06-24T09:00:00"))).toBeUndefined();
  expect(isRunDue(s, at("2026-06-24T09:00:00"))).toBe(false);
});

test("lastScheduledFire is today's time once it has passed, else yesterday's", () => {
  const s = sched({ timeOfDay: "02:00" }); // daily
  // 09:00 — today 02:00 already passed
  expect(lastScheduledFire(s, at("2026-06-24T09:00:00"))?.toISOString()).toBe(new Date("2026-06-24T02:00:00").toISOString());
  // 01:00 — today's 02:00 hasn't arrived → yesterday's
  expect(lastScheduledFire(s, at("2026-06-24T01:00:00"))?.toISOString()).toBe(new Date("2026-06-23T02:00:00").toISOString());
});

test("isRunDue fires when no prior run and a fire time has passed", () => {
  const s = sched({ timeOfDay: "02:00" });
  expect(isRunDue(s, at("2026-06-24T09:00:00"))).toBe(true); // lastRunAt undefined
});

test("isRunDue is false once we've run since the last fire, true after the next fire", () => {
  const s = sched({ timeOfDay: "02:00" });
  // ran at 02:05 today → not due at 09:00
  expect(isRunDue(s, at("2026-06-24T09:00:00"), "2026-06-24T02:05:00")).toBe(false);
  // same run, but now it's tomorrow past 02:00 → due again (catch-up / next day)
  expect(isRunDue(s, at("2026-06-25T03:00:00"), "2026-06-24T02:05:00")).toBe(true);
});

test("catch-up: down at 02:00, started at 07:00 with last run two days ago → due", () => {
  const s = sched({ timeOfDay: "02:00" });
  expect(isRunDue(s, at("2026-06-24T07:00:00"), "2026-06-22T02:01:00")).toBe(true);
});

test("days restriction: only fires on enabled weekdays", () => {
  // 2026-06-24 is a Wednesday (day 3). Restrict to Mon/Fri (1,5).
  const s = sched({ timeOfDay: "02:00", days: [1, 5] });
  expect(lastScheduledFire(s, at("2026-06-24T09:00:00"))?.getDay()).toBe(1); // most recent enabled day = Mon 22nd
  expect(isRunDue(s, at("2026-06-24T09:00:00"), "2026-06-22T02:05:00")).toBe(false); // already ran Monday
  // Friday the 26th after 02:00 → due
  expect(isRunDue(s, at("2026-06-26T03:00:00"), "2026-06-22T02:05:00")).toBe(true);
});

test("nextScheduledFire is strictly in the future and on an enabled day", () => {
  const s = sched({ timeOfDay: "02:00", days: [1, 5] });
  const next = nextScheduledFire(s, at("2026-06-24T09:00:00")); // Wed → next is Fri 26th
  expect(next?.getDay()).toBe(5);
  expect(next!.getTime()).toBeGreaterThan(at("2026-06-24T09:00:00").getTime());
});

test("store round-trips, merges patches, ignores lastRunAt in set, and clamps the cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-sched-"));
  try {
    const store = new AutopilotScheduleStore(dir);
    expect(store.get()).toEqual(DEFAULT_SCHEDULE);
    store.set({ enabled: true, timeOfDay: "06:30", maxAutoStart: 2.7 });
    expect(store.get().enabled).toBe(true);
    expect(store.get().timeOfDay).toBe("06:30");
    expect(store.get().maxAutoStart).toBe(3); // rounded
    expect(store.get().autoStart).toBe(true); // unchanged default preserved
    store.markRun("2026-06-24T02:00:00.000Z");
    // reload from disk
    const reloaded = new AutopilotScheduleStore(dir);
    expect(reloaded.get().timeOfDay).toBe("06:30");
    expect(reloaded.get().lastRunAt).toBe("2026-06-24T02:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The live-run spinner is DERIVED from this, not a stored boolean — that's what makes it un-latchable.

test("runWithinBudget treats an over-budget run as not-running (the un-latchable spinner)", () => {
  const budget = 30 * 60_000; // 30 min
  const t0 = 1_000_000_000_000;
  expect(runWithinBudget(undefined, t0, budget)).toBe(false); // idle
  expect(runWithinBudget(t0, t0, budget)).toBe(true); // just started
  expect(runWithinBudget(t0, t0 + budget - 1, budget)).toBe(true); // within budget
  expect(runWithinBudget(t0, t0 + budget, budget)).toBe(false); // at the ceiling → reported done
  expect(runWithinBudget(t0, t0 + budget + 60_000, budget)).toBe(false); // a hung run never latches
});
