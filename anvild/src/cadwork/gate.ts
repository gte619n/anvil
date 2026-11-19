/**
 * The geometry gate (agent-cad-and-browser spec §4.5, §4.14 #2 #3 #7): is this part what the owner
 * approved?
 *
 * `evaluateGate` is a pure function of what the refresh gathered. It never writes anything, and it
 * FAILS CLOSED: if the gate's own code throws, the result is `unverified`, never `pass`.
 *
 * HARD CHECKS (any one failing ⇒ `fail`):
 *   lock.expectations / lock.ownerParams / lock.rules — the repo files match what the lock store holds
 *   tolerance.length / tolerance.volumeRel            — within the caps, re-checked on EVERY evaluation
 *   expectations.formulas                             — every formula evaluates
 *   accepted                                          — the evaluated numbers the owner accepted have not moved
 *   features                                          — no timeline feature has an error
 *   design                                            — the script on disk is the one the process runs
 *   bbox.min / bbox.mid / bbox.max, volume, bodies    — measured (design bodies only) vs expected
 *   holes ⌀D …, holes.unexpected                      — the hole table
 *   rules.process / rules.envelope / rules.drill ⌀D   — the process rules of cad/rules.json
 * ADVISORY (`hard: false`, shown, never blocking): rules.minWall, rules.minInsideRadius.
 *
 * STATE:
 *   unverified — no expectations, no measurement of the current script, an unreadable `part.json`,
 *                an adoption pending (`needsAdoption`), or the gate threw
 *   concept    — the part is a concept (dimensions not confirmed); never `pass`
 *   fail       — a hard check failed
 *   pass       — every hard check passed
 *   gap        — the agent reported a feature SolidCraft cannot make (`report_gap`); outranks every
 *                other state, because it can only ever block
 *
 * PHASE A4: the refresh passes the reference checks (integrity of each `refs/` file against the STEP
 * text embedded in the design, and interference with each reference body) in `extraChecks`; a
 * changed reference also sets `extraUnverified`. The gap comes in as `gap`.
 */
import { evaluateExpectations, lockedBlockSha, TOLERANCE_CAPS, type EvaluatedExpectations, type GapRecord, type LockedBy, type MeasuredHole, type PartRead } from "./partfile";
import type { PartLock, RulesLock } from "./locks";
import { sortKeys } from "./poststep";
import { checkRules, type RulesRead } from "./rules";

export interface GateCheck {
  id: string;
  expected: number | string;
  measured: number | string;
  ok: boolean;
  hard: boolean;
}

export type GateState = "pass" | "fail" | "unverified" | "concept" | "gap";

export interface GateResult {
  state: GateState;
  checks: GateCheck[];
  /** SolidCraft feature warnings, e.g. "Boolean retry". */
  warnings: string[];
  needsAdoption?: "expectations" | "rules" | "ownerParams";
  /** Measured under a different SolidCraft version than the one running. */
  staleBuild: boolean;
  /** Who approved the numbers the part is checked against (only when an approval is in force).
   *  `agent-initial`: the agent recorded them and the owner has not confirmed them. */
  approvedBy?: LockedBy;
  /** The part is blocked on an unsupported feature (`report_gap`); `state` is then `gap`. */
  gap?: GapRecord;
}

/** What was measured, of the DESIGN bodies only (imported reference bodies are excluded). */
export interface Measurement {
  /** Sorted ascending. */
  bbox: [number, number, number];
  volume: number;
  faces: number;
  bodies: number;
  holes: MeasuredHole[];
  /** The script this was measured from. */
  scriptSha: string;
  /** The SolidCraft version that measured it. */
  solidcraft: string;
}

