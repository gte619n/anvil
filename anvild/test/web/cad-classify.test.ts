// Pure-classifier tests for the CAD viewer. No DOM needed — `classifyCad`/`extOf` are dependency-free
// string logic, so we import them straight from the shared contract module.
import { test, expect } from "bun:test";
import {
  classifyCad,
  extOf,
  MESH_EXTS,
  BREP_EXTS,
  GERBER_EXTS,
} from "../../web/src/cad-types";

test("classifyCad maps each pipeline by extension", () => {
  expect(classifyCad("part.step")).toBe("brep");
  expect(classifyCad("part.STP")).toBe("brep"); // case-insensitive
  expect(classifyCad("widget.stl")).toBe("mesh");
  expect(classifyCad("widget.glb")).toBe("mesh");
  expect(classifyCad("board.kicad_pcb")).toBe("kicad-pcb");
  expect(classifyCad("board.kicad_sch")).toBe("kicad-sch");
  expect(classifyCad("top.gbr")).toBe("gerber");
});

test("classifyCad returns null for files we don't handle", () => {
  expect(classifyCad("readme.md")).toBeNull();
  expect(classifyCad("notes.txt")).toBeNull(); // .txt is deliberately NOT treated as Gerber drill
  expect(classifyCad("noextension")).toBeNull();
});

test("KiCad double-barrelled extensions win over the trailing ext", () => {
  // extOf would see "kicad_pcb" as the ext; classifyCad special-cases it first.
  expect(classifyCad("/a/b/board.kicad_pcb")).toBe("kicad-pcb");
});

test("extOf extracts the lower-case extension without a dot", () => {
  expect(extOf("part.STEP")).toBe("step");
  expect(extOf("/some/dir/Widget.StL")).toBe("stl");
  expect(extOf("archive.tar.gz")).toBe("gz");
  expect(extOf("noext")).toBe("");
});

test("extension sets carry the expected members", () => {
  expect(MESH_EXTS.has("stl")).toBe(true);
  expect(MESH_EXTS.has("glb")).toBe(true);
  expect(MESH_EXTS.has("step")).toBe(false);
  expect(BREP_EXTS.has("step")).toBe(true);
  expect(BREP_EXTS.has("stp")).toBe(true);
  expect(BREP_EXTS.has("stl")).toBe(false);
  expect(GERBER_EXTS.has("gbr")).toBe(true);
});
