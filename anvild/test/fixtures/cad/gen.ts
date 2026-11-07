/**
 * Deterministic CAD fixture generator — writes the mesh + ecad2d fixtures used by the
 * golden-image harness and the fixtures parse-test. Every file produced here is self-generated
 * and released CC0, so there are no provenance/licensing questions (unlike a scraped model).
 *
 * The solid is a 10mm cube spanning (0,0,0)..(10,10,10) in each format — matching the brep
 * fixture (`test/fixtures/cad/brep/cube.step`, a 10mm cube) so the whole fixture family agrees
 * on one canonical part. GLB/COLLADA/3MF are authored in millimetres and tag units="mm" where
 * the format allows, mirroring the brep units path (spec D20).
 *
 * Run:  bun run test/fixtures/cad/gen.ts
 */
import { Document, WebIO } from "@gltf-transform/core";
import { zipSync, strToU8 } from "fflate";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MESH = join(HERE, "mesh");
const ECAD = join(HERE, "ecad2d");

/** Edge length in millimetres. */
const S = 10;

// ── Cube geometry (shared) ──────────────────────────────────────────────────────────────────────
// 8 corners of a 0..S cube.
const V: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], // 0
  [S, 0, 0], // 1
  [S, S, 0], // 2
  [0, S, 0], // 3
  [0, 0, S], // 4
  [S, 0, S], // 5
  [S, S, S], // 6
  [0, S, S], // 7
];

/**
 * 12 triangles (2 per face), CCW when viewed from outside, with their outward face normal.
 * Faces: -Z (bottom), +Z (top), -Y (front), +Y (back), -X (left), +X (right).
 */
const TRIS: ReadonlyArray<{ a: number; b: number; c: number; n: readonly [number, number, number] }> = [
  // -Z bottom
  { a: 0, b: 2, c: 1, n: [0, 0, -1] },
  { a: 0, b: 3, c: 2, n: [0, 0, -1] },
  // +Z top
  { a: 4, b: 5, c: 6, n: [0, 0, 1] },
  { a: 4, b: 6, c: 7, n: [0, 0, 1] },
  // -Y front
  { a: 0, b: 1, c: 5, n: [0, -1, 0] },
  { a: 0, b: 5, c: 4, n: [0, -1, 0] },
  // +Y back
  { a: 3, b: 7, c: 6, n: [0, 1, 0] },
  { a: 3, b: 6, c: 2, n: [0, 1, 0] },
  // -X left
  { a: 0, b: 4, c: 7, n: [-1, 0, 0] },
  { a: 0, b: 7, c: 3, n: [-1, 0, 0] },
  // +X right
  { a: 1, b: 2, c: 6, n: [1, 0, 0] },
  { a: 1, b: 6, c: 5, n: [1, 0, 0] },
];

// ── ASCII STL ─────────────────────────────────────────────────────────────────────────────────
function asciiStl(): string {
  const L: string[] = ["solid cube"];
  for (const t of TRIS) {
    L.push(`  facet normal ${t.n[0]} ${t.n[1]} ${t.n[2]}`);
    L.push("    outer loop");
    for (const i of [t.a, t.b, t.c]) {
      const v = V[i]!;
      L.push(`      vertex ${v[0]} ${v[1]} ${v[2]}`);
    }
    L.push("    endloop");
    L.push("  endfacet");
  }
  L.push("endsolid cube");
  return L.join("\n") + "\n";
}

// ── Binary STL (80-byte header + uint32 count + 50 bytes/triangle) ───────────────────────────────
function binaryStl(): Uint8Array {
  const n = TRIS.length;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  // 80-byte header left as zeros, then the triangle count.
  dv.setUint32(80, n, true);
  let off = 84;
  const put = (x: number) => {
    dv.setFloat32(off, x, true);
    off += 4;
  };
  for (const t of TRIS) {
    put(t.n[0]);
    put(t.n[1]);
    put(t.n[2]);
    for (const i of [t.a, t.b, t.c]) {
      const v = V[i]!;
      put(v[0]);
      put(v[1]);
      put(v[2]);
    }
    dv.setUint16(off, 0, true); // attribute byte count
    off += 2;
  }
  return new Uint8Array(buf);
}

