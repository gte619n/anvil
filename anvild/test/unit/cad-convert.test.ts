import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebIO } from "@gltf-transform/core";
import { MeshoptDecoder } from "meshoptimizer";
import { convertCad } from "../../src/cad/convert";
import {
  buildCadDocument,
  compressDocument,
  countTriangles,
  simplifyDocument,
  writeGlbBinary,
} from "../../src/cad/glb";
import { readEnvConfig } from "../../src/cad/service";
import type { CadMesh, CadNode, ConvertMeta } from "../../src/cad/types";

const fixture = join(import.meta.dir, "../fixtures/cad/brep/cube.step");

/** A dense, collapsible grid mesh (a heightfield) with many shared vertices — unlike the 12-tri
 *  watertight cube, this is geometry quadric simplification can actually decimate. */
function gridMesh(cols: number, rows: number): { meshes: CadMesh[]; tree: CadNode; meta: Omit<ConvertMeta, "glb"> } {
  const positions = new Float32Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3;
      positions[i] = c;
      positions[i + 1] = r;
      positions[i + 2] = Math.sin(c * 0.1) * Math.cos(r * 0.1) * 5;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const cc = a + cols;
      const d = cc + 1;
      idx.push(a, b, cc, b, d, cc);
    }
  }
  const mesh: CadMesh = { name: "grid", positions, indices: new Uint32Array(idx) };
  const tree: CadNode = { name: "", meshIndices: [0], children: [] };
  const triangles = idx.length / 3;
  const meta: Omit<ConvertMeta, "glb"> = {
    sourceExt: "step",
    units: "mm",
    triangles,
    bbox: { min: [0, 0, -5], max: [cols - 1, rows - 1, 5] },
    tree,
  };
  return { meshes: [mesh], tree, meta };
}

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

  test("succeeds (no refusal) when the model is within budget", async () => {
    // The cube is 12 triangles; a budget >= that returns the full model un-decimated. The actual
    // over-budget decimation path (simplifyDocument -> countTriangles, the same calls convertCad
    // makes) is covered against collapsible geometry in the "glb pipeline helpers" block below,
    // because the watertight cube is minimal geometry quadric simplification can't reduce.
    const bytes = new Uint8Array(readFileSync(fixture));
    const { glb, meta } = await convertCad(bytes, "step", { lodMaxTriangles: 12 });
    expect(glb.length).toBeGreaterThan(0);
    expect(meta.triangles).toBeLessThanOrEqual(12);
  }, 60_000);

  test("refuses only when even floored decimation can't reach the budget", async () => {
    // The 12-triangle cube is minimal watertight geometry: quadric simplification can't collapse it
    // below 12 (every face is load-bearing). A budget of 1 is therefore unreachable even after
    // flooring the ratio, so the pipeline refuses with the device-budget error. This is the one
    // remaining throw path — decimation is attempted first, refusal is the fallback.
    const bytes = new Uint8Array(readFileSync(fixture));
    await expect(convertCad(bytes, "step", { lodMaxTriangles: 1 })).rejects.toThrow(
      "exceeds device budget",
    );
  }, 60_000);

  test("compresses the GLB when triangles reach the compression threshold", async () => {
    const bytes = new Uint8Array(readFileSync(fixture));
    // Force compression on the small cube by setting the threshold to 0, then confirm the meshopt +
    // quantization extensions are declared in the GLB (the client decodes meshopt via MeshoptDecoder).
    const { glb } = await convertCad(bytes, "step", { compressThreshold: 0 });
    const header = new TextDecoder("utf-8", { fatal: false }).decode(glb.subarray(0, 8192));
    expect(header).toContain("EXT_meshopt_compression");
    expect(header).toContain("KHR_mesh_quantization");
  }, 60_000);

  test("skips compression for small models below the threshold", async () => {
    const bytes = new Uint8Array(readFileSync(fixture));
    // Default threshold (50k) >> the cube's 12 triangles, so no compression extension is declared.
    const { glb } = await convertCad(bytes, "step");
    const header = new TextDecoder("utf-8", { fatal: false }).decode(glb.subarray(0, 8192));
    expect(header).not.toContain("EXT_meshopt_compression");
  }, 60_000);

  test("rejects garbage bytes with a CadConvertError", async () => {
    const junk = new Uint8Array([0, 1, 2, 3, 4, 5]);
    await expect(convertCad(junk, "step")).rejects.toThrow();
  }, 60_000);
});

