/**
 * `cad/<part>/part.json` (agent-cad-and-browser spec §4.1): what the part is expected to be, which
 * process makes it, and the daemon's last measurement.
 *
 * The file is committed and the agent's Bash can write it, so NOTHING in it proves approval — the
 * lock store (./locks.ts) holds the hash of the block the owner approved, and the gate trusts the
 * file only when the hashes match. `measured` is written by the daemon only (`writeMeasured`).
 *
 * A corrupt file, or one with a different `schema`, is reported as `invalid` with the parse error
 * and is NEVER overwritten: the part is `unverified` until a person repairs the file.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evalExpr, type Expr } from "./expr";
import { CACHE_DIR, sortKeys } from "./poststep";

export const PART_FILE = "part.json";
export const PART_SCHEMA = 1;
/** The loosest tolerances an expectation may carry (§10 item 9): 0.1 mm and 1 %. */
export const TOLERANCE_CAPS = { length: 0.1, volumeRel: 0.01 } as const;
export const DEFAULT_TOLERANCE = { length: 0.01, volumeRel: 0.001 } as const;

export type PartStatusKind = "concept" | "dimensioned";
export type LockedBy = "owner" | "planner" | "agent-initial";
export type HoleKind = "through" | "blind";

export interface HoleExpectation {
  diameter: Expr;
  count: number;
  /** Optional (§4.14 #7): when given, only holes of this kind count towards the row. */
  kind?: HoleKind;
}

export interface Expectations {
  lockedAt: string;
  /** Informational only — the lock store decides who approved. */
  lockedBy: LockedBy;
  /** mm, compared sorted ascending so orientation does not matter. */
  bbox: [Expr, Expr, Expr];
  /** mm³ */
  volume: Expr;
  bodies: number;
  holes: HoleExpectation[];
  tolerance: { length: number; volumeRel: number };
  noInterferenceWith?: string[];
}

export interface MeasuredHole {
  diameter: number;
  count: number;
  kind: HoleKind;
}

export interface Measured {
  at: string;
  solidcraft: string;
  scriptSha: string;
  /** Sorted ascending. */
  bbox: [number, number, number];
  volume: number;
  faces: number;
  bodies: number;
  holes: MeasuredHole[];
  warnings: string[];
}

/** A reference body imported with `import_reference` (Phase A4). Informational: the gate reads the
 *  design's embedded STEP text and `refs/<name>` itself, never trusting this record. */
export interface PartReference {
  /** The file name in `refs/` — the name `expectations.noInterferenceWith` lists. */
  name: string;
  /** Worktree-relative path of the file it was copied from. */
  source: string;
  /** sha256 of the imported bytes. */
  sha256: string;
  /** The bodies the import created (`created_bodies`). */
  bodies: string[];
  at: string;
}

/** The part is blocked on a feature SolidCraft cannot make (`report_gap`, D17). */
export interface GapRecord {
  feature: string;
  detail: string;
  at: string;
}

export interface PartFile {
  schema: 1;
  process: string;
  material?: string;
  status: PartStatusKind;
  ownerParams?: Record<string, number>;
  expectations?: Expectations;
  refs?: PartReference[];
  gap?: GapRecord;
  measured?: Measured;
}

/** What the agent (or a card) supplies; `lockedAt` / `lockedBy` are stamped by the daemon. */
export type ExpectationsInput = Omit<Expectations, "lockedAt" | "lockedBy" | "tolerance"> & { tolerance?: Partial<Expectations["tolerance"]> };

/** The numbers an expectations block evaluates to with the design's current parameters. */
export interface EvaluatedExpectations {
  bbox: [number, number, number];
  volume: number;
  bodies: number;
  holes: { diameter: number; count: number; kind?: HoleKind }[];
}

export type PartRead = { kind: "missing" } | { kind: "invalid"; error: string; text: string } | { kind: "ok"; file: PartFile; text: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isExpr = (v: unknown): v is Expr => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim().length > 0);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Why an expectations block is not well-formed, or undefined when it is. Shape only — the tolerance
 *  CAPS are a gate check (and a `record_expectations` refusal), not a schema error, so a file whose
 *  tolerance someone loosened still parses and fails visibly on the cap. */
