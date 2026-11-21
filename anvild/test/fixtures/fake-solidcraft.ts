#!/usr/bin/env bun
/**
 * fake-solidcraft — a deterministic stand-in for `solidcraft-cli mcp` (agent-cad-and-browser spec
 * §8.2). A stdio MCP server (JSON-RPC 2.0, one message per line; `initialize`,
 * `notifications/initialized`, `ping`, `tools/list`, `tools/call`) that keeps user parameters and a
 * feature list and computes `measure` from closed-form solids, so a missing or changed feature moves
 * the numbers the way the real kernel would. Reply shapes were copied from the real server
 * (SolidCraft 0.44.1, 2026-11-19).
 *
 *   bun test/fixtures/fake-solidcraft.ts mcp --headless --compact --allow-path DIR [--allow-path DIR2] [--require-allow-path] [--in FILE]
 *   bun test/fixtures/fake-solidcraft.ts --version          → "solidcraft-cli <FAKE_SC_VERSION>"
 *
 * TOOLS: version, list_commands, describe_command, execute, batch, inspect_design, measure,
 * body_topology, set_parameter, check_parameters, screenshot, export, undo, redo, new_design, open,
 * save, skill_reference.
 *
 * `inspect_design` honours `timeline: "summary" | false` and `bodies: "names" | false` (the light
 * read the daemon's manager takes after every change) and reports `undo` / `redo` stack depths: one
 * undo step per executed command, so a 16-command batch is 16 steps (the real plate batch is 14).
 *
 * COMMANDS (via execute/batch): parameters.add, parameters.change (`{name, expression}` creates an
 * unknown name as the real tool does; `{changes: {name: expr}}` refuses one), sketch.create,
 * sketch.rectangle.center, sketch.draw.dimensioned (wrapping sketch.rectangle.center), sketch.point,
 * sketch.dimension (horizontal/vertical from the origin to a point), sketch.finish, solid.extrude
 * (new body from a centred rectangle), solid.box (new body), solid.cylinder (new/join/cut, Z axis),
 * solid.fillet (vertical corner edges of a box/plate), solid.hole (simple, drilled or counterbore;
 * through or blind; from a sketch's points or a position; drilled along -Z),
 * solid.pattern.rectangular (of hole / cylinder features), file.insert_step (a fixed reference
 * body; its timeline type is `BaseFeature`, as the real import's is), inspect.interference
 * (axis-aligned bounding-box overlap), inspect.measure {bodies, names_only} (the measure reply for the named
 * bodies; null or [] means all), view.pick {rays, all} (rays against the closed-form solids: enough to
 * tell a hole from a boss from a fillet on Z-axis cylinders, and a blind hole's floor),
 * timeline.export_script.
 * Anything else answers "unknown command `x`" as the real tool does.
 *
 * TEST HOOKS (environment variables):
 *   FAKE_SC_VERSION       reported version (default "0.44.1").
 *   FAKE_SC_FORMAT        design format this "build" reads up to (default 58). Opening (open, --in,
 *                         batch {path}) a file whose format is greater FAILS with "this design was
 *                         saved by a newer SolidCraft (format N, this version reads up to M)".
 *   FAKE_SC_NEWER=warn    …instead open it and add `newer_file` + `warnings` to the reply. This is
 *                         what the REAL 0.44.1 was observed to do with a format-99 design.
 *   FAKE_SC_VOLUME_SCALE  multiplies every reported volume (and mass) — kernel drift between versions.
 *   FAKE_SC_CRASH_ON      a command id (or tool name): on reaching it the process writes one stderr
 *                         line and exits abruptly with code 139, sending no reply.
 *   FAKE_SC_DELAY_MS      delay before every tools/call reply.
 *   FAKE_SC_WARN_ON       a command id whose feature result (and timeline entry) carries a
 *                         "Boolean retry…" warning; the geometry is still built.
 *   FAKE_SC_HANG_ON       a command id (or tool name): on reaching it the process never replies and
 *                         stays alive — the "SolidCraft hangs" case the manager's timeout must kill.
 *   FAKE_SC_MISS_CUTS=1   every cut (solid.hole, solid.cylinder cut, and their patterned copies)
 *                         reports success but removes nothing — the "cut that misses" case.
 *   FAKE_SC_INTERFERENCE  "unchecked" | "truncated" | "budget": `inspect.interference` reports that
 *                         flag (a pair left unchecked, a truncated list, an exhausted budget), with
 *                         `count` 0 — the replies the gate must never read as "no interference".
 *   FAKE_SC_OVERLAP       the `overlap` compare_picture reports (default 0.9).
 *   FAKE_SC_REF_PLACEMENT "moved" | "free" | "pending" | "copied": what `component.list` says of every
 *                         import's placement (see `componentList`); default: identity, grounded, once.
 *
 * PHASE A4 SHAPES. `file.insert_step` embeds the STEP text in the script exactly as the real tool
 * does: `timeline.export_script` writes the import as `timeline.add {feature: {type: "import", name,
 * file, step, body_names}}` (no path), a replay rebuilds it from the embedded text alone, and the reply
 * carries `content_sha256`. `timeline.delete {feature}` removes a feature (by id or name).
 * `screenshot {view}` gives a different grey per view; `compare_picture {reference}` returns an
 * overlay image part plus `{overlap, …}`.
 *
 * FAILED FEATURES (A0 evidence): a `solid.*` step that fails while it is being ADDED is an error
 * reply and adds nothing. One that fails LATER — after a parameter change, or while a script is
 * replayed with `--in` — stays in the timeline with its `error` set, the reply is a success
 * (`parameters.change` lists it under `errors`), and `measure` reports the partial geometry.
 * `--in` therefore starts with failed features, but exits 1 with `error: step N (cmd): …` on a
 * step it cannot run at all (unknown command, a sketch step with no sketch) or `error: <path>: …`
 * on a file it cannot read, as the real CLI does.
 *
 * HOW IT DIFFERS FROM THE REAL SERVER
 *  - Geometry is a table of closed forms, not a kernel. Volume, bounding box, face count and the
 *    cylindrical faces are modelled; `area_mm2`, `edges`, `vertices`, `center_of_mass` and `kernel`
 *    are absent from measure, and body_topology's `edges` list is always empty. Features are assumed
 *    not to partially overlap one another (a hole is wholly inside the material it enters).
 *  - A through hole reports its axis `origin` at the hole's bottom and `extent` [0, length]. The
 *    real kernel reports an origin far below the part with a matching offset extent.
 *  - `timeline.export_script` returns the EXECUTED commands (parameters first, as `parameters.add`
 *    with their current expressions), each other step wrapped as the real tool's `timeline.add`
 *    record with a fake feature `{type: "fake", id: <command>, params}`, so the daemon's script screen
 *    and its `batch` load see the real shape. Replaying such a step (batch or `--in`) records a
 *    feature that fails to compute instead of refusing it. The envelope is the same:
 *    { about: { design, format: "solidcraft/<N>", replay, version }, commands: […] }.
 *  - `save` writes one small JSON document for both .sc and .json (the real .sc is a zip), and
 *    `open` replays either that or an exported script. The real `open` rejects a script (it wants a
 *    design file; scripts go through `batch {path}`), and opens STEP/mesh files, which this does not.
 *  - `file.insert_step` cannot read real STEP geometry. A STEP written by this fake's `export`
 *    carries its bodies in a comment and is re-imported exactly; any other file becomes a
 *    10 × 10 × 10 mm cube at the origin named after the file.
 *  - Files are limited to the `--allow-path` folders only (the real one also allows its recovery and
 *    temp folders and the folders of designs opened or saved in the session).
 *  - `list_commands` unfiltered returns this fake's short table (the real one is over 100 KB).
 *  - As in the real tool there is NO convex/concave field on a cylindrical face: a boss
 *    (`F2:side`) and a cylinder cut (`F5:side`) differ only in which feature made them; holes are
 *    named `…:bore:side:0` / `…:cbore:side:0` and fillets `…:blend(a|b)`.
 *  - The "Boolean retry" warning text is invented (the real wording was not provoked).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fakeReplayEntry } from "./fake-solidcraft-eval";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

// ── hooks ───────────────────────────────────────────────────────────────────────────────────────
const VERSION = process.env.FAKE_SC_VERSION || "0.44.1";
const FORMAT = Number(process.env.FAKE_SC_FORMAT || 58);
const NEWER_WARNS = process.env.FAKE_SC_NEWER === "warn";
const VOLUME_SCALE = Number(process.env.FAKE_SC_VOLUME_SCALE || 1);
const CRASH_ON = process.env.FAKE_SC_CRASH_ON || "";
const DELAY_MS = Number(process.env.FAKE_SC_DELAY_MS || 0);
const WARN_ON = process.env.FAKE_SC_WARN_ON || "";
const HANG_ON = process.env.FAKE_SC_HANG_ON || "";
const MISS_CUTS = process.env.FAKE_SC_MISS_CUTS === "1";
const INTERFERENCE = process.env.FAKE_SC_INTERFERENCE || "";
const OVERLAP = Number(process.env.FAKE_SC_OVERLAP || 0.9);
const BOOLEAN_RETRY = "Boolean retry: the boolean needed a second attempt at a looser tolerance; check the result";

type Json = Record<string, any>;
type V3 = [number, number, number];
interface Cmd {
  command: string;
  params: Json;
}

/** A user-facing failure: becomes an `isError` tool result with this text. */
class ToolError extends Error {
  /** Index of the failing command in the log being built (set by `build`). */
  step?: number;
  command?: string;
}
/** A step that cannot run at all — never recorded as a failed feature. */
class UnknownCommand extends ToolError {}
/** A malformed call: becomes a JSON-RPC error (-32602), as the real server answers. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

// ── expressions ─────────────────────────────────────────────────────────────────────────────────
/** Evaluate `+ - * / ^ ( )` over numbers and names; a trailing unit (mm, deg) is tolerated. */
function evalExpr(src: string | number, lookup: (name: string) => number): number {
  if (typeof src === "number") return src;
  const toks = String(src).match(/\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+|[A-Za-z_][A-Za-z_0-9]*|[-+*/^()]/g) ?? [];
  if (toks.join("") !== String(src).replace(/\s+/g, "")) throw new ToolError(`expression: cannot read \`${src}\``);
  let i = 0;
  const unit = () => {
    while (i < toks.length && /^(mm|deg)$/.test(toks[i]!)) i++;
  };
  const primary = (): number => {
    const t = toks[i++];
    if (t === undefined) throw new ToolError(`expression: unexpected end of \`${src}\``);
    let v: number;
    if (t === "(") {
      v = sum();
      if (toks[i++] !== ")") throw new ToolError(`expression: missing ) in \`${src}\``);
    } else if (t === "-") return -power();
    else if (t === "+") return power();
    else if (/^[\d.]/.test(t)) v = Number(t);
    else if (/^[A-Za-z_]/.test(t)) v = lookup(t);
    else throw new ToolError(`expression: unexpected \`${t}\``);
    unit();
    return v;
  };
  const power = (): number => {
    const b = primary();
    if (toks[i] === "^") {
      i++;
      return Math.pow(b, power());
    }
    return b;
  };
  const product = (): number => {
    let v = power();
    while (toks[i] === "*" || toks[i] === "/") {
      const op = toks[i++];
      const r = power();
      if (op === "/" && r === 0) throw new ToolError("expression: division by zero");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (toks[i] === "+" || toks[i] === "-") v = toks[i++] === "+" ? v + product() : v - product();
    return v;
  };
  const v = sum();
  if (i < toks.length) throw new ToolError(`expression: unexpected \`${toks[i]}\``);
  return v;
}

// ── model ───────────────────────────────────────────────────────────────────────────────────────
type Solid = { kind: "box"; min: V3; max: V3 } | { kind: "cyl"; x: number; y: number; r: number; z0: number; z1: number };
interface Face {
  name: string;
  area: number;
  centroid: V3;
  normal?: V3;
  cylinder?: { axis: V3; origin: V3; radius: number; length: number };
}
/** Material removed from a body: a vertical drilled or cut cylinder, or the corner a fillet rounds off. */
type Void =
  | { kind: "cyl"; x: number; y: number; r: number; z0: number; z1: number }
  | { kind: "fillet"; ox: number; oy: number; sx: 0 | 1; sy: 0 | 1; r: number; z0: number; z1: number };
interface Body {
  name: string;
  feature: number;
  solids: Solid[];
  /** What was cut away — only `view.pick` reads it (volume and faces are kept in closed form). */
  voids: Void[];
  volume: number;
  faces: Face[];
  /** An imported reference body: geometry is opaque and nothing modifies it. */
  fixed?: boolean;
}
interface Feature {
  id: number;
  name: string;
  type: string;
  warning: string | null;
  /** Why the feature failed to compute (it stays in the timeline, as in the real tool). */
  error?: string | null;
  /** Re-apply this feature shifted by (dx, dy) for a pattern copy; returns the bodies it changed. */
  instance?: (dx: number, dy: number, suffix: string) => string[];
  /** The command-log index that made it (`timeline.delete` removes that entry). */
  log?: number;
}
interface Sketch {
  id: number;
  name: string;
  z: number;
  rect?: { cx: number; cy: number; w: number; h: number };
  points: { id: string; x: number; y: number }[];
}
interface Param {
  name: string;
  expression: string;
  unit: string;
  value: number;
}
interface Model {
  params: Param[];
  sketches: Sketch[];
  timeline: Feature[];
  bodies: Body[];
  results: Json[];
  activeSketch: Sketch | null;
}

const PI = Math.PI;
const fmtParam = (v: unknown): string => (typeof v === "number" ? String(v) : String(v ?? ""));
const OPS: Record<string, "new" | "join" | "cut"> = {
  new: "new", newbody: "new", newcomponent: "new",
  join: "join", union: "join", add: "join",
  cut: "cut", subtract: "cut", difference: "cut",
};
const operation = (raw: unknown, command: string): "new" | "join" | "cut" => {
  if (raw === undefined || raw === null) return "new";
  const op = OPS[String(raw).toLowerCase().replace(/[\s_-]/g, "")];
  if (!op) throw new ToolError(`invalid parameters for \`${command}\`: fake-solidcraft does not model operation \`${raw}\``);
  return op;
};

function bboxOf(b: Body): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of b.solids) {
    const lo: V3 = s.kind === "box" ? s.min : [s.x - s.r, s.y - s.r, s.z0];
    const hi: V3 = s.kind === "box" ? s.max : [s.x + s.r, s.y + s.r, s.z1];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, lo[k]!);
      max[k] = Math.max(max[k]!, hi[k]!);
    }
  }
  return { min, max };
}

