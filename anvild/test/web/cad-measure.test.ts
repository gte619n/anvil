// Pure-math tests for the CAD measurement core (Phase 10 / D28). No DOM, no three — these helpers are
// deliberately dependency-free, so we import them straight from the module and feed known geometry.
import { test, expect } from "bun:test";
import {
  distance3,
  distanceSq3,
  snapToVertex,
  edgeMidpoints,
  snapToEdgeMidpoint,
  angle3,
  formatLength,
} from "../../web/src/cad-measure";

// The 8 corners of a unit cube centred at the origin (half-extent 0.5), as a flat XYZ buffer — the
// Phase-10 fixture oracle (§6.2): a snapped corner-to-corner edge must equal the known edge length.
const CUBE: Float32Array = new Float32Array([
  -0.5, -0.5, -0.5, // 0
  0.5, -0.5, -0.5,  // 1
  0.5, 0.5, -0.5,   // 2
  -0.5, 0.5, -0.5,  // 3
  -0.5, -0.5, 0.5,  // 4
  0.5, -0.5, 0.5,   // 5
  0.5, 0.5, 0.5,    // 6
  -0.5, 0.5, 0.5,   // 7
]);

test("distance3 / distanceSq3 on known points", () => {
  expect(distance3({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBeCloseTo(5, 10);
  expect(distanceSq3({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBeCloseTo(25, 10);
  expect(distance3({ x: 1, y: 2, z: 2 }, { x: 0, y: 0, z: 0 })).toBeCloseTo(3, 10);
});

test("snapToVertex picks the nearest cube corner within the radius", () => {
  // A ray hit just inside the +x/+y/+z corner should snap to vertex 6 (0.5,0.5,0.5).
  const hit = { x: 0.47, y: 0.46, z: 0.48 };
  const snapped = snapToVertex(CUBE, hit, 0.1 * 0.1);
  expect(snapped).not.toBeNull();
  expect(snapped!.x).toBeCloseTo(0.5, 10);
  expect(snapped!.y).toBeCloseTo(0.5, 10);
  expect(snapped!.z).toBeCloseTo(0.5, 10);
});

test("snapToVertex returns null past the radius", () => {
  // Dead centre of the cube — every corner is ~0.866 away, outside a 0.1 radius.
  const snapped = snapToVertex(CUBE, { x: 0, y: 0, z: 0 }, 0.1 * 0.1);
  expect(snapped).toBeNull();
});

test("a snapped cube edge equals the known edge length within epsilon", () => {
  // Two near-corner hits → snap → measure. The unit cube's edge is exactly 1.0.
  const a = snapToVertex(CUBE, { x: -0.49, y: -0.48, z: -0.47 }, 0.05 * 0.05)!;
  const b = snapToVertex(CUBE, { x: 0.49, y: -0.48, z: -0.47 }, 0.05 * 0.05)!;
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(distance3(a, b)).toBeCloseTo(1.0, 9);
});

test("edgeMidpoints returns de-duplicated midpoints for a single triangle", () => {
  // One triangle in the z=0 plane; midpoints are the 3 edge centres.
  const tri = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  const mids = edgeMidpoints(tri, null);
  expect(mids.length).toBe(3);
  // Edge (0,0,0)-(2,0,0) midpoint is (1,0,0).
  const hasMid = mids.some((m) => Math.abs(m.x - 1) < 1e-9 && Math.abs(m.y) < 1e-9 && Math.abs(m.z) < 1e-9);
  expect(hasMid).toBe(true);
});

test("edgeMidpoints de-dups shared edges across two triangles", () => {
  // Two triangles sharing the diagonal of a unit square → 5 unique edges (4 sides + 1 shared diagonal).
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const quad = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const mids = edgeMidpoints(quad, indices);
  expect(mids.length).toBe(5);
});

test("snapToEdgeMidpoint finds the nearest midpoint", () => {
  const mids = edgeMidpoints(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), null);
  const snapped = snapToEdgeMidpoint(mids, { x: 1.02, y: 0.03, z: 0 }, 0.1 * 0.1);
  expect(snapped).not.toBeNull();
  expect(snapped!.x).toBeCloseTo(1, 6);
  expect(snapped!.y).toBeCloseTo(0, 6);
  expect(snapToEdgeMidpoint(mids, { x: 5, y: 5, z: 5 }, 0.1 * 0.1)).toBeNull();
});

test("angle3 measures a right angle at the corner", () => {
  // Legs along +x and +y from the origin → 90°.
  expect(angle3({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(90, 9);
  // Colinear opposite directions → 180°.
  expect(angle3({ x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(180, 9);
});

test("formatLength trims zeros and appends real units only", () => {
  expect(formatLength(1, "mm")).toBe("1 mm");
  expect(formatLength(1.25, "mm")).toBe("1.25 mm");
  expect(formatLength(12.5, "unitless")).toBe("12.5");
  expect(formatLength(250, "mm")).toBe("250.0 mm");
});
