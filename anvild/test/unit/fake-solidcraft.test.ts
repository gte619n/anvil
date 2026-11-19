/**
 * [F0] fake-solidcraft (agent-cad-and-browser spec §8.2): the deterministic stand-in for
 * `solidcraft-cli mcp` that every CI-run CAD suite drives. These tests spawn it for real and pin the
 * numbers and reply shapes copied from SolidCraft 0.44.1, plus every FAKE_SC_* failure hook.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../helpers";
import { FAKE_SOLIDCRAFT, REFERENCE_PLATE, startFake, type FakeSolidcraft, type StartOptions } from "../helpers/fake-solidcraft";

const open: FakeSolidcraft[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((p) => p.close()));
  for (const c of cleanups.splice(0)) c();
});

/** A fake with its own allowed scratch folder; both are torn down after the test. */
async function fake(opts: StartOptions = {}): Promise<{ sc: FakeSolidcraft; dir: string }> {
  const { dir, cleanup } = tmpDir("fake-sc-");
  cleanups.push(cleanup);
  const sc = await startFake({ allow: [dir], ...opts });
  open.push(sc);
  return { sc, dir };
}
async function plate(sc: FakeSolidcraft) {
  const r = await sc.call("batch", { commands: REFERENCE_PLATE, verbose: false });
  expect(r.isError).toBe(false);
  expect(r.json.completed).toBe(16);
  return r;
}
const volume = async (sc: FakeSolidcraft) => (await sc.call("measure", { summary: true })).json.total.volume_mm3 as number;

describe("MCP protocol", () => {
  test("[F0] initialize, tools/list and ping answer like an MCP server", async () => {
    const { dir, cleanup } = tmpDir("fake-sc-");
    cleanups.push(cleanup);
    const sc = await startFake({ allow: [dir], noHandshake: true });
    open.push(sc);
    const init = await sc.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(init.jsonrpc).toBe("2.0");
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo).toEqual({ name: "solidcraft", title: "SolidCraft", version: "0.44.1" });
    expect(init.result.capabilities.tools).toEqual({ listChanged: false });
    const tools = (await sc.rpc("tools/list")).result.tools as { name: string; inputSchema: unknown }[];
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["batch", "body_topology", "check_parameters", "describe_command", "execute", "export", "inspect_design", "list_commands", "measure", "new_design", "open", "redo", "save", "screenshot", "set_parameter", "skill_reference", "undo", "version"],
    );
    expect((await sc.rpc("ping")).result).toEqual({});
    expect((await sc.rpc("foo/bar")).error).toEqual({ code: -32601, message: "method `foo/bar` not found" });
    expect((await sc.rpc("tools/call", { name: "nope", arguments: {} })).error).toEqual({ code: -32602, message: "unknown tool `nope`" });
    expect((await sc.rpc("tools/call", { name: "describe_command", arguments: {} })).error.message).toBe("describe_command: missing required argument `id`");
  });

  test("[F0] version reports FAKE_SC_VERSION, and --version prints it like the CLI", async () => {
    const { sc } = await fake({ env: { FAKE_SC_VERSION: "0.45.0" } });
    expect((await sc.call("version")).json).toEqual({ commit: "fake", mode: "headless", version: "0.45.0" });
    const p = Bun.spawnSync(["bun", FAKE_SOLIDCRAFT, "--version"], { env: { ...process.env, FAKE_SC_VERSION: "0.45.0" } });
    expect(p.stdout.toString().trim()).toBe("solidcraft-cli 0.45.0");
  });

  test("[F0] an unknown command is an error result, as the real tool answers", async () => {
    const { sc } = await fake();
    const r = await sc.call("execute", { command: "nope.nope", params: {} });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("unknown command `nope.nope`");
    expect((await sc.call("describe_command", { id: "nope.nope" })).text).toBe("unknown command `nope.nope`");
  });

  test("[F0] list_commands filters, and finds the STEP import command", async () => {
    const { sc } = await fake();
    const hits = (await sc.call("list_commands", { filter: "import", compact: true })).json;
    expect(hits).toEqual([{ id: "file.insert_step", label: "Insert STEP" }]);
    const box = (await sc.call("list_commands", { filter: "solid.box" })).json;
    expect(box).toHaveLength(1);
    expect(Object.keys(box[0]).sort()).toEqual(["disabled_reason", "enabled", "icon", "id", "label", "panel", "params", "shortcut", "tab"]);
    expect((await sc.call("describe_command", { id: "solid.box" })).json.id).toBe("solid.box");
    expect((await sc.call("skill_reference", { skill: "solidcraft-modeling" })).text).toContain("reference plate");
    expect((await sc.call("skill_reference", { skill: "nope" })).isError).toBe(true);
  });
});