/** Length of material in the vertical column at (x, y) of radius r, within [z0, z1]. */
function material(b: Body, x: number, y: number, r: number, z0: number, z1: number): number {
  const spans: [number, number][] = [];
  for (const s of b.solids) {
    const inside =
      s.kind === "box"
        ? x >= s.min[0] && x <= s.max[0] && y >= s.min[1] && y <= s.max[1]
        : Math.hypot(x - s.x, y - s.y) + r <= s.r + 1e-9;
    if (!inside) continue;
    const a = Math.max(z0, s.kind === "box" ? s.min[2] : s.z0);
    const c = Math.min(z1, s.kind === "box" ? s.max[2] : s.z1);
    if (c > a) spans.push([a, c]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, c] of spans) {
    if (c <= end) continue;
    total += c - Math.max(a, end);
    end = c;
  }
  return total;
}

const FEATURE_TYPES: Record<string, [string, string]> = {
  "solid.extrude": ["ExtrudeFeature", "Extrude"], "solid.box": ["BoxFeature", "Box"], "solid.cylinder": ["CylinderFeature", "Cylinder"],
  "solid.fillet": ["FilletFeature", "Fillet"], "solid.hole": ["HoleFeature", "Hole"], "solid.pattern.rectangular": ["RectangularPatternFeature", "Pattern"],
};

/**
 * Rebuild the whole design from the command log. Commands from `strictFrom` on are being ADDED:
 * the first that fails throws ToolError. Earlier `solid.*` commands are history being recomputed: one
 * that fails becomes a timeline feature with `error` set and the build carries on. Any other failure
 * (unknown command, bad sketch step, bad parameter expression) always throws, tagged with its step.
 */