// ── Wavefront OBJ + MTL ─────────────────────────────────────────────────────────────────────────
function objMtl(): { obj: string; mtl: string } {
  const L: string[] = ["# 10mm cube (CC0, generated)", "mtllib cube.mtl", "o cube"];
  for (const v of V) L.push(`v ${v[0]} ${v[1]} ${v[2]}`);
  L.push("usemtl cube_mat");
  // OBJ is 1-indexed.
  for (const t of TRIS) L.push(`f ${t.a + 1} ${t.b + 1} ${t.c + 1}`);
  const obj = L.join("\n") + "\n";
  const mtl =
    [
      "# 10mm cube material (CC0, generated)",
      "newmtl cube_mat",
      "Ka 0.200 0.200 0.200",
      "Kd 0.720 0.750 0.800",
      "Ks 0.100 0.100 0.100",
      "Ns 32.0",
      "d 1.0",
      "illum 2",
    ].join("\n") + "\n";
  return { obj, mtl };
}

// ── ASCII PLY ─────────────────────────────────────────────────────────────────────────────────
function asciiPly(): string {
  const L: string[] = [
    "ply",
    "format ascii 1.0",
    "comment 10mm cube (CC0, generated)",
    `element vertex ${V.length}`,
    "property float x",
    "property float y",
    "property float z",
    `element face ${TRIS.length}`,
    "property list uchar int vertex_indices",
    "end_header",
  ];
  for (const v of V) L.push(`${v[0]} ${v[1]} ${v[2]}`);
  for (const t of TRIS) L.push(`3 ${t.a} ${t.b} ${t.c}`);
  return L.join("\n") + "\n";
}

// ── GLB (glTF binary) ───────────────────────────────────────────────────────────────────────────
async function glb(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();

  // Flatten to a non-indexed triangle soup so three.js' GLTFLoader gets face normals trivially.
  const positions: number[] = [];
  const normals: number[] = [];
  for (const t of TRIS) {
    for (const i of [t.a, t.b, t.c]) {
      const v = V[i]!;
      positions.push(v[0], v[1], v[2]);
      normals.push(t.n[0], t.n[1], t.n[2]);
    }
  }
  const pos = doc.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer);
  const nrm = doc.createAccessor().setType("VEC3").setArray(new Float32Array(normals)).setBuffer(buffer);
  const mat = doc
    .createMaterial("cube_mat")
    .setBaseColorFactor([0.72, 0.75, 0.8, 1])
    .setRoughnessFactor(0.65)
    .setMetallicFactor(0.1);
  const prim = doc.createPrimitive().setAttribute("POSITION", pos).setAttribute("NORMAL", nrm).setMaterial(mat);
  const mesh = doc.createMesh("cube").addPrimitive(prim);
  const node = doc.createNode("cube").setMesh(mesh);
  const scene = doc.createScene("cube").addChild(node);
  doc.getRoot().setDefaultScene(scene);
  // Mirror the brep units path (D20): declare millimetres via asset.extras.
  doc.getRoot().getAsset().extras = { units: "mm" };
  doc.getRoot().getAsset().generator = "anvil cad fixture gen";
  return await new WebIO().writeBinary(doc);
}

