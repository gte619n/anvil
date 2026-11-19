/**
 * Enumerates what the REAL SolidCraft's `timeline.export_script` writes into a design script.
 *
 *   bun test/fixtures/solidcraft-export-ids/generate.ts <path to solidcraft-cli> [out.json]
 *
 * It drives the real binary over MCP through a set of scenarios (assemblies, joints, configurations,
 * materials, appearances, document settings, views, notes, sheet metal, surfaces, meshes, imports,
 * construction geometry, sketches with text / SVG / DXF / projection, canvases), exports the script
 * after EVERY step, and records every command id seen, with the parameter keys each carried and any
 * string value that looks like it names a file. The result is `export-ids.json` beside this file:
 * the evidence behind `ALLOWED_COMMANDS` in src/solidcraft/script-screen.ts.
 *
 * A step the build refuses is recorded with its error and the scenario carries on, so the file also
 * shows what was NOT exercised. Nothing here runs in `bun test`; it needs the real binary.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFERENCE_PLATE, startFake, type FakeSolidcraft } from "../../helpers/fake-solidcraft";

const cli = process.argv[2];
if (!cli) throw new Error("usage: generate.ts <solidcraft-cli> [out.json]");
const outFile = process.argv[3] ?? join(import.meta.dir, "export-ids.json");
const FIX = join(import.meta.dir, "..", "cad");

type Step = [command: string, params: Record<string, unknown>];
type Tool = { tool: string; args: Record<string, unknown> };
interface Scenario {
  name: string;
  /** Files copied into the allowed folder first: fixture-relative path → name there. */
  files?: Record<string, string>;
  steps: (dir: string) => (Step | Tool)[];
}

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect x="1" y="1" width="18" height="8"/></svg>`;
const DXF = "0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n10\n21\n5\n0\nENDSEC\n0\nEOF\n";
const plate: Tool = { tool: "batch", args: { commands: REFERENCE_PLATE } };
const box = (name: string, corner: number[] = [0, 0, 0]): Step => ["solid.box", { length: 20, width: 20, height: 10, corner, name }];
/** Two parts, each in its own component under the root. */
const twoParts = (): (Step | Tool)[] => [
  ["component.create", { name: "A" }],
  box("BoxA"),
  ["component.activate", { component: 0 }],
  ["component.create", { name: "B" }],
  box("BoxB", [40, 0, 0]),
  ["component.activate", { component: 0 }],
];

const SCENARIOS: Scenario[] = [
  { name: "plate", steps: () => [plate] },
  {
    name: "document settings, parameters, materials, appearances",
    steps: () => [
      plate,
      ["document.units", { units: "in" }],
      ["document.metadata.set", { values: { part_number: "P-1", description: "a plate", revision: "B", project: "anvil" } }],
      ["document.metadata.set", { key: "author", value: "anvil" }],
      ["document.metadata.remove", { key: "revision" }],
      ["parameters.comment", { name: "L", comment: "overall length" }],
      ["parameters.favorite", { name: "L", favorite: true }],
      ["parameters.add", { name: "Label", expression: "'REV-B'", unit: "text" }],
      ["parameters.add", { name: "Angle", expression: "30 deg", unit: "deg" }],
      ["parameters.move", { name: "T", before: "L" }],
      ["parameters.rename", { name: "inset", new_name: "margin" }],
      ["material.create", { name: "Unobtainium", density_g_cm3: 3.3, color: "#336699", opacity: 0.9, pbr: { metallic: 0.5, roughness: 0.4, dielectric_ior: 1.5 } }],
      ["material.create", { name: "Plain", density_g_cm3: 1.1, appearance: "Aluminum - Satin" }],
      ["material.assign", { bodies: ["Body1"], material: "Unobtainium" }],
      ["material.edit", { material: "Unobtainium", density_g_cm3: 3.4 }],
      ["appearance.assign", { bodies: ["Body1"], appearance: "Aluminum - Satin" }],
      ["appearance.assign", { faces: [[0, 0, 6]], body: "Body1", appearance: "Aluminum - Anodized Blue" }],
      ["body.print_face", { body: "Body1", point: [0, 0, 0] }],
      ["body.rename", { body: "Body1", name: "PlateBody" }],
      ["timeline.rename", { feature: 2, name: "Base" }],
      ["timeline.suppress", { feature: 6, suppressed: true }],
      ["timeline.group", { features: [2, 3], name: "Blank" }],
      ["note.add", { anchor: [0, 0, 6], text: "deburr\nall edges" }],
      ["view.save", { name: "Front", camera: { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 200 } }],
      ["select.set", { items: [{ type: "body", name: "PlateBody" }] }],
      ["sheet.manage_rules", { name: "Thin steel", thickness: "1 mm" }],
      ["plastic.manage_rules", { name: "My ABS", thickness: "2 mm" }],
      ["plastic.assign_rule", { bodies: ["PlateBody"], rule: "My ABS" }],
      ["render.environment.set", { environment: "studio" }],
    ],
  },
  {
    name: "imported STEP reference",
    files: { "brep/cube.step": "cube.step" },
    steps: (dir) => [plate, ["file.insert_step", { path: join(dir, "cube.step"), name: "ref-cube" }], ["occurrence.move", { occurrence: "ref-cube:1", translate: [0, 0, 20] }]],
  },
  {
    name: "assembly: components, occurrences, joints of each kind",
    steps: () => [
      ...twoParts(),
      ["component.rename", { component: "B", name: "Bracket" }],
      ["component.metadata.set", { component: "A", part_number: "A-1", description: "part A", bom_type: "purchased", values: { vendor: "acme" } }],
      ["occurrence.copy", { component: "A", translate: [0, 60, 0] }],
      ["occurrence.copy", { component: "A", translate: [0, 120, 0] }],
      ["occurrence.move", { occurrence: "A:2", translate: [5, 0, 0] }],
      ["occurrence.move", { occurrence: "A:2", space: "world", translate: ["1 mm", 0, 0] }],
      ["component.capture_position", {}],
      ["occurrence.ground", { occurrence: "A:1", grounded: true }],
      ["joint.as_built", { type: "rigid", a: "A:1", b: "Bracket:1", name: "Weld" }],
      ["joint.as_built", { type: "revolute", a: "A:1", b: "A:2", name: "Hinge", limits: { min: -30, max: 30 } }],
      ["joint.as_built", { type: "slider", a: "A:1", b: "A:3", name: "Slide" }],
      ["joint.limits", { joint: "Slide", min: 0, max: 20 }],
      ["joint.drive", { joint: "Hinge", value: 10 }],
      ["joint.motion_link", { a: "Hinge", b: "Slide", ratio: 0.5 }],
      ["joint.rigid_group", { occurrences: ["A:1", "Bracket:1"] }],
      ["joint.origin", { name: "O1", occurrence: "A:1", face: [10, 10, 10] }],
      ["occurrence.align", { occurrence: "A:3", from_face: [10, 130, 10], to_face: [50, 10, 10] }],
      ["component.paste_new", { component: "A" }],
      ["joint.edit", { joint: "Hinge", flip: true }],
      ["contact.create", { occurrences: ["A:1", "A:2"], name: "Touch" }],
      ["contact.enable_sets", { enabled: true }],
      ["explode.create", { name: "Apart", scale: 2 }],
      ["motion.study", { name: "Swing", steps: 10, keys: [{ joint: "Hinge", points: [[0, 0], [10, 20]] }] }],
      ["component.cycle_color", { component: "A" }],
      ["component.hide_history", { component: "A" }],
    ],
  },
  {
    name: "assembly: joint.create kinds and assembly constraints",
    steps: () => {
      const o = (occ: string, p: number[]) => ({ occurrence: occ, point: p, face: p });
      const kinds = ["rigid", "revolute", "slider", "cylindrical", "pin_slot", "planar", "ball", "parallel", "perpendicular", "angle"];
      return [
        ...twoParts(),
        ...kinds.flatMap((type): Step[] => [
          ["joint.create", { type, a: o("A:1", [10, 10, 10]), b: o("B:1", [50, 10, 10]), name: `J-${type}` }],
          ["joint.delete", { joint: `J-${type}` }],
        ]),
        ["joint.create", { type: "revolute", a: o("A:1", [10, 10, 10]), b: o("B:1", [50, 10, 10]), name: "Keep" }],
        ["assembly.constraint.create", { type: "mate", a: { face: [10, 10, 10], occurrence: "A:1" }, b: { face: [50, 10, 10], occurrence: "B:1" }, name: "Mate1" }],
        ["assembly.constraint.create", { type: "distance", a: { face: [10, 10, 10], occurrence: "A:1" }, b: { face: [50, 10, 10], occurrence: "B:1" }, offset: "5 mm" }],
        ["joint.gear", { a: "Keep", b: "Keep", ra: 10, rb: 20 }],
      ];
    },
  },
  {
    name: "assembly: coupled joints (gear, screw, rack and pinion) and library parts",
    steps: () => {
      const o = (occ: string, p: number[]) => ({ occurrence: occ, face: p });
      return [
        ...twoParts(),
        ["component.create", { name: "C" }],
        box("BoxC", [80, 0, 0]),
        ["component.activate", { component: 0 }],
        ["joint.create", { type: "revolute", a: o("A:1", [10, 10, 10]), b: o("B:1", [50, 10, 10]), name: "R1" }],
        ["joint.create", { type: "revolute", a: o("A:1", [10, 10, 10]), b: o("C:1", [90, 10, 10]), name: "R2" }],
        ["joint.gear", { a: "R1", b: "R2", ra: 10, rb: 20 }],
        ["joint.delete", { joint: "R2" }],
        ["joint.create", { type: "slider", a: o("A:1", [10, 10, 10]), b: o("C:1", [90, 10, 10]), name: "S1" }],
        ["joint.rack_pinion", { a: "R1", b: "S1", radius: 8 }],
        ["joint.delete", { joint: "S1" }],
        ["joint.create", { type: "cylindrical", a: o("A:1", [10, 10, 10]), b: o("C:1", [90, 10, 10]), name: "C1" }],
        ["joint.screw", { joint: "C1", pitch: 2 }],
        ["joint.drive", { joint: "R1", value: "15 deg" }],
        ["solid.cylinder", { radius: 3, height: 10, base: [10, 10, 10], operation: "cut", targets: ["BoxA"] }],
        ["parts.insert", { family: "hex_nut", size: "M6", at: [10, 10, 10] }],
      ];
    },
  },
  {
    name: "assembly: nested components and moved bodies",
    steps: () => [
      plate,
      box("Loose", [100, 0, 0]),
      ["component.from_bodies", { bodies: ["Body2"] }],
      ["component.create", { name: "Outer", activate: true }],
      ["component.create", { name: "Inner", activate: true }],
      box("Deep"),
      ["component.activate", { component: 0 }],
      ["occurrence.reparent", { occurrence: "Inner:1", parent: 0 }],
    ],
  },
  {
    name: "configurations",
    steps: () => [
      plate,
      ["material.create", { name: "Unobtainium", density_g_cm3: 3.3 }],
      ["config.configure", { params: ["L", "W"], features: ["Holes"], materials: ["Body1"], appearances: ["Body1"] }],
      ["config.row", { name: "Long", values: { "param:L": "120 mm", "suppress:Holes": true } }],
      ["config.row", { name: "Short", from: "Default", values: { "param:L": "60 mm", "material:Body1": "Unobtainium" } }],
      ["config.column", { param: "T" }],
      ["config.rule", { rule: { id: "r1", name: "no holes when short", enabled: true, condition: { type: "expression", expression: "L < 70 mm" }, effect: { type: "suppress", feature: "Holes" } } }],
      ["config.activate", { row: "Long" }],
      ["config.row", { name: "Short", rename: "Stubby" }],
      { tool: "execute", args: { command: "config.table", params: {} } },
    ],
  },
  {
    name: "sketch links: text, fonts, SVG, DXF, projection",
    steps: () => [
      plate,
      ["sketch.create", { plane: "XY", name: "Marks", offset: "T" }],
      ["sketch.text", { text: "ANVIL", at: [0, 0], height: 5 }],
      ["sketch.text", { text: "Bold", at: [0, 10], height: 5, font: "Helvetica" }],
      ["sketch.text", { text_expression: "'L=' + L", at: [0, -10], height: 4 }],
      ["sketch.insert_svg", { text: SVG, at: [-30, -20] }],
      ["sketch.insert_dxf", { text: DXF, at: [10, -20] }],
      ["sketch.insert_airfoil", { text: "NACA\n1 0\n0.5 0.06\n0 0\n0.5 -0.06\n1 0\n", chord: 20 }],
      ["sketch.project", { refs: [{ body: "Body1" }] }],
      ["sketch.include_3d", { refs: [{ edge: [40, 0, 6], body: "Body1" }] }],
      ["sketch.finish", {}],
      ["solid.extrude", { sketch: "Marks", distance: 1, operation: "join", name: "Raised" }],
    ],
  },
  {
    name: "canvas and decal",
    steps: () => [plate, ["canvas.insert", { data: PNG_1PX, width: 40, name: "Trace" }], ["canvas.decal", { data: PNG_1PX, face: [0, 0, 6], width: 10 }], ["canvas.edit", { canvas: "Trace", opacity: 0.8 }], ["canvas.calibrate", { canvas: "Trace", a: [0, 0], b: [10, 0], distance: 25 }]],
  },
  {
    name: "mesh, point cloud and board imports",
    files: { "mesh/cube.stl": "cube.stl", "mesh/cube.ply": "cube.ply", "mesh/cube.glb": "cube.glb", "ecad2d/board.gtl": "board.gtl", "ecad2d/board.drl": "board.drl" },
    steps: (dir) => [
      box("Base"),
      ["file.insert_mesh", { path: join(dir, "cube.stl") }],
      ["file.insert_mesh", { path: join(dir, "cube.glb") }],
      ["mesh.convert", { body: "cube" }],
      ["pointcloud.insert", { path: join(dir, "cube.ply") }],
      ["file.insert_gerber", { outline: join(dir, "board.gtl"), drills: join(dir, "board.drl"), name: "Board" }],
      ["file.insert_gerber", { outline_text: "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX100000Y0D01*\nX100000Y50000D01*\nX0Y50000D01*\nX0Y0D01*\nM02*\n", name: "Board2" }],
    ],
  },
  {
    name: "construction geometry, surfaces, sheet metal, plastic, frames, library parts",
    steps: () => [
      plate,
      ["construct.plane.offset", { base: "XY", offset: "10 mm", name: "Mid" }],
      ["construct.plane.at_angle", { base: "XY", axis: "X", angle: 30 }],
      ["construct.axis.two_planes", { a: "XY", b: "XZ", name: "X" }],
      ["construct.axis.through_cylinder", { face: { face: [32, 17, 1], body: "Body1" } }],
      ["construct.point.three_planes", { a: "XY", b: "XZ", c: "YZ", name: "O" }],
      ["solid.sphere", { radius: 5, center: [0, 0, 30], name: "Ball" }],
      ["solid.cone", { radius: 5, height: 10, base: [60, 0, 0] }],
      ["solid.torus", { major: 10, minor: 2, center: [0, 60, 0] }],
      ["solid.chamfer", { edges: [[40, 0, 6]], distance: 0.5 }],
      ["solid.shell", { faces: [[0, 0, 6]], thickness: 1, body: "Body1" }],
      ["sketch.create", { plane: "XZ", name: "Open" }],
      ["sketch.line", { points: [[0, 40], [20, 40], [20, 60]] }],
      ["sketch.finish", {}],
      ["surface.extrude", { sketch: "Open", curves: ["l1", "l2"], distance: 10, name: "Sheet" }],
      ["sheet.flange", { contour: { sketch: "Open", curves: ["l1", "l2"] }, distance: 15 }],
      ["frame.member", { sketch: "Open", profile: { kind: "bar", width: 5, height: 5 } }],
      ["plastic.boss", { position: [0, 0, 6], direction: [0, 0, 1], diameter: 6, height: 5 }],
      ["solid.thread", { face: [32, 17, 1] }],
      ["solid.move", { bodies: ["Ball"], translate: [0, 0, 5] }],
      ["solid.scale", { bodies: ["Ball"], factor: 1.2 }],
      ["solid.mirror", { bodies: ["Body1"], plane: "YZ" }],
      ["solid.pattern.circular", { features: ["Hole"], axis: "Z", count: 3 }],
    ],
  },
  {
    name: "linked design (insert_design)",
    steps: (dir) => [
      plate,
      { tool: "save", args: { path: join(dir, "plate.sc") } },
      { tool: "new_design", args: {} },
      box("Host"),
      ["component.insert_design", { path: join(dir, "plate.sc"), name: "LinkedPlate" }],
    ],
  },
];

interface IdRecord {
  scenarios: string[];
  /** Every key path seen under this id's params, e.g. `feature.sketch.links[].source.font`. */
  keys: string[];
}
const ids: Record<string, IdRecord> = {};
const features: Record<string, string[]> = {};
/** String values that could name a file or hold embedded data: key path → a sample (truncated). */
const suspicious: Record<string, string> = {};
const report: { name: string; steps: { step: string; ok: boolean; error?: string; export?: string }[] }[] = [];

function walk(id: string, v: unknown, path: string, keys: Set<string>): void {
  if (typeof v === "string") {
    if (v.length > 200 || /[\\/~%$]|^[a-z]+:/i.test(v) || /font|file|path|image|data|source|url|uri|href|texture|template/i.test(path.split(".").pop() ?? "")) {
      suspicious[`${id} ${path}`] ??= v.length > 80 ? `${v.slice(0, 60)}… (${v.length} chars)` : v;
    }
    return;
  }
  if (Array.isArray(v)) return void v.forEach((x) => walk(id, x, `${path}[]`, keys));
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      keys.add(p);
      walk(id, x, p, keys);
    }
  }
}

async function exportIds(sc: FakeSolidcraft, scenario: string): Promise<string> {
  const r = await sc.call("execute", { command: "timeline.export_script", params: {} });
  if (r.isError || !r.json?.script?.commands) return `refused: ${r.text.slice(0, 160)}`;
  for (const c of r.json.script.commands as { command: string; params: Record<string, unknown> }[]) {
    const rec = (ids[c.command] ??= { scenarios: [], keys: [] });
    if (!rec.scenarios.includes(scenario)) rec.scenarios.push(scenario);
    const keys = new Set(rec.keys);
    walk(c.command, c.params, "", keys);
    rec.keys = [...keys].sort();
    const f = (c.params as { feature?: { type?: string } }).feature;
    if (c.command === "timeline.add" && typeof f?.type === "string") {
      const fk = new Set(features[f.type] ?? []);
      walk(`timeline.add<${f.type}>`, f, "feature", fk);
      features[f.type] = [...fk].sort();
    }
  }
  const omitted = (r.json.omitted as string[] | undefined) ?? [];
  return `ok (${r.json.steps} steps${omitted.length ? `; omitted: ${omitted.join(", ")}` : ""})`;
}

/** Each seen id's own parameter schema, read from the build (`describe_command`). */
const schemas: Record<string, { params: string; properties: string[] }> = {};
async function describeSeen(sc: FakeSolidcraft): Promise<void> {
  for (const id of Object.keys(ids)) {
    if (schemas[id]) continue;
    const r = await sc.call("describe_command", { id });
    const props = Object.keys((r.json?.input?.properties as Record<string, unknown> | undefined) ?? {}).sort();
    schemas[id] = { params: String(r.json?.params ?? r.text).slice(0, 1200), properties: props };
  }
}

let version = "";
for (const s of SCENARIOS) {
  const dir = mkdtempSync(join(tmpdir(), "sc-export-ids-"));
  for (const [from, to] of Object.entries(s.files ?? {})) copyFileSync(join(FIX, from), join(dir, to));
  const sc = await startFake({ cli: [cli], allow: [dir], env: { SOLIDCRAFT_GPU: "cpu" } });
  const steps: (typeof report)[number]["steps"] = [];
  try {
    version ||= (await sc.call("version", {})).json?.version ?? "";
    for (const step of s.steps(dir)) {
      const label = Array.isArray(step) ? step[0] : step.tool === "execute" ? String(step.args.command) : `(${step.tool})`;
      const r = Array.isArray(step) ? await sc.call("execute", { command: step[0], params: step[1] }) : await sc.call(step.tool, step.args);
      steps.push({ step: label, ok: !r.isError, ...(r.isError ? { error: r.text.replaceAll(dir, "<dir>").slice(0, 200) } : {}), export: await exportIds(sc, s.name) });
    }
    await describeSeen(sc);
  } finally {
    await sc.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
  report.push({ name: s.name, steps });
}

const json = JSON.stringify(
  {
    solidcraft: version,
    generatedBy: "anvild/test/fixtures/solidcraft-export-ids/generate.ts",
    commandIds: Object.keys(ids).sort(),
    ids: Object.fromEntries(Object.entries(ids).sort()),
    schemas: Object.fromEntries(Object.entries(schemas).sort()),
    featureTypes: Object.fromEntries(Object.entries(features).sort()),
    suspiciousStrings: Object.fromEntries(Object.entries(suspicious).sort()),
    scenarios: report,
  },
  null,
  1,
);
// The temp folder's name changes every run; keep the file stable.
writeFileSync(outFile, `${json.replace(/[^"\\\s]*sc-export-ids-[A-Za-z0-9]+/g, "<dir>")}\n`);
console.log(`SolidCraft ${version}: ${Object.keys(ids).length} command ids → ${outFile}`);
console.log(Object.keys(ids).sort().join("\n"));
