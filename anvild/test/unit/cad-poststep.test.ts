/**
 * [A1] Post-step 1, the script write (agent-cad-and-browser spec §4.3, §4.14 #8): design.json is
 * written by the daemon from the `timeline.export_script` reply — atomically, with sorted keys and a
 * stable `about` block — and never over a file that changed on disk.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseToolResult } from "../../src/cadwork/mcp-client";
import { DISK_CONFLICT_REASON, designFileText, fileSha, formatNumber, readDesignFile, scriptSha, sortKeys, writeScript } from "../../src/cadwork/poststep";
import { cleanupTemp, tempDir } from "../helpers/cad-work";

afterEach(cleanupTemp);

const SCRIPT = {
  about: { version: "0.44.1", replay: "solidcraft-cli eval script.json", format: "solidcraft/58", design: "Untitled" },
  commands: [
    { params: { unit: "mm", name: "L", expression: "80 mm" }, command: "parameters.add" },
    { command: "solid.box", params: { width: 10, length: "L", height: 5 } },
  ],
};
/** A `call` that answers `timeline.export_script` the way the real server does. */
const exporter = (script: unknown = SCRIPT, seen: unknown[] = []) => async (tool: string, args: Record<string, unknown>) => {
  seen.push([tool, args]);
  return parseToolResult({ content: [{ type: "text", text: JSON.stringify({ omitted: [], path: null, script, steps: 2 }) }] });
};
const partDir = () => {
  const dir = join(tempDir(), "cad", "plate");
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("cad poststep", () => {
  test("[A1] scriptSha hashes the canonical commands only: about and key order do not matter", () => {
    const reordered = [
      { command: "parameters.add", params: { expression: "80 mm", name: "L", unit: "mm" } },
      { params: { height: 5, length: "L", width: 10 }, command: "solid.box" },
    ];
    expect(scriptSha(SCRIPT.commands)).toBe(scriptSha(reordered));
    expect(scriptSha(SCRIPT.commands)).toMatch(/^[0-9a-f]{64}$/);
    // A different command, or a different ORDER of commands, is a different design.
    expect(scriptSha([...reordered].reverse())).not.toBe(scriptSha(reordered));
    expect(scriptSha([{ ...reordered[0] }, { command: "solid.box", params: { height: 6, length: "L", width: 10 } }])).not.toBe(scriptSha(reordered));
    expect(sortKeys({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } })).toEqual({ a: { c: 3, d: [{ y: 2, z: 1 }] }, b: 1 });
    expect(Object.keys(sortKeys({ b: 1, a: 2 }))).toEqual(["a", "b"]);
  });

  test("[A1] design.json has sorted keys and a stable about block named after the part", () => {
    const text = designFileText("plate", SCRIPT);
    expect(text.endsWith("}\n")).toBe(true);
    const doc = JSON.parse(text);
    expect(doc.about.design).toBe("plate"); // never SolidCraft's "Untitled"
    expect(Object.keys(doc)).toEqual(["about", "commands"]);
    expect(Object.keys(doc.about)).toEqual(["design", "format", "replay", "version"]);
    expect(Object.keys(doc.commands[0])).toEqual(["command", "params"]);
    expect(Object.keys(doc.commands[0].params)).toEqual(["expression", "name", "unit"]);
    // A new SolidCraft release changes about.version, and the file, but not the script's identity.
    const newer = designFileText("plate", { ...SCRIPT, about: { ...SCRIPT.about, version: "0.45.0" } });
    expect(newer).not.toBe(text);
    expect(scriptSha(JSON.parse(newer).commands)).toBe(scriptSha(doc.commands));
    expect(formatNumber(doc)).toBe(58);
    expect(formatNumber({ about: {} })).toBeUndefined();
  });

  test("[A1] the script is exported with no path and written by the daemon", async () => {
    const dir = partDir();
    const seen: unknown[] = [];
    const out = await writeScript({ call: exporter(SCRIPT, seen), partDir: dir, part: "plate", expectedDiskSha: null });
    expect(seen).toEqual([["execute", { command: "timeline.export_script", params: {} }]]); // no `path`: SolidCraft writes nothing
    expect(out).toMatchObject({ kind: "written", changed: true, steps: 2, scriptSha: scriptSha(SCRIPT.commands) });
    const text = readFileSync(join(dir, "design.json"), "utf8");
    expect(text).toBe(designFileText("plate", SCRIPT));
    expect(out.kind === "written" && out.diskSha).toBe(fileSha(join(dir, "design.json"))!);
    expect(readDesignFile(dir).scriptSha).toBe(scriptSha(SCRIPT.commands));
    // No temp file is left beside design.json.
    expect(readdirSync(dir).sort()).toEqual([".cache", "design.json"]);
    expect(readdirSync(join(dir, ".cache"))).toEqual([]);
  });

  test("[A1] a crash during the script write leaves the old script intact (temp file + rename)", async () => {
    const dir = partDir();
    const target = join(dir, "design.json");
    writeFileSync(target, "OLD SCRIPT\n");
    const writes: string[] = [];
    const crash = writeScript({
      call: exporter(),
      partDir: dir,
      part: "plate",
      expectedDiskSha: fileSha(target),
      fs: {
        writeFile: (p, t) => {
          writes.push(p);
          writeFileSync(p, t.slice(0, 20)); // a torn write
        },
        rename: () => {
          throw new Error("ENOSPC: simulated crash before rename");
        },
      },
    });
    await expect(crash).rejects.toThrow("simulated crash before rename");
    expect(readFileSync(target, "utf8")).toBe("OLD SCRIPT\n"); // never half-written
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toBe(target); // the bytes went to a temp file, not to design.json
    expect(existsSync(writes[0]!)).toBe(false); // and the temp file was cleaned up
  });

  test("[A1] a design.json that changed on disk is never overwritten: the result goes to .cache/design.conflict.json", async () => {
    const dir = partDir();
    const target = join(dir, "design.json");
    writeFileSync(target, "STARTED FROM THIS\n");
    const expected = fileSha(target);
    const out = await writeScript({
      call: exporter(),
      partDir: dir,
      part: "plate",
      expectedDiskSha: expected,
      beforeRename: () => writeFileSync(target, "SOMEONE EDITED IT\n"), // changes while the request runs
    });
    expect(out.kind).toBe("conflict");
    expect(out.kind === "conflict" && out.reason).toBe(DISK_CONFLICT_REASON);
    expect(DISK_CONFLICT_REASON).toBe("design changed on disk during a change");
    expect(readFileSync(target, "utf8")).toBe("SOMEONE EDITED IT\n");
    expect(readFileSync(join(dir, ".cache", "design.conflict.json"), "utf8")).toBe(designFileText("plate", SCRIPT));
    // A file that APPEARED where none was expected is a conflict too.
    const dir2 = partDir();
    const out2 = await writeScript({ call: exporter(), partDir: dir2, part: "plate", expectedDiskSha: null, beforeRename: () => writeFileSync(join(dir2, "design.json"), "new\n") });
    expect(out2.kind).toBe("conflict");
    expect(readFileSync(join(dir2, "design.json"), "utf8")).toBe("new\n");
  });

  test("[A1] an identical script is not rewritten", async () => {
    const dir = partDir();
    const first = await writeScript({ call: exporter(), partDir: dir, part: "plate", expectedDiskSha: null });
    if (first.kind !== "written") throw new Error("expected a write");
    let renames = 0;
    const again = await writeScript({ call: exporter(), partDir: dir, part: "plate", expectedDiskSha: first.diskSha, fs: { writeFile: () => {}, rename: () => void renames++ } });
    expect(again).toMatchObject({ kind: "written", changed: false, diskSha: first.diskSha });
    expect(renames).toBe(0);
  });

  test("[A1] a failed export throws and leaves design.json untouched", async () => {
    const dir = partDir();
    writeFileSync(join(dir, "design.json"), "KEEP\n");
    const failing = async () => parseToolResult({ isError: true, content: [{ type: "text", text: "unknown command `timeline.export_script`" }] });
    await expect(writeScript({ call: failing, partDir: dir, part: "plate", expectedDiskSha: fileSha(join(dir, "design.json")) })).rejects.toThrow("could not export the design script");
    expect(readFileSync(join(dir, "design.json"), "utf8")).toBe("KEEP\n");
    expect(readDesignFile(dir).parseError).toBeDefined();
    expect(readDesignFile(join(dir, "nope")).sha).toBeNull();
  });
});
