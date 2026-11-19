/**
 * [A2] Real-tool suite for Phase A2 (agent-cad-and-browser spec §8.3): the gate on the REAL
 * `solidcraft-cli`, through the real service, manager, refresh and lock store and the real agent
 * tools. Skipped unless `ANVIL_REAL_TOOLS=1` (`bun test/tools/phase-gate.ts A2 --require-real` sets
 * it and fails on any skip).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { holeTable } from "../../src/cadwork/holes";
import { partRef } from "../../src/cadwork/partfolder";
import { PLATE_EXPECTATIONS, PLATE_VOLUME, approveCards, buildPlate, cleanupTemp, fakeCadSession, stopServices, tempRepo, writeRules } from "../helpers/cad-work";
import { REAL, SOLIDCRAFT_CLI, hasSolidcraft } from "../helpers/real-tools";

afterEach(async () => {
  await stopServices();
  cleanupTemp();
});

const plate = (repo: string) => {
  expect(hasSolidcraft()).toBe(true); // a missing binary is a FAILURE in a real run, never a skip
  return buildPlate(repo, { cli: SOLIDCRAFT_CLI });
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe("real SolidCraft through the gate", () => {
  test.skipIf(!REAL)("[A2] real: the plate with the documented volume formula and holes [{diameter: 3.4, count: 4}] passes the gate", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const x = await plate(repo);
    const file = JSON.parse(readFileSync(x.partJson, "utf8"));
    expect(file.expectations.volume).toBe(PLATE_VOLUME);
    expect(file.expectations.holes).toEqual([{ diameter: 3.4, count: 4 }]);
    expect(x.gate.failing).toEqual([]);
    expect(x.gate.state).toBe("pass");
    expect(x.gate.warnings).toEqual([]);
    expect(x.gate.staleBuild).toBe(false);
    // What the real kernel measured, as the daemon recorded it.
    expect(file.measured.solidcraft).toMatch(/^\d+\.\d+\.\d+/);
    expect(file.measured.bbox.map((v: number) => Math.round(v * 1e6) / 1e6)).toEqual([6, 50, 80]);
    expect(Math.abs(file.measured.volume - 23335.166952)).toBeLessThan(1e-3);
    expect(file.measured.faces).toBe(22);
    expect(file.measured.bodies).toBe(1);
    expect(file.measured.holes).toEqual([{ diameter: 3.4, count: 4, kind: "through" }]);
    expect(file.measured.scriptSha).toBe(x.manager.status(partRef(repo, "plate"))!.scriptSha);
    // The formula agrees with the kernel to far better than the 0.1 % tolerance.
    const volume = x.gate.checks.find((c: any) => c.id === "volume");
    expect(Math.abs(volume.measured - volume.expected) / volume.expected).toBeLessThan(1e-9);
    // The full hole table: one row, the counterbore inside it.
    expect(x.service.snapshot(partRef(repo, "plate"))!.outcome.holes).toEqual([{ diameter: 3.4, kind: "through", depth: 6, counterbore: [{ diameter: 6.5, depth: 3.3 }], count: 4 }]);
    expect(x.manager.status(partRef(repo, "plate"))!.state.status).toBe("pass");
  }, 120_000);

  test.skipIf(!REAL)("[A2] real: removing the pattern feature fails the gate, naming the hole count and the volume", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const x = await plate(repo);
    expect(x.gate.state).toBe("pass");
    expect((await x.tools.undo!({})).isError).toBe(false); // the pattern was the agent's last request
    const timeline = (await x.tools.inspect_design!({ measure: false, sketches: false, timeline: "summary", bodies: "names" })).json.timeline;
    expect(timeline.map((f: any) => f.type)).not.toContain("RectangularPatternFeature");
    const g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing).toHaveLength(2);
    expect(g.failing[0]).toMatch(/^volume: expected 23335\.167, measured 23737\.22/);
    expect(g.failing[1]).toBe("holes ⌀3.4 count: expected 4, measured 1");
    expect(x.manager.status(partRef(repo, "plate"))!.state.status).toBe("fail");
    await x.tools.redo!({});
    expect((await x.check()).state).toBe("pass");
  }, 120_000);

  test.skipIf(!REAL)("[A2] real: the hole table of a part with one blind hole and one boss is exactly the blind hole", async () => {
    expect(hasSolidcraft()).toBe(true);
    const repo = tempRepo("anvil-cad-real-");
    writeRules(repo);
    const x = fakeCadSession(repo, { resolveCli: () => ({ path: SOLIDCRAFT_CLI, source: "env" }) }, "sess_cad", { expectations: "manual" });
    await x.tools.open_part!({ part: "block" });
    // Block 40 × 30 × 10, a ⌀8 × 5 boss on top, a ⌀5 × 6 blind hole from the top.
    const volume = "40*30*10 + pi*4^2*5 - pi*2.5^2*6";
    const recorded = await x.tools.record_expectations!({ part: "block", process: "fdm-0.4", expectations: { bbox: [40, 30, 15], volume, bodies: 1, holes: [{ diameter: 5, count: 1, kind: "blind" }] } });
    expect(recorded.isError).toBe(false);
    const built = await x.tools.batch!({
      commands: [
        { command: "solid.box", params: { length: 40, width: 30, height: 10, name: "Block" } },
        { command: "solid.cylinder", params: { radius: 4, height: 5, base: [10, 15, 10], operation: "join", name: "Boss" } },
        { command: "solid.hole", params: { position: [30, 15, 10], diameter: 5, depth: 6, name: "Blind" } },
      ],
    });
    expect(built.isError).toBe(false);
    const ref = partRef(repo, "block");
    const t0 = performance.now();
    const table = await x.manager.run(ref, (slot) => holeTable((tool, args) => slot.call(tool, args), "Body1"));
    const ms = performance.now() - t0;
    expect(table).toHaveLength(1); // the boss is not a hole
    expect(table[0]).toMatchObject({ diameter: 5, kind: "blind", count: 1 });
    expect(table[0]!.counterbore).toBeUndefined();
    await x.tools.check_part!({ part: "block" });
    approveCards(x);
    const g = (await x.tools.check_part!({ part: "block" })).json;
    expect(g.failing).toEqual([]);
    expect(g.state).toBe("pass");
    expect(JSON.parse(readFileSync(join(repo, "cad", "block", "part.json"), "utf8")).measured.holes).toEqual([{ diameter: 5, count: 1, kind: "blind" }]);
    console.log(`[A2 real] hole table (boss + blind hole): ${ms.toFixed(0)} ms (recorded, not asserted)`);
  }, 120_000);

  test.skipIf(!REAL)("[A2] real: a parameter change that breaks a feature fails the gate on the feature-error check", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const x = await plate(repo);
    expect(x.gate.state).toBe("pass");
    // W = 8 leaves no room for the R5 corner fillets: SolidCraft reports SUCCESS and keeps the change.
    const changed = await x.tools.set_parameter!({ name: "W", expression: "8" });
    expect(changed.isError).toBe(false);
    expect(changed.json.errors.map((e: any) => e.feature)).toContain("Corners");
    const g = await x.check();
    expect(g.state).toBe("fail");
    const features = g.checks.find((c: any) => c.id === "features");
    expect(features).toMatchObject({ ok: false, hard: true, expected: "no failed features" });
    expect(features.measured).toContain("Corners:");
    expect(g.failing.some((l: string) => l.startsWith("features: expected no failed features, measured Corners:"))).toBe(true);
    // The partial geometry it left behind is measured, and does not match either.
    expect(g.failing.some((l: string) => l.startsWith("volume:"))).toBe(true);
    // Undoing the change restores a passing part.
    await x.tools.undo!({});
    expect((await x.check()).state).toBe("pass");
  }, 120_000);

  test.skipIf(!REAL)("[A2] real: measured timings of the refresh on the reference plate are recorded", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const x = await plate(repo);
    const ref = partRef(repo, "plate");
    const refresh: number[] = [];
    const change: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      expect((await x.service.setParamAsOwner(ref, "L", String(80 + (i % 2 ? 0 : 40)))).ok).toBe(true); // change + script write + refresh
      change.push(performance.now() - t0);
      refresh.push(x.service.snapshot(ref)!.outcome.ms);
      expect(x.service.snapshot(ref)!.outcome.gate.state).toBe("pass");
    }
    for (let i = 0; i < 5; i++) {
      await x.check();
      refresh.push(x.service.snapshot(ref)!.outcome.ms);
    }
    expect(refresh.every((ms) => Number.isFinite(ms) && ms > 0)).toBe(true);
    console.log(
      `[A2 real] refresh (measure + hole table + gate + part.json) on the plate: median ${median(refresh).toFixed(0)} ms, max ${Math.max(...refresh).toFixed(0)} ms over ${refresh.length} runs; ` +
        `owner parameter change + script write + refresh: median ${median(change).toFixed(0)} ms (recorded, not asserted; spec §6 target: under 1 s)`,
    );
  }, 180_000);
});
