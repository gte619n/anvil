/**
 * Unit tests for the design-script screen (src/solidcraft/script-screen.ts): the allow list of
 * command ids, the ban on anything that names a file or a place, the two import exceptions, and
 * the envelope. The module is shared with Track A (manager load, verify), so the cases here are
 * the contract.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWED_COMMANDS,
  FORBIDDEN_KEYS,
  MAX_DEPTH,
  MAX_INSPECTED_CHARS,
  MAX_KEY_CHARS,
  MAX_NODES,
  MAX_SCRIPT_BYTES,
  MAX_STRING_CHARS,
  NAME_KEYS,
  isBareFileName,
  isPlainName,
  screenScript,
  screenScriptText,
  unsafeString,
} from "../../src/solidcraft/script-screen";

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
      { command: "sheet.manage_rules", params: { name: "Thin steel", thickness: "1 mm", k_factor: "0.44", corner_relief_shape: "round", active: true } },
      { command: "plastic.manage_rules", params: { name: "My ABS", thickness: "2 mm", draft: "1 deg", material: "ABS" } },
      { command: "plastic.assign_rule", params: { bodies: ["Body1"], rule: "My ABS" } },
      // An assembly: a copied occurrence (its `path` is a list of occurrence ids), joints, a coupling.
      { command: "occurrence.copy", params: { occurrence: "A:1", path: [3, 7] } },
      { command: "joint.origin", params: { name: "O1", occurrence: "A:1", face: [10, 10, 10], x: [1, 0, 0] } },
      { command: "joint.create", params: { type: "revolute", name: "Hinge", a: { occurrence: "A:1", face: [10, 10, 10], frame: { origin: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] } }, b: { occurrence: "Bracket:1" }, angle: "10 deg", offset: 0, flip: false, values: [10] } },
      { command: "joint.limits", params: { joint: "Hinge", index: 0, min: -30, max: 30 } },
      { command: "joint.motion_link", params: { a: "Hinge", b: "Slide", ratio: 0.5 } },
      // A configuration table.
      { command: "config.column", params: { param: "L" } },
      { command: "config.row", params: { name: "Long", values: { "param:L": "120 mm", "suppress:Holes": true, "material:Body1": "Unobtainium", "appearance:Body1": "Aluminum - Satin" } } },
      { command: "config.activate", params: { row: "Long" } },
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
      // `timeline.export_script` DOES write this one for a linked design, and it stays refused: it opens a file.
      { command: "component.insert_design", params: { name: "LinkedPlate", path: "plate.sc" } },
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
      expect(r.reason).toContain("this command is not on Anvil's list of commands allowed in a design script (extend ALLOWED_COMMANDS in script-screen.ts if it is legitimate)");
    }
    // The first offender is the one reported.
    expect(refused(script(bad[0], bad[1])).index).toBe(0);
    // Without the path too: the id alone is enough.
    expect(refused(script({ command: "file.save", params: {} })).command).toBe("file.save");
  });

  test("[B2] a key that names a file or a place is refused at any depth and in any letter case, unless it holds only numbers", () => {
    expect(FORBIDDEN_KEYS.slice(0, 6)).toEqual(["path", "dir", "filename", "url", "out", "output"]);
    for (const key of ["path", "Path", "PATH", "dir", "DIR", "filename", "FileName", "url", "URL", "out", "Out", "output", "OUTPUT", " path ", "ｐａｔｈ", "uri", "href", "src", "folder", "directory", "cwd"]) {
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
      "~5 mm tolerance", // anything starting with `~`: SolidCraft expands it
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
      "%7e/x", // an encoded ~
      "%HOME%/x.ttf", // environment references, in every spelling
      "x/%USERPROFILE%/y",
      "%_private_1%",
      "$HOME/x.ttf",
      "a/$HOME",
      "${HOME}/x",
      "$(pwd)/x",
      "%24HOME/x", // an encoded $
      "%25HOME%25/x", // an encoded %…%
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
    for (const v of ["L/2 - inset", "W/2 - inset", "1.5 / 3", "80 mm", "F2:side:l2|F2:side:l3", "ref-cube:1", "0.44.1", "a..b", "...", "Aluminum - Satin", "50%", "100% recycled", "10 % 3", "50% to 60%", "%5%", "$5", "5 $", "cost: 5$", "sub/part", "x: y", "note: see drawing", "é", "Ø 3.4"]) {
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
    expect(refused(script({ command: "timeline.add", params: { feature: deep } })).reason).toContain(`nested more than ${MAX_DEPTH} deep`);
  });

  test("[B2] screenScriptText applies the 64 MB cap and JSON parsing before the screen, and returns the parsed script", () => {
    expect(MAX_SCRIPT_BYTES).toBe(64 * 1024 * 1024);
    const good = screenScriptText(JSON.stringify(script(L, FILLET)));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.script.commands.map((c) => c.command)).toEqual(["parameters.add", "timeline.add"]);
    expect(screenScriptText("not json")).toEqual({ ok: false, index: -1, command: "", reason: "the design script is not valid JSON" });
    // A parse failure never quotes the file: what failed to parse may be something else entirely.
    const secret = "root:x:0:0:hunter2-the-secret:/var/root:/bin/sh";
    for (const text of [secret, `{"commands": [${secret}]}`, `{"commands": "${secret}`]) {
      const r = screenScriptText(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("the design script is not valid JSON");
    }
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

  test("[B2] a name key such as font may hold only a plain name, so a script cannot make SolidCraft open a file", () => {
    expect(NAME_KEYS).toEqual(["font", "image", "texture", "template", "source", "icon", "plugin", "script", "module", "include", "shader"]);
    // The shape a real export gives a sketch text (links[].source.font).
    const text = (font: unknown, extra: Record<string, unknown> = {}) =>
      script(L, { command: "timeline.add", params: { feature: { id: 7, name: "Marks", type: "sketch", sketch: { links: [{ id: "j1", kind: "text", source: { angle: 0, at: [0, 0], font, height: 5, text: "ANVIL", type: "text", ...extra } }] } } } });
    for (const font of ["%HOME%/x.ttf", "~/x.ttf", "fonts/x.ttf", "$HOME/x.ttf", "/Library/Fonts/Arial.ttf", "..\\x.ttf", "C:\\Windows\\Fonts\\arial.ttf", "x.ttf;rm", "a|b", "font:Helvetica", "Helvetica*", "", " Helvetica", "x".repeat(256), "%2e%2e%2fx.ttf", "é.ttf"]) {
      const r = refused(text(font));
      expect(r.index).toBe(1);
      expect(r.command).toBe("timeline.add");
    }
    for (const font of ["Helvetica", "Inter-Bold.ttf", "Noto Sans Mono", "DIN_1451.otf", "Arial 2"]) expect(screenScript(text(font))).toEqual({ ok: true });
    expect(isPlainName("Inter-Bold.ttf")).toBe(true);
    expect(isPlainName("fonts/x.ttf")).toBe(false);
    expect(isPlainName("..")).toBe(false);
    // Every name key, at any depth, in any letter case, and inside arrays.
    for (const key of [...NAME_KEYS, "Font", "IMAGE", "ｆｏｎｔ"]) {
      for (const params of [{ feature: { [key]: "a/b.png" } }, { feature: { deep: [{ [key]: ["ok.png", "sub/x.png"] }] } }, { [key]: "%TEMP%" }]) expect(refused(script({ command: "timeline.add", params })).index).toBe(0);
      expect(screenScript(script({ command: "timeline.add", params: { feature: { [key]: "plain-name_1.png", list: [{ [key]: ["a.png", "b.png"] }] } } })).ok).toBe(true);
    }
    // A name key holding an object is walked like any other: `source: { font }`, `profile.source: "library"`.
    expect(screenScript(script({ command: "timeline.add", params: { feature: { type: "frame_member", profile: { source: "library", kind: "bar" } } } })).ok).toBe(true);
    // The text of a sketch label is free text, but still no path, URL or environment reference.
    expect(screenScript(text("Helvetica", { text: "REV-B, 100% tested: OK" })).ok).toBe(true);
    expect(refused(text("Helvetica", { text: "%HOME%" })).reason).toContain("environment reference");
  });

  test("[B2] a mesh import's vertex and triangle arrays are embedded data: any size, numbers only", () => {
    const mesh = (positions: unknown, triangles: unknown = [0, 1, 2], extra: Record<string, unknown> = {}) =>
      script({ command: "timeline.add", params: { feature: { type: "mesh_import", file: "cube.stl", id: 3, name: "cube", meshes: [{ name: "cube", color: null, positions, triangles, ...extra }] } } });
    // Far more values than the node cap allows elsewhere.
    const many = Array.from({ length: MAX_NODES * 3 }, (_, i) => i * 0.5);
    expect(screenScript(mesh(many, many))).toEqual({ ok: true });
    expect(screenScript(mesh([[0, 0, 0], [1, 0, 0], [0, 1, 0]]))).toEqual({ ok: true }); // nested triples too
    // A string hidden among the numbers is not data.
    for (const bad of [[0, 1, "/etc/passwd"], [[0, 1, 2], [3, "x", 5]], [0, { path: "x" }], [[[0]]], [0, null], [0, true]]) {
      const r = screenScript(mesh(bad));
      expect(r.ok).toBe(false);
    }
    expect(refused(mesh([0, 1, "2"])).reason).toContain("must hold numbers only");
    // The exemption is for exactly those two fields of a mesh import's meshes.
    expect(refused(mesh([0, 1, 2], [0, 1, 2], { normals: many })).reason).toContain(`more than ${MAX_NODES} values`);
    expect(refused(script({ command: "timeline.add", params: { feature: { type: "extrude", meshes: [{ positions: many }] } } })).reason).toContain(`more than ${MAX_NODES} values`);
    expect(refused(mesh([0, 1, 2], [0, 1, 2], { file: "a/b.stl" })).reason).toContain("bare file name");
  });

  test("[B2] the script is bounded: string length, key length, text in total, values and nesting", () => {
    expect([MAX_STRING_CHARS, MAX_INSPECTED_CHARS, MAX_NODES, MAX_DEPTH, MAX_KEY_CHARS]).toEqual([1024 * 1024, 8 * 1024 * 1024, 200_000, 64, 256]);
    const param = (params: Record<string, unknown>) => script({ command: "parameters.add", params });
    // One string: exactly 1 MB passes, one character more is refused.
    expect(screenScript(param({ comment: "a".repeat(MAX_STRING_CHARS) })).ok).toBe(true);
    expect(refused(param({ comment: "a".repeat(MAX_STRING_CHARS + 1) })).reason).toContain("is longer than 1 MB");
    // …except the embedded STEP text of an import, which may be as long as the file allows.
    expect(screenScript(script({ command: "timeline.add", params: { feature: { type: "import", file: "a.step", step: "x".repeat(MAX_STRING_CHARS * 3) } } })).ok).toBe(true);
    // A key.
    expect(screenScript(param({ ["k".repeat(MAX_KEY_CHARS)]: 1 })).ok).toBe(true);
    expect(refused(param({ ["k".repeat(MAX_KEY_CHARS + 1)]: 1 })).reason).toContain("is longer than 256 characters");
    // All inspected text together: eight 1 MB strings is over (their keys count too); seven is not.
    const mb = "a".repeat(MAX_STRING_CHARS);
    expect(screenScript(script(...Array.from({ length: 7 }, () => ({ command: "parameters.add", params: { comment: mb } })))).ok).toBe(true);
    const over = refused(script(...Array.from({ length: 9 }, () => ({ command: "parameters.add", params: { comment: mb } }))));
    expect(over.reason).toContain("text outside embedded data is larger than 8 MB");
    expect(over.index).toBe(7); // the eighth megabyte, with the keys, is over
    // Values.
    expect(screenScript(script({ command: "timeline.add", params: { feature: { a: Array.from({ length: MAX_NODES - 10 }, (_, i) => i) } } })).ok).toBe(true);
    expect(refused(script({ command: "timeline.add", params: { feature: { a: Array.from({ length: MAX_NODES + 1 }, (_, i) => i) } } })).reason).toContain("more than 200000 values");
    expect(refused(script(...Array.from({ length: MAX_NODES + 1 }, () => L))).reason).toContain("more than 200000 values"); // too many steps
    // The cap is on the whole script, not per step.
    const half = { command: "timeline.add", params: { feature: { a: Array.from({ length: MAX_NODES / 2 }, (_, i) => i) } } };
    expect(refused(script(half, half, half)).index).toBe(1);
    // Nesting: 64 levels below params passes, one more does not; arrays count too.
    const nest = (levels: number, leaf: unknown = 1): unknown => {
      let v = leaf;
      for (let i = 0; i < levels; i++) v = (levels - 1 - i) % 2 ? [v] : { a: v }; // the outermost is an object
      return v;
    };
    expect(screenScript(script({ command: "timeline.add", params: nest(MAX_DEPTH) as Record<string, unknown> })).ok).toBe(true);
    expect(refused(script({ command: "timeline.add", params: nest(MAX_DEPTH + 2) as Record<string, unknown> })).reason).toContain("nested more than 64 deep");
  });

  test("[B2] a refusal is short whatever the script holds: fragments are cut to 80 characters and the reason to 300", () => {
    const long = "A".repeat(1_000_000);
    const cases: unknown[] = [
      script({ command: long, params: {} }), // a huge command id
      script({ command: "timeline.add", params: { [long]: "x" } }), // a huge key
      script({ command: "timeline.add", params: { feature: { ["k".repeat(200)]: { ["j".repeat(200)]: { path: "x" } } } } }), // a long key path
      script({ command: "timeline.add", params: { name: `/${long}` } }), // a huge value
      script({ command: "timeline.add", params: { font: `${long}/x` } }),
      script({ command: "timeline.add", params: {}, [long]: 1 }), // a huge key beside command and params
      { commands: [], [long]: 1 }, // a huge top-level key
      script({ command: "timeline.add", params: { feature: { type: "import", file: `${"f".repeat(300)}/x`, step: "ok" } } }),
    ];
    for (const c of cases) {
      const r = refused(c);
      expect(r.reason.length).toBeLessThanOrEqual(300);
      expect(r.command.length).toBeLessThanOrEqual(80);
      expect(r.reason.includes("A".repeat(81))).toBe(false); // no fragment longer than 80
    }
    expect(refused(cases[0]).command).toBe(`${"A".repeat(79)}…`);
    // Through the text entry point too.
    const viaText = screenScriptText(JSON.stringify(cases[1]));
    expect(viaText.ok).toBe(false);
    if (!viaText.ok) expect(viaText.reason.length).toBeLessThanOrEqual(300);
  });

  test("[B2] worst-case strings at the caps screen quickly: 1 MB of letters, of %41, of a:, of /.., and a 64 MB embedded STEP", () => {
    const MB = MAX_STRING_CHARS;
    const fill = (unit: string, n: number): string => unit.repeat(Math.floor(n / unit.length));
    const timed = (f: () => unknown): number => {
      const t = performance.now();
      f();
      return performance.now() - t;
    };
    const screenOne = (value: string) => screenScript(script({ command: "parameters.add", params: { name: "L", comment: value } }));
    // The reviewer measured 16.7 s for 160 k letters with the old unanchored regular expression.
    // Each of these is now a few milliseconds; the bound leaves room for a loaded CI machine.
    const LIMIT_MS = 2_000;
    const shapes: [string, string][] = [
      ["letters", "a"],
      ["%41 repeated", "%41"],
      ["a: repeated", "a:"],
      ["/.. repeated", "/.."],
      ["x/.. repeated (not absolute)", "x/..x"],
      ["-:// repeated", "-://"],
      ["$1 repeated", "$1"],
      ["% then 70 letters, repeated", `%${"a".repeat(70)}`],
      ["dots and spaces", ". "],
      ["non-ASCII", "é"],
      ["%25 nested encoding", "%2525"],
      ["backslashes", "a\\"],
    ];
    for (const [name, unit] of shapes) {
      const value = fill(unit, MB);
      const ms = Math.min(timed(() => screenOne(value)), timed(() => screenOne(value)));
      expect(`${name}: ${ms < LIMIT_MS ? "fast" : `${Math.round(ms)} ms`}`).toBe(`${name}: fast`);
    }
    // As keys and as name-key values too.
    expect(timed(() => screenScript(script({ command: "timeline.add", params: { feature: { font: fill("a", MB) } } })))).toBeLessThan(LIMIT_MS);
    // A script at the file cap whose bulk is embedded STEP text: parse and screen together.
    const big = JSON.stringify(script({ command: "timeline.add", params: { feature: { type: "import", file: "a.step", step: "x".repeat(MAX_SCRIPT_BYTES - 1024) } } }));
    expect(big.length).toBeGreaterThan(MAX_SCRIPT_BYTES - 1024);
    expect(big.length).toBeLessThanOrEqual(MAX_SCRIPT_BYTES);
    let ok = false;
    const whole = timed(() => (ok = screenScriptText(big).ok));
    expect(ok).toBe(true);
    expect(whole).toBeLessThan(LIMIT_MS);
    // The worst a script can ask for in total: the inspected-text cap, filled with the costliest shape.
    const nasty = script(...Array.from({ length: 7 }, () => ({ command: "parameters.add", params: { comment: fill("%41", MB) } })));
    expect(timed(() => screenScript(nasty))).toBeLessThan(LIMIT_MS);
    // And the node cap, filled with strings.
    const wide = script({ command: "timeline.add", params: { feature: { a: Array.from({ length: MAX_NODES - 10 }, (_, i) => `v${i}:x/y.z`) } } });
    expect(timed(() => screenScript(wide))).toBeLessThan(LIMIT_MS);
  }, 60_000);

  test("[B2] screening time grows no faster than the input: doubling the size at most about doubles the time", () => {
    const fill = (unit: string, n: number): string => unit.repeat(Math.floor(n / unit.length));
    const best = (value: string): number => {
      const s = script({ command: "parameters.add", params: { name: "L", comment: value } });
      let ms = Infinity;
      for (let i = 0; i < 7; i++) {
        const t = performance.now();
        screenScript(s);
        ms = Math.min(ms, performance.now() - t);
      }
      return ms;
    };
    const sizes = [MAX_STRING_CHARS / 4, MAX_STRING_CHARS / 2, MAX_STRING_CHARS];
    for (const unit of ["%41", "x/..x", "-://", "$1", "é.", `%${"a".repeat(70)}`, "a"]) {
      const t = sizes.map((n) => best(fill(unit, n)));
      // Linear work quadruples from the first size to the last; quadratic work would be 16 times.
      // The floor keeps sub-millisecond noise from deciding the ratio.
      const ratio = Math.max(t[2]!, 0.5) / Math.max(t[0]!, 0.5);
      expect(`${JSON.stringify(unit.slice(0, 8))}: ${ratio < 8 ? "linear" : `x${ratio.toFixed(1)} for 4x the input (${t.map((x) => x.toFixed(1)).join(", ")} ms)`}`).toBe(`${JSON.stringify(unit.slice(0, 8))}: linear`);
      for (let i = 1; i < t.length; i++) expect(Math.max(t[i]!, 0.5) / Math.max(t[i - 1]!, 0.5)).toBeLessThan(3.5); // each doubling: about 2
    }
  }, 60_000);

  test("[B2] the allow list is exactly what the real export was seen to write, minus the one id that opens a file", () => {
    // The evidence: test/fixtures/solidcraft-export-ids/export-ids.json, written by generate.ts
    // beside it from the real binary.
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "solidcraft-export-ids", "export-ids.json"), "utf8")) as {
      solidcraft: string;
      commandIds: string[];
      schemas: Record<string, { params: string; properties: string[] }>;
      ids: Record<string, { keys: string[]; scenarios: string[] }>;
      featureTypes: Record<string, string[]>;
    };
    expect(fixture.solidcraft).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fixture.commandIds.filter((id) => id !== "component.insert_design").sort()).toEqual([...ALLOWED_COMMANDS].sort());
    // The excluded one really is the one with a file parameter…
    expect(fixture.schemas["component.insert_design"]!.properties).toContain("path");
    expect(ALLOWED_COMMANDS).not.toContain("component.insert_design");
    // …and no allowed id's own schema has a parameter that names a file, a URL or code. (`path`
    // and `parent_path` on occurrence commands are lists of occurrence ids; as strings the
    // forbidden-key rule refuses them anyway.)
    const fileish = /(^|_)(file|filename|url|uri|href|dir|folder|out|output|script|code|command|plugin|exec)(_|$)/;
    for (const id of ALLOWED_COMMANDS) {
      const schema = fixture.schemas[id]!;
      expect(schema).toBeDefined();
      expect(schema.properties.filter((p) => fileish.test(p))).toEqual([]);
      const paths = schema.properties.filter((p) => p === "path" || p.endsWith("_path"));
      if (paths.length) expect(["occurrence.copy", "occurrence.ground", "occurrence.move", "joint.origin", "component.create"]).toContain(id);
    }
    // Every key a real export was seen to carry under an allowed id passes the key rules when it
    // holds what real exports hold there (numbers, or plain text).
    for (const id of ALLOWED_COMMANDS) {
      for (const keyPath of fixture.ids[id]!.keys) {
        const leaf = keyPath.split(".").pop()!.replace(/\[\]$/, "").toLowerCase();
        if (FORBIDDEN_KEYS.includes(leaf)) expect(["dir", "path"]).toContain(leaf); // vectors and occurrence paths: numbers
      }
    }
    expect(Object.keys(fixture.featureTypes)).toEqual(expect.arrayContaining(["import", "mesh_import", "sketch", "extrude"]));
    expect(fixture.featureTypes.sketch).toContain("feature.sketch.links[].source.font");
    expect(fixture.featureTypes.mesh_import).toEqual(expect.arrayContaining(["feature.meshes[].positions", "feature.meshes[].triangles", "feature.file"]));
  });
});
