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
import { REFERENCE_CHANGED, importFeatureName } from "../../src/cadwork/refs";
import { REFERENCE_NOT_COVERED } from "../../src/cadwork/refresh";
import { expectedReleaseFiles, MANIFEST } from "../../src/cadwork/release";
import { PLATE_EXPECTATIONS, buildPlate, cleanupTemp, stopServices, tempRepo, type ToolReply } from "../helpers/cad-work";
import { repoIdentity } from "../../src/cadwork/locks";
import { UNAPPROVED_PARAMETER } from "../../src/session/cadwork-service";
import { REAL, SOLIDCRAFT_CLI, hasSolidcraft } from "../helpers/real-tools";

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
