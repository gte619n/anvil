/**
 * [B3] The fixes for the Phase B3 adversarial review (decision 181): the REAL AutopilotService over the
 * REAL CadworkService, lock store, permission rule, git repos and worktrees (the b3 rig); SolidCraft is
 * the fake. No model is called. One describe per review item.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cadProtectedRule } from "../../src/agent/cad-protected";
import { planningTools } from "../../src/agent/planning-tools";
import { OPENROUTER_KEY } from "../../src/auth/openrouter";
import { repoIdentity } from "../../src/cadwork/locks";
import { checkPlanPart, replaceNote } from "../../src/cadwork/plan-expectations";
import { CAD_BUILDS_WITH_GO } from "../../src/integrations/autopilot-cad";
import type { AgentFn } from "../../src/pipeline/phases";
import { builderBlockedNotice } from "../../src/session/autopilot-service";
import { git } from "../helpers/cad-verify";
import { cleanupTemp, plateBuild, stopServices } from "../helpers/cad-work";
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

const at = (iso = "2026-11-20T00:00:00.000Z") => iso;
const approved = (plan = PLATE_PLAN, when = at()) => ({ ...plan, approvedAt: when });
const L120 = { ...PLATE_PLAN, parameters: { L: "120 mm", W: "50 mm", T: "6 mm" } };
type Rig = Awaited<ReturnType<typeof b3Rig>>;
const create = (x: Rig, title: string, fields: Record<string, unknown>) => cadUnit((x.svc as any).workUnits, x.env.id, title, fields as any).id as string;
const approvedFields = (plan = PLATE_PLAN, when = at()) => ({ needsCad: true, cadExpectations: { plate: approved(plan, when) }, cadExpectationsStatus: "approved", cadExpectationsSource: "planner" });

/** The dev pipeline's model calls, faked: the implementer runs `implement` in the pipeline worktree. */
function fakeAgent(implement: (cwd: string) => void, calls: string[]): AgentFn {
  return async (prompt, o) => {
    calls.push(prompt.slice(0, 40));
    if (prompt.includes("User Advocate at intake")) return { text: '{"classification":"well-formed","riskTier":"standard","reason":"clear"}' };
    if (prompt.includes("Requirements Engineer")) return { text: '{"criteria":[{"id":"AC1","text":"done","kind":"automatable"}],"nonGoals":[],"interfaceContract":"n/a"}' };
    if (prompt.includes("Auditor") || prompt.includes("Staff Engineer red-team")) return { text: '{"accept":true,"critical":false,"findings":[]}' };
    if (prompt.includes("Architect")) return { text: "# Plan\nDo it." };
    if (prompt.includes("Implementer")) {
      implement(o.cwd!);
      return { text: "Implemented." };
    }
    if (prompt.includes("Test Adversary")) return { text: "No tests." };
    return { text: '{"satisfies":true,"critical":false,"gap":""}' };
  };
}
async function withKey<T>(fn: () => Promise<T>): Promise<T> {
  const key = process.env[OPENROUTER_KEY];
  process.env[OPENROUTER_KEY] = "test-key";
  try {
    return await fn();
  } finally {
    if (key === undefined) delete process.env[OPENROUTER_KEY];
    else process.env[OPENROUTER_KEY] = key;
  }
}

