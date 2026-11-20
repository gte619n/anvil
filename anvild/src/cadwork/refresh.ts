/**
 * The refresh (agent-cad-and-browser spec §4.3 steps 2–5, §4.14 #2 #3 #7): what runs, inside the
 * part's queue, after a change's script write — debounced during a burst, always when the queue
 * drains, and synchronously first for `check_part` and friends (see `CadManager.setRefresh`).
 *
 *   2. MEASURE   design bodies only (bodies made by a `BaseFeature` — a STEP import — are left
 *                out), the hole table, feature errors and warnings.
 *   3. GATE      evaluate (./gate.ts), write `part.json.measured`, set the part's verdict.
 *                Phase A4 adds, for a part with references, the integrity of every `refs/` file
 *                against the STEP text embedded in the design and the interference check with each
 *                reference in `noInterferenceWith` (./refs.ts), and the gap (`report_gap`).
 *   4. PREVIEW   export the design bodies to `.cache/preview-<rev>.glb` (metres, Y up) and keep the
 *                newest three, plus a small `.cache/thumb-<rev>.png` for the part card (Phase A4).
 *                An empty design has no preview. A failed export never touches the gate.
 *   5. BROADCAST `onResult` hands the outcome to the service, which sends `cad.design`.
 *
 * FAIL CLOSED: anything that throws in here ends as an `unverified` gate result with the error
 * listed, never as `pass`, and never as an exception into the manager's queue.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { evaluateGate, failingLines, gateError, type GateCheck, type GateInput, type GateResult, type Measurement } from "./gate";
import { holeSummary, holeTable, mergeHoleTables, type HoleRow } from "./holes";
import { repoIdentity, type LockReader, type LockStore, type RepoIdentity } from "./locks";
import type { CadParamInfo, FeatureIssue, PartState, RefreshJob, SlotContext } from "./manager";
import type { McpToolResult } from "./mcp-client";
import type { PartRef } from "./partfolder";
import { readPartFile, writeMeasured, type GapRecord, type Measured, type PartRead } from "./partfile";
import { CACHE_DIR, DESIGN_FILE, readDesignFile } from "./poststep";
import { embeddedReferences, interferenceCheck, interferenceRequest, referenceChecks, referenceOnDisk } from "./refs";
import { readRules } from "./rules";

export interface RefreshOutcome {
  ref: PartRef;
  gate: GateResult;
  measurement?: Measurement;
  /** The full hole table (depths, counterbores) — richer than `measurement.holes`. */
  holes: HoleRow[];
  params: CadParamInfo[];
  scriptSha?: string;
  /** How long measuring and evaluating took (the preview export included). */
  ms: number;
  forced: boolean;
  /** The revision this refresh is (`cad.design.rev`), when the service numbers them. */
  rev?: number;
  /** Worktree-relative path of the preview written by this refresh; absent for an empty design. */
  preview?: string;
  /** Why no preview was written although the design has bodies. */
  previewError?: string;
  /** sha256 of the preview as exported: the route serves the file only while it still matches. */
  previewSha?: string;
  /** Worktree-relative path of the part card's thumbnail (`.cache/thumb-<rev>.png`), Phase A4. */
  thumbnail?: string;
  /** sha256 of the thumbnail as written (served on the same terms as the preview). */
  thumbnailSha?: string;
  /** Size of `design.json` in bytes (owner item 45: shown on the card above 5 MB). */
  scriptBytes?: number;
  /** The design's own bodies and the imported reference bodies, as read by this refresh. */
  designBodies?: string[];
  referenceBodies?: string[];
}

/** How many `.cache/preview-<rev>.glb` files are kept per part (§4.3 step 4). */
export const PREVIEWS_KEPT = 3;
const PREVIEW_RE = /^preview-(\d+)\.glb$/;
export const previewName = (rev: number): string => `preview-${rev}.glb`;
/** A worktree-relative path that names a preview of `part` — the only shape the preview route serves. */
export const PREVIEW_PATH_RE = /^cad\/([a-z0-9][a-z0-9-]{0,39})\/\.cache\/preview-(\d+)\.glb$/;
/** The part card's thumbnail, served by the same route (Phase A4): nothing else is reachable. */
export const THUMB_PATH_RE = /^cad\/([a-z0-9][a-z0-9-]{0,39})\/\.cache\/thumb-(\d+)\.png$/;
const THUMB_RE = /^thumb-(\d+)\.png$/;
export const thumbName = (rev: number): string => `thumb-${rev}.png`;

