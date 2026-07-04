import { writeFileSync, renameSync } from "node:fs";

/**
 * [BE-9] Atomic file write: write to a sibling `.tmp` then `rename` over the target. `rename` is
 * atomic on the same filesystem, so a crash mid-write can never leave the target truncated — it is
 * always the complete old or the complete new content. Use this for every persisted daemon store
 * (session registry, push registries, budget, schedule, metrics) so a torn write can't silently
 * reset state to defaults on the next load.
 *
 * On any failure before the rename, the original target is left untouched (the caller sees the throw
 * and can keep the in-memory state authoritative).
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, opts?: { mode?: number }): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
  renameSync(tmp, path);
}
