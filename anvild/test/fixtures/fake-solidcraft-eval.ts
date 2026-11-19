/**
 * The `eval` subcommand of the fake SolidCraft (test/fixtures/fake-solidcraft.ts), kept in its own
 * file so the main fake changes by one import and one dispatch line.
 *
 *   fake-solidcraft eval <script.json> [--json-out FILE]
 *
 * It replays an exported script with the fake's own model builder and prints the JSON the real
 * `solidcraft-cli eval` prints (B0 evidence): `bodies[]`, `body_count`, `params[]`, `sketches[]`,
 * `timeline[]`, `total`. Exit codes follow the real tool:
 *
 *   0  success — AND ALSO when a feature fails to compute: that feature's `timeline[].error` is a
 *      string, later features still run, the geometry is wrong, stderr is empty;
 *   1  a step with invalid parameters / an unknown command (`error: step N (<command>): …`), or a
 *      file that is missing or not a script (`error: <path>: …`).
 *
 * PER-VERSION BEHAVIOUR TABLE. `FAKE_SC_TABLE` names a JSON file `{ "<version>": Behaviour }`; the
 * entry for this process's `FAKE_SC_VERSION` applies. That is how a test makes two "builds" differ.
 * A `parts` map narrows a behaviour to scripts whose `about.design` matches, so one part can differ
 * while the others do not. The file is read on every run, so a test may change it between runs.
 *
 *   volumeScale   multiplies every volume (on top of FAKE_SC_VOLUME_SCALE) — kernel drift
 *   facesDelta    added to every body's face count
 *   edgesDelta    added to every body's edge count (the real kernels disagree on edges for
 *                 identical geometry; the replay gate must ignore it)
 *   areaScale     multiplies every area (also ignored by the gate)
 *   bboxGrow      added to every body's bbox max, in mm
 *   extraBody     adds a second body
 *   failFeature   a feature name or command id that fails to compute: exit 0, `timeline[].error`
 *   paramError    a parameter name whose `params[].error` is set: exit 0
 *   crash         the process dies (exit 139) with one stderr line, writing no JSON
 *   exit          exit with this code after printing `error: …`
 *   delayMs       wait before answering (a slow or hung kernel)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
  build: (log: readonly Cmd[]) => { params: Json[]; sketches: Json[]; timeline: Json[]; bodies: Json[] };
  bboxOf: (body: any) => { min: number[]; max: number[] };
}

/** Errors the real tool reports as a bad STEP (exit 1) rather than a feature that failed to compute. */
const STEP_ERROR = /^(invalid parameters|unknown command|expression:|there is already|set_parameter)/;

function behaviourFor(version: string, design: string): FakeEvalBehaviour {
  const file = process.env.FAKE_SC_TABLE;
  if (!file || !existsSync(file)) return {};
  const table = JSON.parse(readFileSync(file, "utf8")) as FakeEvalTable;
  const { parts, ...base } = table[version] ?? {};
  return { ...base, ...(parts?.[design] ?? {}) };
}

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
  let doc: Json;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return err(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const commands: unknown = Array.isArray(doc) ? doc : doc?.commands;
  if (!Array.isArray(commands)) return err(`${file}: missing field \`commands\``);

  const b = behaviourFor(host.version, String(doc?.about?.design ?? ""));
  if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
  if (b.crash) {
    process.stderr.write("fake-solidcraft: simulated crash in eval (segmentation fault)\n");
    return 139;
  }
  if (b.exit) return err(`${file}: simulated failure`, b.exit);

  // Replay step by step. A step that is malformed stops the run (exit 1); a feature that cannot be
  // computed is recorded on the timeline and skipped, and the run carries on (exit 0).
  const applied: Cmd[] = [];
  const failed: { after: number; name: string; type: string; error: string }[] = [];
  for (const [i, raw] of (commands as Cmd[]).entries()) {
    const cmd: Cmd = { command: String(raw?.command ?? ""), params: raw?.params ?? {} };
    const name = typeof cmd.params.name === "string" ? cmd.params.name : cmd.command;
    const isFeature = cmd.command.startsWith("solid.");
    if (isFeature && b.failFeature && (b.failFeature === cmd.command || b.failFeature === name)) {
      failed.push({ after: host.build(applied).timeline.length, name, type: cmd.command, error: `simulated: ${name} could not be computed by SolidCraft ${host.version}` });
      continue;
    }
    try {
      host.build([...applied, cmd]);
      applied.push(cmd);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!isFeature || STEP_ERROR.test(msg)) return err(`step ${i + 1} (${cmd.command}): ${msg}`);
      failed.push({ after: host.build(applied).timeline.length, name, type: cmd.command, error: msg });
    }
  }
  const model = host.build(applied);

  const scale = host.volumeScale * (b.volumeScale ?? 1);
  const bodies: Json[] = model.bodies.map((body) => {
    const bbox = host.bboxOf(body);
    const faces: Json[] = body.faces;
    const cyl = faces.filter((f) => f.cylinder).length;
    return {
      area_mm2: faces.reduce((s, f) => s + (Number(f.area) || 0), 0) * (b.areaScale ?? 1),
      bbox: { max: bbox.max.map((v) => v + (b.bboxGrow ?? 0)), min: bbox.min },
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
  const timeline: Json[] = model.timeline.map((f) => ({ error: null, id: f.id, ms: Math.random() * 10, name: f.name, rolled_back: false, suppressed: false, type: f.type, warning: f.warning ?? null }));
  for (const f of [...failed].reverse()) timeline.splice(f.after, 0, { error: f.error, id: 1000 + f.after, ms: Math.random() * 10, name: f.name, rolled_back: false, suppressed: false, type: f.type, warning: null });
  const out = {
    bodies,
    body_count: bodies.length,
    params: model.params.map((q) => ({ comment: "", error: b.paramError === q.name ? `simulated: ${q.name} could not be evaluated` : null, expression: q.expression, model: false, name: q.name, unit: q.unit, value: q.value })),
    sketches: model.sketches.map((s) => ({ name: s.name, status: "solved" })),
    timeline,
    total: {
      area_mm2: bodies.reduce((s, x) => s + x.area_mm2, 0),
      edges: bodies.reduce((s, x) => s + x.edges, 0),
      faces: bodies.reduce((s, x) => s + x.faces, 0),
      volume_mm3: bodies.reduce((s, x) => s + x.volume_mm3, 0),
    },
  };
  const text = JSON.stringify(out, null, 1);
  if (jsonOut) writeFileSync(jsonOut, text);
  process.stdout.write(`${text}\n`);
  return 0;
}
