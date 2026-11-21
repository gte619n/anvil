/**
 * The hole table (agent-cad-and-browser spec §4.14 #7; algorithm from the A0 spike evidence).
 *
 * `body_topology {faces:"cylinders"}` lists a body's cylindrical faces but says nothing about which
 * side the material is on, so a hole, a boss and a fillet all look alike. Concavity comes from rays
 * (`execute view.pick`): from points on a cylinder's axis, shoot outwards; in a hole the nearest hit
 * on the body is the cylinder wall itself, at one radius, with its outward normal pointing back at
 * the axis. A boss scores 0 of 8 rays, a fillet 2, a slot end 4; a hole needs 6.
 *
 * One row is one coaxial stack of concave cylinders, keyed by its SMALLEST diameter — so a
 * counterbored hole is one row. Countersinks (cones) and slots are not holes.
 */
import type { McpToolResult } from "./mcp-client";
import type { HoleKind } from "./partfile";

type V3 = [number, number, number];

export interface Cylinder {
  axis: V3;
  /** [min, max] along `axis`, measured from `origin`. */
  extent: [number, number];
  names?: string[];
  origin: V3;
  radius: number;
}

export interface PickHit {
  body: string;
  depth: number;
  normal: V3;
}

export interface Ray {
  origin: V3;
  dir: V3;
}

export interface HoleRow {
  diameter: number;
  kind: HoleKind;
  depth: number;
  counterbore?: { diameter: number; depth: number }[];
  count: number;
  /** Centre of each hole of the row (the middle of its narrowest bore, on the axis), mm. Only when
   *  asked for (`{ positions: true }` — the release spec sheet); never part of what makes a row. */
  positions?: V3[];
}

const RAYS_PER_STATION = 8;
const STATIONS = [1 / 6, 1 / 2, 5 / 6] as const; // three stations survive cross-drilling
export const RAYS_PER_CYLINDER = RAYS_PER_STATION * STATIONS.length + 2;
const TOL = 1e-3;
const MAX_RAYS_PER_CALL = 1024;
/** Whole cylinders per `view.pick` call. */
const CHUNK = Math.floor(MAX_RAYS_PER_CALL / RAYS_PER_CYLINDER) * RAYS_PER_CYLINDER;
const CONCAVE_MIN = 6;

const add = (a: V3, b: V3, k = 1): V3 => [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const n = Math.sqrt(dot(a, a));
  if (!(n > 0)) throw new Error("a cylinder has a zero-length axis");
  return [a[0] / n, a[1] / n, a[2] / n];
};
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

function validCylinder(c: unknown): c is Cylinder {
  const x = c as Cylinder;
  const v3 = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
  return !!x && v3(x.axis) && v3(x.origin) && Array.isArray(x.extent) && x.extent.length === 2 && x.extent.every((n) => typeof n === "number" && Number.isFinite(n)) && typeof x.radius === "number" && x.radius > 0;
}

/** The 26 rays that classify one cylinder: 8 radial rays at each of 3 stations, then +axis and −axis from its middle. */
export function raysFor(c: Cylinder): Ray[] {
  const a = unit(c.axis);
  const [e0, e1] = c.extent;
  // A vector not parallel to the axis: the world axis the cylinder's axis leans on least.
  const least = [0, 1, 2].reduce((best, k) => (Math.abs(a[k]!) < Math.abs(a[best]!) ? k : best), 0);
  const t: V3 = [0, 0, 0];
  t[least] = 1;
  const u0 = unit(cross(a, t));
  const v0 = cross(a, u0);
  const rays: Ray[] = [];
  for (const st of STATIONS) {
    const s = add(c.origin, a, e0 + (e1 - e0) * st);
    for (let k = 0; k < RAYS_PER_STATION; k++) {
      const th = ((11 + (360 * k) / RAYS_PER_STATION) * Math.PI) / 180;
      rays.push({ origin: s, dir: [Math.cos(th) * u0[0] + Math.sin(th) * v0[0], Math.cos(th) * u0[1] + Math.sin(th) * v0[1], Math.cos(th) * u0[2] + Math.sin(th) * v0[2]] });
    }
  }
  const mid = add(c.origin, a, (e0 + e1) / 2);
  rays.push({ origin: mid, dir: a }, { origin: mid, dir: [-a[0], -a[1], -a[2]] });
  return rays;
}