describe("review item 1: a CAD unit never goes through the dev pipeline", () => {
  test("[B3] review 1: the reviewer's repro — approved numbers for cad/plate, an implementer that edits only README.md — the Run pipeline entry point refuses it: nothing built, nothing shipped, no PR, the unit untouched", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const uid = create(x, "plate", approvedFields());
    const calls: string[] = [];
    let prs = 0;
    (x.svc as any).deps.devPipeline = { agent: fakeAgent((cwd) => writeFileSync(join(cwd, "README.md"), "# only the readme\n"), calls), openPr: () => async () => (prs++, "PR#1") };
    await withKey(async () => {
      await expect(x.svc.runDevPipeline(uid, { onProgress: () => {} })).rejects.toThrow(CAD_BUILDS_WITH_GO);
    });
    expect(calls).toEqual([]); // no model call: refused before the worktree was made
    expect(prs).toBe(0);
    const u = x.unit(uid);
    expect(u.status).toBe("planned");
    expect(u.devPipeline).toBeUndefined();
    expect(u.prUrl).toBeUndefined();
    // A unit that only SAYS it needs CAD (no numbers yet) is refused the same way.
    const bare = create(x, "bare", { needsCad: true });
    await withKey(async () => {
      await expect(x.svc.runDevPipeline(bare, { onProgress: () => {} })).rejects.toThrow(CAD_BUILDS_WITH_GO);
    });
  });

  test("[B3] review 1: the planner's run_pipeline tool refuses a CAD unit with the reason (and starts nothing)", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const uid = create(x, "plate", approvedFields());
    const ev = await x.svc.startPlanningSession(uid);
    const run = planningTools({ sessionId: ev.sessionId, savePlan: () => "", runPipeline: () => (x.svc as any).plannerRunPipeline(ev.sessionId) }).find((t: any) => t.name === "run_pipeline")!;
    const out = (await run.handler({}, {})) as any;
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain(CAD_BUILDS_WITH_GO);
    expect((x.svc as any).runningPipelines.size).toBe(0);
    expect(x.unit(uid).devPipeline).toBeUndefined();
  });

  test("[B3] review 1: auto-start with the pipeline selected falls back to Go for a CAD unit (its start gate still applies) and keeps the pipeline for a non-CAD unit", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const cadId = create(x, "plate", approvedFields());
    const lines: string[] = [];
    await (x.svc as any).autoStartUnit(x.unit(cadId), true, (l: string) => void lines.push(l));
    expect(lines.join("\n")).toContain(CAD_BUILDS_WITH_GO);
    expect(lines.join("\n")).toContain("starting it with Go instead");
    expect(x.unit(cadId).status).toBe("building");
    expect(x.handoffs.at(-1)).toMatchObject({ workUnitRole: "builder", workUnitId: cadId });
    expect(x.firstTurns.at(-1)!.partJson.expectations.lockedBy).toBe("planner"); // Go's builder, numbers applied
    expect((x.svc as any).runningPipelines.size).toBe(0);
    // Unapproved numbers: the Go fallback refuses, the unit stays planned (the run reports a failed start).
    const proposed = create(x, "proposed plate", { needsCad: true, cadExpectations: { plate: PLATE_PLAN }, cadExpectationsStatus: "proposed" });
    await expect((x.svc as any).autoStartUnit(x.unit(proposed), true, () => {})).rejects.toThrow("needs approved dimensions");
    expect(x.unit(proposed).status).toBe("planned");
    // A non-CAD unit still goes to the pipeline.
    const plain = create(x, "readme", {});
    const calls: string[] = [];
    (x.svc as any).deps.devPipeline = { agent: fakeAgent((cwd) => writeFileSync(join(cwd, "README.md"), "# tidy\n"), calls), openPr: () => async () => "PR#2" };
    const handoffsBefore = x.handoffs.length;
    await withKey(async () => {
      await (x.svc as any).autoStartUnit(x.unit(plain), true, () => {});
      const t0 = Date.now();
      while (x.unit(plain).devPipeline === undefined && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
    });
    expect(x.handoffs.length).toBe(handoffsBefore);
    expect(calls.length).toBeGreaterThan(0);
    expect(x.unit(plain).devPipeline).toBeDefined();
  }, 30_000);

  test("[B3] review 1: a non-CAD unit whose pipeline diff touches cad/ is still verified (unchanged), and a loose file under cad/ blocks it as an unexpected path", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const uid = create(x, "notes", {});
    let prs = 0;
    (x.svc as any).deps.devPipeline = { agent: fakeAgent((cwd) => writeFileSync(join(cwd, "cad", "notes.txt"), "scratch\n"), []), openPr: () => async () => (prs++, "PR#1") };
    const o = await withKey(() => x.svc.runDevPipeline(uid, { onProgress: () => {} }));
    expect(o.status).toBe("blocked");
    expect(o.reason).toContain("unexpected path cad/notes.txt");
    expect(x.unit(uid).cadBlocked!.reason).toContain("unexpected path cad/notes.txt");
    expect(x.unit(uid).cadVerified).toBeUndefined();
    expect(prs).toBe(0);
  });
});

