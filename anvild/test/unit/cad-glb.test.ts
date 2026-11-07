import { describe, expect, test } from "bun:test";
import { WebIO } from "@gltf-transform/core";
import { meshesToGlb } from "../../src/cad/glb";
import type { CadMesh, CadNode } from "../../src/cad/types";

describe("meshesToGlb", () => {
  test("round-trips a single triangle mesh + metadata", async () => {
    const mesh: CadMesh = {
      name: "tri",
      // one triangle
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      color: [0.2, 0.4, 0.6],
    };
    const tree: CadNode = { name: "root", meshIndices: [0], children: [] };
    const meta = {
      sourceExt: "step",
      units: "mm",
      triangles: 1,
      bbox: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] },
      tree,
    };

    const glb = await meshesToGlb([mesh], tree, meta);
    expect(glb.length).toBeGreaterThan(0);

    const doc = await new WebIO().readBinary(glb);
    const meshes = doc.getRoot().listMeshes();
    expect(meshes.length).toBe(1);

    const prim = meshes[0]!.listPrimitives()[0]!;
    const idx = prim.getIndices()!;
    expect(idx.getCount()).toBe(3); // one triangle = 3 indices
    const pos = prim.getAttribute("POSITION")!;
    expect(pos.getCount()).toBe(3); // 3 vertices

    const extras = doc.getRoot().getAsset().extras as Record<string, unknown>;
    expect(extras.units).toBe("mm");
    expect((extras.bbox as { max: number[] }).max).toEqual([1, 1, 0]);
  });

  test("recreates a nested hierarchy", async () => {
    const meshes: CadMesh[] = [
      {
        name: "a",
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
      },
      {
        name: "b",
        positions: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]),
        indices: new Uint32Array([0, 1, 2]),
      },
    ];
    const tree: CadNode = {
      name: "",
      meshIndices: [],
      children: [
        { name: "partA", meshIndices: [0], children: [] },
        { name: "partB", meshIndices: [1], children: [] },
      ],
    };
    const glb = await meshesToGlb(meshes, tree, {
      sourceExt: "step",
      units: "mm",
      triangles: 2,
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      tree,
    });
    const doc = await new WebIO().readBinary(glb);
    expect(doc.getRoot().listMeshes().length).toBe(2);
  });
});
