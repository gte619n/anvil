import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutopilotSchedule } from "../../protocol";
import {
  AutopilotScheduleStore,
  DEFAULT_SCHEDULE,
  scheduledFireDue,
  lastScheduledFire,
  nextScheduledFire,
  parseTimeOfDay,
  runWithinBudget,
} from "../../src/integrations/schedule";

const sched = (over: Partial<AutopilotSchedule> = {}): AutopilotSchedule => ({ ...DEFAULT_SCHEDULE, enabled: true, timeOfDay: "02:00", ...over });
// A fixed local clock so the day-of-week / time math is deterministic.
const at = (s: string): Date => new Date(s);
const W = 10 * 60_000; // the daemon's scheduled-run window (SCHEDULE_RUN_WINDOW_MS)

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
  expect(scheduledFireDue(s, at("2026-06-24T09:00:00"), W)).toBe(false);
});

test("lastScheduledFire is today's time once it has passed, else yesterday's", () => {
  const s = sched({ timeOfDay: "02:00" }); // daily
  // 09:00 — today 02:00 already passed
  expect(lastScheduledFire(s, at("2026-06-24T09:00:00"))?.toISOString()).toBe(new Date("2026-06-24T02:00:00").toISOString());
  // 01:00 — today's 02:00 hasn't arrived → yesterday's
  expect(lastScheduledFire(s, at("2026-06-24T01:00:00"))?.toISOString()).toBe(new Date("2026-06-23T02:00:00").toISOString());
});

test("scheduledFireDue fires within the window of the scheduled time, not long after", () => {
  const s = sched({ timeOfDay: "02:00" });
  // 02:06 — 6 min after the 02:00 fire, inside the 10-min window, never run → fires
  expect(scheduledFireDue(s, at("2026-06-24T02:06:00"), W)).toBe(true);
  // 09:00 — hours past the fire → outside the window → does NOT fire (no catch-up on a late check)
  expect(scheduledFireDue(s, at("2026-06-24T09:00:00"), W)).toBe(false);
  // 01:00 — before today's fire; the most recent fire is yesterday's, long past → no fire
  expect(scheduledFireDue(s, at("2026-06-24T01:00:00"), W)).toBe(false);
});

test("scheduledFireDue won't refire after running this window, but fires again the next day", () => {
  const s = sched({ timeOfDay: "02:00" });
  // ran at 02:03 today → a later in-window tick at 02:08 must not refire
  expect(scheduledFireDue(s, at("2026-06-24T02:08:00"), W, "2026-06-24T02:03:00")).toBe(false);
  // next day, in-window at 02:04, last run was yesterday → fires
  expect(scheduledFireDue(s, at("2026-06-25T02:04:00"), W, "2026-06-24T02:03:00")).toBe(true);
});

test("no catch-up on restart: a daemon coming up hours after the scheduled time does NOT run", () => {
  const s = sched({ timeOfDay: "02:00" });
  // up at 07:00 having missed 02:00 (last run two days ago). The old behaviour fired a run + spinner on
  // every such (re)start; now it must skip until the next scheduled time arrives while it's running.
  expect(scheduledFireDue(s, at("2026-06-24T07:00:00"), W, "2026-06-22T02:01:00")).toBe(false);
});

test("days restriction: fires only within the window on enabled weekdays", () => {
  // 2026-06-26 is a Friday (day 5); restrict to Mon/Fri (1,5).
  const s = sched({ timeOfDay: "02:00", days: [1, 5] });
  // Friday 02:05 — in window, enabled day, last run Monday → fires
  expect(scheduledFireDue(s, at("2026-06-26T02:05:00"), W, "2026-06-22T02:05:00")).toBe(true);
  // Wednesday 02:05 — not an enabled day (most recent fire is Mon, long past) → no fire
  expect(scheduledFireDue(s, at("2026-06-24T02:05:00"), W, "2026-06-22T02:05:00")).toBe(false);
  // Friday 09:00 — enabled day but hours past the fire → outside the window → no fire
  expect(scheduledFireDue(s, at("2026-06-26T09:00:00"), W, "2026-06-22T02:05:00")).toBe(false);
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
    expect(store.get().autoStart).toBe(false); // review-only by default; a patch that omits it preserves that
    store.set({ autoStart: true });
    expect(store.get().autoStart).toBe(true); // opt-in round-trips
    // usePipeline opts into the autonomous pipeline for auto-started units; defaults off, round-trips.
    expect(store.get().usePipeline).toBe(false);
    store.set({ usePipeline: true });
    expect(store.get().usePipeline).toBe(true);
    store.markRun("2026-06-24T02:00:00.000Z");
    // reload from disk
    const reloaded = new AutopilotScheduleStore(dir);
    expect(reloaded.get().timeOfDay).toBe("06:30");
    expect(reloaded.get().usePipeline).toBe(true);
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