describe("review item 2: Link to session cannot start a CAD unit", () => {
  test("[B3] review 2: linking applies the start gate (unapproved numbers refused) and refuses a CAD unit outright, since a linked session is never its builder; a non-CAD unit still links", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const ordinary = x.builderSession("sess_ord", x.repo, { environmentId: x.env.id });
    x.sessions.set("sess_ord", ordinary.session);
    const proposed = create(x, "proposed", { needsCad: true, cadExpectations: { plate: PLATE_PLAN }, cadExpectationsStatus: "proposed" });
    expect(() => x.svc.linkPlan(proposed, "sess_ord")).toThrow("needs approved dimensions");
    const ok = create(x, "approved", approvedFields());
    expect(() => x.svc.linkPlan(ok, "sess_ord")).toThrow("CAD units build with Go");
    // Even a session stamped as a builder — of another unit — is not this unit's builder.
    (ordinary.session.data as any).workUnitRole = "builder";
    (ordinary.session.data as any).workUnitId = proposed;
    expect(() => x.svc.linkPlan(ok, "sess_ord")).toThrow("CAD units build with Go");
    for (const id of [proposed, ok]) {
      expect(x.unit(id).status).toBe("planned");
      expect(x.unit(id).sessionId).toBeUndefined();
    }
    (ordinary.session.data as any).workUnitRole = undefined;
    (ordinary.session.data as any).workUnitId = undefined;
    const plain = create(x, "plain", {});
    expect(x.svc.linkPlan(plain, "sess_ord")).toMatchObject({ type: "autopilot.started", workUnitId: plain, sessionId: "sess_ord" });
    expect(x.unit(plain).status).toBe("building");
  });
});

