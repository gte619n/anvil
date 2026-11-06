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

// Bounded so a batch of big assemblies can't peg every core / starve chat + agent traffic (D19).
const MAX_CONCURRENCY = 2;
// LRU byte cap for the converted-GLB cache (D23). 512 MiB keeps plenty of recent models warm.
const CACHE_CAP_BYTES = 512 * 1024 * 1024;

let queue: ConvertQueue | null = null;
let cache: CadCache | null = null;

function ensure(stateDir: string): { queue: ConvertQueue; cache: CadCache } {
  if (!queue) queue = new ConvertQueue(MAX_CONCURRENCY);
  if (!cache) cache = new CadCache(join(stateDir, "cache", "cad"), CACHE_CAP_BYTES);
  return { queue, cache };
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
  const { queue, cache } = ensure(stateDir);
  const ext = extOf(path);
  const kind = classifyExt(ext);

  const key = cache.key(bytes, lod);
  const hit = await cache.get(key);
  if (hit) return { glb: hit, status: 200 };

  try {
    let glb: Uint8Array;
    if (kind === "brep") {
      const res = await queue.enqueue(() => convertCad(bytes, ext, { lodMaxTriangles: lod }));
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