interface Classified {
  c: Cylinder;
  axis: V3;
  concaveRays: number;
  isHole: boolean;
  closedPlus: boolean;
  closedMinus: boolean;
}

/**
 * Build the table from a body's cylinders and the pick result for `cylinders.flatMap(raysFor)`
 * (`hits[i]` is the list for ray i, nearest first). Pure, so it can be tested on recorded data.
 */
export function holesFromPicks(body: string, cylinders: Cylinder[], hits: (PickHit[] | null | undefined)[], opts: { positions?: boolean } = {}): HoleRow[] {
  if (hits.length !== cylinders.length * RAYS_PER_CYLINDER) throw new Error(`view.pick answered ${hits.length} rays; ${cylinders.length * RAYS_PER_CYLINDER} were sent`);
  const firstOnBody = (list: PickHit[] | null | undefined): PickHit | undefined => (list ?? []).find((h) => h && h.body === body);
  const classified: Classified[] = cylinders.map((c, i) => {
    const rays = raysFor(c);
    const mine = hits.slice(i * RAYS_PER_CYLINDER, (i + 1) * RAYS_PER_CYLINDER);
    const r = c.radius;
    let concave = 0;
    for (let s = 0; s < STATIONS.length; s++) {
      let n = 0;
      for (let k = s * RAYS_PER_STATION; k < (s + 1) * RAYS_PER_STATION; k++) {
        const first = firstOnBody(mine[k]);
        if (first && Math.abs(first.depth - r) < TOL * Math.max(1, r) && dot(first.normal, rays[k]!.dir) < -0.99) n++;
      }
      concave = Math.max(concave, n);
    }
    const half = (c.extent[1] - c.extent[0]) / 2;
    const closed = (list: PickHit[] | null | undefined): boolean => {
      const first = firstOnBody(list);
      return first !== undefined && first.depth <= half + TOL;
    };
    return { c, axis: unit(c.axis), concaveRays: concave, isHole: concave >= CONCAVE_MIN, closedPlus: closed(mine[RAYS_PER_CYLINDER - 2]), closedMinus: closed(mine[RAYS_PER_CYLINDER - 1]) };
  });

  // Coaxial concave cylinders form one stack: parallel axes, and no sideways offset between them.
  const stacks: Classified[][] = [];
  for (const f of classified.filter((x) => x.isHole)) {
    const home = stacks.find((s) => {
      const g = s[0]!;
      const d: V3 = [f.c.origin[0] - g.c.origin[0], f.c.origin[1] - g.c.origin[1], f.c.origin[2] - g.c.origin[2]];
      const perp = add(d, g.axis, -dot(d, g.axis));
      return Math.abs(Math.abs(dot(f.axis, g.axis)) - 1) < 1e-6 && Math.sqrt(dot(perp, perp)) < TOL;
    });
    if (home) home.push(f);
    else stacks.push([f]);
  }

  const table = new Map<string, HoleRow>();
  for (const stack of stacks) {
    stack.sort((p, q) => p.c.radius - q.c.radius);
    const narrow = stack[0]!;
    const len = (x: Classified): number => x.c.extent[1] - x.c.extent[0];
    const smallest = round4(2 * narrow.c.radius);
    // Sections of the SAME diameter as the narrowest are the bore itself (a kernel may split it).
    const bores = stack.filter((x) => round4(2 * x.c.radius) === smallest);
    const wider = stack.filter((x) => round4(2 * x.c.radius) !== smallest);
    const hole: Omit<HoleRow, "count"> = {
      diameter: smallest,
      kind: bores.every((x) => !x.closedPlus && !x.closedMinus) ? "through" : "blind",
      depth: round4(stack.reduce((s, x) => s + len(x), 0)),
      ...(wider.length ? { counterbore: wider.map((x) => ({ diameter: round4(2 * x.c.radius), depth: round4(len(x)) })) } : {}),
    };
    const key = JSON.stringify(hole);
    const row = table.get(key);
    const centre = (): V3 => {
      const mid = add(narrow.c.origin, narrow.axis, (narrow.c.extent[0] + narrow.c.extent[1]) / 2);
      return [round4(mid[0]), round4(mid[1]), round4(mid[2])];
    };
    if (row) {
      row.count++;
      if (opts.positions) row.positions!.push(centre());
    } else table.set(key, { ...hole, count: 1, ...(opts.positions ? { positions: [centre()] } : {}) });
  }
  return [...table.values()].sort((p, q) => p.diameter - q.diameter || p.kind.localeCompare(q.kind) || p.depth - q.depth);
}

