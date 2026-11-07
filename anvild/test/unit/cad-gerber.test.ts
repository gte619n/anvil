import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderGerberFromDir, selectGerberLayers } from "../../src/cad/gerber";

const FIX = join(import.meta.dir, "..", "fixtures", "cad");
const ECAD = join(FIX, "ecad2d");
const MESH = join(FIX, "mesh");

describe("selectGerberLayers", () => {
  test("keeps recognised copper/silk layers + drill, drops readme.txt", () => {
    const got = selectGerberLayers(["board.gtl", "board.gbl", "board.drl", "readme.txt", "board.gto"]).sort();
    expect(got).toEqual(["board.drl", "board.gbl", "board.gtl", "board.gto"].sort());
  });
  test("empty in → empty out", () => expect(selectGerberLayers([])).toEqual([]));
  test("drops .txt even though whats-that-gerber tags it as a drill", () => {
    expect(selectGerberLayers(["drill.txt"])).toEqual([]);
  });
});

describe("renderGerberFromDir (server-side pcb-stackup)", () => {
  test("composites the fixture board into top + bottom SVG", async () => {
    const stackup = await renderGerberFromDir(join(ECAD, "board.gtl"));
    expect(stackup.top).toContain("<svg");
    expect(stackup.bottom).toContain("<svg");
    expect(stackup.layerCount).toBeGreaterThanOrEqual(2);
  });
  test("throws when the directory has no recognised Gerber layers", async () => {
    await expect(renderGerberFromDir(join(MESH, "cube.stl"))).rejects.toThrow();
  });
});
