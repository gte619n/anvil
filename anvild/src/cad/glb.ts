// Mesh JSON → GLB via @gltf-transform/core, preserving the assembly hierarchy + metadata. The
// client (three.js GLTFLoader) consumes the result directly; metadata (units/bbox/tree/sourceExt)
// rides in the glTF asset extras so the viewer can label + frame the model without a side-channel.

import { Document, WebIO } from "@gltf-transform/core";
import type { TypedArray } from "@gltf-transform/core";
import type { CadMesh, CadNode, ConvertMeta } from "./types";

// gltf-transform's Accessor.setArray expects a TypedArray backed by a plain ArrayBuffer. Our typed
// arrays may be backed by any ArrayBufferLike (e.g. from occt JSON), so narrow via this cast at the
// writer boundary — the byte layout is identical.
const asTyped = (a: Float32Array | Uint32Array): TypedArray => a as unknown as TypedArray;

/**
 * Serialize tessellated meshes + an assembly tree into a single GLB.
 * One glTF Mesh/Primitive per CadMesh; nodes recreate the hierarchy and reference meshes by index.
 */
export async function meshesToGlb(
  meshes: CadMesh[],
  tree: CadNode,
  meta: Omit<ConvertMeta, "glb">,
): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();

  // Build one glTF Mesh per CadMesh so a tree node can point at it by index.
  const gltfMeshes = meshes.map((m, i) => {
    const prim = doc.createPrimitive();

    const position = doc
      .createAccessor(`pos_${i}`)
      .setType("VEC3")
      .setArray(asTyped(m.positions))
      .setBuffer(buffer);
    prim.setAttribute("POSITION", position);

    if (m.normals && m.normals.length) {
      const normal = doc
        .createAccessor(`nrm_${i}`)
        .setType("VEC3")
        .setArray(asTyped(m.normals))
        .setBuffer(buffer);
      prim.setAttribute("NORMAL", normal);
    }

    const indices = doc
      .createAccessor(`idx_${i}`)
      .setType("SCALAR")
      .setArray(asTyped(m.indices))
      .setBuffer(buffer);
    prim.setIndices(indices);

    const material = doc.createMaterial(`mat_${i}`).setRoughnessFactor(0.6).setMetallicFactor(0.1);
    if (m.color) {
      material.setBaseColorFactor([m.color[0], m.color[1], m.color[2], 1]);
    } else {
      material.setBaseColorFactor([0.6, 0.6, 0.6, 1]);
    }
    prim.setMaterial(material);

    return doc.createMesh(m.name || `mesh_${i}`).addPrimitive(prim);
  });

  // Recreate the node hierarchy. A node referencing N meshes becomes a node with N child nodes
  // (glTF nodes hold at most one mesh), preserving both structure and the mesh→node mapping.
  const scene = doc.createScene("scene");

  const buildNode = (cn: CadNode) => {
    const node = doc.createNode(cn.name || "node");
    if (cn.meshIndices.length === 1) {
      const gm = gltfMeshes[cn.meshIndices[0]!];
      if (gm) node.setMesh(gm);
    } else {
      for (const mi of cn.meshIndices) {
        const gm = gltfMeshes[mi];
        if (gm) node.addChild(doc.createNode(`${cn.name || "node"}_m${mi}`).setMesh(gm));
      }
    }
    for (const child of cn.children) node.addChild(buildNode(child));
    return node;
  };

  scene.addChild(buildNode(tree));
  doc.getRoot().setDefaultScene(scene);

  // Stash metadata in asset extras so the viewer gets units/bbox/tree without a second request.
  doc.getRoot().getAsset().extras = {
    units: meta.units,
    bbox: meta.bbox,
    sourceExt: meta.sourceExt,
    triangles: meta.triangles,
    tree: meta.tree,
  };

  // WebIO.writeBinary returns a GLB Uint8Array and works under Bun (no node:fs dependency).
  const io = new WebIO();
  return io.writeBinary(doc);
}
