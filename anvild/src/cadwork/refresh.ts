/**
 * The refresh (agent-cad-and-browser spec §4.3 steps 2–5, §4.14 #2 #3 #7): what runs, inside the
 * part's queue, after a change's script write — debounced during a burst, always when the queue
 * drains, and synchronously first for `check_part` and friends (see `CadManager.setRefresh`).
 *
 *   2. MEASURE   design bodies only (bodies made by a `BaseFeature` — a STEP import — are left
 *                out), the hole table, feature errors and warnings.
 *   3. GATE      evaluate (./gate.ts), write `part.json.measured`, set the part's verdict.
 *   4. PREVIEW   — Phase A3 (see the marked hook at the end of `makeRefreshJob`).
 *   5. BROADCAST `onResult` hands the outcome to the service, which sends `cad.design`.
 *
 * FAIL CLOSED: anything that throws in here ends as an `unverified` gate result with the error
 * listed, never as `pass`, and never as an exception into the manager's queue.
 */
import { evaluateGate, failingLines, gateError, type GateInput, type GateResult, type Measurement } from "./gate";
import { holeSummary, holeTable, mergeHoleTables, type HoleRow } from "./holes";
import { repoKey, type LockStore, type PartLock } from "./locks";
import type { CadParamInfo, FeatureIssue, RefreshJob, SlotContext } from "./manager";
import type { McpToolResult } from "./mcp-client";
import type { PartRef } from "./partfolder";
import { evaluateExpectations, lockedBlockSha, readPartFile, writeMeasured, type Measured } from "./partfile";
import { readRules } from "./rules";

export interface RefreshOutcome {
  ref: PartRef;
  gate: GateResult;
  measurement?: Measurement;
  /** The full hole table (depths, counterbores) — richer than `measurement.holes`. */
  holes: HoleRow[];
  params: CadParamInfo[];
  scriptSha?: string;
  /** How long measuring and evaluating took. */
  ms: number;
  forced: boolean;
}

export interface RefreshDeps {
  locks: LockStore;
  /** Record a daemon-made change to a lock (pinning the first evaluated numbers) and sync it. */
  pinValues(lock: PartLock): void;
  /** Step 5, and where Phase A3 hangs the preview: called once per refresh with the outcome. */
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

/** Everything the gate reads that is not the live process: the repo files and the lock store. */
export function readLocked(ref: PartRef, locks: LockStore): Pick<GateInput, "part" | "lock" | "rules" | "rulesLock"> & { repo: string } {
  const repo = repoKey(ref.worktree);
  return { repo, part: readPartFile(ref.dir), lock: locks.getPart(repo, ref.part), rules: readRules(ref.worktree), rulesLock: locks.getRules(repo) };
}

const paramValues = (params: CadParamInfo[]): Record<string, number> => Object.fromEntries(params.filter((p) => Number.isFinite(p.value)).map((p) => [p.name, p.value]));

export function makeRefreshJob(deps: RefreshDeps): RefreshJob {
  const now = deps.now ?? (() => new Date().toISOString());
  return async (slot) => {
    const t0 = performance.now();
    const { ref } = slot;
    const call: Call = (tool, args) => slot.call(tool, args);
    let outcome: RefreshOutcome;
    try {
      deps.beforeMeasure?.(ref);
      const design = await readDesign(call);
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

      const locked = readLocked(ref, deps.locks);
      const params = paramValues(design.params);
      // The first time every formula of a freshly recorded block evaluates, the daemon pins those
      // numbers as the accepted ones (the parameters did not exist yet when the block was recorded).
      if (locked.part.kind === "ok" && locked.part.file.expectations && locked.lock && !locked.lock.values && locked.lock.sha === lockedBlockSha(locked.part.file)) {
        try {
          const pinned = { ...locked.lock, values: evaluateExpectations(locked.part.file.expectations, params), at: now() };
          deps.pinValues(pinned);
          locked.lock = pinned;
        } catch {
          /* not evaluable yet — the gate reports which formula */
        }
      }
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

    // ── PHASE A3 HOOK (§4.3 step 4) ──────────────────────────────────────────────────────────────
    // Export `.cache/preview-<rev>.glb` here with `slot.call("export", …)` and prune older previews,
    // then pass the path on through the outcome so step 5 can put it in `cad.design.preview`.
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    try {
      await deps.onResult(outcome, slot); // step 5: the service broadcasts `cad.design`
    } catch {
      /* a broadcast failure must never undo a measurement */
    }
  };
}
