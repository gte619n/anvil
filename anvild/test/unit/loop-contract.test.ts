import { test, expect } from "bun:test";
import { completeLoop, defaultTokenBudget, checkLocks, SESSION_TOKEN_BUDGET, PIPELINE_TOKEN_BUDGET, DEFAULT_MAX_LAPS, DEFAULT_NO_PROGRESS_LAPS } from "../../src/loops/contract";
import type { LoopInput } from "../../protocol";

const opts = { now: "2026-08-11T00:00:00.000Z", genId: () => "loop_1" };
const base: LoopInput = {
  name: "Fix flaky test",
  trigger: { kind: "manual" },
  act: { kind: "session-prompt", prompt: "fix it" },
  checks: [{ kind: "command", command: "bun test" }],
};

test("defaults: checksMode all, rung pr, maxLaps 10, noProgressLaps 2, session token budget", () => {
  const { loop, warnings } = completeLoop(base, opts);
  expect(loop.checksMode).toBe("all");
  expect(loop.rung).toBe("pr");
  expect(loop.hardStops.maxLaps).toBe(DEFAULT_MAX_LAPS);
  expect(loop.hardStops.noProgressLaps).toBe(DEFAULT_NO_PROGRESS_LAPS);
  expect(loop.hardStops.tokenBudget).toBe(SESSION_TOKEN_BUDGET);
  expect(loop.status).toBe("draft");
  expect(loop.configRevision).toBe(1);
  expect(warnings).toEqual([]);
});

test("token budget is ALWAYS present (mandatory-budget guarantee) and defaults by act body", () => {
  expect(defaultTokenBudget({ kind: "session-prompt", prompt: "x" })).toBe(SESSION_TOKEN_BUDGET);
  expect(defaultTokenBudget({ kind: "skill-check", command: "x" })).toBe(SESSION_TOKEN_BUDGET);
  expect(defaultTokenBudget({ kind: "pipeline" })).toBe(PIPELINE_TOKEN_BUDGET);
  const pipe = completeLoop({ ...base, act: { kind: "pipeline" } }, opts);
  expect(pipe.loop.hardStops.tokenBudget).toBe(PIPELINE_TOKEN_BUDGET);
});

test("act: autopilot is rejected on user loops, allowed for the singleton", () => {
  expect(() => completeLoop({ ...base, act: { kind: "autopilot" } }, opts)).toThrow(/reserved/);
  const ok = completeLoop({ ...base, act: { kind: "autopilot" } }, { ...opts, allowAutopilotAct: true });
  expect(ok.loop.act.kind).toBe("autopilot");
});

test("zero checks and 'any' mode warn (not reject)", () => {
  const noChecks = completeLoop({ ...base, checks: [] }, opts);
  expect(noChecks.warnings[0]).toMatch(/no checks/i);
  const anyMode = completeLoop({ ...base, checks: [{ kind: "command", command: "a" }, { kind: "command", command: "b" }], checksMode: "any" }, opts);
  expect(anyMode.warnings.some((w) => /any/i.test(w))).toBe(true);
});

test("fatal validations: blank name, missing prompt/command", () => {
  expect(() => completeLoop({ ...base, name: "  " }, opts)).toThrow(/name/);
  expect(() => completeLoop({ ...base, act: { kind: "session-prompt", prompt: "" } }, opts)).toThrow(/prompt/);
  expect(() => completeLoop({ ...base, act: { kind: "skill-check", command: "" } }, opts)).toThrow(/command/);
});

test("update path preserves createdAt/cleanGatedLaps/workUnitId and bumps configRevision", () => {
  const first = completeLoop(base, opts).loop;
  const existing = { ...first, cleanGatedLaps: 3, workUnitId: "wu9", configRevision: 4, createdAt: "2026-01-01T00:00:00.000Z" };
  const { loop } = completeLoop({ ...base, id: first.id, name: "Renamed" }, { now: "2026-08-12T00:00:00.000Z", genId: () => "nope", existing });
  expect(loop.id).toBe(first.id);
  expect(loop.name).toBe("Renamed");
  expect(loop.cleanGatedLaps).toBe(3);
  expect(loop.workUnitId).toBe("wu9");
  expect(loop.configRevision).toBe(5); // bumped
  expect(loop.createdAt).toBe("2026-01-01T00:00:00.000Z");
  expect(loop.updatedAt).toBe("2026-08-12T00:00:00.000Z");
});

test("checkLocks is the union of every check's locks", () => {
  expect(checkLocks([{ kind: "command", command: "a", locks: ["x", "y"] }, { kind: "command", command: "b", locks: ["y", "z"] }])).toEqual(["x", "y", "z"]);
  expect(checkLocks([{ kind: "judge", condition: "c" }])).toEqual([]);
});
