// Daemon CAD conversion service: the single owner of the bounded conversion queue (D19) + the
// content-hash shared disk cache (D23), fronting convertCad (B-rep → GLB) and the kicad-cli 3D
// path (Phase 5). The HTTP `/cad` route calls serveCad(); everything else is an implementation
// detail. See docs/plans/2026-11-06-cad-viewer.md §3.2.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CadCache } from "./cache";
import { convertCad } from "./convert";
import { classifyExt, extOf, isKicadPcb } from "./formats";
import { kicadPcbToGlb } from "./kicad";
import { ConvertQueue } from "./queue";
import { CadConvertError } from "./types";

// Resource limits are env-configurable (owner verdict V5); the defaults below preserve prior
// behavior. All are parsed defensively — a missing/NaN/non-positive value falls back to the default.
//   ANVIL_CAD_CONCURRENCY  max simultaneous conversions (D19); default 2. Bounded so a batch of big
//                          assemblies can't peg every core / starve chat + agent traffic.
//   ANVIL_CAD_CACHE_MB     LRU byte cap (MiB) for the converted-GLB cache (D23); default 512.
//   ANVIL_CAD_TIMEOUT_MS   per-conversion OCCT/tessellation timeout; default 60000 (DEFAULT_TIMEOUT_MS).
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_CACHE_MB = 512;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Positive-number env read; returns `def` on missing, non-numeric, NaN, or non-positive values. */
function envPositive(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Resolve the env-configurable CAD resource limits (re-read each call so env changes take effect). */
export function readEnvConfig(): { concurrency: number; cacheCapBytes: number; timeoutMs: number } {
  return {
    concurrency: Math.floor(envPositive("ANVIL_CAD_CONCURRENCY", DEFAULT_CONCURRENCY)),
    cacheCapBytes: Math.floor(envPositive("ANVIL_CAD_CACHE_MB", DEFAULT_CACHE_MB)) * 1024 * 1024,
    timeoutMs: Math.floor(envPositive("ANVIL_CAD_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)),
  };
}

let queue: ConvertQueue | null = null;
let cache: CadCache | null = null;

function ensure(stateDir: string): { queue: ConvertQueue; cache: CadCache; timeoutMs: number } {
  const cfg = readEnvConfig();
  // Queue + cache are singletons (built from env on first use); timeout is read per call so it can
  // be threaded into each convertCad invocation without rebuilding the queue.
  if (!queue) queue = new ConvertQueue(cfg.concurrency);
  if (!cache) cache = new CadCache(join(stateDir, "cache", "cad"), cfg.cacheCapBytes);
  return { queue, cache, timeoutMs: cfg.timeoutMs };
}

export interface CadServeResult {
  glb?: Uint8Array;
  error?: string;
  status: number;
}

/**
 * Convert a worktree CAD file to a GLB for the browser. `lod` is the client's device triangle
 * budget (D22). B-rep (STEP/IGES/FCStd) goes through occt→gltf-transform; a `.kicad_pcb` opened for
 * 3D goes through kicad-cli. Mesh/ECAD-2D formats are NOT served here (the client renders those
 * directly) — asking for one is a 400.
 */
export async function serveCad(stateDir: string, bytes: Uint8Array, path: string, lod: number): Promise<CadServeResult> {
  const { queue, cache, timeoutMs } = ensure(stateDir);
  const ext = extOf(path);
  const kind = classifyExt(ext);

  const key = cache.key(bytes, lod);
  const hit = await cache.get(key);
  if (hit) return { glb: hit, status: 200 };

  try {
    let glb: Uint8Array;
    if (kind === "brep") {
      const res = await queue.enqueue(() => convertCad(bytes, ext, { lodMaxTriangles: lod, timeoutMs }));
      glb = res.glb;
    } else if (isKicadPcb(path)) {
      glb = await queue.enqueue(() => kicadPcbToGlbBytes(bytes));
    } else {
      return { error: `not a server-converted CAD format: .${ext}`, status: 400 };
    }
    await cache.put(key, glb);
    return { glb, status: 200 };
  } catch (e) {
    const msg = e instanceof CadConvertError ? e.reason : e instanceof Error ? e.message : "conversion failed";
    // Budget/too-large → 413 (client shows the device-ceiling fallback); everything else → 422.
    const status = /budget|too large|exceeds/i.test(msg) ? 413 : 422;
    return { error: msg, status };
  }
}

/** kicad-cli writes a GLB to a file, so stage the pcb + output in a temp dir and read the result back. */
async function kicadPcbToGlbBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "anvil-kicad-"));
  const pcb = join(dir, "board.kicad_pcb");
  const out = join(dir, "board.glb");
  try {
    await writeFile(pcb, bytes);
    await kicadPcbToGlb(pcb, out);
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
