/**
 * [A2] The hole table (agent-cad-and-browser spec §4.14 #7; the A0 algorithm): cylinders from
 * `body_topology {faces:"cylinders"}`, concavity from `view.pick` rays, one row per coaxial concave
 * stack keyed by its smallest diameter.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { RAYS_PER_CYLINDER, holeSummary, holeTable, holesFromPicks, mergeHoleTables, raysFor, type Cylinder, type PickHit } from "../../src/cadwork/holes";
import type { McpToolResult } from "../../src/cadwork/mcp-client";
import { REFERENCE_PLATE, startFake, type FakeSolidcraft } from "../helpers/fake-solidcraft";

const open: FakeSolidcraft[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});
async function design(commands: { command: string; params: Record<string, unknown> }[], env: Record<string, string> = {}) {
  const sc = await startFake({ env });
  open.push(sc);
  const built = await sc.call("batch", { commands });
  if (built.isError) throw new Error(built.text);
  const calls: { tool: string; args: any }[] = [];
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    return (await sc.call(tool, args)) as unknown as McpToolResult;
  };
  return { sc, call, calls };
}
const BLOCK = { command: "solid.box", params: { length: 40, width: 30, height: 10, name: "Block" } };

describe("cad holes", () => {
  test("[A2] the plate's four counterbored holes are ONE row: ⌀3.4 through, with the counterbore listed", async () => {
    const { call, calls } = await design(REFERENCE_PLATE);
    const table = await holeTable(call, "Body1");
    expect(table).toEqual([{ diameter: 3.4, kind: "through", depth: 6, counterbore: [{ diameter: 6.5, depth: 3.3 }], count: 4 }]);
    expect(holeSummary(table)).toEqual([{ diameter: 3.4, count: 4, kind: "through" }]);
    // One topology read and one pick call: 12 cylinders × 26 rays (4 fillets, 4 counterbores, 4 bores).
    expect(calls.map((c) => c.tool)).toEqual(["body_topology", "execute"]);
    expect(calls[0]!.args).toEqual({ body: "Body1", faces: "cylinders" });
    expect(calls[1]!.args.command).toBe("view.pick");
    expect(calls[1]!.args.params.all).toBe(true);
    expect(calls[1]!.args.params.rays).toHaveLength(12 * RAYS_PER_CYLINDER);
    expect(RAYS_PER_CYLINDER).toBe(26);
  });

  test("[A2] a part with one blind hole and one boss has exactly the blind hole; fillets, bosses and missed cuts are not holes", async () => {
    const { call } = await design([
      BLOCK,
      { command: "solid.fillet", params: { edges: [[0, 0, 5], [40, 0, 5], [0, 30, 5], [40, 30, 5]], radius: 4, name: "Corners" } },
      { command: "solid.cylinder", params: { radius: 4, height: 5, base: [10, 15, 10], operation: "join", name: "Boss" } },
      { command: "solid.hole", params: { position: [30, 15, 10], diameter: 6, depth: 6, name: "Blind" } },
    ]);
    expect(await holeTable(call, "Body1")).toEqual([{ diameter: 6, kind: "blind", depth: 6, count: 1 }]);

    // A cylinder CUT is a hole like any other; a through one and a blind one of the same diameter are two rows.
    const two = await design([
      BLOCK,
      { command: "solid.cylinder", params: { radius: 2.5, height: 10, base: [10, 15, 0], operation: "cut", name: "Thru" } },
      { command: "solid.hole", params: { position: [30, 15, 10], diameter: 5, depth: 4, name: "Blind" } },
    ]);
    const rows = await holeTable(two.call, "Body1");
    expect(rows).toEqual([
      { diameter: 5, kind: "blind", depth: 4, count: 1 },
      { diameter: 5, kind: "through", depth: 10, count: 1 },
    ]);
    expect(holeSummary(rows)).toEqual([
      { diameter: 5, count: 1, kind: "blind" },
      { diameter: 5, count: 1, kind: "through" },
    ]);

    // A body with no cylinders at all needs no pick call; a cut that missed leaves no hole.
    const plain = await design([BLOCK]);
    expect(await holeTable(plain.call, "Body1")).toEqual([]);
    expect(plain.calls.map((c) => c.tool)).toEqual(["body_topology"]);
    const missed = await design([BLOCK, { command: "solid.hole", params: { position: [30, 15, 10], diameter: 5, name: "H" } }], { FAKE_SC_MISS_CUTS: "1" });
    expect(await holeTable(missed.call, "Body1")).toEqual([]);
    // A standalone cylinder body (a boss with nothing around it) is not a hole either.
    const rod = await design([{ command: "solid.cylinder", params: { radius: 5, height: 20, name: "Rod" } }]);
    expect(await holeTable(rod.call, "Body1")).toEqual([]);
  });

  test("[A2] concavity needs 6 of 8 rays: a slot end (4 of 8) and a fillet (2 of 8) are not holes; a floor makes a hole blind", () => {
    const c: Cylinder = { axis: [0, 0, 1], extent: [0, 10], origin: [0, 0, 0], radius: 2 };
    const rays = raysFor(c);
    expect(rays).toHaveLength(26);
    // Radial rays are perpendicular to the axis and start on it; the last two run along it from the middle.
    for (const r of rays.slice(0, 24)) expect(Math.abs(r.dir[2])).toBeLessThan(1e-12);
    expect(rays.slice(0, 8).every((r) => Math.abs(r.origin[2] - 10 / 6) < 1e-9)).toBe(true);
    expect(rays[24]).toEqual({ origin: [0, 0, 5], dir: [0, 0, 1] });
    expect(rays[25]).toEqual({ origin: [0, 0, 5], dir: [-0, -0, -1] });
    const wall = (k: number): PickHit[] => [{ body: "B", depth: 2, normal: [-rays[k]!.dir[0], -rays[k]!.dir[1], 0] }];
    const picks = (concavePerStation: number, floor: "none" | "minus" | "far") =>
      rays.map((_, k) => {
        if (k < 24) return k % 8 < concavePerStation ? wall(k) : [];
        if (k === 25 && floor === "minus") return [{ body: "B", depth: 5, normal: [0, 0, 1] as [number, number, number] }];
        if (k === 25 && floor === "far") return [{ body: "B", depth: 40, normal: [0, 0, 1] as [number, number, number] }];
        return [];
      });
    expect(holesFromPicks("B", [c], picks(8, "none"))).toEqual([{ diameter: 4, kind: "through", depth: 10, count: 1 }]);
    expect(holesFromPicks("B", [c], picks(6, "none"))).toHaveLength(1);
    expect(holesFromPicks("B", [c], picks(5, "none"))).toEqual([]);
    expect(holesFromPicks("B", [c], picks(4, "none"))).toEqual([]); // a slot end
    expect(holesFromPicks("B", [c], picks(2, "none"))).toEqual([]); // a fillet
    expect(holesFromPicks("B", [c], picks(0, "none"))).toEqual([]); // a boss
    expect(holesFromPicks("B", [c], picks(8, "minus"))[0]!.kind).toBe("blind");
    expect(holesFromPicks("B", [c], picks(8, "far"))[0]!.kind).toBe("through"); // something far beyond the hole is not its floor
    // A hit on ANOTHER body in front (a reference part in the hole) is skipped, not mistaken for the wall.
    const blocked = rays.map((_, k) => (k < 24 ? [{ body: "Ref", depth: 1, normal: [0, 0, 1] as [number, number, number] }, ...wall(k)] : []));
    expect(holesFromPicks("B", [c], blocked)).toHaveLength(1);
    // A wall at the wrong distance, or facing away, is not this cylinder's wall.
    const wrongDepth = rays.map((_, k) => (k < 24 ? [{ body: "B", depth: 2.5, normal: wall(k)[0]!.normal }] : []));
    expect(holesFromPicks("B", [c], wrongDepth)).toEqual([]);
    const convex = rays.map((r, k) => (k < 24 ? [{ body: "B", depth: 2, normal: r.dir }] : []));
    expect(holesFromPicks("B", [c], convex)).toEqual([]);
    expect(() => holesFromPicks("B", [c], [])).toThrow("view.pick answered 0 rays");
  });

  test("[A2] coaxial sections stack into one row keyed by the smallest diameter; separate axes and bodies add up", () => {
    const bore: Cylinder = { axis: [0, 0, 1], extent: [0, 6], origin: [5, 5, 0], radius: 1.7 };
    const cbore: Cylinder = { axis: [0, 0, -1], extent: [-10, -6], origin: [5, 5, 0], radius: 3.25 }; // same axis, opposite sense
    const elsewhere: Cylinder = { axis: [0, 0, 1], extent: [0, 6], origin: [20, 5, 0], radius: 1.7 };
    const all = (c: Cylinder): PickHit[][] => raysFor(c).map((r, k) => (k < 24 ? [{ body: "B", depth: c.radius, normal: [-r.dir[0], -r.dir[1], -r.dir[2]] }] : []));
    const table = holesFromPicks("B", [bore, cbore, elsewhere], [...all(bore), ...all(cbore), ...all(elsewhere)]);
    expect(table).toEqual([
      { diameter: 3.4, kind: "through", depth: 6, count: 1 },
      { diameter: 3.4, kind: "through", depth: 10, counterbore: [{ diameter: 6.5, depth: 4 }], count: 1 },
    ]);
    expect(holeSummary(table)).toEqual([{ diameter: 3.4, count: 2, kind: "through" }]);
    expect(mergeHoleTables([table, table])).toEqual(table.map((r) => ({ ...r, count: 2 })));
  });

  test("[A2] many cylinders are picked in chunks of whole cylinders under the 1024-ray limit, and errors are thrown, not swallowed", async () => {
    // 45 through holes → 45 cylinders → 1170 rays → two pick calls (39 cylinders, then 6).
    const holes = Array.from({ length: 45 }, (_, i) => ({ command: "solid.hole", params: { position: [5 + (i % 9) * 10, 5 + Math.floor(i / 9) * 10, 10], diameter: 3, name: `H${i}` } }));
    const { call, calls } = await design([{ command: "solid.box", params: { length: 100, width: 60, height: 10, name: "Slab" } }, ...holes]);
    expect(await holeTable(call, "Body1")).toEqual([{ diameter: 3, kind: "through", depth: 10, count: 45 }]);
    const picks = calls.filter((c) => c.tool === "execute");
    expect(picks.map((c) => c.args.params.rays.length)).toEqual([39 * 26, 6 * 26]);
    expect(picks.every((c) => c.args.params.rays.length <= 1024)).toBe(true);
    await expect(holeTable(call, "NoSuchBody")).rejects.toThrow("body_topology failed");
    const broken = async (tool: string) => ({ isError: tool !== "body_topology", text: "pick exploded", json: tool === "body_topology" ? { cylinders: [{ axis: [0, 0, 1], extent: [0, 1], origin: [0, 0, 0], radius: 1 }] } : undefined }) as unknown as McpToolResult;
    await expect(holeTable(broken, "B")).rejects.toThrow("view.pick failed: pick exploded");
    const garbage = async () => ({ isError: false, text: "", json: { cylinders: [{ radius: -1 }] } }) as unknown as McpToolResult;
    await expect(holeTable(garbage, "B")).rejects.toThrow("could not be read");
  });
});