describe("review item 3: one approval per repo and part, made visible and not clobbered", () => {
  /** Unit A builds the plate at L=80 in its builder, which is merged into main and archived. */
  async function mainVerifiedAt80(x: Rig) {
    const a = create(x, "plate at 80", approvedFields());
    const ev = await x.svc.startPlan(a);
    const cwd = x.firstTurns.at(-1)!.cwd;
    await builderBuildsPlate(x.tools(ev.sessionId));
    expect((await x.svc.verifyBuilder(ev.sessionId, "turn"))!.ok).toBe(true);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "plate");
    git(x.repo, "merge", "-q", "--ff-only", `b3-${x.handoffs.length}`);
    (x.sessions.get(ev.sessionId)!.data as any).archived = true; // merged; its builder is done
    const main = await x.cad.verifyParts(x.repo, { parts: ["plate"] });
    const v = main.parts[0]!;
    expect({ state: v.state, reason: v.reason, failing: v.failing, needsAdoption: v.needsAdoption }).toMatchObject({ state: "pass" });
    return a;
  }
  const row = (rows: any[], label: string) => rows.find((r) => r.label === label);

  test("[B3] review 3a: the reviewer's repro — main verifies at L=80; a second unit plans L=120: its card shows old 80 with the replace note; approving and starting makes main unverified BY DESIGN, as the card said", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    await mainVerifiedAt80(x);
    const b = create(x, "plate at 120", { needsCad: true, cadExpectations: { plate: L120 }, cadExpectationsStatus: "proposed", cadExpectationsSource: "nightly" });
    const card = x.plan(b).cad!;
    const part = card.parts[0]!;
    expect(row(part.rows, "Parameters")).toMatchObject({ old: "L = 80, T = 6, W = 50", new: "L = 120 mm, T = 6 mm, W = 50 mm" });
    expect(row(part.rows, "Bounding box (mm)").old).toBe("6 × 50 × 80");
    expect(row(part.rows, "Bounding box (mm)").new).toContain("6 × 50 × 120");
    expect(row(part.rows, "Process").old).toBe("fdm-0.4");
    expect(part.note).toBe(replaceNote("plate", "main"));
    expect(part.note).toBe("Approving replaces the approved numbers for cad/plate for the whole repo. Until this work is merged, the part on main will show as unverified.");
    // The owner approves what the card said, and starts it: main's plate is unverified, as warned.
    x.svc.respondCad(b, true, card.sha);
    await x.svc.startPlan(b);
    const main = await x.cad.verifyParts(x.repo, { parts: ["plate"] });
    expect(main.parts[0]!.state).not.toBe("pass");
  });

  test("[B3] review 3a: a plan whose numbers ARE the approved ones has no note, and starting it keeps the approval — main stays verified", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    await mainVerifiedAt80(x);
    const lockBefore = x.cad.approvalOf(x.repo, "plate")!;
    const c = create(x, "plate again", { needsCad: true, cadExpectations: { plate: PLATE_PLAN }, cadExpectationsStatus: "proposed" });
    const card = x.plan(c).cad!;
    expect(card.parts[0]!.note).toBeUndefined();
    expect(row(card.parts[0]!.rows, "Volume (mm³)").old).toBe("23335.167");
    x.svc.respondCad(c, true, card.sha);
    await x.svc.startPlan(c);
    const after = x.cad.approvalOf(x.repo, "plate")!;
    expect(after.sha).toBe(lockBefore.sha);
    expect(after.at).toBe(lockBefore.at);
    expect((await x.cad.verifyParts(x.repo, { parts: ["plate"] })).parts[0]!.state).toBe("pass");
  });

  test("[B3] review 3a: the planner's save_cad_expectations card also shows old from the approved entry, with the replace note", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    await mainVerifiedAt80(x);
    const uid = create(x, "planned plate", {});
    const ev = await x.svc.startPlanningSession(uid);
    const pending = (x.svc as any).plannerSaveCad(ev.sessionId, { part: "plate", ...L120 }) as Promise<string>;
    await new Promise((r) => setTimeout(r, 20));
    const card = x.openCards().find((c) => c.kind === "plan")!;
    expect(row(card.rows, "Parameters").old).toBe("L = 80, T = 6, W = 50");
    expect(card.note).toContain(replaceNote("plate", "main"));
    x.cad.respond(card.requestId, false);
    expect(await pending).toContain("nothing was saved");
  });

  test("[B3] review 3b: approved numbers that changed after the plan was approved refuse the start; the redrawn card shows the new old values and a re-approval lets it start", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const b = create(x, "plate at 120", approvedFields(L120, new Date(Date.now() - 60_000).toISOString()));
    const shown = x.plan(b).cad!.sha!;
    await mainVerifiedAt80(x); // someone else's plate at 80 approved and applied AFTER b was approved
    await expect(x.svc.startPlan(b)).rejects.toThrow("the approved numbers for cad/plate changed after this plan was approved; re-approve the plan");
    const card = x.plan(b).cad!;
    expect(card.reapprove).toContain("re-approve the plan");
    expect(card.needsApproval).toBe(true);
    expect(card.sha).not.toBe(shown); // the old side changed, so the card's identity did
    expect(row(card.parts[0]!.rows, "Parameters").old).toBe("L = 80, T = 6, W = 50");
    expect(() => x.svc.respondCad(b, true, shown)).toThrow("changed while the card was open");
    x.svc.respondCad(b, true, card.sha);
    expect(x.plan(b).cad!.reapprove).toBeUndefined();
    await x.svc.startPlan(b);
    expect(x.unit(b).status).toBe("building");
  });

  test("[B3] review 3c: a unit cannot start while another unit's LIVE builder holds the same part; once that builder is archived it can (after re-approval over the approval that builder wrote)", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const a = create(x, "first plate", approvedFields());
    const ev = await x.svc.startPlan(a);
    const b = create(x, "second plate", approvedFields());
    await expect(x.svc.startPlan(b)).rejects.toThrow("cad/plate is being built by “first plate” — finish, dismiss or archive that session first");
    expect(x.unit(b).status).toBe("planned");
    // A unit on other parts is not held by it.
    const other = create(x, "bracket", { needsCad: true, cadExpectations: { bracket: approved() }, cadExpectationsStatus: "approved" });
    await x.svc.startPlan(other);
    // The first builder's process exiting does NOT free the part: the session can still take turns.
    (x.sessions.get(ev.sessionId)!.data as any).status = "exited";
    await expect(x.svc.startPlan(b)).rejects.toThrow("is being built by “first plate”");
    // Archived: the part is free. b was approved over no approval; the first builder has written one since,
    // so b must be re-approved over it (re-review 5) — then it starts.
    (x.sessions.get(ev.sessionId)!.data as any).archived = true;
    await expect(x.svc.startPlan(b)).rejects.toThrow("changed after this plan was approved");
    x.svc.respondCad(b, true, x.plan(b).cad!.sha);
    await x.svc.startPlan(b);
    expect(x.unit(b).status).toBe("building");
  });
});