export interface GateInput {
  part: PartRead;
  lock?: PartLock;
  rules: RulesRead;
  rulesLock?: RulesLock;
  /** The design's user parameters, by name. Undefined when no process is up to ask (a check from
   *  disk): the formulas are then not re-evaluated and the ACCEPTED numbers are the target. */
  params?: Readonly<Record<string, number>>;
  measurement?: Measurement;
  /** Why there is no measurement (the refresh could not measure). */
  measureError?: string;
  /** sha of the script the process currently holds. */
  scriptSha?: string;
  /** The running SolidCraft version. */
  solidcraft?: string;
  featureErrors: { feature: string; message: string }[];
  warnings: string[];
  /** The manager's own failure: a disk conflict, or a design.json that did not replay. */
  designFailure?: string;
  /** Phase A4: reference integrity and interference checks (and advisories such as a concept's
   *  picture score). */
  extraChecks?: GateCheck[];
  /** Phase A4: something the extra checks found makes the part unverifiable (a changed reference). */
  extraUnverified?: boolean;
  /** Phase A4: the gap the part is blocked on, when one is in force. */
  gap?: GapRecord;
}

export const MOVED_WITHOUT_APPROVAL = "expected value moved without owner approval";
export const ADOPTION_CHECKS = { expectations: "lock.expectations", ownerParams: "lock.ownerParams", rules: "lock.rules" } as const;

const fmt = (v: number): string => String(Math.round(v * 1e4) / 1e4);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));
const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
/** Accepted numbers that can actually be checked against: all four present and finite. */
export function hasValues(v: EvaluatedExpectations | undefined): v is EvaluatedExpectations {
  return !!v && Array.isArray(v.bbox) && v.bbox.length === 3 && v.bbox.every((n) => typeof n === "number" && Number.isFinite(n)) && typeof v.volume === "number" && Number.isFinite(v.volume) && Number.isInteger(v.bodies) && Array.isArray(v.holes);
}
const short = (sha: string | undefined): string => (sha ? sha.slice(0, 12) : "none");

/** How the accepted numbers differ from the ones the formulas give now ("bbox[2] 80 → 120"). */
export function movedValues(accepted: EvaluatedExpectations, now: EvaluatedExpectations): string[] {
  const out: string[] = [];
  for (let i = 0; i < 3; i++) if (!close(accepted.bbox[i]!, now.bbox[i]!)) out.push(`bbox[${i}] ${fmt(accepted.bbox[i]!)} → ${fmt(now.bbox[i]!)}`);
  if (!close(accepted.volume, now.volume)) out.push(`volume ${fmt(accepted.volume)} → ${fmt(now.volume)}`);
  if (accepted.bodies !== now.bodies) out.push(`bodies ${accepted.bodies} → ${now.bodies}`);
  const holes = (e: EvaluatedExpectations): string => e.holes.map((h) => `⌀${fmt(h.diameter)}×${h.count}${h.kind ? ` ${h.kind}` : ""}`).join(", ") || "none";
  const sameHoles = accepted.holes.length === now.holes.length && accepted.holes.every((h, i) => close(h.diameter, now.holes[i]!.diameter) && h.count === now.holes[i]!.count && h.kind === now.holes[i]!.kind);
  if (!sameHoles) out.push(`holes ${holes(accepted)} → ${holes(now)}`);
  return out;
}

function geometryChecks(target: EvaluatedExpectations, tol: { length: number; volumeRel: number }, m: Measurement): GateCheck[] {
  const out: GateCheck[] = [];
  const names = ["bbox.min", "bbox.mid", "bbox.max"];
  for (let i = 0; i < 3; i++) out.push({ id: names[i]!, expected: target.bbox[i]!, measured: m.bbox[i]!, ok: Math.abs(m.bbox[i]! - target.bbox[i]!) <= tol.length, hard: true });
  out.push({ id: "volume", expected: target.volume, measured: m.volume, ok: Math.abs(m.volume - target.volume) <= tol.volumeRel * Math.abs(target.volume), hard: true });
  out.push({ id: "bodies", expected: target.bodies, measured: m.bodies, ok: m.bodies === target.bodies, hard: true });
  const claimed = new Set<number>();
  for (const want of target.holes) {
    let count = 0;
    m.holes.forEach((h, i) => {
      if (Math.abs(h.diameter - want.diameter) <= tol.length && (!want.kind || h.kind === want.kind)) {
        count += h.count;
        claimed.add(i);
      }
    });
    out.push({ id: `holes ⌀${fmt(want.diameter)}${want.kind ? ` ${want.kind}` : ""} count`, expected: want.count, measured: count, ok: count === want.count, hard: true });
  }
  const extra = m.holes.filter((_, i) => !claimed.has(i));
  out.push({
    id: "holes.unexpected",
    expected: target.holes.length ? "no holes other than the expected ones" : "no holes",
    measured: extra.length ? extra.map((h) => `⌀${fmt(h.diameter)} ×${h.count} (${h.kind})`).join(", ") : "none",
    ok: extra.length === 0,
    hard: true,
  });
  return out;
}

