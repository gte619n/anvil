/**
 * The expected numbers an autopilot PLAN carries for its CAD parts (agent-cad-and-browser spec §4.11,
 * §4.14 item 41, Phase B3). Pure and SDK-free, so the nightly planner's metadata parser (`plan-meta.ts`),
 * the planner session's `save_cad_expectations` tool, the autopilot card and `startPlan` all read ONE
 * definition of "a well-formed plan expectation", with the same schema and caps as `record_expectations`:
 *
 *   - `part`        a part name (`cad/<part>/`), never a path;
 *   - `process`     an id in `cad/rules.json`;
 *   - `parameters`  the DECLARED literal value of every parameter a formula uses (a number, optionally
 *                   with `mm`), exactly what `record_expectations` requires — the expected numbers are
 *                   fixed from these values when the plan is written, never from a design;
 *   - `expectations` bbox / volume / bodies / holes / tolerance / noInterferenceWith, the caps checked.
 *
 * The approval card for a plan shows `planExpectationRows` and approves exactly the record whose
 * `planExpectationsSha` it was drawn with (decisions 153, 159).
 */
import { createHash } from "node:crypto";
import type { CadExpectationsRow } from "@protocol";
import { isValidPartName } from "./partfolder";
import {
  DEFAULT_TOLERANCE,
  evaluateExpectations,
  expectationsShapeError,
  stampExpectations,
  toleranceCapErrors,
  type EvaluatedExpectations,
  type ExpectationsInput,
} from "./partfile";
import { sortKeys } from "./poststep";

/** One part's expectations as a plan declares them. */
export interface PlanPartExpectations {
  process: string;
  /** Parameter name → declared literal value ("80 mm" or 80). */
  parameters: Record<string, string | number>;
  expectations: ExpectationsInput;
  /** When the OWNER approved this part's numbers (a planner card or the autopilot card). */
  approvedAt?: string;
}

/** At most this many parts in one plan (a bound on what a model can make the card show). */
export const PLAN_MAX_PARTS = 20;

/** A declared parameter value: a number, optionally followed by `mm`. Nothing else — the declared
 *  values are what the expectations (lengths, volumes) are evaluated from, so they are lengths or
 *  plain numbers; an angle (`deg`) is not accepted. */
const DECLARED_RE = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(mm)?\s*$/;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z_0-9]*$/;

/** Read `record_expectations`' `parameters` argument: every value a plain number (with an optional
 *  `mm`). Returns the numbers and the expressions to create the parameters with. */
export function parseDeclared(raw: unknown): { ok: true; values: Record<string, number>; expressions: Record<string, string> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "`parameters` must be an object mapping every parameter name the expectations use to its value (use {} when every expectation is a plain number)" };
  const values: Record<string, number> = {};
  const expressions: Record<string, string> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!PARAM_NAME_RE.test(name) || name === "pi") return { ok: false, error: `\`parameters\`: ${JSON.stringify(name)} is not a parameter name` };
    const m = typeof v === "number" ? (Number.isFinite(v) ? [String(v), String(v), undefined] : null) : typeof v === "string" ? DECLARED_RE.exec(v) : null;
    if (!m) return { ok: false, error: `\`parameters.${name}\` must be a number, optionally with mm (e.g. 80 or "80 mm"), not ${JSON.stringify(v)}` };
    values[name] = Number(m[1]);
    expressions[name] = typeof v === "number" ? String(v) : (v as string).trim();
  }
  return { ok: true, values, expressions };
}

export type PlanPartCheck =
  | { ok: true; entry: PlanPartExpectations; values: EvaluatedExpectations; declared: Record<string, number>; expressions: Record<string, string> }
  | { ok: false; error: string };

/**
 * Validate one part of a plan exactly as `record_expectations` validates a call: a part name, a
 * process, declared literal parameter values, a well-formed expectations block within the tolerance
 * caps, and every formula evaluating from the declared values alone. Returns the normalized entry
 * (known keys only) and the numbers it fixes.
 */
