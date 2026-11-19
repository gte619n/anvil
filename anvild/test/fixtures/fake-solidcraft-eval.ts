/**
 * The replay side of the fake SolidCraft (test/fixtures/fake-solidcraft.ts), kept in its own file
 * so the main fake changes by one import and one dispatch line. Two entry points:
 *
 *   fake-solidcraft eval <script.json> [--json-out FILE]
 *   fake-solidcraft mcp --headless --compact --allow-path DIR --require-allow-path [--in FILE]
 *       (this MCP server is used only when FAKE_SC_TABLE is set; otherwise the main fake serves)
 *
 * Both replay an exported DESIGN SCRIPT — the format the real `timeline.export_script` writes:
 * `parameters.add` steps, then one `timeline.add` step per feature. The real feature objects are
 * the kernel's own; the fake's are `{ type: "fake", id: "<fake command id>", params: {...} }`, which
 * it replays with the main fake's model builder. The other ids a real script can carry
 * (`document.units`, `material.assign`, `component.create`, …) are accepted and do nothing.
 *
 * `eval` prints the JSON the real `solidcraft-cli eval` prints and follows its exit codes: 0 on
 * success AND when a feature fails to compute (`timeline[].error` set, later features still run),
 * 1 for a malformed step or an unreadable file.
 *
 * `mcp` serves what the replay gate calls: `initialize`, `ping`, and the tools `version`, `batch`,
 * `measure`, `inspect_design`. Like the real server it keeps the `--allow-path` sandbox for tool
 * calls: a `batch` step that names a file outside the allowed folders is refused and the batch is
 * rolled back. And like the real 0.44.1 it does NOT keep it for a script loaded with `--in` or run
 * by `eval`: there, a file-writing step writes wherever it points. The file-writing steps modelled
 * are `parameters.export`, `file.save`, `file.export_step`, `timeline.export_script` (each writes
 * `path`) and `doc.open` (reads `path`).
 *
 * PER-VERSION BEHAVIOUR TABLE. `FAKE_SC_TABLE` names a JSON file `{ "<version>": Behaviour }`; the
 * entry for this process's `FAKE_SC_VERSION` applies. That is how a test makes two "builds" differ.
 * A `parts` map narrows a behaviour to scripts whose `about.design` matches (for `mcp`, where a
 * batch carries no `about`, the design name is the file name of the one `*.json` in the allowed
 * folder's `about.design`). The file is read on every run, so a test may change it between runs.
 *
 *   volumeScale   multiplies every volume (on top of FAKE_SC_VOLUME_SCALE) — kernel drift
 *   facesDelta    added to every body's face count
 *   edgesDelta    added to every body's edge count (ignored by the replay gate)
 *   areaScale     multiplies every area (ignored by the replay gate)
 *   bboxGrow      added to every body's bbox max, in mm
 *   holeShift     [dx, dy] added to the `position` of every hole: the same volume, faces and box,
 *                 but the hole is somewhere else (only the centre of mass shows it)
 *   extraBody     adds a second body
 *   failFeature   a feature name or fake command id that fails to compute (a timeline error)
 *   paramError    a parameter name whose `params[].error` is set
 *   crash         the process dies (exit 139) with one stderr line while replaying
 *   exit          `eval` only: exit with this code after printing `error: …`
 *   delayMs       wait before replaying (a slow or hung kernel)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type Json = Record<string, any>;
interface Cmd {
  command: string;
  params: Json;
}
export interface FakeEvalBehaviour {
  volumeScale?: number;
  facesDelta?: number;
  edgesDelta?: number;
  areaScale?: number;
  bboxGrow?: number;
  holeShift?: [number, number];
  extraBody?: boolean;
  failFeature?: string;
  paramError?: string;
  crash?: boolean;
  exit?: number;
  delayMs?: number;
  parts?: Record<string, FakeEvalBehaviour>;
}
export type FakeEvalTable = Record<string, FakeEvalBehaviour>;

/** What the main fake lends: its version, its volume scale, and its model builder. */
export interface FakeEvalHost {
  version: string;
  volumeScale: number;
  /** `strictFrom` (Track A's builder): commands from that index on are being ADDED and throw on failure;
   *  earlier ones are history, whose failures are recorded on the timeline instead. */
  build: (log: readonly Cmd[], strictFrom?: number) => { params: Json[]; sketches: Json[]; timeline: Json[]; bodies: Json[] };
  bboxOf: (body: any) => { min: number[]; max: number[] };
}

