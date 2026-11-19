/**
 * [A2] Real-tool suite for Phase A2 (agent-cad-and-browser spec §8.3): the gate on the REAL
 * `solidcraft-cli`, through the real service, manager, refresh and lock store and the real agent
 * tools. Skipped unless `ANVIL_REAL_TOOLS=1` (`bun test/tools/phase-gate.ts A2 --require-real` sets
 * it and fails on any skip).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAllowedCommand } from "../../src/agent/cad-command-allow";
import { holeTable } from "../../src/cadwork/holes";
import { repoIdentity } from "../../src/cadwork/locks";
import { partRef } from "../../src/cadwork/partfolder";
import { PLATE_EXPECTATIONS, PLATE_VOLUME, approveCards, buildPlate, cleanupTemp, fakeCadSession, stopServices, tempRepo, until, writeRules } from "../helpers/cad-work";
import { REFERENCE_PLATE } from "../helpers/fake-solidcraft";
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
    const recorded = await x.tools.record_expectations!({ part: "block", process: "fdm-0.4", parameters: {}, expectations: { bbox: [40, 30, 15], volume, bodies: 1, holes: [{ diameter: 5, count: 1, kind: "blind" }] } });
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

  // ── the Phase A2 review's repros, on the real kernel ──────────────────────────────────────────────
  const realSession = (repo: string, id = "sess_cad", sessionData: Record<string, unknown> = {}) => {
    expect(hasSolidcraft()).toBe(true);
    return fakeCadSession(repo, { resolveCli: () => ({ path: SOLIDCRAFT_CLI, source: "env" }) }, id, { expectations: "manual", sessionData });
  };

  test.skipIf(!REAL)("[A2] real review 1: recording formulas, building a 13×17×19 box, measuring, then setting the parameters to the measurement does NOT pass — the numbers were fixed at record time", async () => {
    const repo = tempRepo("anvil-cad-real-");
    writeRules(repo);
    const x = realSession(repo);
    await x.tools.open_part!({ part: "box" });
    const formulas = { bbox: ["A", "B", "C"], volume: "V", bodies: 1, holes: [] };
    // Step 1 of the repro as the reviewer ran it: formulas over parameters that do not exist yet.
    const blind = await x.tools.record_expectations!({ part: "box", process: "fdm-0.4", parameters: {}, expectations: formulas });
    expect(blind.isError).toBe(true);
    expect(blind.text).toContain("Every parameter a formula uses must be listed in `parameters`");
    expect((await x.tools.execute!({ command: "solid.box", params: { length: 13, width: 17, height: 19, name: "Blob" } })).isError).toBe(true); // still no modeling
    // The only way in: declare values now. The daemon creates them in the REAL design.
    const rec = await x.tools.record_expectations!({ part: "box", process: "fdm-0.4", parameters: { A: 1, B: "2 mm", C: 3, V: 6 }, expectations: formulas });
    expect(rec.isError).toBe(false);
    const ref = partRef(repo, "box");
    expect(x.manager.status(ref)!.params.map((p) => [p.name, p.value])).toEqual([["A", 1], ["B", 2], ["C", 3], ["V", 6]]);
    const lock = x.service.locks.findPart(repoIdentity(repo), "box")!;
    expect(lock.values).toEqual({ bbox: [1, 2, 3], volume: 6, bodies: 1, holes: [] });
    // Build, measure, and move the parameters onto the measurement.
    expect((await x.tools.execute!({ command: "solid.box", params: { length: 13, width: 17, height: 19, name: "Blob" } })).isError).toBe(false);
    const measured = (await x.tools.measure!({ summary: true })).json.total.volume_mm3;
    expect(Math.abs(measured - 13 * 17 * 19)).toBeLessThan(1e-6);
    expect((await x.tools.execute!({ command: "parameters.add", params: { name: "A", expression: "13" } })).isError).toBe(true); // "equal to the measurement" cannot be ADDED: they exist
    for (const [name, v] of [["A", 13], ["B", 17], ["C", 19], ["V", measured]] as const) expect((await x.tools.set_parameter!({ name, expression: String(v) })).isError).toBe(false);
    await x.tools.check_part!({ part: "box" });
    approveCards(x); // the rules file
    const g = (await x.tools.check_part!({ part: "box" })).json;
    expect(g.state).toBe("fail"); // the reviewer got `pass` here
    expect(g.failing.join("\n")).toContain("expected value moved without owner approval");
    expect(g.checks.find((c: any) => c.id === "volume")).toMatchObject({ expected: 6, ok: false });
    expect(x.service.locks.findPart(repoIdentity(repo), "box")!.values!.volume).toBe(6);
    expect(x.openCards()).toEqual([]); // and nobody was asked to bless it
  }, 120_000);

  test.skipIf(!REAL)("[A2] real review 2: a hand-written design.json, replayed and measured, cannot be given expectations by the agent — it is the owner's card, and Deny writes nothing", async () => {
    // A real script for a 10 mm cube, made by a real process in another repo…
    const donor = tempRepo("anvil-cad-real-");
    const d = fakeCadSession(donor, { resolveCli: () => ({ path: SOLIDCRAFT_CLI, source: "env" }) });
    await d.tools.open_part!({ part: "cube" });
    expect((await d.tools.execute!({ command: "solid.box", params: { length: 10, width: 10, height: 10, name: "Cube" } })).isError).toBe(false);
    const script = readFileSync(join(donor, "cad", "cube", "design.json"), "utf8");
    await stopServices();
    // …written into this repo by hand (Write is not Bash), before anything else exists for the part.
    const repo = tempRepo("anvil-cad-real-");
    writeRules(repo);
    mkdirSync(join(repo, "cad", "cube"), { recursive: true });
    writeFileSync(join(repo, "cad", "cube", "design.json"), script);
    const x = realSession(repo);
    const opened = await x.tools.open_part!({ part: "cube" });
    expect(opened.json).toMatchObject({ has_design: true, state: "unverified" });
    const measured = (await x.tools.measure!({ summary: true })).json.total.volume_mm3; // inspection is allowed
    expect(Math.abs(measured - 1000)).toBeLessThan(1e-6);
    const pending = x.tools.record_expectations!({ part: "cube", process: "fdm-0.4", parameters: {}, expectations: { bbox: [10, 10, 10], volume: measured, bodies: 1, holes: [] } });
    await until(() => x.openCards().some((c: any) => c.kind === "initial"), "the owner card", 20_000);
    const card = x.openCards().find((c: any) => c.kind === "initial");
    expect(card.note).toBe("this part already has geometry; these numbers were written after it existed");
    expect(existsSync(join(repo, "cad", "cube", "part.json"))).toBe(false);
    x.service.respond(card.requestId, false);
    expect((await pending).json).toMatchObject({ recorded: false });
    expect(existsSync(join(repo, "cad", "cube", "part.json"))).toBe(false);
    expect(x.service.locks.findPart(repoIdentity(repo), "cube")).toBeUndefined();
    const g = (await x.tools.check_part!({ part: "cube" })).json;
    expect(g.state).toBe("unverified"); // the reviewer got `pass`
    // In an unattended session there is not even a card.
    await stopServices();
    const auto = realSession(repo, "sess_auto", { workUnitRole: "builder" });
    await auto.tools.open_part!({ part: "cube" });
    const refused = await auto.tools.record_expectations!({ part: "cube", process: "fdm-0.4", parameters: {}, expectations: { bbox: [10, 10, 10], volume: measured, bodies: 1, holes: [] } });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("unattended");
    expect(auto.openCards()).toEqual([]);
  }, 180_000);

  test.skipIf(!REAL)("[A2] real review 9: after every allowed command exercised here the script still exports and design.json is rewritten; component.from_bodies / move_bodies, which break the export, are refused", async () => {
    const repo = tempRepo("anvil-cad-real-");
    const x = fakeCadSession(repo, { resolveCli: () => ({ path: SOLIDCRAFT_CLI, source: "env" }) });
    await x.tools.open_part!({ part: "plate" });
    const ref = partRef(repo, "plate");
    const design = join(repo, "cad", "plate", "design.json");
    let last = "";
    const families = new Set<string>();
    // Every command of the reference plate, one at a time, then one from each further family a part uses.
    const steps = [
      ...REFERENCE_PLATE,
      { command: "parameters.change", params: { changes: { inset: "9 mm" } } },
      { command: "solid.box", params: { length: 5, width: 5, height: 5, name: "Lug" } },
      { command: "solid.cylinder", params: { radius: 2, height: 4, base: [0, 0, 6], operation: "join", name: "Boss" } },
      { command: "component.create", params: { name: "Sub" } },
      { command: "component.rename", params: { component: "Sub", name: "Sub2" } },
    ];
    for (const step of steps) {
      expect(isAllowedCommand(step.command)).toBe(true);
      const r = await x.tools.execute!(step);
      expect([step.command, r.isError, r.text.slice(0, 200)]).toEqual([step.command, false, r.text.slice(0, 200)]);
      // The script was exported and written: the file changed, parses, and is what the manager holds.
      const now_ = readFileSync(design, "utf8");
      if (!["sketch.finish"].includes(step.command)) expect([step.command, now_ !== last]).toEqual([step.command, true]);
      last = now_;
      expect(Array.isArray(JSON.parse(now_).commands)).toBe(true);
      expect(x.manager.status(ref)!.state.conflict).toBe(false);
      const exported = await x.manager.request(ref, { tool: "execute", args: { command: "timeline.export_script", params: {} }, kind: "read" });
      expect([step.command, exported.result.isError]).toEqual([step.command, false]);
      families.add(step.command.split(".")[0]!);
    }
    expect([...families].sort()).toEqual(["component", "parameters", "sketch", "solid"]);
    // The two commands the review found: refused by the tools, so the design can always be written.
    for (const id of ["component.from_bodies", "component.move_bodies"]) {
      expect(isAllowedCommand(id)).toBe(false);
      const r = await x.tools.execute!({ command: id, params: { bodies: ["Body1"] } });
      expect(r.isError).toBe(true);
    }
    expect(readFileSync(design, "utf8")).toBe(last);
    // Why: sent straight to SolidCraft (not through the tools), from_bodies applies and the export then fails.
    const scratch = tempRepo("anvil-cad-real-");
    const y = fakeCadSession(scratch, { resolveCli: () => ({ path: SOLIDCRAFT_CLI, source: "env" }) }, "sess_y");
    await y.tools.open_part!({ part: "p" });
    await y.tools.execute!({ command: "solid.box", params: { length: 5, width: 5, height: 5, name: "B" } });
    const before = readFileSync(join(scratch, "cad", "p", "design.json"), "utf8");
    const raw = await y.manager.request(partRef(scratch, "p"), { tool: "execute", args: { command: "component.from_bodies", params: { bodies: ["Body1"] } }, kind: "mutate" }).then(
      (r) => `resolved: ${r.result.text}`,
      (e) => `rejected: ${e.message}`,
    );
    console.log(`[A2 real] component.from_bodies sent straight to SolidCraft → ${raw.slice(0, 220)}`);
    expect(raw).toMatch(/^rejected: .*design\.json could not be written/);
    expect(readFileSync(join(scratch, "cad", "p", "design.json"), "utf8")).toBe(before);
  }, 240_000);
});
