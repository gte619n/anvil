/**
 * [B3] Functional scenario for Phase B3, autopilot CAD (agent-cad-and-browser spec §4.11, §4.14 item
 * 41, §5 "Phase B3"). The REAL AutopilotService over the REAL CadworkService, lock store, permission
 * hook, git repos and worktrees; a fake handoff that does what the Supervisor's does; SolidCraft is the
 * fake. One test per Acceptance bullet, then item 41, the planner's `save_cad_expectations` and the
 * builder restrictions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeStopHook } from "../../src/agent/goal";
import { cadToolId } from "../../src/agent/cad-tool-ids";
import { MOVED_WITHOUT_APPROVAL } from "../../src/cadwork/gate";
import { planExpectationsSha } from "../../src/cadwork/plan-expectations";
import { OPENROUTER_KEY } from "../../src/auth/openrouter";
import { autoStartDecision } from "../../src/integrations/autostart-gate";
import { cadFieldsFromMeta } from "../../src/integrations/autopilot-cad";
import { extractPlanMeta } from "../../src/integrations/plan-meta";
import { planningTools } from "../../src/agent/planning-tools";
import type { AgentFn } from "../../src/pipeline/phases";
import { BOX, PLATE_EXPECTATIONS, cleanupTemp, stopServices, writeDesign } from "../helpers/cad-work";
import { git } from "../helpers/cad-verify";
import { PLATE_PLAN, b3Rig, builderBuildsPlate, cadUnit } from "../helpers/autopilot-b3";
import { FAKE_SOLIDCRAFT, REFERENCE_PLATE } from "../helpers/fake-solidcraft";

const saved = process.env.ANVIL_SOLIDCRAFT_CLI;
beforeAll(() => void (process.env.ANVIL_SOLIDCRAFT_CLI = FAKE_SOLIDCRAFT));
afterAll(() => {
  if (saved === undefined) delete process.env.ANVIL_SOLIDCRAFT_CLI;
  else process.env.ANVIL_SOLIDCRAFT_CLI = saved;
});
afterEach(async () => {
  await stopServices();
  cleanupTemp();
});

const approved = { ...PLATE_PLAN, approvedAt: "2026-11-20T00:00:00.000Z" };
/** A rig with one unit whose plan carries APPROVED numbers for cad/plate. */
async function approvedPlateRig() {
  let uid = "";
  const x = await b3Rig({ cli: FAKE_SOLIDCRAFT, units: (seed, env) => void (uid = cadUnit(seed, env, "plate", { needsCad: true, cadExpectations: { plate: approved }, cadExpectationsStatus: "approved", cadExpectationsSource: "planner" }).id) });
  return { ...x, uid };
}
/** startPlan, then the builder's tools and session id. */
async function started(x: Awaited<ReturnType<typeof approvedPlateRig>>) {
  const ev = await x.svc.startPlan(x.uid);
  return { sid: ev.sessionId, t: x.tools(ev.sessionId), cwd: x.firstTurns.at(-1)!.cwd };
}
/** The Stop hook a builder session runs, with a judge that would say MET (the verify must override it). */
async function goalOutcome(x: { svc: any; sessions: Map<string, any> }, sid: string) {
  const s = x.sessions.get(sid)!;
  s.data.goal = { condition: "the plan is built", iterations: 0, setAt: "t" };
  s.recentTurns = ["assistant: the plate is done"];
  const resolved: { met: boolean; unmet?: string }[] = [];
  let judged = 0;
  const hook = makeStopHook(s, () => ({}), (met, _g, unmet) => void resolved.push({ met, ...(unmet ? { unmet } : {}) }), async () => (judged++, { met: true, reason: "" }), () => {}, () => x.svc.builderGoalCheck(sid));
  const out = await hook({} as any, undefined, {} as any);
  return { out, resolved, judged, goal: s.data.goal };
}

