import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convertCad } from "../../src/cad/convert";

const fixture = join(import.meta.dir, "../fixtures/cad/brep/cube.step");

describe("convertCad (STEP)", () => {
  test("tessellates the hand-authored cube to a GLB with metadata", async () => {
    const bytes = new Uint8Array(readFileSync(fixture));
    const { glb, meta } = await convertCad(bytes, "step");

    expect(glb.length).toBeGreaterThan(0);
    expect(meta.triangles).toBeGreaterThan(0);
    expect(meta.sourceExt).toBe("step");
    // tree root has at least one child (the "Cube" product node)
    expect(meta.tree.children.length).toBeGreaterThan(0);

    // bbox should span roughly the 10mm cube
    const dx = meta.bbox.max[0] - meta.bbox.min[0];
    const dy = meta.bbox.max[1] - meta.bbox.min[1];
    const dz = meta.bbox.max[2] - meta.bbox.min[2];
    expect(dx).toBeGreaterThan(9);
    expect(dx).toBeLessThan(11);
    expect(dy).toBeGreaterThan(9);
    expect(dz).toBeGreaterThan(9);
  }, 60_000);

  test("enforces the triangle budget", async () => {
    const bytes = new Uint8Array(readFileSync(fixture));
    await expect(convertCad(bytes, "step", { lodMaxTriangles: 1 })).rejects.toThrow(
      "exceeds device budget",
    );
  }, 60_000);

  test("rejects garbage bytes with a CadConvertError", async () => {
    const junk = new Uint8Array([0, 1, 2, 3, 4, 5]);
    await expect(convertCad(junk, "step")).rejects.toThrow();
  }, 60_000);
});
