/**
 * Unit tests for the design-script screen (src/solidcraft/script-screen.ts): the allow list of
 * command ids, the ban on anything that names a file or a place, the two import exceptions, and
 * the envelope. The module is shared with Track A (manager load, verify), so the cases here are
 * the contract.
 */
import { describe, expect, test } from "bun:test";
import { ALLOWED_COMMANDS, FORBIDDEN_KEYS, MAX_SCRIPT_BYTES, isBareFileName, screenScript, screenScriptText, unsafeString } from "../../src/solidcraft/script-screen";

type Step = { command: string; params: Record<string, unknown> };
const script = (...commands: unknown[]) => ({ about: { design: "plate", format: "solidcraft/58", replay: "solidcraft-cli eval script.json", version: "0.44.1" }, commands });
const L: Step = { command: "parameters.add", params: { expression: "80 mm", name: "L", unit: "mm" } };
/** A step copied from a real 0.44.1 export: note the `dir` vectors and the `/` in expressions. */
const FILLET: Step = {
  command: "timeline.add",
  params: {
    feature: {
      edge_names: ["F2:side:l2|F2:side:l3", "F2:side:l1|F2:side:l4"],
      edge_refs: [{ dir: [0.0, 0.0, 1.0], max: [40.0, 25.0, 6.0], min: [-40.0, -25.0, 0.0] }],
      edges: [[40.0, 25.0, 3.0]],
      id: 3,
      name: "Corners",
      param_names: ["d4"],
      radius: "5",
      suppressed: false,
      type: "fillet",
    },
  },
};
const SKETCH: Step = { command: "timeline.add", params: { feature: { id: 4, name: "HolePts", plane: { base: { name: "XY", type: "origin" }, distance: "T", type: "offset" }, type: "sketch" }, params: [{ expression: "L/2 - inset", name: "d6", unit: "mm" }] } };
const IMPORT: Step = { command: "timeline.add", params: { feature: { file: "cube.step", id: 9, name: "ref-cube", step: "ISO-10303-21;\nHEADER;\nFILE_NAME('/Users/someone/../cube.step','2026');\nFILE_SCHEMA(('http://example/schema'));\nENDSEC;", type: "import" } } };
const refused = (s: unknown) => {
  const r = screenScript(s);
  if (r.ok) throw new Error("expected the script to be refused");
  return r;
};