/** The revisions that have a preview file in a part's cache folder, ascending. */
export function previewRevs(partDir: string): number[] {
  try {
    return readdirSync(join(partDir, CACHE_DIR))
      .map((n) => PREVIEW_RE.exec(n)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Keep the newest `keep` thumbnails of a part. */
export function pruneThumbs(partDir: string, keep = PREVIEWS_KEPT): void {
  try {
    const revs = readdirSync(join(partDir, CACHE_DIR))
      .map((n) => THUMB_RE.exec(n)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    for (const r of revs.slice(0, Math.max(0, revs.length - keep))) rmSync(join(partDir, CACHE_DIR, thumbName(r)), { force: true });
  } catch {
    /* no cache folder */
  }
}

/** Step 4b (Phase A4): a small PNG of the part for its card, in the camera the process has (so the
 *  agent's own view is not moved). Never throws. */
export async function exportThumbnail(call: Call, ref: PartRef, rev: number): Promise<{ path: string; sha: string } | undefined> {
  try {
    const path = join(ref.dir, CACHE_DIR, thumbName(rev));
    const r = await call("screenshot", { width: 160, height: 120, path });
    if (r.isError || !existsSync(path)) return undefined;
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    pruneThumbs(ref.dir);
    return { path: relative(ref.worktree, path), sha };
  } catch {
    return undefined;
  }
}

/** Delete every preview older than the newest `keep`. Returns the revisions removed. */
export function prunePreviews(partDir: string, keep = PREVIEWS_KEPT): number[] {
  const revs = previewRevs(partDir);
  const drop = revs.slice(0, Math.max(0, revs.length - keep));
  for (const r of drop) rmSync(join(partDir, CACHE_DIR, previewName(r)), { force: true });
  return drop;
}

/** The newest preview on disk for a part as `{ rev, path }` (path worktree-relative), if any. */
export function newestPreview(ref: PartRef): { rev: number; path: string } | undefined {
  const rev = previewRevs(ref.dir).at(-1);
  return rev === undefined ? undefined : { rev, path: relative(ref.worktree, join(ref.dir, CACHE_DIR, previewName(rev))) };
}

/**
 * Step 4: write `.cache/preview-<rev>.glb` through the part's own process and prune. Design bodies
 * only — an imported reference is not the part. Never throws: the preview is a picture, not a check.
 */
export async function exportPreview(call: Call, ref: PartRef, rev: number, designBodies: string[]): Promise<{ preview?: string; sha?: string; error?: string }> {
  if (designBodies.length === 0) return {}; // nothing to show yet; not an error
  try {
    const dir = join(ref.dir, CACHE_DIR);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, previewName(rev));
    const r = await call("export", { path, format: "glb", bodies: designBodies });
    if (r.isError || !existsSync(path)) return { error: r.text.slice(0, 300) || "no preview file was written" };
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    prunePreviews(ref.dir);
    return { preview: relative(ref.worktree, path), sha };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export interface RefreshDeps {
  locks: LockStore;
  /** This machine's serverId: a lock found by the repo's PATH counts only when made here. */
  machine?(): string | undefined;
  /** The number the refresh about to be broadcast gets (`cad.design.rev`). Omitted → no preview is written. */
  nextRev?(ref: PartRef): number;
  /** Step 5: called once per refresh with the outcome (measurement, gate, preview). */
  onResult(outcome: RefreshOutcome, slot: SlotContext): void | Promise<void>;
  now?: () => string;
  /** Test seam: replace the gate's evaluation (to prove a throwing gate fails closed). */
  evaluateImpl?: (input: GateInput) => GateResult;
  /** Test seam: called before measuring (to prove a throwing refresh fails closed). */
  beforeMeasure?: (ref: PartRef) => void;
  /** Phase A4: advisory checks the service holds for a part (a concept's picture score). */
  advisoryFor?: (ref: PartRef) => GateCheck[];
}

type Call = (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>;

export interface DesignRead {
  version: string;
  designBodies: string[];
  /** Bodies made by a `BaseFeature` (a STEP import): the references. */
  referenceBodies: string[];
  featureErrors: FeatureIssue[];
  warnings: string[];
  params: CadParamInfo[];
}

const need = (r: McpToolResult, what: string): any => {
  if (r.isError || r.json === undefined) throw new Error(`${what} failed: ${r.text.slice(0, 300) || "no reply"}`);
  return r.json;
};

/** Bodies with their creating feature, the timeline's errors and warnings, parameters, the version. */
export async function readDesign(call: Call): Promise<DesignRead> {
  const d = need(await call("inspect_design", { measure: false, sketches: false, timeline: "summary", bodies: true }), "inspect_design");
  const timeline: any[] = Array.isArray(d.timeline) ? d.timeline : [];
  const typeOf = new Map<unknown, string>(timeline.map((f) => [f?.id, String(f?.type ?? "")]));
  const bodies: any[] = Array.isArray(d.bodies) ? d.bodies : [];
  // §4.14 #3: a body created by a BaseFeature is an imported reference, not the part.
  const designBodies = bodies.filter((b) => b && typeof b.name === "string" && typeOf.get(b.feature) !== "BaseFeature").map((b) => String(b.name));
  const referenceBodies = bodies.filter((b) => b && typeof b.name === "string" && typeOf.get(b.feature) === "BaseFeature").map((b) => String(b.name));
  const params: any[] = Array.isArray(d.params) ? d.params : [];
  const version = need(await call("version", {}), "version").version;
  return {
    version: String(version ?? ""),
    designBodies,
    referenceBodies,
    featureErrors: timeline.filter((f) => f?.error).map((f) => ({ id: f.id, feature: String(f.name ?? f.id), message: String(f.error) })),
    warnings: timeline.filter((f) => f?.warning).map((f) => `${String(f.name ?? f.id)}: ${String(f.warning)}`),
    params: params
      .filter((p) => p && p.model !== true)
      .map((p) => ({ name: String(p.name), expression: String(p.expression ?? ""), value: Number(p.value), unit: String(p.unit ?? ""), ...(p.error ? { error: String(p.error) } : {}) })),
  };
}

/** Measure the design bodies: volume is their sum, the bounding box their union (then sorted). */
export async function measureDesign(call: Call, designBodies: string[]): Promise<{ bbox: [number, number, number]; volume: number; faces: number; bodies: number; holes: HoleRow[] }> {
  // `inspect.measure {bodies: []}` means "all", which would include references: never send it empty.
  if (designBodies.length === 0) return { bbox: [0, 0, 0], volume: 0, faces: 0, bodies: 0, holes: [] };
  const m = need(await call("execute", { command: "inspect.measure", params: { bodies: designBodies } }), "inspect.measure");
  const list: any[] = Array.isArray(m.bodies) ? m.bodies : [];
  if (list.length !== designBodies.length) throw new Error(`inspect.measure answered ${list.length} bodies; ${designBodies.length} were asked for`);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let volume = 0;
  let faces = 0;
  for (const b of list) {
    if (b?.error) throw new Error(`body ${b.name} could not be measured: ${b.error}`);
    if (typeof b?.volume_mm3 !== "number" || !Number.isFinite(b.volume_mm3)) throw new Error(`body ${b?.name} has no volume (is it a closed solid?)`);
    volume += b.volume_mm3;
    faces += Number(b.faces ?? 0);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, Number(b.bbox?.min?.[k]));
      max[k] = Math.max(max[k]!, Number(b.bbox?.max?.[k]));
    }
  }
  const size = [0, 1, 2].map((k) => max[k]! - min[k]!);
  if (!size.every((v) => Number.isFinite(v))) throw new Error("a body has no bounding box");
  const tables: HoleRow[][] = [];
  for (const body of designBodies) tables.push(await holeTable(call, body));
  return { bbox: size.sort((a, b) => a - b) as [number, number, number], volume, faces, bodies: designBodies.length, holes: mergeHoleTables(tables) };
}

/** Everything the gate reads that is not the live process: the repo files and the lock store. An
 *  approval is found under ANY identity of the repo (its remote, its main checkout's path). */
export function readLocked(ref: PartRef, locks: LockReader, machine?: string): Pick<GateInput, "part" | "lock" | "rules" | "rulesLock"> & { repo: string; identity: RepoIdentity } {
  const identity = repoIdentity(ref.worktree);
  return { repo: identity.key, identity, part: readPartFile(ref.dir), lock: locks.findPart(identity, ref.part, machine), rules: readRules(ref.worktree), rulesLock: locks.findRules(identity, machine) };
}

/**
 * The gap a part is blocked on: the lock store's record wins (it cannot be edited away in the file);
 * a `gap` in `part.json` with no newer record in the store counts too (a fresh clone).
 */
export function gapOf(part: PartRead, store: { gap?: GapRecord; at: string } | undefined): GapRecord | undefined {
  if (store?.gap) return store.gap;
  const fileGap = part.kind === "ok" ? part.file.gap : undefined;
  if (!fileGap) return undefined;
  if (store && Date.parse(store.at) >= Date.parse(fileGap.at)) return undefined; // cleared after it was reported
  return fileGap;
}

/**
 * Phase A4: the reference checks for a part, inside its queue slot. Nothing is asked of SolidCraft
 * for a part that names no reference.
 */
export async function referenceGate(call: Call, ref: PartRef, part: PartRead, scriptSha: string | undefined, design: Pick<DesignRead, "designBodies" | "referenceBodies">): Promise<{ checks: GateCheck[]; unverified: boolean }> {
  if (part.kind !== "ok") return { checks: [], unverified: false };
  const must = part.file.expectations?.noInterferenceWith ?? [];
  const names = [...new Set([...must, ...(part.file.refs ?? []).map((r) => r.name)])];
  if (names.length === 0) return { checks: [], unverified: false };
  // The embedded text is read from design.json — and only when it IS the script the process runs.
  const disk = readDesignFile(ref.dir);
  const embedded = disk.script && scriptSha !== undefined && disk.scriptSha === scriptSha ? embeddedReferences(disk.script) : undefined;
  const integrity = referenceChecks(names, (n) => referenceOnDisk(ref, n), embedded);
  const checks = [...integrity.checks];
  for (const name of [...new Set(must)].sort()) {
    const emb = embedded?.find((e) => e.file === name);
    if (!emb) {
      checks.push({ id: `interference ${name}`, expected: `no overlap with refs/${name}`, measured: `refs/${name} is not in the design, so nothing could be checked`, ok: false, hard: true });
      continue;
    }
    const missing = emb.bodies.filter((b) => !design.referenceBodies.includes(b));
    if (emb.bodies.length === 0 || missing.length) {
      checks.push({ id: `interference ${name}`, expected: `no overlap with refs/${name}`, measured: `the reference's bodies (${missing.join(", ") || "none listed"}) are not in the design`, ok: false, hard: true });
      continue;
    }
    if (design.designBodies.length === 0) {
      checks.push({ id: `interference ${name}`, expected: `no overlap with refs/${name}`, measured: "no design bodies yet", ok: true, hard: true });
      continue;
    }
    let reply: McpToolResult | { error: string };
    try {
      reply = await call("execute", interferenceRequest(design.designBodies, emb.bodies));
    } catch (e) {
      reply = { error: e instanceof Error ? e.message : String(e) };
    }
    checks.push(interferenceCheck(name, reply));
  }
  return { checks, unverified: integrity.unverified };
}

const paramValues = (params: CadParamInfo[]): Record<string, number> => Object.fromEntries(params.filter((p) => Number.isFinite(p.value)).map((p) => [p.name, p.value]));

/** What `measureAndEvaluate` gathered: the gate's verdict and everything it was reached from. */
export interface GateEvaluation {
  gate: GateResult;
  measurement?: Measurement;
  /** The full hole table (depths, counterbores). */
  holes: HoleRow[];
  design: DesignRead;
  scriptSha?: string;
}

export interface EvaluateDeps {
  /** Read only: nothing here ever writes an approval. */
  locks: LockReader;
  machine?: string;
  evaluateImpl?: (input: GateInput) => GateResult;
  /** Advisory checks (a concept's picture score). */
  advisory?: GateCheck[];
}

/**
 * Steps 2 and 3 WITHOUT any write: measure the design bodies of the process behind `call`, read the
 * repo files and the lock store for `ref`, and evaluate the gate. This is the ONE evaluation the live
 * refresh and the merge guard (`verify.ts`) share, so the two can never judge a part differently.
 * `slot` is what the manager knows about the process: the sha of the script it holds and its state
 * (a disk conflict, a script that did not replay). Throws only when the design cannot be read at
 * all — callers turn that into an `unverified` result (fail closed).
 */
export async function measureAndEvaluate(call: Call, ref: PartRef, slot: { scriptSha: string | undefined; state: Pick<PartState, "conflict" | "reason" | "replayFailure"> }, deps: EvaluateDeps): Promise<GateEvaluation> {
  const design = await readDesign(call);
  const scriptSha = slot.scriptSha;
  let measurement: Measurement | undefined;
  let holes: HoleRow[] = [];
  let measureError: string | undefined;
  try {
    const m = await measureDesign(call, design.designBodies);
    holes = m.holes;
    measurement = { bbox: m.bbox, volume: m.volume, faces: m.faces, bodies: m.bodies, holes: holeSummary(m.holes), scriptSha: scriptSha ?? "", solidcraft: design.version };
  } catch (e) {
    measureError = `could not measure: ${e instanceof Error ? e.message : String(e)}`;
  }

  // The accepted numbers were fixed when the expectations were approved. Nothing is pinned here:
  // this only ever READS the lock store.
  const locked = readLocked(ref, deps.locks, deps.machine);
  const params = paramValues(design.params);
  const state = slot.state;
  const refs = await referenceGate(call, ref, locked.part, scriptSha, design);
  const gap = gapOf(locked.part, deps.locks.findGap(locked.identity, ref.part, deps.machine));
  const advisory = deps.advisory ?? [];
  const gate = evaluateGate(
    {
      ...locked,
      params,
      measurement,
      measureError,
      scriptSha,
      solidcraft: design.version,
      featureErrors: design.featureErrors,
      warnings: design.warnings,
      designFailure: state.conflict ? state.reason : state.replayFailure ? `design.json failed to replay: ${state.replayFailure}` : undefined,
      ...(refs.checks.length || advisory.length ? { extraChecks: [...refs.checks, ...advisory] } : {}),
      ...(refs.unverified ? { extraUnverified: true } : {}),
      ...(gap ? { gap } : {}),
    },
    deps.evaluateImpl,
  );
  return { gate, measurement, holes, design, scriptSha };
}

export function makeRefreshJob(deps: RefreshDeps): RefreshJob {
  const now = deps.now ?? (() => new Date().toISOString());
  return async (slot) => {
    const t0 = performance.now();
    const { ref } = slot;
    const call: Call = (tool, args) => slot.call(tool, args);
    let outcome: RefreshOutcome;
    let designBodies: string[] | undefined;
    try {
      deps.beforeMeasure?.(ref);
      const { gate, measurement, holes, design, scriptSha } = await measureAndEvaluate(call, ref, { scriptSha: slot.scriptSha(), state: slot.state() }, {
        locks: deps.locks,
        machine: deps.machine?.(),
        evaluateImpl: deps.evaluateImpl,
        advisory: deps.advisoryFor?.(ref) ?? [],
      });
      designBodies = design.designBodies;
      if (measurement) {
        const measured: Measured = { at: now(), solidcraft: measurement.solidcraft, scriptSha: measurement.scriptSha, bbox: measurement.bbox, volume: measurement.volume, faces: measurement.faces, bodies: measurement.bodies, holes: measurement.holes, warnings: design.warnings };
        try {
          writeMeasured(ref.dir, measured); // never over a corrupt part.json; skipped when nothing changed
        } catch (e) {
          gate.warnings.push(`part.json could not be updated with the measurement: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      outcome = { ref, gate, measurement, holes, params: design.params, scriptSha, ms: performance.now() - t0, forced: slot.forced, designBodies: design.designBodies, referenceBodies: design.referenceBodies };
    } catch (e) {
      outcome = { ref, gate: gateError(e instanceof Error ? e.message : String(e)), holes: [], params: slot.params(), scriptSha: slot.scriptSha(), ms: performance.now() - t0, forced: slot.forced };
    }
    const failing = failingLines(outcome.gate);
    slot.setVerdict({
      status: outcome.gate.state === "pass" ? "pass" : outcome.gate.state === "fail" ? "fail" : "unverified",
      ...(outcome.gate.state === "fail" && failing.length ? { reason: `the gate fails — ${failing.join("; ")}` } : {}),
    });

    // Step 4: the preview. Its number is the revision this refresh will be broadcast as.
    if (deps.nextRev) {
      try {
        outcome.rev = deps.nextRev(ref);
        if (designBodies === undefined) designBodies = (await readDesign(call)).designBodies; // the gate half threw
        const p = await exportPreview(call, ref, outcome.rev, designBodies);
        if (p.preview) outcome.preview = p.preview;
        if (p.sha) outcome.previewSha = p.sha;
        if (p.error) outcome.previewError = p.error;
        if (p.preview) {
          const thumb = await exportThumbnail(call, ref, outcome.rev);
          if (thumb) {
            outcome.thumbnail = thumb.path;
            outcome.thumbnailSha = thumb.sha;
          }
        }
      } catch (e) {
        outcome.previewError = e instanceof Error ? e.message : String(e);
      }
      outcome.ms = performance.now() - t0;
    }
    try {
      outcome.scriptBytes = statSync(join(ref.dir, DESIGN_FILE)).size;
    } catch {
      /* no design.json yet */
    }

    try {
      await deps.onResult(outcome, slot); // step 5: the service broadcasts `cad.design`
    } catch {
      /* a broadcast failure must never undo a measurement */
    }
  };
}