describe("reference plate", () => {
  test("[F0] the plate measures 23335.2 mm³ with 22 faces at L=80", async () => {
    const { sc } = await fake();
    const built = await plate(sc);
    // Feature results carry the real tool's shape.
    expect(built.json.results[7]).toEqual({ changed_bodies: [], created_bodies: ["Body1"], feature: 2, ms: 0.1, name: "Plate", removed_bodies: [], warning: null });
    expect(built.json.results[15].name).toBe("Holes");
    const m = (await sc.call("measure")).json;
    expect(m.body_count).toBe(1);
    expect(Math.abs(m.total.volume_mm3 - 23335.2)).toBeLessThan(0.05);
    expect(m.bodies[0].faces).toBe(22);
    expect(m.bodies[0].face_types).toEqual({ cylinder: 12, plane: 10 });
    expect(m.bodies[0].bbox).toEqual({ min: [-40, -25, 0], max: [40, 25, 6] });
    expect(m.bodies[0].name).toBe("Body1");
  });

  test("[F0] set_parameter L=120 rebuilds the plate to 35335.2 mm³", async () => {
    const { sc } = await fake();
    await plate(sc);
    const set = (await sc.call("set_parameter", { name: "L", value: "120" })).json;
    expect(set).toEqual({ display_value: 120, errors: [], expression: "120", name: "L", recomputed: 6, restored: 0, value: 120 });
    const m = (await sc.call("measure", { summary: true })).json;
    expect(Math.abs(m.total.volume_mm3 - 35335.2)).toBeLessThan(0.05);
    expect(m.bodies[0].faces).toBe(22);
    expect(m.bodies[0].bbox).toEqual({ min: [-60, -25, 0], max: [60, 25, 6] });
    // inspect_design lists the parameters the way the panel reads them.
    const params = (await sc.call("inspect_design", { measure: false })).json.params;
    expect(params[0]).toEqual({ comment: "", error: null, expression: "120", model: false, name: "L", unit: "mm", value: 120 });
    expect(params.map((p: { name: string }) => p.name)).toEqual(["L", "W", "T", "inset"]);
  });

  test("[F0] check_parameters tries a value without keeping it", async () => {
    const { sc } = await fake();
    await plate(sc);
    const c = (await sc.call("check_parameters", { set: { L: 120 }, summary: true })).json;
    expect(Math.abs(c.measure.total.volume_mm3 - 35335.2)).toBeLessThan(0.05);
    expect(c.values).toEqual({ L: 120 });
    expect(c.restored).toBe(true);
    expect(Math.abs((await volume(sc)) - 23335.2)).toBeLessThan(0.05);
  });

  test("[F0] hole table data is present in body_topology", async () => {
    const { sc } = await fake();
    await plate(sc);
    const cyl = (await sc.call("body_topology", { body: "Body1", faces: "cylinders" })).json.cylinders as { names: string[]; radius: number; origin: number[]; axis: number[]; extent: number[] }[];
    expect(cyl).toHaveLength(12);
    const bores = cyl.filter((c) => c.names[0]!.includes(":bore:side"));
    const cbores = cyl.filter((c) => c.names[0]!.includes(":cbore:side"));
    const blends = cyl.filter((c) => c.names[0]!.includes(":blend("));
    expect([bores.length, cbores.length, blends.length]).toEqual([4, 4, 4]);
    // Four Ø3.4 through bores under four Ø6.5 × 3.3 counterbores, at (±32, ±17).
    for (const b of bores) {
      expect(b.radius * 2).toBeCloseTo(3.4, 9);
      expect(b.axis).toEqual([0, 0, 1]);
      expect(b.extent[1]! - b.extent[0]!).toBeCloseTo(2.7, 9);
    }
    for (const c of cbores) {
      expect(c.radius * 2).toBeCloseTo(6.5, 9);
      expect(c.extent[1]! - c.extent[0]!).toBeCloseTo(3.3, 9);
    }
    const xy = (list: typeof cyl) => list.map((c) => `${c.origin[0]},${c.origin[1]}`).sort();
    expect(xy(bores)).toEqual(["-32,-17", "-32,17", "32,-17", "32,17"]);
    expect(xy(cbores)).toEqual(xy(bores));
    expect(bores.map((b) => b.names[0])).toEqual(["F5:bore:side:0", "F5:bore:side:0@F6.1", "F5:bore:side:0@F6.2", "F5:bore:side:0@F6.3"]);
    expect(blends.map((b) => b.radius)).toEqual([5, 5, 5, 5]);

    // The full listing gives every face; a cylindrical one carries `cylinder` and a null plane_normal.
    const faces = (await sc.call("body_topology", { body: "Body1" })).json.faces as { name: string; cylinder?: { radius: number }; plane_normal: number[] | null }[];
    expect(faces).toHaveLength(22);
    const bore = faces.find((f) => f.name === "F5:bore:side:0")!;
    expect(bore.cylinder!.radius).toBeCloseTo(1.7, 9);
    expect(bore.plane_normal).toBeNull();
    expect(faces.find((f) => f.name === "F2:top")!.plane_normal).toEqual([0, 0, 1]);
    // The holes follow the parameters.
    await sc.call("set_parameter", { name: "L", value: 120 });
    const moved = (await sc.call("body_topology", { body: "Body1", faces: "cylinders" })).json.cylinders as typeof cyl;
    expect(xy(moved.filter((c) => c.names[0]!.includes(":bore:side")))).toEqual(["-52,-17", "-52,17", "52,-17", "52,17"]);
    const bad = await sc.call("body_topology", { body: "Nope" });
    expect(bad.isError).toBe(true);
  });

  test("[F0] removing the hole pattern changes volume and face count, and undo/redo restore them", async () => {
    const { sc } = await fake();
    await plate(sc);
    expect((await sc.call("undo")).json).toEqual({ undone: "Rectangular Pattern" });
    const m = (await sc.call("measure", { summary: true })).json;
    // One counterbored hole left: 3 × 134.018 mm³ come back, 9 faces go.
    expect(m.total.volume_mm3).toBeCloseTo(23335.167 + 3 * 134.0178, 2);
    expect(m.bodies[0].faces).toBe(13);
    expect((await sc.call("redo")).json).toEqual({ redone: "Rectangular Pattern" });
    expect(Math.abs((await volume(sc)) - 23335.2)).toBeLessThan(0.05);
    const none = await sc.call("redo");
    expect(none.isError).toBe(true);
    expect(none.text).toBe("nothing to redo");
  });
});