// ── Multi-part assembly GLB (base plate + two blocks) ────────────────────────────────────────────
// A 3-part named assembly so the model tree / isolate / section / explode features have real parts to
// act on (a single cube can't be exploded). Each part is a transformed copy of the unit cube.
async function assembly(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("assembly");
  const root = doc.createNode("assembly");
  scene.addChild(root);

  const part = (name: string, size: [number, number, number], pos: [number, number, number], color: [number, number, number, number]): void => {
    const positions: number[] = [];
    const normals: number[] = [];
    for (const t of TRIS) {
      for (const i of [t.a, t.b, t.c]) {
        const v = V[i]!;
        positions.push((v[0] / S) * size[0] + pos[0], (v[1] / S) * size[1] + pos[1], (v[2] / S) * size[2] + pos[2]);
        normals.push(t.n[0], t.n[1], t.n[2]);
      }
    }
    const posA = doc.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer);
    const nrmA = doc.createAccessor().setType("VEC3").setArray(new Float32Array(normals)).setBuffer(buffer);
    const mat = doc.createMaterial(`${name}_mat`).setBaseColorFactor(color).setRoughnessFactor(0.6).setMetallicFactor(0.1);
    const prim = doc.createPrimitive().setAttribute("POSITION", posA).setAttribute("NORMAL", nrmA).setMaterial(mat);
    root.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  };

  part("base", [40, 2, 24], [0, 0, 0], [0.45, 0.48, 0.52, 1]);
  part("block_a", [8, 8, 8], [6, 2, 8], [0.82, 0.45, 0.4, 1]);
  part("block_b", [10, 12, 8], [24, 2, 8], [0.4, 0.55, 0.75, 1]);

  doc.getRoot().setDefaultScene(scene);
  doc.getRoot().getAsset().extras = {
    units: "mm",
    tree: {
      name: "assembly",
      meshIndices: [],
      children: [
        { name: "base", meshIndices: [0], children: [] },
        { name: "block_a", meshIndices: [1], children: [] },
        { name: "block_b", meshIndices: [2], children: [] },
      ],
    },
  };
  doc.getRoot().getAsset().generator = "anvil cad fixture gen";
  return await new WebIO().writeBinary(doc);
}

// ── 3MF (ZIP: [Content_Types].xml + _rels/.rels + 3D/3dmodel.model) ──────────────────────────────
function threeMf(): Uint8Array {
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>\n`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>\n`;

  const verts = V.map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join("");
  const faces = TRIS.map((t) => `<triangle v1="${t.a}" v2="${t.b}" v3="${t.c}"/>`).join("");
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" ` +
    `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources><object id="1" type="model"><mesh>` +
    `<vertices>${verts}</vertices>` +
    `<triangles>${faces}</triangles>` +
    `</mesh></object></resources>` +
    `<build><item objectid="1"/></build>` +
    `</model>\n`;

  return zipSync(
    {
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(rels),
      "3D/3dmodel.model": strToU8(model),
    },
    { level: 0 }, // store (no compression) — deterministic bytes, trivially valid.
  );
}

// ── COLLADA 1.4 (.dae) ──────────────────────────────────────────────────────────────────────────
function collada(): string {
  const posFloats = V.flat().join(" ");
  // Normals, one per face, referenced per-vertex in the <p> list.
  const normList: number[] = [];
  for (const t of TRIS) normList.push(t.n[0], t.n[1], t.n[2]);
  const normFloats = normList.join(" ");
  // <p> interleaves POSITION + NORMAL indices (offset 0 and 1). Face f uses normal index f.
  const p = TRIS.map((t, f) => `${t.a} ${f} ${t.b} ${f} ${t.c} ${f}`).join(" ");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">` +
    `<asset><unit name="millimeter" meter="0.001"/><up_axis>Z_UP</up_axis></asset>` +
    `<library_geometries><geometry id="cube-geom" name="cube"><mesh>` +
    `<source id="cube-pos"><float_array id="cube-pos-arr" count="${V.length * 3}">${posFloats}</float_array>` +
    `<technique_common><accessor source="#cube-pos-arr" count="${V.length}" stride="3">` +
    `<param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>` +
    `</accessor></technique_common></source>` +
    `<source id="cube-norm"><float_array id="cube-norm-arr" count="${normList.length}">${normFloats}</float_array>` +
    `<technique_common><accessor source="#cube-norm-arr" count="${TRIS.length}" stride="3">` +
    `<param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>` +
    `</accessor></technique_common></source>` +
    `<vertices id="cube-vtx"><input semantic="POSITION" source="#cube-pos"/></vertices>` +
    `<triangles count="${TRIS.length}">` +
    `<input semantic="VERTEX" source="#cube-vtx" offset="0"/>` +
    `<input semantic="NORMAL" source="#cube-norm" offset="1"/>` +
    `<p>${p}</p>` +
    `</triangles>` +
    `</mesh></geometry></library_geometries>` +
    `<library_visual_scenes><visual_scene id="scene"><node id="cube" name="cube">` +
    `<instance_geometry url="#cube-geom"/>` +
    `</node></visual_scene></library_visual_scenes>` +
    `<scene><instance_visual_scene url="#scene"/></scene>` +
    `</COLLADA>\n`
  );
}

