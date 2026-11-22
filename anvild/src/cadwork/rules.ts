/**
 * `cad/rules.json` — the repo's manufacturing processes (agent-cad-and-browser spec §4.6).
 *
 *  HARD (fail the gate):  the part's sorted bounding box fits the process's sorted envelope; for a
 *                         `cnc` process every hole diameter is within `holeTolerance` of a listed
 *                         drill; a part whose `process` is not in the file is "unknown process".
 *  ADVISORY (never block): `minWall` and `minInsideRadius`. SolidCraft cannot measure wall
 *                         thickness, and the line says so in plain words.
 *
 * The file is committed, so — like `part.json` — it is trusted only when its sha256 matches the lock
 * store; the gate handles that (`needsAdoption: "rules"`), this module only reads and checks.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAD_DIR } from "./partfolder";

export const RULES_FILE = "rules.json";
export const DEFAULT_HOLE_TOLERANCE = 0.05;
export const WALL_NOT_MEASURED = "not measured: SolidCraft cannot measure wall thickness, so check this by eye";
export const RADIUS_NOT_MEASURED = "not measured: inside corner radii are not checked automatically, so check this by eye";

export interface RulesProcess {
  id: string;
  kind: "fdm" | "cnc";
  /** Bed or travel, mm. */
  envelope: [number, number, number];
  /** Allowed hole diameters, mm (cnc). */
  drills?: number[];
  holeTolerance?: number;
  minWall?: number;
  minInsideRadius?: number;
  generalTolerance?: string;
  material?: string;
}

export interface RulesFile {
  schema: 1;
  processes: RulesProcess[];
}

export type RulesRead = { kind: "missing" } | { kind: "invalid"; error: string; text: string; sha: string } | { kind: "ok"; file: RulesFile; text: string; sha: string };