describe("B3 re-review: approvals keep only identical blocks; parts are reserved before start", () => {
  async function mainAt80(x: Rig) {
    const a = create(x, "plate at 80", approvedFields());
    const ev = await x.svc.startPlan(a);
    const cwd = x.firstTurns.at(-1)!.cwd;
    await builderBuildsPlate(x.tools(ev.sessionId));
    expect((await x.svc.verifyBuilder(ev.sessionId, "turn"))!.ok).toBe(true);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "plate");
    git(x.repo, "merge", "-q", "--ff-only", `b3-${x.handoffs.length}`);
    (x.sessions.get(ev.sessionId)!.data as any).archived = true;
    expect((await x.cad.verifyParts(x.repo, { parts: ["plate"] })).parts[0]!.state).toBe("pass");
  }
  const row = (rows: any[], label: string) => rows.find((r) => r.label === label);
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  test("[B3] re-review 1: the reviewer's repro — the same numbers plus 'Must not touch: housing.step': the card shows the replace note, the start writes part.json with the reference, and the verify checks the interference", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    await mainAt80(x);
    const lockBefore = x.cad.approvalOf(x.repo, "plate")!;
    const strict = { ...PLATE_PLAN, expectations: { ...PLATE_PLAN.expectations, noInterferenceWith: ["housing.step"] } };
    const c = create(x, "plate clear of the housing", { needsCad: true, cadExpectations: { plate: strict }, cadExpectationsStatus: "proposed" });
    const card = x.plan(c).cad!;
    expect(card.parts[0]!.note).toBe(replaceNote("plate", "main"));
    expect(row(card.parts[0]!.rows, "Must not touch")).toMatchObject({ old: "none", new: "housing.step" });
    expect(row(card.parts[0]!.rows, "Parameters")).toMatchObject({ old: "L = 80, T = 6, W = 50" }); // the numbers are the same
    x.svc.respondCad(c, true, card.sha);
    const ev = await x.svc.startPlan(c);
    const first = x.firstTurns.at(-1)!;
    expect(first.partJson.expectations.noInterferenceWith).toEqual(["housing.step"]);
    expect(first.partJson.expectations.lockedBy).toBe("planner");
    const after = x.cad.approvalOf(x.repo, "plate")!;
    expect(after.sha).not.toBe(lockBefore.sha); // the approval was replaced, as the card said
    expect(after.approvedBy).toBe("planner");
    const j = (await x.svc.verifyBuilder(ev.sessionId, "turn"))!;
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("interference housing.step"); // the reference is checked
    expect(x.unit(c).status).toBe("blocked");
  });

  test("[B3] re-review 2: two concurrent Go clicks for two units on cad/plate — exactly one starts, the other is refused naming the first; the lock holds only the winner's numbers", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const a = create(x, "plate at 80", approvedFields());
    const b = create(x, "plate at 120", approvedFields(L120));
    const [ra, rb] = await Promise.allSettled([x.svc.startPlan(a), x.svc.startPlan(b)]);
    const won = [ra, rb].filter((r) => r.status === "fulfilled");
    const lost = [ra, rb].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    const winner = ra.status === "fulfilled" ? a : b;
    const loser = winner === a ? b : a;
    expect(String(lost[0]!.reason?.message ?? lost[0]!.reason)).toContain(`cad/plate is being built by “${x.unit(winner).title}” — finish, dismiss or archive that session first`);
    expect(x.handoffs.filter((h) => h.workUnitRole === "builder").length).toBe(1);
    expect(x.unit(winner).status).toBe("building");
    expect(x.unit(loser).status).toBe("planned");
    expect(x.unit(loser).sessionId).toBeUndefined();
    expect(x.cad.approvalOf(x.repo, "plate")!.declared!.L).toBe(winner === a ? 80 : 120);
    // The reservation is released when a start fails: a refused/failed start leaves nothing held.
    expect((x.svc as any).starting.size).toBe(0);
  });

  test("[B3] re-review 3: a double Go on the same unit starts one builder; the second is refused 'this plan is already starting'", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const a = create(x, "plate", approvedFields());
    const plain = create(x, "readme", {});
    const results = await Promise.allSettled([x.svc.startPlan(a), x.svc.startPlan(a), x.svc.startPlan(plain), x.svc.startPlan(plain)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "rejected"]);
    for (const r of [results[1], results[3]] as PromiseRejectedResult[]) expect(String(r.reason?.message)).toBe("this plan is already starting");
    expect(x.handoffs.filter((h) => h.workUnitId === a).length).toBe(1);
    expect(x.handoffs.filter((h) => h.workUnitId === plain).length).toBe(1);
    // A start whose prepare fails releases the reservation: the unit can be started again.
    const bad = create(x, "bad", { needsCad: true, cadExpectations: { gear: approved({ ...PLATE_PLAN, process: "fdm-0.4" }) }, cadExpectationsStatus: "approved" });
    const orig = x.cad.applyPlanExpectations.bind(x.cad);
    (x.cad as any).applyPlanExpectations = async () => ({ ok: false, error: "boom" });
    await expect(x.svc.startPlan(bad)).rejects.toThrow("boom");
    (x.cad as any).applyPlanExpectations = orig;
    expect((x.svc as any).starting.size).toBe(0);
    await x.svc.startPlan(bad);
    expect(x.unit(bad).status).toBe("building");
  });

  test("[B3] re-review 4: a builder holds its part only while its unit is building/blocked with that session, not archived; every other path releases it", async () => {
    const paths: [string, boolean, (x: Rig, a: string, sid: string) => void][] = [
      ["blocked (still its builder)", true, (x, a) => (x.svc as any).workUnits.update(a, { status: "blocked" })],
      ["process exited (not archived)", true, (x, _a, sid) => void ((x.sessions.get(sid)!.data as any).status = "exited")],
      ["session archived", false, (x, _a, sid) => void ((x.sessions.get(sid)!.data as any).archived = true)],
      ["session gone", false, (x, _a, sid) => void x.sessions.delete(sid)],
      ["unit completed", false, (x, a) => (x.svc as any).workUnits.update(a, { status: "completed" })],
      ["unit dismissed", false, (x, a) => (x.svc as any).workUnits.update(a, { status: "dismissed" })],
      ["unit expired", false, (x, a) => (x.svc as any).workUnits.update(a, { status: "expired" })],
      ["unit in review", false, (x, a) => (x.svc as any).workUnits.update(a, { status: "review" })],
      ["unit moved on to another session", false, (x, a) => (x.svc as any).workUnits.update(a, { sessionId: "sess_other" })],
    ];
    for (const [what, holds, release] of paths) {
      const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
      const a = create(x, "first plate", approvedFields());
      const ev = await x.svc.startPlan(a);
      const b = create(x, "second plate", approvedFields());
      release(x, a, ev.sessionId);
      const why = await refusal(x.svc.startPlan(b));
      expect([what, why.includes("cad/plate is being built by “first plate” — finish, dismiss or archive that session first")]).toEqual([what, holds]);
      if (!holds) {
        // Free: only the approval the first builder wrote stands in the way; re-approved over it, b starts.
        expect([what, why]).toEqual([what, "this plan cannot start: the approved numbers for cad/plate changed after this plan was approved; re-approve the plan"]);
        x.svc.respondCad(b, true, x.plan(b).cad!.sha);
        await x.svc.startPlan(b);
        expect([what, x.unit(b).status]).toEqual([what, "building"]);
      }
      await stopServices();
      cleanupTemp();
    }
  }, 120_000);

  test("[B3] re-review 5: an approval synced from another machine whose clock is EARLIER than the plan's approval still refuses the start (identity, not time); re-approval over it lets it start", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const b = create(x, "plate at 120", { needsCad: true, cadExpectations: { plate: L120 }, cadExpectationsStatus: "proposed" });
    x.svc.respondCad(b, true, x.plan(b).cad!.sha); // approved now, over no approval
    const planAt = Date.parse(x.unit(b).cadExpectations!.plate!.approvedAt!);
    const c = checkPlanPart("plate", PLATE_PLAN);
    if (!c.ok) throw new Error(c.error);
    const id = repoIdentity(x.repo);
    // The owner approved L=80 on another machine whose clock runs an hour behind; it arrives via the fleet.
    x.cad.lockSync.acceptFromMember({ serverId: "m1", parts: [{ repo: id.key, ...(id.remote ? { remote: id.remote } : {}), path: id.path, part: "plate", sha: "sha-from-m1", approvedBy: "owner", status: "dimensioned", values: c.values, declared: c.declared, at: new Date(planAt - 3_600_000).toISOString(), machine: "m1" }], rules: [] } as any);
    expect(x.cad.approvalOf(x.repo, "plate")!.sha).toBe("sha-from-m1");
    await expect(x.svc.startPlan(b)).rejects.toThrow("the approved numbers for cad/plate changed after this plan was approved; re-approve the plan");
    const card = x.plan(b).cad!;
    expect(card.reapprove).toContain("re-approve the plan");
    expect(card.parts[0]!.note).toBe(replaceNote("plate", "main"));
    x.svc.respondCad(b, true, card.sha);
    await x.svc.startPlan(b);
    expect(x.unit(b).status).toBe("building");
  });
});

