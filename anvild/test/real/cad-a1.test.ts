/**
 * [A1] Real-tool suite for Phase A1 (agent-cad-and-browser spec §8.3): the REAL `solidcraft-cli`
 * driven through the real manager and the real agent tools. Skipped unless `ANVIL_REAL_TOOLS=1`
 * (`bun test/tools/phase-gate.ts A1 --require-real` sets it and fails on any skip).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { partRef } from "../../src/cadwork/partfolder";
import { scriptSha } from "../../src/cadwork/poststep";
import { cleanupTemp, fakeCadSession, stopServices, tempRepo, until, writeDesign } from "../helpers/cad-work";
import { REFERENCE_PLATE, startFake } from "../helpers/fake-solidcraft";
import { REAL, SOLIDCRAFT_CLI, hasSolidcraft } from "../helpers/real-tools";

afterEach(async () => {
  await stopServices();
  cleanupTemp();
});

/** The real service + manager + tools on the real binary. */
const real = (repo: string) => {
  expect(hasSolidcraft()).toBe(true); // a missing binary is a FAILURE in a real run, never a skip
  return fakeCadSession(repo, { resolveCli: () => ({ path: SOLIDCRAFT_CLI, source: "env" }) });
};
const V80 = 23335.2;
const V120 = 35335.2;
const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThan(0.05);

