/**
 * [B3] The goal's deterministic half (agent-cad-and-browser §4.11): an autopilot builder's CAD verify
 * runs in the Stop hook BEFORE the judge and overrides it — a verify that does not pass ends the goal
 * UNMET with its reason, whatever the judge would say; a pass (or no precheck) leaves the judge in
 * charge, exactly as before.
 */
import { expect, test } from "bun:test";
import { makeStopHook } from "../../src/agent/goal";

function session() {
  return { data: { goal: { condition: "the plan is built", iterations: 0, setAt: "t" } as any }, recentTurns: ["assistant: done"] } as any;
}

test("[B3] a failing precheck ends the goal unmet with its reason, and the judge is never asked", async () => {
  const s = session();
  const resolved: any[] = [];
  let judged = 0;
  const hook = makeStopHook(s, () => ({}), (met, g, unmet) => void resolved.push({ met, condition: g.condition, unmet }), async () => (judged++, { met: true, reason: "" }), () => {}, async () => ({ met: false, reason: "CAD verify: cad/plate is fail" }));
  expect(await hook({} as any, undefined, {} as any)).toEqual({ continue: true });
  expect(judged).toBe(0);
  expect(resolved).toEqual([{ met: false, condition: "the plan is built", unmet: "CAD verify: cad/plate is fail" }]);
  expect(s.data.goal).toBeUndefined();
});

test("[B3] a passing precheck lets the judge decide; a throwing precheck fails closed (unmet)", async () => {
  const s = session();
  const resolved: any[] = [];
  const blocked = makeStopHook(s, () => ({}), (met) => void resolved.push(met), async () => ({ met: false, reason: "tests fail" }), () => {}, async () => undefined);
  expect(await blocked({} as any, undefined, {} as any)).toEqual({ decision: "block", reason: "[the plan is built]: tests fail" });
  expect(s.data.goal.iterations).toBe(1);
  const s2 = session();
  const r2: any[] = [];
  const throwing = makeStopHook(s2, () => ({}), (met, _g, unmet) => void r2.push({ met, unmet }), async () => ({ met: true, reason: "" }), () => {}, async () => {
    throw new Error("boom");
  });
  await throwing({} as any, undefined, {} as any);
  expect(r2).toEqual([{ met: false, unmet: "the precheck failed: boom" }]);
  // Without a precheck the hook is unchanged: no goal → continue, no judge.
  const s3 = { data: {}, recentTurns: [] } as any;
  expect(await makeStopHook(s3, () => ({}), () => {}, async () => ({ met: true, reason: "" }))({} as any, undefined, {} as any)).toEqual({ continue: true });
});