function evaluate(input: GateInput): GateResult {
  const checks: GateCheck[] = [];
  let unverified = false;
  const adopt = new Set<"expectations" | "ownerParams" | "rules">();
  const m = input.measurement;
  let concept = false;
  let process: string | undefined;
  let approvedBy: LockedBy | undefined;

  if (input.part.kind === "invalid") {
    unverified = true;
    checks.push({ id: "part.json", expected: "a readable part.json (schema 1)", measured: input.part.error, ok: false, hard: true });
  } else if (input.part.kind === "missing") {
    unverified = true;
    checks.push(
      input.lock
        ? { id: "part.json", expected: "the part.json whose expectations were approved", measured: "part.json is missing — restore it from git", ok: false, hard: true }
        : { id: "expectations", expected: "expectations recorded before modeling (record_expectations)", measured: "none recorded", ok: false, hard: true },
    );
  } else {
    const file = input.part.file;
    process = file.process;
    const lock = input.lock;
    const sha = lockedBlockSha(file);
    // An approval of expectations that carries no accepted numbers is not an approval: nothing is
    // ever pinned later, so such an entry (a tampered or pre-fix store) needs adopting like any other.
    const noValues = !!lock && lock.sha === sha && !!file.expectations && !hasValues(lock.values);
    const lockOk = !!lock && lock.sha === sha && !noValues;
    if (lockOk) approvedBy = lock!.approvedBy;
    if (!lock && !file.expectations && file.status === "dimensioned") {
      unverified = true;
      checks.push({ id: "expectations", expected: "expectations recorded before modeling (record_expectations)", measured: "none recorded", ok: false, hard: true });
    } else {
      checks.push({
        id: ADOPTION_CHECKS.expectations,
        expected: `the expectations the owner approved (${short(lock?.sha)})`,
        measured: lockOk
          ? `unchanged (${short(sha)})`
          : noValues
            ? `the approval on record holds no accepted numbers, so it does not count (${short(sha)})`
            : lock
              ? `part.json was changed outside the approval flow (${short(sha)})`
              : `not approved on this fleet yet (${short(sha)})`,
        ok: lockOk,
        hard: true,
      });
      if (!lockOk) adopt.add("expectations");
    }
    const paramsOk = same(file.ownerParams ?? {}, lock?.ownerParams ?? {});
    if (file.ownerParams || lock?.ownerParams) {
      checks.push({ id: ADOPTION_CHECKS.ownerParams, expected: "the dimensions the owner typed", measured: paramsOk ? "unchanged" : "ownerParams in part.json differ from the approved ones", ok: paramsOk, hard: true });
      if (!paramsOk) adopt.add("ownerParams");
    }
    concept = file.status === "concept";

    const exp = file.expectations;
    if (exp) {
      // The caps are checked HERE, on every evaluation, so a tolerance loosened on disk (and even
      // adopted) can never make the gate pass.
      checks.push({ id: "tolerance.length", expected: `at most ${TOLERANCE_CAPS.length} mm`, measured: exp.tolerance.length, ok: exp.tolerance.length <= TOLERANCE_CAPS.length, hard: true });
      checks.push({ id: "tolerance.volumeRel", expected: `at most ${TOLERANCE_CAPS.volumeRel} (1%)`, measured: exp.tolerance.volumeRel, ok: exp.tolerance.volumeRel <= TOLERANCE_CAPS.volumeRel, hard: true });
      let now: EvaluatedExpectations | undefined;
      if (input.params) {
        try {
          now = evaluateExpectations(exp, input.params);
          checks.push({ id: "expectations.formulas", expected: "every formula evaluates", measured: "ok", ok: true, hard: true });
        } catch (e) {
          checks.push({ id: "expectations.formulas", expected: "every formula evaluates", measured: e instanceof Error ? e.message : String(e), ok: false, hard: true });
        }
      } else if (!(lockOk && lock!.values)) {
        checks.push({ id: "expectations.formulas", expected: "every formula evaluates", measured: "the design's parameters are not known without opening it, and no accepted numbers are stored", ok: false, hard: true });
      }
      // The numbers the owner accepted are the target. A formula that now gives something else —
      // because the agent changed a parameter — does not move it.
      const accepted = lockOk ? lock!.values : undefined;
      if (accepted && now) {
        const moved = movedValues(accepted, now);
        // Which parameters moved away from their ACCEPTED values (what the owner approved or typed).
        const declared = lockOk ? lock!.declared : undefined;
        const changedParams = declared && input.params ? Object.keys(declared).sort().filter((n) => input.params![n] !== undefined && !close(declared[n]!, input.params![n]!)).map((n) => `${n} ${fmt(declared[n]!)} → ${fmt(input.params![n]!)}`) : [];
        checks.push({
          id: "accepted",
          expected: "the expected values the owner accepted",
          measured: moved.length ? `${MOVED_WITHOUT_APPROVAL}: ${moved.join("; ")}${changedParams.length ? ` (parameters changed without approval: ${changedParams.join(", ")})` : ""}` : "unmoved",
          ok: moved.length === 0,
          hard: true,
        });
      }
      // The target is ONLY what was accepted. With no accepted numbers there is nothing to check the
      // part against — never the formulas as they evaluate now, which the agent controls.
      // (An approval whose hash matches but which holds no numbers says so; a part that simply needs
      // adopting already fails on `lock.expectations`.)
      if (noValues) checks.push({ id: "accepted", expected: "the expected values the owner accepted", measured: "no accepted value", ok: false, hard: true });
      const target = accepted;
      // The clamp keeps a loosened tolerance from hiding a real mismatch behind the cap failure.
      const tol = { length: Math.min(exp.tolerance.length, TOLERANCE_CAPS.length), volumeRel: Math.min(exp.tolerance.volumeRel, TOLERANCE_CAPS.volumeRel) };
      if (target && m) checks.push(...geometryChecks(target, tol, m));
    }
  }

  // Rules.
  if (input.rules.kind === "missing") {
    checks.push({ id: "rules.file", expected: "cad/rules.json listing the manufacturing processes", measured: "cad/rules.json does not exist — propose a starter file for the owner to approve", ok: false, hard: true });
  } else {
    const rl = input.rulesLock;
    const rulesOk = !!rl && rl.sha === input.rules.sha;
    checks.push({
      id: ADOPTION_CHECKS.rules,
      expected: `the cad/rules.json the owner approved (${short(rl?.sha)})`,
      measured: rulesOk ? `unchanged (${short(input.rules.sha)})` : rl ? `cad/rules.json was changed (${short(input.rules.sha)})` : `not approved on this fleet yet (${short(input.rules.sha)})`,
      ok: rulesOk,
      hard: true,
    });
    if (!rulesOk) adopt.add("rules");
    if (input.rules.kind === "invalid") checks.push({ id: "rules.file", expected: "a readable cad/rules.json (schema 1)", measured: input.rules.error, ok: false, hard: true });
    else if (process !== undefined) checks.push(...checkRules(input.rules.file, process, m ? { bbox: m.bbox, holes: m.holes } : undefined));
  }

  // The design itself.
  checks.push({
    id: "features",
    expected: "no failed features",
    measured: input.featureErrors.length ? input.featureErrors.map((f) => `${f.feature}: ${f.message}`).join("; ") : "none failed",
    ok: input.featureErrors.length === 0,
    hard: true,
  });
  if (input.designFailure) checks.push({ id: "design", expected: "design.json loaded as written", measured: input.designFailure, ok: false, hard: true });
  if (!m) {
    unverified = true;
    checks.push({ id: "measured", expected: "a measurement of the current design", measured: input.measureError ?? "not measured yet", ok: false, hard: true });
  } else if (input.scriptSha !== undefined && m.scriptSha !== input.scriptSha) {
    unverified = true;
    checks.push({ id: "measured", expected: "a measurement of the current design", measured: "the last measurement is of an older version of the design", ok: false, hard: true });
  }
  if (input.extraChecks) checks.push(...input.extraChecks);
  if (input.extraUnverified) unverified = true;

  const needsAdoption = adopt.has("expectations") ? "expectations" : adopt.has("ownerParams") ? "ownerParams" : adopt.has("rules") ? "rules" : undefined;
  const state: GateState = input.gap ? "gap" : unverified || needsAdoption ? "unverified" : concept ? "concept" : checks.some((c) => c.hard && !c.ok) ? "fail" : "pass";
  return {
    state,
    checks,
    warnings: [...input.warnings],
    ...(needsAdoption ? { needsAdoption } : {}),
    staleBuild: !!(m && input.solidcraft && m.solidcraft !== input.solidcraft),
    ...(approvedBy ? { approvedBy } : {}),
    ...(input.gap ? { gap: { ...input.gap } } : {}),
  };
}