// ── ECAD 2D: synthetic RS-274X Gerber set + Excellon drill (CC0, hand-authored) ──────────────────
// A tiny 10mm square board outline with a couple of round pads. Minimal but tracespace-parseable.
function gerbers(): Record<string, string> {
  // Top copper: two round pads (D10 = 1.5mm circle) at (2,2) and (8,8).
  const gtl =
    [
      "G04 Anvil synthetic top copper (CC0)*",
      "%MOMM*%",
      "%FSLAX34Y34*%",
      "%ADD10C,1.5*%",
      "D10*",
      "X2000000Y2000000D03*",
      "X8000000Y8000000D03*",
      "M02*",
    ].join("\n") + "\n";

  // Bottom copper: one pad at (5,5).
  const gbl =
    [
      "G04 Anvil synthetic bottom copper (CC0)*",
      "%MOMM*%",
      "%FSLAX34Y34*%",
      "%ADD10C,1.5*%",
      "D10*",
      "X5000000Y5000000D03*",
      "M02*",
    ].join("\n") + "\n";

  // Top silkscreen: a 10mm square outline drawn with a thin line aperture (D11 = 0.15mm).
  const gto =
    [
      "G04 Anvil synthetic top silk (CC0)*",
      "%MOMM*%",
      "%FSLAX34Y34*%",
      "%ADD11C,0.15*%",
      "D11*",
      "X0Y0D02*",
      "X10000000Y0D01*",
      "X10000000Y10000000D01*",
      "X0Y10000000D01*",
      "X0Y0D01*",
      "M02*",
    ].join("\n") + "\n";

  return { "board.gtl": gtl, "board.gbl": gbl, "board.gto": gto };
}

function drill(): string {
  // Excellon: one 0.8mm hole at each copper pad location.
  return (
    [
      "M48",
      "; Anvil synthetic drill (CC0)",
      "METRIC,TZ",
      "T1C0.800",
      "%",
      "T1",
      "X2.0Y2.0",
      "X8.0Y8.0",
      "X5.0Y5.0",
      "T0",
      "M30",
    ].join("\n") + "\n"
  );
}

// ── write everything ────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  mkdirSync(MESH, { recursive: true });
  mkdirSync(ECAD, { recursive: true });

  const { obj, mtl } = objMtl();
  const outputs: Array<[string, string | Uint8Array]> = [
    [join(MESH, "cube.stl"), asciiStl()],
    [join(MESH, "cube-bin.stl"), binaryStl()],
    [join(MESH, "cube.obj"), obj],
    [join(MESH, "cube.mtl"), mtl],
    [join(MESH, "cube.ply"), asciiPly()],
    [join(MESH, "cube.glb"), await glb()],
    [join(MESH, "assembly.glb"), await assembly()],
    [join(MESH, "cube.3mf"), threeMf()],
    [join(MESH, "cube.dae"), collada()],
  ];

  const g = gerbers();
  for (const [name, text] of Object.entries(g)) outputs.push([join(ECAD, name), text]);
  outputs.push([join(ECAD, "board.drl"), drill()]);

  for (const [path, data] of outputs) {
    await Bun.write(path, data);
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    console.log(`wrote ${path.slice(HERE.length + 1)} (${size} bytes)`);
  }
  console.log(`\n${outputs.length} fixtures written.`);
}

if (import.meta.main) {
  await main();
}

export { asciiStl, binaryStl, objMtl, asciiPly, glb, assembly, threeMf, collada, gerbers, drill, S, TRIS, V };