function build(log: readonly Cmd[], strictFrom: number = log.length): Model {
  // Pass 1 — parameters. They are evaluated with their FINAL expressions, because the design is
  // parametric: changing L after the plate was extruded still resizes the plate.
  const params: Param[] = [];
  for (const { command, params: p } of log) {
    if (command !== "parameters.add" && command !== "parameters.change") continue;
    // The `changes` form (the only one that refuses an unknown name): all or nothing, one rebuild.
    if (command === "parameters.change" && p.changes && typeof p.changes === "object") {
      for (const [name, expr] of Object.entries(p.changes as Json)) {
        const q = params.find((x) => x.name === name);
        if (!q) throw new ToolError(`unknown parameter \`${name}\``);
        q.expression = fmtParam(expr);
      }
      continue;
    }
    if (typeof p.name !== "string" || !p.name) throw new ToolError(`invalid parameters for \`${command}\`: \`name\` is required`);
    const expr = p.expression ?? p.value;
    if (expr === undefined) throw new ToolError(`invalid parameters for \`${command}\`: \`expression\` is required`);
    const have = params.find((q) => q.name === p.name);
    if (command === "parameters.add" && have) throw new ToolError(`there is already a parameter \`${p.name}\``);
    if (have) have.expression = fmtParam(expr);
    else params.push({ name: p.name, expression: fmtParam(expr), unit: typeof p.unit === "string" ? p.unit : "mm", value: NaN });
  }
  const resolving = new Set<string>();
  const lookup = (name: string): number => {
    const q = params.find((x) => x.name === name);
    if (!q) throw new ToolError(`expression: unknown parameter \`${name}\``);
    if (!Number.isNaN(q.value)) return q.value;
    if (resolving.has(name)) throw new ToolError(`expression: parameter \`${name}\` depends on itself`);
    resolving.add(name);
    q.value = evalExpr(q.expression, lookup);
    resolving.delete(name);
    return q.value;
  };
  for (const q of params) lookup(q.name);
  const ev = (v: unknown, command: string, field: string): number => {
    if (typeof v !== "number" && typeof v !== "string") {
      throw new ToolError(`invalid parameters for \`${command}\`: \`${field}\` must be a number or an expression`);
    }
    return evalExpr(v, lookup);
  };
  const pt = (v: unknown, command: string, field: string, n: number): number[] => {
    if (!Array.isArray(v) || v.length < n) throw new ToolError(`invalid parameters for \`${command}\`: \`${field}\` must be [${"xyz".slice(0, n).split("").join(",")}]`);
    return v.slice(0, n).map((c, k) => ev(c, command, `${field}[${k}]`));
  };

  // Pass 2 — sketches, features, bodies.
  const m: Model = { params, sketches: [], timeline: [], bodies: [], results: [], activeSketch: null };
  let nextId = 1;
  let bodyCount = 0;
  const counters: Record<string, number> = {};
  const autoName = (base: string) => `${base}${(counters[base] = (counters[base] ?? 0) + 1)}`;
  const bodyNamed = (name: string, command: string): Body => {
    const b = m.bodies.find((x) => x.name === name);
    if (!b) throw new ToolError(`invalid parameters for \`${command}\`: no body \`${name}\``);
    return b;
  };
  const newBody = (feature: number, name: unknown): Body => {
    bodyCount++;
    const b: Body = { name: typeof name === "string" && name ? name : `Body${bodyCount}`, feature, solids: [], voids: [], volume: 0, faces: [] };
    m.bodies.push(b);
    return b;
  };
  /** The modifiable body a vertical tool at (x, y) spanning [z0, z1] acts on. */
  const target = (p: Json, command: string, x: number, y: number, z0: number, z1: number): Body => {
    const soft = m.bodies.filter((b) => !b.fixed);
    if (Array.isArray(p.targets) && p.targets.length && p.targets[0] !== "*") return bodyNamed(String(p.targets[0]), command);
    if (soft.length === 0) throw new ToolError(`invalid parameters for \`${command}\`: there is no body to modify`);
    return (
      soft.find((b) => material(b, x, y, 0, z0 - 1e-6, z1 + 1e-6) > 0) ??
      soft.find((b) => {
        const bb = bboxOf(b);
        return x >= bb.min[0] && x <= bb.max[0] && y >= bb.min[1] && y <= bb.max[1];
      }) ??
      soft[0]!
    );
  };
  let curIdx = 0;
  const feature = (command: string, type: string, base: string, name: unknown): Feature => {
    const f: Feature = { id: nextId++, name: typeof name === "string" && name ? name : autoName(base), type, warning: WARN_ON === command ? BOOLEAN_RETRY : null, log: curIdx };
    m.timeline.push(f);
    return f;
  };
  const featureResult = (f: Feature, created: string[], changed: string[]): Json => ({
    bodies: m.bodies.map((b) => b.name),
    changed_bodies: changed,
    created_bodies: created,
    feature: f.id,
    ms: 0.1,
    name: f.name,
    removed_bodies: [],
    warning: f.warning,
  });
  const planeFace = (name: string, normal: V3, area: number, centroid: V3): Face => ({ name, normal, area, centroid });
  const cylFace = (name: string, x: number, y: number, z0: number, z1: number, r: number, fraction = 1): Face => ({
    name,
    area: 2 * PI * r * (z1 - z0) * fraction,
    centroid: [x, y, (z0 + z1) / 2],
    cylinder: { axis: [0, 0, 1], origin: [x, y, z0], radius: r, length: z1 - z0 },
  });
  /** The six faces of a prism, named as the real tool names a box's (or an extrusion's) faces. */
  const prism = (b: Body, f: Feature, min: V3, max: V3, names: Record<string, string>) => {
    const [dx, dy, dz] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const c: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    b.solids.push({ kind: "box", min, max });
    b.volume += dx * dy * dz;
    b.faces.push(
      planeFace(`F${f.id}:${names["+y"]}`, [0, 1, 0], dx * dz, [c[0], max[1], c[2]]),
      planeFace(`F${f.id}:${names["-x"]}`, [-1, 0, 0], dy * dz, [min[0], c[1], c[2]]),
      planeFace(`F${f.id}:${names["+x"]}`, [1, 0, 0], dy * dz, [max[0], c[1], c[2]]),
      planeFace(`F${f.id}:${names["-y"]}`, [0, -1, 0], dx * dz, [c[0], min[1], c[2]]),
      planeFace(`F${f.id}:${names["-z"]}`, [0, 0, -1], dx * dy, [c[0], c[1], min[2]]),
      planeFace(`F${f.id}:${names["+z"]}`, [0, 0, 1], dx * dy, [c[0], c[1], max[2]]),
    );
  };
  /** Take `area` off the horizontal face of `b` at height z facing `sign` (a hole's mouth). */
  const openFace = (b: Body, z: number, sign: 1 | -1, area: number) => {
    const f = b.faces.find((x) => x.normal && x.normal[2] === sign && Math.abs(x.centroid[2] - z) < 1e-9);
    if (f) f.area = Math.max(0, f.area - area);
  };

  const sketchOf = (ref: unknown, command: string): Sketch => {
    const s = ref === undefined ? m.sketches[m.sketches.length - 1] : m.sketches.find((x) => x.name === ref || x.id === ref);
    if (!s) throw new ToolError(`invalid parameters for \`${command}\`: ${ref === undefined ? "there is no sketch" : `no sketch \`${ref}\``}`);
    return s;
  };
  const active = (command: string): Sketch => {
    if (!m.activeSketch) throw new ToolError(`\`${command}\` needs an active sketch (sketch.create first)`);
    return m.activeSketch;
  };
  const created = (o: Partial<Record<"constraints" | "curves" | "dimensions" | "points", string[]>> = {}) => ({
    constraints: [], curves: [], dimensions: [], points: [], ...o,
  });
  const rectangle = (s: Sketch, p: Json, command: string) => {
    const c = pt(p.center ?? [0, 0], command, "center", 2);
    const k = pt(p.corner, command, "corner", 2);
    s.rect = { cx: c[0]!, cy: c[1]!, w: 2 * Math.abs(k[0]! - c[0]!), h: 2 * Math.abs(k[1]! - c[1]!) };
  };

  /** One vertical drill at (x, y) entering at zTop. Returns whether it removed anything. */
  const drill = (b: Body, f: Feature, p: Json, x: number, y: number, zTop: number, suffix: string): boolean => {
    const cmd = "solid.hole";
    const r = ev(p.diameter, cmd, "diameter") / 2;
    const type = String(p.type ?? "simple");
    if (!["simple", "drilled", "counterbore"].includes(type)) throw new ToolError(`invalid parameters for \`${cmd}\`: fake-solidcraft does not model hole type \`${type}\``);
    const blind = p.depth !== undefined;
    const zBottom = blind ? zTop - ev(p.depth, cmd, "depth") : -Infinity;
    const cb = type === "counterbore";
    const R = cb ? ev(p.cb_diameter, cmd, "cb_diameter") / 2 : r;
    const zStep = cb ? zTop - ev(p.cb_depth, cmd, "cb_depth") : zTop;
    const removed = PI * R * R * material(b, x, y, R, zStep, zTop) + PI * r * r * material(b, x, y, r, zBottom, zStep);
    if (removed <= 0 || MISS_CUTS) return false;
    b.volume -= removed;
    const bb = bboxOf(b);
    const floor = blind ? zBottom : bb.min[2];
    openFace(b, zTop, 1, PI * R * R);
    if (cb) b.voids.push({ kind: "cyl", x, y, r: R, z0: zStep, z1: zTop });
    b.voids.push({ kind: "cyl", x, y, r, z0: blind ? zBottom : floor, z1: zStep });
    if (cb) {
      b.faces.push(planeFace(`F${f.id}:cbore:base${suffix}`, [0, 0, 1], PI * (R * R - r * r), [x, y, zStep]));
      b.faces.push(cylFace(`F${f.id}:cbore:side:0${suffix}`, x, y, zStep, zTop, R));
    }
    if (blind) b.faces.push(planeFace(`F${f.id}:bore:base${suffix}`, [0, 0, 1], PI * r * r, [x, y, zBottom]));
    else openFace(b, floor, -1, PI * r * r);
    b.faces.push(cylFace(`F${f.id}:bore:side:0${suffix}`, x, y, floor, zStep, r));
    return true;
  };

  const paramReplies: Json[] = [];
  for (const [idx, { command, params: p }] of log.entries()) {
    curIdx = idx;
    const tolerant = idx < strictFrom && command.startsWith("solid.");
    const snap = tolerant ? { bodies: structuredClone(m.bodies), timeline: m.timeline.length, results: m.results.length, bodyCount, nextId, counters: { ...counters } } : undefined;
    try {
    switch (command) {
      case "parameters.add": {
        const q = params.find((x) => x.name === p.name)!;
        m.results.push({ display_value: q.value, name: q.name, unit: q.unit, value: q.value });
        break;
      }
      case "parameters.change": {
        if (p.changes && typeof p.changes === "object") {
          const changed = Object.fromEntries(Object.keys(p.changes).map((name) => [name, params.find((x) => x.name === name)!.value]));
          paramReplies.push({ changed, errors: [], recomputed: 0, restored: 0 });
        } else {
          const q = params.find((x) => x.name === p.name)!;
          paramReplies.push({ display_value: q.value, errors: [], expression: q.expression, name: q.name, recomputed: 0, restored: 0, value: q.value });
        }
        m.results.push(paramReplies[paramReplies.length - 1]!);
        break;
      }
      case "sketch.create": {
        const z = p.offset === undefined ? 0 : ev(p.offset, command, "offset");
        if (p.plane !== undefined && String(p.plane).toUpperCase() !== "XY") throw new ToolError(`invalid parameters for \`${command}\`: fake-solidcraft models the XY plane only`);
        const id = nextId++;
        const s: Sketch = { id, name: typeof p.name === "string" && p.name ? p.name : autoName("Sketch"), z, points: [] };
        m.sketches.push(s);
        m.activeSketch = s;
        m.timeline.push({ id, name: s.name, type: "Sketch", warning: null });
        m.results.push({ attachment: "fixed", created: created(), name: s.name, projected: null, sketch: id });
        break;
      }
      case "sketch.rectangle.center": {
        rectangle(active(command), p, command);
        m.results.push({ created: created({ curves: ["l1", "l2", "l3", "l4"], points: ["p1", "p2", "p3", "p4"] }), curves: ["l1", "l2", "l3", "l4"], sketch: { dof: 4, solved: true } });
        break;
      }
      case "sketch.draw.dimensioned": {
        const s = active(command);
        if (p.command !== "sketch.rectangle.center") throw new ToolError(`invalid parameters for \`${command}\`: fake-solidcraft draws only sketch.rectangle.center`);
        rectangle(s, p.params ?? {}, command);
        const d = p.dimensions ?? {};
        if (d.width !== undefined) s.rect!.w = ev(d.width, command, "dimensions.width");
        if (d.height !== undefined) s.rect!.h = ev(d.height, command, "dimensions.height");
        m.results.push({
          created: created({ curves: ["l1", "l2", "l3", "l4"], dimensions: ["k7", "k8"], points: ["p1", "p2", "p3", "p4", "p5"] }),
          curves: ["l1", "l2", "l3", "l4"],
          sides: { bottom: "l1", left: "l4", right: "l2", top: "l3" },
          sketch: { dof: 0, solved: true },
        });
        break;
      }
      case "sketch.point": {
        const s = active(command);
        const [x, y] = pt(p.point, command, "point", 2);
        const id = `p${s.points.length + 1}`;
        s.points.push({ id, x: x!, y: y! });
        m.results.push({ created: created({ points: [id] }), point: id, sketch: { dof: 2, solved: true } });
        break;
      }
      case "sketch.dimension": {
        const s = active(command);
        const ents: unknown[] = Array.isArray(p.entities) ? p.entities : [];
        const point = s.points.find((q) => ents.includes(q.id));
        if (!ents.includes("origin") || !point || (p.type !== "horizontal" && p.type !== "vertical")) {
          throw new ToolError(`invalid parameters for \`${command}\`: fake-solidcraft dimensions only origin → point, horizontal or vertical`);
        }
        const v = ev(p.value, command, "value");
        if (p.type === "horizontal") point.x = v;
        else point.y = v;
        m.results.push({ created: created({ dimensions: ["k1"] }), expression: fmtParam(p.value), measured: v, sketch: { dof: 0, solved: true }, type: "LinearDimension", unit: "mm" });
        break;
      }
      case "sketch.finish": {
        const s = active(command);
        m.activeSketch = null;
        m.results.push({ profiles: s.rect ? 1 : 0, sketch: s.id });
        break;
      }
      case "solid.extrude": {
        const s = sketchOf(p.sketch, command);
        if (!s.rect) throw new ToolError(`${s.name} has no closed profiles`);
        if (operation(p.operation, command) !== "new") throw new ToolError(`invalid parameters for \`${command}\`: fake-solidcraft extrudes new bodies only`);
        const d = ev(p.distance, command, "distance");
        const f = feature(command, "ExtrudeFeature", "Extrude", p.name);
        const b = newBody(f.id, p.body_name);
        const { cx, cy, w, h } = s.rect;
        prism(b, f, [cx - w / 2, cy - h / 2, Math.min(s.z, s.z + d)], [cx + w / 2, cy + h / 2, Math.max(s.z, s.z + d)], {
          "+y": "side:l3", "-x": "side:l4", "+x": "side:l2", "-y": "side:l1", "-z": "start", "+z": "top",
        });
        m.results.push(featureResult(f, [b.name], []));
        break;
      }
      case "solid.box": {
        const [l, w, h] = [ev(p.length, command, "length"), ev(p.width, command, "width"), ev(p.height, command, "height")];
        if (operation(p.operation, command) !== "new") throw new ToolError(`invalid parameters for \`${command}\`: fake-solidcraft makes box bodies only (no join/cut)`);
        const lo = p.center ? pt(p.center, command, "center", 3).map((c, k) => c - [l, w, h][k]! / 2) : pt(p.corner ?? [0, 0, 0], command, "corner", 3);
        const f = feature(command, "BoxFeature", "Box", p.name);
        const b = newBody(f.id, p.body_name);
        prism(b, f, lo as V3, [lo[0]! + l, lo[1]! + w, lo[2]! + h], { "+y": "+y", "-x": "-x", "+x": "+x", "-y": "-y", "-z": "-z", "+z": "+z" });
        m.results.push(featureResult(f, [b.name], []));
        break;
      }
      case "solid.cylinder": {
        const r = p.radius !== undefined ? ev(p.radius, command, "radius") : ev(p.diameter, command, "diameter") / 2;
        const h = ev(p.height, command, "height");
        const [x0, y0, z0] = pt(p.base ?? [0, 0, 0], command, "base", 3) as V3;
        if (p.axis !== undefined && String(p.axis).toUpperCase() !== "Z" && String(p.axis) !== "0,0,1") throw new ToolError(`invalid parameters for \`${command}\`: fake-solidcraft models the Z axis only`);
        const op = operation(p.operation, command);
        const f = feature(command, "CylinderFeature", "Cylinder", p.name);
        if (op === "new") {
          const b = newBody(f.id, p.body_name);
          b.solids.push({ kind: "cyl", x: x0, y: y0, r, z0, z1: z0 + h });
          b.volume = PI * r * r * h;
          b.faces.push(cylFace(`F${f.id}:side`, x0, y0, z0, z0 + h, r), planeFace(`F${f.id}:top`, [0, 0, 1], PI * r * r, [x0, y0, z0 + h]), planeFace(`F${f.id}:bottom`, [0, 0, -1], PI * r * r, [x0, y0, z0]));
          m.results.push(featureResult(f, [b.name], []));
          break;
        }
        f.instance = (dx, dy, suffix) => {
          const [x, y] = [x0 + dx, y0 + dy];
          const b = target(p, command, x, y, z0, z0 + h);
          const inside = material(b, x, y, r, z0, z0 + h);
          if (op === "join") {
            b.volume += PI * r * r * (h - inside);
            b.solids.push({ kind: "cyl", x, y, r, z0, z1: z0 + h });
            b.faces.push(cylFace(`F${f.id}:side${suffix}`, x, y, z0 + inside, z0 + h, r), planeFace(`F${f.id}:top${suffix}`, [0, 0, 1], PI * r * r, [x, y, z0 + h]));
            return [b.name];
          }
          if (inside <= 0 || MISS_CUTS) return [];
          b.volume -= PI * r * r * inside;
          b.voids.push({ kind: "cyl", x, y, r, z0, z1: z0 + h });
          b.faces.push(cylFace(`F${f.id}:side${suffix}`, x, y, z0, z0 + inside, r));
          return [b.name];
        };
        m.results.push(featureResult(f, [], f.instance(0, 0, "")));
        break;
      }
      case "solid.fillet": {
        const r = ev(p.radius, command, "radius");
        if (!Array.isArray(p.edges) || p.edges.length === 0) throw new ToolError(`invalid parameters for \`${command}\`: \`edges\` must list at least one edge point`);
        const f = feature(command, "FilletFeature", "Fillet", p.name);
        const changed = new Set<string>();
        const done = new Set<string>();
        const blends: { b: Body; face: Face }[] = [];
        for (const e of p.edges) {
          const [x, y, z] = pt(e, command, "edges[]", 3) as V3;
          // The edge is the vertical corner NEAREST the picked point, so a pick made at one size
          // still names the same corner after a parameter resizes the body (the real tool keeps
          // the edge's name for the same reason).
          let best: { b: Body; s: Extract<Solid, { kind: "box" }>; sx: 0 | 1; sy: 0 | 1; d: number } | undefined;
          for (const b of m.bodies) {
            if (b.fixed) continue;
            for (const s of b.solids) {
              if (s.kind !== "box") continue;
              for (const sx of [0, 1] as const) {
                for (const sy of [0, 1] as const) {
                  const d = Math.hypot(x - (sx ? s.max[0] : s.min[0]), y - (sy ? s.max[1] : s.min[1]), z < s.min[2] ? s.min[2] - z : z > s.max[2] ? z - s.max[2] : 0);
                  if (!best || d < best.d) best = { b, s, sx, sy, d };
                }
              }
            }
          }
          if (!best) throw new ToolError(`invalid parameters for \`${command}\`: no edge at (${x}, ${y}, ${z})`);
          const { b, s, sx, sy } = best;
          const key = `${b.name}:${m.bodies.indexOf(b)}:${b.solids.indexOf(s)}:${sx}${sy}`;
          if (done.has(key)) continue;
          done.add(key);
          if (2 * r > Math.min(s.max[0] - s.min[0], s.max[1] - s.min[1]) + 1e-9) {
            throw new ToolError("not supported yet: the fillet is larger than the faces beside its edges allow");
          }
          const h = s.max[2] - s.min[2];
          b.volume -= r * r * (1 - PI / 4) * h;
          const side = (axis: "x" | "y", hi: 0 | 1) => b.faces.find((q) => q.normal && q.normal[axis === "x" ? 0 : 1] === (hi ? 1 : -1) && !q.cylinder);
          const [fx, fy] = [side("x", sx), side("y", sy)];
          for (const q of [fx, fy]) if (q) q.area = Math.max(0, q.area - r * h);
          for (const q of b.faces) if (q.normal && Math.abs(q.normal[2]) === 1 && (q.name.endsWith(":top") || q.name.endsWith(":start") || q.name.endsWith("z"))) q.area -= r * r * (1 - PI / 4);
          const names = [fy?.name, fx?.name].filter(Boolean).sort();
          const ox = sx ? s.max[0] - r : s.min[0] + r;
          const oy = sy ? s.max[1] - r : s.min[1] + r;
          b.voids.push({ kind: "fillet", ox, oy, sx, sy, r, z0: s.min[2], z1: s.max[2] });
          blends.push({ b, face: cylFace(`F${f.id}:blend(${names.join("|")})`, ox, oy, s.min[2], s.max[2], r, 0.25) });
          changed.add(b.name);
        }
        // The real tool lists the blends by position (x, then y), whatever order the edges were picked in.
        blends.sort((p1, p2) => p1.face.cylinder!.origin[0] - p2.face.cylinder!.origin[0] || p1.face.cylinder!.origin[1] - p2.face.cylinder!.origin[1]);
        for (const { b, face } of blends) b.faces.push(face);
        m.results.push(featureResult(f, [], [...changed]));
        break;
      }
      case "solid.hole": {
        let spots: { x: number; y: number; z: number }[];
        if (p.sketch !== undefined) {
          const s = sketchOf(p.sketch, command);
          const ids: unknown[] | undefined = Array.isArray(p.points) ? p.points : undefined;
          spots = s.points.filter((q) => !ids || ids.includes(q.id)).map((q) => ({ x: q.x, y: q.y, z: s.z }));
          if (spots.length === 0) throw new ToolError(`invalid parameters for \`${command}\`: sketch \`${s.name}\` has no points to drill`);
        } else {
          const [x, y, z] = pt(p.position, command, "position", 3) as V3;
          spots = [{ x, y, z }];
        }
        ev(p.diameter, command, "diameter");
        const f = feature(command, "HoleFeature", "Hole", p.name);
        f.instance = (dx, dy, suffix) => {
          const changed = new Set<string>();
          for (const s of spots) {
            const b = target(p, command, s.x + dx, s.y + dy, -Infinity, s.z);
            if (drill(b, f, p, s.x + dx, s.y + dy, s.z, suffix)) changed.add(b.name);
          }
          return [...changed];
        };
        m.results.push(featureResult(f, [], f.instance(0, 0, "")));
        break;
      }
      case "solid.pattern.rectangular": {
        const names: unknown[] = Array.isArray(p.features) ? p.features : [];
        const sources = names.map((n) => {
          const src = m.timeline.find((t) => t.name === n || t.id === n);
          if (!src) throw new ToolError(`invalid parameters for \`${command}\`: no feature \`${n}\``);
          if (!src.instance) throw new ToolError(`invalid parameters for \`${command}\`: fake-solidcraft patterns only hole and cylinder join/cut features (\`${n}\` is a ${src.type})`);
          return src;
        });
        if (sources.length === 0) throw new ToolError(`invalid parameters for \`${command}\`: \`features\` is required`);
        const n1 = Math.round(ev(p.count1 ?? 1, command, "count1"));
        const n2 = Math.round(ev(p.count2 ?? 1, command, "count2"));
        const d1 = pt(p.dir1 ?? [1, 0, 0], command, "dir1", 3);
        const d2 = pt(p.dir2 ?? [0, 1, 0], command, "dir2", 3);
        const s1 = n1 > 1 ? ev(p.spacing1, command, "spacing1") : 0;
        const s2 = n2 > 1 ? ev(p.spacing2, command, "spacing2") : 0;
        const f = feature(command, "RectangularPatternFeature", "Pattern", p.name);
        const changed = new Set<string>();
        for (let i = 0; i < n1; i++) {
          for (let j = 0; j < n2; j++) {
            if (i === 0 && j === 0) continue;
            const dx = d1[0]! * s1 * i + d2[0]! * s2 * j;
            const dy = d1[1]! * s1 * i + d2[1]! * s2 * j;
            for (const src of sources) for (const name of src.instance!(dx, dy, `@F${f.id}.${i * n2 + j}`)) changed.add(name);
          }
        }
        m.results.push(featureResult(f, [], [...changed]));
        break;
      }
      case "timeline.add":
      case "file.insert_step": {
        // A replayed import carries its STEP text (the real script shape); a live insert was given it
        // by `execute` (see stepParams). Nothing reads the file again.
        const imp = command === "timeline.add" ? (p.feature as Json | undefined) : p;
        if (command === "timeline.add" && (imp?.type !== "import" || typeof imp?.step !== "string")) throw new UnknownCommand("fake-solidcraft only replays `timeline.add` imports");
        const text: string = typeof imp!.step === "string" ? imp!.step : readFileSync(readablePath(p.path, command), "utf8");
        const path: string = typeof p.path === "string" ? p.path : String(imp!.file ?? "reference.step");
        const stem = basename(String(imp!.file ?? path), extname(String(imp!.file ?? path)));
        const marker = /\/\* fake-solidcraft (\{.*\}) \*\//.exec(text);
        const src: { name: string; volume: number; faces: number; min: V3; max: V3 }[] = marker
          ? JSON.parse(marker[1]!).bodies
          : [{ name: stem, volume: 1000, faces: 6, min: [0, 0, 0], max: [10, 10, 10] }];
        const f = feature(command, "BaseFeature", "Import", imp!.name ?? stem); // the real timeline type of a STEP import
        const made: string[] = [];
        for (const s of src) {
          let name = src.length === 1 ? stem : s.name;
          while (m.bodies.some((b) => b.name === name)) name += "_1";
          const faces: Face[] = Array.from({ length: s.faces }, (_, k) => planeFace(`F${f.id}:import:${k}`, [0, 0, 1], 0, s.min));
          m.bodies.push({ name, feature: f.id, solids: [{ kind: "box", min: s.min, max: s.max }], voids: [], volume: s.volume, faces, fixed: true });
          made.push(name);
        }
        m.results.push({
          bodies: made, component: f.id, component_name: stem, content_sha256: createHash("sha256").update(text).digest("hex"), created_bodies: made, exporter: marker ? "SolidCraft" : "unknown", exporter_up: "z",
          feature: f.id, name: f.name, occurrence: f.id, path, system: marker ? "SolidCraft" : "unknown", warnings: [],
        });
        break;
      }
      default:
        throw new UnknownCommand(`unknown command \`${command}\``);
    }
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      if (!snap || e instanceof UnknownCommand) {
        e.step ??= idx;
        e.command ??= command;
        throw e;
      }
      // A feature that no longer computes: undo whatever it half-did and keep it as a failed feature.
      m.bodies = snap.bodies;
      m.timeline.length = snap.timeline;
      m.results.length = snap.results;
      bodyCount = snap.bodyCount;
      nextId = snap.nextId;
      for (const k of Object.keys(counters)) delete counters[k];
      Object.assign(counters, snap.counters);
      const [type, base] = FEATURE_TYPES[command] ?? ["Feature", "Feature"];
      const f: Feature = { id: nextId++, name: typeof p.name === "string" && p.name ? p.name : autoName(base), type, warning: null, error: e.message };
      m.timeline.push(f);
      m.results.push({ error: e.message, feature: f.id, name: f.name, warning: null });
    }
  }
  // A parameter change reports every feature it left failing, and still counts as a success.
  const errors = m.timeline.filter((f) => f.error).map((f) => ({ error: f.error, feature: f.name }));
  for (const r of paramReplies) {
    r.errors = errors;
    r.recomputed = m.timeline.length;
  }
  return m;
}