/** One line of a gate result (same shape as `GateCheck`; declared here to keep this module leaf-level). */
export interface RuleCheck {
  id: string;
  expected: number | string;
  measured: number | string;
  ok: boolean;
  hard: boolean;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const fmt = (v: number): string => String(Math.round(v * 1e4) / 1e4);

export function rulesPath(worktree: string): string {
  return join(worktree, CAD_DIR, RULES_FILE);
}

export function validateRules(doc: unknown): { ok: true; file: RulesFile } | { ok: false; error: string } {
  const d = doc as Partial<RulesFile>;
  if (!d || typeof d !== "object" || Array.isArray(d)) return { ok: false, error: "rules.json must be a JSON object" };
  if (d.schema !== 1) return { ok: false, error: `rules.json has schema ${JSON.stringify(d.schema)}; this Anvil reads schema 1` };
  if (!Array.isArray(d.processes)) return { ok: false, error: "rules.json: `processes` must be a list" };
  const seen = new Set<string>();
  for (const [i, p] of d.processes.entries()) {
    const at = `rules.json: processes[${i}]`;
    if (!p || typeof p !== "object") return { ok: false, error: `${at} must be an object` };
    if (typeof p.id !== "string" || !p.id.trim()) return { ok: false, error: `${at}.id must be a name such as "fdm-0.4"` };
    if (seen.has(p.id)) return { ok: false, error: `rules.json: process "${p.id}" is listed twice` };
    seen.add(p.id);
    if (p.kind !== "fdm" && p.kind !== "cnc") return { ok: false, error: `${at}.kind must be "fdm" or "cnc"` };
    if (!Array.isArray(p.envelope) || p.envelope.length !== 3 || !p.envelope.every((n) => isNum(n) && n > 0)) return { ok: false, error: `${at}.envelope must be three positive numbers (mm)` };
    if (p.drills !== undefined && !(Array.isArray(p.drills) && p.drills.every((n) => isNum(n) && n > 0))) return { ok: false, error: `${at}.drills must be a list of positive diameters (mm)` };
    for (const k of ["holeTolerance", "minWall", "minInsideRadius"] as const) {
      if (p[k] !== undefined && !(isNum(p[k]) && (p[k] as number) >= 0)) return { ok: false, error: `${at}.${k} must be a number, 0 or more` };
    }
    for (const k of ["generalTolerance", "material"] as const) {
      if (p[k] !== undefined && typeof p[k] !== "string") return { ok: false, error: `${at}.${k} must be text` };
    }
  }
  return { ok: true, file: d as RulesFile };
}

/** Read the worktree's `cad/rules.json` with the sha256 of its exact bytes. */
export function readRules(worktree: string): RulesRead {
  let text: string;
  try {
    text = readFileSync(rulesPath(worktree), "utf8");
  } catch {
    return { kind: "missing" };
  }
  const sha = sha256(text);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { kind: "invalid", error: `rules.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, text, sha };
  }
  const v = validateRules(doc);
  return v.ok ? { kind: "ok", file: v.file, text, sha } : { kind: "invalid", error: v.error, text, sha };
}

/**
 * Check a measured part against its process. Returns hard checks and advisory lines (`hard: false`,
 * shown and never blocking). With nothing measured yet, only the process lookup is checked.
 */
export function checkRules(rules: RulesFile, processId: string, m?: { bbox: [number, number, number]; holes: { diameter: number; count: number }[] }): RuleCheck[] {
  const proc = rules.processes.find((p) => p.id === processId);
  if (!proc) {
    const known = rules.processes.map((p) => p.id).join(", ") || "none";
    return [{ id: "rules.process", expected: `a process listed in cad/rules.json (${known})`, measured: `unknown process "${processId}"`, ok: false, hard: true }];
  }
  const out: RuleCheck[] = [{ id: "rules.process", expected: processId, measured: `${processId} (${proc.kind})`, ok: true, hard: true }];
  if (m) {
    const env = [...proc.envelope].sort((a, b) => a - b);
    const box = [...m.bbox].sort((a, b) => a - b);
    out.push({
      id: "rules.envelope",
      expected: `fits ${env.map(fmt).join(" × ")} mm (${proc.id})`,
      measured: `${box.map(fmt).join(" × ")} mm`,
      ok: box.every((v, i) => v <= env[i]! + 1e-9),
      hard: true,
    });
    if (proc.kind === "cnc" && proc.drills) {
      const tol = proc.holeTolerance ?? DEFAULT_HOLE_TOLERANCE;
      const drills = [...proc.drills].sort((a, b) => a - b);
      for (const d of [...new Set(m.holes.map((h) => h.diameter))].sort((a, b) => a - b)) {
        const nearest = drills.reduce<number | undefined>((best, x) => (best === undefined || Math.abs(x - d) < Math.abs(best - d) ? x : best), undefined);
        out.push({
          id: `rules.drill ⌀${fmt(d)}`,
          expected: `within ${fmt(tol)} mm of a listed drill (${drills.map(fmt).join(", ") || "none listed"})`,
          measured: nearest === undefined ? `⌀${fmt(d)} mm, no drills listed` : `⌀${fmt(d)} mm (nearest drill ${fmt(nearest)})`,
          ok: nearest !== undefined && Math.abs(nearest - d) <= tol + 1e-9,
          hard: true,
        });
      }
    }
  }
  if (proc.minWall !== undefined) out.push({ id: "rules.minWall", expected: `walls at least ${fmt(proc.minWall)} mm`, measured: WALL_NOT_MEASURED, ok: true, hard: false });
  if (proc.minInsideRadius !== undefined) out.push({ id: "rules.minInsideRadius", expected: `inside corners at least R${fmt(proc.minInsideRadius)} mm`, measured: RADIUS_NOT_MEASURED, ok: true, hard: false });
  return out;
}

/** A plain line diff of two texts (longest common subsequence), for the rules adopt card. */
export function lineDiff(oldText: string, newText: string): { op: " " | "+" | "-"; line: string }[] {
  const a = oldText.replace(/\n$/, "").split("\n");
  const b = newText.replace(/\n$/, "").split("\n");
  if (oldText === "") a.length = 0;
  if (newText === "") b.length = 0;
  if (a.length * b.length > 4_000_000) return [...a.map((line) => ({ op: "-" as const, line })), ...b.map((line) => ({ op: "+" as const, line }))];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: { op: " " | "+" | "-"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push({ op: " ", line: a[i++]! }), j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "-", line: a[i++]! });
    else out.push({ op: "+", line: b[j++]! });
  }
  while (i < a.length) out.push({ op: "-", line: a[i++]! });
  while (j < b.length) out.push({ op: "+", line: b[j++]! });
  return out;
}
