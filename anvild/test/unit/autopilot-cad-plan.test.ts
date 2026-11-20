/**
 * [B3] The pure parts of autopilot CAD (agent-cad-and-browser §4.11, §4.14 item 41): a plan's
 * expectations are validated exactly like `record_expectations`; the nightly planner's metadata block
 * is the structured channel for PROPOSED numbers (malformed ones ignored with a note); the start gate
 * ("needs approved dimensions" is an overlay, not a new status); the card's CAD section; and how a
 * verify result is judged for a builder or the dev pipeline.
 */
import { describe, expect, test } from "bun:test";
import { checkPlanExpectations, checkPlanPart, parseDeclared, planExpectationRows, planExpectationsSha } from "../../src/cadwork/plan-expectations";
import { parseDeclared as serviceParseDeclared } from "../../src/session/cadwork-service";
import { CAD_META_INSTRUCTION, extractPlanMeta } from "../../src/integrations/plan-meta";
import { autoStartDecision } from "../../src/integrations/autostart-gate";
import { NEEDS_APPROVED_DIMENSIONS, cadFieldsFromMeta, cadStartRefusal, cadStatusOf, judgeCadVerify, toCadInfo } from "../../src/integrations/autopilot-cad";
import { buildAutopilotBrief, selectPendingPlans, toPlanInfo } from "../../src/integrations/autopilot-plans";
import { PassthroughRenderer } from "../../src/render/markdown";
import type { WorkUnit } from "../../src/integrations/workunit";

const PLAN = { process: "fdm-0.4", parameters: { L: "80 mm", W: 50, T: "6 mm" }, expectations: { bbox: ["L", "W", "T"], volume: "L*W*T", bodies: 1, holes: [{ diameter: 3.4, count: 4 }] } };
const unit = (over: Partial<WorkUnit> = {}): WorkUnit => ({ id: "wu1", environmentId: "e", todoistProjectId: "p", taskIds: [], title: "plate", status: "planned", createdAt: "t", updatedAt: "t", ...over }) as WorkUnit;

describe("a plan's expectations: the record_expectations schema and caps", () => {
  test("[B3] a valid part is normalized and its numbers fixed from the declared literal values", () => {
    const c = checkPlanPart("plate", { ...PLAN, extra: "dropped" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.declared).toEqual({ L: 80, W: 50, T: 6 });
    expect(c.values).toMatchObject({ bbox: [6, 50, 80], volume: 24000, bodies: 1, holes: [{ diameter: 3.4, count: 4 }] });
    expect(Object.keys(c.entry).sort()).toEqual(["expectations", "parameters", "process"]);
    expect(c.entry.parameters).toEqual({ L: "80 mm", T: "6 mm", W: 50 });
    // The same declared-value reader record_expectations uses.
    expect(serviceParseDeclared).toBe(parseDeclared);
  });

  test("[B3] a bad name, a missing process, a non-literal parameter, a bad shape, a loose tolerance, or an undeclared formula name is refused", () => {
    const bad = (part: unknown, raw: unknown) => {
      const c = checkPlanPart(part, raw);
      expect(c.ok).toBe(false);
      return c.ok ? "" : c.error;
    };
    expect(bad("../x", PLAN)).toContain("not a part name");
    expect(bad("plate", { ...PLAN, process: " " })).toContain("process");
    expect(bad("plate", { ...PLAN, parameters: { L: "W*2" } })).toContain("must be a number");
    expect(bad("plate", { ...PLAN, parameters: { L: "30 deg" } })).toContain("must be a number");
    expect(bad("plate", { ...PLAN, expectations: { ...PLAN.expectations, bodies: 1.5 } })).toContain("bodies");
    expect(bad("plate", { ...PLAN, expectations: { ...PLAN.expectations, tolerance: { length: 0.5 } } })).toContain("looser than the cap");
    expect(bad("plate", { ...PLAN, expectations: { ...PLAN.expectations, tolerance: { volumeRel: 0.05 } } })).toContain("looser than the cap");
    expect(bad("plate", { ...PLAN, parameters: { L: 80 } })).toContain("must be declared");
    expect(bad("plate", "nope")).toContain("{process, parameters, expectations}");
  });

  test("[B3] a record keeps the valid parts and lists one error per invalid one; the sha ignores approval stamps and key order", () => {
    const r = checkPlanExpectations({ plate: PLAN, Bad: PLAN, loose: { ...PLAN, expectations: { ...PLAN.expectations, tolerance: { length: 1 } } } });
    expect(Object.keys(r.parts)).toEqual(["plate"]);
    expect(r.errors.length).toBe(2);
    expect(checkPlanExpectations([1]).errors[0]).toContain("must be an object");
    expect(checkPlanExpectations(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, PLAN]))).errors[0]).toContain("at most 20");
    const a = checkPlanPart("plate", PLAN);
    if (!a.ok) throw new Error("x");
    expect(planExpectationsSha({ plate: a.entry })).toBe(planExpectationsSha({ plate: { ...a.entry, approvedAt: "2026-01-01" } }));
    expect(planExpectationsSha({ plate: a.entry })).not.toBe(planExpectationsSha({ plate: { ...a.entry, parameters: { ...a.entry.parameters, L: "81 mm" } } }));
    const rows = planExpectationRows(a.entry);
    expect(rows.find((x) => x.label === "Bounding box (mm)")!.new).toBe("L × W × T  (= 6 × 50 × 80)");
    expect(rows.find((x) => x.label === "Parameters")!.new).toBe("L = 80 mm, T = 6 mm, W = 50");
  });
});