// ── reports ─────────────────────────────────────────────────────────────────────────────────────
function measureBody(b: Body, summary: boolean): Json {
  const volume = b.volume * VOLUME_SCALE;
  const core = { bbox: bboxOf(b), closed: true, faces: b.faces.length, name: b.name, volume_mm3: volume };
  if (summary) return core;
  const cyl = b.faces.filter((f) => f.cylinder).length;
  return {
    ...core,
    density_g_cm3: 1.29,
    face_types: { ...(cyl ? { cylinder: cyl } : {}), plane: b.faces.length - cyl },
    mass_g: (volume * 1.29) / 1000,
    material: "Default",
    measured_by: "fake",
    notes: [],
  };
}
function measure(m: Model, a: Json): Json {
  let bodies = m.bodies;
  if (typeof a.body === "string") {
    bodies = bodies.filter((b) => b.name === a.body);
    if (bodies.length === 0) throw new ToolError("invalid parameters for `inspect.measure`: unknown body name");
  }
  // `inspect.measure {bodies}`: a name or a list of names; null or an EMPTY list means all, as the real command does.
  const pick: string[] | undefined = typeof a.bodies === "string" ? [a.bodies] : Array.isArray(a.bodies) && a.bodies.length ? a.bodies : undefined;
  if (pick) {
    bodies = pick.map((n) => {
      const b = m.bodies.find((x) => x.name === n);
      if (!b) throw new ToolError("invalid parameters for `inspect.measure`: unknown body name");
      return b;
    });
  }
  // `names_only`: each placed body's world name and its definition's (the fake places every body once).
  if (a.names_only === true) return { bodies: bodies.map((b) => ({ definition: b.name, name: b.name })), body_count: bodies.length };
  const summary = a.summary === true;
  const volume = bodies.reduce((s, b) => s + b.volume, 0) * VOLUME_SCALE;
  return {
    bodies: bodies.map((b) => measureBody(b, summary)),
    body_count: bodies.length,
    total: summary ? { volume_mm3: volume } : { faces: bodies.reduce((s, b) => s + b.faces.length, 0), mass_g: (volume * 1.29) / 1000, open_bodies_skipped: 0, volume_mm3: volume },
  };
}
function cylinders(b: Body): Json[] {
  return b.faces.filter((f) => f.cylinder).map((f) => ({
    axis: f.cylinder!.axis,
    extent: [0, f.cylinder!.length],
    names: [f.name],
    origin: f.cylinder!.origin,
    radius: f.cylinder!.radius,
  }));
}
function topology(m: Model, a: Json): Json {
  const b = m.bodies.find((x) => x.name === a.body);
  if (!b) throw new ToolError(`invalid parameters for \`model.edges\`: no body \`${a.body}\``);
  if (a.faces === "cylinders") return { body: b.name, cylinders: cylinders(b) };
  return {
    body: b.name,
    edges: [],
    faces: b.faces.map((f, index) => ({
      area: f.area,
      centroid: f.centroid,
      ...(f.cylinder ? { cylinder: { axis: f.cylinder.axis, origin: f.cylinder.origin, radius: f.cylinder.radius } } : {}),
      exact: true,
      index,
      name: f.name,
      plane_normal: f.normal ?? null,
      point: f.centroid,
    })),
  };
}
// ── view.pick: rays against the closed-form solids ──────────────────────────────────────────────
const EPS = 1e-6;
/** Is the point in the body's material? */
function inside(b: Body, p: V3): boolean {
  const inSolid = b.solids.some((s) =>
    s.kind === "box"
      ? p[0] >= s.min[0] && p[0] <= s.max[0] && p[1] >= s.min[1] && p[1] <= s.max[1] && p[2] >= s.min[2] && p[2] <= s.max[2]
      : Math.hypot(p[0] - s.x, p[1] - s.y) <= s.r && p[2] >= s.z0 && p[2] <= s.z1,
  );
  if (!inSolid) return false;
  for (const v of b.voids) {
    if (p[2] <= v.z0 || p[2] >= v.z1) continue;
    if (v.kind === "cyl") {
      if (Math.hypot(p[0] - v.x, p[1] - v.y) < v.r) return false;
    } else {
      // The corner outside the fillet's arc: beyond the arc centre on both axes, and further than r from it.
      const bx = v.sx ? p[0] > v.ox : p[0] < v.ox;
      const by = v.sy ? p[1] > v.oy : p[1] < v.oy;
      if (bx && by && Math.hypot(p[0] - v.ox, p[1] - v.oy) > v.r) return false;
    }
  }
  return true;
}
/** Every ray parameter t > 0 at which the ray meets one of the body's primitive surfaces, with that surface's normal. */
function candidates(b: Body, o: V3, d: V3): { t: number; n: V3 }[] {
  const out: { t: number; n: V3 }[] = [];
  const plane = (axis: 0 | 1 | 2, value: number) => {
    if (Math.abs(d[axis]) < 1e-12) return;
    const n: V3 = [0, 0, 0];
    n[axis] = 1;
    out.push({ t: (value - o[axis]) / d[axis], n });
  };
  const cylinder = (x: number, y: number, r: number) => {
    const [ox, oy] = [o[0] - x, o[1] - y];
    const a = d[0] * d[0] + d[1] * d[1];
    if (a < 1e-12) return;
    const h = ox * d[0] + oy * d[1];
    const disc = h * h - a * (ox * ox + oy * oy - r * r);
    if (disc < 0) return;
    for (const t of [(-h - Math.sqrt(disc)) / a, (-h + Math.sqrt(disc)) / a]) {
      out.push({ t, n: [(o[0] + t * d[0] - x) / r, (o[1] + t * d[1] - y) / r, 0] });
    }
  };
  for (const s of b.solids) {
    if (s.kind === "box") {
      for (const axis of [0, 1, 2] as const) {
        plane(axis, s.min[axis]);
        plane(axis, s.max[axis]);
      }
    } else {
      cylinder(s.x, s.y, s.r);
      plane(2, s.z0);
      plane(2, s.z1);
    }
  }
  for (const v of b.voids) {
    if (v.kind === "cyl") cylinder(v.x, v.y, v.r);
    else cylinder(v.ox, v.oy, v.r);
    plane(2, v.z0);
    plane(2, v.z1);
  }
  return out.filter((c) => Number.isFinite(c.t) && c.t > EPS);
}
/** `view.pick {rays, all}`: per ray, where it crosses a body's surface, nearest first; `[]` for a miss. */
function pick(m: Model, p: Json): Json {
  if (!Array.isArray(p.rays)) throw new ToolError("invalid parameters for `view.pick`: `rays` must be a list of {origin, dir}");
  if (p.rays.length > 1024) throw new ToolError("invalid parameters for `view.pick`: at most 1024 rays");
  const hits = p.rays.map((ray: Json) => {
    const o = ray?.origin as V3;
    const raw = ray?.dir as V3;
    if (!Array.isArray(o) || !Array.isArray(raw) || o.length !== 3 || raw.length !== 3) throw new ToolError("invalid parameters for `view.pick`: a ray needs `origin` and `dir`");
    const len = Math.hypot(raw[0], raw[1], raw[2]);
    if (!(len > 0)) throw new ToolError("invalid parameters for `view.pick`: a ray's `dir` is zero");
    const d: V3 = [raw[0] / len, raw[1] / len, raw[2] / len];
    const found: Json[] = [];
    for (const b of m.bodies) {
      const seen: number[] = [];
      for (const c of candidates(b, o, d).sort((x, y) => x.t - y.t)) {
        if (seen.some((t) => Math.abs(t - c.t) < 1e-7)) continue;
        const at = (t: number): V3 => [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
        const [before, after] = [inside(b, at(c.t - EPS)), inside(b, at(c.t + EPS))];
        if (before === after) continue; // not on the body's real boundary here
        seen.push(c.t);
        // The outward normal points from material to air: along the ray when it is leaving material.
        const along = c.n[0] * d[0] + c.n[1] * d[1] + c.n[2] * d[2];
        const flip = before ? along < 0 : along > 0;
        const point = at(c.t);
        const normal = (flip ? c.n.map((v) => -v) : c.n) as V3;
        const face = b.faces.findIndex((f) => (f.cylinder ? Math.abs(Math.hypot(point[0] - f.cylinder.origin[0], point[1] - f.cylinder.origin[1]) - f.cylinder.radius) < 1e-6 : false));
        found.push({ body: b.name, depth: c.t, face: Math.max(0, face), normal, pixel: { dir: raw, origin: o }, point });
      }
    }
    found.sort((x, y) => x.depth - y.depth);
    return p.all === true ? found : found.slice(0, 1);
  });
  return { frame: "rays", hits };
}

function interference(m: Model, p: Json): Json {
  const pick: Body[] = Array.isArray(p.bodies)
    ? p.bodies.map((n: string) => {
        const b = m.bodies.find((x) => x.name === n);
        if (!b) throw new ToolError(`invalid parameters for \`inspect.interference\`: no body \`${n}\``);
        return b;
      })
    : m.bodies;
  const out: Json[] = [];
  const excluded = new Set((Array.isArray(p.exclude_pairs) ? p.exclude_pairs : []).flatMap((x: unknown) => (Array.isArray(x) && x.length === 2 ? [`${x[0]}\n${x[1]}`, `${x[1]}\n${x[0]}`] : [])));
  for (let i = 0; i < pick.length; i++) {
    for (let j = i + 1; j < pick.length; j++) {
      if (excluded.has(`${pick[i]!.name}\n${pick[j]!.name}`)) continue;
      const [a, b] = [bboxOf(pick[i]!), bboxOf(pick[j]!)];
      const min = a.min.map((v, k) => Math.max(v, b.min[k]!)) as V3;
      const max = a.max.map((v, k) => Math.min(v, b.max[k]!)) as V3;
      const d = max.map((v, k) => v - min[k]!);
      if (d.some((v) => v <= 1e-9)) continue;
      const part = { component: "", path: [], path_ids: [] };
      out.push({
        a: pick[i]!.name, a_part: part, b: pick[j]!.name, b_part: part, bbox: { max, min },
        center: min.map((v, k) => (v + max[k]!) / 2), volume_mm3: d[0]! * d[1]! * d[2]! * VOLUME_SCALE,
      });
    }
  }
  if (INTERFERENCE) {
    // The hook: the check did not complete, and it reports nothing found.
    return {
      budget_exceeded: INTERFERENCE === "budget", budget_s: 240, checked: pick.length, count: 0, interferences: [], ms: 0.1,
      pairs_candidate: 1, pairs_cleared: 0, pairs_excluded: excluded.size / 2, pairs_intersected: 0, pairs_not_checked: 1,
      skipped_pairs: 0, truncated: INTERFERENCE === "truncated", unchecked: INTERFERENCE === "unchecked" ? [[pick[0]?.name ?? "?", pick[1]?.name ?? "?"]] : [],
    };
  }
  return {
    budget_exceeded: false, budget_s: 240, checked: pick.length, count: out.length, interferences: out, ms: 0.1,
    pairs_candidate: out.length, pairs_cleared: 0, pairs_excluded: excluded.size / 2, pairs_intersected: out.length, pairs_not_checked: 0,
    skipped_pairs: 0, truncated: false, unchecked: [],
  };
}

// ── files ───────────────────────────────────────────────────────────────────────────────────────
const allowed: string[] = [];
const real = (p: string): string => {
  // Resolve symlinks on the deepest EXISTING ancestor (/tmp → /private/tmp), keep the rest.
  let dir = resolve(p);
  const rest: string[] = [];
  while (!existsSync(dir) && dirname(dir) !== dir) {
    rest.unshift(basename(dir));
    dir = dirname(dir);
  }
  return join(realpathSync(dir), ...rest);
};
function allowedPath(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !raw) throw new RpcError(-32602, `${what}: missing required argument \`path\``);
  const full = isAbsolute(raw) ? real(raw) : "";
  if (!full || !allowed.some((d) => full === d || full.startsWith(d + "/"))) {
    throw new ToolError(`${raw}: outside the folders this agent may use (${allowed.join(", ")}); allow another folder with \`--allow-path DIR\``);
  }
  return raw;
}
function readablePath(raw: unknown, what: string): string {
  const p = allowedPath(raw, what);
  if (!existsSync(p)) throw new ToolError(`${p}: No such file or directory (os error 2)`);
  return p;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A valid w×h 8-bit grey PNG (`shade` is the grey level). */
function png(w: number, h: number, shade = 0xc0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth; colour type 0 (grey), default compression/filter/interlace
  const rows = Buffer.alloc((w + 1) * h, shade);
  for (let y = 0; y < h; y++) rows[y * (w + 1)] = 0; // filter byte per scanline
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
/** A valid single-entry (stored) zip — the container a .3mf is. */
function zip(name: string, data: Buffer): Buffer {
  const n = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12);
  end.writeUInt32LE(30 + n.length + data.length, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}
const EXPORTS: Record<string, string> = { step: "Step", stp: "Step", glb: "Glb", "3mf": "ThreeMf", stl: "StlBinary", stla: "StlAscii" };
function exportBytes(m: Model, label: string, name: string): Buffer {
  const bodies = m.bodies.map((b) => ({ name: b.name, volume: b.volume, faces: b.faces.length, ...bboxOf(b) }));
  const note = JSON.stringify({ bodies });
  switch (label) {
    case "Step":
      return Buffer.from(
        `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('SolidCraft model'),'2;1');\nFILE_NAME('${name}','',(''),(''),'SolidCraft','SolidCraft','');\n` +
          `FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));\nENDSEC;\nDATA;\n/* fake-solidcraft ${note} */\nENDSEC;\nEND-ISO-10303-21;\n`,
      );
    case "Glb": {
      // A real, loadable GLB like SolidCraft's: metres, Y up (CAD x,y,z mm → x, z, -y metres), one
      // box mesh per body spanning its bounding box. The geometry rides in a data: URI so the file
      // is a single JSON chunk.
      const nodes: Json[] = [];
      const meshes: Json[] = [];
      const accessors: Json[] = [];
      const bufferViews: Json[] = [];
      const chunks: Buffer[] = [];
      let offset = 0;
      const IDX = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
      for (const body of m.bodies) {
        const { min, max } = bboxOf(body);
        const toGl = (x: number, y: number, z: number): V3 => [x / 1000, z / 1000, -y / 1000];
        const corners: V3[] = [
          toGl(min[0], min[1], min[2]), toGl(max[0], min[1], min[2]), toGl(max[0], max[1], min[2]), toGl(min[0], max[1], min[2]),
          toGl(min[0], min[1], max[2]), toGl(max[0], min[1], max[2]), toGl(max[0], max[1], max[2]), toGl(min[0], max[1], max[2]),
        ];
        const pos = Buffer.alloc(96);
        corners.forEach((c, i) => c.forEach((v, k) => pos.writeFloatLE(v, i * 12 + k * 4)));
        const idx = Buffer.alloc(72);
        IDX.forEach((v, i) => idx.writeUInt16LE(v, i * 2));
        const lo = [0, 1, 2].map((k) => Math.fround(Math.min(...corners.map((c) => c[k]!))));
        const hi = [0, 1, 2].map((k) => Math.fround(Math.max(...corners.map((c) => c[k]!))));
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: 96, target: 34962 }, { buffer: 0, byteOffset: offset + 96, byteLength: 72, target: 34963 });
        accessors.push({ bufferView: bufferViews.length - 2, componentType: 5126, count: 8, type: "VEC3", min: lo, max: hi }, { bufferView: bufferViews.length - 1, componentType: 5123, count: 36, type: "SCALAR" });
        meshes.push({ name: body.name, primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1 }] });
        nodes.push({ name: body.name, mesh: meshes.length - 1 });
        chunks.push(pos, idx);
        offset += 168;
      }
      const bin = Buffer.concat(chunks);
      let json = JSON.stringify({
        asset: { version: "2.0", generator: "fake-solidcraft" },
        extras: { bodies },
        scene: 0,
        scenes: [{ nodes: nodes.map((_, i) => i) }],
        nodes,
        meshes,
        accessors,
        bufferViews,
        buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${bin.toString("base64")}` }],
      });
      json += " ".repeat((4 - (Buffer.byteLength(json) % 4)) % 4);
      const head = Buffer.alloc(20);
      head.write("glTF", 0, "latin1");
      head.writeUInt32LE(2, 4);
      head.writeUInt32LE(20 + Buffer.byteLength(json), 8);
      head.writeUInt32LE(Buffer.byteLength(json), 12);
      head.write("JSON", 16, "latin1");
      return Buffer.concat([head, Buffer.from(json)]);
    }
    case "ThreeMf":
      return zip(
        "3D/3dmodel.model",
        Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><!-- fake-solidcraft --><resources/><build/></model>\n`),
      );
    case "StlAscii":
      return Buffer.from(`solid ${name}\nendsolid ${name}\n`);
    default: {
      const stl = Buffer.alloc(84, 0x20); // 80-byte header + uint32 triangle count (0)
      stl.write(`SolidCraft STL ${name}`.slice(0, 80), 0, "latin1");
      stl.writeUInt32LE(0, 80);
      return stl;
    }
  }
}

