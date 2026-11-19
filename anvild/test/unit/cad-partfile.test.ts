/**
 * [A2] `part.json` (agent-cad-and-browser spec §4.1): schema 1, read / write / validate; `measured`
 * is the daemon's; a corrupt file or a wrong schema is reported and never overwritten.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TOLERANCE,
  TOLERANCE_CAPS,
  evaluateExpectations,
  expectationsShapeError,
  lockedBlockSha,
  partFileText,
  readPartFile,
  stampExpectations,
  toleranceCapErrors,
  validatePartFile,
  writeMeasured,
  writePartFile,
  type Measured,
  type PartFile,
} from "../../src/cadwork/partfile";
import { cleanupTemp, tempDir } from "../helpers/cad-work";

afterEach(() => cleanupTemp());

const EXP = stampExpectations({ bbox: ["L", "W", "T"], volume: "L*W*T", bodies: 1, holes: [{ diameter: 3.4, count: 4 }] }, "agent-initial", "2026-11-19T10:00:00.000Z");
const FILE: PartFile = { schema: 1, process: "fdm-0.4", status: "dimensioned", expectations: EXP };
const MEASURED: Measured = { at: "2026-11-19T10:00:01.000Z", solidcraft: "0.44.1", scriptSha: "abc", bbox: [6, 50, 80], volume: 24000, faces: 6, bodies: 1, holes: [], warnings: [] };
const partDir = () => {
  const dir = join(tempDir(), "cad", "plate");
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("cad partfile", () => {
  test("[A2] a part.json round-trips: stable key order, defaults filled, schema 1", () => {
    const dir = partDir();
    expect(readPartFile(dir)).toEqual({ kind: "missing" });
    writePartFile(dir, FILE);
    const text = readFileSync(join(dir, "part.json"), "utf8");
    expect(text).toBe(partFileText(FILE));
    expect(Object.keys(JSON.parse(text))).toEqual(["schema", "process", "status", "expectations"]);
    expect(text.endsWith("}\n")).toBe(true);
    const back = readPartFile(dir);
    expect(back.kind).toBe("ok");
    if (back.kind !== "ok") throw new Error("unreachable");
    expect(back.file).toEqual(FILE);
    expect(back.file.expectations!.tolerance).toEqual({ ...DEFAULT_TOLERANCE });
    expect(DEFAULT_TOLERANCE).toEqual({ length: 0.01, volumeRel: 0.001 });
    expect(TOLERANCE_CAPS).toEqual({ length: 0.1, volumeRel: 0.01 });
    // The temp file used for the atomic write is gone, and it lived in the git-excluded .cache.
    expect(existsSync(join(dir, ".cache"))).toBe(true);
    expect(Bun.spawnSync(["ls", join(dir, ".cache")]).stdout.toString().trim()).toBe("");
  });

  test("[A2] a corrupt part.json or a wrong schema is reported with the parse error and is never overwritten", () => {
    const dir = partDir();
    const cases: [string, string][] = [
      ["{ not json", "not valid JSON"],
      [JSON.stringify({ ...FILE, schema: 2 }), "schema 2"],
      [JSON.stringify({ process: "fdm", status: "dimensioned" }), "schema undefined"],
      [JSON.stringify({ ...FILE, status: "done" }), "`status`"],
      [JSON.stringify({ ...FILE, process: "" }), "`process`"],
      [JSON.stringify({ ...FILE, expectations: { ...EXP, bbox: [1, 2] } }), "`expectations.bbox`"],
      [JSON.stringify({ ...FILE, expectations: { ...EXP, lockedBy: "me" } }), "`expectations.lockedBy`"],
      [JSON.stringify({ ...FILE, expectations: { ...EXP, holes: [{ diameter: 3, count: 0 }] } }), "holes[0].count"],
      [JSON.stringify({ ...FILE, expectations: { ...EXP, tolerance: { length: -1, volumeRel: 0.001 } } }), "tolerance.length"],
      [JSON.stringify({ ...FILE, ownerParams: { L: "80" } }), "`ownerParams`"],
      [JSON.stringify([1, 2]), "must be a JSON object"],
    ];
    for (const [text, message] of cases) {
      writeFileSync(join(dir, "part.json"), text);
      const r = readPartFile(dir);
      expect(r.kind).toBe("invalid");
      if (r.kind !== "invalid") throw new Error("unreachable");
      expect(r.error).toContain(message);
      // The daemon's measurement is NOT written over a file it cannot read.
      expect(writeMeasured(dir, MEASURED)).toBe(false);
      expect(readFileSync(join(dir, "part.json"), "utf8")).toBe(text);
    }
    // A tolerance above the cap is NOT a schema error: the file parses, and the gate fails on the cap.
    expect(validatePartFile({ ...FILE, expectations: { ...EXP, tolerance: { length: 1, volumeRel: 0.5 } } }).ok).toBe(true);
  });

  test("[A2] measured is written by the daemon only when there is a valid part.json, and not rewritten when unchanged", () => {
    const dir = partDir();
    expect(writeMeasured(dir, MEASURED)).toBe(false); // no part.json: nothing is invented
    expect(existsSync(join(dir, "part.json"))).toBe(false);
    writePartFile(dir, FILE);
    expect(writeMeasured(dir, MEASURED)).toBe(true);
    const first = readFileSync(join(dir, "part.json"), "utf8");
    expect(JSON.parse(first).measured).toEqual(MEASURED);
    expect(JSON.parse(first).expectations).toEqual(EXP); // nothing else is disturbed
    // The same measurement at a later time does not churn the committed file.
    expect(writeMeasured(dir, { ...MEASURED, at: "2026-11-19T11:00:00.000Z" })).toBe(false);
    expect(readFileSync(join(dir, "part.json"), "utf8")).toBe(first);
    expect(writeMeasured(dir, { ...MEASURED, volume: 23000 })).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "part.json"), "utf8")).measured.volume).toBe(23000);
  });

  test("[A2] the locked hash covers the expectations, the process and the status, and not the measurement", () => {
    const sha = lockedBlockSha(FILE);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(lockedBlockSha({ ...FILE, measured: MEASURED, material: "PLA" } as PartFile)).toBe(sha);
    // Key order in the file does not matter…
    expect(lockedBlockSha(JSON.parse(JSON.stringify({ expectations: { ...EXP }, status: "dimensioned", process: "fdm-0.4" })))).toBe(sha);
    // …but every approved value does, including who the file claims locked it.
    expect(lockedBlockSha({ ...FILE, expectations: { ...EXP, lockedBy: "owner" } })).not.toBe(sha);
    expect(lockedBlockSha({ ...FILE, expectations: { ...EXP, volume: "L*W*T*2" } })).not.toBe(sha);
    expect(lockedBlockSha({ ...FILE, expectations: { ...EXP, tolerance: { length: 1, volumeRel: 0.001 } } })).not.toBe(sha);
    expect(lockedBlockSha({ ...FILE, process: "cnc-3axis" })).not.toBe(sha);
    expect(lockedBlockSha({ ...FILE, status: "concept" })).not.toBe(sha);
    expect(lockedBlockSha({ ...FILE, expectations: undefined })).not.toBe(sha);
  });

  test("[A2] expectations evaluate to sorted numbers, and shape and tolerance problems are named", () => {
    expect(evaluateExpectations(EXP, { L: 80, W: 50, T: 6 })).toEqual({ bbox: [6, 50, 80], volume: 24000, bodies: 1, holes: [{ diameter: 3.4, count: 4 }] });
    expect(() => evaluateExpectations(EXP, { L: 80 })).toThrow("bbox[1]: unknown parameter `W`");
    const blind = stampExpectations({ bbox: [1, 2, 3], volume: 6, bodies: 1, holes: [{ diameter: "d", count: 2, kind: "blind" }], tolerance: { length: 0.05 }, noInterferenceWith: ["motor.step"] }, "owner", "t");
    expect(blind.tolerance).toEqual({ length: 0.05, volumeRel: 0.001 });
    expect(blind.noInterferenceWith).toEqual(["motor.step"]);
    expect(evaluateExpectations(blind, { d: 5 }).holes).toEqual([{ diameter: 5, count: 2, kind: "blind" }]);
    expect(expectationsShapeError({ bbox: [1, 2, 3], volume: 6, bodies: 1, holes: [] }, { stamped: false })).toBeUndefined();
    expect(expectationsShapeError({ bbox: [1, 2, 3], volume: 6, bodies: 1 }, { stamped: false })).toContain("holes");
    expect(expectationsShapeError({ bbox: [1, 2, 3], volume: 6, bodies: 1.5, holes: [] }, { stamped: false })).toContain("bodies");
    expect(expectationsShapeError({ bbox: [1, 2, 3], volume: "", bodies: 1, holes: [] }, { stamped: false })).toContain("volume");
    expect(expectationsShapeError({ bbox: [1, 2, 3], volume: 6, bodies: 1, holes: [{ diameter: 3, count: 1, kind: "countersunk" }] }, { stamped: false })).toContain("kind");
    expect(expectationsShapeError("x", { stamped: false })).toContain("must be an object");
    expect(toleranceCapErrors({ length: 0.1, volumeRel: 0.01 })).toEqual([]);
    expect(toleranceCapErrors({ length: 0.11, volumeRel: 0.011 })).toHaveLength(2);
    expect(toleranceCapErrors({ length: 1, volumeRel: 0.001 })[0]).toContain("looser than the cap of 0.1 mm");
  });
});
