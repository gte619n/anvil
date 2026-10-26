import { test, expect } from "bun:test";
import type { Budget } from "../../protocol";
import { agoText, gaugeLabel, gaugesOf, isStale, level, mergeGauges, untilText, weekProgress } from "../../web/src/usage";

const g = (accountId: string | undefined, updatedAt: string, week: number, extra: Partial<Budget> = {}): Budget => ({
  available: true,
  warn: false,
  ...(accountId ? { accountId } : {}),
  updatedAt,
  week: { utilization: week },
  ...extra,
});

test("one gauge per account across servers — the newest reading wins", () => {
  const hub = [g("a", "2026-10-25T10:00:00Z", 40, { accountLabel: "work" }), g("b", "2026-10-25T10:05:00Z", 3, { accountLabel: "personal" })];
  const member = [g("a", "2026-10-25T10:09:00Z", 44, { accountLabel: "work" })];
  const out = mergeGauges([hub, member]);
  expect(out.map((x) => [x.accountLabel, x.week?.utilization])).toEqual([
    ["personal", 3],
    ["work", 44],
  ]);
});

test("same subscription on two machines (different local ids) merges by subscriptionKey", () => {
  // The real-world "two default meters" bug: one Claude account seeded on two daemons, each minting a
  // random accountId, but the SAME token → the same subscriptionKey. These must collapse to one row.
  const hub = [g("hub_id", "2026-10-25T10:00:00Z", 6, { accountLabel: "default", subscriptionKey: "k1" })];
  const member = [g("mem_id", "2026-10-25T10:05:00Z", 6, { accountLabel: "default", subscriptionKey: "k1" })];
  const out = mergeGauges([hub, member]);
  expect(out.length).toBe(1);
  expect(out[0]?.accountId).toBe("mem_id"); // newest reading wins
});

test("two real accounts both labelled 'default' stay separate (distinct subscriptionKeys)", () => {
  const a = g("a", "2026-10-25T10:00:00Z", 6, { accountLabel: "default", subscriptionKey: "ka" });
  const b = g("b", "2026-10-25T10:00:00Z", 9, { accountLabel: "default", subscriptionKey: "kb" });
  expect(mergeGauges([[a], [b]]).length).toBe(2);
});

test("unavailable gauges are dropped; unattributed ones merge under one key", () => {
  const out = mergeGauges([[{ available: false, warn: false }, g(undefined, "2026-10-25T10:00:00Z", 5)], [g(undefined, "2026-10-25T11:00:00Z", 6)]]);
  expect(out.map((x) => x.week?.utilization)).toEqual([6]);
});

test("gaugesOf falls back to the legacy single budget on an older daemon", () => {
  const b = g("a", "2026-10-25T10:00:00Z", 1);
  expect(gaugesOf({ budget: b })).toEqual([b]);
  expect(gaugesOf({ budget: { available: false, warn: false } })).toEqual([]);
  expect(gaugesOf({ budget: b, budgets: [] })).toEqual([]);
});

test("labels, levels, and relative times", () => {
  expect(gaugeLabel({ available: true, warn: false, subscriptionType: "max" })).toBe("Claude Max");
  expect(gaugeLabel({ available: true, warn: false, accountLabel: "work" })).toBe("work");
  expect(level({ utilization: 79 })).toBe("");
  expect(level({ utilization: 80 })).toBe("warm");
  expect(level({ utilization: 95 })).toBe("hot");
  const now = Date.parse("2026-10-25T12:00:00Z");
  expect(untilText("2026-10-25T14:14:00Z", now)).toBe("2h 14m");
  expect(untilText("2026-10-28T16:00:00Z", now)).toBe("3d 4h");
  expect(untilText("2026-10-25T11:00:00Z", now)).toBe("");
  expect(agoText("2026-10-25T11:53:00Z", now)).toBe("7m ago");
  expect(isStale(g("a", "2026-10-25T11:50:00Z", 1), now)).toBe(false);
  expect(isStale(g("a", "2026-10-25T11:30:00Z", 1), now)).toBe(true);
});

test("weekProgress: prorated fraction elapsed through the 7-day window", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  // reset exactly 3.5 days out → the window opened 3.5 days ago → half elapsed
  expect(weekProgress("2026-10-29T00:00:00Z", now)).toBeCloseTo(50, 5);
  // reset is now → the full week has elapsed
  expect(weekProgress("2026-10-25T12:00:00Z", now)).toBeCloseTo(100, 5);
  // reset a full 7 days out → the window just opened
  expect(weekProgress("2026-11-01T12:00:00Z", now)).toBeCloseTo(0, 5);
  expect(weekProgress(undefined, now)).toBeNull();
  expect(weekProgress("not-a-date", now)).toBeNull();
});