/** Errors the real tool reports as a bad STEP rather than a feature that failed to compute. */
const STEP_ERROR = /^(invalid parameters|unknown command|expression:|there is already|set_parameter)/;
/** Real script steps that carry no geometry in the fake. */
const NO_OPS = new Set(["document.units", "document.metadata.set", "material.create", "material.assign", "component.create", "component.metadata.set", "occurrence.ground", "occurrence.move"]);
/** Steps that write (or read) the file named by `params.path`. */
const FILE_STEPS = new Set(["parameters.export", "file.save", "file.export_step", "timeline.export_script", "doc.open"]);

function behaviourFor(version: string, design: string): FakeEvalBehaviour {
  const file = process.env.FAKE_SC_TABLE;
  if (!file || !existsSync(file)) return {};
  const table = JSON.parse(readFileSync(file, "utf8")) as FakeEvalTable;
  const { parts, ...base } = table[version] ?? {};
  return { ...base, ...(parts?.[design] ?? {}) };
}

class StepError extends Error {
  constructor(
    readonly index: number,
    readonly command: string,
    message: string,
  ) {
    super(message);
  }
}

interface Replayed {
  model: ReturnType<FakeEvalHost["build"]>;
  failed: { after: number; name: string; type: string; error: string }[];
  results: Json[];
}

/**
 * Replay a design script's steps. `fileStep` decides what a file-writing step does (the sandbox
 * check lives there). A malformed step throws `StepError`; a feature that cannot be computed is
 * recorded and skipped.
 */
function replay(commands: Cmd[], host: FakeEvalHost, b: FakeEvalBehaviour, fileStep: (cmd: Cmd) => void): Replayed {
  const applied: Cmd[] = [];
  const failed: Replayed["failed"] = [];
  const results: Json[] = [];
  for (const [i, raw] of commands.entries()) {
    const outer: Cmd = { command: String(raw?.command ?? ""), params: raw?.params ?? {} };
    try {
      if (NO_OPS.has(outer.command)) {
        results.push({});
        continue;
      }
      if (FILE_STEPS.has(outer.command)) {
        fileStep(outer);
        results.push({ path: outer.params.path ?? null });
        continue;
      }
      let cmd = outer;
      if (outer.command === "timeline.add") {
        const f = outer.params.feature;
        if (!f || f.type !== "fake" || typeof f.id !== "string") throw new Error("invalid parameters for `timeline.add`: invalid feature: unknown variant (fake-solidcraft replays only its own `fake` features)");
        cmd = { command: f.id, params: { ...(f.params ?? {}) } };
      } else if (outer.command !== "parameters.add") {
        throw new Error(`unknown command \`${outer.command}\``);
      }
      if (cmd.command === "solid.hole" && b.holeShift && Array.isArray(cmd.params.position)) {
        cmd.params.position = [cmd.params.position[0] + b.holeShift[0], cmd.params.position[1] + b.holeShift[1], cmd.params.position[2]];
      }
      const name = typeof cmd.params.name === "string" ? cmd.params.name : cmd.command;
      const isFeature = cmd.command.startsWith("solid.");
      if (isFeature && b.failFeature && (b.failFeature === cmd.command || b.failFeature === name)) {
        const error = `simulated: ${name} could not be computed by SolidCraft ${host.version}`;
        failed.push({ after: host.build(applied).timeline.length, name, type: cmd.command, error });
        results.push({ error, feature: null, name, warning: null });
        continue;
      }
      try {
        host.build([...applied, cmd], applied.length); // this step is being added: a failure throws
        applied.push(cmd);
        results.push(outer.command === "timeline.add" ? { error: null, feature: applied.length, name, warning: null } : { name: cmd.params.name });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!isFeature || STEP_ERROR.test(msg)) throw e;
        failed.push({ after: host.build(applied).timeline.length, name, type: cmd.command, error: msg });
        results.push({ error: msg, feature: null, name, warning: null });
      }
    } catch (e) {
      throw new StepError(i, outer.command, e instanceof Error ? e.message : String(e));
    }
  }
  return { model: host.build(applied), failed, results };
}

