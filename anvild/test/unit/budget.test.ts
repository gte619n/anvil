import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetTracker } from "../../src/budget/tracker";

// defaults (no env override): opus 18 USD/hr, limit 20 hr; sonnet 6 USD/hr, limit 240 hr.
// warn at 0.8 → opus 16 hr (288 USD); soft-stop at 0.95 → 19 hr (342 USD).
const cfg = () => ({ stateDir: mkdtempSync(join(tmpdir(), "anvil-bud-")), warnFraction: 0.8, softStopFraction: 0.95 });

test("accumulates cost and reports hours + limits", () => {
  const c = cfg();
  const { budget } = new BudgetTracker(c).record("opus", 18);
  expect(budget.opus.usedHrs).toBeCloseTo(1, 1);
  expect(budget.opus.limitHrs).toBe(20);
  expect(budget.warn).toBe(false);
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("warn flips past threshold; soft-stop crosses exactly once", () => {
  const c = cfg();
  const t = new BudgetTracker(c);
  let r = t.record("opus", 290); // 16.1 hr → warn, not yet soft-stop
  expect(r.budget.warn).toBe(true);
  expect(r.crossedSoftStop).toBe(false);
  r = t.record("opus", 60); // 19.4 hr → soft-stop crossed
  expect(r.crossedSoftStop).toBe(true);
  expect(t.record("opus", 10).crossedSoftStop).toBe(false); // already stopped
  rmSync(c.stateDir, { recursive: true, force: true });
});

test("persists across instances (same window)", () => {
  const c = cfg();
  new BudgetTracker(c).record("sonnet", 12);
  expect(new BudgetTracker(c).snapshot().sonnet.usedHrs).toBeCloseTo(2, 1); // 12 / 6
  rmSync(c.stateDir, { recursive: true, force: true });
});
