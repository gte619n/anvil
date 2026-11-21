/**
 * [A4] Real-tool suite for Phase A4 (agent-cad-and-browser spec §8.3): references, interference and
 * the release pack on the REAL `solidcraft-cli`, through the real service, manager, refresh and lock
 * store and the real agent tools. Skipped unless `ANVIL_REAL_TOOLS=1` (`bun test/tools/phase-gate.ts
 * A4 --require-real` sets it and fails on any skip).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { partRef } from "../../src/cadwork/partfolder";
import { DUPLICATE_REFERENCE, REFERENCE_CHANGED, REFERENCE_MOVED, REFERENCE_NOT_GROUNDED, REFERENCE_RESHAPED, importFeatureName } from "../../src/cadwork/refs";
import { DESIGN_PLACED_ONCE, REFERENCE_NOT_COVERED, REFERENCE_NOT_RECORDED, REFERENCE_PLACED_ONCE } from "../../src/cadwork/refresh";
import { expectedReleaseFiles, MANIFEST } from "../../src/cadwork/release";
import { PLATE_EXPECTATIONS, buildPlate, cleanupTemp, stopServices, tempRepo, type ToolReply } from "../helpers/cad-work";
import { repoIdentity } from "../../src/cadwork/locks";
import { UNAPPROVED_PARAMETER } from "../../src/session/cadwork-service";
import { REAL, SOLIDCRAFT_CLI, hasSolidcraft } from "../helpers/real-tools";
import { runVerifyCli } from "../helpers/cad-verify";

afterEach(async () => {
  await stopServices();
  cleanupTemp();
});

type X = Awaited<ReturnType<typeof buildPlate>>;
async function asOwner(x: X, call: Promise<ToolReply>, approve = true, shown: any[] = []): Promise<ToolReply> {
  let settled = false;
  void call.finally(() => (settled = true));
  const seen = new Set<string>();
  while (!settled) {
    for (const c of x.openCards()) {
      if (seen.has(c.requestId)) continue;
      seen.add(c.requestId);
      shown.push(c);
      x.service.respond(c.requestId, approve);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return call;
}
/** Like asOwner, but the i-th card (0-based) is answered by `answer(i)`. */
async function asOwnerEach(x: X, call: Promise<ToolReply>, answer: (i: number) => boolean, shown: any[] = []): Promise<ToolReply> {
  let settled = false;
  void call.finally(() => (settled = true));
  const seen = new Set<string>();
  while (!settled) {
    for (const c of x.openCards()) {
      if (seen.has(c.requestId)) continue;
      seen.add(c.requestId);
      shown.push(c);
      x.service.respond(c.requestId, answer(shown.length - 1));
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return call;
}
const row = (card: any, label: string) => card.rows.find((r: any) => r.label === label);
const must = async (p: Promise<ToolReply>): Promise<ToolReply> => {
  const r = await p;
  if (r.isError) throw new Error(r.text);
  return r;
};

/** A 10 mm block exported to STEP by the REAL binary, as its own part, at `corner`. */
async function blockStep(x: X, repo: string, part: string, corner: number[]): Promise<string> {
  await must(x.tools.open_part!({ part }));
  await must(x.tools.record_expectations!({ part, process: "fdm-0.4", parameters: {}, expectations: { bbox: [10, 10, 10], volume: 1000, bodies: 1, holes: [] } }));
  await must(x.tools.execute!({ command: "solid.box", params: { length: 10, width: 10, height: 10, corner, name: "Block" } }));
  const r = await must(x.tools.export_part!({ part, formats: ["step"] }));
  return join(repo, r.json.exports[0].path);
}

describe("real SolidCraft: references and the release pack", () => {
  test.skipIf(!REAL)("[A4] real: a STEP block imported as a reference into the plate it overlaps fails the gate on interference with a volume; re-imported clear it passes; the reference body is a BaseFeature body, excluded from the measurement", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    expect(x.gate.state).toBe("pass");
    const near = await blockStep(x, repo, "block", [0, 0, 0]); // inside the plate's corner region (plate: x ±40, y ±25, z 0…6)
    const far = await blockStep(x, repo, "far", [100, 0, 0]);
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    copyFileSync(near, join(repo, ".anvil-downloads", "block.step"));
    await must(x.tools.open_part!({ part: "plate" }));
    const imp = await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }));
    expect(imp.isError).toBe(false);
    expect(imp.json.imported).toBe(true);
    const refBody = imp.json.bodies[0];
    // The real binary marks the import's body as made by a BaseFeature, so it is not measured as the part.
    const insp = (await x.tools.inspect_design!({ measure: false, sketches: false, timeline: "summary", bodies: true })).json;
    const feat = insp.bodies.find((b: any) => b.name === refBody).feature;
    expect(insp.timeline.find((f: any) => f.id === feat).type).toBe("BaseFeature");
    let g = await x.check();
    expect(g.state).toBe("fail");
    const hit = g.checks.find((c: any) => c.id === "interference block.step");
    expect(hit.ok).toBe(false);
    expect(hit.measured).toMatch(new RegExp(`overlaps ${refBody} by 600 mm³`));
    for (const id of ["volume", "bbox.max", "bodies", "holes ⌀3.4 count"]) expect(g.checks.find((c: any) => c.id === id).ok).toBe(true);
    // The embedded text is the file's bytes.
    const design = JSON.parse(readFileSync(join(repo, "cad", "plate", "design.json"), "utf8"));
    const embedded = design.commands.find((c: any) => c.command === "timeline.add" && c.params.feature.type === "import").params.feature;
    expect(new Bun.CryptoHasher("sha256").update(embedded.step).digest("hex")).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(join(repo, "cad", "plate", "refs", "block.step"))).digest("hex"));
    // Moved clear: the same reference, re-imported from its new position.
    copyFileSync(far, join(repo, ".anvil-downloads", "block.step"));
    expect((await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }))).json.replaced).toBe(true);
    g = await x.check();
    expect(g.failing).toEqual([]);
    expect(g.state).toBe("pass");
    expect(g.checks.find((c: any) => c.id === "interference block.step")).toMatchObject({ ok: true, measured: "no overlap" });
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: editing refs/x.step makes the part unverified ('reference changed; re-import') — the sha of refs/ against the embedded text", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const far = await blockStep(x, repo, "far", [100, 0, 0]);
    mkdirSync(join(repo, "vendor"), { recursive: true });
    copyFileSync(far, join(repo, "vendor", "far.step"));
    await must(x.tools.open_part!({ part: "plate" }));
    await asOwner(x, x.tools.import_reference!({ part: "plate", file: "vendor/far.step" }));
    expect((await x.check()).state).toBe("pass");
    const p = join(repo, "cad", "plate", "refs", "far.step");
    const orig = readFileSync(p);
    writeFileSync(p, Buffer.concat([orig, Buffer.from("\n")]));
    const g = await x.check();
    expect(g.state).toBe("unverified");
    expect(g.failing.join("\n")).toContain(REFERENCE_CHANGED);
    writeFileSync(p, orig);
    expect((await x.check()).state).toBe("pass");
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: review — the agent sets L=120, then proposes only a tighter tolerance: the card shows the accepted numbers and L as its own row; denied the gate still fails on L, approved it passes with L accepted by the owner", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    expect(x.gate.state).toBe("pass");
    await must(x.tools.set_parameter!({ name: "L", expression: "120" }));
    expect((await x.check()).failing.join("\n")).toContain("L 80 → 120");
    const tighter = { ...PLATE_EXPECTATIONS, tolerance: { length: 0.05 } };
    const shown: any[] = [];
    await asOwner(x, x.tools.propose_expectations!({ part: "plate", expectations: tighter, reason: "tighter length tolerance" }), false, shown);
    expect(row(shown[0], "Bounding box (mm)").old).toBe("L × W × T  (= 6 × 50 × 80)");
    expect(row(shown[0], "Parameter L")).toMatchObject({ old: "80", new: `120 (${UNAPPROVED_PARAMETER})`, unapproved: true });
    let g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain("L 80 → 120");
    const r = await asOwner(x, x.tools.propose_expectations!({ part: "plate", expectations: tighter, reason: "tighter length tolerance" }));
    expect(r.isError).toBe(false);
    g = await x.check();
    expect(g.failing).toEqual([]);
    expect(g.state).toBe("pass");
    expect(g.approvedBy).toBe("owner");
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")!.declared).toMatchObject({ L: 120, W: 50, T: 6 });
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: review — the agent sets L=120, then imports a clear reference: the card shows the accepted numbers and L as its own row; denied nothing is imported and the gate fails on L, approved it passes with L accepted", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const far = await blockStep(x, repo, "far", [200, 0, 0]);
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    copyFileSync(far, join(repo, ".anvil-downloads", "far.step"));
    await must(x.tools.open_part!({ part: "plate" }));
    await must(x.tools.set_parameter!({ name: "L", expression: "120" }));
    const shown: any[] = [];
    const no = await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/far.step" }), false, shown);
    expect(no.json.imported).toBe(false);
    expect(row(shown[0], "Bounding box (mm)").old).toBe("L × W × T  (= 6 × 50 × 80)");
    expect(row(shown[0], "Parameter L")).toMatchObject({ old: "80", new: `120 (${UNAPPROVED_PARAMETER})`, unapproved: true });
    expect(row(shown[0], "Reference").new).toMatch(/^adds refs\/far\.step \(sha [0-9a-f]{12}, 1 body\)$/); // the real STEP declares its one solid
    expect((await x.check()).failing.join("\n")).toContain("L 80 → 120");
    const yes = await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/far.step" }));
    expect(yes.json.imported).toBe(true);
    const g = await x.check();
    expect(g.failing).toEqual([]);
    expect(g.state).toBe("pass");
    expect(g.approvedBy).toBe("owner");
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")!.declared).toMatchObject({ L: 120, W: 50, T: 6 });
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: re-review — the card shows Process fdm-0.4; part.json is rewritten to cnc-3axis while the approved import runs: nothing is recorded, the import is rolled back in full and cannot be redone, the redrawn card shows cnc-3axis, the gate does not pass", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    let armed: (() => void) | undefined;
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI, deps: { manager: { beforeScriptRename: () => { const f = armed; armed = undefined; f?.(); } } } });
    expect(x.gate.state).toBe("pass");
    const far = await blockStep(x, repo, "far", [200, 0, 0]);
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    copyFileSync(far, join(repo, ".anvil-downloads", "far.step"));
    await must(x.tools.open_part!({ part: "plate" }));
    const lockBefore = x.service.locks.findPart(repoIdentity(repo), "plate")!;
    const designPath = join(repo, "cad", "plate", "design.json");
    const scriptBefore = readFileSync(designPath, "utf8");
    // Inside the import (the part's queue held), part.json is rewritten — what a Bash edit can do.
    armed = () => {
      const pj = JSON.parse(readFileSync(x.partJson, "utf8"));
      pj.process = "cnc-3axis";
      writeFileSync(x.partJson, JSON.stringify(pj, null, 2) + "\n");
    };
    const shown: any[] = [];
    const r = await asOwnerEach(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/far.step" }), (i) => i === 0, shown);
    expect(shown).toHaveLength(2);
    expect(row(shown[0], "Process")).toMatchObject({ old: "fdm-0.4", new: "fdm-0.4" });
    expect(row(shown[1], "Process")).toMatchObject({ old: "cnc-3axis", new: "cnc-3axis" });
    expect(row(shown[1], "Reference").new).toMatch(/^adds refs\/far\.step/);
    expect(r.json.imported).toBe(false);
    expect(x.service.locks.findPart(repoIdentity(repo), "plate")).toEqual(lockBefore);
    const pj = JSON.parse(readFileSync(x.partJson, "utf8"));
    expect(pj.refs ?? []).toEqual([]);
    expect(pj.expectations.noInterferenceWith ?? []).toEqual([]);
    expect(existsSync(join(repo, "cad", "plate", "refs", "far.step"))).toBe(false);
    expect(readFileSync(designPath, "utf8")).toBe(scriptBefore);
    const insp = (await x.tools.inspect_design!({ measure: false, sketches: false, timeline: "summary", bodies: true })).json;
    expect(insp.timeline.filter((f: any) => f.type === "BaseFeature")).toEqual([]);
    const redo = await x.tools.redo!({});
    expect(redo.isError).toBe(true);
    expect(readFileSync(designPath, "utf8")).toBe(scriptBefore);
    expect((await x.check()).state).not.toBe("pass");
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: re-review — a parameter change queued ahead of the approved import refuses the approval before anything is imported; redrawn with the move, denied, nothing is left and no reference goes unchecked", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const far = await blockStep(x, repo, "far", [200, 0, 0]);
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    copyFileSync(far, join(repo, ".anvil-downloads", "far.step"));
    await must(x.tools.open_part!({ part: "plate" }));
    const ref = partRef(repo, "plate");
    const call = x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/far.step" });
    while (x.openCards().length === 0) await new Promise((r) => setTimeout(r, 5));
    const first = x.openCards()[0];
    const change = x.manager.request(ref, { tool: "execute", args: { command: "parameters.change", params: { changes: { L: "130 mm" } } }, kind: "mutate" });
    expect(x.service.respond(first.requestId, true)).toBe(true);
    await change;
    while (!x.openCards().some((c) => c.requestId !== first.requestId)) await new Promise((r) => setTimeout(r, 5));
    const second = x.openCards()[0];
    expect(row(second, "Parameter L")).toMatchObject({ old: "80", new: `130 (${UNAPPROVED_PARAMETER})`, unapproved: true });
    expect(existsSync(join(repo, "cad", "plate", "refs", "far.step"))).toBe(false);
    x.service.respond(second.requestId, false);
    expect((await call).json.imported).toBe(false);
    const insp = (await x.tools.inspect_design!({ measure: false, sketches: false, timeline: "summary", bodies: true })).json;
    expect(insp.timeline.filter((f: any) => f.type === "BaseFeature")).toEqual([]);
    expect(JSON.parse(readFileSync(x.partJson, "utf8")).refs ?? []).toEqual([]);
    const g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain("L 80 → 130");
    expect(g.failing.join("\n")).not.toContain(REFERENCE_NOT_COVERED);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: re-review — a real STEP imported past import_reference (no must-not-touch rule) fails the gate: 'reference <name> is not covered by a must-not-touch rule'", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const far = await blockStep(x, repo, "far", [200, 0, 0]);
    await must(x.tools.open_part!({ part: "plate" }));
    const ref = partRef(repo, "plate");
    mkdirSync(join(ref.dir, "refs"), { recursive: true });
    const dest = join(ref.dir, "refs", "far.step");
    copyFileSync(far, dest);
    const ins = await x.manager.request(ref, { tool: "execute", args: { command: "file.insert_step", params: { path: dest, name: importFeatureName("far.step") } }, kind: "mutate" });
    expect(ins.result.isError).toBe(false);
    const g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain(`reference far.step ${REFERENCE_NOT_COVERED}`);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: re-review — a SECOND import carrying the approved reference's file name (other STEP text: a 10 mm block at the origin, body far_b) added to design.json fails the gate ('duplicate reference import far.step', the overlap with far_b found); release_part writes nothing and verify-cli exits 1", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const far = await blockStep(x, repo, "far", [100, 0, 0]);
    const near = await blockStep(x, repo, "near", [0, 0, 0]);
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    copyFileSync(far, join(repo, ".anvil-downloads", "far.step"));
    await must(x.tools.open_part!({ part: "plate" }));
    expect((await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/far.step" }))).json.imported).toBe(true);
    let g = await x.check();
    expect(g.failing).toEqual([]);
    expect(g.state).toBe("pass");
    // A Bash write (or an owner-allowed edit) appends a second import with file "far.step" but other text.
    const designPath = join(repo, "cad", "plate", "design.json");
    const doc = JSON.parse(readFileSync(designPath, "utf8"));
    const first = doc.commands.find((c: any) => c.command === "timeline.add" && c.params?.feature?.type === "import");
    const second = JSON.parse(JSON.stringify(first));
    second.params.feature.step = readFileSync(near, "utf8");
    second.params.feature.name = "ref-far.step-2";
    second.params.feature.body_names = ["far_b"];
    second.params.feature.id = 1 + Math.max(...doc.commands.map((c: any) => Number(c.params?.feature?.id ?? 0)));
    for (const k of ["component", "components", "inserted"]) delete second.params.feature[k];
    doc.commands.push(second);
    writeFileSync(designPath, JSON.stringify(doc, null, 2) + "\n");
    g = await x.check(); // reloads the design from disk
    const insp = (await x.tools.inspect_design!({ measure: false, sketches: false, timeline: "summary", bodies: true })).json;
    expect(insp.bodies.map((b: any) => b.name)).toContain("far_b");
    expect(g.state).toBe("fail");
    const lines = g.failing.join("\n");
    expect(lines).toContain(`${DUPLICATE_REFERENCE} far.step: 2 imports`);
    expect(g.checks.find((c: any) => c.id === "ref far.step").ok).toBe(false);
    const hit = g.checks.find((c: any) => c.id === "interference far.step");
    expect(hit.ok).toBe(false);
    expect(hit.measured).toMatch(/overlaps far_b by 600 mm³/);
    expect(lines).toContain(REFERENCE_NOT_COVERED); // neither import's bodies count as a checked reference
    // Release is refused and writes nothing.
    const rel = await asOwner(x, x.tools.release_part!({ part: "plate" }));
    expect(rel.isError).toBe(true);
    expect(rel.text).toContain("the gate is fail");
    expect(existsSync(join(repo, "cad", "plate", "release"))).toBe(false);
    // The merge guard judges it the same way (the shared evaluation), in its own real process.
    const stateDir = x.service.locks.file.replace(/\/cadwork\/locks\.json$/, "");
    const v = await runVerifyCli(repo, ["--json", "--part", "plate"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: SOLIDCRAFT_CLI });
    expect(v.code).toBe(1);
    const p = v.json.parts.find((q: any) => q.part === "plate");
    expect(p.state).toBe("fail");
    expect(p.failing.join("\n")).toContain(`${DUPLICATE_REFERENCE} far.step`);
    expect(p.failing.join("\n")).toMatch(/overlaps far_b by 600 mm³/);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: re-review — the approved far.step reference copied onto the plate (occurrence.copy of ref-far.step:1, translate -100) fails the gate: 'reference far.step is placed 2 times' and Body1 overlaps far (ref-far.step:2) by 600 mm³; the agent's execute refuses the copy; release_part writes nothing and verify-cli exits 1", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const far = await blockStep(x, repo, "far", [100, 0, 0]);
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    copyFileSync(far, join(repo, ".anvil-downloads", "far.step"));
    await must(x.tools.open_part!({ part: "plate" }));
    expect((await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/far.step" }))).json.imported).toBe(true);
    let g = await x.check();
    expect(g.failing).toEqual([]);
    expect(g.state).toBe("pass");
    const copy = { command: "occurrence.copy", params: { occurrence: "ref-far.step:1", translate: [-100, 0, 0] } };
    // The agent's own tools refuse it before it reaches SolidCraft…
    const refused = await x.tools.execute!(copy);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(REFERENCE_PLACED_ONCE);
    // …so it arrives the other way: a step in design.json (what a Bash write can add), here run as one.
    const ref = partRef(repo, "plate");
    const ran = await x.manager.request(ref, { tool: "execute", args: copy, kind: "mutate" });
    expect(ran.result.isError).toBe(false);
    expect(readFileSync(join(repo, "cad", "plate", "design.json"), "utf8")).toContain('"occurrence.copy"');
    // SolidCraft's own all-bodies check sees the copy on the plate.
    const all = (await x.tools.execute!({ command: "inspect.interference", params: {} })).json;
    expect(all.interferences.map((i: any) => `${i.a}|${i.b}|${Math.round(i.volume_mm3)}`)).toEqual(["Body1|far (ref-far.step:2)|600"]);
    g = await x.check();
    expect(g.state).toBe("fail");
    const lines = g.failing.join("\n");
    expect(lines).toContain(`reference far.step is placed 2 times; ${REFERENCE_PLACED_ONCE}`);
    expect(g.checks.find((c: any) => c.id === "interference far.step").measured).toMatch(/Body1 overlaps far \(ref-far\.step:2\) by 600 mm³/);
    const rel = await asOwner(x, x.tools.release_part!({ part: "plate" }));
    expect(rel.isError).toBe(true);
    expect(rel.text).toContain("the gate is fail");
    expect(existsSync(join(repo, "cad", "plate", "release"))).toBe(false);
    const stateDir = x.service.locks.file.replace(/\/cadwork\/locks\.json$/, "");
    const v = await runVerifyCli(repo, ["--json", "--part", "plate"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: SOLIDCRAFT_CLI });
    expect(v.code).toBe(1);
    const p = v.json.parts.find((q: any) => q.part === "plate");
    expect(p.state).toBe("fail");
    expect(p.failing.join("\n")).toContain(`reference far.step is placed 2 times; ${REFERENCE_PLACED_ONCE}`);
    expect(p.failing.join("\n")).toMatch(/Body1 overlaps far \(ref-far\.step:2\) by 600 mm³/);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: re-review — a copy of the far.step reference left in place, then moved onto the plate by the agent's occurrence.move of ref-far.step:2: placed twice fails at once, and after the move the overlap is found at the copy's final position", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const far = await blockStep(x, repo, "far", [100, 0, 0]);
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    copyFileSync(far, join(repo, ".anvil-downloads", "far.step"));
    await must(x.tools.open_part!({ part: "plate" }));
    expect((await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/far.step" }))).json.imported).toBe(true);
    const ref = partRef(repo, "plate");
    expect((await x.manager.request(ref, { tool: "execute", args: { command: "occurrence.copy", params: { occurrence: "ref-far.step:1" } }, kind: "mutate" })).result.isError).toBe(false);
    let g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain(`reference far.step is placed 2 times; ${REFERENCE_PLACED_ONCE}`);
    expect(g.checks.find((c: any) => c.id === "interference far.step")).toMatchObject({ ok: true, measured: "no overlap" }); // both placements are clear at x=100
    // The agent's own tool refuses to move a placement of the reference; the gate is shown the move made past it.
    const refused = await x.tools.execute!({ command: "occurrence.move", params: { occurrence: "ref-far.step:2", translate: [-100, 0, 0] } });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("may not change the reference ref-far.step");
    expect((await x.manager.request(ref, { tool: "execute", args: { command: "occurrence.move", params: { occurrence: "ref-far.step:2", translate: [-100, 0, 0] } }, kind: "mutate" })).result.isError).toBe(false);
    g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain(`reference far.step is placed 2 times; ${REFERENCE_PLACED_ONCE}`);
    expect(g.checks.find((c: any) => c.id === "interference far.step").measured).toMatch(/Body1 overlaps far \(ref-far\.step:2\) by 600 mm³/);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: veto — the only placement of an overlapping reference un-grounded (occurrence.ground false) and moved 1000 mm away (occurrence.move): the agent's execute refuses both; made past the tool, the gate fails 'reference block.step was moved from where it was imported' and '…is not grounded' although the overlap is gone, release_part writes nothing and verify-cli exits 1", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const near = await blockStep(x, repo, "block", [0, 0, 0]); // overlaps the plate by 600 mm³
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    copyFileSync(near, join(repo, ".anvil-downloads", "block.step"));
    await must(x.tools.open_part!({ part: "plate" }));
    expect((await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/block.step" }))).json.imported).toBe(true);
    // part.json records where the import put it: identity in the design, grounded.
    const rec = JSON.parse(readFileSync(x.partJson, "utf8")).refs.find((r: any) => r.name === "block.step");
    expect(rec.placement).toEqual({ transform: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], grounded: true });
    let g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.checks.find((c: any) => c.id === "interference block.step").measured).toMatch(/overlaps block by 600 mm³/);
    const unground = { command: "occurrence.ground", params: { occurrence: "ref-block.step:1", grounded: false } };
    const away = { command: "occurrence.move", params: { occurrence: "ref-block.step:1", translate: [1000, 0, 0] } };
    // The agent's own tools refuse both, by name, by id and inside a batch.
    for (const step of [unground, away]) {
      const r = await x.tools.execute!(step);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("may not change the reference ref-block.step");
    }
    const occId = (await x.tools.execute!({ command: "component.list", params: {} })).json.components.find((c: any) => c.name === "ref-block.step").occurrences[0].id;
    expect((await x.tools.execute!({ command: "occurrence.ground", params: { occurrence: occId, grounded: false } })).isError).toBe(true);
    expect((await x.tools.batch!({ commands: [unground, away] })).text).toContain("step 1: `occurrence.ground` may not change the reference ref-block.step");
    // Made past the tools (a step in design.json is what a Bash write can add), here run as two.
    const ref = partRef(repo, "plate");
    for (const step of [unground, away]) expect((await x.manager.request(ref, { tool: "execute", args: step, kind: "mutate" })).result.isError).toBe(false);
    expect(readFileSync(join(repo, "cad", "plate", "design.json"), "utf8")).toContain('"occurrence.move"');
    g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.checks.find((c: any) => c.id === "interference block.step")).toMatchObject({ ok: true, measured: "no overlap" }); // the hole: it no longer overlaps
    const lines = g.failing.join("\n");
    expect(lines).toContain(`reference block.step ${REFERENCE_MOVED} (placement ref-block.step:1: its translation is [1000, 0, 0])`);
    expect(lines).toContain(`reference block.step ${REFERENCE_NOT_GROUNDED}`);
    const rel = await asOwner(x, x.tools.release_part!({ part: "plate" }));
    expect(rel.isError).toBe(true);
    expect(rel.text).toContain("the gate is fail");
    expect(existsSync(join(repo, "cad", "plate", "release"))).toBe(false);
    const stateDir = x.service.locks.file.replace(/\/cadwork\/locks\.json$/, "");
    const v = await runVerifyCli(repo, ["--json", "--part", "plate"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: SOLIDCRAFT_CLI });
    expect(v.code).toBe(1);
    const p = v.json.parts.find((q: any) => q.part === "plate");
    expect(p.state).toBe("fail");
    expect(p.failing.join("\n")).toContain(`reference block.step ${REFERENCE_MOVED}`);
    expect(p.failing.join("\n")).toContain(`reference block.step ${REFERENCE_NOT_GROUNDED}`);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: veto — renaming the reference's component (component.rename ref-far.step → innocent) is refused; made past the tool, the renamed reference is still found by its import: ground, copy, rename back to ref-, and solid.move of its body are refused, the gate still holds it ('reference far.step was moved…') and a body move past the tool fails ('…is changed by feature')", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const far = await blockStep(x, repo, "far", [100, 0, 0]);
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    copyFileSync(far, join(repo, ".anvil-downloads", "far.step"));
    await must(x.tools.open_part!({ part: "plate" }));
    expect((await asOwner(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/far.step" }))).json.imported).toBe(true);
    expect((await x.check()).state).toBe("pass");
    const rename = { command: "component.rename", params: { component: "ref-far.step", name: "innocent" } };
    const r0 = await x.tools.execute!(rename);
    expect(r0.isError).toBe(true);
    expect(r0.text).toContain("may not");
    const ref = partRef(repo, "plate");
    expect((await x.manager.request(ref, { tool: "execute", args: rename, kind: "mutate" })).result.isError).toBe(false);
    const comps = (await x.tools.execute!({ command: "component.list", params: {} })).json.components;
    expect(comps.map((c: any) => c.name)).toContain("innocent");
    // Renamed, it is still a reference: found by its import feature, not by its name.
    for (const step of [
      { command: "occurrence.ground", params: { occurrence: "innocent:1", grounded: false } },
      { command: "occurrence.move", params: { occurrence: "innocent:1", translate: [1000, 0, 0] } },
      { command: "component.rename", params: { component: "innocent", name: "still-innocent" } },
      { command: "component.delete", params: { component: "innocent" } },
      { command: "solid.move", params: { bodies: ["far"], translate: [-100, 0, 0] } },
    ]) {
      const r = await x.tools.execute!(step);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("may not change the reference ref-far.step");
    }
    const copy = await x.tools.execute!({ command: "occurrence.copy", params: { component: "innocent", translate: [-100, 0, 0] } });
    expect(copy.isError).toBe(true);
    expect(copy.text).toContain(REFERENCE_PLACED_ONCE);
    const back = await x.tools.execute!({ command: "component.rename", params: { component: "Untitled", name: "ref-plate" } });
    expect(back.isError).toBe(true);
    expect(back.text).toContain('names starting with "ref-" belong to imported references');
    // The rename alone moves nothing: the gate passes, and holds the renamed reference where it was imported.
    let g = await x.check();
    expect(g.failing).toEqual([]);
    expect((await x.manager.request(ref, { tool: "execute", args: { command: "occurrence.move", params: { occurrence: "innocent:1", translate: [0, 0, 50], move_grounded: true } }, kind: "mutate" })).result.isError).toBe(false);
    g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain(`reference far.step ${REFERENCE_MOVED} (placement innocent:1: its translation is [0, 0, 50])`);
    // A move of the reference's BODY (not its placement) is caught too, from the design script.
    await x.manager.request(ref, { tool: "undo", args: {}, kind: "undo" });
    expect((await x.check()).failing).toEqual([]);
    expect((await x.manager.request(ref, { tool: "execute", args: { command: "solid.move", params: { bodies: ["far"], translate: [-100, 0, 0] } }, kind: "mutate" })).result.isError).toBe(false);
    g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toMatch(/reference far\.step is changed by feature Move\d* \(it names far\)/);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: veto — a design component placed twice (occurrence.copy of Design2, 500 mm away) fails the gate 'body Body2 is placed 2 times; a design body may be placed once', so the measurement, export and release never leave a copy out", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    expect(x.gate.state).toBe("pass");
    await must(x.tools.execute!({ command: "component.create", params: { name: "Design2" } }));
    await must(x.tools.execute!({ command: "solid.box", params: { length: 5, width: 5, height: 5, corner: [0, 0, 50], name: "Box2" } }));
    await must(x.tools.execute!({ command: "component.activate", params: { component: 0 } }));
    await must(x.tools.execute!({ command: "occurrence.copy", params: { component: "Design2", translate: [500, 0, 0] } }));
    const names = (await x.tools.execute!({ command: "inspect.measure", params: { names_only: true } })).json.bodies.map((b: any) => b.name);
    expect(names).toContain("Body2 (Design2:2)");
    const g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain(`body Body2 is placed 2 times; ${DESIGN_PLACED_ONCE} (Body2, Body2 (Design2:2))`);
    const rel = await asOwner(x, x.tools.release_part!({ part: "plate" }));
    expect(rel.isError).toBe(true);
    expect(existsSync(join(repo, "cad", "plate", "release"))).toBe(false);
    const stateDir = x.service.locks.file.replace(/\/cadwork\/locks\.json$/, "");
    const v = await runVerifyCli(repo, ["--json", "--part", "plate"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: SOLIDCRAFT_CLI });
    expect(v.code).toBe(1);
    expect(v.json.parts.find((q: any) => q.part === "plate").failing.join("\n")).toContain(`body Body2 is placed 2 times; ${DESIGN_PLACED_ONCE}`);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: re-review — after a refused import is rolled back, a read through execute (inspect.measure) does not lift the redo ceiling: redo is refused, design.json is unchanged and no BaseFeature comes back", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    let armed: (() => void) | undefined;
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI, deps: { manager: { beforeScriptRename: () => { const f = armed; armed = undefined; f?.(); } } } });
    const far = await blockStep(x, repo, "far", [200, 0, 0]);
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    copyFileSync(far, join(repo, ".anvil-downloads", "far.step"));
    await must(x.tools.open_part!({ part: "plate" }));
    const designPath = join(repo, "cad", "plate", "design.json");
    const scriptBefore = readFileSync(designPath, "utf8");
    armed = () => {
      const pj = JSON.parse(readFileSync(x.partJson, "utf8"));
      pj.process = "cnc-3axis";
      writeFileSync(x.partJson, JSON.stringify(pj, null, 2) + "\n");
    };
    const r = await asOwnerEach(x, x.tools.import_reference!({ part: "plate", file: ".anvil-downloads/far.step" }), (i) => i === 0);
    expect(r.json.imported).toBe(false);
    expect(readFileSync(designPath, "utf8")).toBe(scriptBefore);
    // SolidCraft still holds the rolled-back import in its redo history…
    const depth = (await x.tools.inspect_design!({ measure: false, sketches: false, timeline: "summary", bodies: true })).json;
    expect(depth.redo).toBeGreaterThan(0);
    // …and a read the agent sends through execute keeps it there.
    const m = await x.tools.execute!({ command: "inspect.measure", params: {} });
    expect(m.isError).toBe(false);
    expect((await x.tools.inspect_design!({ measure: false, sketches: false, timeline: "summary", bodies: true })).json.redo).toBeGreaterThan(0);
    const redo = await x.tools.redo!({});
    expect(redo.isError).toBe(true);
    expect(redo.text).toContain("nothing to redo");
    expect(readFileSync(designPath, "utf8")).toBe(scriptBefore);
    const insp = (await x.tools.inspect_design!({ measure: false, sketches: false, timeline: "summary", bodies: true })).json;
    expect(insp.timeline.filter((f: any) => f.type === "BaseFeature")).toEqual([]);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: a release pack of the plate has exactly the listed files, a STEP the binary re-opens as 1 body, four different non-empty PNGs, a valid 3MF, a verifying manifest, and the hole table 3.4 mm ×4; wall time recorded", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    expect(x.gate.state).toBe("pass");
    const t0 = performance.now();
    const r = await asOwner(x, x.tools.release_part!({ part: "plate" }));
    const ms = performance.now() - t0;
    expect(r.isError).toBe(false);
    expect(r.json.released).toBe(true);
    const sha = x.manager.status(partRef(repo, "plate"))!.scriptSha!;
    const dir = join(repo, "cad", "plate", "release", `plate-${sha.slice(0, 7)}`);
    expect(readdirSync(dir).sort()).toEqual(expectedReleaseFiles("plate", "fdm"));
    // The STEP opens in the real binary as one body.
    const ev = Bun.spawnSync([SOLIDCRAFT_CLI, "eval", join(dir, "plate.step")], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", TMPDIR: process.env.TMPDIR ?? "/tmp", SOLIDCRAFT_GPU: "cpu" } });
    const evJson = JSON.parse(ev.stdout.toString());
    expect(evJson.body_count).toBe(1);
    expect(Math.abs(evJson.bodies[0].volume_mm3 - 23335.166952)).toBeLessThan(1e-3);
    // Four non-empty, mutually different PNGs.
    const pngs = ["iso", "front", "top", "right"].map((v) => readFileSync(join(dir, `${v}.png`)));
    for (const p of pngs) {
      expect(p.length).toBeGreaterThan(100);
      expect(p.subarray(1, 4).toString()).toBe("PNG");
    }
    const hashes = pngs.map((p) => new Bun.CryptoHasher("sha256").update(p).digest("hex"));
    expect(new Set(hashes).size).toBe(4);
    // A valid 3MF: a zip with the 3D model part.
    const z = Bun.spawnSync(["unzip", "-l", join(dir, "plate.3mf")], { stdout: "pipe" });
    expect(z.exitCode).toBe(0);
    expect(z.stdout.toString()).toContain("3D/3dmodel.model");
    // Manifest + HMAC.
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
    for (const [f, h] of Object.entries(m.files)) expect(new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, f))).digest("hex")).toBe(h as string);
    expect(x.service.verifyReleaseDir(dir)).toMatchObject({ ok: true });
    expect(m.solidcraft).toMatch(/^\d+\.\d+\.\d+/);
    // The hole table: one row, ⌀3.4 ×4, with four centres.
    const html = readFileSync(join(dir, "spec-sheet.html"), "utf8");
    const holes = html.split("<h2>Holes</h2>")[1]!.split("<h2>")[0]!;
    expect((holes.match(/<tr>/g) ?? []).length - 1).toBe(1);
    expect(holes).toContain("<td>3.4</td><td>4</td>");
    expect(holes).toContain("⌀6.5 × 3.3"); // the counterbore, inside the same row
    expect((holes.match(/\(-?\d+(\.\d+)?, -?\d+(\.\d+)?, -?\d+(\.\d+)?\)/g) ?? []).length).toBe(4);
    expect(html).toContain("Not a drawing");
    expect(existsSync(join(dir, "spec-sheet.md"))).toBe(true);
    expect(x.emitted.filter((e) => e.type === "file.offer")).toHaveLength(9);
    console.log(`[A4 real] release pack for the plate (forced refresh, card, STEP + 3MF + 4 views + sheets + manifest): ${ms.toFixed(0)} ms wall time`);
    expect(ms).toBeGreaterThan(0);
  }, 300_000);
});

/** The plate with `block.step` (a 10 mm block at `corner`) imported as an approved reference. */
async function plateWithBlock(corner: number[], file = "block.step") {
  const repo = tempRepo("anvil-cad-real-");
  const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
  const step = await blockStep(x, repo, file.replace(/\.step$/, ""), corner);
  mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
  copyFileSync(step, join(repo, ".anvil-downloads", file));
  await must(x.tools.open_part!({ part: "plate" }));
  expect((await asOwner(x, x.tools.import_reference!({ part: "plate", file: `.anvil-downloads/${file}` }))).json.imported).toBe(true);
  const designPath = join(repo, "cad", "plate", "design.json");
  const stateDir = x.service.locks.file.replace(/\/cadwork\/locks\.json$/, "");
  return { repo, x, ref: partRef(repo, "plate"), designPath, stateDir };
}
const timelineOf = async (x: X) => (await x.tools.inspect_design!({ measure: false, sketches: false, timeline: "summary", bodies: true })).json;

describe("real SolidCraft: a reference measures what its import did", () => {
  test.skipIf(!REAL)("[A4] real: veto — a hand-written design.json feature reshapes the reference by a face POINT (offset_face {faces: [[5, 5, -2]], distance: -9}, no body or face names): no overlap is left and no feature names a reference body, but the gate fails 'reference block.step does not match what was imported (volume 1000 → 100 mm³ …)' against the lock store's record, release_part writes nothing and verify-cli exits 1", async () => {
    expect(hasSolidcraft()).toBe(true);
    const { repo, x, ref, designPath, stateDir } = await plateWithBlock([0, 0, -2]); // z -2…8: overlaps the plate (z 0…6) by 600 mm³
    // The lock store holds the reference as it measured when it was imported (not only part.json).
    const rec = x.service.locks.findPart(repoIdentity(repo), "plate")!.references!["block.step"]!;
    expect(rec.bodies).toHaveLength(1);
    expect(rec.bodies[0]).toMatchObject({ name: "block", volume: 1000, faces: 6, bbox: { min: [0, 0, -2], max: [10, 10, 8] }, centerOfMass: [5, 5, 3] });
    let g = await x.check();
    expect(g.checks.find((c: any) => c.id === "interference block.step").measured).toMatch(/overlaps block by 600 mm³/);
    expect(g.checks.find((c: any) => c.id === "geometry block.step")).toMatchObject({ ok: true, measured: "as imported" });
    // Past the tools, as a hand-written design.json: the command, then its body and face names taken out.
    expect((await x.manager.request(ref, { tool: "execute", args: { command: "solid.offset_face", params: { faces: [[5, 5, -2]], distance: "-9" } }, kind: "mutate" })).result.isError).toBe(false);
    const doc = JSON.parse(readFileSync(designPath, "utf8"));
    const feat = doc.commands.find((c: any) => c.params?.feature?.type === "offset_face").params.feature;
    delete feat.body;
    delete feat.face_names;
    expect(JSON.stringify(feat)).not.toContain("block");
    writeFileSync(designPath, JSON.stringify(doc, null, 2) + "\n");
    g = await x.check();
    expect(readFileSync(designPath, "utf8")).not.toContain("face_names"); // the hand-written script is what runs
    expect(g.state).toBe("fail");
    expect(g.checks.find((c: any) => c.id === "interference block.step")).toMatchObject({ ok: true, measured: "no overlap" }); // the hole: no overlap any more
    const lines = g.failing.join("\n");
    expect(lines).not.toMatch(/is changed by feature/); // no feature names a reference body
    expect(lines).toContain(`reference block.step ${REFERENCE_RESHAPED} (volume 1000 → 100 mm³`);
    expect(lines).toContain("bounding box [0, 0, -2]…[10, 10, 8] → [0, 0, 7]…[10, 10, 8]");
    const rel = await asOwner(x, x.tools.release_part!({ part: "plate" }));
    expect(rel.isError).toBe(true);
    expect(rel.text).toContain("the gate is fail");
    expect(existsSync(join(repo, "cad", "plate", "release"))).toBe(false);
    const v = await runVerifyCli(repo, ["--json", "--part", "plate"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: SOLIDCRAFT_CLI });
    expect(v.code).toBe(1);
    const p = v.json.parts.find((q: any) => q.part === "plate");
    expect(p.state).toBe("fail");
    expect(p.failing.join("\n")).toContain(`reference block.step ${REFERENCE_RESHAPED} (volume 1000 → 100 mm³`);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: veto — the agent's point-based reshapes of a reference (solid.offset_face, replace_face, press_pull, face.delete, draft, split_face, fillet, chamfer, shell, hole by a point on it) are refused from SolidCraft's changed_bodies and UNDONE: design.json unchanged, nothing to redo, and a batch is undone as a whole", async () => {
    expect(hasSolidcraft()).toBe(true);
    const { x, designPath } = await plateWithBlock([0, 0, -2]);
    const top = [5, 5, 8];
    const side = [10, 5, 7];
    const edge = [10, 5, 8];
    const reshapes: [string, Record<string, unknown>][] = [
      ["solid.offset_face", { faces: [top], distance: "-1" }],
      ["solid.replace_face", { faces: [top], target: { origin: [0, 0, 7], normal: [0, 0, 1] } }],
      ["solid.press_pull", { face: top, distance: "-1" }],
      ["face.delete", { faces: [top], heal: false }],
      ["solid.draft", { faces: [side], angle: "5 deg", neutral: "XY" }],
      ["solid.split_face", { faces: [top], plane: { origin: [5, 0, 0], normal: [1, 0, 0] } }],
      ["solid.fillet", { edges: [edge], radius: "1" }],
      ["solid.chamfer", { edges: [edge], distance: "1" }],
      ["solid.shell", { faces: [top], thickness: "1" }],
      ["solid.hole", { position: top, diameter: "2", depth: "3" }],
    ];
    const script = readFileSync(designPath, "utf8");
    const features = (await timelineOf(x)).timeline.length;
    for (const [command, params] of reshapes) {
      const r = await x.tools.execute!({ command, params });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`\`${command}\` changed the reference ref-block.step`);
      expect(r.text).toContain("SolidCraft reports changed_bodies block");
      expect(r.text).toContain("It was undone");
      expect(readFileSync(designPath, "utf8")).toBe(script);
      expect((await timelineOf(x)).timeline.length).toBe(features);
      const redo = await x.tools.redo!({});
      expect(redo.isError).toBe(true);
      expect(readFileSync(designPath, "utf8")).toBe(script);
    }
    // In a batch, the design's own step goes with it: the request is undone as a whole.
    const b = await x.tools.batch!({ commands: [{ command: "solid.box", params: { length: 2, width: 2, height: 2, corner: [30, 0, 6], name: "Nub" } }, { command: "solid.offset_face", params: { faces: [top], distance: "-1" } }] });
    expect(b.isError).toBe(true);
    expect(b.text).toContain("this batch changed the reference ref-block.step");
    expect(readFileSync(designPath, "utf8")).toBe(script);
    expect((await timelineOf(x)).bodies.map((q: any) => q.name)).not.toContain("Nub");
    // The design's own modeling still goes through.
    expect((await x.tools.execute!({ command: "solid.fillet", params: { edges: [[40, 0, 6]], radius: "0.5", body: "Body1" } })).isError).toBe(false);
    const g = await x.check();
    expect(g.checks.find((c: any) => c.id === "geometry block.step")).toMatchObject({ ok: true });
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: veto — timeline.suppress / delete / roll_to / rollback / reorder / edit of the reference's import are refused before anything is sent (by name, by id, by marker position); a suppress through a timeline folder is caught after it ran and undone; occurrence.align {paths: [[<occurrence id>]], move_grounded: true} of the reference is refused", async () => {
    expect(hasSolidcraft()).toBe(true);
    const { x, ref, designPath } = await plateWithBlock([100, 0, 0]);
    const insp = await timelineOf(x);
    const at = insp.timeline.findIndex((f: any) => f.type === "BaseFeature");
    const imp = insp.timeline[at];
    expect(imp.name).toBe(importFeatureName("block.step"));
    const script = readFileSync(designPath, "utf8");
    const upFront: [string, Record<string, unknown>][] = [
      ["timeline.suppress", { feature: imp.name }],
      ["timeline.suppress", { feature: imp.id }],
      ["timeline.suppress", { features: [imp.id], suppressed: true }],
      ["timeline.delete", { feature: imp.id }],
      ["timeline.roll_to", { position: at }],
      ["timeline.roll_to", { feature: insp.timeline[at - 1].id }],
      ["timeline.rollback", { position: 1 }],
      ["timeline.reorder", { feature: imp.id, position: insp.timeline.length - 1, active: false }],
      ["timeline.edit", { feature: imp.id, set: { name: "innocent" } }],
    ];
    for (const [command, params] of upFront) {
      const r = await x.tools.execute!({ command, params });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/may not (change the import of the reference ref-block\.step|move the history marker before the import of a reference|change the reference ref-block\.step)/);
      expect(r.text).not.toContain("undone"); // nothing was sent
      expect(readFileSync(designPath, "utf8")).toBe(script);
    }
    // A marker move that keeps the import in is fine.
    expect((await x.tools.execute!({ command: "timeline.rollback", params: { position: "end" } })).isError).toBe(false);
    // A folder holding the import (made past the tools), suppressed by the agent: caught after it ran, undone.
    const grouped = await x.manager.request(ref, { tool: "execute", args: { command: "timeline.group", params: { name: "Refs", features: [imp.id] } }, kind: "mutate" });
    expect(grouped.result.isError).toBe(false);
    const gid = grouped.result.json?.group ?? grouped.result.json?.id;
    expect(typeof gid).toBe("number");
    const scriptGrouped = readFileSync(designPath, "utf8");
    const s = await x.tools.execute!({ command: "timeline.suppress", params: { groups: [gid], suppressed: true } });
    expect(s.isError).toBe(true);
    expect(s.text).toContain("the import ref-block.step was suppressed");
    expect(s.text).toContain("It was undone");
    expect(readFileSync(designPath, "utf8")).toBe(scriptGrouped);
    expect((await timelineOf(x)).timeline.find((f: any) => f.id === imp.id).suppressed).toBeUndefined();
    // occurrence.align by placement path.
    const occId = (await x.tools.execute!({ command: "component.list", params: {} })).json.components.find((c: any) => c.name === "ref-block.step").occurrences[0].id;
    const al = await x.tools.execute!({ command: "occurrence.align", params: { paths: [[occId]], from: [100, 0, 0], to: [0, 0, -2], move_grounded: true } });
    expect(al.isError).toBe(true);
    expect(al.text).toContain("`occurrence.align` may not change the reference ref-block.step");
    expect(readFileSync(designPath, "utf8")).toBe(scriptGrouped);
    expect((await x.check()).failing).toEqual([]);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: item 3 — a part approved before reference measurements were recorded (its lock has no `references`) is never trusted from the current file: check_part and verify-cli say unverified 'reference measurements not recorded; approve current reference' (needsAdoption references) and the owner gets an adopt-references card; approved, the record is the import replayed alone and the part passes in both; reshaped past the tools by a face point it then fails 'reference far.step does not match what was imported (volume 1000 → 500 mm³ …)' in both", async () => {
    expect(hasSolidcraft()).toBe(true);
    const { repo, x, ref, stateDir } = await plateWithBlock([100, 0, 0], "far.step");
    const id = repoIdentity(repo);
    const { references, ...legacy } = x.service.locks.findPart(id, "plate")!;
    const approved = references!["far.step"]!;
    expect(approved).toBeDefined();
    x.service.locks.putPart(legacy); // what an approval made before this change looks like
    expect(x.service.locks.findPart(id, "plate")!.references).toBeUndefined();
    let g = await x.check();
    expect(g.state).toBe("unverified");
    expect(g.needsAdoption).toBe("references");
    expect(g.failing.join("\n")).toContain(`lock.references: expected what each reference measured when the owner approved it, measured ${REFERENCE_NOT_RECORDED} (refs/far.step)`);
    // Still checked against its import meanwhile.
    expect(g.checks.find((c: any) => c.id === "geometry far.step")).toMatchObject({ ok: true, measured: "as imported" });
    let v = await runVerifyCli(repo, ["--json", "--part", "plate"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: SOLIDCRAFT_CLI });
    expect(v.code).toBe(1);
    expect(v.json.parts[0]).toMatchObject({ state: "unverified", needsAdoption: "references" });
    // The owner's card: one row per reference, old "not recorded", new the current file by sha.
    const card = x.openCards().find((c: any) => c.kind === "adopt-references");
    expect(card).toBeDefined();
    expect(row(card, "refs/far.step")).toMatchObject({ old: "measurements not recorded", new: expect.stringContaining(`approve current reference (sha ${approved.sha256.slice(0, 12)}, 1 body: far)`) });
    // …and, per body, the measurements approving records (the import replayed alone, before the card was drawn).
    expect(row(card, "refs/far.step far")).toMatchObject({ new: "volume 1000 mm³, bounding box [100, 0, 0]…[110, 10, 10], 6 faces" });
    x.service.respond(card.requestId, true);
    for (let i = 0; i < 400 && !x.service.locks.findPart(id, "plate")!.references; i++) await new Promise((r) => setTimeout(r, 25));
    // What is recorded is the import replayed alone: the same numbers import_reference measured.
    expect(x.service.locks.findPart(id, "plate")!.references!["far.step"]).toEqual(approved);
    g = await x.check();
    expect(g.failing).toEqual([]);
    expect(g.state).toBe("pass");
    v = await runVerifyCli(repo, ["--json", "--part", "plate"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: SOLIDCRAFT_CLI });
    expect(v.json.parts[0].checks.find((c: any) => c.id === "geometry far.step")).toMatchObject({ ok: true, measured: "as imported" });
    expect(v.code).toBe(0);
    expect((await x.manager.request(ref, { tool: "execute", args: { command: "solid.offset_face", params: { faces: [[105, 5, 10]], distance: "-5" } }, kind: "mutate" })).result.isError).toBe(false);
    g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain(`reference far.step ${REFERENCE_RESHAPED} (volume 1000 → 500 mm³`);
    v = await runVerifyCli(repo, ["--json", "--part", "plate"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: SOLIDCRAFT_CLI });
    expect(v.code).toBe(1);
    expect(v.json.parts[0].failing.join("\n")).toContain(`reference far.step ${REFERENCE_RESHAPED} (volume 1000 → 500 mm³`);
  }, 300_000);
});

