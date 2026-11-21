/**
 * [A1] Real-tool suite for Phase A1 (agent-cad-and-browser spec §8.3): the REAL `solidcraft-cli`
 * driven through the real manager and the real agent tools. Skipped unless `ANVIL_REAL_TOOLS=1`
 * (`bun test/tools/phase-gate.ts A1 --require-real` sets it and fails on any skip).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAllowedCommand, refusedCommand } from "../../src/agent/cad-command-allow";
import { partRef } from "../../src/cadwork/partfolder";
import { scriptSha } from "../../src/cadwork/poststep";
import { cleanupTemp, fakeCadSession, stopServices, tempDir, tempRepo, until, writeDesign } from "../helpers/cad-work";
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
    expect(readdirSync(join(repo, "cad", "plate")).filter((f) => f !== ".cache").sort()).toEqual(["design.json", "part.json"]); // part.json: the expectations (Phase A2)

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
    // Replayed with no failed features and no replay failure. (`status` itself is the gate's verdict
    // since Phase A2, which this suite's placeholder expectations do not describe.)
    expect(manager.status(ref)!.state.featureErrors).toEqual([]);
    expect(manager.status(ref)!.state.replayFailure).toBeUndefined();
    expect(manager.status(ref)!.state.conflict).toBe(false);
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
    expect(readdirSync(dir).filter((f) => f !== ".cache").sort()).toEqual(["design.json", "part.json"]);
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

  test.skipIf(!REAL)("[A1] real: every command id the binary reports is either allow-listed or refused, and refused commands leave the part folder untouched", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const { tools, manager } = real(repo);
    const ref = partRef(repo, "plate");
    await tools.open_part!({ part: "plate" });
    expect((await tools.batch!({ commands: REFERENCE_PLATE })).isError).toBe(false);
    const dir = join(repo, "cad", "plate");
    const designBefore = readFileSync(join(dir, "design.json"), "utf8");

    // The binary's own list, read past the agent's tools (which refuse an unfiltered listing).
    const listed = (await manager.request(ref, { tool: "list_commands", args: { fields: ["id", "params"] }, kind: "read" })).result.json as { id: string; params: string }[];
    expect(listed.length).toBeGreaterThan(500);
    const allowed = listed.filter((c) => isAllowedCommand(c.id));
    const refused = listed.filter((c) => !isAllowedCommand(c.id));
    for (const c of refused) expect(refusedCommand(c.id)).toBeString();
    for (const c of allowed) expect(refusedCommand(c.id)).toBeUndefined();
    expect(allowed.length).toBeGreaterThan(200);
    expect(refused.length).toBeGreaterThan(200);
    // No whole family the review named is reachable.
    for (const family of ["file", "doc", "plugin", "diagnostics", "settings", "library", "canvas", "pointcloud", "render", "motion", "engine", "edit"]) {
      expect(allowed.filter((c) => c.id.startsWith(family + "."))).toEqual([]);
    }
    // Allowed commands whose documentation mentions a path, file, folder, font or the clipboard:
    // each was read and is geometry (a sweep's path curve, occurrence ids, timeline folders) or is
    // covered by a parameter rule (a font file). A release that adds another one fails here until
    // it has been read and either excepted in the table or added to this list.
    const reviewed = [
      "sketch.create", "sketch.spline.reverse", "sketch.text", "sketch.edit_text", "sketch.arc3d", "surface.sweep", "sketch.trim.path", "solid.sweep", "solid.pattern.path",
      "solid.pipe", "construct.plane.offset", "construct.plane.at_angle", "construct.point.along_path", "construct.plane.along_path", "frame.end_cap", "component.activate",
      "occurrence.properties", "occurrence.copy", "occurrence.move", "occurrence.align", "occurrence.reparent", "inspect.interference", "timeline.delete", "timeline.group",
      "timeline.rename_group", "timeline.move_many", "timeline.suppress", "timeline.inspect", "timeline.export_script", "inspect.section",
    ];
    const mentions = allowed.filter((c) => /\b(path|file|url|folder|clipboard|font)\b/i.test(c.params ?? "")).map((c) => c.id);
    expect(mentions.filter((id) => !reviewed.includes(id))).toEqual([]);

    // The ids the review reached, each with the path that did the damage: all refused, nothing written.
    const target = join(dir, "design.json");
    const attempts: [string, Record<string, unknown>][] = [
      ["doc.open", { path: join(dir, "design.json") }],
      ["doc.recover", {}],
      ["parameters.export", { path: target, format: "json" }],
      ["parameters.export", { path: join(dir, "params.csv") }],
      ["parameters.import", { path: target }],
      ["sketch.export_dxf", { path: join(dir, "x.dxf") }],
      ["sketch.insert_dxf", { path: join(dir, "x.dxf") }],
      ["library.export", { path: join(dir, "lib.json") }],
      ["component.insert_design", { path: target }],
      ["plugin.inspect", { path: join(dir, "p.wasm") }],
      ["plugin.run", { name: "x" }],
      ["diagnostics.crash_test", {}],
      ["diagnostics.report_issue", { title: "x" }],
      ["edit.undo", {}],
      ["edit.restore_checkpoint", { checkpoint: 1 }],
      ["engine.commands", {}],
      ["timeline.export_script", { path: join(dir, "script.json") }],
      ["solid.box", { length: 1, width: 1, height: 1, path: target }],
    ];
    for (const [command, params] of attempts) {
      const r = await tools.execute!({ command, params });
      expect(r.isError).toBe(true);
      const b = await tools.batch!({ commands: [{ command, params }] });
      expect(b.isError).toBe(true);
    }
    for (const step of ["undo", "redo", "set_parameter", "save"]) {
      expect((await tools.batch!({ commands: [{ command: step, params: { name: "L", value: 1, path: join(dir, "x.sc") } }] })).isError).toBe(true);
    }
    expect(readdirSync(dir).sort()).toEqual([".cache", "design.json", "part.json"]); // part.json: the daemon's own (Phase A2)
    expect(readFileSync(join(dir, "design.json"), "utf8")).toBe(designBefore);
    // (Phase A3: the daemon's own preview of the part is the one thing that lives in .cache — with,
    // since Phase A4, the daemon's own card thumbnail of the same revision.)
    expect(readdirSync(join(dir, ".cache")).filter((n) => !/^preview-\d+\.glb$/.test(n) && !/^thumb-\d+\.png$/.test(n))).toEqual([]);
    near((await tools.measure!({ summary: true })).json.total.volume_mm3, V80); // still the plate, still alive
    // The undo stack is intact: one undo still reverts the whole batch.
    expect((await tools.undo!({})).isError).toBe(false);
    expect((await tools.measure!({ summary: true })).json.body_count).toBe(0);
  }, 120_000);

  test.skipIf(!REAL)("[A1] real: a symlinked part folder or cad folder is refused and nothing is written outside the worktree", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const outside = tempDir("anvil-cad-real-outside-");
    const { tools, manager } = real(repo);
    mkdirSync(join(repo, "cad"), { recursive: true });
    symlinkSync(outside, join(repo, "cad", "evil"));
    const opened = await tools.open_part!({ part: "evil" });
    expect(opened.isError).toBe(true);
    expect(opened.text).toContain("symbolic link");
    // With no part open, nothing runs; exporting the linked part is refused too.
    expect((await tools.execute!({ command: "solid.box", params: { length: 1, width: 1, height: 1 } })).isError).toBe(true);
    expect((await tools.export_part!({ part: "evil", formats: ["step"] })).isError).toBe(true);
    expect(manager.liveCount()).toBe(0);
    expect(readdirSync(outside)).toEqual([]);

    // A real part still works, and an alias linked to it is refused (one folder, one process).
    await tools.open_part!({ part: "plate" });
    expect((await tools.execute!({ command: "solid.box", params: { length: 10, width: 10, height: 10 } })).isError).toBe(false);
    symlinkSync(join(repo, "cad", "plate"), join(repo, "cad", "alias"));
    expect((await tools.open_part!({ part: "alias" })).isError).toBe(true);
    expect(manager.liveCount()).toBe(1);

    const repo2 = tempRepo("anvil-cad-real-");
    const outside2 = tempDir("anvil-cad-real-outside-");
    symlinkSync(outside2, join(repo2, "cad"));
    const other = real(repo2);
    expect((await other.tools.open_part!({ part: "plate" })).isError).toBe(true);
    expect(readdirSync(outside2)).toEqual([]);
  }, 120_000);

  test.skipIf(!REAL)("[A1] real: a design.json is screened before it is loaded — one carrying parameters.export to an outside file is refused and the file is untouched; a clean one loads by batch to 23335.2 mm³", async () => {
    // Build the reference plate once, through the tools, so design.json is a REAL export.
    const repo = tempRepo("anvil-cad-real-");
    const first = real(repo);
    expect((await first.tools.open_part!({ part: "plate" })).isError).toBe(false);
    expect((await first.tools.batch!({ commands: REFERENCE_PLATE })).isError).toBe(false);
    await first.service.shutdown();
    const path = join(repo, "cad", "plate", "design.json");
    const clean = readFileSync(path, "utf8");

    // The clean export passes the screen and loads (no --in: a batch on an empty process).
    const second = real(repo);
    const opened = await second.tools.open_part!({ part: "plate" });
    expect(opened.isError).toBe(false);
    near((await second.tools.measure!({ summary: true })).json.total.volume_mm3, V80);
    await second.service.shutdown();

    // The same script with a step that writes outside the part folder: SolidCraft would write it
    // with `--in` (decision 88). The screen refuses it, nothing starts, the victim is unchanged.
    const outside = tempDir("anvil-cad-victim-");
    const victim = join(outside, "authorized_keys");
    writeFileSync(victim, "ssh-ed25519 AAAA original\n");
    const doc = JSON.parse(clean);
    doc.commands.push({ command: "parameters.export", params: { path: victim } });
    writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
    const hostile = readFileSync(path, "utf8");
    const third = real(repo);
    const refused = await third.tools.open_part!({ part: "plate" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("refused by Anvil's script screen");
    expect(refused.text).toContain("parameters.export");
    expect(third.manager.liveCount()).toBe(0); // nothing was spawned for it
    expect(third.manager.status(partRef(repo, "plate"))?.state.status).toBe("fail");
    expect(third.manager.status(partRef(repo, "plate"))?.state.reason).toContain("refused by Anvil's script screen");
    // Rebuild (cad.design.refresh) is a load too, and is refused the same way.
    await expect(third.manager.reload(partRef(repo, "plate"))).rejects.toThrow("refused by Anvil's script screen");
    expect(readFileSync(victim, "utf8")).toBe("ssh-ed25519 AAAA original\n");
    expect(readdirSync(outside)).toEqual(["authorized_keys"]);
    expect(readFileSync(path, "utf8")).toBe(hostile); // not rewritten either
  }, 180_000);
});