describe("script round trip", () => {
  test("[F0] an exported script replayed in a fresh process reproduces the same measure", async () => {
    const { sc, dir } = await fake();
    await plate(sc);
    await sc.call("set_parameter", { name: "L", value: "120" });
    const before = (await sc.call("measure")).json;
    const scriptPath = join(dir, "plate.script.json");
    const exported = (await sc.call("execute", { command: "timeline.export_script", params: { path: scriptPath } })).json;
    expect(exported.script.about).toMatchObject({ format: "solidcraft/58", version: "0.44.1" });
    expect(exported.script.commands[0]).toEqual({ command: "parameters.add", params: { expression: "120", name: "L", unit: "mm" } });
    expect(exported.steps).toBe(exported.script.commands.length);
    expect(JSON.parse(readFileSync(scriptPath, "utf8"))).toEqual(exported.script);
    await sc.close();

    // A brand-new process, opened on the script at startup.
    const again = await startFake({ allow: [dir], inFile: scriptPath });
    open.push(again);
    const after = (await again.call("measure")).json;
    expect(after).toEqual(before);
    expect(Math.abs(after.total.volume_mm3 - 35335.2)).toBeLessThan(0.05);

    // …and the same through the `open` tool and through `batch {path}` in further fresh processes.
    const viaOpen = await startFake({ allow: [dir] });
    open.push(viaOpen);
    expect((await viaOpen.call("open", { path: scriptPath })).json).toEqual({ errors: 0, features: 6, name: "plate.script", path: scriptPath });
    expect((await viaOpen.call("measure")).json).toEqual(before);
    const viaBatch = await startFake({ allow: [dir] });
    open.push(viaBatch);
    expect((await viaBatch.call("batch", { path: scriptPath, verbose: false })).json.ok).toBe(true);
    expect((await viaBatch.call("measure")).json).toEqual(before);
  });

  test("[F0] save then open restores the design, parameters included", async () => {
    const { sc, dir } = await fake();
    await plate(sc);
    const path = join(dir, "plate.sc");
    const saved = (await sc.call("save", { path })).json;
    expect(saved.name).toBe("plate");
    expect(saved.bytes).toBe(readFileSync(path).length);
    expect((await sc.call("new_design")).json).toEqual({ name: "Untitled" });
    expect(await volume(sc)).toBe(0);
    expect((await sc.call("open", { path })).json.features).toBe(6);
    expect(Math.abs((await volume(sc)) - 23335.2)).toBeLessThan(0.05);
    const missing = await sc.call("open", { path: join(dir, "none.sc") });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("No such file or directory");
  });

  test("[F0] opening a script from a newer format fails", async () => {
    const { sc, dir } = await fake();
    await plate(sc);
    const script = (await sc.call("execute", { command: "timeline.export_script", params: {} })).json.script;
    script.about.format = "solidcraft/59";
    const newer = join(dir, "newer.script.json");
    writeFileSync(newer, JSON.stringify(script));
    await sc.call("new_design");
    const r = await sc.call("open", { path: newer });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("this design was saved by a newer SolidCraft (format 59, this version reads up to 58)");
    expect(await volume(sc)).toBe(0); // nothing was loaded

    // The same file opens in a build that reads format 59…
    const next = await fake({ env: { FAKE_SC_FORMAT: "59" } });
    writeFileSync(join(next.dir, "s.json"), JSON.stringify(script));
    expect((await next.sc.call("open", { path: join(next.dir, "s.json") })).isError).toBe(false);
    // …a `--in` start on it exits non-zero in the older build…
    const p = Bun.spawnSync(["bun", FAKE_SOLIDCRAFT, "mcp", "--headless", "--allow-path", dir, "--in", newer], { stdin: "ignore" });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("newer SolidCraft");
    // …and FAKE_SC_NEWER=warn mimics what real 0.44.1 was seen to do: open, with a warning.
    const warn = await fake({ env: { FAKE_SC_NEWER: "warn" } });
    writeFileSync(join(warn.dir, "s.json"), JSON.stringify(script));
    const w = (await warn.sc.call("open", { path: join(warn.dir, "s.json") })).json;
    expect(w.newer_file).toMatchObject({ format: 59, reads_up_to: 58 });
    expect(w.warnings).toHaveLength(1);
  });
});