export function expectationsShapeError(x: unknown, opts: { stamped: boolean }): string | undefined {
  if (!isObj(x)) return "`expectations` must be an object";
  if (opts.stamped) {
    if (typeof x.lockedAt !== "string" || !x.lockedAt) return "`expectations.lockedAt` must be an ISO time";
    if (x.lockedBy !== "owner" && x.lockedBy !== "planner" && x.lockedBy !== "agent-initial") return "`expectations.lockedBy` must be owner, planner or agent-initial";
  }
  if (!Array.isArray(x.bbox) || x.bbox.length !== 3 || !x.bbox.every(isExpr)) return "`expectations.bbox` must be three numbers or formulas (mm)";
  if (!isExpr(x.volume)) return "`expectations.volume` must be a number or a formula (mm³)";
  if (!isCount(x.bodies)) return "`expectations.bodies` must be a whole number";
  if (!Array.isArray(x.holes)) return "`expectations.holes` must be a list (empty when the part has no holes)";
  for (const [i, h] of x.holes.entries()) {
    if (!isObj(h) || !isExpr(h.diameter)) return `\`expectations.holes[${i}].diameter\` must be a number or a formula (mm)`;
    if (!isCount(h.count) || h.count < 1) return `\`expectations.holes[${i}].count\` must be a whole number, at least 1`;
    if (h.kind !== undefined && h.kind !== "through" && h.kind !== "blind") return `\`expectations.holes[${i}].kind\` must be "through" or "blind"`;
  }
  if (x.tolerance !== undefined || opts.stamped) {
    const t = x.tolerance;
    if (!isObj(t)) return "`expectations.tolerance` must be { length, volumeRel }";
    for (const k of ["length", "volumeRel"] as const) {
      if (t[k] === undefined && !opts.stamped) continue;
      if (typeof t[k] !== "number" || !Number.isFinite(t[k] as number) || (t[k] as number) < 0) return `\`expectations.tolerance.${k}\` must be a number, 0 or more`;
    }
  }
  if (x.noInterferenceWith !== undefined && !(Array.isArray(x.noInterferenceWith) && x.noInterferenceWith.every((s) => typeof s === "string"))) {
    return "`expectations.noInterferenceWith` must be a list of file names";
  }
  return undefined;
}

/** Which tolerances are looser than the caps, as plain sentences (empty when within them). */
export function toleranceCapErrors(t: { length: number; volumeRel: number }): string[] {
  const out: string[] = [];
  if (!(t.length <= TOLERANCE_CAPS.length)) out.push(`length tolerance ${t.length} mm is looser than the cap of ${TOLERANCE_CAPS.length} mm`);
  if (!(t.volumeRel <= TOLERANCE_CAPS.volumeRel)) out.push(`volume tolerance ${t.volumeRel} is looser than the cap of ${TOLERANCE_CAPS.volumeRel} (1%)`);
  return out;
}

/** Turn what a tool was given into a stamped block (defaults filled, known keys only, stable order). */
export function stampExpectations(input: ExpectationsInput, lockedBy: LockedBy, lockedAt: string): Expectations {
  return {
    lockedAt,
    lockedBy,
    bbox: [input.bbox[0], input.bbox[1], input.bbox[2]],
    volume: input.volume,
    bodies: input.bodies,
    holes: input.holes.map((h) => ({ diameter: h.diameter, count: h.count, ...(h.kind ? { kind: h.kind } : {}) })),
    tolerance: { length: input.tolerance?.length ?? DEFAULT_TOLERANCE.length, volumeRel: input.tolerance?.volumeRel ?? DEFAULT_TOLERANCE.volumeRel },
    ...(input.noInterferenceWith?.length ? { noInterferenceWith: [...input.noInterferenceWith] } : {}),
  };
}

/** Validate a parsed `part.json`. */
export function validatePartFile(doc: unknown): { ok: true; file: PartFile } | { ok: false; error: string } {
  if (!isObj(doc)) return { ok: false, error: "part.json must be a JSON object" };
  if (doc.schema !== PART_SCHEMA) return { ok: false, error: `part.json has schema ${JSON.stringify(doc.schema)}; this Anvil reads schema ${PART_SCHEMA}` };
  if (typeof doc.process !== "string" || !doc.process.trim()) return { ok: false, error: "part.json: `process` must name a process in cad/rules.json" };
  if (doc.material !== undefined && typeof doc.material !== "string") return { ok: false, error: "part.json: `material` must be text" };
  if (doc.status !== "concept" && doc.status !== "dimensioned") return { ok: false, error: 'part.json: `status` must be "concept" or "dimensioned"' };
  if (doc.ownerParams !== undefined) {
    if (!isObj(doc.ownerParams) || !Object.values(doc.ownerParams).every((v) => typeof v === "number" && Number.isFinite(v))) {
      return { ok: false, error: "part.json: `ownerParams` must map parameter names to numbers" };
    }
  }
  if (doc.expectations !== undefined) {
    const why = expectationsShapeError(doc.expectations, { stamped: true });
    if (why) return { ok: false, error: `part.json: ${why}` };
  }
  if (doc.refs !== undefined) {
    const okRef = (r: unknown): boolean => isObj(r) && typeof r.name === "string" && typeof r.source === "string" && typeof r.sha256 === "string" && typeof r.at === "string" && Array.isArray(r.bodies) && r.bodies.every((b) => typeof b === "string");
    if (!Array.isArray(doc.refs) || !doc.refs.every(okRef)) return { ok: false, error: "part.json: `refs` must list the imported references ({name, source, sha256, bodies, at})" };
  }
  if (doc.gap !== undefined && !(isObj(doc.gap) && typeof doc.gap.feature === "string" && typeof doc.gap.detail === "string" && typeof doc.gap.at === "string")) {
    return { ok: false, error: "part.json: `gap` must be {feature, detail, at}" };
  }
  if (doc.measured !== undefined && !isObj(doc.measured)) return { ok: false, error: "part.json: `measured` must be an object" };
  return { ok: true, file: doc as unknown as PartFile };
}