// ── session ─────────────────────────────────────────────────────────────────────────────────────
let designName = "Untitled";
let designPath: string | null = null;
let log: Cmd[] = [];
let redo: Cmd[] = [];
let model: Model = build([]);
let revision = 0;

const READ_ONLY: Record<string, (m: Model, p: Json) => Json> = {
  "inspect.interference": interference,
  "inspect.measure": (m, p) => measure(m, p),
  "view.pick": pick,
  "component.list": componentList,
  "timeline.export_script": (m, p) => {
    const script = exportScript(m);
    const path = p.path === undefined ? null : allowedPath(p.path, "timeline.export_script");
    if (path) writeFileSync(path, JSON.stringify(script, null, 2) + "\n");
    return { omitted: [], path, script, steps: script.commands.length };
  },
};
/**
 * `component.list` in the real shape: the design (id 0) holds every body an import did not make; each
 * import (BaseFeature) is a component named after the feature holding its bodies, placed once in the
 * design, grounded, at the identity (as the real `file.insert_step` places it). FAKE_SC_REF_PLACEMENT
 * "moved" | "free" | "pending" | "copied" makes every import's placement translated by [1000, 0, 0],
 * not grounded, with a move pending, or placed twice.
 */
function componentList(m: Model): Json {
  const I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const mode = process.env.FAKE_SC_REF_PLACEMENT ?? "";
  const imports = m.timeline.filter((f) => f.type === "BaseFeature");
  const placed = (f: Feature, k: number) => ({ component: 1000 + f.id, grounded: mode !== "free", id: 2000 + f.id * 10 + k, name: `${f.name}:${k}`, parent: 0, transform: mode === "moved" ? [I[0], I[1], I[2], [1000, 0, 0, 1]] : I });
  const refs = imports.map((f) => ({
    bodies: m.bodies.filter((b) => b.feature === f.id).map((b) => b.name), children: [], construction: [], features: [f.name], id: 1000 + f.id, name: f.name,
    occurrences: mode === "copied" ? [placed(f, 1), placed(f, 2)] : [placed(f, 1)], parent: 0, sketches: [],
  }));
  const root = {
    bodies: m.bodies.filter((b) => !imports.some((f) => f.id === b.feature)).map((b) => b.name), children: refs.flatMap((r) => r.occurrences), construction: [],
    features: m.timeline.filter((f) => f.type !== "BaseFeature" && f.type !== "Sketch").map((f) => f.name), id: 0, name: designName, occurrences: [], parent: null, sketches: m.sketches.map((k) => k.name),
  };
  return { active: 0, active_path: [], components: [root, ...refs], pending_moves: mode === "pending" ? refs.flatMap((r) => r.occurrences.map((o) => o.id)) : [] };
}

