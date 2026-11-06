// Pure layer-selection tests for the Gerber adapter. The only browser-free unit in cad-ecad.ts is
// `selectGerberLayers`, which runs whats-that-gerber over a directory listing and keeps only the
// recognised Gerber/drill files. No DOM needed.
import { test, expect } from "bun:test";
import { selectGerberLayers } from "../../web/src/cad-ecad";

test("selectGerberLayers keeps recognised gerbers + drills, drops the rest", () => {
  const kept = selectGerberLayers([
    "board.gtl", // top copper
    "board.gbl", // bottom copper
    "board.drl", // Excellon drill
    "readme.txt", // not a gerber
    "board.gto", // top silkscreen
  ]);

  expect(kept).toContain("board.gtl");
  expect(kept).toContain("board.gbl");
  expect(kept).toContain("board.drl");
  expect(kept).toContain("board.gto");
  expect(kept).not.toContain("readme.txt");
  expect(kept.length).toBe(4);
});

test("selectGerberLayers preserves input order of the kept files", () => {
  const kept = selectGerberLayers(["board.gbl", "board.gtl", "notes.md"]);
  expect(kept).toEqual(["board.gbl", "board.gtl"]);
});

test("selectGerberLayers returns [] for an empty listing", () => {
  expect(selectGerberLayers([])).toEqual([]);
});

test("selectGerberLayers drops a folder with no recognisable gerbers", () => {
  expect(selectGerberLayers(["readme.txt", "logo.png", "spec.pdf"])).toEqual([]);
});
