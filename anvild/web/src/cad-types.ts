// Shared types + pure classifier for the CAD viewer (web side). Kept dependency-free so both
// cad.ts (viewer host) and cad-ecad.ts (ECAD adapters) import from one stable contract.
// See docs/plans/2026-11-06-cad-viewer.md §3.3.

/** Which rendering pipeline a file belongs to, decided purely from its extension. */
export type CadKind = "mesh" | "brep" | "kicad-pcb" | "kicad-sch" | "gerber";

/** Mesh formats three.js loads directly (client-side), keyed by lower-case extension (no dot). */
export const MESH_EXTS = new Set(["stl", "obj", "3mf", "ply", "gltf", "glb", "dae"]);
/** B-rep formats the daemon tessellates to GLB (server-side via occt-import-js). */
export const BREP_EXTS = new Set(["step", "stp", "iges", "igs", "fcstd"]);
/** Gerber/Excellon layer + drill extensions (client-side 2D stackup via tracespace). */
export const GERBER_EXTS = new Set([
  "gbr", "ger", "gerber", "gtl", "gbl", "gts", "gbs", "gto", "gbo", "gtp", "gbp",
  "gko", "gm1", "gm2", "drl", "xln", "txt", "drd", "nc", "tap",
]);

const EXT_RE = /\.([a-z0-9]+)$/i;

/** Lower-case extension (no dot) of a path, or "" if none. */
export function extOf(path: string): string {
  const m = EXT_RE.exec(path);
  return m ? m[1]!.toLowerCase() : "";
}

/**
 * Classify a path into a CAD pipeline, or null if it isn't a CAD file we handle.
 * KiCad native files are matched by their double-barrelled extensions first.
 */
export function classifyCad(path: string): CadKind | null {
  const p = path.toLowerCase();
  if (p.endsWith(".kicad_pcb")) return "kicad-pcb";
  if (p.endsWith(".kicad_sch")) return "kicad-sch";
  const ext = extOf(path);
  if (MESH_EXTS.has(ext)) return "mesh";
  if (BREP_EXTS.has(ext)) return "brep";
  // .txt is ambiguous (could be a plain text file) — only treat as Gerber drill when it is NOT
  // obviously something else. The caller (panel.ts) only reaches classifyCad for files it opens;
  // we keep .txt OUT of the Gerber set here to avoid hijacking every text file, and let an explicit
  // "open as Gerber" affordance handle the rare .txt drill case.
  if (ext !== "txt" && GERBER_EXTS.has(ext)) return "gerber";
  return null;
}

/**
 * Injected data-access the viewer modules use, so they never reach into WS/fleet internals.
 * Wired by panel.ts/cad.ts at call time (DL-5: all over REST + a thin WS list helper).
 */
export interface CadIo {
  /** Absolute URL for a worktree file (daemon-relative → absolute, fleet-routed). */
  fileUrl(path: string): string;
  /** Absolute URL for the server-side CAD conversion of a B-rep/kicad-3d file. */
  cadUrl(path: string, lod: number): string;
  /** Fetch raw bytes of a worktree file. */
  fetchBytes(path: string): Promise<Uint8Array>;
  /** Fetch text of a worktree file. */
  fetchText(path: string): Promise<string>;
  /** List sibling entries in the directory containing `path` (names only, same dir). */
  listSiblings(path: string): Promise<string[]>;
  /** Save-to-project snapshot target (D16): PUT a PNG into the worktree; returns the written path.
   *  Optional — contexts without a session (none today) omit it and the viewer hides the action. */
  saveSnapshot?(name: string, png: Blob): Promise<string>;
  /** Insert-into-chat snapshot target (D16): drop a PNG into the conversation as an attachment. */
  insertSnapshot?(name: string, png: Blob): Promise<void>;
}

/** Device render budget (max triangles / max GLB bytes) the client advertises to the daemon. */
export interface LodBudget {
  maxTriangles: number;
  maxBytes: number;
}

/** A conservative budget for phones; desktop gets a larger one. Chosen by cad.ts at runtime. */
export const PHONE_LOD: LodBudget = { maxTriangles: 1_500_000, maxBytes: 48 * 1024 * 1024 };
export const DESKTOP_LOD: LodBudget = { maxTriangles: 8_000_000, maxBytes: 256 * 1024 * 1024 };