describe("Phase B3 acceptance", () => {
  test("[B3] acceptance 1: startPlan on a unit with cadExpectations.plate — the new session carries workUnitRole builder, and the worktree's cad/plate/part.json and the lock store hold the plan's expectations (approvedBy planner) before the first turn", async () => {
    const x = await approvedPlateRig();
    const ev = await x.svc.startPlan(x.uid);
    expect(x.handoffs[0]).toMatchObject({ workUnitRole: "builder", workUnitId: x.uid, autonomy: "bypass" });
    const first = x.firstTurns[0]!;
    expect(first.sessionId).toBe(ev.sessionId);
    expect(first.role).toBe("builder");
    expect(first.workUnitId).toBe(x.uid);
    // part.json, at the moment the first turn began: the plan's process and numbers, locked by the planner.
    expect(first.partJson).toMatchObject({ schema: 1, process: "fdm-0.4", status: "dimensioned", expectations: { lockedBy: "planner", bbox: ["L", "W", "T"], volume: PLATE_EXPECTATIONS.volume, bodies: 1, holes: [{ diameter: 3.4, count: 4 }] } });
    // The lock store (fleet-synced): approvedBy planner, the evaluated numbers fixed from the declared values.
    expect(first.lock!.approvedBy).toBe("planner");
    expect(first.lock!.declared).toEqual({ L: 80, W: 50, T: 6 });
    expect((first.lock!.values as any).bbox).toEqual([6, 50, 80]);
    expect((first.lock!.values as any).volume).toBeCloseTo(23335.167, 2);
    // The declared parameters exist in the design before the builder does anything.
    const added = first.design.commands.filter((c: any) => c.command === "parameters.add").map((c: any) => [c.params.name, c.params.expression]);
    expect(Object.fromEntries(added)).toEqual({ L: "80 mm", W: "50 mm", T: "6 mm" });
    // The unit is building, with the base the verify hook diffs against.
    expect(x.unit(x.uid)).toMatchObject({ status: "building", sessionId: ev.sessionId, cadBase: git(x.repo, "rev-parse", "HEAD") });
    // And the builder may not record them again.
    const t = x.tools(ev.sessionId);
    await t.open_part!({ part: "plate" });
    const rec = await t.record_expectations!({ part: "plate", process: "fdm-0.4", parameters: { L: "80 mm", W: "50 mm", T: "6 mm" }, expectations: PLATE_EXPECTATIONS });
    expect(rec.isError).toBe(true);
    expect(rec.text).toContain("come from this work unit's approved plan");
  });

  test("[B3] acceptance 2: the builder builds a passing part — at turn end the unit has cadVerified and is not blocked", async () => {
    const x = await approvedPlateRig();
    const { sid, t } = await started(x);
    await builderBuildsPlate(t);
    const j = await x.svc.verifyBuilder(sid, "turn");
    expect(j).toMatchObject({ ok: true, parts: ["plate"] });
    const u = x.unit(x.uid);
    expect(u.status).toBe("building");
    expect(u.cadVerified!.parts).toEqual(["plate"]);
    expect(u.cadBlocked).toBeUndefined();
    // On its card: the verified badge.
    expect(x.plan(x.uid).cad?.verified?.parts).toEqual(["plate"]);
    expect(x.svc.autopilotPlansEvent().plans.map((p) => p.id)).toContain(x.uid);
    // At goal resolution the verify passes too, so the judge decides (and says met).
    const g = await goalOutcome(x, sid);
    expect(g.judged).toBe(1);
    expect(g.resolved).toEqual([{ met: true }]);
  });

  test("[B3] acceptance 3a: the builder's part fails the gate — the unit is blocked with the failing checks and the goal reports unmet (overriding the judge)", async () => {
    const x = await approvedPlateRig();
    const { sid, t } = await started(x);
    await t.open_part!({ part: "plate" });
    await t.batch!({ commands: (await import("../helpers/cad-work")).plateBuild(REFERENCE_PLATE).slice(0, -1) }); // no hole pattern: 1 hole, not 4
    const g = await goalOutcome(x, sid);
    expect(g.judged).toBe(0); // the deterministic verify decided; the judge (which would say MET) never ran
    expect(g.resolved.length).toBe(1);
    expect(g.resolved[0]!.met).toBe(false);
    expect(g.resolved[0]!.unmet).toContain("cad/plate is fail");
    expect(g.goal).toBeUndefined();
    expect(g.out).toEqual({ continue: true });
    const u = x.unit(x.uid);
    expect(u.status).toBe("blocked");
    expect(u.blockedReason).toStartWith("CAD: cad/plate is fail");
    expect(u.blockedReason).toContain("holes");
    expect(u.cadVerified).toBeUndefined();
    expect(x.plan(x.uid).cad?.blocked?.reason).toContain("cad/plate is fail");
    // The turn-end verify says the same.
    expect((await x.svc.verifyBuilder(sid, "turn"))!.ok).toBe(false);
  });

  test("[B3] acceptance 3b: the builder calls report_gap — the unit is blocked on the gap and the goal reports unmet", async () => {
    const x = await approvedPlateRig();
    const { sid, t } = await started(x);
    await builderBuildsPlate(t);
    const gap = await t.report_gap!({ part: "plate", feature: "knurling", detail: "SolidCraft has no knurl feature" });
    expect(gap.isError).toBeFalsy(); // report_gap is allowed: it can only block
    const j = await x.svc.verifyBuilder(sid, "turn");
    expect(j!.ok).toBe(false);
    expect(x.unit(x.uid).status).toBe("blocked");
    expect(x.unit(x.uid).blockedReason).toContain("cad/plate reported a capability gap");
    const g = await goalOutcome(x, sid);
    expect(g.resolved[0]).toMatchObject({ met: false });
    expect(g.resolved[0]!.unmet).toContain("capability gap");
  });

  test("[B3] acceptance 3c: the builder touches a part the plan did not cover — open_part refuses it, and a part made another way blocks the unit and the goal reports unmet", async () => {
    const x = await approvedPlateRig();
    const { sid, t, cwd } = await started(x);
    await builderBuildsPlate(t);
    const refused = await t.open_part!({ part: "bracket" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("not covered by this work unit's plan");
    expect(existsSync(join(cwd, "cad", "bracket"))).toBe(false); // refused before the folder was made
    // The agent writes a part with its shell instead.
    writeDesign(cwd, "bracket", [BOX("Bracket", 12)]);
    const j = await x.svc.verifyBuilder(sid, "turn");
    expect(j!.ok).toBe(false);
    expect(x.unit(x.uid).status).toBe("blocked");
    expect(x.unit(x.uid).blockedReason).toContain("cad/bracket was touched but the plan has no approved dimensions");
    const g = await goalOutcome(x, sid);
    expect(g.resolved[0]!.met).toBe(false);
    expect(g.resolved[0]!.unmet).toContain("cad/bracket");
  });

  test("[B3] acceptance 4: in a builder session, propose_expectations, request_dimensions and an Edit to cad/rules.json are denied and no card is emitted", async () => {
    const x = await approvedPlateRig();
    const { sid, t, cwd } = await started(x);
    const before = x.openCards().length;
    for (const [tool, input] of [
      [cadToolId("propose_expectations"), { part: "plate", expectations: PLATE_EXPECTATIONS, reason: "looser" }],
      [cadToolId("request_dimensions"), { part: "plate", proposed: [{ name: "L", value: 90 }] }],
      [cadToolId("release_part"), { part: "plate" }],
      ["Edit", { file_path: join(cwd, "cad", "rules.json"), old_string: "250", new_string: "999" }],
      ["Write", { file_path: join(cwd, "cad", "rules.json"), content: "{}" }],
    ] as const) {
      const r = await x.gate(sid, tool, input as Record<string, unknown>);
      expect(r.decision).toBe("deny");
      expect(r.asked).toEqual([]); // no permission card
    }
    // And behind the gate, the tools refuse without drawing their owner card.
    await t.open_part!({ part: "plate" });
    const p = await t.propose_expectations!({ part: "plate", expectations: PLATE_EXPECTATIONS, reason: "x" });
    expect(p.isError).toBe(true);
    expect(p.text).toContain("unattended");
    const imp = await t.import_reference!({ part: "plate", file: "README.md" });
    expect(imp.isError).toBe(true);
    expect(x.openCards().length).toBe(before); // no card of any kind
    expect(x.broadcasts.filter((e) => e.type === "cad.expectations.request")).toEqual([]);
  });

  test("[B3] acceptance 5: the dev pipeline with a diff touching cad/ and a failing design maps to blocked, and removing the repo's EnvironmentValidation does not change that", async () => {
    // A passing, planner-approved plate on main (built by a builder, then merged).
    const x = await approvedPlateRig();
    const { sid, t, cwd } = await started(x);
    await builderBuildsPlate(t);
    expect((await x.svc.verifyBuilder(sid, "turn"))!.ok).toBe(true);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "plate");
    git(x.repo, "merge", "-q", "--ff-only", "b3-1");
    // A second unit, no CAD in its plan, goes through the pipeline; its implementer breaks the plate.
    const seedId = (x.svc as any).workUnits.create({ environmentId: x.env.id, todoistProjectId: "p1", taskIds: [], title: "tidy the readme", plan: "Edit the README." }).id;
    const implement = (cwdOf: string) => {
      const dj = join(cwdOf, "cad", "plate", "design.json");
      const doc = JSON.parse(readFileSync(dj, "utf8"));
      doc.commands = doc.commands.slice(0, -1); // drops the hole pattern: 1 hole, not 4
      writeFileSync(dj, JSON.stringify(doc, null, 2) + "\n");
      writeFileSync(join(cwdOf, "README.md"), "# b3, tidied\n");
    };
    const agent: AgentFn = async (prompt, o) => {
      if (prompt.includes("User Advocate at intake")) return { text: '{"classification":"well-formed","riskTier":"standard","reason":"clear"}' };
      if (prompt.includes("Requirements Engineer")) return { text: '{"criteria":[{"id":"AC1","text":"readme tidy","kind":"automatable"}],"nonGoals":[],"interfaceContract":"n/a"}' };
      if (prompt.includes("Auditor") || prompt.includes("Staff Engineer red-team")) return { text: '{"accept":true,"critical":false,"findings":[]}' };
      if (prompt.includes("Architect")) return { text: "# Plan\nEdit README." };
      if (prompt.includes("Implementer")) {
        implement(o.cwd!);
        return { text: "Implemented." };
      }
      if (prompt.includes("Test Adversary")) return { text: "No tests." };
      return { text: '{"satisfies":true,"critical":false,"gap":""}' };
    };
    let prs = 0;
    (x.svc as any).deps.devPipeline = { agent, openPr: () => async () => (prs++, "PR#1") };
    const key = process.env[OPENROUTER_KEY];
    process.env[OPENROUTER_KEY] = "test-key";
    try {
      // With the repo's validation configured (and passing).
      x.envStore.update(x.env.id, { validation: { commands: ["true"] } });
      const a = await x.svc.runDevPipeline(seedId, { onProgress: () => {} });
      expect(a.status).toBe("blocked");
      expect(a.reason).toStartWith("CAD verify failed: cad/plate is fail");
      expect(x.unit(seedId)).toMatchObject({ status: "blocked" });
      expect(x.unit(seedId).blockedReason).toContain("CAD verify failed");
      expect(x.unit(seedId).cadBlocked!.reason).toContain("holes");
      // Without any EnvironmentValidation: the same.
      x.envStore.update(x.env.id, { validation: null });
      expect(x.envStore.get(x.env.id)!.validation).toBeUndefined();
      const b = await x.svc.runDevPipeline(seedId, { onProgress: () => {} });
      expect(b.status).toBe("blocked");
      expect(b.reason).toStartWith("CAD verify failed: cad/plate is fail");
      expect(prs).toBe(0); // never shipped as review
    } finally {
      if (key === undefined) delete process.env[OPENROUTER_KEY];
      else process.env[OPENROUTER_KEY] = key;
    }
  });
});

describe("item 41: the nightly planner proposes, the owner approves", () => {
  const META = (cad: unknown) => `# Plan\nMake the plate.\n\n\`\`\`json\n${JSON.stringify({ summary: "plate", size: "s", filesTouched: 2, needsCad: true, cadExpectations: cad })}\n\`\`\``;
  /** A rig with one nightly unit whose fields come from the planner's metadata block, as autopilot.ts stores them. */
  async function nightlyRig(cad: unknown) {
    const meta = extractPlanMeta(META(cad));
    let uid = "";
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT, units: (seed, env) => void (uid = cadUnit(seed, env, "nightly plate", { plan: meta.plan, ...cadFieldsFromMeta(meta.cad) }).id) });
    return { ...x, uid, meta };
  }

  test("[B3] item 41: nightly-proposed numbers block start (Go and auto-start) until approved", async () => {
    const x = await nightlyRig({ plate: PLATE_PLAN });
    expect(x.unit(x.uid)).toMatchObject({ status: "planned", needsCad: true, cadExpectationsStatus: "proposed", cadExpectationsSource: "nightly" });
    await expect(x.svc.startPlan(x.uid)).rejects.toThrow("needs approved dimensions");
    expect(x.handoffs).toEqual([]); // nothing was created
    expect(autoStartDecision(x.unit(x.uid))).toMatchObject({ start: false, reason: expect.stringContaining("needs approved dimensions") });
    const card = x.plan(x.uid).cad!;
    expect(card).toMatchObject({ status: "proposed", needsApproval: true, source: "nightly" });
    expect(card.parts[0]!.part).toBe("plate");
    expect(card.parts[0]!.rows.find((r) => r.label === "Volume (mm³)")!.new).toContain("23335.167");
    // The pipeline path is refused outright: a CAD unit builds with Go only (decision 182).
    await expect(x.svc.runDevPipeline(x.uid)).rejects.toThrow("CAD units build with Go (the pipeline cannot model)");
  });

  test("[B3] item 41: Reject keeps the unit unable to start", async () => {
    const x = await nightlyRig({ plate: PLATE_PLAN });
    const sha = x.plan(x.uid).cad!.sha!;
    const r = x.svc.respondCad(x.uid, false, sha);
    expect(r.plan.cad).toMatchObject({ status: "rejected", needsApproval: true });
    expect(x.unit(x.uid).cadExpectationsStatus).toBe("rejected");
    await expect(x.svc.startPlan(x.uid)).rejects.toThrow("needs approved dimensions");
    expect(autoStartDecision(x.unit(x.uid)).start).toBe(false);
    expect(x.handoffs).toEqual([]);
  });

  test("[B3] item 41: approval on the card locks the numbers (approvedBy planner in the builder's worktree) and start then succeeds", async () => {
    const x = await nightlyRig({ plate: PLATE_PLAN });
    const sha = x.plan(x.uid).cad!.sha!;
    const r = x.svc.respondCad(x.uid, true, sha);
    expect(r.plan.cad).toMatchObject({ status: "approved", needsApproval: false });
    expect(x.unit(x.uid).cadExpectations!.plate!.approvedAt).toBeString();
    expect(autoStartDecision(x.unit(x.uid)).start).toBe(true);
    const ev = await x.svc.startPlan(x.uid);
    const first = x.firstTurns[0]!;
    expect(first.sessionId).toBe(ev.sessionId);
    expect(first.partJson.expectations.lockedBy).toBe("planner");
    expect(first.lock!.approvedBy).toBe("planner");
    expect(first.lock!.declared).toEqual({ L: 80, W: 50, T: 6 });
  });

  test("[B3] item 41: malformed proposals are ignored with a note, and the unit still cannot start", async () => {
    const x = await nightlyRig({
      plate: PLATE_PLAN,
      loose: { process: "fdm-0.4", parameters: {}, expectations: { bbox: [1, 2, 3], volume: 6, bodies: 1, holes: [], tolerance: { length: 5 } } },
      "Bad/Name": PLATE_PLAN,
      undeclared: { process: "fdm-0.4", parameters: {}, expectations: { bbox: ["L", 2, 3], volume: 6, bodies: 1, holes: [] } },
    });
    const u = x.unit(x.uid);
    expect(Object.keys(u.cadExpectations!)).toEqual(["plate"]); // only the valid one
    expect(u.cadNote).toContain("loose");
    expect(u.cadNote).toContain("looser than the cap");
    expect(u.cadNote).toContain("Bad/Name");
    expect(u.cadNote).toContain("undeclared");
    expect(x.plan(x.uid).cad!.note).toBe(u.cadNote);
    await expect(x.svc.startPlan(x.uid)).rejects.toThrow("needs approved dimensions");
    // Nothing valid at all: CAD is still needed, so the unit waits for a planning session.
    const y = await nightlyRig({ loose: { process: "", parameters: {}, expectations: {} } });
    expect(y.unit(y.uid).cadExpectations).toBeUndefined();
    expect(y.plan(y.uid).cad).toMatchObject({ status: "missing", needsApproval: true });
    await expect(y.svc.startPlan(y.uid)).rejects.toThrow("needs approved dimensions");
  });

  test("[B3] item 41: the approval card approves exactly what it showed — a proposal changed while the card is open is refused and the card redrawn", async () => {
    const x = await nightlyRig({ plate: PLATE_PLAN });
    const shown = x.plan(x.uid).cad!.sha!;
    // While the owner looks at the card, a re-plan changes the numbers.
    const changed = { plate: { ...PLATE_PLAN, parameters: { L: "120 mm", W: "50 mm", T: "6 mm" } } };
    x.svc.proposeCadExpectations(x.uid, cadFieldsFromMeta({ needsCad: true, expectations: changed }));
    const plansBefore = x.events.filter((e) => e.type === "autopilot.plans").length;
    expect(() => x.svc.respondCad(x.uid, true, shown)).toThrow("changed while the card was open");
    expect(x.unit(x.uid).cadExpectationsStatus).toBe("proposed"); // nothing approved
    expect(x.unit(x.uid).cadExpectations!.plate!.approvedAt).toBeUndefined();
    // Redrawn: a fresh plans broadcast carrying the new numbers and their sha.
    const redraw = x.events.filter((e) => e.type === "autopilot.plans").slice(plansBefore);
    expect(redraw.length).toBeGreaterThan(0);
    const card = redraw.at(-1).plans.find((p: any) => p.id === x.uid).cad;
    expect(card.sha).toBe(planExpectationsSha(changed as any));
    expect(card.sha).not.toBe(shown);
    expect(card.parts[0].rows.find((r: any) => r.label === "Parameters").new).toContain("L = 120 mm");
    // Approving what is now shown works.
    expect(x.svc.respondCad(x.uid, true, card.sha).plan.cad!.status).toBe("approved");
  });
});

