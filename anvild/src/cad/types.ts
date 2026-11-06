// Core type contract for the daemon-side CAD conversion pipeline. Dependency-free so every module
// under src/cad/ can import a single stable shape. See docs/plans/2026-11-06-cad-viewer.md.

export type CadKind = "mesh" | "brep" | "kicad-pcb" | "kicad-sch" | "gerber" | "unknown";

/** A node in the (possibly nested) assembly tree; meshIndices point into the flat CadMesh[]. */
export interface CadNode {
  name: string;
  meshIndices: number[];
  children: CadNode[];
}

/** One tessellated mesh. Typed arrays so the GLB writer can hand them straight to accessors. */
export interface CadMesh {
  name: string;
  positions: Float32Array;
  normals?: Float32Array;
  indices: Uint32Array;
  color?: [number, number, number];
}

/** Metadata we stash in the GLB asset extras and return alongside the bytes. */
export interface ConvertMeta {
  sourceExt: string;
  units: string;
  triangles: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  tree: CadNode;
}

export interface ConvertResult {
  glb: Uint8Array;
  meta: ConvertMeta;
}

export interface ConvertOpts {
  lodMaxTriangles?: number;
  timeoutMs?: number;
  /**
   * Meshopt-compress the GLB only when the (post-decimation) triangle count is at or above this
   * threshold. Compression + quantization add CPU + a KHR extension the client must decode, which
   * isn't worth it for small models. Default ~50k triangles; set to 0 to always compress.
   */
  compressThreshold?: number;
}

/** Every failure in the pipeline surfaces as this, with a human-readable `reason`. */
export class CadConvertError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "CadConvertError";
  }
}