describe("review item 4: no change under cad/ is skipped", () => {
  test("[B3] review 4: a builder's loose file directly under cad/ or a folder with an invalid part name fails its verify as an unexpected path", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const uid = create(x, "plate", approvedFields());
    const ev = await x.svc.startPlan(uid);
    const cwd = x.firstTurns.at(-1)!.cwd;
    await builderBuildsPlate(x.tools(ev.sessionId));
    expect((await x.svc.verifyBuilder(ev.sessionId, "turn"))!.ok).toBe(true);
    writeFileSync(join(cwd, "cad", "bracket.step"), "ISO-10303-21;\n");
    let j = await x.svc.verifyBuilder(ev.sessionId, "turn");
    expect(j!.ok).toBe(false);
    expect(j!.reason).toContain("unexpected path cad/bracket.step");
    expect(x.unit(uid).status).toBe("blocked");
    git(cwd, "rm", "-q", "--cached", "--ignore-unmatch", "cad/bracket.step");
    Bun.spawnSync(["rm", "-f", join(cwd, "cad", "bracket.step")]);
    mkdirSync(join(cwd, "cad", "Widget_X"), { recursive: true });
    writeFileSync(join(cwd, "cad", "Widget_X", "design.json"), "{}\n");
    j = await x.svc.verifyBuilder(ev.sessionId, "turn");
    expect(j!.ok).toBe(false);
    expect(j!.reason).toContain("unexpected path cad/Widget_X/design.json");
    expect(j!.reason).not.toContain("cad/bracket.step");
  });

  test("[B3] review 4: a builder's Write/Edit to a file directly under cad/ (other than rules.json) is denied; an ordinary session is not stopped by that rule", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const uid = create(x, "plate", approvedFields());
    const ev = await x.svc.startPlan(uid);
    const cwd = x.firstTurns.at(-1)!.cwd;
    for (const [tool, input] of [
      ["Write", { file_path: join(cwd, "cad", "bracket.step"), content: "x" }],
      ["Edit", { file_path: join(cwd, "cad", "notes.md"), old_string: "a", new_string: "b" }],
    ] as const) {
      const r = await x.gate(ev.sessionId, tool, input as Record<string, unknown>);
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain("directly under cad/");
      expect(r.asked).toEqual([]);
    }
    // rules.json keeps its own rule (always-prompt, denied unattended); a part's own file is not this rule's.
    expect(cadProtectedRule({ session: x.sessions.get(ev.sessionId)! as any, tool: "Write", input: { file_path: join(cwd, "cad", "rules.json"), content: "{}" }, cwd })).toMatchObject({ kind: "always-prompt" });
    expect(cadProtectedRule({ session: x.sessions.get(ev.sessionId)! as any, tool: "Write", input: { file_path: join(cwd, "cad", "plate", "notes.md"), content: "x" }, cwd })).toBeUndefined();
    const ordinary = { data: { id: "o", cwd, autonomy: "bypass" } } as any;
    expect(cadProtectedRule({ session: ordinary, tool: "Write", input: { file_path: join(cwd, "cad", "bracket.step"), content: "x" }, cwd })).toBeUndefined();
  });
});