describe("the planner's save_cad_expectations (interactive planning session)", () => {
  async function plannerRig() {
    let uid = "";
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT, units: (seed, env) => void (uid = cadUnit(seed, env, "planned plate", {}).id) });
    // An interactive planning session on the unit (what startPlanningSession creates).
    const ev = await x.svc.startPlanningSession(uid);
    const tools = new Map(planningTools({ sessionId: ev.sessionId, savePlan: () => "", runPipeline: () => "", saveCadExpectations: (i) => (x.svc as any).plannerSaveCad(ev.sessionId, i) }).map((d: any) => [d.name, d.handler]));
    return { ...x, uid, sid: ev.sessionId, save: (args: Record<string, unknown>) => tools.get("save_cad_expectations")!(args, {}) as Promise<any> };
  }
  const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

  test("[B3] save_cad_expectations always prompts with a typed card showing the numbers; approval sets the unit's cadExpectations approved, deny saves nothing", async () => {
    const x = await plannerRig();
    expect(x.handoffs[0]).toMatchObject({ workUnitRole: "planner" });
    // Deny.
    const denied = x.save({ part: "plate", ...PLATE_PLAN });
    await new Promise((r) => setTimeout(r, 10));
    let card = x.openCards()[0];
    expect(card).toMatchObject({ kind: "plan", sessionId: x.sid, part: "plate" });
    expect(card.rows.find((r: any) => r.label === "Volume (mm³)").new).toContain("23335.167");
    x.cad.respond(card.requestId, false);
    expect(text(await denied)).toContain("nothing was saved");
    expect(x.unit(x.uid).cadExpectations).toBeUndefined();
    // Approve.
    const ok = x.save({ part: "plate", ...PLATE_PLAN });
    await new Promise((r) => setTimeout(r, 10));
    card = x.openCards()[0];
    x.cad.respond(card.requestId, true);
    expect(text(await ok)).toContain("approved the numbers for cad/plate");
    expect(x.unit(x.uid)).toMatchObject({ cadExpectationsStatus: "approved", cadExpectationsSource: "planner", needsCad: true });
    expect(x.unit(x.uid).cadExpectations!.plate).toMatchObject({ process: "fdm-0.4", parameters: PLATE_PLAN.parameters });
    // Malformed: refused before any card.
    const bad = await x.save({ part: "plate", process: "fdm-0.4", parameters: {}, expectations: { ...PLATE_EXPECTATIONS } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("declared");
    expect(x.openCards()).toEqual([]);
  });

  test("[B3] the planner's card approves exactly what it showed: the unit's numbers changing while it is open refuses the approval and redraws the card", async () => {
    const x = await plannerRig();
    const pending = x.save({ part: "plate", ...PLATE_PLAN });
    await new Promise((r) => setTimeout(r, 10));
    const first = x.openCards()[0];
    // Meanwhile the unit's numbers for the part change (a nightly re-plan).
    x.svc.proposeCadExpectations(x.uid, cadFieldsFromMeta({ needsCad: true, expectations: { plate: { ...PLATE_PLAN, parameters: { L: "90 mm", W: "50 mm", T: "6 mm" } } } }));
    x.cad.respond(first.requestId, true);
    await new Promise((r) => setTimeout(r, 10));
    const resolved = x.broadcasts.find((e) => e.type === "cad.expectations.resolved" && e.requestId === first.requestId);
    expect(resolved).toMatchObject({ approved: false, superseded: true });
    expect(x.unit(x.uid).cadExpectations!.plate!.approvedAt).toBeUndefined(); // nothing approved
    const second = x.openCards()[0];
    expect(second.requestId).not.toBe(first.requestId);
    // Redrawn: "old" is what is APPROVED for cad/plate in the repo (decision 183) — nothing yet — never the
    // unit's earlier, unapproved proposal.
    expect(second.rows.find((r: any) => r.label === "Parameters").old).toBeUndefined();
    x.cad.respond(second.requestId, true);
    await pending;
    expect(x.unit(x.uid).cadExpectations!.plate!.parameters).toEqual(PLATE_PLAN.parameters);
    expect(x.unit(x.uid).cadExpectationsStatus).toBe("approved");
  });
});

