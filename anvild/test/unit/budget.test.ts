import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimitTracker } from "../../src/budget/tracker";

// warn at 0.8 → 80% of any window; soft-stop at 0.95 → 95% of the 7-day window.
const cfg = () => ({ stateDir: mkdtempSync(join(tmpdir(), "anvil-bud-")), warnFraction: 0.8, softStopFraction: 0.95 });

// A minimal SDK `rate_limits` payload (snake_case, as the SDK reports it).
const raw = (sevenDay: number, fiveHour = 0, resetsAt = "2026-07-01T00:00:00Z") => ({
  five_hour: { utilization: fiveHour, resets_at: "2026-06-22T12:00:00Z" },
  seven_day: { utilization: sevenDay, resets_at: resetsAt },
  seven_day_sonnet: { utilization: 1, resets_at: resetsAt },
});

test("reads the real rate-limit windows into the gauge", () => {
  const c = cfg();
  const { budget } = new RateLimitTracker(c).update("a", raw(5, 27), "max");
  expect(budget.available).toBe(true);
  expect(budget.subscriptionType).toBe("max");
  expect(budget.week?.utilization).toBe(5);
  expect(budget.session?.utilization).toBe(27);
  expect(budget.weekSonnet?.utilization).toBe(1);
  expect(budget.warn).toBe(false);
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("warn flips when any window passes the threshold", () => {
  const c = cfg();
  const { budget } = new RateLimitTracker(c).update("a", raw(85), "max");
  expect(budget.warn).toBe(true);
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("soft-stop crosses once, latches, then re-arms when the window resets", () => {
  const c = cfg();
  const t = new RateLimitTracker(c);
  expect(t.update("a", raw(90), "max").crossedSoftStop).toBe(false); // below 95%
  expect(t.update("a", raw(96), "max").crossedSoftStop).toBe(true); // crosses
  expect(t.update("a", raw(97), "max").crossedSoftStop).toBe(false); // latched
  // New 7-day window (different reset timestamp) → latch re-arms.
  expect(t.update("a", raw(98, 0, "2026-07-08T00:00:00Z"), "max").crossedSoftStop).toBe(true);
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("an unavailable reading keeps the last-known gauge", () => {
  const c = cfg();
  const t = new RateLimitTracker(c);
  t.update("a", raw(42), "max");
  const { budget, crossedSoftStop } = t.update("a", null);
  expect(budget.week?.utilization).toBe(42);
  expect(crossedSoftStop).toBe(false);
  expect(t.update("a", undefined).budget.available).toBe(true);
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("a fresh tracker reports unavailable (no plan data yet)", () => {
  const c = cfg();
  const b = new RateLimitTracker(c).snapshot();
  expect(b.available).toBe(false);
  expect(b.warn).toBe(false);
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("persists the gauge across instances", () => {
  const c = cfg();
  new RateLimitTracker(c).update("a", raw(12), "max");
  expect(new RateLimitTracker(c).snapshot().week?.utilization).toBe(12);
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("keeps an independent gauge per account (rate limits are per account, not per daemon)", () => {
  const c = cfg();
  const t = new RateLimitTracker(c);
  t.update("work", raw(70, 10), "max");
  t.update("personal", raw(5, 2), "pro");
  // A second account's turn must not overwrite the first account's numbers.
  const byId = Object.fromEntries(t.snapshots().map((b) => [b.accountId, b]));
  expect(byId.work?.week?.utilization).toBe(70);
  expect(byId.personal?.week?.utilization).toBe(5);
  expect(byId.personal?.subscriptionType).toBe("pro");
  // snapshot() stays "the most recently refreshed account" — what autopilot/teams gate on.
  expect(t.snapshot().accountId).toBe("personal");
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("soft-stop latches per account", () => {
  const c = cfg();
  const t = new RateLimitTracker(c);
  expect(t.update("work", raw(96), "max").crossedSoftStop).toBe(true);
  expect(t.update("personal", raw(96), "max").crossedSoftStop).toBe(true); // its own window, its own latch
  expect(t.update("work", raw(97), "max").crossedSoftStop).toBe(false);
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("an unavailable reading for a new account leaves the other gauges alone", () => {
  const c = cfg();
  const t = new RateLimitTracker(c);
  t.update("work", raw(33), "max");
  t.update("personal", null);
  expect(t.snapshots().map((b) => b.accountId)).toEqual(["work"]);
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("retain() drops removed accounts", () => {
  const c = cfg();
  const t = new RateLimitTracker(c);
  t.update("work", raw(10), "max");
  t.update("gone", raw(20), "max");
  t.retain((k) => k !== "gone");
  expect(t.snapshots().map((b) => b.accountId)).toEqual(["work"]);
  expect(new RateLimitTracker(c).snapshots().map((b) => b.accountId)).toEqual(["work"]); // persisted
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("the bare env-var token (key \"\") carries no accountId", () => {
  const c = cfg();
  const { budget } = new RateLimitTracker(c).update("", raw(9), "max");
  expect(budget.accountId).toBeUndefined();
  expect(budget.week?.utilization).toBe(9);
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("a pre-per-account budget.json is the snapshot fallback until a fresh reading", () => {
  const c = cfg();
  writeFileSync(join(c.stateDir, "budget.json"), JSON.stringify({ budget: { available: true, warn: true, week: { utilization: 81 } }, softStopped: false }));
  const t = new RateLimitTracker(c);
  expect(t.snapshot().week?.utilization).toBe(81);
  expect(t.snapshot().warn).toBe(true);
  expect(t.snapshots()).toEqual([]); // unattributable → not shown as any account's gauge
  t.update("work", raw(12), "max");
  expect(t.snapshot().week?.utilization).toBe(12);
  rmSync(c.stateDir, { recursive: true, force: true });
});