/** Read a part's `part.json` as far as it can be read. */
export function readPartFile(partDir: string): PartRead {
  let text: string;
  try {
    text = readFileSync(join(partDir, PART_FILE), "utf8");
  } catch {
    return { kind: "missing" };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { kind: "invalid", error: `part.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, text };
  }
  const v = validatePartFile(doc);
  return v.ok ? { kind: "ok", file: v.file, text } : { kind: "invalid", error: v.error, text };
}

/** The exact bytes of `part.json`: fixed top-level key order, 2-space indent, trailing newline. */
export function partFileText(file: PartFile): string {
  const out: Record<string, unknown> = { schema: PART_SCHEMA, process: file.process };
  if (file.material !== undefined) out.material = file.material;
  out.status = file.status;
  if (file.ownerParams !== undefined) out.ownerParams = file.ownerParams;
  if (file.expectations !== undefined) out.expectations = file.expectations;
  if (file.refs !== undefined) out.refs = file.refs;
  if (file.gap !== undefined) out.gap = file.gap;
  if (file.measured !== undefined) out.measured = file.measured;
  return JSON.stringify(out, null, 2) + "\n";
}

let tmpCounter = 0;
/** Write `part.json` atomically (temp file in the git-excluded `.cache/` + rename). */
export function writePartFile(partDir: string, file: PartFile): void {
  mkdirSync(join(partDir, CACHE_DIR), { recursive: true });
  const tmp = join(partDir, CACHE_DIR, `${PART_FILE}.tmp-${process.pid}-${++tmpCounter}`);
  try {
    writeFileSync(tmp, partFileText(file));
    renameSync(tmp, join(partDir, PART_FILE));
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

/**
 * Record the daemon's measurement. Returns false, writing nothing, when there is no `part.json`, when
 * the file is corrupt (never overwritten), or when the measurement is unchanged apart from its time —
 * so a re-check does not churn a committed file.
 */
export function writeMeasured(partDir: string, measured: Measured): boolean {
  const cur = readPartFile(partDir);
  if (cur.kind !== "ok") return false;
  const strip = (m: Measured | undefined): string => (m ? JSON.stringify(sortKeys({ ...m, at: "" })) : "");
  if (strip(cur.file.measured) === strip(measured)) return false;
  writePartFile(partDir, { ...cur.file, measured });
  return true;
}

/**
 * sha256 of the block the owner approves: the `expectations` together with the `process` and
 * `status` they were approved under (canonical JSON, sorted keys). Process and status are included
 * because swapping either on disk would loosen the gate just as an edited expectation would.
 */
export function lockedBlockSha(file: Pick<PartFile, "process" | "status" | "expectations">): string {
  const block = { process: file.process, status: file.status, expectations: file.expectations ?? null };
  return createHash("sha256").update(JSON.stringify(sortKeys(block))).digest("hex");
}

/** Evaluate every formula in a block. Throws `ExprError` naming the field that cannot be evaluated. */
export function evaluateExpectations(exp: Expectations, params: Readonly<Record<string, number>>): EvaluatedExpectations {
  const at = <T>(field: string, fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      err.message = `${field}: ${err.message}`;
      throw err;
    }
  };
  const bbox = exp.bbox.map((e, i) => at(`bbox[${i}]`, () => evalExpr(e, params))).sort((a, b) => a - b) as [number, number, number];
  return {
    bbox,
    volume: at("volume", () => evalExpr(exp.volume, params)),
    bodies: exp.bodies,
    holes: exp.holes
      .map((h, i) => ({ diameter: at(`holes[${i}].diameter`, () => evalExpr(h.diameter, params)), count: h.count, ...(h.kind ? { kind: h.kind } : {}) }))
      .sort((a, b) => a.diameter - b.diameter || String(a.kind ?? "").localeCompare(String(b.kind ?? ""))),
  };
}