function bodiesOf(r: Replayed, host: FakeEvalHost, b: FakeEvalBehaviour): Json[] {
  const scale = host.volumeScale * (b.volumeScale ?? 1);
  const bodies: Json[] = r.model.bodies.map((body) => {
    const bbox = host.bboxOf(body);
    const faces: Json[] = body.faces;
    const cyl = faces.filter((f) => f.cylinder).length;
    // The fake has no mass model; the area-weighted centroid of the faces moves when a hole moves,
    // which is all the centre of mass is needed for here.
    const area = faces.reduce((s, f) => s + Math.max(0, Number(f.area) || 0), 0) || 1;
    const com = [0, 1, 2].map((k) => faces.reduce((s, f) => s + Math.max(0, Number(f.area) || 0) * (f.centroid?.[k] ?? 0), 0) / area);
    return {
      area_mm2: faces.reduce((s, f) => s + (Number(f.area) || 0), 0) * (b.areaScale ?? 1),
      bbox: { max: bbox.max.map((v) => v + (b.bboxGrow ?? 0)), min: bbox.min },
      center_of_mass: com,
      closed: true,
      edges: faces.length * 2 + (b.edgesDelta ?? 0),
      face_types: { ...(cyl ? { cylinder: cyl } : {}), plane: faces.length - cyl },
      faces: faces.length + (b.facesDelta ?? 0),
      kernel: { name: "fake", version: host.version },
      name: body.name,
      vertices: faces.length + 10,
      volume_mm3: body.volume * scale,
    };
  });
  if (b.extraBody) bodies.push({ ...bodies[0], name: "Extra", volume_mm3: 1 });
  return bodies;
}
function timelineOf(r: Replayed, summary: boolean): Json[] {
  const full = (f: Json): Json => ({ error: null, id: f.id, ms: Math.random() * 10, name: f.name, rolled_back: false, suppressed: false, type: f.type, warning: f.warning ?? null });
  const timeline: Json[] = r.model.timeline.map((f) => (summary ? { id: f.id, name: f.name, type: f.type, ...(f.warning ? { warning: f.warning } : {}) } : full(f)));
  for (const f of [...r.failed].reverse()) {
    timeline.splice(f.after, 0, summary ? { error: f.error, id: 1000 + f.after, name: f.name, type: f.type } : { ...full({ id: 1000 + f.after, name: f.name, type: f.type }), error: f.error });
  }
  return timeline;
}
const paramsOf = (r: Replayed, b: FakeEvalBehaviour): Json[] =>
  r.model.params.map((q) => ({ comment: "", error: b.paramError === q.name ? `simulated: ${q.name} could not be evaluated` : null, expression: q.expression, model: false, name: q.name, unit: q.unit, value: q.value }));
function totals(bodies: Json[]): Json {
  return {
    area_mm2: bodies.reduce((s, x) => s + x.area_mm2, 0),
    edges: bodies.reduce((s, x) => s + x.edges, 0),
    faces: bodies.reduce((s, x) => s + x.faces, 0),
    open_bodies_skipped: 0,
    volume_mm3: bodies.reduce((s, x) => s + x.volume_mm3, 0),
  };
}

/** A file step with no sandbox at all — what `eval` and `mcp --in` do on the real 0.44.1. */
function unguardedFileStep(cmd: Cmd): void {
  const path = String(cmd.params.path ?? "");
  if (!path) return;
  if (cmd.command === "doc.open") return void readFileSync(path);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `written by fake-solidcraft ${cmd.command}\n`);
}

function readScript(file: string): { doc: Json; commands: Cmd[] } {
  const doc = JSON.parse(readFileSync(file, "utf8")) as Json;
  const commands: unknown = Array.isArray(doc) ? doc : doc?.commands;
  if (!Array.isArray(commands)) throw new Error("missing field `commands`");
  return { doc, commands: commands as Cmd[] };
}

