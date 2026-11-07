/**
 * Fixtures parse-test (bun:test, NO browser). Verifies the generated CAD fixtures exist, are
 * non-empty, and actually parse with the libraries the viewer uses. Run:
 *   cd anvild && bun test test/golden/fixtures.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebIO } from "@gltf-transform/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "fixtures", "cad");
const MESH = join(FIX, "mesh");
const ECAD = join(FIX, "ecad2d");

// gen.ts output is verified in a THROWAWAY tmp dir — the test must never mutate the tracked,
// committed fixtures (the 3MF zip in particular is non-deterministic across runs).
let GEN: string;

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
  // Drive gen.ts into a throwaway tmp dir — verifies the generator produces parseable output WITHOUT
  // touching the committed fixtures. The module writes nothing on import (guarded by import.meta.main).
  GEN = mkdtempSync(join(tmpdir(), "anvil-cadfix-"));
  const gen = await import("../fixtures/cad/gen");
  const { glb, asciiStl, binaryStl, objMtl, asciiPly, threeMf, collada, gerbers, drill } = gen;
  const { obj, mtl } = objMtl();
  const outputs: Array<[string, string | Uint8Array]> = [
    [join(GEN, "cube.stl"), asciiStl()],
    [join(GEN, "cube-bin.stl"), binaryStl()],
    [join(GEN, "cube.obj"), obj],
    [join(GEN, "cube.mtl"), mtl],
    [join(GEN, "cube.ply"), asciiPly()],
    [join(GEN, "cube.glb"), await glb()],
    [join(GEN, "cube.3mf"), threeMf()],
    [join(GEN, "cube.dae"), collada()],
  ];
  for (const [name, text] of Object.entries(gerbers())) outputs.push([join(GEN, name), text]);
  outputs.push([join(GEN, "board.drl"), drill()]);
  for (const [path, data] of outputs) await Bun.write(path, data);
});

afterAll(() => {
  if (GEN) rmSync(GEN, { recursive: true, force: true });
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
    const bytes = new Uint8Array(await Bun.file(join(GEN, "cube.glb")).arrayBuffer());
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

  test("assembly-draco.glb is Draco-compressed (regression: GLTFLoader needs a DRACOLoader)", async () => {
    // Most real .glb exports are Draco-compressed; the viewer must wire a DRACOLoader or they fail to
    // open while every other format works. The extension name sits in the glb's plaintext JSON chunk.
    const bytes = new Uint8Array(await Bun.file(join(MESH, "assembly-draco.glb")).arrayBuffer());
    const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
    expect(text).toContain("KHR_draco_mesh_compression");
  });

  test("cube-bin.stl header declares 12 triangles", async () => {
    const bytes = new Uint8Array(await Bun.file(join(GEN, "cube-bin.stl")).arrayBuffer());
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

  test("kicad board fixture is a well-formed KiCad 7 board", async () => {
    const txt = await Bun.file(join(FIX, "kicad", "board.kicad_pcb")).text();
    expect(txt).toStartWith("(kicad_pcb");
    expect(txt).toContain("(version 20221018)");
    expect(txt).toContain('(layer "Edge.Cuts")'); // board outline
    expect(txt).toContain("(footprint"); // at least one component
    expect(txt).toContain('(pad "1" smd'); // pads
    expect(txt).toContain("(via "); // routing
  });

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
