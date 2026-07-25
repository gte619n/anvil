/**
 * End-to-end `/goal` wiring: the intercept sets state without consuming a turn, the Stop hook blocks
 * an unmet goal and increments, a met goal clears, and `/goal clear` removes it. This is the tier
 * that would have caught the failure found on 2026-07-25 — five `/goal` attempts that looked correct
 * and did nothing, because the command never reached anything that could act on it.
 */
import { test, expect, mock } from "bun:test";

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({ type: "sdk", name: "mock", instance: {} }),
  tool: (name: string, _d: unknown, _s: unknown, handler: unknown) => ({ name, handler }),
  query: () => ({
    async *[Symbol.asyncIterator]() {
      /* no turns — this test drives the hook directly */
    },
    interrupt: async () => {},
    setModel: async () => {},
    close: () => {},
  }),
}));

const { parseGoalCommand, makeStopHook, GOAL_MAX_ITERATIONS } = await import("../../src/agent/goal");

test("/goal set → unmet blocks and counts → met clears", async () => {
  const session = {
    data: { goal: undefined as any },
    recentTurns: ["assistant: ran tests", "tool ERROR: 3 failed"],
    recordTurnLine() {},
  } as any;

  // set
  const cmd = parseGoalCommand("/goal all tests pass");
  expect(cmd).toEqual({ kind: "set", condition: "all tests pass" });
  session.data.goal = { condition: "all tests pass", iterations: 0, setAt: "t" };

  // unmet → blocks, counts, and the model receives the CC-compatible reason format
  let verdict = { met: false, reason: "3 tests still failing" };
  const resolved: boolean[] = [];
  const hook = makeStopHook(session, () => ({}), (met) => resolved.push(met), async () => verdict);

  const blocked = (await hook({} as any, undefined, {} as any)) as any;
  expect(blocked).toEqual({ decision: "block", reason: "[all tests pass]: 3 tests still failing" });
  expect(session.data.goal.iterations).toBe(1);

  // met → clears, reports once
  verdict = { met: true, reason: "" };
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
  expect(session.data.goal).toBeUndefined();
  expect(resolved).toEqual([true]);
});

test("/goal clear parses and the ceiling is shared with the protocol", () => {
  expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
  expect(GOAL_MAX_ITERATIONS).toBe(10);
});