// ── eval ────────────────────────────────────────────────────────────────────────────────────────

/** Run `eval`. Returns the exit code. */
export async function fakeEval(argv: string[], host: FakeEvalHost): Promise<number> {
  let file: string | undefined;
  let jsonOut: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json-out") jsonOut = argv[++i];
    else if (!file) file = argv[i];
  }
  const err = (line: string, code = 1): number => {
    process.stderr.write(`error: ${line}\n`);
    return code;
  };
  if (!file) return err("usage: eval <script.json> [--json-out FILE]", 2);
  let script: ReturnType<typeof readScript>;
  try {
    script = readScript(file);
  } catch (e) {
    return err(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const b = behaviourFor(host.version, String(script.doc?.about?.design ?? ""));
  if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
  if (b.crash) {
    process.stderr.write("fake-solidcraft: simulated crash in eval (segmentation fault)\n");
    return 139;
  }
  if (b.exit) return err(`${file}: simulated failure`, b.exit);
  let r: Replayed;
  try {
    r = replay(script.commands, host, b, unguardedFileStep);
  } catch (e) {
    if (e instanceof StepError) return err(`step ${e.index + 1} (${e.command}): ${e.message}`);
    throw e;
  }
  const bodies = bodiesOf(r, host, b);
  const out = { bodies, body_count: bodies.length, params: paramsOf(r, b), sketches: r.model.sketches.map((s) => ({ name: s.name, status: "solved" })), timeline: timelineOf(r, false), total: totals(bodies) };
  const text = JSON.stringify(out, null, 1);
  if (jsonOut) writeFileSync(jsonOut, text);
  process.stdout.write(`${text}\n`);
  return 0;
}

// ── mcp ─────────────────────────────────────────────────────────────────────────────────────────

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    // Not there yet: resolve the folder that is, as the real server does for a file to be written.
    try {
      return join(realpathSync(dirname(resolve(p))), basename(p));
    } catch {
      return resolve(p);
    }
  }
};

