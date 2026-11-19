/**
 * [A2] The geometry gate (agent-cad-and-browser spec §4.5, §4.14 #2 #3): `GateResult`, its hard
 * checks, and the rule that it fails CLOSED. The first half drives `evaluateGate` directly; the
 * second runs the real refresh against the fake SolidCraft.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOVED_WITHOUT_APPROVAL, advisoryLines, evaluateGate, failingLines, pendingAdoptions, type GateInput, type Measurement } from "../../src/cadwork/gate";
import type { PartLock, RulesLock } from "../../src/cadwork/locks";
import { partRef } from "../../src/cadwork/partfolder";
import { evaluateExpectations, lockedBlockSha, stampExpectations, type PartFile } from "../../src/cadwork/partfile";
import { validateRules, type RulesRead } from "../../src/cadwork/rules";
import { PLATE_EXPECTATIONS, RULES, approveCards, buildPlate, cleanupTemp, fakeCadSession, stopServices, tempDir, tempRepo, writeRules } from "../helpers/cad-work";
import { NOT_MEASURED } from "../../src/session/cadwork-service";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";

afterEach(async () => {
  await stopServices();
  cleanupTemp();
});

const PARAMS = { L: 80, W: 50, T: 6, inset: 8 };
const EXP = stampExpectations(PLATE_EXPECTATIONS as any, "agent-initial", "2026-11-19T10:00:00.000Z");
const FILE: PartFile = { schema: 1, process: "fdm-0.4", status: "dimensioned", expectations: EXP };
const VALUES = evaluateExpectations(EXP, PARAMS);
const LOCK: PartLock = { repo: "r", part: "plate", sha: lockedBlockSha(FILE), approvedBy: "agent-initial", status: "dimensioned", values: VALUES, at: "2026-11-19T10:00:00.000Z" };
const RULES_TEXT = JSON.stringify(RULES);
const RULES_READ: RulesRead = { kind: "ok", file: (validateRules(RULES) as any).file, text: RULES_TEXT, sha: "rules-sha" };
const RULES_LOCK: RulesLock = { repo: "r", sha: "rules-sha", text: RULES_TEXT, at: "2026-11-19T10:00:00.000Z" };
const MEASURED: Measurement = { bbox: [6, 50, 80], volume: VALUES.volume, faces: 22, bodies: 1, holes: [{ diameter: 3.4, count: 4, kind: "through" }], scriptSha: "script-1", solidcraft: "0.44.1" };
const input = (more: Partial<GateInput> = {}): GateInput => ({
  part: { kind: "ok", file: FILE, text: "" },
  lock: LOCK,
  rules: RULES_READ,
  rulesLock: RULES_LOCK,
  params: PARAMS,
  measurement: MEASURED,
  scriptSha: "script-1",
  solidcraft: "0.44.1",
  featureErrors: [],
  warnings: [],
  ...more,
});
const withFile = (file: PartFile, lock: PartLock | undefined = { ...LOCK, sha: lockedBlockSha(file) }) => input({ part: { kind: "ok", file, text: "" }, lock });
const failing = (i: GateInput) => evaluateGate(i).checks.filter((c) => c.hard && !c.ok).map((c) => c.id);

describe("cad gate (evaluateGate)", () => {
  test("[A2] GateResult has exactly the spec's shape, and a part that matches everything passes", () => {
    const r = evaluateGate(input());
    // `approvedBy` (A2 review item 10): who approved the numbers, present while an approval is in force.
    expect(Object.keys(r).sort()).toEqual(["approvedBy", "checks", "staleBuild", "state", "warnings"]);
    expect(r.approvedBy).toBe(LOCK.approvedBy);
    expect(r.state).toBe("pass");
    expect(r.staleBuild).toBe(false);
    expect(r.needsAdoption).toBeUndefined();
    for (const c of r.checks) {
      expect(Object.keys(c).sort()).toEqual(["expected", "hard", "id", "measured", "ok"]);
      expect(c.ok).toBe(true);
    }
    // Every hard check of §4.5 is present.
    const ids = r.checks.map((c) => c.id);
    for (const id of ["lock.expectations", "lock.rules", "tolerance.length", "tolerance.volumeRel", "accepted", "features", "bbox.min", "bbox.mid", "bbox.max", "volume", "bodies", "holes ⌀3.4 count", "holes.unexpected", "rules.process", "rules.envelope"]) {
      expect(ids).toContain(id);
    }
    expect(failingLines(r)).toEqual([]);
  });

  test("[A2] gate code that throws gives unverified, never pass (fail closed)", () => {
    const boom = evaluateGate(input(), () => {
      throw new Error("kaboom");
    });
    expect(boom.state).toBe("unverified");
    expect(boom.checks).toHaveLength(1);
    expect(boom.checks[0]).toMatchObject({ id: "gate", ok: false, hard: true });
    expect(String(boom.checks[0]!.measured)).toContain("kaboom");
    // A gate that returns nonsense is treated the same way.
    expect(evaluateGate(input(), () => undefined as never).state).toBe("unverified");
    expect(evaluateGate(input(), () => ({ state: "definitely", checks: [], warnings: [], staleBuild: false }) as never).state).toBe("unverified");
    // An input the real gate cannot digest also fails closed instead of throwing.
    const broken = evaluateGate({ ...input(), part: { kind: "ok", file: null as never, text: "" } });
    expect(broken.state).toBe("unverified");
    expect(broken.checks[0]!.id).toBe("gate");
  });

  test("[A2] a corrupt part.json or a wrong schema is unverified with the parse error", () => {
    const r = evaluateGate(input({ part: { kind: "invalid", error: "part.json is not valid JSON: Unexpected token", text: "{" } }));
    expect(r.state).toBe("unverified");
    const c = r.checks.find((x) => x.id === "part.json")!;
    expect(c.ok).toBe(false);
    expect(String(c.measured)).toContain("not valid JSON");
    // No expectations at all, and no measurement yet, are unverified too.
    expect(evaluateGate(input({ part: { kind: "missing" }, lock: undefined })).state).toBe("unverified");
    expect(failing(input({ part: { kind: "missing" }, lock: undefined }))).toContain("expectations");
    expect(evaluateGate(input({ measurement: undefined, measureError: "could not measure: boom" })).state).toBe("unverified");
    expect(String(evaluateGate(input({ measurement: undefined, measureError: "could not measure: boom" })).checks.find((x) => x.id === "measured")!.measured)).toContain("boom");
    // A measurement of an older script is not a measurement of this design.
    const stale = evaluateGate(input({ scriptSha: "script-2" }));
    expect(stale.state).toBe("unverified");
    expect(String(stale.checks.find((x) => x.id === "measured")!.measured)).toContain("older version");
  });

  test("[A2] lock-store hashes must match: a changed part.json, ownerParams or rules.json is unverified with needsAdoption", () => {
    // The file says the owner locked it — but the store never saw that block.
    const forged = evaluateGate(input({ part: { kind: "ok", file: { ...FILE, expectations: { ...EXP, lockedBy: "owner", volume: 1 } }, text: "" } }));
    expect(forged.state).toBe("unverified");
    expect(forged.needsAdoption).toBe("expectations");
    expect(forged.checks.find((c) => c.id === "lock.expectations")!.ok).toBe(false);
    // A fresh clone / another machine: nothing in the store at all.
    const unknown = evaluateGate(input({ lock: undefined }));
    expect(unknown.state).toBe("unverified");
    expect(unknown.needsAdoption).toBe("expectations");
    // The process and the status are part of what was approved.
    expect(evaluateGate(input({ part: { kind: "ok", file: { ...FILE, process: "cnc-3axis" }, text: "" } })).needsAdoption).toBe("expectations");
    expect(evaluateGate(input({ part: { kind: "ok", file: { ...FILE, status: "concept" }, text: "" } })).needsAdoption).toBe("expectations");
    // Deleting part.json after approval does not reset anything.
    expect(String(evaluateGate(input({ part: { kind: "missing" } })).checks.find((c) => c.id === "part.json")!.measured)).toContain("restore it from git");

    const params = evaluateGate(withFile({ ...FILE, ownerParams: { L: 90 } }, { ...LOCK, ownerParams: { L: 80 } }));
    expect(params.state).toBe("unverified");
    expect(params.needsAdoption).toBe("ownerParams");
    expect(evaluateGate(withFile({ ...FILE, ownerParams: { L: 80 } }, { ...LOCK, ownerParams: { L: 80 } })).state).toBe("pass");

    for (const rulesLock of [undefined, { ...RULES_LOCK, sha: "an-older-file" }]) {
      const r = evaluateGate(input({ rulesLock }));
      expect(r.state).toBe("unverified");
      expect(r.needsAdoption).toBe("rules");
      expect(r.checks.find((c) => c.id === "lock.rules")!.ok).toBe(false);
    }
    // Several at once: the result names the first, and all are discoverable.
    const both = evaluateGate(input({ lock: undefined, rulesLock: undefined }));
    expect(both.needsAdoption).toBe("expectations");
    expect(pendingAdoptions(both)).toEqual(["expectations", "rules"]);
    expect(pendingAdoptions(evaluateGate(input()))).toEqual([]);
    // No rules file at all is a plain failure, with the way out stated.
    const none = evaluateGate(input({ rules: { kind: "missing" }, rulesLock: undefined }));
    expect(none.state).toBe("fail");
    expect(String(none.checks.find((c) => c.id === "rules.file")!.measured)).toContain("propose a starter file");
  });

  test("[A2] tolerances are capped at 0.1 mm and 1% on every evaluation, even when the loose block was approved", () => {
    for (const [tolerance, id] of [
      [{ length: 1.0, volumeRel: 0.001 }, "tolerance.length"],
      [{ length: 0.01, volumeRel: 0.5 }, "tolerance.volumeRel"],
      [{ length: 0.11, volumeRel: 0.001 }, "tolerance.length"],
    ] as const) {
      const loose: PartFile = { ...FILE, expectations: { ...EXP, tolerance: { ...tolerance } } };
      const r = evaluateGate(withFile(loose)); // the lock MATCHES: the owner adopted it
      expect(r.state).toBe("fail");
      expect(failingLines(r).join("\n")).toContain(id);
      expect(r.needsAdoption).toBeUndefined();
    }
    // Exactly at the caps is allowed.
    expect(evaluateGate(withFile({ ...FILE, expectations: { ...EXP, tolerance: { length: 0.1, volumeRel: 0.01 } } })).state).toBe("pass");
    // A loosened tolerance does not hide a real mismatch behind the cap failure either.
    const off = evaluateGate({ ...withFile({ ...FILE, expectations: { ...EXP, tolerance: { length: 5, volumeRel: 0.9 } } }), measurement: { ...MEASURED, bbox: [6, 50, 82], volume: VALUES.volume * 1.5 } });
    expect(failing({ ...withFile({ ...FILE, expectations: { ...EXP, tolerance: { length: 5, volumeRel: 0.9 } } }), measurement: { ...MEASURED, bbox: [6, 50, 82], volume: VALUES.volume * 1.5 } })).toEqual(expect.arrayContaining(["tolerance.length", "tolerance.volumeRel", "bbox.max", "volume"]));
    expect(off.state).toBe("fail");
  });

  test("[A2] accepted numbers are held: a formula that now evaluates differently fails with old and new listed, and the old numbers stay the target", () => {
    // The agent set L=120: the formulas follow, the accepted numbers do not.
    const grown = { ...MEASURED, bbox: [6, 50, 120] as [number, number, number], volume: evaluateExpectations(EXP, { ...PARAMS, L: 120 }).volume };
    const r = evaluateGate(input({ params: { ...PARAMS, L: 120 }, measurement: grown }));
    expect(r.state).toBe("fail");
    const moved = r.checks.find((c) => c.id === "accepted")!;
    expect(moved.ok).toBe(false);
    expect(String(moved.measured)).toContain(MOVED_WITHOUT_APPROVAL);
    expect(MOVED_WITHOUT_APPROVAL).toBe("expected value moved without owner approval");
    expect(String(moved.measured)).toContain("bbox[2] 80 → 120");
    expect(String(moved.measured)).toContain("volume 23335.167 → 35335.167");
    // The geometry is still judged against what was ACCEPTED (80), so it fails there too.
    expect(r.checks.find((c) => c.id === "bbox.max")).toMatchObject({ expected: 80, measured: 120, ok: false });
    // Once the owner accepts the new numbers (the lock store's values), the same state passes.
    const accepted = evaluateGate(input({ params: { ...PARAMS, L: 120 }, measurement: grown, lock: { ...LOCK, values: evaluateExpectations(EXP, { ...PARAMS, L: 120 }) } }));
    expect(accepted.state).toBe("pass");
    // A formula that cannot be evaluated is a failure, not a skipped check.
    const lost = evaluateGate(input({ params: { L: 80 } }));
    expect(lost.state).toBe("fail");
    expect(String(lost.checks.find((c) => c.id === "expectations.formulas")!.measured)).toContain("unknown parameter `W`");
  });

  test("[A2] no timeline feature may have an error, whatever the numbers say", () => {
    const r = evaluateGate(input({ featureErrors: [{ feature: "Corners", message: "the fillet is larger than the faces beside its edges allow" }] }));
    expect(r.state).toBe("fail");
    const c = r.checks.find((x) => x.id === "features")!;
    expect(c).toMatchObject({ ok: false, hard: true });
    expect(String(c.measured)).toContain("Corners: the fillet is larger");
    expect(failing(input({ designFailure: "design changed on disk during a change" }))).toEqual(["design"]);
  });

  test("[A2] sorted bounding box, volume, body count and the hole table are each a hard check within tolerance", () => {
    const m = (more: Partial<Measurement>) => input({ measurement: { ...MEASURED, ...more } });
    expect(failing(m({ bbox: [6, 50, 80.02] }))).toEqual(["bbox.max"]);
    expect(failing(m({ bbox: [6, 50, 80.009] }))).toEqual([]); // inside 0.01 mm
    expect(failing(m({ bbox: [6.5, 50, 80] }))).toEqual(["bbox.min"]);
    expect(failing(m({ volume: VALUES.volume * 1.002 }))).toEqual(["volume"]);
    expect(failing(m({ volume: VALUES.volume * 1.0005 }))).toEqual([]); // inside 0.1 %
    expect(failing(m({ bodies: 2 }))).toEqual(["bodies"]);
    expect(failing(m({ holes: [{ diameter: 3.4, count: 3, kind: "through" }] }))).toEqual(["holes ⌀3.4 count"]);
    expect(failing(m({ holes: [] }))).toEqual(["holes ⌀3.4 count"]);
    expect(failing(m({ holes: [{ diameter: 3.4, count: 4, kind: "through" }, { diameter: 5, count: 1, kind: "blind" }] }))).toEqual(["holes.unexpected"]);
    expect(failing(m({ holes: [{ diameter: 3.6, count: 4, kind: "through" }] }))).toEqual(["holes ⌀3.4 count", "holes.unexpected"]);
    // The expected box is compared SORTED, so the part's orientation does not matter.
    const rotated: PartFile = { ...FILE, expectations: { ...EXP, bbox: ["T", "L", "W"] } };
    expect(evaluateGate(withFile(rotated, { ...LOCK, sha: lockedBlockSha(rotated) })).state).toBe("pass");
    // An optional hole kind narrows the row.
    const blindOnly: PartFile = { ...FILE, expectations: { ...EXP, holes: [{ diameter: 3.4, count: 4, kind: "blind" }] } };
    const kinds = evaluateGate(withFile(blindOnly, { ...LOCK, sha: lockedBlockSha(blindOnly), values: evaluateExpectations(blindOnly.expectations!, PARAMS) }));
    expect(kinds.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["holes ⌀3.4 blind count", "holes.unexpected"]);
    const line = failingLines(evaluateGate(m({ volume: 23737.2209, holes: [{ diameter: 3.4, count: 1, kind: "through" }] })));
    expect(line).toEqual(["volume: expected 23335.167, measured 23737.2209", "holes ⌀3.4 count: expected 4, measured 1"]);
  });

  test("[A2] the rules of the part's process are hard checks; advisories are listed and never change the state", () => {
    const tiny = { schema: 1, processes: [{ id: "fdm-0.4", kind: "fdm", envelope: [60, 60, 60] }] };
    const small = evaluateGate(input({ rules: { kind: "ok", file: tiny as any, text: "", sha: "rules-sha" } }));
    expect(small.state).toBe("fail");
    expect(failingLines(small)).toEqual(["rules.envelope: expected fits 60 × 60 × 60 mm (fdm-0.4), measured 6 × 50 × 80 mm"]);
    const unknown = evaluateGate(withFile({ ...FILE, process: "sla" }));
    expect(unknown.state).toBe("fail");
    expect(failingLines(unknown).join()).toContain('unknown process "sla"');
    const advice = { schema: 1, processes: [{ id: "fdm-0.4", kind: "fdm", envelope: [250, 210, 220], minWall: 1.2 }] };
    const advised = evaluateGate(input({ rules: { kind: "ok", file: advice as any, text: "", sha: "rules-sha" } }));
    expect(advised.state).toBe("pass");
    expect(advisoryLines(advised)).toEqual(["rules.minWall: walls at least 1.2 mm — not measured: SolidCraft cannot measure wall thickness, so check this by eye"]);
    const invalid = evaluateGate(input({ rules: { kind: "invalid", error: "rules.json is not valid JSON", text: "{", sha: "rules-sha" } }));
    expect(invalid.state).toBe("fail");
    expect(failing(input({ rules: { kind: "invalid", error: "x", text: "{", sha: "rules-sha" } }))).toEqual(["rules.file"]);
  });

  test("[A2] staleBuild is set when the measurement was taken under a different SolidCraft version, and a concept part is never pass", () => {
    expect(evaluateGate(input({ solidcraft: "0.45.0" })).staleBuild).toBe(true);
    expect(evaluateGate(input({ solidcraft: "0.45.0" })).state).toBe("pass"); // a flag, not a verdict
    expect(evaluateGate(input({ solidcraft: "0.44.1" })).staleBuild).toBe(false);
    expect(evaluateGate(input({ measurement: undefined })).staleBuild).toBe(false);
    const concept: PartFile = { ...FILE, status: "concept" };
    expect(evaluateGate(withFile(concept, { ...LOCK, sha: lockedBlockSha(concept), status: "concept" })).state).toBe("concept");
  });
});

const CLI = FAKE_SOLIDCRAFT;

describe("cad gate (the refresh, against the fake)", () => {
  test("[A2] the refresh measures, evaluates, writes part.json.measured and sets PartState to pass", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: CLI });
    expect(x.gate.state).toBe("pass");
    expect(x.gate.failing).toEqual([]);
    const ref = partRef(repo, "plate");
    expect(x.manager.status(ref)!.state.status).toBe("pass");
    expect(x.manager.status(ref)!.refreshPending).toBe(false);
    const file = JSON.parse(readFileSync(x.partJson, "utf8"));
    expect(file.measured).toMatchObject({ solidcraft: "0.44.1", bbox: [6, 50, 80], faces: 22, bodies: 1, holes: [{ diameter: 3.4, count: 4, kind: "through" }], warnings: [] });
    expect(file.measured.volume).toBeCloseTo(23335.167, 2);
    expect(file.measured.scriptSha).toBe(x.manager.status(ref)!.scriptSha);
    expect(file.expectations.lockedBy).toBe("agent-initial"); // the gate never writes expectations
    // A change makes it unverified again until the next refresh has run.
    await x.tools.execute!({ command: "solid.box", params: { length: 1, width: 1, height: 1, corner: [200, 200, 200] } });
    expect((await x.check()).state).toBe("fail"); // a second body now
    expect(x.manager.status(ref)!.state.status).toBe("fail");
    // The broadcast carries the same result (post-step 5).
    const ev = x.design("plate");
    expect(ev).toMatchObject({ type: "cad.design", cwd: repo, part: "plate", by: "agent", sessionIds: ["sess_cad"] });
    expect(ev.gate.state).toBe("fail");
    expect(ev.rev).toBeGreaterThan(1);
    expect(ev.preview).toBe(`cad/plate/.cache/preview-${ev.rev}.glb`); // Phase A3: every refresh of a part with geometry writes a preview
    expect(ev.params.map((p: any) => p.name)).toEqual(["L", "W", "T", "inset"]);
  });

  test("[A2] a refresh that throws, or a gate that throws, leaves the part unverified and never pass", async () => {
    const repo = tempRepo();
    let explode = false;
    const x = await buildPlate(repo, {
      cli: CLI,
      deps: {
        beforeMeasure: () => {
          if (explode) throw new Error("measure blew up");
        },
      },
    });
    expect(x.gate.state).toBe("pass");
    explode = true;
    const after = await x.check();
    expect(after.state).toBe("unverified");
    expect(after.failing.join()).toContain("measure blew up");
    expect(x.manager.status(partRef(repo, "plate"))!.state.status).toBe("unverified");

    const repo2 = tempRepo();
    const y = await buildPlate(repo2, {
      cli: CLI,
      deps: {
        gateImpl: () => {
          throw new Error("gate blew up");
        },
      },
    });
    expect(y.gate.state).toBe("unverified");
    expect(y.gate.failing.join()).toContain("gate blew up");
    expect(y.manager.status(partRef(repo2, "plate"))!.state.status).toBe("unverified");
  });

  test("[A2] a corrupt part.json makes the part unverified with the parse error, and the file is not overwritten", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: CLI });
    expect(x.gate.state).toBe("pass");
    for (const text of ['{ "schema": 1, "process": ', JSON.stringify({ schema: 7, process: "fdm-0.4", status: "dimensioned" })]) {
      writeFileSync(x.partJson, text);
      const g = await x.check();
      expect(g.state).toBe("unverified");
      expect(g.failing.join("\n")).toContain("part.json");
      expect(readFileSync(x.partJson, "utf8")).toBe(text); // no measurement written over it
      // Modeling is refused while it is unreadable, and that does not touch it either.
      const refused = await x.tools.execute!({ command: "solid.box", params: { length: 1, width: 1, height: 1 } });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("cannot be read");
      expect(readFileSync(x.partJson, "utf8")).toBe(text);
    }
    expect((await x.check()).failing.join("\n")).toContain("schema 7");
  });

  test("[A2] a Boolean retry warning with matching numbers passes, with the warning listed", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: CLI, deps: { manager: { extraEnv: { FAKE_SC_WARN_ON: "solid.hole" } } } });
    expect(x.gate.state).toBe("pass");
    expect(x.gate.warnings).toHaveLength(1);
    expect(x.gate.warnings[0]).toContain("Hole: Boolean retry");
    expect(JSON.parse(readFileSync(x.partJson, "utf8")).measured.warnings).toEqual(x.gate.warnings);
    expect(x.design("plate").gate.warnings).toEqual(x.gate.warnings);
  });

  test("[A2] only design bodies are measured: an imported reference body (BaseFeature) is left out of volume, box and body count", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: CLI });
    const ref = partRef(repo, "plate");
    mkdirSync(join(ref.dir, "refs"), { recursive: true });
    writeFileSync(join(ref.dir, "refs", "motor.step"), "ISO-10303-21;\n");
    // The import route is the daemon's own (Phase A4's import_reference); the agent's execute refuses it.
    expect((await x.tools.execute!({ command: "file.insert_step", params: { path: join(ref.dir, "refs", "motor.step") } })).isError).toBe(true);
    const inserted = await x.manager.request(ref, { tool: "execute", args: { command: "file.insert_step", params: { path: join(ref.dir, "refs", "motor.step") } }, kind: "mutate" });
    expect(inserted.result.isError).toBe(false);
    const all = (await x.tools.measure!({ summary: true })).json;
    expect(all.body_count).toBe(2); // SolidCraft's own measure counts the reference
    const g = await x.check();
    expect(g.state).toBe("pass");
    const measured = JSON.parse(readFileSync(x.partJson, "utf8")).measured;
    expect(measured.bodies).toBe(1);
    expect(measured.bbox).toEqual([6, 50, 80]);
    expect(measured.volume).toBeCloseTo(23335.167, 2);
    expect(all.total.volume_mm3).toBeGreaterThan(measured.volume + 900);
  });

  test("[A2] a fresh clone or another machine: an approved part is unverified with an adopt card, and one approval restores pass", async () => {
    const repo = tempRepo();
    const first = await buildPlate(repo, { cli: CLI });
    expect(first.gate.state).toBe("pass");
    // "Another machine": a second daemon with its own (empty) lock store opens the same committed files.
    const other = fakeCadSession(repo, { resolveCli: () => ({ path: CLI, source: "env" }), stateDir: tempDir("anvil-cad-other-machine-") }, "sess_other", { expectations: "manual" });
    await other.tools.open_part!({ part: "plate" });
    const g = (await other.tools.check_part!({ part: "plate" })).json;
    expect(g.state).toBe("unverified");
    expect(g.needsAdoption).toBe("expectations");
    const cards = other.openCards();
    expect(cards.map((c: any) => c.kind).sort()).toEqual(["adopt-expectations", "adopt-rules"]);
    const card = cards.find((c: any) => c.kind === "adopt-expectations");
    expect(card).toMatchObject({ type: "cad.expectations.request", sessionId: "sess_other", part: "plate", cwd: repo });
    expect(card.rows.find((r: any) => r.label === "Bounding box (mm)").new).toBe("L × W × T  (= 6 × 50 × 80)");
    expect(card.rows.find((r: any) => r.label === "Process").new).toBe("fdm-0.4");
    expect(card.suggestions).toBeUndefined(); // Approve / Deny only: there is no "always allow" to offer
    // Checking again does not stack up duplicate cards.
    await other.tools.check_part!({ part: "plate" });
    expect(other.openCards()).toHaveLength(2);
    // Deny leaves it unverified (and asks again on the next check); Approve restores pass.
    other.service.respond(card.requestId, false);
    expect((await other.tools.check_part!({ part: "plate" })).json.state).toBe("unverified");
    expect(approveCards(other).sort()).toEqual(["adopt-expectations", "adopt-rules"]);
    expect((await other.tools.check_part!({ part: "plate" })).json.state).toBe("pass");
    expect(other.service.locks.getPart(repo, "plate")!.approvedBy).toBe("owner");
    expect(other.openCards()).toEqual([]);
  });

  test("[A2] review 6: numbers stored in part.json are never a pass — a part not measured in this session is unverified, whatever `measured` says", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: CLI });
    const ref = partRef(repo, "plate");
    const sha = x.manager.status(ref)!.scriptSha;
    expect(x.gate.state).toBe("pass"); // live, measured now: a real pass
    const good = JSON.parse(readFileSync(x.partJson, "utf8")).measured;
    // The reviewer's repro: break the plate (the live gate fails)…
    await x.tools.undo!({});
    expect((await x.check()).state).toBe("fail");
    // …then put the earlier GOOD measurement back into part.json, as Bash could, with the current script's sha.
    const file = JSON.parse(readFileSync(x.partJson, "utf8"));
    writeFileSync(x.partJson, JSON.stringify({ ...file, measured: { ...good, scriptSha: x.manager.status(ref)!.scriptSha } }, null, 2) + "\n");
    const live = x.manager.liveCount();
    for (const script of [x.manager.status(ref)!.scriptSha, sha, "a-different-script", undefined]) {
      const g = x.service.gateFromDisk(ref, script);
      expect(g.state).toBe("unverified");
      expect(g.checks.find((c) => c.id === "measured")).toMatchObject({ ok: false, measured: NOT_MEASURED });
      expect(g.checks.some((c) => c.id === "volume")).toBe(false); // the stored numbers are not even compared
    }
    expect(x.manager.liveCount()).toBe(live); // and it started nothing
    // A parts list says the same of a part whose process is not up, and refreshes one that is.
    const listed = await x.service.listParts(repo);
    expect(listed.find((p) => p.part === "plate")!.gate.state).toBe("fail"); // live: measured again, the forged numbers ignored
    await stopServices();
    const cold = fakeCadSession(repo, { resolveCli: () => ({ path: CLI, source: "env" }) }, "sess_cold", { expectations: "manual" });
    const coldList = await cold.service.listParts(repo);
    expect(coldList.find((p) => p.part === "plate")).toMatchObject({ live: false, gate: { state: "unverified" } });
    expect(cold.manager.liveCount()).toBe(0);
  });
});
