// Pure extension classifier — mirrors web/src/cad-types.ts so daemon and client agree on which
// pipeline a file belongs to. No deps, deterministic. See docs/plans/2026-11-06-cad-viewer.md §3.3.

import type { CadKind } from "./types";

/** Mesh formats three.js loads directly (client-side), keyed by lower-case extension (no dot). */
export const MESH_EXTS = new Set(["stl", "obj", "3mf", "ply", "gltf", "glb", "dae"]);
/** B-rep formats the daemon tessellates to GLB (server-side via occt-import-js). */
export const BREP_EXTS = new Set(["step", "stp", "iges", "igs", "fcstd"]);
/** Gerber/Excellon layer + drill extensions. */
export const GERBER_EXTS = new Set([
  "gbr", "ger", "gerber", "gtl", "gbl", "gts", "gbs", "gto", "gbo", "gtp", "gbp",
  "gko", "gm1", "gm2", "drl", "xln", "txt", "drd", "nc", "tap",
]);

// Include "_" so double-barrelled KiCad extensions (kicad_pcb / kicad_sch) survive extOf intact.
const EXT_RE = /\.([a-z0-9_]+)$/i;

/** Lower-case extension (no dot) of a path, or "" if none. */
export function extOf(path: string): string {
  const m = EXT_RE.exec(path);
  return m ? m[1]!.toLowerCase() : "";
}

/** True if `ext` (no dot) is a B-rep format we tessellate server-side. */
export function isBrep(ext: string): boolean {
  return BREP_EXTS.has(ext.toLowerCase());
}

/** True if `path` is a KiCad PCB file (matched by its double-barrelled extension). */
export function isKicadPcb(path: string): boolean {
  return path.toLowerCase().endsWith(".kicad_pcb");
}

/**
 * Classify a bare extension (no dot) into a CAD pipeline. Note: KiCad native files use
 * double-barrelled extensions (.kicad_pcb / .kicad_sch) so they can only be classified from a
 * full path — callers with a path should match those first; extOf("x.kicad_pcb") === "kicad_pcb".
 */
export function classifyExt(ext: string): CadKind {
  const e = ext.toLowerCase();
  if (e === "kicad_pcb") return "kicad-pcb";
  if (e === "kicad_sch") return "kicad-sch";
  if (MESH_EXTS.has(e)) return "mesh";
  if (BREP_EXTS.has(e)) return "brep";
  // .txt is ambiguous (plain text vs. Excellon drill) — keep it out so we don't hijack text files.
  if (e !== "txt" && GERBER_EXTS.has(e)) return "gerber";
  return "unknown";
}