describe("real SolidCraft through the manager", () => {
  test.skipIf(!REAL)("[A1] real: the 16-command plate builds, design.json is written, and it replays in a fresh process to the same volume", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const { tools, service, manager } = real(repo);
    const status = await service.refreshStatus();
    expect(status.available).toBe(true);
    expect(status.version).toMatch(/^\d+\.\d+\.\d+/);

    expect((await tools.open_part!({ part: "plate" })).isError).toBe(false);
    const t0 = performance.now();
    const built = await tools.batch!({ commands: REFERENCE_PLATE });
    const ms = performance.now() - t0;
    expect(built.isError).toBe(false);
    expect(built.json).toMatchObject({ completed: 16, ok: true });
    const live = (await tools.measure!({})).json;
    near(live.total.volume_mm3, V80);
    expect(live.bodies[0].faces).toBe(22);

    const path = join(repo, "cad", "plate", "design.json");
    expect(existsSync(path)).toBe(true);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.about.design).toBe("plate");
    expect(doc.about.format).toMatch(/^solidcraft\/\d+$/);
    expect(doc.commands.length).toBeGreaterThan(0);
    expect(manager.status(partRef(repo, "plate"))!.scriptSha).toBe(scriptSha(doc.commands));
    // SolidCraft wrote nothing itself: the part folder holds the script (and our .cache), no .sc.
    expect(readdirSync(join(repo, "cad", "plate")).filter((f) => f !== ".cache")).toEqual(["design.json"]);

    // A fresh process, outside the manager, replays the committed file to the same numbers.
    const fresh = await startFake({ cli: [SOLIDCRAFT_CLI], allow: [join(repo, "cad", "plate")], inFile: path, env: { SOLIDCRAFT_GPU: "cpu" } });
    try {
      const replayed = (await fresh.call("measure", {})).json;
      near(replayed.total.volume_mm3, V80);
      expect(Math.abs(replayed.total.volume_mm3 - live.total.volume_mm3)).toBeLessThan(1e-6 * V80);
      expect(replayed.bodies[0].faces).toBe(22);
      const timeline = (await fresh.call("inspect_design", { measure: false, sketches: false, timeline: "summary", bodies: "names" })).json.timeline;
      expect(timeline.filter((f: any) => f.error)).toEqual([]);
    } finally {
      await fresh.close();
    }
    console.log(`[A1 real] plate batch + script write: ${ms.toFixed(0)} ms (recorded, not asserted)`);
  }, 120_000);

  test.skipIf(!REAL)("[A1] real: killing the process between two calls, the next call recovers the design", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const { tools, manager } = real(repo);
    const ref = partRef(repo, "plate");
    await tools.open_part!({ part: "plate" });
    expect((await tools.batch!({ commands: REFERENCE_PLATE })).isError).toBe(false);
    const before = (await tools.measure!({ summary: true })).json.total.volume_mm3;
    near(before, V80);
    const pid = manager.status(ref)!.pid!;
    process.kill(pid, "SIGKILL");
    await until(() => manager.status(ref)!.live === false, "the manager to see the kill");
    const after = await tools.measure!({ summary: true });
    expect(after.isError).toBe(false);
    near(after.json.total.volume_mm3, V80);
    expect(after.json.bodies[0].faces).toBe(22);
    expect(manager.status(ref)!.pid).not.toBe(pid);
    expect(manager.status(ref)!.state.status).toBe("unverified"); // replayed with no failed features
  }, 120_000);

  test.skipIf(!REAL)("[A1] real: editing design.json on disk then measuring reflects the edited file", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const { tools } = real(repo);
    await tools.open_part!({ part: "plate" });
    await tools.batch!({ commands: REFERENCE_PLATE });
    near((await tools.measure!({ summary: true })).json.total.volume_mm3, V80);
    const path = join(repo, "cad", "plate", "design.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const L = doc.commands.find((c: any) => c.command === "parameters.add" && c.params.name === "L");
    expect(L.params.expression).toBe("80 mm");
    L.params.expression = "120 mm";
    writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
    const measured = await tools.measure!({ summary: true });
    near(measured.json.total.volume_mm3, V120);
    expect(measured.notes.join(" ")).toContain("reloaded");
  }, 120_000);

  test.skipIf(!REAL)("[A1] real: set_parameter refuses an unknown name, undo reverts a whole batch, and a broken feature marks the part failed", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const { tools, manager } = real(repo);
    const ref = partRef(repo, "plate");
    await tools.open_part!({ part: "plate" });
    await tools.batch!({ commands: REFERENCE_PLATE });

    const set = await tools.set_parameter!({ name: "L", expression: "120" });
    expect(set.isError).toBe(false);
    near((await tools.measure!({ summary: true })).json.total.volume_mm3, V120);
    const typo = await tools.set_parameter!({ name: "Lenght", expression: "90" });
    expect(typo.isError).toBe(true);
    expect(typo.text).toContain("unknown parameter");
    const userParams = (await tools.inspect_design!({ measure: false, sketches: false })).json.params.filter((p: any) => !p.model).map((p: any) => p.name);
    expect(userParams).toEqual(["L", "W", "T", "inset"]);

    await tools.undo!({}); // the parameter change
    near((await tools.measure!({ summary: true })).json.total.volume_mm3, V80);
    const undone = await tools.undo!({}); // the whole 16-command batch, in one agent undo
    expect(undone.isError).toBe(false);
    expect((await tools.measure!({ summary: true })).json.body_count).toBe(0);
    expect((await tools.inspect_design!({ measure: false, sketches: false, bodies: false, timeline: false })).json.active_sketch).toBeNull();
    expect(JSON.parse(readFileSync(join(ref.dir, "design.json"), "utf8")).commands).toEqual([]);
    await tools.redo!({});
    near((await tools.measure!({ summary: true })).json.total.volume_mm3, V80);

    // W=8 breaks the corner fillet: SolidCraft answers success, the manager reads the timeline.
    const broken = await tools.set_parameter!({ name: "W", expression: "8" });
    expect(broken.isError).toBe(false);
    expect(manager.status(ref)!.state.status).toBe("fail");
    expect(manager.status(ref)!.state.featureErrors.map((f) => f.feature)).toContain("Corners");
    expect(broken.notes.join(" ")).toContain("failed to build");
  }, 120_000);

  test.skipIf(!REAL)("[A1] real: file commands never reach SolidCraft, exports land in .cache/exports, a screenshot is an image, a newer format is refused", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const { tools, emitted } = real(repo);
    await tools.open_part!({ part: "plate" });
    await tools.batch!({ commands: REFERENCE_PLATE });
    const dir = join(repo, "cad", "plate");
    for (const command of ["file.save", "file.save_as", "file.export", "file.export_step", "file.new"]) {
      expect((await tools.execute!({ command, params: { path: join(dir, "x.sc") } })).isError).toBe(true);
    }
    expect((await tools.batch!({ commands: [{ command: "save", params: { path: join(dir, "x.sc") } }] })).isError).toBe(true);
    expect(readdirSync(dir).filter((f) => f !== ".cache")).toEqual(["design.json"]);
    near((await tools.measure!({ summary: true })).json.total.volume_mm3, V80); // still the plate: file.new did not run

    const exported = await tools.export_part!({ part: "plate", formats: ["step", "3mf", "glb"] });
    expect(exported.isError).toBe(false);
    expect(readdirSync(join(dir, ".cache", "exports")).sort()).toEqual(["plate.3mf", "plate.glb", "plate.step"]);
    expect(readFileSync(join(dir, ".cache", "exports", "plate.step"), "utf8").startsWith("ISO-10303-21")).toBe(true);
    expect(emitted.map((e) => e.file.name)).toEqual(["plate.step", "plate.3mf", "plate.glb"]);

    const shot = await tools.screenshot!({ width: 320, height: 200 });
    expect(shot.isError).toBe(false);
    const image = shot.content.find((c: any) => c.type === "image");
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(1, 4).toString("latin1")).toBe("PNG");

    // The real binary does not enforce about.format on a script; Anvil does.
    const doc = JSON.parse(readFileSync(join(dir, "design.json"), "utf8"));
    writeDesign(repo, "future", doc.commands, { ...doc.about, design: "future", format: "solidcraft/9999" });
    const refused = await tools.open_part!({ part: "future" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("this machine's SolidCraft is older than the design");
  }, 180_000);
});
