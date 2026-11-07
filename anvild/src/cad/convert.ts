// Public entry for the daemon-side CAD conversion pipeline. Takes raw B-rep bytes + an extension,
// runs OCCT (in an isolated worker) to tessellate, composes an assembly tree, enforces the device
// triangle budget, and writes a GLB with metadata in its extras. Every failure becomes a
// CadConvertError with a readable reason. See docs/plans/2026-11-06-cad-viewer.md.

import { unzipSync } from "fflate";
import {
  buildCadDocument,
  compressDocument,
  countTriangles,
  simplifyDocument,
  writeGlbBinary,
} from "./glb";
import { runOcct } from "./occt-run";
import type { CadMesh, CadNode, ConvertMeta, ConvertOpts, ConvertResult } from "./types";
import { CadConvertError } from "./types";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LOD_MAX_TRIANGLES = 8_000_000;
const DEFAULT_COMPRESS_THRESHOLD = 50_000;
// Floor on the decimation ratio: collapsing below ~5% of the original triangle count destroys so
// much fidelity (merged edges, vanished thin features) that the result is rarely useful. We still
// honor it so a pathologically tiny budget degrades gracefully instead of throwing — but we refuse
// (below) if even flooring the ratio can't get under the budget by a safe margin.
const MIN_SIMPLIFY_RATIO = 0.05;
// Simplification is approximate; accept a result up to this fraction over the budget rather than
// refusing a model that landed just above the target triangle count.
const BUDGET_TOLERANCE = 1.1;

/** Convert B-rep bytes (step/stp/iges/igs/fcstd) to a GLB + metadata. */
export async function convertCad(
  bytes: Uint8Array,
  ext: string,
  opts: ConvertOpts = {},
): Promise<ConvertResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lodMax = opts.lodMaxTriangles ?? DEFAULT_LOD_MAX_TRIANGLES;
  const compressThreshold = opts.compressThreshold ?? DEFAULT_COMPRESS_THRESHOLD;
  const sourceExt = ext.toLowerCase().replace(/^\./, "");

  try {
    let meshes: CadMesh[];
    let tree: CadNode;
    let units = "mm"; // OCCT STEP tessellation is emitted in model units; mm is the near-universal default.

    if (sourceExt === "fcstd") {
      const composed = await convertFcstd(bytes, timeoutMs);
      meshes = composed.meshes;
      tree = composed.tree;
    } else {
      const kind = sourceExt === "iges" || sourceExt === "igs" ? "iges" : "step";
      if (kind !== "iges" && sourceExt !== "step" && sourceExt !== "stp") {
        throw new CadConvertError(`unsupported B-rep extension: ${sourceExt}`);
      }
      const { root, meshes: raw } = await runOcct(bytes, kind, timeoutMs);
      meshes = raw.map(occtMeshToCad);
      tree = occtRootToTree(root);
    }

    if (meshes.length === 0) {
      throw new CadConvertError("no geometry produced");
    }

    const rawTriangles = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
    const bbox = computeBbox(meshes);

    // Phase 9 (D22): when the model exceeds the device triangle budget we DECIMATE it to fit rather
    // than refusing. Build the Document, run meshopt quadric simplification down to the budget, and
    // only throw if even a floored ratio can't land under the budget by a safe margin.
    const metaNoGlb: ConvertMeta = { sourceExt, units, triangles: rawTriangles, bbox, tree };
    const doc = buildCadDocument(meshes, tree, metaNoGlb);

    let triangles = rawTriangles;
    if (rawTriangles > lodMax) {
      const ratio = Math.max(MIN_SIMPLIFY_RATIO, lodMax / rawTriangles);
      await simplifyDocument(doc, ratio);
      triangles = countTriangles(doc);
      if (triangles > lodMax * BUDGET_TOLERANCE) {
        // Even the floored ratio couldn't get us under budget (geometry too fragmented to collapse
        // further). Refuse so the client can request a coarser LOD instead of shipping an
        // over-budget model.
        throw new CadConvertError("exceeds device budget");
      }
      // Reflect the decimated count in the metadata the viewer reads.
      metaNoGlb.triangles = triangles;
      doc.getRoot().getAsset().extras = {
        ...(doc.getRoot().getAsset().extras ?? {}),
        triangles,
      };
    }

    // Phase 9: meshopt-compress large models; small ones skip it (the KHR extension + CPU aren't
    // worth it). The web GLTFLoader decodes meshopt via MeshoptDecoder (no external decoder files).
    const compress = triangles >= compressThreshold;
    if (compress) await compressDocument(doc);
    const glb = await writeGlbBinary(doc, compress);

    return { glb, meta: metaNoGlb };
  } catch (err) {
    if (err instanceof CadConvertError) throw err;
    throw new CadConvertError(err instanceof Error ? err.message : String(err));
  }
}

/** occt mesh (plain JSON, untyped) → typed CadMesh. */
function occtMeshToCad(m: unknown): CadMesh {
  // occt-import-js meshes are untyped JSON; `any` confined to this boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mm = m as any;
  const positions = new Float32Array(mm.attributes.position.array);
  const indices = new Uint32Array(mm.index.array);
  const normals = mm.attributes.normal ? new Float32Array(mm.attributes.normal.array) : undefined;
  const color: [number, number, number] | undefined = Array.isArray(mm.color)
    ? [mm.color[0], mm.color[1], mm.color[2]]
    : undefined;
  return { name: typeof mm.name === "string" ? mm.name : "", positions, normals, indices, color };
}

