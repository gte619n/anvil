// Pure, DOM-free detection of viewable file paths Claude names in prose — so conversation.ts can
// turn them into clickable chips (CAD → 3D viewer, images → reader, markdown → reader). Kept separate
// + dependency-free so the matcher is unit-testable without the whole conversation module.

export const MODEL_EXTS = ["stl", "obj", "3mf", "ply", "gltf", "glb", "dae", "step", "stp", "iges", "igs", "fcstd", "kicad_pcb", "kicad_sch"];
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
export const DOC_EXTS = ["md", "markdown"];

// Longest-first so e.g. `step` wins over `stp` and `kicad_pcb` isn't shadowed (regex alternation is
// leftmost-eager); `(?![\w/-])` still anchors to the full extension so partial matches can't leak.
const VIEWABLE_EXTS = [...MODEL_EXTS, ...IMAGE_EXTS, ...DOC_EXTS].sort((a, b) => b.length - a.length);

/** Fresh regex per call — a shared /g regex carries `lastIndex` state across callers. */
export function viewablePathRe(): RegExp {
  return new RegExp(`(?:\\.{0,2}\\/)?(?:[\\w.-]+\\/)*[\\w.-]+\\.(?:${VIEWABLE_EXTS.join("|")})(?![\\w/-])`, "gi");
}

export type FileChipKind = "model" | "image" | "doc";

/** Category of a path by extension (drives the chip's leading icon). */
export function fileChipKind(path: string): FileChipKind {
  const ext = path.toLowerCase().match(/\.([a-z0-9_]+)$/)?.[1] ?? "";
  if (MODEL_EXTS.includes(ext)) return "model";
  if (IMAGE_EXTS.includes(ext)) return "image";
  return "doc";
}

/** Material-symbol name for a path's chip (model → 3D cube, image, doc). */
export function fileChipIcon(path: string): string {
  const kind = fileChipKind(path);
  return kind === "model" ? "deployed_code" : kind === "image" ? "image" : "description";
}