/** The replayable script: parameters first with their current expressions, then every other step. */
function exportScript(m: Model): { about: Json; commands: Cmd[] } {
  return {
    about: { design: designName, format: `solidcraft/${FORMAT}`, replay: "solidcraft-cli eval script.json", version: VERSION },
    commands: [
      ...m.params.map((q) => ({ command: "parameters.add", params: { expression: q.expression, name: q.name, unit: q.unit } })),
      ...log.flatMap((c, idx) => {
        if (c.command.startsWith("parameters.")) return [];
        if (c.command === "timeline.add") return [c]; // a replayed import is already a script step
        // Every other modeling step as the real export writes a feature: `timeline.add {feature}`.
        // The real feature objects are the kernel's own; the fake's are `{type: "fake", id, params}`
        // (the same shape test/fixtures/fake-solidcraft-eval.ts replays).
        if (c.command !== "file.insert_step") return [{ command: "timeline.add", params: { feature: { id: c.command, params: c.params, type: "fake" } } }];
        // As the real tool writes an import: the STEP text embedded, no path.
        const f = m.timeline.find((x) => x.log === idx);
        const stem = basename(String(c.params.file), extname(String(c.params.file)));
        return [{ command: "timeline.add", params: { feature: { body_names: m.bodies.filter((b) => f && b.feature === f.id).map((b) => b.name), file: c.params.file, id: f?.id, name: c.params.name ?? stem, step: c.params.step, type: "import" } } }];
      }),
    ],
  };
}

const COMMANDS: { id: string; label: string; params: string }[] = [
  { id: "parameters.add", label: "Add User Parameter", params: "name, expression: e.g. \"80 mm\", unit?" },
  { id: "parameters.change", label: "Change Parameters", params: "name, expression" },
  { id: "sketch.create", label: "Create Sketch", params: "plane: XY, name?, offset?: expr" },
  { id: "sketch.rectangle.center", label: "Center Rectangle", params: "center: [x,y], corner: [x,y]" },
  { id: "sketch.draw.dimensioned", label: "Draw Dimensioned", params: "command: sketch.rectangle.center, params, dimensions: {width, height}" },
  { id: "sketch.point", label: "Point", params: "point: [x,y]" },
  { id: "sketch.dimension", label: "Dimension", params: "entities: [origin, point id], type: horizontal|vertical, value: expr" },
  { id: "sketch.finish", label: "Finish Sketch", params: "" },
  { id: "solid.extrude", label: "Extrude", params: "distance: expr, sketch?, name?, body_name?" },
  { id: "solid.box", label: "Box", params: "length, width, height: expr; corner?: [x,y,z] | center?: [x,y,z]; name?, body_name?" },
  { id: "solid.cylinder", label: "Cylinder", params: "radius | diameter, height: expr; base?: [x,y,z]; axis?: Z; operation?, targets?: [body], name?, body_name?" },
  { id: "solid.fillet", label: "Fillet", params: "edges: [[x,y,z]…], radius: expr, name?" },
  { id: "solid.hole", label: "Hole", params: "position: [x,y,z] | sketch + points?; diameter; depth? (default through all); type?: simple|drilled|counterbore; cb_diameter?, cb_depth?; targets?: [body], name?" },
  { id: "solid.pattern.rectangular", label: "Rectangular Pattern", params: "features: [names], dir1, count1, spacing1, dir2?, count2?, spacing2?, name?" },
  { id: "file.insert_step", label: "Insert STEP", params: "path; STEP import: brings the file's solids in as a fixed reference body" },
  { id: "timeline.delete", label: "Delete", params: "feature: id or name" },
  { id: "inspect.interference", label: "Interference", params: "bodies?: [names] → interferences: pairs that overlap" },
  { id: "inspect.measure", label: "Measure", params: "bodies?: name | [names] (default: all) → the same reply as the measure tool" },
  { id: "view.pick", label: "Pick", params: "rays: [{origin: [x,y,z], dir: [x,y,z]}] (max 1024), all?: bool → hits: per ray [{body, depth, face, normal, point}], nearest first" },
  { id: "component.list", label: "List Components", params: "compact?, bodies? → components: the design (id 0) and its child components, each with its placements (transform, grounded)" },
  { id: "timeline.export_script", label: "Export Script", params: "path?: write the script to this file → script: {commands: [...]} that rebuilds the design" },
];
const LABELS: Record<string, string> = Object.fromEntries(COMMANDS.map((c) => [c.id, c.label]));
const isKnown = (id: string) => COMMANDS.some((c) => c.id === id);