/** occt root node (plain JSON, untyped) → typed CadNode tree. */
function occtRootToTree(root: unknown): CadNode {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any): CadNode => ({
    name: typeof n?.name === "string" ? n.name : "",
    meshIndices: Array.isArray(n?.meshes) ? n.meshes.slice() : [],
    children: Array.isArray(n?.children) ? n.children.map(walk) : [],
  });
  return walk(root);
}

function computeBbox(meshes: CadMesh[]): ConvertMeta["bbox"] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const v = p[i + j]!;
        if (v < min[j]!) min[j] = v;
        if (v > max[j]!) max[j] = v;
      }
    }
  }
  if (!isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

// --- FreeCAD .FCStd composition ---------------------------------------------------------------
// A .FCStd is a zip. Document.xml lists the objects + their Placements (position + rotation axis +
// angle); GuiDocument.xml carries visibility/colors. Each solid's geometry is a *.brp entry we hand
// to OCCT's brep reader. We parse the XML with regex (no DOMParser, no new deps) — placement
// parsing is best-effort: if we can't match a placement for a shape we fall back to identity, and
// if we can't map objects to .brp files at all we simply compose every .brp entry untransformed.

interface Placement {
  pos: [number, number, number];
  axis: [number, number, number];
  angleRad: number;
}

async function convertFcstd(
  bytes: Uint8Array,
  timeoutMs: number,
): Promise<{ meshes: CadMesh[]; tree: CadNode }> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    throw new CadConvertError(
      `not a valid FCStd archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const brepNames = Object.keys(files).filter((n) => /\.brp$/i.test(n)).sort();
  if (brepNames.length === 0) throw new CadConvertError("FCStd contains no B-rep shapes");

  const docXml = files["Document.xml"] ? new TextDecoder().decode(files["Document.xml"]) : "";
  const placements = docXml ? parsePlacements(docXml) : new Map<string, Placement>();

  const meshes: CadMesh[] = [];
  const children: CadNode[] = [];

  for (const name of brepNames) {
    const brp = files[name]!;
    let result: Awaited<ReturnType<typeof runOcct>>;
    try {
      result = await runOcct(brp, "brep", timeoutMs);
    } catch {
      continue; // skip a shape OCCT can't read rather than failing the whole document
    }
    // Best-effort placement: FCStd .brp files are commonly named "<ObjectName>.brp" or "PartShapeN.brp".
    const objName = name.replace(/\.brp$/i, "");
    const placement = placements.get(objName);
    const nodeMeshIdx: number[] = [];
    for (const raw of result.meshes) {
      const cad = occtMeshToCad(raw);
      if (placement) applyPlacement(cad.positions, placement);
      nodeMeshIdx.push(meshes.length);
      meshes.push(cad);
    }
    children.push({ name: objName, meshIndices: nodeMeshIdx, children: [] });
  }

  if (meshes.length === 0) throw new CadConvertError("no readable shapes in FCStd");
  return { meshes, tree: { name: "", meshIndices: [], children } };
}

/** Scan Document.xml for `<Object name="X">` + a following Placement (position + axis/angle). */
function parsePlacements(xml: string): Map<string, Placement> {
  const out = new Map<string, Placement>();
  // FreeCAD serializes a Placement as a PropertyPlacement with a <PropertyPlacement ...> whose
  // position/axis/angle attributes live on a nested element. Formats vary across versions, so we
  // match the common attribute-bearing element and associate it with the nearest preceding object.
  const objRe = /<Object\s+name="([^"]+)"/g;
  const plRe =
    /<PropertyPlacement[^>]*?Px="([-\d.eE]+)"[^>]*?Py="([-\d.eE]+)"[^>]*?Pz="([-\d.eE]+)"[^>]*?Ax="([-\d.eE]+)"[^>]*?Ay="([-\d.eE]+)"[^>]*?Az="([-\d.eE]+)"[^>]*?Angle="([-\d.eE]+)"/g;

  // Index object name positions so we can attribute a placement to the object it follows.
  const objs: { name: string; at: number }[] = [];
  for (let m = objRe.exec(xml); m; m = objRe.exec(xml)) objs.push({ name: m[1]!, at: m.index });

  for (let m = plRe.exec(xml); m; m = plRe.exec(xml)) {
    const at = m.index;
    let owner = "";
    for (const o of objs) {
      if (o.at < at) owner = o.name;
      else break;
    }
    if (!owner) continue;
    out.set(owner, {
      pos: [parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!)],
      axis: [parseFloat(m[4]!), parseFloat(m[5]!), parseFloat(m[6]!)],
      angleRad: parseFloat(m[7]!),
    });
  }
  return out;
}

/** Apply a FreeCAD placement (rotate about axis by angle, then translate) to positions in place. */
function applyPlacement(positions: Float32Array, p: Placement): void {
  const [ax, ay, az] = p.axis;
  const len = Math.hypot(ax, ay, az) || 1;
  const ux = ax / len;
  const uy = ay / len;
  const uz = az / len;
  const c = Math.cos(p.angleRad);
  const s = Math.sin(p.angleRad);
  const t = 1 - c;

  // Rodrigues rotation matrix.
  const r00 = c + ux * ux * t;
  const r01 = ux * uy * t - uz * s;
  const r02 = ux * uz * t + uy * s;
  const r10 = uy * ux * t + uz * s;
  const r11 = c + uy * uy * t;
  const r12 = uy * uz * t - ux * s;
  const r20 = uz * ux * t - uy * s;
  const r21 = uz * uy * t + ux * s;
  const r22 = c + uz * uz * t;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    positions[i] = r00 * x + r01 * y + r02 * z + p.pos[0];
    positions[i + 1] = r10 * x + r11 * y + r12 * z + p.pos[1];
    positions[i + 2] = r20 * x + r21 * y + r22 * z + p.pos[2];
  }
}
