/**
 * [A4] Concept parts (D16) and the dimensions card (§4.5): a concept is only ever a BRAND-NEW part,
 * honoured only while the lock store agrees; the agent's proposed dimensions are checked; the owner's
 * answer must be a finite number for exactly the card's names; nobody is asked when unattended.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { partRef } from "../../src/cadwork/partfolder";
import { CAD_DIMENSION_MAX_MM } from "@protocol";
import { checkDimensionValues, dimensionError, parseDimensionRows } from "../../src/session/cadwork-service";
import { RULES, cleanupTemp, fakeCadSession, stopServices, tempRepo, writeRules } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";

const saved = process.env.ANVIL_SOLIDCRAFT_CLI;
beforeAll(() => void (process.env.ANVIL_SOLIDCRAFT_CLI = FAKE_SOLIDCRAFT));
afterAll(() => {
  if (saved === undefined) delete process.env.ANVIL_SOLIDCRAFT_CLI;
  else process.env.ANVIL_SOLIDCRAFT_CLI = saved;
});
afterEach(async () => {
  await stopServices();
  cleanupTemp();
});
const fake = { resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" as const }) };

describe("concept parts and dimensions", () => {
  test("[A4] proposed dimensions: 1–50 unique parameter names with finite numbers in mm; the owner's answer must give a finite number for exactly those names", () => {
    expect(parseDimensionRows([{ name: "L", value: 60, unit: "mm", note: " length " }, { name: "W", value: 20 }])).toEqual({ ok: true, rows: [{ name: "L", value: 60, unit: "mm", note: "length" }, { name: "W", value: 20 }] });
    for (const bad of [[], "L", [{ name: "1x", value: 1 }], [{ name: "pi", value: 1 }], [{ name: "L", value: Infinity }], [{ name: "L", value: "60" }], [{ name: "L", value: 1 }, { name: "L", value: 2 }], [{ name: "A", value: 30, unit: "deg" }], Array.from({ length: 51 }, (_, i) => ({ name: `P${i}`, value: i }))]) {
      expect(parseDimensionRows(bad).ok).toBe(false);
    }
    expect(checkDimensionValues(["L", "W"], { L: 95, W: 20 })).toEqual({ ok: true, values: { L: 95, W: 20 } });
    for (const bad of [{ L: 95 }, { L: 95, W: "20" }, { L: NaN, W: 1 }, { L: 1, W: 2, X: 3 }, null, [95, 20]]) expect(checkDimensionValues(["L", "W"], bad).ok).toBe(false);
  });

  test("[A4] review: a dimension must be a finite length above 0 and at most CAD_DIMENSION_MAX_MM (1e6 mm), in the proposal and the owner's answer", () => {
    expect(CAD_DIMENSION_MAX_MM).toBe(1e6);
    for (const v of [0, -0, -1, -1e-9, 1e6 + 1, 1e308, Infinity, -Infinity, NaN]) {
      expect(checkDimensionValues(["L"], { L: v }).ok).toBe(false);
      expect(parseDimensionRows([{ name: "L", value: v }]).ok).toBe(false);
      expect(dimensionError(v)).toBeDefined();
    }
    for (const v of [1e-6, 0.4, 95, 1e6]) {
      expect(checkDimensionValues(["L"], { L: v })).toEqual({ ok: true, values: { L: v } });
      expect(parseDimensionRows([{ name: "L", value: v }]).ok).toBe(true);
    }
    expect(checkDimensionValues(["L"], { L: -5 })).toEqual({ ok: false, error: "L must be above 0 mm" });
    expect(checkDimensionValues(["L"], { L: 2e6 })).toEqual({ ok: false, error: "L must be at most 1000000 mm" });
  });

  test("[A4] open_part {concept: true} is honoured only for a brand-new part: an existing part, or one with a design, is left as it is", async () => {
    const repo = tempRepo();
    writeRules(repo, RULES);
    const x = fakeCadSession(repo, fake, "sess_cad", { expectations: "manual" });
    // Needs a process.
    expect((await x.tools.open_part!({ part: "a", concept: true })).isError).toBe(true);
    // An ordinary part that already has expectations: not turned into a concept.
    await x.tools.open_part!({ part: "b" });
    await x.tools.record_expectations!({ part: "b", process: "fdm-0.4", parameters: {}, expectations: { bbox: [1, 1, 1], volume: 1, bodies: 1, holes: [] } });
    const before = readFileSync(join(repo, "cad", "b", "part.json"), "utf8");
    const r = await x.tools.open_part!({ part: "b", concept: true, process: "fdm-0.4" });
    expect(r.isError).toBe(false);
    expect(r.notes.join("\n")).toContain("honoured only when creating a brand-new part");
    expect(readFileSync(join(repo, "cad", "b", "part.json"), "utf8")).toBe(before);
    // A brand-new one becomes a concept, in the file and the lock store; reopening it is a no-op.
    expect((await x.tools.open_part!({ part: "c", concept: true, process: "fdm-0.4" })).json.modeling).toBe("allowed");
    expect((await x.tools.open_part!({ part: "c", concept: true, process: "fdm-0.4" })).notes.join("\n")).toContain("already a concept");
  });

  test("[A4] a concept written into part.json by hand is not honoured (the lock store must agree), and request_dimensions is only for a concept", async () => {
    const repo = tempRepo();
    writeRules(repo, RULES);
    const x = fakeCadSession(repo, fake, "sess_cad", { expectations: "manual" });
    await x.tools.open_part!({ part: "d" });
    writeFileSync(join(repo, "cad", "d", "part.json"), JSON.stringify({ schema: 1, process: "fdm-0.4", status: "concept" }));
    expect(x.service.modelingRefusal(partRef(repo, "d"))).toContain("not approved on this fleet");
    const r = await x.tools.request_dimensions!({ part: "d", proposed: [{ name: "L", value: 1 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("concept part");
    expect(x.openCards()).toEqual([]);
  });

  test("[A4] request_dimensions is denied without a card in an unattended session", async () => {
    const repo = tempRepo();
    writeRules(repo, RULES);
    const x = fakeCadSession(repo, fake, "sess_b", { expectations: "manual", sessionData: { workUnitRole: "builder" } });
    await x.tools.open_part!({ part: "e", concept: true, process: "fdm-0.4" });
    const r = await x.tools.request_dimensions!({ part: "e", proposed: [{ name: "L", value: 1 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unattended");
    expect(x.openCards()).toEqual([]);
  });
});
