// Content + converter-version keyed LRU cache for converted GLBs on disk (DL / D23). The same
// B-rep bytes at the same LOD always produce the same GLB, so we key on sha256(bytes)+lod+version
// and never re-run OCCT for a cache hit. Bumping CONVERTER_VERSION invalidates every stale entry.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Bump when occt-import-js or gltf-transform (or our tessellation logic) changes output. */
export const CONVERTER_VERSION = "occt0.0.23-gltf4.5.1";

export class CadCache {
  constructor(
    private readonly dir: string,
    private readonly byteCapBytes: number,
  ) {}

  /** Deterministic cache key for a file's bytes at a given LOD + the current converter version. */
  key(bytes: Uint8Array, lod: number): string {
    const sha = createHash("sha256").update(bytes).digest("hex");
    return `${sha}_lod${lod}_v${CONVERTER_VERSION}`;
  }

  private path(key: string): string {
    return join(this.dir, `${key}.glb`);
  }

  /** Return cached GLB bytes, or null on miss. Never throws (a miss must be transparent). */
  async get(key: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.path(key));
      // Touch mtime so LRU treats a read as a recent use.
      const now = new Date();
      await this.touch(this.path(key), now).catch(() => {});
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  /** Store GLB bytes, then evict oldest-by-mtime entries until the dir is under the byte cap. */
  async put(key: string, glb: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(key), glb);
    await this.evictIfNeeded().catch(() => {});
  }

  private async touch(p: string, when: Date): Promise<void> {
    const { utimes } = await import("node:fs/promises");
    await utimes(p, when, when);
  }

  private async evictIfNeeded(): Promise<void> {
    const names = (await readdir(this.dir)).filter((n) => n.endsWith(".glb"));
    const entries: { path: string; size: number; mtime: number }[] = [];
    let total = 0;
    for (const name of names) {
      const p = join(this.dir, name);
      try {
        const s = await stat(p);
        entries.push({ path: p, size: s.size, mtime: s.mtimeMs });
        total += s.size;
      } catch {
        // file vanished between readdir and stat — ignore
      }
    }
    if (total <= this.byteCapBytes) return;
    // Evict oldest first (smallest mtime) until under cap.
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const e of entries) {
      if (total <= this.byteCapBytes) break;
      try {
        await unlink(e.path);
        total -= e.size;
      } catch {
        // ignore; may have been removed concurrently
      }
    }
  }
}