/** Merge several bodies' tables into one (identical records add up). */
export function mergeHoleTables(tables: HoleRow[][]): HoleRow[] {
  const out = new Map<string, HoleRow>();
  for (const row of tables.flat()) {
    const { count, positions, ...rest } = row;
    const key = JSON.stringify(rest);
    const have = out.get(key);
    if (have) {
      have.count += count;
      if (positions) have.positions = [...(have.positions ?? []), ...positions];
    } else out.set(key, { ...row, ...(positions ? { positions: [...positions] } : {}) });
  }
  return [...out.values()].sort((p, q) => p.diameter - q.diameter || p.kind.localeCompare(q.kind) || p.depth - q.depth);
}

/** The table as the gate and `part.json.measured` use it: one row per (diameter, kind). */
export function holeSummary(rows: HoleRow[]): { diameter: number; count: number; kind: HoleKind }[] {
  const out = new Map<string, { diameter: number; count: number; kind: HoleKind }>();
  for (const r of rows) {
    const key = `${r.diameter}|${r.kind}`;
    const have = out.get(key);
    if (have) have.count += r.count;
    else out.set(key, { diameter: r.diameter, count: r.count, kind: r.kind });
  }
  return [...out.values()].sort((p, q) => p.diameter - q.diameter || p.kind.localeCompare(q.kind));
}

/**
 * Measure one body's hole table on a live process: one `body_topology` call, then `view.pick` in
 * chunks of at most 1014 rays. Throws when SolidCraft answers an error — the gate then fails closed.
 */
export async function holeTable(call: (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>, body: string, opts: { positions?: boolean } = {}): Promise<HoleRow[]> {
  const topo = await call("body_topology", { body, faces: "cylinders" });
  if (topo.isError) throw new Error(`body_topology failed for ${body}: ${topo.text.slice(0, 300)}`);
  const raw: unknown = topo.json?.cylinders;
  if (!Array.isArray(raw)) throw new Error(`body_topology returned no cylinder list for ${body}`);
  const cylinders = raw.filter(validCylinder);
  if (cylinders.length !== raw.length) throw new Error(`body_topology returned a cylinder that could not be read for ${body}`);
  if (cylinders.length === 0) return [];
  const rays = cylinders.flatMap(raysFor);
  const hits: (PickHit[] | null)[] = [];
  for (let at = 0; at < rays.length; at += CHUNK) {
    const chunk = rays.slice(at, at + CHUNK);
    const picked = await call("execute", { command: "view.pick", params: { rays: chunk, all: true } });
    if (picked.isError) throw new Error(`view.pick failed: ${picked.text.slice(0, 300)}`);
    const list: unknown = picked.json?.hits;
    if (!Array.isArray(list) || list.length !== chunk.length) throw new Error("view.pick did not answer every ray");
    hits.push(...(list as (PickHit[] | null)[]));
  }
  return holesFromPicks(body, cylinders, hits, opts);
}
