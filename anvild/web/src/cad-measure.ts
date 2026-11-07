// ── cad-measure.ts — pure measurement math for the CAD viewer (Phase 10, D28) ──────────────────────
// Snap-to-geometry helpers + distance/angle math, kept DOM-free and three-free so they're unit-testable
// in isolation (test/web/cad-measure.test.ts). cad.ts does the raycasting + DOM; this module is the
// numeric core: given raw geometry buffers and a target world point, pick the nearest real vertex /
// edge-midpoint, and measure between snapped points. Everything is "approximate (mesh)" (NG5) — these
// operate on the tessellation, not the original B-rep.
//
// Spec: docs/plans/2026-11-06-cad-viewer.md §Phase 10 / D28.

/** A plain 3D point. Deliberately not a three.js Vector3 so this stays runtime-dependency-free. */
export interface Pt3 {
  x: number;
  y: number;
  z: number;
}

/** Euclidean distance between two points. */
export function distance3(a: Pt3, b: Pt3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Squared distance (cheap comparator — avoids the sqrt when you only need to rank candidates). */
export function distanceSq3(a: Pt3, b: Pt3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Snap `target` to the nearest vertex in a flat XYZ position buffer, within `maxDistSq` (squared
 * world distance). Returns the winning vertex, or null when nothing lands inside the radius. The
 * buffer is read in [x,y,z] triples (the layout of a three BufferAttribute's `.array`).
 */
export function snapToVertex(points: Float32Array, target: Pt3, maxDistSq: number): Pt3 | null {
  let best: Pt3 | null = null;
  let bestSq = maxDistSq;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const vx = points[i]!;
    const vy = points[i + 1]!;
    const vz = points[i + 2]!;
    const dx = vx - target.x;
    const dy = vy - target.y;
    const dz = vz - target.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= bestSq) {
      bestSq = d2;
      best = { x: vx, y: vy, z: vz };
    }
  }
  return best;
}

/**
 * Midpoints of every triangle edge in a mesh. `positions` is the flat XYZ vertex buffer; `indices`
 * (if present) is the element buffer in triples of vertex indices — otherwise positions are taken
 * three-vertices-per-triangle in order (non-indexed geometry). Duplicate edges across adjacent faces
 * are de-duplicated by a rounded key so shared edges aren't counted twice.
 */
export function edgeMidpoints(positions: Float32Array, indices?: Uint32Array | Uint16Array | null): Pt3[] {
  const out: Pt3[] = [];
  const seen = new Set<string>();
  const vertAt = (vi: number): Pt3 => ({
    x: positions[vi * 3]!,
    y: positions[vi * 3 + 1]!,
    z: positions[vi * 3 + 2]!,
  });
  const triCount = indices ? indices.length / 3 : positions.length / 9;
  const key = (a: Pt3, b: Pt3): string => {
    // Order-independent, quantized key so (a,b) and (b,a) collapse and float jitter doesn't split edges.
    const q = (n: number): number => Math.round(n * 1e4);
    const ka = `${q(a.x)},${q(a.y)},${q(a.z)}`;
    const kb = `${q(b.x)},${q(b.y)},${q(b.z)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  for (let t = 0; t < triCount; t++) {
    let i0: number, i1: number, i2: number;
    if (indices) {
      i0 = indices[t * 3]!;
      i1 = indices[t * 3 + 1]!;
      i2 = indices[t * 3 + 2]!;
    } else {
      i0 = t * 3;
      i1 = t * 3 + 1;
      i2 = t * 3 + 2;
    }
    const a = vertAt(i0);
    const b = vertAt(i1);
    const c = vertAt(i2);
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = key(p, q);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 });
    }
  }
  return out;
}

/** Snap `target` to the nearest edge-midpoint, within `maxDistSq`. Returns null if none in range. */
export function snapToEdgeMidpoint(midpoints: Pt3[], target: Pt3, maxDistSq: number): Pt3 | null {
  let best: Pt3 | null = null;
  let bestSq = maxDistSq;
  for (const m of midpoints) {
    const d2 = distanceSq3(m, target);
    if (d2 <= bestSq) {
      bestSq = d2;
      best = m;
    }
  }
  return best;
}

/** Interior angle at vertex `b` of the segments b→a and b→c, in degrees (0..180). */
export function angle3(a: Pt3, b: Pt3, c: Pt3): number {
  const u = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const lu = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z);
  const lv = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (lu === 0 || lv === 0) return 0;
  const dot = (u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv);
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/** Format a scalar length with its unit, trimming trailing zeros. Used by the dimension labels. */
export function formatLength(value: number, units: string): string {
  const v = Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(3).replace(/\.?0+$/, "");
  const u = units && units !== "unitless" && units !== "—" ? ` ${units}` : "";
  return `${v}${u}`;
}
