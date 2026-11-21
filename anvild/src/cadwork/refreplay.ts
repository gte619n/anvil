/**
 * What a reference measures AS IMPORTED, worked out from its embedded STEP text alone: a throwaway
 * SolidCraft process (a `CadManager` of its own with no refresh job, in a temp folder holding only
 * that STEP file — `--allow-path` is that folder) runs `file.insert_step` exactly as `import_reference`
 * did, with the design active, and measures the bodies it made. Nothing else of the design is loaded,
 * so no feature, edit of the import feature or move can change the answer.
 *
 * The gate uses this for a reference the lock store holds no measurement of (a part approved before
 * measurements were recorded, or a reference imported before the part had an approval), so such a
 * part needs no owner action and is still checked exactly. Answers are cached per binary and sha.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CadManager, type CadManagerOptions } from "./manager";
import type { PartRef } from "./partfolder";
import { importFeatureName, readReferenceMeasures, referenceName, type ReferenceMeasure } from "./refs";

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

async function replayOnce(cli: { path: string }, step: string, file: string, sha256: string, opts: ReferenceReplayOptions): Promise<ReferenceMeasure> {
  const root = realpathSync(mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "anvil-refreplay-")));
  const manager = new CadManager({ ...opts.manager, maxProcs: 1, resolveCli: () => cli, refresh: undefined, tmpRoot: join(root, "tmp") });
  try {
    const dir = join(root, "cad", "reference");
    mkdirSync(dir, { recursive: true });
    const name = referenceName(file);
    const path = join(dir, name);
    writeFileSync(path, step);
    const box: PartRef = { key: dir, worktree: root, part: "reference", dir };
    return await manager.run(box, async (slot) => {
      const r = await slot.call("execute", { command: "file.insert_step", params: { path, name: importFeatureName(name) } });
      if (r.isError) throw new Error(`SolidCraft could not import the reference's STEP text: ${r.text.slice(0, 300)}`);
      const bodies: string[] = Array.isArray(r.json?.created_bodies) ? r.json.created_bodies.map(String) : [];
      if (bodies.length === 0) throw new Error("SolidCraft imported the reference's STEP text but reported no bodies");
      const m = await slot.call("execute", { command: "inspect.measure", params: { bodies } });
      if (m.isError) throw new Error(`the replayed reference could not be measured: ${m.text.slice(0, 300)}`);
      return { sha256, bodies: readReferenceMeasures(m.json, bodies) };
    });
  } finally {
    await manager.shutdown().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