/** A 30 × 30 × 10 block at [100, 0, 0] with r = 3 through-holes at `holes` (x, y), exported to STEP by
 *  the REAL binary as its own part. */
async function holeyStep(x: X, repo: string, part: string, holes: number[][]): Promise<string> {
  await must(x.tools.open_part!({ part }));
  const volume = 9000 - holes.length * Math.PI * 9 * 10;
  await must(x.tools.record_expectations!({ part, process: "fdm-0.4", parameters: {}, expectations: { bbox: [10, 30, 30], volume, bodies: 1, holes: [{ diameter: 6, count: holes.length }] } }));
  await must(x.tools.execute!({ command: "solid.box", params: { length: 30, width: 30, height: 10, corner: [100, 0, 0], name: "Block" } }));
  for (const [hx, hy] of holes) await must(x.tools.execute!({ command: "solid.hole", params: { position: [hx, hy, 10], diameter: "6", depth: "10" } }));
  const r = await must(x.tools.export_part!({ part, formats: ["step"] }));
  return join(repo, r.json.exports[0].path);
}

/** Part `pin`: one r = 3.5, 4 mm pin (z 6…10) at (108, 8), with `file` (from `step`) imported as its
 *  must-not-touch reference. */
async function pinWith(x: X, repo: string, step: string, file: string) {
  mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
  copyFileSync(step, join(repo, ".anvil-downloads", file));
  await must(x.tools.open_part!({ part: "pin" }));
  await must(x.tools.record_expectations!({ part: "pin", process: "fdm-0.4", parameters: {}, expectations: { bbox: [4, 7, 7], volume: Math.PI * 3.5 * 3.5 * 4, bodies: 1, holes: [] } }));
  await must(x.tools.execute!({ command: "solid.cylinder", params: { radius: "3.5", height: "4", base: [108, 8, 6], name: "Pin", body_name: "Pin" } }));
  expect((await asOwner(x, x.tools.import_reference!({ part: "pin", file: `.anvil-downloads/${file}` }))).json.imported).toBe(true);
  const ref = partRef(repo, "pin");
  const stateDir = x.service.locks.file.replace(/\/cadwork\/locks\.json$/, "");
  const check = async () => (await must(x.tools.check_part!({ part: "pin" }))).json;
  return { ref, stateDir, check, designPath: join(repo, "cad", "pin", "design.json") };
}