describe("review item 5: the unit follows the latest verify", () => {
  test("[B3] review 5: blocked → fixed → building: a passing verify clears cadBlocked and returns the unit to building; a failing one clears cadVerified; never both; one notice per new reason says how to resume", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const uid = create(x, "plate", approvedFields());
    const ev = await x.svc.startPlan(uid);
    const t = x.tools(ev.sessionId);
    const sid = ev.sessionId;
    await t.open_part!({ part: "plate" });
    const build = plateBuild(REFERENCE_PLATE);
    await t.batch!({ commands: build.slice(0, -1) }); // no hole pattern yet: fails
    expect((await x.svc.verifyBuilder(sid, "turn"))!.ok).toBe(false);
    let u = x.unit(uid);
    expect(u.status).toBe("blocked");
    expect(u.cadBlocked).toBeDefined();
    expect(u.cadVerified).toBeUndefined();
    expect(x.notices.length).toBe(1);
    expect(x.notices[0]).toMatchObject({ sessionId: sid });
    expect(x.notices[0]!.markdown).toContain("blocked by the CAD verify");
    expect(x.notices[0]!.markdown).toContain("reply in this session");
    expect(x.notices[0]!.markdown).toContain("no separate Unblock button");
    await x.svc.verifyBuilder(sid, "turn"); // the same reason again: no second notice
    expect(x.notices.length).toBe(1);
    // The owner replies; the builder finishes the part; the next turn's verify passes.
    await t.batch!({ commands: build.slice(-1) });
    expect((await x.svc.verifyBuilder(sid, "turn"))!.ok).toBe(true);
    u = x.unit(uid);
    expect(u.status).toBe("building");
    expect(u.blockedReason).toBeUndefined();
    expect(u.cadBlocked).toBeUndefined();
    expect(u.cadVerified!.parts).toEqual(["plate"]);
    expect(x.notices.at(-1)!.markdown).toContain("back to *building*");
    expect(x.plan(uid).cad!.blocked).toBeUndefined();
    // It breaks again: blocked, and the stale verified badge is gone.
    await t.set_parameter!({ name: "L", expression: "120 mm" });
    expect((await x.svc.verifyBuilder(sid, "turn"))!.ok).toBe(false);
    u = x.unit(uid);
    expect(u.status).toBe("blocked");
    expect(u.cadVerified).toBeUndefined();
    expect(u.cadBlocked).toBeDefined();
    const info = x.plan(uid).cad!;
    expect(!!info.verified && !!info.blocked).toBe(false);
  });

  test("[B3] review 5: a goal-time block says the goal ended unmet (the first failing goal check ends it), and a passing verify of a builder whose session is gone does not revive the unit", async () => {
    expect(builderBlockedNotice("cad/plate is fail", "goal")).toContain("The goal ended unmet");
    expect(builderBlockedNotice("cad/plate is fail", "turn")).not.toContain("goal");
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const uid = create(x, "plate", approvedFields());
    const ev = await x.svc.startPlan(uid);
    await x.svc.verifyBuilder(ev.sessionId, "turn"); // nothing built: blocked
    expect(x.unit(uid).status).toBe("blocked");
    await builderBuildsPlate(x.tools(ev.sessionId));
    (x.sessions.get(ev.sessionId)!.data as any).archived = true;
    expect((await x.svc.verifyBuilder(ev.sessionId, "turn"))!.ok).toBe(true);
    expect(x.unit(uid).status).toBe("blocked"); // not live: the status is the owner's to change
    expect(x.unit(uid).cadBlocked).toBeUndefined(); // but the state is consistent with the latest verify
    expect(x.unit(uid).cadVerified).toBeDefined();
  });
});

