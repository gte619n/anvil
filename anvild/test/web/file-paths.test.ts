import { describe, expect, test } from "bun:test";
import { fileChipIcon, fileChipKind, viewablePathRe } from "../../web/src/file-paths";

const matches = (text: string): string[] => text.match(viewablePathRe()) ?? [];

describe("viewablePathRe — which prose mentions become clickable file chips", () => {
  test("links CAD model + PCB paths", () => {
    expect(matches("open pcb/out/sync12_main.glb now")).toEqual(["pcb/out/sync12_main.glb"]);
    expect(matches("mirror_adapter/mirror_riser_v2_preview.stl ← open")).toEqual(["mirror_adapter/mirror_riser_v2_preview.stl"]);
    expect(matches("the STEP is at out/part.step")).toEqual(["out/part.step"]);
    expect(matches("board.kicad_pcb and sheet.kicad_sch")).toEqual(["board.kicad_pcb", "sheet.kicad_sch"]);
    expect(matches("./a/b/c.3mf")).toEqual(["./a/b/c.3mf"]);
  });

  test("links image + markdown paths", () => {
    expect(matches("see render.png")).toEqual(["render.png"]);
    expect(matches("docs/plans/design.md")).toEqual(["docs/plans/design.md"]);
  });

  test("does NOT linkify ordinary words or unknown extensions", () => {
    expect(matches("let me step through this and e.g. do a thing")).toEqual([]);
    expect(matches("the object is a plan")).toEqual([]);
    expect(matches("config.json and script.ts stay plain")).toEqual([]);
  });

  test("extension wins over a shorter prefix (step vs stp)", () => {
    expect(matches("a.step")).toEqual(["a.step"]);
    expect(matches("a.stp")).toEqual(["a.stp"]);
  });
});

describe("fileChipKind / fileChipIcon", () => {
  test("model → 3D cube icon, image → image, doc → description", () => {
    expect(fileChipKind("x.glb")).toBe("model");
    expect(fileChipKind("x.kicad_pcb")).toBe("model");
    expect(fileChipKind("x.png")).toBe("image");
    expect(fileChipKind("x.md")).toBe("doc");
    expect(fileChipIcon("x.step")).toBe("deployed_code");
    expect(fileChipIcon("x.jpg")).toBe("image");
  });
});