describe("the nightly planner's channel: the metadata block", () => {
  const block = (o: unknown) => `# Plan\nDo it.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

  test("[B3] needsCad and cadExpectations in the metadata block become PROPOSED numbers on the unit, never approved", () => {
    const m = extractPlanMeta(block({ summary: "s", size: "s", filesTouched: 1, needsCad: true, cadExpectations: { plate: PLAN } }));
    expect(m.plan).toBe("# Plan\nDo it.");
    expect(m.summary).toBe("s");
    expect(Object.keys(m.cad!.expectations)).toEqual(["plate"]);
    expect(m.cad!.note).toBeUndefined();
    const f = cadFieldsFromMeta(m.cad);
    expect(f).toMatchObject({ needsCad: true, cadExpectationsStatus: "proposed", cadExpectationsSource: "nightly" });
    expect(f.cadExpectations!.plate!.approvedAt).toBeUndefined();
    // No CAD fields at all: nothing about CAD.
    expect(extractPlanMeta(block({ summary: "s", size: "s" })).cad).toBeUndefined();
    expect(cadFieldsFromMeta(undefined)).toEqual({});
    // The instruction names the fields and the caps.
    expect(CAD_META_INSTRUCTION).toContain('"cadExpectations"');
    expect(CAD_META_INSTRUCTION).toContain("0.1 mm / 1%");
  });

  test("[B3] malformed proposals are ignored with a note; the unit still needs CAD", () => {
    const m = extractPlanMeta(block({ summary: "s", size: "s", cadExpectations: { plate: PLAN, broken: { process: "fdm-0.4", parameters: {}, expectations: { bbox: [1, 1], volume: 1, bodies: 1, holes: [] } } } }));
    expect(Object.keys(m.cad!.expectations)).toEqual(["plate"]);
    expect(m.cad!.note).toContain("cad/broken");
    expect(m.cad!.note).toContain("Ignored");
    const only = extractPlanMeta(block({ summary: "s", size: "s", needsCad: true, cadExpectations: "lots" }));
    expect(only.cad).toMatchObject({ needsCad: true, expectations: {} });
    const f = cadFieldsFromMeta(only.cad);
    expect(f.needsCad).toBe(true);
    expect(f.cadExpectations).toBeUndefined();
    expect(f.cadNote).toContain("must be an object");
    expect(cadStartRefusal(f as WorkUnit)).toContain(NEEDS_APPROVED_DIMENSIONS);
  });
});

describe("the start gate: an overlay, not a new status", () => {
  test("[B3] a CAD unit starts only when every part is approved; a non-CAD unit is unaffected; auto-start holds with the same reason", () => {
    const c = checkPlanPart("plate", PLAN);
    if (!c.ok) throw new Error("x");
    expect(cadStartRefusal(unit())).toBeUndefined();
    expect(autoStartDecision(unit())).toEqual({ start: true });
    const proposed = unit({ needsCad: true, cadExpectations: { plate: c.entry }, cadExpectationsStatus: "proposed" });
    expect(cadStartRefusal(proposed)).toContain("approve the proposed CAD numbers");
    expect(autoStartDecision(proposed)).toMatchObject({ start: false, reason: expect.stringContaining(NEEDS_APPROVED_DIMENSIONS) });
    expect(proposed.status).toBe("planned"); // the real status is untouched
    expect(cadStartRefusal({ ...proposed, cadExpectationsStatus: "rejected" })).toContain("rejected");
    expect(cadStartRefusal(unit({ needsCad: true }))).toContain("no valid numbers");
    // "approved" with a part that has no approval stamp is not approved.
    expect(cadStartRefusal({ ...proposed, cadExpectationsStatus: "approved" })).toBeDefined();
    const ok = { ...proposed, cadExpectations: { plate: { ...c.entry, approvedAt: "t" } }, cadExpectationsStatus: "approved" as const };
    expect(cadStartRefusal(ok)).toBeUndefined();
    expect(autoStartDecision(ok)).toEqual({ start: true });
    expect(cadStatusOf({ plate: { ...c.entry, approvedAt: "t" }, other: c.entry })).toBe("proposed");
    expect(cadStatusOf({ plate: { ...c.entry, approvedAt: "t" } })).toBe("approved");
  });

  test("[B3] the card shows the numbers, the needs-approval state, the verified badge and the blocked reason; CAD builds stay on the grid", () => {
    const c = checkPlanPart("plate", PLAN);
    if (!c.ok) throw new Error("x");
    expect(toCadInfo(unit())).toBeUndefined();
    const u = unit({ needsCad: true, cadExpectations: { plate: c.entry }, cadExpectationsStatus: "proposed", cadExpectationsSource: "nightly", cadNote: "n" });
    const info = toCadInfo(u)!;
    expect(info).toMatchObject({ status: "proposed", needsApproval: true, source: "nightly", note: "n", sha: planExpectationsSha(u.cadExpectations) });
    expect(info.parts[0]).toMatchObject({ part: "plate", process: "fdm-0.4", approved: false });
    const verified = unit({ ...u, status: "building", sessionId: "s", cadExpectations: { plate: { ...c.entry, approvedAt: "t" } }, cadExpectationsStatus: "approved", cadVerified: { at: "t", parts: ["plate"] } });
    expect(toCadInfo(verified)).toMatchObject({ status: "approved", needsApproval: false, verified: { parts: ["plate"] } });
    const blocked = unit({ ...verified, status: "blocked", cadVerified: undefined, cadBlocked: { at: "t", reason: "cad/plate is fail" }, blockedReason: "CAD: cad/plate is fail" });
    const plan = toPlanInfo(blocked, "env", new PassthroughRenderer());
    expect(plan.cad!.blocked!.reason).toBe("cad/plate is fail");
    expect(plan.blockedReason).toBe("CAD: cad/plate is fail");
    expect(selectPendingPlans([verified, blocked, unit({ id: "x", status: "building", sessionId: "s2" })]).map((p) => p.status)).toEqual(["building", "blocked"]);
    // The builder's brief says the numbers are already recorded.
    const brief = buildAutopilotBrief(verified);
    expect(brief).toContain("## CAD parts");
    expect(brief).toContain("Do not call record_expectations");
    expect(buildAutopilotBrief(unit())).not.toContain("CAD parts");
  });
});

describe("judging a verify run", () => {
  const verdict = (part: string, state: string, more: Record<string, unknown> = {}) => ({ part, state, ok: state === "pass" || state === "concept", failing: [], ...more });
  const run = (parts: any[], changed: string[], rulesChanged = false, error?: string) => ({ ok: parts.every((p) => p.ok), ...(error ? { error } : {}), parts, selection: { changed, rulesChanged } });
  const owner = () => ({ approvedBy: "planner" });

  test("[B3] all pass with plan-approved numbers → OK; every failure kind gives its own reason", () => {
    expect(judgeCadVerify(run([verdict("plate", "pass")], ["plate"]), { covered: ["plate"], approvalOf: owner })).toEqual({ ok: true, parts: ["plate"] });
    const reason = (r: any, covered: string[] | undefined = ["plate"], approvalOf: (p: string) => any = owner) => judgeCadVerify(r, { ...(covered ? { covered } : {}), approvalOf }).reason ?? "";
    expect(reason(run([verdict("plate", "fail", { failing: ["volume: expected 1, measured 2"] })], ["plate"]))).toContain("cad/plate is fail: volume");
    expect(reason(run([verdict("plate", "gap", { reason: "knurling" })], ["plate"]))).toContain("reported a capability gap: knurling");
    expect(reason(run([verdict("plate", "unverified", { needsAdoption: "rules" })], ["plate"]))).toContain("adoption pending: rules");
    expect(reason(run([verdict("plate", "concept")], ["plate"]))).toContain("is concept");
    expect(reason(run([verdict("plate", "pass"), verdict("bracket", "pass")], ["plate", "bracket"]))).toContain("cad/bracket was touched but the plan has no approved dimensions");
    expect(reason(run([verdict("plate", "pass")], ["plate"]), ["plate"], () => ({ approvedBy: "agent-initial" }))).toContain("set by the agent");
    expect(reason(run([verdict("plate", "pass")], ["plate"]), ["plate"], () => undefined)).toContain("no approved expectations");
    expect(reason(run([], [], true))).toContain("cad/rules.json changed");
    expect(reason(run([], [], false, "no SolidCraft"))).toContain("could not run: no SolidCraft");
    // The dev pipeline (no plan coverage): an owner-approved passing part is fine, an agent-initial one is not.
    expect(judgeCadVerify(run([verdict("bracket", "pass")], ["bracket"]), { approvalOf: () => ({ approvedBy: "owner" }) }).ok).toBe(true);
    expect(reason(run([verdict("bracket", "pass")], ["bracket"]), undefined, () => ({ approvedBy: "agent-initial" }))).toContain("set by the agent");
  });
});

describe("B3 review fixes: the pure parts", () => {
  const approvedAt80 = (over: Record<string, unknown> = {}) => ({
    approvedBy: "planner",
    at: "2026-11-20T01:00:00.000Z",
    sha: "s1",
    values: { bbox: [6, 50, 80] as [number, number, number], volume: 24000, bodies: 1, holes: [{ diameter: 3.4, count: 4 }] },
    declared: { L: 80, W: 50, T: 6 },
    matchesFile: true,
    process: "fdm-0.4",
    tolerance: { length: 0.01, volumeRel: 0.001 }, // the defaults (PLAN sets none)
    refs: [],
    ...over,
  });

  test("[B3] review 3: 'same as approved' compares the evaluated numbers and declared values (and the process when known); only the same, owner- or plan-approved numbers with their block on disk keep the approval", async () => {
    const { replacesApproval, sameAsApproved, planExpectationRows: rowsOf } = await import("../../src/cadwork/plan-expectations");
    const p80 = checkPlanPart("plate", PLAN);
    if (!p80.ok) throw new Error(p80.error);
    expect(sameAsApproved(p80.entry, approvedAt80())).toBe(true);
    expect(replacesApproval(p80.entry, approvedAt80())).toBe(false);
    const p120 = checkPlanPart("plate", { ...PLAN, parameters: { ...PLAN.parameters, L: "120 mm" } });
    if (!p120.ok) throw new Error(p120.error);
    expect(sameAsApproved(p120.entry, approvedAt80())).toBe(false);
    expect(replacesApproval(p120.entry, approvedAt80())).toBe(true);
    expect(sameAsApproved(p80.entry, approvedAt80({ process: "cnc-3axis" }))).toBe(false);
    expect(sameAsApproved(p80.entry, approvedAt80({ tolerance: { length: 0.1, volumeRel: 0.01 } }))).toBe(false);
    expect(sameAsApproved(p80.entry, approvedAt80({ process: undefined, tolerance: undefined, matchesFile: false }))).toBe(true); // unknown fields not compared…
    expect(replacesApproval(p80.entry, approvedAt80({ matchesFile: false }))).toBe(true); // …but the block on disk is not the approved one
    expect(replacesApproval(p80.entry, approvedAt80({ approvedBy: "agent-initial" }))).toBe(true);
    expect(replacesApproval(p80.entry, undefined)).toBe(true);
    // The rows' old side is the approval, the new side the plan.
    const rows = rowsOf(p120.entry, approvedAt80());
    expect(rows.find((r) => r.label === "Parameters")).toMatchObject({ old: "L = 80, T = 6, W = 50", new: "L = 120 mm, T = 6 mm, W = 50" });
    expect(rows.find((r) => r.label === "Process")).toMatchObject({ old: "fdm-0.4", new: "fdm-0.4" });
    expect(rowsOf(p120.entry).every((r) => r.old === undefined)).toBe(true);
  });

  test("[B3] review 3: the card carries old values, the replace note and a re-approve state from the approval; its sha changes when the approval does", async () => {
    const { cadCardSha, approvalChangedRefusal } = await import("../../src/integrations/autopilot-cad");
    const p120 = checkPlanPart("plate", { ...PLAN, parameters: { ...PLAN.parameters, L: "120 mm" } });
    if (!p120.ok) throw new Error(p120.error);
    const u = unit({ needsCad: true, cadExpectations: { plate: { ...p120.entry, approvedAt: "2026-11-20T00:00:00.000Z" } }, cadExpectationsStatus: "approved" });
    let approval: ReturnType<typeof approvedAt80> | undefined = approvedAt80();
    const ctx = { approved: () => approval, processes: ["fdm-0.4"], defaultBranch: "main" };
    const info = toCadInfo(u, ctx)!;
    expect(info.parts[0]!.note).toContain("Approving replaces the approved numbers for cad/plate for the whole repo");
    expect(info.parts[0]!.note).toContain("the part on main will show as unverified");
    expect(info.reapprove).toContain("changed after this plan was approved"); // the approval (01:00) is newer than the plan's (00:00)
    expect(info.needsApproval).toBe(true);
    expect(approvalChangedRefusal(u, () => approvedAt80({ at: "2026-11-19T00:00:00.000Z" }))).toBeUndefined(); // older: no conflict
    const shaWith = cadCardSha(u.cadExpectations, ctx);
    approval = approvedAt80({ at: "2026-11-20T02:00:00.000Z" });
    expect(cadCardSha(u.cadExpectations, ctx)).not.toBe(shaWith);
    approval = undefined;
    expect(cadCardSha(u.cadExpectations, ctx)).toBe(planExpectationsSha(u.cadExpectations));
    expect(toCadInfo(u, ctx)!.parts[0]!.note).toBeUndefined(); // nothing approved: nothing replaced
    // An unknown process is invalid with a note.
    const bad = toCadInfo(u, { ...ctx, processes: ["cnc-3axis"] })!;
    expect(bad.parts[0]!.invalid).toBe("process fdm-0.4 is not in the repo's cad/rules.json (it has: cnc-3axis)");
    expect(bad.needsApproval).toBe(true);
    expect(toCadInfo(u, { ...ctx, processes: null })!.parts[0]!.invalid).toContain("no readable cad/rules.json");
  });

  test("[B3] review 6: a unit held for clarification keeps the planner's CAD fields; a proposed part whose process is not in cad/rules.json is dropped with a note", async () => {
    const { processedUnitFields } = await import("../../src/integrations/autopilot");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const repo = mkdtempSync(join(tmpdir(), "anvil-b3-fields-"));
    try {
      mkdirSync(join(repo, "cad"));
      writeFileSync(join(repo, "cad", "rules.json"), JSON.stringify({ schema: 1, processes: [{ id: "fdm-0.4", kind: "fdm", envelope: [250, 210, 220] }] }));
      const meta = extractPlanMeta(`# Plan\n\n\`\`\`json\n${JSON.stringify({ summary: "s", size: "s", needsCad: true, cadExpectations: { plate: PLAN, cup: { ...PLAN, process: "sla-0.05" } } })}\n\`\`\``);
      const planned = { title: "plate", rationale: "r", taskIds: ["t1"], tasks: [], plan: meta.plan, cad: meta.cad } as any;
      const held = processedUnitFields({ title: "plate", rationale: "r", taskIds: ["t1"] }, { environmentId: "e", projectId: "p", repoRoot: repo }, { reason: "which plate?", questions: ["Which?"] }, planned);
      expect(held).toMatchObject({ status: "needs-clarification", needsCad: true, cadExpectationsStatus: "proposed", cadExpectationsSource: "nightly" });
      expect(Object.keys((held as any).cadExpectations)).toEqual(["plate"]);
      expect((held as any).cadNote).toContain("cad/cup: process sla-0.05 is not in the repo's cad/rules.json (it has: fdm-0.4)");
      const ok = processedUnitFields({ title: "plate", rationale: "r", taskIds: ["t1"] }, { environmentId: "e", projectId: "p", repoRoot: repo }, undefined, planned);
      expect(ok).toMatchObject({ status: "planned", needsCad: true, cadExpectationsStatus: "proposed" });
      // Intake held it before any planning: there is nothing about CAD to keep.
      expect((processedUnitFields({ title: "x", rationale: "r", taskIds: [] }, { environmentId: "e", projectId: "p", repoRoot: repo }, { reason: "vague", questions: [] }, undefined) as any).needsCad).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
