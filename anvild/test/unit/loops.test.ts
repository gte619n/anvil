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

test("a paused goal reads as paused (no runner on the circuit)", () => {
  const rows = buildLoopsSnapshot({ ...empty, goals: [{ sessionId: "s1", title: "t", condition: "c", iterations: 0, paused: true }] });
  expect(rows[0]!.status).toBe("paused");
  expect(rows[0]!.runnerAt).toBeUndefined();
});

test("proposals sit at your gate keyed by their source", () => {
  const rows = buildLoopsSnapshot({ ...empty, proposals: [{ id: "wu1", title: "Fix build", source: "CI build #1421" }] });
  expect(rows[0]).toMatchObject({ kind: "trigger", status: "gated", runnerAt: "gate", rung: "suggest", trigger: "CI build #1421", stopCondition: "Awaiting your approval" });
});

test("work-unit drafts render as gated draft rows in the drafts section", () => {
  const rows = buildLoopsSnapshot({
    ...empty,
    drafts: [
      { id: "wu1", title: "Add export", status: "planned", source: "Todoist" },
      { id: "wu2", title: "Unclear ask", status: "needs-clarification" },
    ],
  });
  expect(rows.map((r) => r.kind)).toEqual(["draft", "draft"]);
  expect(rows[0]).toMatchObject({ kind: "draft", status: "gated", runnerAt: "gate" });
  expect(rows[1]!.act).toMatch(/open questions/i);
});

test("circuit fields: schedule is a suggest-rung heartbeat; a live goal laps at Check", () => {
  const rows = buildLoopsSnapshot({
    ...empty,
    schedule: { enabled: true, timeOfDay: "02:00", running: false, autoStart: true },
    goals: [{ sessionId: "s1", title: "g", condition: "c", iterations: 2 }],
  });
  expect(rows[0]).toMatchObject({ kind: "schedule", rung: "suggest", act: expect.any(String) });
  expect(rows[0]!.runnerAt).toBeUndefined(); // armed → no runner
  expect(rows[1]).toMatchObject({ kind: "goal", rung: "pr", runnerAt: "check" });
});

test("excludeSessionIds drops goal rows owned by a live LoopRun (no double-vision)", () => {
  const rows = buildLoopsSnapshot({
    ...empty,
    goals: [
      { sessionId: "s1", title: "owned by a loop", condition: "c", iterations: 1 },
      { sessionId: "s2", title: "free goal", condition: "c", iterations: 1 },
    ],
    excludeSessionIds: ["s1"],
  });
  expect(rows.map((r) => r.id)).toEqual(["s2"]);
});

test("environment id/name flow through to rows for grouping", () => {
  const rows = buildLoopsSnapshot({
    ...empty,
    goals: [{ sessionId: "s1", title: "g", condition: "c", iterations: 0, environmentId: "env_1", environmentName: "anvil-web" }],
  });
  expect(rows[0]).toMatchObject({ environmentId: "env_1", environmentName: "anvil-web" });
});

test("rows are ordered schedule → goals → pipelines → proposals → drafts (most-active first)", () => {
  const rows = buildLoopsSnapshot({
    schedule: { enabled: true, timeOfDay: "02:00", running: false, autoStart: false },
    goals: [{ sessionId: "s1", title: "g", condition: "c", iterations: 1 }],
    pipelines: [{ id: "wu1", title: "p", phaseReached: "verification" }],
    proposals: [{ id: "wu2", title: "pr", source: "GH #9" }],
    drafts: [{ id: "wu3", title: "d", status: "planned" }],
  });
  expect(rows.map((r) => r.kind)).toEqual(["schedule", "goal", "pipeline", "trigger", "draft"]);
  expect(rows[2]!.detail).toBe("Phase: verification");
});
