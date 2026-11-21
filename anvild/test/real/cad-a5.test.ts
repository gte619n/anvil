/**
 * [A5] Real-tool suite for Phase A5, the merge guard (agent-cad-and-browser spec §8.3, §4.11): the
 * two-branch merge of the A5 Acceptance end to end on the reference plate with the REAL
 * `solidcraft-cli` — the real service builds and re-measures, `verify-cli.ts` runs as a subprocess and
 * replays in its own sandboxed real process — including the CLI's exit codes. Wall times are recorded.
 * Skipped unless `ANVIL_REAL_TOOLS=1` (`bun test/tools/phase-gate.ts A5 --require-real`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { evalExpr } from "../../src/cadwork/expr";
import { PLATE_VOLUME, cleanupTemp, stopServices, tempDir } from "../helpers/cad-work";
import { git, runVerifyCli, twoBranchMerge } from "../helpers/cad-verify";
import { REAL, SOLIDCRAFT_CLI, hasSolidcraft } from "../helpers/real-tools";

const saved = process.env.ANVIL_SOLIDCRAFT_CLI;
beforeAll(() => void (process.env.ANVIL_SOLIDCRAFT_CLI = SOLIDCRAFT_CLI));
afterAll(() => {
  if (saved === undefined) delete process.env.ANVIL_SOLIDCRAFT_CLI;
  else process.env.ANVIL_SOLIDCRAFT_CLI = saved;
});
afterEach(async () => {
  await stopServices();
  cleanupTemp();
});

const plateVolume = (L: number, T: number) => evalExpr(PLATE_VOLUME, { L, W: 50, T });

describe("real SolidCraft: the merge guard", () => {
  test.skipIf(!REAL)("[A5] real: two branches change L and T of the plate; after the clean merge verify-cli exits 1 on the stale measurement, after check_part it exits 0, and an edited expectations block exits 1; wall time recorded", async () => {
    expect(hasSolidcraft()).toBe(true); // a missing binary is a FAILURE in a real run, never a skip
    const t0 = performance.now();
    const m = await twoBranchMerge(SOLIDCRAFT_CLI);
    const setupMs = performance.now() - t0;
    const env = { ANVIL_STATE_DIR: m.stateDir, ANVIL_SOLIDCRAFT_CLI: SOLIDCRAFT_CLI };
    // Branch a's measurement is what the merge carried: L = 120, T = 6 (35,335.2 mm³, §4.14 #11).
    expect(Math.abs(m.partDoc().measured.volume - 35335.2)).toBeLessThan(0.1);

    // 1. After the clean text merge: non-zero, because part.json's measurement is not of this script.
    const stale = await runVerifyCli(m.repo, ["--changed-since", m.base, "--json"], env);
    expect(stale.code).toBe(1);
    const p = stale.json.parts.find((x: any) => x.part === "plate");
    expect(p.state).toBe("fail");
    expect(p.failing[0]).toStartWith("measured.scriptSha");
    expect(p.failing.some((l: string) => l.startsWith("measured.volume"))).toBe(true);
    // The real replay is of the MERGED design (L = 120 and T = 6.5) and matches what the owner accepted.
    expect(Math.abs(p.measurement.volume - plateVolume(120, 6.5)) / plateVolume(120, 6.5)).toBeLessThan(1e-6);
    expect(p.measurement.bbox.map((v: number) => Math.round(v * 1e6) / 1e6)).toEqual([6.5, 50, 120]);
    expect(p.measurement.holes).toEqual([{ diameter: 3.4, count: 4, kind: "through" }]);
    for (const id of ["lock.expectations", "accepted", "features", "volume", "holes ⌀3.4 count"]) expect(p.checks.find((c: any) => c.id === id).ok).toBe(true);
    const plain = await runVerifyCli(m.repo, ["--changed-since", m.base], env);
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain("FAILED: do not commit this merge");

    // 2. The refresh on the merged script, then the guard passes.
    const t1 = performance.now();
    const g = (await m.tools.check_part!({ part: "plate" })).json;
    const refreshMs = performance.now() - t1;
    expect(g.failing).toEqual([]);
    expect(g.state).toBe("pass");
    git(m.repo, "commit", "-q", "-am", "re-measured after the merge");
    const ok = await runVerifyCli(m.repo, ["--changed-since", m.base], env);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("OK: every selected part passes.");

    // 3. Expectations edited outside the approval flow: non-zero, adoption pending.
    const pj = m.partJson;
    const doc = JSON.parse(readFileSync(pj, "utf8"));
    doc.expectations.holes = [];
    writeFileSync(pj, JSON.stringify(doc, null, 2) + "\n");
    const adopt = await runVerifyCli(m.repo, ["--json"], env);
    expect(adopt.code).toBe(1);
    expect(adopt.json.parts[0]).toMatchObject({ part: "plate", state: "unverified", needsAdoption: "expectations" });

    // Exit 2: not a repo, and no binary.
    expect((await runVerifyCli(tempDir(), [], env)).code).toBe(2);
    expect((await runVerifyCli(m.repo, [], { ...env, ANVIL_SOLIDCRAFT_CLI: "/nonexistent/solidcraft-cli" })).code).toBe(2);

    console.log(
      `[A5 real] two-branch scenario setup ${setupMs.toFixed(0)} ms; verify-cli (stale, json) ${stale.ms.toFixed(0)} ms; check_part refresh ${refreshMs.toFixed(0)} ms; verify-cli (pass) ${ok.ms.toFixed(0)} ms; total ${(performance.now() - t0).toFixed(0)} ms (recorded, not asserted)`,
    );
  }, 300_000);
});