function crashIf(id: string): void {
  if (CRASH_ON && CRASH_ON === id) {
    process.stderr.write(`fake-solidcraft: simulated crash on ${id} (segmentation fault)\n`);
    process.exit(139);
  }
}

/** Run one command against the session. Mutating commands are validated by a full rebuild first. */
function execute(command: string, params: Json, verbose: boolean): Json {
  crashIf(command);
  // A replayed design-script step (what `timeline.export_script` writes and the daemon now loads
  // with `batch`): `timeline.add {feature}`. As in the real tool, a replayed feature that fails to
  // compute is RECORDED with its error and the step succeeds; only a step that cannot run at all
  // (an unknown command, a malformed feature) fails the batch.
  if (command === "timeline.add") {
    const f = params.feature as Json | undefined;
    let inner: Cmd;
    if (f?.type === "fake" && typeof f.id === "string" && f.id !== "timeline.add") {
      crashIf(f.id);
      if (!isKnown(f.id)) throw new UnknownCommand(`unknown command \`${f.id}\``);
      inner = { command: f.id, params: (f.params ?? {}) as Json };
    } else if (f?.type === "import" && typeof f.step === "string") {
      inner = { command, params };
    } else {
      throw new UnknownCommand("invalid parameters for `timeline.add`: invalid feature: unknown variant (fake-solidcraft replays only its own `fake` features and imports)");
    }
    const next = build([...log, inner], log.length + 1); // history, not a new feature: failures are recorded
    log.push(inner);
    redo = [];
    model = next;
    revision++;
    const last = next.timeline[next.timeline.length - 1];
    const r = { ...next.results[next.results.length - 1]! };
    if (!verbose && "feature" in r) delete r.bodies;
    return last && last.log === log.length - 1 ? { error: (last as Json).error ?? null, feature: last.id, name: last.name, warning: last.warning ?? null, ...r } : r;
  }
  if (!isKnown(command)) throw new ToolError(`unknown command \`${command}\``);
  const ro = READ_ONLY[command];
  if (ro) return ro(model, params);
  if (command === "timeline.delete") {
    const key = params.feature ?? params.features;
    const f = model.timeline.find((x) => x.id === key || x.name === key);
    if (!f || f.log === undefined) throw new ToolError(`invalid parameters for \`timeline.delete\`: no feature \`${key}\``);
    const next = log.filter((_, i) => i !== f.log);
    model = build(next);
    log = next;
    redo = [];
    revision++;
    return { deleted: [f.id] };
  }
  if (command === "file.insert_step") {
    // The STEP text is read ONCE and travels in the command from here on (and in the script).
    const path = readablePath(params.path, command);
    params = { ...params, file: basename(path), step: readFileSync(path, "utf8") };
  }
  const next = build([...log, { command, params }], log.length);
  log.push({ command, params });
  redo = [];
  model = next;
  revision++;
  const result = { ...next.results[next.results.length - 1]! };
  if (!verbose && "feature" in result) delete result.bodies;
  return result;
}
const setParameter = (a: Json, verbose: boolean): Json => {
  if (typeof a.name !== "string") throw new RpcError(-32602, "set_parameter: missing required argument `name`");
  const expression = a.value ?? a.expression;
  if (expression === undefined) throw new ToolError("set_parameter: give `value` or `expression`");
  return execute("parameters.change", { name: a.name, expression: fmtParam(expression), ...(a.unit !== undefined ? { unit: a.unit } : {}) }, verbose);
};

/** Read a saved design or an exported script and return its commands (after the format check). */
function loadCommands(path: string): { name: string; commands: Cmd[]; newer?: Json } {
  let doc: Json;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ToolError(`${path}: design file: ${e instanceof Error ? e.message : String(e)}`);
  }
  const commands: unknown = Array.isArray(doc) ? doc : doc.commands;
  if (!Array.isArray(commands)) throw new ToolError(`${path}: design file: missing field \`commands\``);
  const format = Number(/(\d+)$/.exec(String(doc.format ?? doc.about?.format ?? ""))?.[1] ?? FORMAT);
  let newer: Json | undefined;
  if (format > FORMAT) {
    if (!NEWER_WARNS) throw new ToolError(`${path}: this design was saved by a newer SolidCraft (format ${format}, this version reads up to ${FORMAT})`);
    const notice = `Saved by a newer SolidCraft (format ${format}, this version reads up to ${FORMAT}). If something's missing, update.`;
    newer = { format, not_understood: [], notice, reads_up_to: FORMAT, unknown_changes: [] };
  }
  // A script's `timeline.add {feature: {type: "fake"}}` step is the fake's own command, wrapped.
  const unwrapped = (commands as Cmd[]).map((c) => {
    const f = c?.command === "timeline.add" ? (c.params?.feature as Json | undefined) : undefined;
    return f?.type === "fake" && typeof f.id === "string" ? { command: f.id, params: (f.params ?? {}) as Json } : c;
  });
  return { name: String(doc.name ?? doc.about?.design ?? basename(path, extname(path))), commands: unwrapped, newer };
}
function openDesign(path: string): Json {
  const { commands, newer } = loadCommands(path);
  const next = build(commands);
  log = commands.map((c) => ({ command: c.command, params: c.params ?? {} }));
  redo = [];
  model = next;
  designName = basename(path, extname(path));
  designPath = path;
  revision++;
  return { errors: 0, features: next.timeline.length, name: designName, path, ...(newer ? { newer_file: newer, warnings: [newer.notice] } : {}) };
}

function batch(a: Json): Json {
  let steps: Cmd[];
  if (typeof a.path === "string") steps = loadCommands(readablePath(a.path, "batch")).commands;
  else if (Array.isArray(a.commands)) steps = a.commands;
  else throw new RpcError(-32602, "batch: missing required argument `commands`");
  const STEP_TOOLS = ["measure", "set_parameter", "save"];
  const failed = (index: number, error: string, completed: number, note?: string) => {
    throw new ToolError(
      JSON.stringify({
        applied: [], completed, failed: { command: steps[index]!.command, error, index },
        not_run: steps.map((_, i) => i).filter((i) => (note ? true : i > index)), ...(note ? { note } : {}),
        ok: false, results: [], rolled_back: true, undone: completed,
      }),
    );
  };
  const unknown = steps.findIndex((s) => !isKnown(s.command) && s.command !== "timeline.add" && !STEP_TOOLS.includes(s.command));
  if (unknown >= 0) failed(unknown, `unknown command \`${steps[unknown]!.command}\``, 0, "nothing was run: the batch was checked before its first step");
  const before = { log: [...log], redo: [...redo], model, revision };
  const results: Json[] = [];
  steps.forEach((s, i) => {
    try {
      const p = s.params ?? {};
      if (s.command === "measure") results.push(measure(model, p));
      else if (s.command === "set_parameter") results.push(setParameter(p, a.verbose !== false));
      else if (s.command === "save") results.push(save(p));
      else results.push(execute(s.command, p, a.verbose !== false));
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      ({ log, redo, model, revision } = before);
      failed(i, e.message, i);
    }
  });
  return { completed: steps.length, ok: true, results };
}

function save(a: Json): Json {
  const path = a.path === undefined ? designPath : allowedPath(a.path, "save");
  if (!path) throw new ToolError("save: the design has no file yet; give `path`");
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify({ format: `solidcraft/${FORMAT}`, name: basename(path, extname(path)), units: "mm", version: VERSION, commands: log }, null, 2) + "\n";
  writeFileSync(path, text);
  designPath = path;
  designName = basename(path, extname(path));
  return { bytes: Buffer.byteLength(text), name: designName, path };
}

function inspectDesign(a: Json): Json {
  return {
    active_sketch: model.activeSketch?.id ?? null,
    ...(a.bodies === false
      ? {}
      : {
          bodies:
            a.bodies === "names"
              ? model.bodies.map((b) => b.name)
              : a.measure === false
                ? model.bodies.map((b) => ({ feature: b.feature, name: b.name, visible: true }))
                : model.bodies.map((b) => ({ ...measureBody(b, false), visible: true })),
        }),
    dirty: revision > 0,
    hidden_origin: [],
    marker: model.timeline.length,
    metadata: {},
    name: designName,
    params: model.params.map((q) => ({ comment: "", error: null, expression: q.expression, model: false, name: q.name, unit: q.unit, value: q.value })),
    path: designPath,
    redo: redo.length,
    revision,
    selection: [],
    sketches: a.sketches === false ? [] : model.sketches.map((s) => ({ id: s.id, name: s.name, plane: { origin: [0, 0, s.z], x_dir: [1, 0, 0], y_dir: [0, 1, 0] }, points: s.points.length + 1, profiles: s.rect ? 1 : 0, status: "solved", visible: false, wires_ok: true })),
    ...(a.timeline === false
      ? {}
      : {
          timeline: model.timeline.map((f) =>
            a.timeline === "summary"
              ? { ...(f.error ? { error: f.error } : {}), id: f.id, name: f.name, type: f.type, ...(f.warning ? { warning: f.warning } : {}) }
              : { error: f.error ?? null, id: f.id, ms: 0.1, name: f.name, rolled_back: false, suppressed: false, type: f.type, warning: f.warning },
          ),
        }),
    undo: log.length,
    units: "mm",
  };
}

const SKILL = `# SolidCraft command reference for agents (fake-solidcraft excerpt)

- Lengths are in mm. Any numeric field can be an expression that names parameters: "L/2 - inset".
- Name every feature. Build in a few \`batch\` calls, then \`measure\`.

## Worked example: the reference plate (23335.2 mm³; 35335.2 mm³ at L = 120; 22 faces)

parameters.add L=80 mm, W=50 mm, T=6 mm, inset=8 mm → sketch.create PlateSketch →
sketch.draw.dimensioned sketch.rectangle.center {width: L, height: W} → sketch.finish →
solid.extrude {distance: T, name: Plate} → solid.fillet {4 corner edges, radius: 5, name: Corners} →
sketch.create HolePts {offset: T} → sketch.point [32,17] → sketch.dimension horizontal "L/2 - inset",
vertical "W/2 - inset" → sketch.finish → solid.hole {sketch: HolePts, diameter: 3.4, type: counterbore,
cb_diameter: 6.5, cb_depth: 3.3, name: Hole} → solid.pattern.rectangular {features: [Hole], 2 × 2,
spacing1: "L - 2*inset", spacing2: "W - 2*inset", name: Holes}
`;

const need = (tool: string, a: Json, key: string) => {
  if (a[key] === undefined) throw new RpcError(-32602, `${tool}: missing required argument \`${key}\``);
};

