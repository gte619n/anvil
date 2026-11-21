/**
 * The reference AS IMPORTED, worked out from its embedded STEP text alone, in a throwaway
 * SolidCraft process (a `CadManager` of its own with no refresh job, in a temp folder holding only
 * that STEP file — `--allow-path` is that folder) runs `file.insert_step` exactly as `import_reference`
 * did, with the design active, and measures the bodies it made. Nothing else of the design is loaded,
 * so no feature, edit of the import feature or move can change the answer.
 *
 * Two uses:
 *   - `makeReferenceReplay`: what the import measures (volume, world bbox, faces, centre of mass) —
 *     what the owner's "approve current reference" card records for a part approved before
 *     measurements were kept. Cached per binary and sha.
 *   - `makeTrueReferenceCheck` (the gate, refresh and verify alike): the TRUE import next to the design
 *     bodies and the live reference body, each exported to STEP by the live process at its world
 *     placement and inserted here. `inspect.interference` between every design body and every true
 *     reference body (the must-not-touch check against what was approved, not against a live body a
 *     feature may have reshaped; the reference imported before AND after the design bodies, so each
 *     pair is checked in both orders — refs.ts RESIDUALS), and between each true body and its live
 *     counterpart: the shapes are the same solid ⇔ vol(true) = vol(live) = vol(true ∩ live) (the
 *     overlap `inspect.interference` reports) within a 0.1 nm layer over the import's surface
 *     (refs.ts `shapeTolerance`). Real 0.44.1: two imports of one STEP overlap by exactly their volume; a body touching
 *     a face, or a pin filling a hole exactly, is "no interference"; an export by WORLD name is
 *     written where that placement is. Never cached: the design changes every refresh.
 *
 * Every process is a fresh `CadManager` slot: `mcp --headless --compact --allow-path <its folder>
 * --require-allow-path`, its working folder that folder, the child environment limited (mcp-client),
 * never `--in`. Anything that goes wrong throws; the gate turns that into `unverified`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CadManager, type CadManagerOptions } from "./manager";
import type { PartRef } from "./partfolder";
import type { McpToolResult } from "./mcp-client";
import { importFeatureName, interferenceRequest, readReferenceMeasures, referenceName, type ReferenceBodyMeasure, type ReferenceMeasure } from "./refs";

/** Measure the reference a STEP text makes, as `import_reference` would import it. */
export type ReferenceReplay = (step: string, file: string) => Promise<ReferenceMeasure>;

export interface ReferenceReplayOptions {
  /** The binary (the same one the design runs on). */
  resolveCli: () => { path: string } | undefined;
  /** How processes are spawned (tests point these at the fake). */
  manager?: Pick<CadManagerOptions, "spawn" | "extraEnv" | "requestTimeoutMs" | "batchTimeoutMs" | "clock">;
  /** Where the throwaway folders are made. Default: the system temp folder. */
  tmpRoot?: string;
}

const CACHE_MAX = 64;

export function makeReferenceReplay(opts: ReferenceReplayOptions): ReferenceReplay {
  const cache = new Map<string, Promise<ReferenceMeasure>>();
  return (step, file) => {
    const cli = opts.resolveCli();
    if (!cli) return Promise.reject(new Error("SolidCraft is not installed on this machine, so the reference's import could not be replayed"));
    const sha256 = createHash("sha256").update(step).digest("hex");
    const key = `${cli.path}\n${sha256}`;
    let p = cache.get(key);
    if (!p) {
      p = replayOnce(cli, step, file, sha256, opts);
      p.catch(() => cache.delete(key));
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(key, p);
    }
    return p;
  };
}

/** Run `fn` in a throwaway SolidCraft process whose only allowed folder is a fresh temp folder
 *  (`dir`, also its working folder); the folder and the process are gone when it returns. */