/** Past the tools: run `cmds` on the part's process, then take every body and face name out of the
 *  features they made, as a hand-written design.json would have them. */
async function handWritten(x: X, ref: ReturnType<typeof partRef>, designPath: string, cmds: [string, Record<string, unknown>][], type: string) {
  for (const [command, params] of cmds) expect((await x.manager.request(ref, { tool: "execute", args: { command, params }, kind: "mutate" })).result.isError).toBe(false);
  const doc = JSON.parse(readFileSync(designPath, "utf8"));
  const feats = doc.commands.filter((c: any) => c.params?.feature?.type === type).map((c: any) => c.params.feature);
  expect(feats).toHaveLength(cmds.length);
  for (const f of feats) {
    delete f.body;
    delete f.face_names;
  }
  writeFileSync(designPath, JSON.stringify(doc, null, 2) + "\n");
  return feats;
}

describe("real SolidCraft: references are checked against their TRUE import", () => {
  test.skipIf(!REAL)("[A4] real: veto — holey.step (30×30×10, four r=3 through-holes symmetric about its centre of mass) reshaped by four hand-written solid.offset_face features by point (two holes to r=3.5, two shrunk by the same material): volume, bounding box, faces and centre of mass all unchanged, the pin no longer touches the live body — but it overlaps the TRUE import by 40.841 mm³: check_part fails 'interference holey.step as imported' and 'does not match what was imported (shape …)', release_part writes nothing and verify-cli exits 1", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const step = await holeyStep(x, repo, "holey", [[108, 8], [122, 8], [108, 22], [122, 22]]);
    const { ref, stateDir, check, designPath } = await pinWith(x, repo, step, "holey.step");
    let t0 = performance.now();
    let g = await check();
    const firstMs = performance.now() - t0;
    // Untouched: the pin (r 3.5) sits in a r 3 hole — both checks find the same overlap.
    expect(g.state).toBe("fail");
    expect(g.checks.find((c: any) => c.id === "interference holey.step").measured).toMatch(/overlaps .* by 40\.841 mm³/);
    expect(g.checks.find((c: any) => c.id === "interference holey.step as imported").measured).toMatch(/Pin overlaps .*\(as imported\) by 40\.841 mm³|\(as imported\) overlaps Pin by 40\.841 mm³/);
    expect(g.checks.find((c: any) => c.id === "geometry holey.step")).toMatchObject({ ok: true, measured: "as imported" });
    const recorded = x.service.locks.findPart(repoIdentity(repo), "pin")!.references!["holey.step"]!.bodies[0]!;
    // The reshape: enlarge (108, 8) and (122, 22) to r 3.5; shrink (122, 8) and (108, 22) by the same area.
    const b = String(3 - Math.sqrt(5.75));
    await handWritten(x, ref, designPath, [
      ["solid.offset_face", { faces: [[111, 8, 5]], distance: "-0.5" }],
      ["solid.offset_face", { faces: [[125, 22, 5]], distance: "-0.5" }],
      ["solid.offset_face", { faces: [[125, 8, 5]], distance: b }],
      ["solid.offset_face", { faces: [[111, 22, 5]], distance: b }],
    ], "offset_face");
    expect(readFileSync(designPath, "utf8")).not.toContain("face_names");
    t0 = performance.now();
    g = await check();
    const reshapedMs = performance.now() - t0;
    // The four summary numbers did not move: the old check alone passed this.
    const live = (await x.tools.execute!({ command: "inspect.measure", params: { bodies: [recorded.name] } })).json.bodies[0];
    expect(live.volume_mm3).toBeCloseTo(recorded.volume, 6);
    expect(live.faces).toBe(recorded.faces);
    expect(live.bbox.min[0]).toBeCloseTo(recorded.bbox.min[0], 9);
    expect(live.center_of_mass[0]).toBeCloseTo(recorded.centerOfMass![0], 6);
    expect(live.center_of_mass[1]).toBeCloseTo(recorded.centerOfMass![1], 6);
    expect(g.state).toBe("fail");
    expect(g.checks.find((c: any) => c.id === "interference holey.step")).toMatchObject({ ok: true, measured: "no overlap" }); // the hole: the live body is clear
    const lines = g.failing.join("\n");
    expect(lines).not.toMatch(/is changed by feature/); // no feature names a reference body
    expect(lines).toMatch(/interference holey\.step as imported: .*overlaps .* by 40\.841 mm³/);
    const geo = g.checks.find((c: any) => c.id === "geometry holey.step").measured;
    expect(geo).toContain(`reference holey.step ${REFERENCE_RESHAPED} (shape is not the import's: it shares`);
    expect(geo).not.toMatch(/volume \d|bounding box|faces \d|centre of mass/); // the fast pre-check passed; only the exact comparison sees it
    const rel = await asOwner(x, x.tools.release_part!({ part: "pin" }));
    expect(rel.isError).toBe(true);
    expect(rel.text).toContain("the gate is fail");
    expect(existsSync(join(repo, "cad", "pin", "release"))).toBe(false);
    t0 = performance.now();
    const v = await runVerifyCli(repo, ["--json", "--part", "pin"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: SOLIDCRAFT_CLI });
    const verifyMs = performance.now() - t0;
    expect(v.code).toBe(1);
    const p = v.json.parts.find((q: any) => q.part === "pin");
    expect(p.state).toBe("fail");
    expect(p.failing.join("\n")).toMatch(/interference holey\.step as imported: .*overlaps .* by 40\.841 mm³/);
    expect(p.failing.join("\n")).toContain(`reference holey.step ${REFERENCE_RESHAPED} (shape is not the import's`);
    expect(p.checks.find((c: any) => c.id === "interference holey.step")).toMatchObject({ ok: true });
    console.log(`[A4 real] true-import check: check_part ${firstMs.toFixed(0)} ms untouched, ${reshapedMs.toFixed(0)} ms reshaped; verify-cli ${verifyMs.toFixed(0)} ms`);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: veto — diag.step (30×30×10 with two r=3 holes on one diagonal) turned 90° about its centre (solid.move made past the tools): volume, bounding box, faces and centre of mass unchanged, but the exact comparison with the true import fails 'shape is not the import's'; the pin is checked against both bodies (153.938 mm³ live, 40.841 mm³ as imported)", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const step = await holeyStep(x, repo, "diag", [[108, 8], [122, 22]]);
    const { ref, check } = await pinWith(x, repo, step, "diag.step");
    let g = await check();
    expect(g.checks.find((c: any) => c.id === "geometry diag.step")).toMatchObject({ ok: true, measured: "as imported" });
    const body = x.service.locks.findPart(repoIdentity(repo), "pin")!.references!["diag.step"]!.bodies[0]!.name;
    expect((await x.manager.request(ref, { tool: "execute", args: { command: "solid.move", params: { bodies: [body], axis: [0, 0, 1], angle: "90 deg", origin: [115, 15, 0] } }, kind: "mutate" })).result.isError).toBe(false);
    g = await check();
    expect(g.state).toBe("fail");
    const geo = String(g.checks.find((c: any) => c.id === "geometry diag.step").measured);
    expect(geo).toContain(`reference diag.step ${REFERENCE_RESHAPED} (shape is not the import's: it shares`);
    expect(geo).not.toMatch(/volume \d|bounding box|faces \d|centre of mass/);
    // The live body's hole moved to (122, 8): the pin is now buried in it (the whole pin, 153.938 mm³),
    // while against the TRUE import it still overlaps by the 40.841 mm³ it always did.
    expect(g.checks.find((c: any) => c.id === "interference diag.step").measured).toMatch(/by 153\.938 mm³/);
    expect(g.checks.find((c: any) => c.id === "interference diag.step as imported").measured).toMatch(/by 40\.841 mm³/);
  }, 300_000);

  test.skipIf(!REAL)("[A4] real: veto — big.step (600×600×10, four r=3 holes symmetric about its centre) with a r=3.006 pin 6 µm into one hole (0.453 mm³): reshaped by four hand-written offset_face features (the pin's hole and its diagonal partner grown 9 µm, the other two shrunk by the same material) the live body clears the pin and the summary numbers hold, but the shape check — a 0.1 nm depth over the import's surface (0.074 mm³ here), not 1e-6 of the volume (3.6 mm³) — fails; the true import, imported before and after the pin, still finds the 0.453 mm³; release_part writes nothing and verify-cli exits 1", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    const x = await buildPlate(repo, { cli: SOLIDCRAFT_CLI });
    const holes = [[100, 100], [500, 100], [100, 500], [500, 500]];
    await must(x.tools.open_part!({ part: "big" }));
    await must(x.tools.record_expectations!({ part: "big", process: "fdm-0.4", parameters: {}, expectations: { bbox: [10, 600, 600], volume: 3600000 - holes.length * Math.PI * 9 * 10, bodies: 1, holes: [{ diameter: 6, count: holes.length }] } }));
    await must(x.tools.execute!({ command: "solid.box", params: { length: 600, width: 600, height: 10, corner: [0, 0, 0], name: "Big" } }));
    for (const [hx, hy] of holes) await must(x.tools.execute!({ command: "solid.hole", params: { position: [hx, hy, 10], diameter: "6", depth: "10" } }));
    const step = join(repo, (await must(x.tools.export_part!({ part: "big", formats: ["step"] }))).json.exports[0].path);
    mkdirSync(join(repo, ".anvil-downloads"), { recursive: true });
    copyFileSync(step, join(repo, ".anvil-downloads", "big.step"));
    await must(x.tools.open_part!({ part: "pin" }));
    const r = 3.006;
    await must(x.tools.record_expectations!({ part: "pin", process: "fdm-0.4", parameters: {}, expectations: { bbox: [4, 2 * r, 2 * r], volume: Math.PI * r * r * 4, bodies: 1, holes: [] } }));
    await must(x.tools.execute!({ command: "solid.cylinder", params: { radius: String(r), height: "4", base: [100, 100, 6], name: "Pin", body_name: "Pin" } }));
    expect((await asOwner(x, x.tools.import_reference!({ part: "pin", file: ".anvil-downloads/big.step" }))).json.imported).toBe(true);
    const ref = partRef(repo, "pin");
    const stateDir = x.service.locks.file.replace(/\/cadwork\/locks\.json$/, "");
    const designPath = join(repo, "cad", "pin", "design.json");
    const check = async () => (await must(x.tools.check_part!({ part: "pin" }))).json;
    let g = await check();
    // Untouched: the live check and the true import both find the 6 µm overlap; the untouched
    // reference is the same solid as its import at the 0.1 nm depth (measured noise: exactly 0).
    expect(g.state).toBe("fail");
    expect(g.checks.find((c: any) => c.id === "interference big.step").measured).toMatch(/by 0\.453 mm³/);
    expect(g.checks.find((c: any) => c.id === "interference big.step as imported").measured).toMatch(/by 0\.453 mm³/);
    expect(g.checks.find((c: any) => c.id === "geometry big.step")).toMatchObject({ ok: true, measured: "as imported" });
    const recorded = x.service.locks.findPart(repoIdentity(repo), "pin")!.references!["big.step"]!.bodies[0]!;
    // The reshape: grow (100, 100) and (500, 500) to r 3.009; shrink (500, 100) and (100, 500) by the same area.
    const grown = 3.009;
    const b = String(3 - Math.sqrt(18 - grown * grown));
    await handWritten(x, ref, designPath, [
      ["solid.offset_face", { faces: [[103, 100, 5]], distance: String(3 - grown) }],
      ["solid.offset_face", { faces: [[503, 500, 5]], distance: String(3 - grown) }],
      ["solid.offset_face", { faces: [[503, 100, 5]], distance: b }],
      ["solid.offset_face", { faces: [[103, 500, 5]], distance: b }],
    ], "offset_face");
    g = await check();
    // The summary numbers held (the fast pre-check passes), and the live body clears the pin.
    const live = (await x.tools.execute!({ command: "inspect.measure", params: { bodies: [recorded.name] } })).json.bodies[0];
    expect(Math.abs(live.volume_mm3 - recorded.volume)).toBeLessThan(1e-6 * recorded.volume);
    expect(live.faces).toBe(recorded.faces);
    expect(g.state).toBe("fail");
    expect(g.checks.find((c: any) => c.id === "interference big.step")).toMatchObject({ ok: true, measured: "no overlap" });
    const geo = String(g.checks.find((c: any) => c.id === "geometry big.step").measured);
    expect(geo).toContain(`reference big.step ${REFERENCE_RESHAPED} (shape is not the import's: it shares`);
    expect(geo).not.toMatch(/volume \d|bounding box|faces \d|centre of mass/);
    // The import lacks ~3.4 mm³ in the live body: under 1e-6 of its volume, over the depth allowance.
    const shares = Number(/it shares ([\d.]+) of the import's ([\d.]+) mm³/.exec(geo)![2]) - Number(/it shares ([\d.]+)/.exec(geo)![1]);
    expect(shares).toBeGreaterThan(3);
    expect(shares).toBeLessThan(1e-6 * recorded.volume);
    expect(g.failing.join("\n")).toMatch(/interference big\.step as imported: .*by 0\.453 mm³/);
    const rel = await asOwner(x, x.tools.release_part!({ part: "pin" }));
    expect(rel.isError).toBe(true);
    expect(rel.text).toContain("the gate is fail");
    expect(existsSync(join(repo, "cad", "pin", "release"))).toBe(false);
    const v = await runVerifyCli(repo, ["--json", "--part", "pin"], { ANVIL_STATE_DIR: stateDir, ANVIL_SOLIDCRAFT_CLI: SOLIDCRAFT_CLI });
    expect(v.code).toBe(1);
    const p = v.json.parts.find((q: any) => q.part === "pin");
    expect(p.state).toBe("fail");
    expect(p.failing.join("\n")).toContain(`reference big.step ${REFERENCE_RESHAPED} (shape is not the import's`);
    expect(p.checks.find((c: any) => c.id === "interference big.step")).toMatchObject({ ok: true });
  }, 600_000);
});