describe("glb pipeline helpers", () => {
  test("simplifyDocument decimates a dense mesh to <= the target triangle count", async () => {
    const { meshes, tree, meta } = gridMesh(120, 120); // ~28k triangles
    const doc = buildCadDocument(meshes, tree, meta);
    const before = countTriangles(doc);
    expect(before).toBeGreaterThan(20_000);

    const budget = 4_000;
    await simplifyDocument(doc, budget / before);
    const after = countTriangles(doc);
    // Quadric simplification is approximate; allow the 10% tolerance convert.ts uses.
    expect(after).toBeLessThanOrEqual(Math.ceil(budget * 1.1));
    expect(after).toBeLessThan(before);
  }, 60_000);

  test("compressDocument shrinks a large GLB and round-trips via MeshoptDecoder", async () => {
    const { meshes, tree, meta } = gridMesh(200, 200); // ~79k triangles — worth compressing

    const uncompressed = await writeGlbBinary(buildCadDocument(meshes, tree, meta), false);

    const doc = buildCadDocument(meshes, tree, meta);
    await compressDocument(doc);
    const compressed = await writeGlbBinary(doc, true);

    expect(compressed.length).toBeLessThan(uncompressed.length);

    // Read it back in Node: the meshopt + quantization extensions must be registered on the IO and
    // the decoder dependency supplied, else gltf-transform can't decode the compressed buffer views.
    // Pull the extension ctors off the compressed Document (same trick glb.ts uses on write) so the
    // test doesn't depend on the transitive @gltf-transform/extensions package directly.
    await MeshoptDecoder.ready;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extension ctor type is internal.
    const ctors = doc.getRoot().listExtensionsUsed().map((e) => e.constructor as any);
    const io = new WebIO().registerExtensions(ctors);
    io.registerDependencies({ "meshopt.decoder": MeshoptDecoder });
    const back = await io.readBinary(compressed);
    expect(back.getRoot().listMeshes().length).toBe(1);
    expect(countTriangles(back)).toBeGreaterThan(0);
  }, 60_000);
});

describe("service env config", () => {
  const KEYS = ["ANVIL_CAD_CONCURRENCY", "ANVIL_CAD_CACHE_MB", "ANVIL_CAD_TIMEOUT_MS"] as const;

  function withEnv(vals: Partial<Record<(typeof KEYS)[number], string | undefined>>, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) saved[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(vals)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fn();
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  test("defaults when env is unset", () => {
    withEnv(
      { ANVIL_CAD_CONCURRENCY: undefined, ANVIL_CAD_CACHE_MB: undefined, ANVIL_CAD_TIMEOUT_MS: undefined },
      () => {
        const cfg = readEnvConfig();
        expect(cfg.concurrency).toBe(2);
        expect(cfg.cacheCapBytes).toBe(512 * 1024 * 1024);
        expect(cfg.timeoutMs).toBe(60_000);
      },
    );
  });

  test("respects valid overrides", () => {
    withEnv({ ANVIL_CAD_CONCURRENCY: "4", ANVIL_CAD_CACHE_MB: "128", ANVIL_CAD_TIMEOUT_MS: "5000" }, () => {
      const cfg = readEnvConfig();
      expect(cfg.concurrency).toBe(4);
      expect(cfg.cacheCapBytes).toBe(128 * 1024 * 1024);
      expect(cfg.timeoutMs).toBe(5000);
    });
  });

  test("falls back to defaults on NaN / non-positive values", () => {
    withEnv({ ANVIL_CAD_CONCURRENCY: "nope", ANVIL_CAD_CACHE_MB: "0", ANVIL_CAD_TIMEOUT_MS: "-5" }, () => {
      const cfg = readEnvConfig();
      expect(cfg.concurrency).toBe(2);
      expect(cfg.cacheCapBytes).toBe(512 * 1024 * 1024);
      expect(cfg.timeoutMs).toBe(60_000);
    });
  });
});
