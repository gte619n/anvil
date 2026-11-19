/**
 * The refresh (agent-cad-and-browser spec §4.3 steps 2–5, §4.14 #2 #3 #7): what runs, inside the
 * part's queue, after a change's script write — debounced during a burst, always when the queue
 * drains, and synchronously first for `check_part` and friends (see `CadManager.setRefresh`).
 *
 *   2. MEASURE   design bodies only (bodies made by a `BaseFeature` — a STEP import — are left
 *                out), the hole table, feature errors and warnings.
 *   3. GATE      evaluate (./gate.ts), write `part.json.measured`, set the part's verdict.
 *   4. PREVIEW   export the design bodies to `.cache/preview-<rev>.glb` (metres, Y up) and keep the
 *                newest three. An empty design has no preview. A failed export never touches the gate.
 *   5. BROADCAST `onResult` hands the outcome to the service, which sends `cad.design`.
 *
 * FAIL CLOSED: anything that throws in here ends as an `unverified` gate result with the error
 * listed, never as `pass`, and never as an exception into the manager's queue.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { evaluateGate, failingLines, gateError, type GateInput, type GateResult, type Measurement } from "./gate";
import { holeSummary, holeTable, mergeHoleTables, type HoleRow } from "./holes";
import { repoIdentity, type LockStore, type RepoIdentity } from "./locks";
import type { CadParamInfo, FeatureIssue, RefreshJob, SlotContext } from "./manager";
import type { McpToolResult } from "./mcp-client";
import type { PartRef } from "./partfolder";
import { readPartFile, writeMeasured, type Measured } from "./partfile";
import { CACHE_DIR } from "./poststep";
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
}

/** How many `.cache/preview-<rev>.glb` files are kept per part (§4.3 step 4). */
export const PREVIEWS_KEPT = 3;
const PREVIEW_RE = /^preview-(\d+)\.glb$/;
export const previewName = (rev: number): string => `preview-${rev}.glb`;
/** A worktree-relative path that names a preview of `part` — the only shape the preview route serves. */
export const PREVIEW_PATH_RE = /^cad\/([a-z0-9][a-z0-9-]{0,39})\/\.cache\/preview-(\d+)\.glb$/;

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
export async function exportPreview(call: Call, ref: PartRef, rev: number, designBodies: string[]): Promise<{ preview?: string; error?: string }> {
  if (designBodies.length === 0) return {}; // nothing to show yet; not an error
  try {
    const dir = join(ref.dir, CACHE_DIR);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, previewName(rev));
    const r = await call("export", { path, format: "glb", bodies: designBodies });
    if (r.isError || !existsSync(path)) return { error: r.text.slice(0, 300) || "no preview file was written" };
    prunePreviews(ref.dir);
    return { preview: relative(ref.worktree, path) };
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
}

type Call = (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>;

interface DesignRead {
  version: string;
  designBodies: string[];
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
  const params: any[] = Array.isArray(d.params) ? d.params : [];
  const version = need(await call("version", {}), "version").version;
  return {
    version: String(version ?? ""),
    designBodies,
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
export function readLocked(ref: PartRef, locks: LockStore, machine?: string): Pick<GateInput, "part" | "lock" | "rules" | "rulesLock"> & { repo: string; identity: RepoIdentity } {
  const identity = repoIdentity(ref.worktree);
  return { repo: identity.key, identity, part: readPartFile(ref.dir), lock: locks.findPart(identity, ref.part, machine), rules: readRules(ref.worktree), rulesLock: locks.findRules(identity, machine) };
}

const paramValues = (params: CadParamInfo[]): Record<string, number> => Object.fromEntries(params.filter((p) => Number.isFinite(p.value)).map((p) => [p.name, p.value]));

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
      const design = await readDesign(call);
      designBodies = design.designBodies;
      const scriptSha = slot.scriptSha();
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
      // a refresh only ever READS the lock store.
      const locked = readLocked(ref, deps.locks, deps.machine?.());
      const params = paramValues(design.params);
      const state = slot.state();
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
          // PHASE A4 HOOK: interference with each reference body goes in `extraChecks` here.
        },
        deps.evaluateImpl,
      );
      if (measurement) {
        const measured: Measured = { at: now(), solidcraft: measurement.solidcraft, scriptSha: measurement.scriptSha, bbox: measurement.bbox, volume: measurement.volume, faces: measurement.faces, bodies: measurement.bodies, holes: measurement.holes, warnings: design.warnings };
        try {
          writeMeasured(ref.dir, measured); // never over a corrupt part.json; skipped when nothing changed
        } catch (e) {
          gate.warnings.push(`part.json could not be updated with the measurement: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      outcome = { ref, gate, measurement, holes, params: design.params, scriptSha, ms: performance.now() - t0, forced: slot.forced };
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
        if (p.error) outcome.previewError = p.error;
      } catch (e) {
        outcome.previewError = e instanceof Error ? e.message : String(e);
      }
      outcome.ms = performance.now() - t0;
    }

    try {
      await deps.onResult(outcome, slot); // step 5: the service broadcasts `cad.design`
    } catch {
      /* a broadcast failure must never undo a measurement */
    }
  };
}
