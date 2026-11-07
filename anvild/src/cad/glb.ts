// Mesh JSON → GLB via @gltf-transform/core, preserving the assembly hierarchy + metadata. The
// client (three.js GLTFLoader) consumes the result directly; metadata (units/bbox/tree/sourceExt)
// rides in the glTF asset extras so the viewer can label + frame the model without a side-channel.
//
// convert.ts drives the pipeline: build a Document → (optionally) decimate it to fit the device
// triangle budget → (optionally) meshopt-compress it → write the GLB bytes. We expose the Document
// and the individual transforms here so convert.ts can inspect the post-decimation triangle count
// before committing to the final serialization.

import { Document, WebIO } from "@gltf-transform/core";
import type { TypedArray } from "@gltf-transform/core";
import { meshopt, quantize, simplify, weld } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import type { CadMesh, CadNode, ConvertMeta } from "./types";

// gltf-transform's Accessor.setArray expects a TypedArray backed by a plain ArrayBuffer. Our typed
// arrays may be backed by any ArrayBufferLike (e.g. from occt JSON), so narrow via this cast at the
// writer boundary — the byte layout is identical.
const asTyped = (a: Float32Array | Uint32Array): TypedArray => a as unknown as TypedArray;

/**
 * Build a gltf-transform Document from tessellated meshes + an assembly tree. One glTF
 * Mesh/Primitive per CadMesh; nodes recreate the hierarchy and reference meshes by index.
 * Metadata is stashed in the asset extras so the viewer gets units/bbox/tree without a second
 * request. Returns the live Document so convert.ts can run transforms before writing.
 */
export function buildCadDocument(
  meshes: CadMesh[],
  tree: CadNode,
  meta: Omit<ConvertMeta, "glb">,
): Document {
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

  return doc;
}

/** Total triangle count across every primitive in the Document (indexed geometry). */
export function countTriangles(doc: Document): number {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      if (idx) tris += idx.getCount() / 3;
      else {
        const pos = prim.getAttribute("POSITION");
        if (pos) tris += pos.getCount() / 3;
      }
    }
  }
  return tris;
}

/**
 * Decimate the Document in place to ~`ratio` of its triangles via meshopt quadric simplification.
 * `ratio` is a target fraction (0..1); callers clamp it to a sane floor because extreme ratios
 * (e.g. collapsing a million-triangle assembly to a few thousand) throw away real fidelity — edges
 * get merged and thin features can vanish. `weld()` first so simplify has manifold, shared-vertex
 * geometry to collapse (occt emits per-primitive index arrays that may not be welded).
 */
export async function simplifyDocument(doc: Document, ratio: number): Promise<void> {
  await MeshoptSimplifier.ready;
  // error is a relative bound on geometric deviation; 0.01 (1% of AABB) tolerates aggressive
  // reduction. lockBorder keeps shared edges stable across the assembly's separate primitives.
  await doc.transform(
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: true }),
  );
}

/**
 * Apply KHR_mesh_quantization + EXT_meshopt_compression to the Document in place. This is what the
 * web GLTFLoader decodes via MeshoptDecoder (no external decoder files, unlike Draco). Call before
 * writeGlbBinary(doc, true).
 */
export async function compressDocument(doc: Document): Promise<void> {
  await MeshoptEncoder.ready;
  await doc.transform(quantize(), meshopt({ encoder: MeshoptEncoder }));
}

/**
 * Serialize the Document to GLB bytes. When `compressed` is true the meshopt + quantization
 * extensions must be registered on the IO or gltf-transform silently drops the compressed buffer
 * views on write. We read the extension *constructors* straight off the Document's used-extensions
 * (compressDocument attached them) rather than importing @gltf-transform/extensions directly — that
 * package is only a transitive dep, so this keeps our declared dependency surface stable.
 */
export async function writeGlbBinary(doc: Document, compressed: boolean): Promise<Uint8Array> {
  // WebIO.writeBinary returns a GLB Uint8Array and works under Bun (no node:fs dependency).
  const io = new WebIO();
  if (compressed) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extension ctor type is internal.
    const ctors = doc.getRoot().listExtensionsUsed().map((e) => e.constructor as any);
    io.registerExtensions(ctors);
    io.registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  }
  return io.writeBinary(doc);
}

/**
 * Serialize tessellated meshes + an assembly tree into a single uncompressed GLB. Thin wrapper kept
 * for callers that don't need the decimation/compression pipeline.
 */
export async function meshesToGlb(
  meshes: CadMesh[],
  tree: CadNode,
  meta: Omit<ConvertMeta, "glb">,
): Promise<Uint8Array> {
  return writeGlbBinary(buildCadDocument(meshes, tree, meta), false);
}
