import { test, expect } from "bun:test";
import { GOAL_MAX_ITERATIONS, makeStopHook, parseGoalCommand, parseVerdict } from "../../src/agent/goal";
import type { SessionGoal } from "@protocol";

function fakeSession(goal?: SessionGoal) {
  return {
    data: { goal },
    recentTurns: ["assistant: ran the tests", "tool: 3 failed"],
    recordTurnLine() {},
  } as any;
}
const noEnv = () => ({});

test("parseGoalCommand recognises set, clear, and status", () => {
  expect(parseGoalCommand("/goal all tests pass")).toEqual({ kind: "set", condition: "all tests pass" });
  expect(parseGoalCommand("  /goal   all tests pass  ")).toEqual({ kind: "set", condition: "all tests pass" });
  expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
  expect(parseGoalCommand("/goal")).toEqual({ kind: "status" });
});

test("parseGoalCommand ignores anything that is not the whole message", () => {
  // Matches Claude Code's slash-command rule and the existing /clear + /compact intercepts.
  expect(parseGoalCommand("please run /goal all tests pass")).toBeUndefined();
  expect(parseGoalCommand("/goalpost is unrelated")).toBeUndefined();
  expect(parseGoalCommand("/goals all tests pass")).toBeUndefined();
  expect(parseGoalCommand("")).toBeUndefined();
});

test("parseVerdict reads the judge's reply", () => {
  expect(parseVerdict("MET")).toEqual({ met: true, reason: "" });
  expect(parseVerdict("  met  ")).toEqual({ met: true, reason: "" });
  expect(parseVerdict("UNMET: 3 tests still failing")).toEqual({ met: false, reason: "3 tests still failing" });
  expect(parseVerdict("unmet: no evidence the file was created")).toEqual({
    met: false,
    reason: "no evidence the file was created",
  });
});

test("parseVerdict throws on an unparseable reply so the hook fails open (D6)", () => {
  expect(() => parseVerdict("I think maybe?")).toThrow();
  expect(() => parseVerdict("")).toThrow();
});

test("stop hook is a no-op with no goal, and never calls the judge", async () => {
  let judged = 0;
  const s = fakeSession(undefined);
  const hook = makeStopHook(s, noEnv, () => {}, async () => {
    judged++;
    return { met: false, reason: "x" };
  });
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
  expect(judged).toBe(0); // guards the "free for every non-goal session" invariant
});

test("stop hook is a no-op while the goal is paused", async () => {
  const s = fakeSession({ condition: "c", iterations: 0, paused: true, setAt: "t" });
  const hook = makeStopHook(s, noEnv, () => {}, async () => ({ met: false, reason: "x" }));
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
});

test("unmet blocks the stop, increments, and records the blocker", async () => {
  const s = fakeSession({ condition: "all tests pass", iterations: 0, setAt: "t" });
  const hook = makeStopHook(s, noEnv, () => {}, async () => ({ met: false, reason: "3 tests still failing" }));
  const out = (await hook({} as any, undefined, {} as any)) as any;
  expect(out.decision).toBe("block");
  expect(out.reason).toBe("[all tests pass]: 3 tests still failing");
  expect(s.data.goal.iterations).toBe(1);
  expect(s.data.goal.lastReason).toBe("3 tests still failing");
});

test("met clears the goal and reports resolved(met=true) once", async () => {
  const s = fakeSession({ condition: "c", iterations: 2, setAt: "t" });
  const seen: boolean[] = [];
  const hook = makeStopHook(s, noEnv, (met) => seen.push(met), async () => ({ met: true, reason: "" }));
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
  expect(s.data.goal).toBeUndefined();
  expect(seen).toEqual([true]);
});

test("at the ceiling the goal clears WITHOUT calling the judge", async () => {
  let judged = 0;
  const s = fakeSession({ condition: "c", iterations: GOAL_MAX_ITERATIONS, lastReason: "still red", setAt: "t" });
  const seen: boolean[] = [];
  const hook = makeStopHook(s, noEnv, (met) => seen.push(met), async () => {
    judged++;
    return { met: false, reason: "x" };
  });
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
  expect(s.data.goal).toBeUndefined();
  expect(seen).toEqual([false]);
  expect(judged).toBe(0);
});

test("a judge failure fails open and does NOT consume an iteration (D6)", async () => {
  const s = fakeSession({ condition: "c", iterations: 4, setAt: "t" });
  const hook = makeStopHook(s, noEnv, () => {}, async () => {
    throw new Error("haiku unreachable");
  });
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
  expect(s.data.goal.iterations).toBe(4); // unchanged
  expect(s.data.goal).toBeDefined(); // still armed
});