export function checkPlanPart(part: unknown, raw: unknown): PlanPartCheck {
  if (!isValidPartName(part)) return { ok: false, error: `${JSON.stringify(part)} is not a part name (lowercase letters, digits and hyphens, e.g. "motor-mount")` };
  const x = raw as Record<string, unknown> | undefined;
  if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, error: `cad/${part}: must be {process, parameters, expectations}` };
  if (typeof x.process !== "string" || !x.process.trim()) return { ok: false, error: `cad/${part}: \`process\` must name a process in cad/rules.json` };
  const declared = parseDeclared(x.parameters ?? {});
  if (!declared.ok) return { ok: false, error: `cad/${part}: ${declared.error}` };
  const why = expectationsShapeError(x.expectations, { stamped: false });
  if (why) return { ok: false, error: `cad/${part}: ${why}` };
  const input = x.expectations as ExpectationsInput;
  const stamped = stampExpectations(input, "planner", "1970-01-01T00:00:00.000Z");
  const caps = toleranceCapErrors(stamped.tolerance);
  if (caps.length) return { ok: false, error: `cad/${part}: ${caps.join("; ")} (defaults are ${DEFAULT_TOLERANCE.length} mm and ${DEFAULT_TOLERANCE.volumeRel})` };
  let values: EvaluatedExpectations;
  try {
    values = evaluateExpectations(stamped, declared.values);
  } catch (e) {
    return { ok: false, error: `cad/${part}: ${e instanceof Error ? e.message : String(e)} — every parameter a formula uses must be declared in \`parameters\` with its value` };
  }
  // Known keys only, in a stable shape (the card and the sha see exactly what will be locked).
  const expectations: ExpectationsInput = {
    bbox: [input.bbox[0], input.bbox[1], input.bbox[2]],
    volume: input.volume,
    bodies: input.bodies,
    holes: input.holes.map((h) => ({ diameter: h.diameter, count: h.count, ...(h.kind ? { kind: h.kind } : {}) })),
    ...(input.tolerance ? { tolerance: { ...(input.tolerance.length !== undefined ? { length: input.tolerance.length } : {}), ...(input.tolerance.volumeRel !== undefined ? { volumeRel: input.tolerance.volumeRel } : {}) } } : {}),
    ...(input.noInterferenceWith?.length ? { noInterferenceWith: [...input.noInterferenceWith] } : {}),
  };
  const parameters: Record<string, string | number> = {};
  for (const n of Object.keys(declared.expressions).sort()) {
    const v = (x.parameters as Record<string, unknown>)[n];
    parameters[n] = typeof v === "number" ? v : declared.expressions[n]!;
  }
  return { ok: true, entry: { process: x.process.trim(), parameters, expectations }, values, declared: declared.values, expressions: declared.expressions };
}

/**
 * Validate a whole `cadExpectations` record (part → entry). Invalid parts are dropped with one error
 * line each; the caller decides what an error means (the nightly planner: ignored with a note).
 */
export function checkPlanExpectations(raw: unknown): { parts: Record<string, PlanPartExpectations>; errors: string[] } {
  const parts: Record<string, PlanPartExpectations> = {};
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { parts, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) return { parts, errors: ["`cadExpectations` must be an object mapping each part name to {process, parameters, expectations}"] };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > PLAN_MAX_PARTS) return { parts, errors: [`\`cadExpectations\` lists ${entries.length} parts; at most ${PLAN_MAX_PARTS}`] };
  for (const [part, v] of entries) {
    const c = checkPlanPart(part, v);
    if (c.ok) parts[part] = c.entry;
    else errors.push(c.error);
  }
  return { parts, errors };
}

/** The identity of exactly what a card shows: the record without approval stamps, canonical JSON. */
export function planExpectationsSha(record: Record<string, PlanPartExpectations> | undefined): string {
  const bare = Object.fromEntries(
    Object.keys(record ?? {})
      .sort()
      .map((p) => {
        const { approvedAt: _a, ...rest } = record![p]!;
        return [p, rest];
      }),
  );
  return createHash("sha256").update(JSON.stringify(sortKeys(bare))).digest("hex");
}

const num = (v: number): string => String(Math.round(v * 1e4) / 1e4);
const withValue = (written: string, value: string): string => (written === value ? written : `${written}  (= ${value})`);

/**
 * What is APPROVED for a part right now: the repo's single lock-store entry (per repo and part, shared by
 * every worktree and fleet-synced — decision 183). `process`, `tolerance` and `refs` are only known when
 * the part.json read alongside it still carries exactly the approved block (`matchesFile`); the numbers
 * (`values`, `declared`) are the lock's own.
 */