describe("builder restrictions and the moved-number rule", () => {
  test("[B3] a builder that changes a planned parameter is blocked on 'moved without owner approval'", async () => {
    const x = await approvedPlateRig();
    const { sid, t } = await started(x);
    await builderBuildsPlate(t);
    expect((await x.svc.verifyBuilder(sid, "turn"))!.ok).toBe(true);
    await t.set_parameter!({ name: "L", expression: "120 mm" });
    const j = await x.svc.verifyBuilder(sid, "turn");
    expect(j!.ok).toBe(false);
    expect(x.unit(x.uid).blockedReason).toContain(MOVED_WITHOUT_APPROVAL);
    expect(x.unit(x.uid).cadVerified).toBeUndefined();
  });

  test("[B3] a unit whose plan touches CAD cannot start on a machine without cad-work, and a failed apply leaves no session", async () => {
    const x = await approvedPlateRig();
    (x.cad as any).deps.enabled = false;
    await expect(x.svc.startPlan(x.uid)).rejects.toThrow("cad-work");
    (x.cad as any).deps.enabled = true;
    // Bad numbers in the store (hand-edited): the apply refuses, the session is removed, the unit unchanged.
    (x.unit(x.uid).cadExpectations!.plate as any).expectations = { ...PLATE_EXPECTATIONS, tolerance: { length: 3 } };
    await expect(x.svc.startPlan(x.uid)).rejects.toThrow("could not apply the plan's numbers for cad/plate");
    expect(x.sessions.size).toBe(0);
    expect(x.unit(x.uid).status).toBe("planned");
  });
});
