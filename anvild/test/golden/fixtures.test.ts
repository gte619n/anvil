/**
 * Fixtures parse-test (bun:test, NO browser). Verifies the generated CAD fixtures exist, are
 * non-empty, and actually parse with the libraries the viewer uses. Run:
 *   cd anvild && bun test test/golden/fixtures.test.ts
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebIO } from "@gltf-transform/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "fixtures", "cad");
const MESH = join(FIX, "mesh");
const ECAD = join(FIX, "ecad2d");

const MESH_FILES = [
  "cube.stl",
  "cube-bin.stl",
  "cube.obj",
  "cube.mtl",
  "cube.ply",
  "cube.glb",
  "cube.3mf",
  "cube.dae",
];
const ECAD_FILES = ["board.gtl", "board.gbl", "board.gto", "board.drl"];

beforeAll(async () => {
  // (Re)generate so the test is self-contained even on a fresh checkout.
  const gen = await import("../fixtures/cad/gen");
  // The module writes nothing on import (guarded by import.meta.main); drive it directly.
  const { glb, asciiStl, binaryStl, objMtl, asciiPly, threeMf, collada, gerbers, drill } = gen;
  const { obj, mtl } = objMtl();
  const outputs: Array<[string, string | Uint8Array]> = [
    [join(MESH, "cube.stl"), asciiStl()],
    [join(MESH, "cube-bin.stl"), binaryStl()],
    [join(MESH, "cube.obj"), obj],
    [join(MESH, "cube.mtl"), mtl],
    [join(MESH, "cube.ply"), asciiPly()],
    [join(MESH, "cube.glb"), await glb()],
    [join(MESH, "cube.3mf"), threeMf()],
    [join(MESH, "cube.dae"), collada()],
  ];
  for (const [name, text] of Object.entries(gerbers())) outputs.push([join(ECAD, name), text]);
  outputs.push([join(ECAD, "board.drl"), drill()]);
  for (const [path, data] of outputs) await Bun.write(path, data);
});

describe("mesh fixtures", () => {
  for (const f of MESH_FILES) {
    test(`${f} exists and is non-empty`, () => {
      const p = join(MESH, f);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(0);
    });
  }

  test("cube.glb re-reads to a mesh with triangles and units extra", async () => {
    const bytes = new Uint8Array(await Bun.file(join(MESH, "cube.glb")).arrayBuffer());
    const doc = await new WebIO().readBinary(bytes);
    const meshes = doc.getRoot().listMeshes();
    expect(meshes.length).toBe(1);
    const prim = meshes[0]!.listPrimitives()[0]!;
    const pos = prim.getAttribute("POSITION")!;
    // 12 triangles * 3 verts = 36 positions (non-indexed triangle soup).
    expect(pos.getCount()).toBe(36);
    const extras = doc.getRoot().getAsset().extras as { units?: string };
    expect(extras?.units).toBe("mm");
  });

  test("cube-bin.stl header declares 12 triangles", async () => {
    const bytes = new Uint8Array(await Bun.file(join(MESH, "cube-bin.stl")).arrayBuffer());
    expect(bytes.byteLength).toBe(84 + 12 * 50);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = dv.getUint32(80, true); // little-endian uint32 after the 80-byte header
    expect(count).toBe(12);
  });
});

describe("ecad2d fixtures", () => {
  for (const f of ECAD_FILES) {
    test(`${f} exists and is non-empty`, () => {
      const p = join(ECAD, f);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(0);
    });
  }

  test("whats-that-gerber recognizes the layer set", async () => {
    type WtgFn = (f: readonly string[]) => Record<string, { type: string | null; side: string | null }>;
    const mod = (await import("whats-that-gerber")) as unknown as { default?: WtgFn } & WtgFn;
    const wtg: WtgFn = mod.default ?? mod;
    const res = wtg(ECAD_FILES);
    expect(res["board.gtl"]).toEqual({ type: "copper", side: "top" });
    expect(res["board.gbl"]).toEqual({ type: "copper", side: "bottom" });
    expect(res["board.gto"]).toEqual({ type: "silkscreen", side: "top" });
    expect(res["board.drl"]).toEqual({ type: "drill", side: "all" });
  });
});