/** A tool's reply: a JSON value (serialised into one text block) or ready-made content blocks. */
type Reply = Json | { content: Json[] };
const TOOLS: Record<string, { description: string; readOnly: boolean; required?: string[]; run: (a: Json) => Reply }> = {
  version: { description: "The SolidCraft build answering this session: {version, commit, mode}.", readOnly: true, run: () => ({ commit: "fake", mode: "headless", version: VERSION }) },
  list_commands: {
    description: "Command ids with one-line parameter docs. Takes filter, prefix, compact, fields, limit, offset.",
    readOnly: true,
    run: (a) => {
      let list: Json[] = COMMANDS.filter((c) => (!a.filter || [c.id, c.label, c.params].some((t) => t.toLowerCase().includes(String(a.filter).toLowerCase()))) && (!a.prefix || c.id.toLowerCase().startsWith(String(a.prefix).toLowerCase()))).map((c) => ({
        disabled_reason: null, enabled: true, icon: c.id.split(".").pop(), id: c.id, label: c.label, panel: "", params: c.params, shortcut: null, tab: "",
      }));
      if (Array.isArray(a.fields)) list = list.map((c) => Object.fromEntries(a.fields.map((k: string) => [k, c[k]])));
      else if (a.compact) list = list.map((c) => ({ id: c.id, label: c.label }));
      if (a.limit === undefined && a.offset === undefined) return list;
      const offset = Number(a.offset ?? 0);
      const page = list.slice(offset, a.limit === undefined ? undefined : offset + Number(a.limit));
      return { commands: page, next_offset: offset + page.length < list.length ? offset + page.length : null, offset, total: list.length };
    },
  },
  describe_command: {
    description: "One command's documentation and schemas.",
    readOnly: true,
    required: ["id"],
    run: (a) => {
      const c = COMMANDS.find((x) => x.id === a.id);
      if (!c) throw new ToolError(`unknown command \`${a.id}\``);
      return { id: c.id, input: { $schema: "https://json-schema.org/draft/2020-12/schema", description: `${c.label}. ${c.params}`, type: "object" }, label: c.label, params: c.params };
    },
  },
  execute: { description: "Run one command: {command, params?, verbose?}.", readOnly: false, required: ["command"], run: (a) => execute(String(a.command), a.params ?? {}, a.verbose !== false) },
  batch: { description: "Run steps in order, all or nothing: {commands: [{command, params}], verbose?} or {path}.", readOnly: false, run: batch },
  inspect_design: { description: "The design: parameters, bodies, sketches, timeline. Takes measure: false, sketches: false.", readOnly: true, run: inspectDesign },
  measure: { description: "Volume, bounding box and face count of every body (or `body`); summary: true for the short form.", readOnly: true, run: (a) => measure(model, a) },
  body_topology: { description: "A body's faces; faces: \"cylinders\" lists only the cylindrical faces with their axis extent.", readOnly: true, required: ["body"], run: (a) => topology(model, a) },
  set_parameter: { description: "Set a parameter: {name, value | expression}.", readOnly: false, required: ["name"], run: (a) => setParameter(a, true) },
  check_parameters: {
    description: "Try parameter values without keeping them: {set: {name: value}, summary?}.",
    readOnly: true,
    required: ["set"],
    run: (a) => {
      const changes = Object.entries(a.set as Json).map(([name, v]) => ({ command: "parameters.change", params: { name, expression: fmtParam(v) } }));
      const trial = build([...log, ...changes]);
      const report: string[] = Array.isArray(a.report) ? a.report : ["measure", "cylinders", "errors"];
      return {
        ...(report.includes("cylinders") ? { cylinders: trial.bodies.flatMap((b) => cylinders(b).map((c) => ({ axis: c.axis, body: b.name, name: c.names[0], origin: c.origin, radius: c.radius }))) } : {}),
        ...(report.includes("errors") ? { errors: [] } : {}),
        ...(report.includes("measure") ? { measure: measure(trial, { summary: a.summary === true }) } : {}),
        parameter_errors: [], recomputed: trial.timeline.length, restored: true, set: a.set,
        values: Object.fromEntries(Object.keys(a.set).map((n) => [n, trial.params.find((q) => q.name === n)!.value])), warnings: [],
      };
    },
  },
  screenshot: {
    description: "A PNG of the model: {width?, height?, path?}.",
    readOnly: true,
    run: (a) => {
      const [width, height] = [Math.min(Number(a.width ?? 16), 64), Math.min(Number(a.height ?? 16), 64)];
      const shades: Record<string, number> = { iso: 0xc0, front: 0x80, top: 0x60, right: 0xa0 };
      const bytes = png(width, height, shades[String(a.view ?? "iso")] ?? 0xc0);
      const path = a.path === undefined ? null : allowedPath(a.path, "screenshot");
      if (path) writeFileSync(path, bytes);
      return {
        content: [
          { data: bytes.toString("base64"), mimeType: "image/png", type: "image" },
          { text: JSON.stringify({ bytes: bytes.length, height, path, renderer: "fake", source: a.source ?? "model", width }), type: "text" },
        ],
      };
    },
  },
  export: {
    description: "Write the bodies to a file: {path, format?: step|stp|3mf|stl|stla|glb, bodies?: [names]} (default: from the extension).",
    readOnly: true,
    required: ["path"],
    run: (a) => {
      const path = allowedPath(a.path, "export");
      const label = EXPORTS[String(a.format ?? extname(path).slice(1)).toLowerCase()];
      if (!label) throw new ToolError(`${path}: fake-solidcraft does not write format \`${a.format ?? extname(path).slice(1)}\``);
      if (model.bodies.length === 0) throw new ToolError("nothing to export: the design has no bodies");
      // `bodies` (names) limits the export, as the real tool does; an unknown name is the same error.
      let source = model;
      if (Array.isArray(a.bodies)) {
        const wanted = new Set(a.bodies.map(String));
        const picked = model.bodies.filter((b) => wanted.has(b.name));
        if (picked.length !== wanted.size || picked.length === 0) throw new ToolError("nothing to export: the design has no bodies");
        source = { ...model, bodies: picked };
      }
      const bytes = exportBytes(source, label, basename(path));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      return { bytes: bytes.length, format: label, path };
    },
  },
  compare_picture: {
    description: "Overlay the model's outline on a reference picture: {reference, view?}.",
    readOnly: true,
    required: ["reference"],
    run: (a) => {
      const ref = readablePath(a.reference, "compare_picture");
      const bytes = png(16, 16, 0x40);
      return {
        content: [
          { data: bytes.toString("base64"), mimeType: "image/png", type: "image" },
          { text: JSON.stringify({ aspect_mismatch: 0.99, edges: {}, fit: "width", mm_per_px: { x: 0.5, y: 0.5 }, model: { bodies: model.bodies.length }, overlap: OVERLAP, picture: { source: ref }, stations: 9 }), type: "text" },
        ],
      };
    },
  },
  undo: {
    description: "Undo the last change.",
    readOnly: false,
    run: () => {
      const last = log[log.length - 1];
      if (!last) throw new ToolError("nothing to undo");
      model = build(log.slice(0, -1));
      redo.push(log.pop()!);
      revision++;
      return { undone: LABELS[last.command] ?? last.command };
    },
  },
  redo: {
    description: "Redo the last undone change.",
    readOnly: false,
    run: () => {
      const next = redo[redo.length - 1];
      if (!next) throw new ToolError("nothing to redo");
      model = build([...log, next]);
      log.push(redo.pop()!);
      revision++;
      return { redone: LABELS[next.command] ?? next.command };
    },
  },
  new_design: {
    description: "Start an empty design: {name?}.",
    readOnly: false,
    run: (a) => {
      designName = typeof a.name === "string" && a.name ? a.name : "Untitled";
      designPath = null;
      log = [];
      redo = [];
      model = build([]);
      revision = 0;
      return { name: designName };
    },
  },
  open: { description: "Open a saved design (.sc/.json) or replay an exported script: {path}.", readOnly: false, required: ["path"], run: (a) => openDesign(readablePath(a.path, "open")) },
  save: { description: "Save the design: {path?}.", readOnly: false, run: save },
  skill_reference: {
    description: "A skill document: {skill, file?}.",
    readOnly: true,
    required: ["skill"],
    run: (a) => {
      if (a.skill !== "solidcraft-modeling") throw new ToolError("Unknown skill. Available skills: solidcraft-modeling");
      return { content: [{ text: SKILL, type: "text" }] };
    },
  },
};

// ── MCP over stdio ──────────────────────────────────────────────────────────────────────────────
const send = (msg: Json): void => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

async function handle(msg: Json): Promise<void> {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // a notification (notifications/initialized, …): no reply
  const fail = (code: number, message: string) => send({ error: { code, message }, id, jsonrpc: "2.0" });
  switch (method) {
    case "initialize":
      return void send({
        id,
        jsonrpc: "2.0",
        result: {
          capabilities: { resources: { listChanged: false }, tools: { listChanged: false } },
          instructions: "fake-solidcraft: a deterministic stand-in for `solidcraft-cli mcp`. Units are millimetres, Z is up.",
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          serverInfo: { name: "solidcraft", title: "SolidCraft", version: VERSION },
        },
      });
    case "ping":
      return void send({ id, jsonrpc: "2.0", result: {} });
    case "tools/list":
      return void send({
        id,
        jsonrpc: "2.0",
        result: {
          tools: Object.entries(TOOLS).map(([name, t]) => ({
            annotations: { readOnlyHint: t.readOnly },
            description: t.description,
            inputSchema: { properties: {}, type: "object", ...(t.required ? { required: t.required } : {}) },
            name,
          })),
        },
      });
    case "tools/call": {
      const name = String(params?.name ?? "");
      const tool = TOOLS[name];
      if (!tool) return fail(-32602, `unknown tool \`${name}\``);
      const args: Json = params?.arguments ?? {};
      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
      if (HANG_ON && (HANG_ON === name || (name === "execute" && HANG_ON === args.command))) await new Promise(() => {});
      try {
        for (const key of tool.required ?? []) need(name, args, key);
        crashIf(name);
        const out = tool.run(args);
        const content = !Array.isArray(out) && Array.isArray((out as Json).content) ? (out as Json).content : [{ text: JSON.stringify(out), type: "text" }];
        return void send({ id, jsonrpc: "2.0", result: { content } });
      } catch (e) {
        if (e instanceof RpcError) return fail(e.code, e.message);
        if (e instanceof ToolError) return void send({ id, jsonrpc: "2.0", result: { content: [{ text: e.message, type: "text" }], isError: true } });
        throw e;
      }
    }
    default:
      return fail(-32601, `method \`${method}\` not found`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version") {
    console.log(`solidcraft-cli ${VERSION}`);
    return;
  }
  const replayExit = fakeReplayEntry(argv, { version: VERSION, volumeScale: VOLUME_SCALE, build, bboxOf });
  if (replayExit) return void process.exit(await replayExit);
  if (argv[0] !== "mcp") {
    process.stderr.write("usage: fake-solidcraft mcp [--headless] [--compact] [--allow-path DIR]... [--require-allow-path] [--in design.sc|script.json]\n");
    process.exit(2);
  }
  let inFile: string | undefined;
  let requireAllow = false;
  const allowArgs: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--allow-path") {
      allowArgs.push(argv[++i] ?? "");
      allowed.push(real(allowArgs[allowArgs.length - 1]!));
    } else if (a === "--require-allow-path") requireAllow = true;
    else if (a === "--in") inFile = argv[++i];
    else if (a === "--headless" || a === "--compact") continue;
    else {
      process.stderr.write(`fake-solidcraft: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  if (requireAllow && allowArgs.every((d) => !d || !existsSync(d))) {
    process.stderr.write(`error: none of the --allow-path folders exist (${allowArgs.join(", ") || "none given"})\n`);
    process.exit(1);
  }
  process.stderr.write(`solidcraft mcp: files limited to ${allowed.join(", ") || "(nothing)"} (--allow-path DIR adds one)\n`);
  if (inFile) {
    try {
      openDesign(readablePath(inFile, "--in"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const step = e instanceof ToolError && e.step !== undefined ? `step ${e.step + 1} (${e.command}): ` : "";
      process.stderr.write(`error: ${step}${msg}\n`);
      process.exit(1);
    }
  }
  // One message per line, handled strictly in order: a reply is written before the next is read.
  for await (const line of console) {
    if (!line.trim()) continue;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ error: { code: -32700, message: "parse error" }, id: null, jsonrpc: "2.0" });
      continue;
    }
    await handle(msg);
  }
}

await main();