/** Evaluate the gate. Never throws: an error inside the gate is `unverified` with the error listed. */
export function evaluateGate(input: GateInput, evaluateImpl: (input: GateInput) => GateResult = evaluate): GateResult {
  try {
    const r = evaluateImpl(input);
    if (!r || !Array.isArray(r.checks) || !["pass", "fail", "unverified", "concept", "gap"].includes(r.state)) throw new Error("the gate returned no result");
    return r;
  } catch (e) {
    return {
      state: "unverified",
      checks: [{ id: "gate", expected: "the gate to run", measured: `the gate could not be evaluated: ${e instanceof Error ? e.message : String(e)}`, ok: false, hard: true }],
      warnings: Array.isArray(input?.warnings) ? [...input.warnings] : [],
      staleBuild: false,
    };
  }
}

/** A result for a refresh that died before it could gather anything (fail closed). */
export function gateError(message: string, warnings: string[] = []): GateResult {
  return { state: "unverified", checks: [{ id: "gate", expected: "the gate to run", measured: `the gate could not be evaluated: ${message}`, ok: false, hard: true }], warnings, staleBuild: false };
}

/** Every adoption a result is waiting for (a result names only the first in `needsAdoption`). */
export function pendingAdoptions(r: GateResult): ("expectations" | "ownerParams" | "rules")[] {
  return (["expectations", "ownerParams", "rules"] as const).filter((k) => r.checks.some((c) => c.id === ADOPTION_CHECKS[k] && !c.ok));
}

/** The failing hard checks as plain lines ("volume: expected 23335.167, measured 23422.6"). */
export function failingLines(r: GateResult): string[] {
  const show = (v: number | string): string => (typeof v === "number" ? fmt(v) : v);
  return r.checks.filter((c) => c.hard && !c.ok).map((c) => `${c.id}: expected ${show(c.expected)}, measured ${show(c.measured)}`);
}
/** The advisory lines (shown, never blocking). */
export function advisoryLines(r: GateResult): string[] {
  return r.checks.filter((c) => !c.hard).map((c) => `${c.id}: ${c.expected} — ${c.measured}`);
}