describe("review item 6: smaller holes", () => {
  test("[B3] review 6: save_cad_expectations refuses a unit that is building (as the card's respond does)", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const uid = create(x, "planned plate", {});
    const ev = await x.svc.startPlanningSession(uid);
    (x.svc as any).workUnits.update(uid, { status: "building", sessionId: ev.sessionId });
    await expect((x.svc as any).plannerSaveCad(ev.sessionId, { part: "plate", ...PLATE_PLAN })).rejects.toThrow("already building");
    expect(x.openCards()).toEqual([]);
  });

  test("[B3] review 6: a process the repo's cad/rules.json does not define — refused by save_cad_expectations, marked invalid on the card (no approve, no start)", async () => {
    const x = await b3Rig({ cli: FAKE_SOLIDCRAFT });
    const sla = { ...PLATE_PLAN, process: "sla-0.05" };
    const uid = create(x, "planned plate", {});
    const ev = await x.svc.startPlanningSession(uid);
    await expect((x.svc as any).plannerSaveCad(ev.sessionId, { part: "plate", ...sla })).rejects.toThrow("process sla-0.05 is not in the repo's cad/rules.json");
    expect(x.openCards()).toEqual([]);
    const p = create(x, "sla plate", { needsCad: true, cadExpectations: { plate: sla }, cadExpectationsStatus: "proposed" });
    const card = x.plan(p).cad!;
    expect(card.parts[0]!.invalid).toContain("not in the repo's cad/rules.json (it has: fdm-0.4, cnc-3axis)");
    expect(card.needsApproval).toBe(true);
    expect(() => x.svc.respondCad(p, true, card.sha)).toThrow("process sla-0.05 is not in the repo's cad/rules.json");
    const q = create(x, "sla approved", { needsCad: true, cadExpectations: { plate: approved(sla) }, cadExpectationsStatus: "approved" });
    await expect(x.svc.startPlan(q)).rejects.toThrow("process sla-0.05 is not in the repo's cad/rules.json");
    expect(x.handoffs.filter((h) => h.workUnitRole === "builder")).toEqual([]);
  });
});
