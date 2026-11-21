/**
 * [A2] `cad/rules.json` (agent-cad-and-browser spec §4.6): hard checks (envelope, cnc drills, unknown
 * process) and advisory lines (minWall, minInsideRadius) that are shown and never block.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { RADIUS_NOT_MEASURED, WALL_NOT_MEASURED, checkRules, lineDiff, readRules, validateRules, type RulesFile } from "../../src/cadwork/rules";
import { RULES, cleanupTemp, tempRepo, writeRules } from "../helpers/cad-work";

afterEach(() => cleanupTemp());

const rules = RULES as RulesFile;
const PLATE = { bbox: [6, 50, 80] as [number, number, number], holes: [{ diameter: 3.4, count: 4 }] };
const byId = (checks: ReturnType<typeof checkRules>) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("cad rules", () => {
  test("[A2] the file is read with the sha256 of its exact bytes; a missing or malformed file is reported, not guessed", () => {
    const repo = tempRepo();
    expect(readRules(repo)).toEqual({ kind: "missing" });
    const path = writeRules(repo);
    const ok = readRules(repo);
    expect(ok.kind).toBe("ok");
    if (ok.kind !== "ok") throw new Error("unreachable");
    expect(ok.sha).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
    expect(ok.file.processes.map((p) => p.id)).toEqual(["fdm-0.4", "cnc-3axis"]);
    // One changed byte is a different hash (what the lock store compares).
    writeFileSync(path, readFileSync(path, "utf8") + " ");
    expect((readRules(repo) as any).sha).not.toBe(ok.sha);
    const bad: [unknown, string][] = [
      [{ schema: 2, processes: [] }, "schema 2"],
      [{ schema: 1 }, "`processes` must be a list"],
      [{ schema: 1, processes: [{ id: "x", kind: "laser", envelope: [1, 1, 1] }] }, 'kind must be "fdm" or "cnc"'],
      [{ schema: 1, processes: [{ id: "x", kind: "fdm", envelope: [1, 1] }] }, "envelope must be three positive numbers"],
      [{ schema: 1, processes: [{ id: "x", kind: "fdm", envelope: [1, 1, 0] }] }, "envelope"],
      [{ schema: 1, processes: [{ id: "x", kind: "cnc", envelope: [1, 1, 1], drills: ["3"] }] }, "drills"],
      [{ schema: 1, processes: [{ id: "x", kind: "cnc", envelope: [1, 1, 1], holeTolerance: -1 }] }, "holeTolerance"],
      [{ schema: 1, processes: [{ id: "x", kind: "fdm", envelope: [1, 1, 1] }, { id: "x", kind: "fdm", envelope: [1, 1, 1] }] }, "listed twice"],
      [{ schema: 1, processes: [{ kind: "fdm", envelope: [1, 1, 1] }] }, ".id"],
    ];
    for (const [doc, message] of bad) {
      const v = validateRules(doc);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toContain(message);
    }
    writeFileSync(path, "{ nope");
    const invalid = readRules(repo);
    expect(invalid.kind).toBe("invalid");
    if (invalid.kind === "invalid") {
      expect(invalid.error).toContain("not valid JSON");
      expect(invalid.sha).toMatch(/^[0-9a-f]{64}$/); // still hashed, so a change is still noticed
    }
  });

  test("[A2] hard: the sorted bounding box must fit the sorted envelope, whatever the part's orientation", () => {
    const fits = byId(checkRules(rules, "fdm-0.4", PLATE));
    expect(fits["rules.process"]).toMatchObject({ ok: true, hard: true });
    expect(fits["rules.envelope"]).toMatchObject({ ok: true, hard: true, expected: "fits 210 × 220 × 250 mm (fdm-0.4)", measured: "6 × 50 × 80 mm" });
    // A long thin part fits lying down even though its longest side exceeds the SHORTEST envelope side.
    expect(byId(checkRules(rules, "fdm-0.4", { bbox: [240, 5, 5], holes: [] }))["rules.envelope"]!.ok).toBe(true);
    const small: RulesFile = { schema: 1, processes: [{ id: "tiny", kind: "fdm", envelope: [60, 60, 60] }] };
    const tooBig = byId(checkRules(small, "tiny", PLATE))["rules.envelope"]!;
    expect(tooBig).toMatchObject({ ok: false, hard: true, expected: "fits 60 × 60 × 60 mm (tiny)", measured: "6 × 50 × 80 mm" });
    // Exactly the envelope fits; a hair over does not.
    expect(byId(checkRules(small, "tiny", { bbox: [60, 60, 60], holes: [] }))["rules.envelope"]!.ok).toBe(true);
    expect(byId(checkRules(small, "tiny", { bbox: [60, 60, 60.01], holes: [] }))["rules.envelope"]!.ok).toBe(false);
  });

  test("[A2] hard: for cnc every hole diameter must be within holeTolerance of a listed drill; fdm has no drill rule", () => {
    const ok = checkRules(rules, "cnc-3axis", PLATE);
    expect(byId(ok)["rules.drill ⌀3.4"]).toMatchObject({ ok: true, hard: true });
    const odd = checkRules(rules, "cnc-3axis", { bbox: [6, 50, 80], holes: [{ diameter: 3.4, count: 4 }, { diameter: 3.7, count: 1 }, { diameter: 5.04, count: 2 }] });
    expect(byId(odd)["rules.drill ⌀3.7"]).toMatchObject({ ok: false, hard: true });
    expect(String(byId(odd)["rules.drill ⌀3.7"]!.measured)).toContain("nearest drill 3.4");
    expect(byId(odd)["rules.drill ⌀5.04"]!.ok).toBe(true); // within 0.05 of the 5 mm drill
    const strict: RulesFile = { schema: 1, processes: [{ id: "c", kind: "cnc", envelope: [300, 200, 100], drills: [5], holeTolerance: 0.01 }] };
    expect(byId(checkRules(strict, "c", { bbox: [1, 1, 1], holes: [{ diameter: 5.04, count: 1 }] }))["rules.drill ⌀5.04"]!.ok).toBe(false);
    const dflt: RulesFile = { schema: 1, processes: [{ id: "c", kind: "cnc", envelope: [300, 200, 100], drills: [5] }] };
    expect(byId(checkRules(dflt, "c", { bbox: [1, 1, 1], holes: [{ diameter: 5.05, count: 1 }, { diameter: 5.06, count: 1 }] }))["rules.drill ⌀5.05"]!.ok).toBe(true); // default 0.05
    expect(byId(checkRules(dflt, "c", { bbox: [1, 1, 1], holes: [{ diameter: 5.06, count: 1 }] }))["rules.drill ⌀5.06"]!.ok).toBe(false);
    expect(checkRules(rules, "fdm-0.4", { bbox: [6, 50, 80], holes: [{ diameter: 3.7, count: 1 }] }).some((c) => c.id.startsWith("rules.drill"))).toBe(false);
  });

  test("[A2] advisory: minWall and minInsideRadius are shown, never block, and say plainly that they are not measured", () => {
    const withAdvice: RulesFile = { schema: 1, processes: [{ id: "cnc", kind: "cnc", envelope: [300, 200, 100], drills: [3.4], minWall: 1.2, minInsideRadius: 1.5 }] };
    const checks = checkRules(withAdvice, "cnc", PLATE);
    const wall = byId(checks)["rules.minWall"]!;
    const radius = byId(checks)["rules.minInsideRadius"]!;
    expect(wall).toEqual({ id: "rules.minWall", expected: "walls at least 1.2 mm", measured: WALL_NOT_MEASURED, ok: true, hard: false });
    expect(WALL_NOT_MEASURED).toContain("SolidCraft cannot measure wall thickness");
    expect(radius).toMatchObject({ hard: false, measured: RADIUS_NOT_MEASURED });
    // Nothing advisory can fail the part: every hard check still passes.
    expect(checks.filter((c) => c.hard && !c.ok)).toEqual([]);
    expect(checkRules(rules, "fdm-0.4", PLATE).filter((c) => !c.hard)).toEqual([]); // none set, none shown
  });

  test("[A2] a process that is not in the file fails with \"unknown process\"", () => {
    const checks = checkRules(rules, "sla-resin", PLATE);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: "rules.process", ok: false, hard: true });
    expect(String(checks[0]!.measured)).toBe('unknown process "sla-resin"');
    expect(String(checks[0]!.expected)).toContain("fdm-0.4, cnc-3axis");
  });

  test("[A2] the adopt card's diff marks added and removed lines", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([
      { op: " ", line: "a" },
      { op: "-", line: "b" },
      { op: "+", line: "B" },
      { op: " ", line: "c" },
      { op: "+", line: "d" },
    ]);
    expect(lineDiff("", "x\n")).toEqual([{ op: "+", line: "x" }]);
    expect(lineDiff("x\n", "x\n").every((d) => d.op === " ")).toBe(true);
  });
});