describe("files", () => {
  test("[F0] export writes placeholders with the right magic bytes", async () => {
    const { sc, dir } = await fake();
    await plate(sc);
    const out = async (name: string, format?: string) => {
      const path = join(dir, name);
      const r = (await sc.call("export", { path, ...(format ? { format } : {}) })).json;
      const bytes = readFileSync(path);
      expect(r.bytes).toBe(bytes.length);
      return { r, bytes };
    };
    const glb = await out("p.glb", "glb");
    expect(glb.r.format).toBe("Glb");
    expect(glb.bytes.subarray(0, 4).toString("latin1")).toBe("glTF");
    expect(glb.bytes.readUInt32LE(4)).toBe(2);
    expect(glb.bytes.readUInt32LE(8)).toBe(glb.bytes.length);
    expect(JSON.parse(glb.bytes.subarray(20).toString()).asset.version).toBe("2.0");
    const step = await out("p.step"); // format from the extension
    expect(step.r.format).toBe("Step");
    expect(step.bytes.toString()).toStartWith("ISO-10303-21;\nHEADER;");
    expect(step.bytes.toString().trimEnd()).toEndWith("END-ISO-10303-21;");
    const tmf = await out("p.3mf", "3mf");
    expect(tmf.r.format).toBe("ThreeMf");
    expect([...tmf.bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const stl = await out("p.stl", "stl");
    expect(stl.r.format).toBe("StlBinary");
    expect(stl.bytes.length).toBe(84);
    expect(stl.bytes.subarray(0, 14).toString("latin1")).toBe("SolidCraft STL");
    expect(stl.bytes.readUInt32LE(80)).toBe(0);
  });

  test("[F0] export outside the allowed folders is refused", async () => {
    const { sc, dir } = await fake();
    await plate(sc);
    const outside = tmpDir("fake-sc-outside-");
    cleanups.push(outside.cleanup);
    const path = join(outside.dir, "p.step");
    const r = await sc.call("export", { path, format: "step" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("outside the folders this agent may use");
    expect(r.text).toContain("allow another folder with `--allow-path DIR`");
    expect(existsSync(path)).toBe(false);
    // A path that climbs out of the allowed folder, and a relative path, are refused too.
    expect((await sc.call("export", { path: join(dir, "..", "escape.step") })).isError).toBe(true);
    expect((await sc.call("export", { path: "rel.step" })).isError).toBe(true);
    expect((await sc.call("save", { path: join(outside.dir, "p.sc") })).isError).toBe(true);
    expect((await sc.call("open", { path: join(outside.dir, "p.sc") })).isError).toBe(true);
    // An empty design has nothing to export.
    await sc.call("new_design");
    expect((await sc.call("export", { path: join(dir, "e.step") })).text).toBe("nothing to export: the design has no bodies");
  });

  test("[F0] screenshot returns a valid PNG image block", async () => {
    const { sc } = await fake();
    await plate(sc);
    const r = await sc.call("screenshot", { source: "model", width: 16, height: 12 });
    expect(r.content.map((c) => c.type)).toEqual(["image", "text"]);
    expect(r.content[0].mimeType).toBe("image/png");
    const png = Buffer.from(r.content[0].data, "base64");
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([16, 12]);
    expect(png.subarray(-8, -4).toString("latin1")).toBe("IEND");
    expect(r.json).toMatchObject({ bytes: png.length, width: 16, height: 12, path: null });
  });
});

describe("other solids", () => {
  test("[F0] box, boss, blind hole, through hole and cylinder cut match the real kernel's numbers", async () => {
    const { sc } = await fake();
    // Measured on SolidCraft 0.44.1: 12268.606 mm³, 12 faces, bbox to z = 18.
    const r = await sc.call("batch", {
      verbose: false,
      commands: [
        { command: "solid.box", params: { length: 40, width: 30, height: 10, name: "B" } },
        { command: "solid.cylinder", params: { diameter: 10, height: 8, base: [20, 15, 10], operation: "join", name: "Boss" } },
        { command: "solid.hole", params: { position: [8, 8, 10], diameter: 4, depth: 5, name: "Blind" } },
        { command: "solid.hole", params: { position: [32, 8, 10], diameter: 3, name: "Thru" } },
        { command: "solid.cylinder", params: { diameter: 4, height: 30, base: [20, 15, 0], operation: "cut", name: "Bore" } },
      ],
    });
    expect(r.json.ok).toBe(true);
    const m = (await sc.call("measure", { summary: true })).json;
    expect(m.total.volume_mm3).toBeCloseTo(12268.606, 2);
    expect(m.bodies[0].faces).toBe(12);
    expect(m.bodies[0].bbox).toEqual({ min: [0, 0, 0], max: [40, 30, 18] });
    const names = ((await sc.call("body_topology", { body: "Body1" })).json.faces as { name: string }[]).map((f) => f.name);
    expect(names.slice(6)).toEqual(["F2:side", "F2:top", "F3:bore:base", "F3:bore:side:0", "F4:bore:side:0", "F5:side"]);
  });

  test("[F0] an imported reference body is fixed, and interference is found by bounding-box overlap", async () => {
    const { sc, dir } = await fake();
    await sc.call("execute", { command: "solid.box", params: { length: 10, width: 10, height: 10, corner: [100, 0, 0], name: "Ref" } });
    const step = join(dir, "ref.step");
    await sc.call("export", { path: step });
    await sc.call("new_design");
    await sc.call("execute", { command: "solid.box", params: { length: 20, width: 20, height: 20, name: "Part" } });
    const ins = (await sc.call("execute", { command: "file.insert_step", params: { path: step } })).json;
    expect(ins.created_bodies).toEqual(["ref"]);
    expect(ins.path).toBe(step);
    const m = (await sc.call("measure", { summary: true })).json;
    expect(m.body_count).toBe(2);
    expect(m.bodies[1]).toEqual({ bbox: { min: [100, 0, 0], max: [110, 10, 10] }, closed: true, faces: 6, name: "ref", volume_mm3: 1000 });
    // Apart: no interference.
    expect((await sc.call("execute", { command: "inspect.interference", params: {} })).json).toMatchObject({ checked: 2, count: 0, interferences: [] });
    // A second box that reaches into the reference body.
    await sc.call("execute", { command: "solid.box", params: { length: 10, width: 10, height: 10, corner: [95, 0, 0], name: "Clash" } });
    const hit = (await sc.call("execute", { command: "inspect.interference", params: {} })).json;
    expect(hit.count).toBe(1);
    expect(hit.interferences[0]).toMatchObject({ a: "ref", b: "Body2", volume_mm3: 500, bbox: { min: [100, 0, 0], max: [105, 10, 10] } });
    // A hole aimed at the reference body does not modify it.
    await sc.call("execute", { command: "solid.hole", params: { position: [105, 5, 10], diameter: 2, targets: ["Body2"], name: "H" } });
    expect((await sc.call("measure", { body: "ref", summary: true })).json.total.volume_mm3).toBe(1000);
  });

  test("[F0] a failing batch rolls back and names the failing step", async () => {
    const { sc } = await fake();
    const r = await sc.call("batch", {
      commands: [
        { command: "parameters.add", params: { name: "Q", expression: "1 mm" } },
        { command: "solid.extrude", params: { distance: "Q" } },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ ok: false, completed: 1, rolled_back: true, failed: { command: "solid.extrude", index: 1 } });
    expect((await sc.call("inspect_design")).json.params).toEqual([]);
    const pre = await sc.call("batch", { commands: [{ command: "parameters.add", params: { name: "Q", expression: "1" } }, { command: "nope.x", params: {} }] });
    expect(pre.json.note).toBe("nothing was run: the batch was checked before its first step");
    // Expression errors read like the real tool's.
    expect((await sc.call("set_parameter", { name: "L", value: "1 +* q" })).isError).toBe(true);
    expect((await sc.call("set_parameter", { name: "L", value: "q + 1" })).text).toBe("expression: unknown parameter `q`");
    expect((await sc.call("set_parameter", { name: "a", value: "2*(3+1)^2 mm" })).json.value).toBe(32);
    expect((await sc.call("set_parameter", { name: "b", value: "a/0" })).text).toBe("expression: division by zero");
    await sc.call("execute", { command: "parameters.add", params: { name: "L", expression: "80 mm" } });
    expect((await sc.call("execute", { command: "parameters.add", params: { name: "L", expression: "1 mm" } })).text).toBe("there is already a parameter `L`");
  });
});

describe("failure hooks", () => {
  test("[F0] FAKE_SC_CRASH_ON exits abruptly with code 139 and a stderr line, sending no reply", async () => {
    const { sc } = await fake({ env: { FAKE_SC_CRASH_ON: "solid.fillet" } });
    // Steps before the crash command run normally.
    expect((await sc.call("execute", { command: "solid.box", params: { length: 10, width: 10, height: 10 } })).isError).toBe(false);
    const dead = sc.call("execute", { command: "solid.fillet", params: { edges: [[0, 0, 5]], radius: 1 } });
    await expect(dead).rejects.toThrow(/exited \(code 139\)/);
    expect(await sc.exited).toBe(139);
    expect(sc.stderr()).toContain("simulated crash on solid.fillet");
  });

  test("[F0] FAKE_SC_VOLUME_SCALE scales every reported volume", async () => {
    const { sc } = await fake({ env: { FAKE_SC_VOLUME_SCALE: "1.001" } });
    await plate(sc);
    const m = (await sc.call("measure")).json;
    expect(m.total.volume_mm3).toBeCloseTo(23335.167 * 1.001, 2);
    expect(m.bodies[0].volume_mm3).toBe(m.total.volume_mm3);
    expect(m.bodies[0].faces).toBe(22); // drift moves numbers, not topology
    expect((await sc.call("inspect_design")).json.bodies[0].volume_mm3).toBe(m.total.volume_mm3);
  });

  test("[F0] FAKE_SC_MISS_CUTS reports success for a cut that removes nothing", async () => {
    const { sc } = await fake({ env: { FAKE_SC_MISS_CUTS: "1" } });
    const built = await plate(sc);
    // The hole and its pattern "succeed"…
    expect(built.json.ok).toBe(true);
    expect(built.json.results[14]).toMatchObject({ name: "Hole", warning: null, changed_bodies: [] });
    // …but the plate is still solid: 24000 − the four corner fillets, and no hole faces.
    const m = (await sc.call("measure", { summary: true })).json;
    expect(m.total.volume_mm3).toBeCloseTo(24000 - 4 * 25 * (1 - Math.PI / 4) * 6, 6);
    expect(m.bodies[0].faces).toBe(10);
    const cut = (await sc.call("execute", { command: "solid.cylinder", params: { diameter: 4, height: 30, base: [0, 0, 0], operation: "cut", name: "Bore" } })).json;
    expect(cut.changed_bodies).toEqual([]);
    expect((await sc.call("measure", { summary: true })).json.total.volume_mm3).toBe(m.total.volume_mm3);
  });

  test("[F0] without the hook, a cut placed off the part also misses silently", async () => {
    const { sc } = await fake();
    await plate(sc);
    const before = await volume(sc);
    const miss = await sc.call("execute", { command: "solid.cylinder", params: { diameter: 4, height: 30, base: [500, 0, 0], operation: "cut", name: "Miss" } });
    expect(miss.isError).toBe(false);
    expect(miss.json.changed_bodies).toEqual([]);
    expect(await volume(sc)).toBe(before);
  });

  test("[F0] FAKE_SC_WARN_ON puts a Boolean retry warning on that command's feature", async () => {
    const { sc } = await fake({ env: { FAKE_SC_WARN_ON: "solid.hole" } });
    const built = await plate(sc);
    expect(built.json.results[14].warning).toStartWith("Boolean retry");
    expect(built.json.results[8].warning).toBeNull();
    const timeline = (await sc.call("inspect_design", { measure: false })).json.timeline as { name: string; type: string; warning: string | null }[];
    expect(timeline.map((t) => t.type)).toEqual(["Sketch", "ExtrudeFeature", "FilletFeature", "Sketch", "HoleFeature", "RectangularPatternFeature"]);
    expect(timeline.find((t) => t.name === "Hole")!.warning).toStartWith("Boolean retry");
    expect(timeline.filter((t) => t.warning).length).toBe(1);
  });

  test("[F0] FAKE_SC_DELAY_MS delays every tool reply, in order", async () => {
    const { sc } = await fake({ env: { FAKE_SC_DELAY_MS: "60" } });
    const t0 = performance.now();
    // Two calls sent back to back are answered one after the other.
    const [a, b] = await Promise.all([sc.call("version"), sc.call("measure", { summary: true })]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(110);
    expect(a.json.version).toBe("0.44.1");
    expect(b.json.body_count).toBe(0);
  });
});