export interface ApprovedNumbers {
  approvedBy: string;
  /** ISO time of the approval (the lock entry's clock). */
  at: string;
  /** The lock entry's `lockedBlockSha`. */
  sha: string;
  values?: EvaluatedExpectations;
  declared?: Record<string, number>;
  /** The part.json read with it holds exactly the approved block (so the fields below are known). */
  matchesFile: boolean;
  process?: string;
  tolerance?: { length: number; volumeRel: number };
  refs?: string[];
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const sameHoles = (a: EvaluatedExpectations["holes"], b: EvaluatedExpectations["holes"]): boolean =>
  a.length === b.length && a.every((h, i) => near(h.diameter, b[i]!.diameter) && h.count === b[i]!.count && (h.kind ?? "") === (b[i]!.kind ?? ""));

/**
 * The plan's numbers for a part are the approved ones: the same evaluated expectations and declared
 * parameter values (and, where the approved block is known, the same process and tolerance). Fields the
 * approval does not record are not compared.
 */
export function sameAsApproved(entry: PlanPartExpectations, approved: ApprovedNumbers | undefined): boolean {
  if (!approved?.values) return false;
  const c = checkPlanPart("x", entry);
  if (!c.ok) return false;
  const v = c.values;
  const a = approved.values;
  if (!(v.bbox.every((x, i) => near(x, a.bbox[i]!)) && near(v.volume, a.volume) && v.bodies === a.bodies && sameHoles(v.holes, a.holes))) return false;
  const d = approved.declared ?? {};
  const names = new Set([...Object.keys(c.declared), ...Object.keys(d)]);
  for (const n of names) if (c.declared[n] === undefined || d[n] === undefined || !near(c.declared[n]!, d[n]!)) return false;
  if (approved.process !== undefined && approved.process !== entry.process) return false;
  if (approved.tolerance) {
    const t = { length: entry.expectations.tolerance?.length ?? DEFAULT_TOLERANCE.length, volumeRel: entry.expectations.tolerance?.volumeRel ?? DEFAULT_TOLERANCE.volumeRel };
    if (!near(t.length, approved.tolerance.length) || !near(t.volumeRel, approved.tolerance.volumeRel)) return false;
  }
  return true;
}

/**
 * Starting a builder with this plan REPLACES the part's approval (and so, until the work is merged, the
 * part on the default branch shows as unverified): anything but "the same numbers, already approved by
 * the owner or a plan, with the approved block on disk". When it does not, the builder keeps the
 * existing approval and part.json block untouched (`applyPlanExpectations`).
 */
export function replacesApproval(entry: PlanPartExpectations, approved: ApprovedNumbers | undefined): boolean {
  if (!approved || !approved.matchesFile) return true;
  if (approved.approvedBy !== "owner" && approved.approvedBy !== "planner") return true;
  return !sameAsApproved(entry, approved);
}

/** The warning a plan card carries when approving and starting it replaces the repo-wide approval. */
export function replaceNote(part: string, defaultBranch: string): string {
  return `Approving replaces the approved numbers for cad/${part} for the whole repo. Until this work is merged, the part on ${defaultBranch} will show as unverified.`;
}

/** What a card's "old" side is drawn from, for the card's identity (decision 153: a card whose old side
 *  changed while it was open is refused and redrawn). */
export function approvedFingerprint(approved: ApprovedNumbers | undefined): string | null {
  return approved ? `${approved.sha}@${approved.at}@${approved.approvedBy}@${approved.matchesFile ? 1 : 0}` : null;
}

/** The rows an owner card shows for one planned part: the process, each declared parameter, and each
 *  expected number as written with what it evaluates to. `old` is what is APPROVED for the part now (the
 *  repo's lock-store entry, decisions 153 and 183) — absent for a part nobody has approved numbers for. */
export function planExpectationRows(entry: PlanPartExpectations, approved?: ApprovedNumbers): CadExpectationsRow[] {
  const c = checkPlanPart("x", entry);
  const v = c.ok ? c.values : undefined;
  const ex = entry.expectations;
  const tol = { length: ex.tolerance?.length ?? DEFAULT_TOLERANCE.length, volumeRel: ex.tolerance?.volumeRel ?? DEFAULT_TOLERANCE.volumeRel };
  const n = {
    process: entry.process,
    params: Object.keys(entry.parameters).sort().map((k) => `${k} = ${String(entry.parameters[k])}`).join(", ") || "none",
    bbox: withValue(ex.bbox.join(" × "), v ? v.bbox.map(num).join(" × ") : "?"),
    volume: withValue(String(ex.volume), v ? num(v.volume) : "?"),
    bodies: String(ex.bodies),
    holes: ex.holes.map((h) => `⌀${h.diameter} ×${h.count}${h.kind ? ` ${h.kind}` : ""}`).join(", ") || "none",
    tolerance: `${tol.length} mm, ${tol.volumeRel * 100}% volume`,
    refs: (ex.noInterferenceWith ?? []).join(", ") || "none",
  };
  const a = approved;
  const av = a?.values;
  const o: Partial<Record<keyof typeof n, string>> = a
    ? {
        ...(a.process !== undefined ? { process: a.process } : {}),
        ...(a.declared ? { params: Object.keys(a.declared).sort().map((k) => `${k} = ${num(a.declared![k]!)}`).join(", ") || "none" } : {}),
        ...(av
          ? {
              bbox: av.bbox.map(num).join(" × "),
              volume: num(av.volume),
              bodies: String(av.bodies),
              holes: av.holes.map((h) => `⌀${num(h.diameter)} ×${h.count}${h.kind ? ` ${h.kind}` : ""}`).join(", ") || "none",
            }
          : {}),
        ...(a.tolerance ? { tolerance: `${a.tolerance.length} mm, ${a.tolerance.volumeRel * 100}% volume` } : {}),
        ...(a.refs ? { refs: a.refs.join(", ") || "none" } : {}),
      }
    : {};
  const row = (label: string, k: keyof typeof n): CadExpectationsRow => ({ label, ...(o[k] !== undefined ? { old: o[k] } : {}), new: n[k] });
  return [
    row("Process", "process"),
    row("Parameters", "params"),
    row("Bounding box (mm)", "bbox"),
    row("Volume (mm³)", "volume"),
    row("Bodies", "bodies"),
    row("Holes", "holes"),
    row("Tolerance", "tolerance"),
    row("Must not touch", "refs"),
  ];
}