async function inThrowaway<T>(cli: { path: string }, opts: ReferenceReplayOptions, prefix: string, fn: (call: SlotCall, dir: string) => Promise<T>): Promise<T> {
  const root = realpathSync(mkdtempSync(join(opts.tmpRoot ?? tmpdir(), prefix)));
  const manager = new CadManager({ ...opts.manager, maxProcs: 1, resolveCli: () => cli, refresh: undefined, tmpRoot: join(root, "tmp") });
  try {
    const dir = join(root, "cad", "reference");
    mkdirSync(dir, { recursive: true });
    const box: PartRef = { key: dir, worktree: root, part: "reference", dir };
    return await manager.run(box, (slot) => fn((tool, args) => slot.call(tool, args), dir));
  } finally {
    await manager.shutdown().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

type SlotCall = (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>;

/** `file.insert_step` of `path` (in the design, at the identity) → the bodies it made. Throws on
 *  anything else; with `sha256`, also when SolidCraft embedded other bytes. */
async function insertStep(call: SlotCall, path: string, name: string, what: string, sha256?: string): Promise<string[]> {
  const r = await call("execute", { command: "file.insert_step", params: { path, name } });
  if (r.isError) throw new Error(`SolidCraft could not import ${what}: ${r.text.slice(0, 300)}`);
  if (sha256 !== undefined && typeof r.json?.content_sha256 === "string" && r.json.content_sha256 !== sha256) throw new Error(`SolidCraft imported other bytes than ${what} (${String(r.json.content_sha256).slice(0, 12)})`);
  const bodies: string[] = Array.isArray(r.json?.created_bodies) ? r.json.created_bodies.map(String) : [];
  if (bodies.length === 0) throw new Error(`SolidCraft imported ${what} but reported no bodies`);
  return bodies;
}

async function measure(call: SlotCall, bodies: string[], what: string): Promise<ReferenceBodyMeasure[]> {
  return (await measureWithArea(call, bodies, what)).measures;
}

/** `measure`, with each body's surface area (`area_mm2`; the shape tolerance is a depth over it).
 *  `needArea`: a body without a positive area throws (the gate then says unverified). */
async function measureWithArea(call: SlotCall, bodies: string[], what: string, needArea = false): Promise<{ measures: ReferenceBodyMeasure[]; areas: number[] }> {
  const m = await call("execute", { command: "inspect.measure", params: { bodies } });
  if (m.isError) throw new Error(`${what} could not be measured: ${m.text.slice(0, 300)}`);
  const measures = readReferenceMeasures(m.json, bodies);
  const areas = (m.json.bodies as any[]).map((b) => (typeof b?.area_mm2 === "number" && Number.isFinite(b.area_mm2) ? b.area_mm2 : NaN));
  if (needArea) for (const [i, a] of areas.entries()) if (!(a > 0)) throw new Error(`${what}: body ${bodies[i]} has no surface area`);
  return { measures, areas };
}

async function replayOnce(cli: { path: string }, step: string, file: string, sha256: string, opts: ReferenceReplayOptions): Promise<ReferenceMeasure> {
  return inThrowaway(cli, opts, "anvil-refreplay-", async (call, dir) => {
    const name = referenceName(file);
    const path = join(dir, name);
    writeFileSync(path, step);
    const bodies = await insertStep(call, path, importFeatureName(name), "the reference's STEP text", sha256);
    return { sha256, bodies: await measure(call, bodies, "the replayed reference") };
  });
}

// ── the gate's check against the TRUE import ─────────────────────────────────────────────────────

/** One body exported by the live process to STEP, where it is in the world. */
export interface ExportedBody {
  /** The name the gate reports it by (its world name in the live design). */
  label: string;
  bytes: Buffer;
}

export interface TrueReferenceInput {
  /** The `refs/` file name. */
  file: string;
  /** The embedded STEP text (checked by the caller against `refs/` and the approval). */
  step: string;
  /** Every design body placement, for the must-not-touch check. Empty: no interference is run. */
  design: ExportedBody[];
  /** The live reference's bodies, in the import's order, for the shape comparison. */
  live: ExportedBody[];
}

/** How one live reference body compares with its true counterpart. */
export interface ShapeComparison {
  label: string;
  trueVolume: number;
  liveVolume: number;
  /** vol(true ∩ live), from `inspect.interference` between the two. */
  overlap: number;
  /** The true body's surface area (mm²): the shape tolerance is a depth over it. */
  trueArea: number;
}

export interface TrueReferenceResult {
  sha256: string;
  /** The true import, measured. */
  asImported: ReferenceBodyMeasure[];
  /** `inspect.interference` of the design bodies against the true bodies, with every body name
   *  mapped back to the live design's (a true body is called `<name> (as imported)`). Absent when no
   *  design body was given. */
  interference?: McpToolResult;
  /** Per live body; empty when the live body count is not the import's (`bodyCount` says so). */
  shape: ShapeComparison[];
  /** The true import's body count, when the live one differs. */
  bodyCount?: { imported: number; live: number };
}

export type TrueReferenceCheck = (input: TrueReferenceInput) => Promise<TrueReferenceResult>;

/** The exact "interference finished" condition, for the pairwise shape checks. */
function finished(j: any): boolean {
  return !!j && typeof j === "object" && Array.isArray(j.unchecked) && j.unchecked.length === 0 && j.budget_exceeded === false && j.truncated === false && typeof j.count === "number" && Array.isArray(j.interferences) && j.interferences.length === j.count;
}

export function makeTrueReferenceCheck(opts: ReferenceReplayOptions): TrueReferenceCheck {
  return (input) => {
    const cli = opts.resolveCli();
    if (!cli) return Promise.reject(new Error("SolidCraft is not installed on this machine, so the reference could not be checked against its import"));
    const sha256 = createHash("sha256").update(input.step).digest("hex");
    return inThrowaway(cli, opts, "anvil-truecheck-", async (call, dir) => {
      const name = referenceName(input.file);
      const truePath = join(dir, name);
      writeFileSync(truePath, input.step);
      const trueBodies = await insertStep(call, truePath, importFeatureName(name), `refs/${input.file}`, sha256);
      const { measures: asImported, areas } = await measureWithArea(call, trueBodies, `the import of refs/${input.file}`, true);
      const labels = new Map<string, string>(trueBodies.map((b, i) => [b, `${asImported[i]?.name ?? b} (as imported)`]));
      const designBodies: string[] = [];
      for (const [i, d] of input.design.entries()) {
        const p = join(dir, `design-${i}.step`);
        writeFileSync(p, d.bytes);
        const made = await insertStep(call, p, `design-${i}`, `design body ${d.label}`);
        made.forEach((b, k) => labels.set(b, made.length === 1 ? d.label : `${d.label} #${k + 1}`));
        designBodies.push(...made);
      }
      let interference: McpToolResult | undefined;
      if (designBodies.length) {
        // Measured (refs.ts, RESIDUALS): `inspect.interference` drops an overlap below about
        // (d / 1000)³ mm³, d the bounding-box diagonal of the body it takes first — here the one made
        // first. So the true reference is imported a second time AFTER the design bodies, and every
        // design body is checked against both copies: each pair in both orders, the floor the smaller
        // body's. Every overlap with either copy is an overlap with the true import; a pair found
        // against both is reported once, by its larger volume.
        const again = await insertStep(call, truePath, `${importFeatureName(name)}-again`, `refs/${input.file} (second import)`, sha256);
        if (again.length !== trueBodies.length) throw new Error(`refs/${input.file} imported as ${trueBodies.length} bodies, then as ${again.length}`);
        again.forEach((b, i) => labels.set(b, labels.get(trueBodies[i]!)!));
        const r = await call("execute", interferenceRequest(designBodies, [...trueBodies, ...again]));
        if (r.json && Array.isArray(r.json.interferences)) {
          const byPair = new Map<string, any>();
          for (const x of r.json.interferences as any[]) {
            const m = { ...x, a: labels.get(String(x?.a)) ?? x?.a, b: labels.get(String(x?.b)) ?? x?.b };
            const key = JSON.stringify([m.a, m.b].map(String).sort());
            const had = byPair.get(key);
            if (!had || !(typeof had.volume_mm3 === "number" && had.volume_mm3 >= (typeof m.volume_mm3 === "number" ? m.volume_mm3 : -Infinity))) byPair.set(key, m);
          }
          const interferences = [...byPair.values()];
          const unchecked = Array.isArray(r.json.unchecked) ? r.json.unchecked.map((u: any) => (u && typeof u === "object" && !Array.isArray(u) ? { ...u, a: labels.get(String(u.a)) ?? u.a, b: labels.get(String(u.b)) ?? u.b } : u)) : r.json.unchecked;
          const json = { ...r.json, interferences, ...(typeof r.json.count === "number" && r.json.count === r.json.interferences.length ? { count: interferences.length } : {}), ...(unchecked !== undefined ? { unchecked } : {}) };
          interference = { ...r, json };
        } else interference = r;
      }
      if (input.live.length !== trueBodies.length) return { sha256, asImported, ...(interference ? { interference } : {}), shape: [], bodyCount: { imported: trueBodies.length, live: input.live.length } };
      const shape: ShapeComparison[] = [];
      for (const [i, l] of input.live.entries()) {
        const p = join(dir, `live-${i}.step`);
        writeFileSync(p, l.bytes);
        const made = await insertStep(call, p, `live-${i}`, `the live reference body ${l.label}`);
        if (made.length !== 1) throw new Error(`the live reference body ${l.label} came back as ${made.length} bodies`);
        const [lm] = await measure(call, made, `the live reference body ${l.label}`);
        const r = await call("execute", { command: "inspect.interference", params: { bodies: [trueBodies[i]!, made[0]!] } });
        if (r.isError || !finished(r.json)) throw new Error(`the live reference body ${l.label} could not be compared with its import: ${r.text.slice(0, 300) || "no reply"}`);
        const overlap = (r.json.interferences as any[]).reduce((s, x) => s + (typeof x?.volume_mm3 === "number" ? x.volume_mm3 : NaN), 0);
        if (!Number.isFinite(overlap)) throw new Error(`the overlap of ${l.label} with its import has no volume`);
        shape.push({ label: l.label, trueVolume: asImported[i]!.volume, liveVolume: lm!.volume, overlap, trueArea: areas[i]! });
      }
      return { sha256, asImported, ...(interference ? { interference } : {}), shape };
    });
  };
}