/** Serve the replay gate's MCP calls. Returns the exit code. */
export async function fakeReplayMcp(argv: string[], host: FakeEvalHost): Promise<number> {
  const allowed: string[] = [];
  let inFile: string | undefined;
  let requireAllow = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--allow-path") allowed.push(argv[++i] ?? "");
    else if (a === "--in") inFile = argv[++i];
    else if (a === "--require-allow-path") requireAllow = true;
    else if (a !== "--headless" && a !== "--compact") {
      process.stderr.write(`fake-solidcraft: unknown argument ${a}\n`);
      return 2;
    }
  }
  if (requireAllow && !allowed.some((d) => existsSync(d))) {
    process.stderr.write("error: none of the --allow-path folders exist\n");
    return 1;
  }
  const roots = allowed.filter((d) => existsSync(d)).map(real);
  process.stderr.write(`solidcraft mcp: files limited to ${roots.join(", ") || "(nothing)"} (--allow-path DIR adds one)\n`);
  /** The sandbox for TOOL CALLS: a path outside every allowed folder is refused and nothing is written. */
  const guardedFileStep = (cmd: Cmd): void => {
    const raw = String(cmd.params.path ?? "");
    if (!raw) return;
    const full = real(raw);
    if (!roots.some((d) => full === d || full.startsWith(`${d}/`))) {
      throw new Error(`${raw}: ${raw}: outside the folders this agent may use (${roots.join(", ")}); allow another folder with \`--allow-path DIR\``);
    }
    unguardedFileStep(cmd);
  };
  // The design a batch belongs to (for `parts` rows): the script copied into the allowed folder.
  const designName = (): string => {
    for (const d of roots) {
      for (const f of readdirSync(d).filter((n) => n.endsWith(".json"))) {
        try {
          const about = (JSON.parse(readFileSync(join(d, f), "utf8")) as Json)?.about;
          if (typeof about?.design === "string") return about.design;
        } catch {
          /* not a script */
        }
      }
    }
    return "";
  };

  let state: Replayed = { model: host.build([]), failed: [], results: [] };
  let b: FakeEvalBehaviour = {};
  if (inFile) {
    try {
      const script = readScript(inFile);
      b = behaviourFor(host.version, String(script.doc?.about?.design ?? ""));
      state = replay(script.commands, host, b, unguardedFileStep); // NOT sandboxed, as on the real build
    } catch (e) {
      process.stderr.write(`error: ${inFile}: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  const send = (msg: Json): void => void process.stdout.write(`${JSON.stringify(msg)}\n`);
  const tool = async (name: string, a: Json): Promise<{ json?: Json; error?: string }> => {
    switch (name) {
      case "version":
        return { json: { commit: "fake", mode: "headless", version: host.version } };
      case "batch": {
        if (!Array.isArray(a.commands)) throw new Error("batch: missing required argument `commands`");
        b = behaviourFor(host.version, designName());
        if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
        if (b.crash) {
          process.stderr.write("fake-solidcraft: simulated crash in batch (segmentation fault)\n");
          process.exit(139);
        }
        try {
          state = replay(a.commands as Cmd[], host, b, guardedFileStep);
        } catch (e) {
          if (!(e instanceof StepError)) throw e;
          state = { model: host.build([]), failed: [], results: [] }; // rolled back
          return { error: JSON.stringify({ applied: [], completed: e.index, failed: { command: e.command, error: e.message, index: e.index }, not_run: [], ok: false, results: [], rolled_back: true, undone: e.index }) };
        }
        return { json: { completed: state.results.length, ok: true, results: state.results } };
      }
      case "measure": {
        const bodies = bodiesOf(state, host, b);
        return { json: { bodies, body_count: bodies.length, total: totals(bodies) } };
      }
      case "inspect_design":
        return {
          json: {
            active_sketch: null,
            bodies: a.bodies === false ? [] : state.model.bodies.map((x) => ({ feature: x.feature, name: x.name, visible: true })),
            dirty: true,
            name: "Untitled",
            params: paramsOf(state, b),
            path: null,
            sketches: [],
            timeline: a.timeline === false ? [] : timelineOf(state, a.timeline === "summary"),
            units: "mm",
          },
        };
      default:
        return {};
    }
  };

  for await (const line of console) {
    if (!line.trim()) continue;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ error: { code: -32700, message: "parse error" }, id: null, jsonrpc: "2.0" });
      continue;
    }
    const { id, method, params } = msg;
    if (id === undefined) continue; // a notification
    if (method === "initialize") {
      send({ id, jsonrpc: "2.0", result: { capabilities: { tools: { listChanged: false } }, protocolVersion: "2025-06-18", serverInfo: { name: "solidcraft", title: "SolidCraft (fake)", version: host.version } } });
    } else if (method === "ping") {
      send({ id, jsonrpc: "2.0", result: {} });
    } else if (method === "tools/call") {
      try {
        const r = await tool(String(params?.name ?? ""), params?.arguments ?? {});
        if (r.error !== undefined) send({ id, jsonrpc: "2.0", result: { content: [{ text: r.error, type: "text" }], isError: true } });
        else if (r.json) send({ id, jsonrpc: "2.0", result: { content: [{ text: JSON.stringify(r.json), type: "text" }] } });
        else send({ error: { code: -32602, message: `unknown tool \`${params?.name}\`` }, id, jsonrpc: "2.0" });
      } catch (e) {
        send({ error: { code: -32602, message: e instanceof Error ? e.message : String(e) }, id, jsonrpc: "2.0" });
      }
    } else {
      send({ error: { code: -32601, message: `method \`${method}\` not found` }, id, jsonrpc: "2.0" });
    }
  }
  return 0;
}

/** The one entry point the main fake dispatches to. Returns undefined when the call is not for this file. */
export function fakeReplayEntry(argv: string[], host: FakeEvalHost): Promise<number> | undefined {
  if (argv[0] === "eval") return fakeEval(argv.slice(1), host);
  if (argv[0] === "mcp" && process.env.FAKE_SC_TABLE) return fakeReplayMcp(argv.slice(1), host);
  return undefined;
}
