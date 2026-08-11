import { test, expect } from "bun:test";
import { GOAL_MAX_ITERATIONS } from "@protocol";
import { buildLoopsSnapshot, type LoopsInput } from "../../src/integrations/loops";

const empty: LoopsInput = { goals: [], pipelines: [], proposals: [] };

test("buildLoopsSnapshot is empty when nothing is looping", () => {
  expect(buildLoopsSnapshot(empty)).toEqual([]);
});

test("a disabled schedule contributes no row", () => {
  const rows = buildLoopsSnapshot({ ...empty, schedule: { enabled: false, timeOfDay: "02:00", running: false, autoStart: false } });
  expect(rows).toEqual([]);
});

test("an enabled schedule is an armed heartbeat with its next fire", () => {
  const rows = buildLoopsSnapshot({
    ...empty,
    schedule: { enabled: true, timeOfDay: "02:00", running: false, autoStart: true, nextRunAt: "2026-07-31T02:00:00.000Z" },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "schedule", status: "armed", nextFireAt: "2026-07-31T02:00:00.000Z" });
  expect(rows[0]!.stopCondition).toMatch(/auto-start/i);
});

test("a running schedule reports running", () => {
  const rows = buildLoopsSnapshot({ ...empty, schedule: { enabled: true, timeOfDay: "02:00", running: true, autoStart: false } });
  expect(rows[0]!.status).toBe("running");
  expect(rows[0]!.stopCondition).toMatch(/review/i);
});

test("a goal loop carries its condition, live iteration count, and last blocker", () => {
  const rows = buildLoopsSnapshot({
    ...empty,
    goals: [{ sessionId: "s1", title: "Fix flaky test", condition: "the suite passes 10x", iterations: 3, lastReason: "2 tests still red" }],
  });
  expect(rows[0]).toMatchObject({
    kind: "goal",
    sessionId: "s1",
    status: "running",
    stopCondition: "the suite passes 10x",
    detail: "2 tests still red",
    iteration: { current: 3, max: GOAL_MAX_ITERATIONS },
  });
});

test("a paused goal reads as armed (re-arms next turn)", () => {
  const rows = buildLoopsSnapshot({ ...empty, goals: [{ sessionId: "s1", title: "t", condition: "c", iterations: 0, paused: true }] });
  expect(rows[0]!.status).toBe("armed");
});

test("proposals are waiting-on-a-human loops keyed by their source", () => {
  const rows = buildLoopsSnapshot({ ...empty, proposals: [{ id: "wu1", title: "Fix build", source: "CI build #1421" }] });
  expect(rows[0]).toMatchObject({ kind: "trigger", status: "waiting", trigger: "CI build #1421", stopCondition: "Awaiting your approval" });
});

test("rows are ordered schedule → goals → pipelines → proposals (most-active first)", () => {
  const rows = buildLoopsSnapshot({
    schedule: { enabled: true, timeOfDay: "02:00", running: false, autoStart: false },
    goals: [{ sessionId: "s1", title: "g", condition: "c", iterations: 1 }],
    pipelines: [{ id: "wu1", title: "p", phaseReached: "verification" }],
    proposals: [{ id: "wu2", title: "pr", source: "GH #9" }],
  });
  expect(rows.map((r) => r.kind)).toEqual(["schedule", "goal", "pipeline", "trigger"]);
  expect(rows[2]!.detail).toBe("Phase: verification");
});
