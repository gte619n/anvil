/**
 * Tiny GLB fixtures for the live-viewer spec (live.pw.ts) and the preview unit tests: one or more
 * axis-aligned boxes, written the way SolidCraft writes a preview — metres, Y up (CAD x, y, z in mm
 * become x, z, -y in metres) — with normals, as a standard two-chunk GLB.
 */
export type BoxMm = { size: [number, number, number]; at?: [number, number, number] };

const FACES: { n: [number, number, number]; c: [number, number, number][] }[] = [
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];
const toGl = (v: [number, number, number]): [number, number, number] => [v[0] / 1000, v[2] / 1000, -v[1] / 1000];
const dirGl = (v: [number, number, number]): [number, number, number] => [v[0], v[2], -v[1]];

/** A GLB holding one mesh per box. 12 triangles and 24 vertices per box. */
export function boxesGlb(boxes: BoxMm[]): Uint8Array {
  const nodes: unknown[] = [];
  const meshes: unknown[] = [];
  const accessors: unknown[] = [];
  const bufferViews: unknown[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;
  const view = (buf: Buffer, target: number): number => {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
    chunks.push(buf);
    offset += buf.length;
    return bufferViews.length - 1;
  };
  boxes.forEach((box, bi) => {
    const at = box.at ?? [0, 0, 0];
    const pos = Buffer.alloc(24 * 12);
    const nor = Buffer.alloc(24 * 12);
    const idx = Buffer.alloc(36 * 2);
    const pts: [number, number, number][] = [];
    FACES.forEach((f, fi) => {
      f.c.forEach((c, ci) => {
        const p = toGl([at[0] + c[0] * box.size[0], at[1] + c[1] * box.size[1], at[2] + c[2] * box.size[2]]);
        const n = dirGl(f.n);
        pts.push(p);
        for (let k = 0; k < 3; k++) {
          pos.writeFloatLE(p[k]!, (fi * 4 + ci) * 12 + k * 4);
          nor.writeFloatLE(n[k]!, (fi * 4 + ci) * 12 + k * 4);
        }
      });
      [0, 1, 2, 0, 2, 3].forEach((v, k) => idx.writeUInt16LE(fi * 4 + v, (fi * 6 + k) * 2));
    });
    const lo = [0, 1, 2].map((k) => Math.fround(Math.min(...pts.map((p) => p[k]!))));
    const hi = [0, 1, 2].map((k) => Math.fround(Math.max(...pts.map((p) => p[k]!))));
    const [pv, nv, iv] = [view(pos, 34962), view(nor, 34962), view(idx, 34963)];
    accessors.push({ bufferView: pv, componentType: 5126, count: 24, type: "VEC3", min: lo, max: hi }, { bufferView: nv, componentType: 5126, count: 24, type: "VEC3" }, { bufferView: iv, componentType: 5123, count: 36, type: "SCALAR" });
    meshes.push({ name: `Body${bi + 1}`, primitives: [{ attributes: { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 }, indices: accessors.length - 1 }] });
    nodes.push({ name: `Body${bi + 1}`, mesh: meshes.length - 1 });
  });
  const bin = Buffer.concat(chunks);
  let json = JSON.stringify({ asset: { version: "2.0", generator: "anvil-test" }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors, bufferViews, buffers: [{ byteLength: bin.length }] });
  json += " ".repeat((4 - (Buffer.byteLength(json) % 4)) % 4);
  const jsonBuf = Buffer.from(json);
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "latin1");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.write("JSON", 4, "latin1");
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.write("BIN\0", 4, "latin1");
  return new Uint8Array(Buffer.concat([head, jh, jsonBuf, bh, bin]));
}

type V3 = [number, number, number];
/** Apply a glTF node's scale, then rotation (unit quaternion x, y, z, w), then translation. */
function applyTrs(p: V3, node: { scale?: number[]; rotation?: number[]; translation?: number[] }): V3 {
  const s = node.scale ?? [1, 1, 1];
  const v: V3 = [p[0] * s[0]!, p[1] * s[1]!, p[2] * s[2]!];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  // v' = v + 2w(q × v) + 2 q × (q × v)
  const cx = qy! * v[2] - qz! * v[1];
  const cy = qz! * v[0] - qx! * v[2];
  const cz = qx! * v[1] - qy! * v[0];
  const r: V3 = [v[0] + 2 * (qw! * cx + qy! * cz - qz! * cy), v[1] + 2 * (qw! * cy + qz! * cx - qx! * cz), v[2] + 2 * (qw! * cz + qx! * cy - qy! * cx)];
  const t = node.translation ?? [0, 0, 0];
  return [r[0] + t[0]!, r[1] + t[1]!, r[2] + t[2]!];
}

/**
 * What a GLB holds, read without a 3D library: the mesh count and the bounding box of the default
 * scene in WORLD space — every POSITION accessor's min/max corners carried through the node
 * hierarchy's scale / rotation / translation, which is where SolidCraft puts millimetres-to-metres
 * and Z-up-to-Y-up. So `min`/`max` are in the units and axes a viewer shows: metres, Y up.
 * Throws on anything that is not a GLB (magic, version 2, length field, a JSON chunk first).
 */
export function readGlb(bytes: Uint8Array): { json: any; meshes: number; min: V3; max: V3 } {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 20 || b.toString("latin1", 0, 4) !== "glTF") throw new Error("not a GLB: bad magic");
  if (b.readUInt32LE(4) !== 2) throw new Error(`not a GLB 2: version ${b.readUInt32LE(4)}`);
  if (b.readUInt32LE(8) !== b.length) throw new Error("GLB length field does not match the file");
  const jsonLen = b.readUInt32LE(12);
  if (b.toString("latin1", 16, 20) !== "JSON") throw new Error("GLB has no JSON chunk first");
  const json = JSON.parse(b.toString("utf8", 20, 20 + jsonLen));
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  const nodes: any[] = json.nodes ?? [];
  const visit = (index: number, chain: any[]): void => {
    const node = nodes[index];
    if (!node) return;
    if (node.matrix) throw new Error("readGlb does not read node matrices");
    const path = [node, ...chain]; // innermost first
    for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
      const acc = json.accessors?.[prim.attributes?.POSITION];
      if (!acc?.min || !acc?.max) continue;
      for (let c = 0; c < 8; c++) {
        let p: V3 = [c & 1 ? acc.max[0] : acc.min[0], c & 2 ? acc.max[1] : acc.min[1], c & 4 ? acc.max[2] : acc.min[2]];
        for (const n of path) p = applyTrs(p, n);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, p[k]!);
          max[k] = Math.max(max[k]!, p[k]!);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, path);
  };
  for (const root of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(root, []);
  return { json, meshes: (json.meshes ?? []).length, min, max };
}