describe("design-script screen", () => {
  test("[B2] a plain design script passes: parameters, real features, an imported reference and the settings steps", () => {
    const steps: Step[] = [
      { command: "document.units", params: { units: "in" } },
      { command: "document.metadata.set", params: { values: { part_number: "P-1" } } },
      { command: "material.create", params: { density_g_cm3: 3.3, name: "Unobtainium" } },
      L,
      SKETCH,
      FILLET,
      { command: "component.create", params: { activate: false, grounded: false, name: "ref-cube" } },
      { command: "occurrence.ground", params: { grounded: false, occurrence: "ref-cube:1" } },
      { command: "occurrence.move", params: { occurrence: "ref-cube:1", space: "local", to_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] } },
      { command: "component.metadata.set", params: { component: "ref-cube", values: { bom_type: null, description: null } } },
      IMPORT,
      { command: "material.assign", params: { bodies: ["Body1"], material: "Unobtainium" } },
    ];
    expect(screenScript(script(...steps))).toEqual({ ok: true });
    expect(new Set(steps.map((s) => s.command))).toEqual(new Set(ALLOWED_COMMANDS)); // every allowed id is exercised
    expect(screenScript(script())).toEqual({ ok: true }); // an empty design
    expect(screenScript({ commands: [L] })).toEqual({ ok: true }); // `about` is optional
  });

  test("[B2] every command that is not a design step is refused, with its index and id", () => {
    const outside = "/Users/victim/.ssh/authorized_keys";
    const bad: Step[] = [
      { command: "parameters.export", params: { path: outside } },
      { command: "file.save", params: { path: outside } },
      { command: "file.save_as", params: { path: outside } },
      { command: "file.export_step", params: { path: outside } },
      { command: "file.export", params: { path: outside } },
      { command: "timeline.export_script", params: { path: outside } },
      { command: "doc.open", params: { path: outside } },
      { command: "file.insert_step", params: { path: outside } },
      { command: "parameters.import", params: { path: outside } },
      { command: "settings.profile.export", params: { path: outside } },
      { command: "file.copy", params: { from: "a", to: "b" } },
      { command: "file.trash", params: {} },
      // Not file commands, and still not design steps: the list is an allow list.
      { command: "parameters.change", params: { name: "L", expression: "1" } },
      { command: "solid.box", params: { length: 1, width: 1, height: 1 } },
      { command: "batch", params: { commands: [] } },
      { command: "plugin.run", params: {} },
      { command: "TIMELINE.ADD", params: {} }, // ids are exact
      { command: "timeline.add ", params: {} },
      { command: "parameters.add\u0000", params: {} },
    ];
    for (const step of bad) {
      const r = refused(script(L, FILLET, step));
      expect(r.index).toBe(2);
      expect(r.command).toBe(step.command);
      expect(r.reason).toContain("step 3");
      expect(r.reason).toContain("not one SolidCraft writes into a design script");
    }
    // The first offender is the one reported.
    expect(refused(script(bad[0], bad[1])).index).toBe(0);
    // Without the path too: the id alone is enough.
    expect(refused(script({ command: "file.save", params: {} })).command).toBe("file.save");
  });

  test("[B2] a key that names a file or a place is refused at any depth and in any letter case, unless it holds only numbers", () => {
    expect(FORBIDDEN_KEYS).toEqual(["path", "dir", "filename", "url", "out", "output"]);
    for (const key of ["path", "Path", "PATH", "dir", "DIR", "filename", "FileName", "url", "URL", "out", "Out", "output", "OUTPUT", " path ", "ｐａｔｈ"]) {
      for (const params of [
        { [key]: "x.csv" },
        { feature: { [key]: "x" } },
        { feature: { a: [{ b: { [key]: "relative/file" } }] } },
        { feature: { [key]: { nested: "x" } } },
        { feature: { [key]: ["x"] } },
        { feature: { [key]: [1, 2, "three"] } },
      ]) {
        const r = refused(script(L, { command: "timeline.add", params }));
        expect(r.index).toBe(1);
        expect(r.command).toBe("timeline.add");
        expect(r.reason).toContain("names a file or a place");
      }
    }
    // The real scripts' direction vectors: a forbidden NAME holding only numbers is geometry.
    expect(screenScript(script({ command: "timeline.add", params: { feature: { edge_refs: [{ dir: [0, 0, 1] }], out: 3, output: null, path: [[1, 2], [3, 4]], url: false } } })).ok).toBe(true);
    // Near-miss names are not the forbidden ones.
    expect(screenScript(script({ command: "timeline.add", params: { feature: { dir1: [1, 0, 0], pathway: "a", outline: "b", directory_hint: "c" } } })).ok).toBe(true);
  });

  test("[B2] a string that is an absolute path, has a `..` segment or holds a URL is refused wherever it sits", () => {
    const refusedValues = [
      "/etc/passwd",
      "/tmp/x.csv",
      " /tmp/x.csv",
      "~/.ssh/authorized_keys",
      "~",
      "~root/x",
      "C:\\Windows\\system32",
      "c:/x",
      "\\\\server\\share\\x",
      "../x",
      "a/../../x",
      "a\\..\\x",
      "..",
      "x/..",
      "%2e%2e/x", // percent-encoded dots
      "%2E%2E%2Fx",
      "a/%2e%2e/b",
      "%252e%252e/x", // double-encoded
      "\uFF0E\uFF0E/x", // fullwidth dots
      "\u2025/x", // two-dot leader
      "\u2024\u2024/x", // one-dot leaders
      "..\uFF0Fx", // fullwidth slash
      "%2fetc%2fpasswd",
      "%ZZ/%2e%2e/x", // malformed encoding beside a real one
      "file:///etc/passwd",
      "FILE:/etc/passwd",
      "http://example.com/x",
      "https://example.com",
      "see https://example.com for why",
      "smb://host/share",
      "data:text/plain,hi",
      "javascript:alert(1)",
      "x\u0000y",
    ];
    for (const v of refusedValues) {
      expect(unsafeString(v)).toBeDefined();
      for (const params of [{ name: v }, { feature: { name: v } }, { feature: { list: ["ok", { deep: [v] }] } }, { values: { description: v } }]) {
        const r = refused(script({ command: "timeline.add", params }));
        expect(r.index).toBe(0);
      }
    }
    // What real scripts hold: expressions with `/` and `.`, edge names with `:` and `|`, units.
    for (const v of ["L/2 - inset", "W/2 - inset", "1.5 / 3", "80 mm", "F2:side:l2|F2:side:l3", "ref-cube:1", "0.44.1", "a..b", "...", "Aluminum - Satin", "~5 mm tolerance", "50%", "100% recycled", "sub/part", "x: y", "note: see drawing"]) {
      expect(unsafeString(v)).toBeUndefined();
      expect(screenScript(script({ command: "timeline.add", params: { feature: { name: v, list: [v] } } })).ok).toBe(true);
    }
  });

  test("[B2] the two import exceptions: `file` must be a bare name, and the embedded STEP text is not inspected", () => {
    // The STEP text above contains an absolute path, `..` and a URL, and passes.
    expect(screenScript(script(IMPORT)).ok).toBe(true);
    const withFile = (file: unknown) => script({ command: "timeline.add", params: { feature: { ...(IMPORT.params.feature as object), file } } });
    for (const file of ["refs/cube.step", "/tmp/cube.step", "../cube.step", "a\\cube.step", "", ".", "..", "cube.step ", "%2e%2e%2fcube.step", "file:cube.step", 7, null, ["cube.step"]]) {
      const r = refused(withFile(file));
      expect(r.command).toBe("timeline.add");
    }
    for (const file of ["cube.step", "My Part (rev 2).STEP", "bracket_v1.2.stp"]) expect(screenScript(withFile(file)).ok).toBe(true);
    expect(isBareFileName("cube.step")).toBe(true);
    expect(isBareFileName("a/b")).toBe(false);
    // The STEP exception is exactly `feature.step` of an IMPORT feature in a `timeline.add` step.
    const evil = "/etc/passwd";
    expect(refused(script({ command: "timeline.add", params: { feature: { type: "extrude", step: evil } } })).reason).toContain("absolute path");
    expect(refused(script({ command: "timeline.add", params: { feature: { type: "import", file: "a.step", step: "ok", nested: { step: evil } } } })).reason).toContain("absolute path");
    expect(refused(script({ command: "timeline.add", params: { step: evil, feature: { type: "import", file: "a.step", step: "ok" } } })).reason).toContain("absolute path");
    expect(refused(script({ command: "material.assign", params: { feature: { type: "import", step: evil } } })).reason).toContain("absolute path");
    expect(refused(script({ command: "timeline.add", params: { feature: { type: "import", file: "a.step", step: ["not", "text"] } } })).reason).toContain("STEP text");
    // A `file` key anywhere must be a bare name too.
    expect(refused(script({ command: "timeline.add", params: { feature: { type: "canvas", file: "img/photo.png" } } })).reason).toContain("bare file name");
    expect(screenScript(script({ command: "timeline.add", params: { feature: { type: "canvas", file: "photo.png" } } })).ok).toBe(true);
  });

  test("[B2] the envelope is shape-checked: commands is a list of { command, params } and nothing else", () => {
    for (const whole of [null, 7, "x", [], [L], { about: {} }, { commands: "x" }, { commands: {} }, { about: "x", commands: [] }, { commands: [], extra: 1 }, { commands: [], script: { commands: [] } }]) {
      const r = refused(whole);
      expect(r.index).toBe(-1);
      expect(r.command).toBe("");
    }
    for (const step of [null, "parameters.add", ["parameters.add", {}], {}, { command: 7, params: {} }, { command: "", params: {} }, { command: "parameters.add" }, { command: "parameters.add", params: null }, { command: "parameters.add", params: [] }, { command: "parameters.add", params: "x" }, { command: "parameters.add", params: {}, path: "x" }, { command: "parameters.add", params: {}, then: L }]) {
      const r = refused(script(L, step));
      expect(r.index).toBe(1);
      expect(r.reason).toContain("step 2");
    }
    // Nesting deep enough to be an attack is refused, not followed.
    let deep: unknown = "x";
    for (let i = 0; i < 400; i++) deep = { a: deep };
    expect(refused(script({ command: "timeline.add", params: { feature: deep } })).reason).toContain("nested too deeply");
  });

  test("[B2] screenScriptText applies the 64 MB cap and JSON parsing before the screen, and returns the parsed script", () => {
    expect(MAX_SCRIPT_BYTES).toBe(64 * 1024 * 1024);
    const good = screenScriptText(JSON.stringify(script(L, FILLET)));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.script.commands.map((c) => c.command)).toEqual(["parameters.add", "timeline.add"]);
    expect(screenScriptText("not json")).toMatchObject({ ok: false, index: -1, reason: expect.stringContaining("not JSON") });
    expect(screenScriptText("")).toMatchObject({ ok: false, index: -1 });
    expect(screenScriptText(JSON.stringify(script({ command: "file.save", params: {} })))).toMatchObject({ ok: false, index: 0, command: "file.save" });
    // One byte over the cap, valid JSON otherwise: refused for size, without being parsed.
    const pad = "x".repeat(MAX_SCRIPT_BYTES);
    const big = screenScriptText(`{"commands":[],"about":{"design":"${pad}"}}`);
    expect(big).toMatchObject({ ok: false, index: -1, reason: expect.stringContaining("larger than 64 MB") });
    // Multi-byte text is measured in bytes, not characters.
    const wide = screenScriptText(`{"commands":[],"about":{"design":"${"é".repeat(MAX_SCRIPT_BYTES / 2 + 8)}"}}`);
    expect(wide).toMatchObject({ ok: false, reason: expect.stringContaining("larger than 64 MB") });
  });
});
