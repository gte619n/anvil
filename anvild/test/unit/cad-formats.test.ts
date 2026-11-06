import { describe, expect, test } from "bun:test";
import { classifyExt, extOf, isBrep, isKicadPcb } from "../../src/cad/formats";

describe("classifyExt", () => {
  test("B-rep extensions", () => {
    expect(classifyExt("step")).toBe("brep");
    expect(classifyExt("STP")).toBe("brep");
    expect(classifyExt("iges")).toBe("brep");
    expect(classifyExt("fcstd")).toBe("brep");
  });

  test("mesh extensions", () => {
    expect(classifyExt("stl")).toBe("mesh");
    expect(classifyExt("glb")).toBe("mesh");
  });

  test("kicad double-barrelled extensions", () => {
    expect(classifyExt("kicad_pcb")).toBe("kicad-pcb");
    expect(classifyExt("kicad_sch")).toBe("kicad-sch");
  });

  test("gerber extensions", () => {
    expect(classifyExt("gbr")).toBe("gerber");
    expect(classifyExt("gtl")).toBe("gerber");
    // .txt is ambiguous and intentionally NOT classified as gerber
    expect(classifyExt("txt")).toBe("unknown");
  });

  test("unknown", () => {
    expect(classifyExt("pdf")).toBe("unknown");
    expect(classifyExt("")).toBe("unknown");
  });
});

describe("helpers", () => {
  test("extOf", () => {
    expect(extOf("/a/b/c.STEP")).toBe("step");
    expect(extOf("foo.kicad_pcb")).toBe("kicad_pcb");
    expect(extOf("noext")).toBe("");
  });

  test("isBrep", () => {
    expect(isBrep("step")).toBe(true);
    expect(isBrep("stl")).toBe(false);
  });

  test("isKicadPcb", () => {
    expect(isKicadPcb("/x/board.kicad_pcb")).toBe(true);
    expect(isKicadPcb("/x/board.kicad_sch")).toBe(false);
  });
});
