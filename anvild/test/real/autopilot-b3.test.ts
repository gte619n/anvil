/**
 * [B3] Real-tool suite for Phase B3, autopilot CAD (agent-cad-and-browser spec §4.11, §8.3) with the
 * REAL `solidcraft-cli`. No Claude API call is made: the builder's tool calls are driven directly
 * through the real `anvil_cad` server, as an agent would make them, and its turn end and goal go through
 * the real verify hook and Stop hook. An approved plan → startPlan → the builder builds the reference
 * plate → turn end → `cadVerified`; a second run where the builder changes L → blocked "moved".
 * Skipped unless `ANVIL_REAL_TOOLS=1` (`bun test/tools/phase-gate.ts B3 --require-real`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeStopHook } from "../../src/agent/goal";
import { MOVED_WITHOUT_APPROVAL } from "../../src/cadwork/gate";
import { cleanupTemp, stopServices } from "../helpers/cad-work";
import { PLATE_PLAN, b3Rig, builderBuildsPlate, cadUnit } from "../helpers/autopilot-b3";
import { REAL, SOLIDCRAFT_CLI, hasSolidcraft } from "../helpers/real-tools";

afterEach(async () => {
  await stopServices();
  cleanupTemp();
});

async function goal(x: { svc: any; sessions: Map<string, any> }, sid: string) {
  const s = x.sessions.get(sid)!;
  s.data.goal = { condition: "the plate is built", iterations: 0, setAt: "t" };
  s.recentTurns = [];
  const resolved: { met: boolean; unmet?: string }[] = [];
  const hook = makeStopHook(s, () => ({}), (met, _g, unmet) => void resolved.push({ met, ...(unmet ? { unmet } : {}) }), async () => ({ met: true, reason: "" }), () => {}, () => x.svc.builderGoalCheck(sid));
  await hook({} as any, undefined, {} as any);
  return resolved;
}

describe("real SolidCraft: autopilot CAD", () => {
  test.skipIf(!REAL)("[B3] real: an approved plan → startPlan → the builder builds the reference plate → turn end → cadVerified; a second run where the builder changes L is blocked 'moved'; wall times recorded", async () => {
    expect(hasSolidcraft()).toBe(true); // a missing binary is a FAILURE in a real run, never a skip
    const approved = { ...PLATE_PLAN, approvedAt: new Date().toISOString() };
    let uid = "";
    let uid2 = "";
    const x = await b3Rig({
      cli: SOLIDCRAFT_CLI,
      units: (seed, env) => {
        uid = cadUnit(seed, env, "plate", { needsCad: true, cadExpectations: { plate: approved }, cadExpectationsStatus: "approved" }).id;
        uid2 = cadUnit(seed, env, "plate again", { needsCad: true, cadExpectations: { plate: approved }, cadExpectationsStatus: "approved" }).id;
      },
    });

    // Run 1.
    const t0 = performance.now();
    const ev = await x.svc.startPlan(uid);
    const startMs = performance.now() - t0;
    const first = x.firstTurns[0]!;
    expect(first.role).toBe("builder");
    expect(first.partJson.expectations.lockedBy).toBe("planner");
    expect(first.lock!.approvedBy).toBe("planner");
    expect((first.lock!.values as any).volume).toBeCloseTo(23335.167, 1);
    const t1 = performance.now();
    await builderBuildsPlate(x.tools(ev.sessionId));
    const buildMs = performance.now() - t1;
    const t2 = performance.now();
    const j = await x.svc.verifyBuilder(ev.sessionId, "turn");
    const verifyMs = performance.now() - t2;
    expect(j).toMatchObject({ ok: true, parts: ["plate"] });
    expect(x.unit(uid).status).toBe("building");
    expect(x.unit(uid).cadVerified!.parts).toEqual(["plate"]);
    expect(await goal(x, ev.sessionId)).toEqual([{ met: true }]); // the verify passes; the judge decides

    // Run 2 cannot start while run 1's builder is live on the same part (decision 183); once it is done, it can.
    await expect(x.svc.startPlan(uid2)).rejects.toThrow("cad/plate is being built by “plate” — finish, dismiss or archive that session first");
    (x.sessions.get(ev.sessionId)!.data as any).archived = true;
    // Run 1's builder wrote the part's approval after run 2's numbers were approved: run 2 is re-approved
    // over it on its card first (an approval is compared by identity, never by clock).
    await expect(x.svc.startPlan(uid2)).rejects.toThrow("changed after this plan was approved");
    x.svc.respondCad(uid2, true, x.plan(uid2).cad!.sha);
    // Run 2: a builder that moves L.
    const ev2 = await x.svc.startPlan(uid2);
    const t = x.tools(ev2.sessionId);
    await builderBuildsPlate(t);
    const moved = await t.set_parameter!({ name: "L", expression: "120 mm" });
    expect(moved.isError).toBeFalsy();
    const j2 = await x.svc.verifyBuilder(ev2.sessionId, "turn");
    expect(j2!.ok).toBe(false);
    const u2 = x.unit(uid2);
    expect(u2.status).toBe("blocked");
    expect(u2.blockedReason).toContain(MOVED_WITHOUT_APPROVAL);
    expect(u2.blockedReason).toContain("L 80 → 120");
    const g2 = await goal(x, ev2.sessionId);
    expect(g2[0]!.met).toBe(false);
    expect(g2[0]!.unmet).toContain(MOVED_WITHOUT_APPROVAL);
    // Run 1 is unaffected.
    expect(x.unit(uid).status).toBe("building");

    console.log(`[B3 real] startPlan (worktree + apply) ${startMs.toFixed(0)} ms; builder build ${buildMs.toFixed(0)} ms; turn-end verify ${verifyMs.toFixed(0)} ms (recorded, not asserted)`);
  }, 300_000);
});
