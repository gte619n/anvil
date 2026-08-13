/**
 * Phase 2 acceptance harness (loops-circuit spec §5/§8). Deterministic: a fake clock, a scripted
 * `runLap` (diffs + outputs — no worktree, no subprocess), a scripted judge/command, and a real
 * LoopStore over a temp dir. Drives whole lifecycles: laps advance with verdicts → gate → open/send-back
 * → terminal states; and the guardrail trips (scope-violation, check-tampering, over-budget, no-progress,
 * lap ceiling). No model spend; CI-reproducible.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopStore } from "../../src/loops/store";
import { LoopEngine, type LapExecution, type LoopEngineDeps } from "../../src/loops/engine";
import { completeLoop } from "../../src/loops/contract";
import type { Loop, LoopInput } from "../../protocol";

interface ScriptLap {
  diffFiles: string[];
  summary?: string;
  tokens?: number;
  judge?: { met: boolean; reason?: string };
  command?: { exit: number; output?: string };
}

function makeLoop(over: Partial<LoopInput> = {}): Loop {
  const input: LoopInput = {
    name: "Fix the flaky upload test",
    trigger: { kind: "manual" },
    act: { kind: "session-prompt", prompt: "fix it" },
    checks: [{ kind: "command", command: "bun test upload", locks: ["test/upload.test.ts"] }],
    checksMode: "all",
    scope: { allow: ["src/upload/"] },
    rung: "pr",
    hardStops: { maxLaps: 5, tokenBudget: 300_000, noProgressLaps: 2 },
    ...over,
  };
  return completeLoop(input, { now: "2026-08-11T00:00:00.000Z", genId: () => "loop_test" }).loop;
}

function harness(script: ScriptLap[], gateResult: { summary: string; url?: string } = { summary: "opened PR", url: "https://pr/1" }) {
  const dir = mkdtempSync(join(tmpdir(), "anvil-loop-"));
  const store = new LoopStore(dir);
  let clock = Date.parse("2026-08-11T00:00:00.000Z");
  let runIdN = 0;
  let lapN = 0; // next index into script; runLap consumes one entry per lap and pins it as `current`
  let current: ScriptLap = { diffFiles: [] };
  const runs: string[] = []; // captured run statuses (broadcast order)
  const deps: LoopEngineDeps = {
    store,
    now: () => new Date(clock),
    genRunId: () => `run_${++runIdN}`,
    runLap: async () => {
      // One script entry per lap, pinned here so judge/runCommand (called later in the same lap) read it.
      current = script[lapN] ?? { diffFiles: [] };
      lapN++;
      clock += 1000;
      const exec: LapExecution = {
        diffFiles: current.diffFiles,
        summary: current.summary ?? `lap ${lapN}`,
        tokens: current.tokens ?? 1000,
        transcript: "…",
        cwd: dir,
      };
      return exec;
    },
    judge: async () => current.judge ?? { met: false, reason: "no judge scripted" },
    runCommand: async () => ({ exit: current.command?.exit ?? 1, output: current.command?.output ?? "" }),
    openGateAction: async () => gateResult,
    onRun: (r) => runs.push(r.status),
  };
  const engine = new LoopEngine(deps);
  return { engine, store, runs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("laps advance with verdicts; a passing check parks the run at-gate; Open the gate ships the PR", async () => {
  const loop = makeLoop();
  const h = harness([
    { diffFiles: ["src/upload/a.ts"], command: { exit: 1, output: "2 failed" } }, // lap 1 fails
    { diffFiles: ["src/upload/a.ts"], command: { exit: 0 } }, // lap 2 passes
  ]);
  try {
    h.store.save(loop);
    const run = await h.engine.run(loop, { kind: "manual" });
    expect(run.status).toBe("at-gate");
    expect(run.laps.length).toBe(2);
    expect(run.laps[0]!.verdicts[0]!.v).toBe("fail");
    expect(run.laps[1]!.verdicts[0]!.v).toBe("pass");
    // Open the gate → ships the PR.
    const shipped = await h.engine.openGate(loop.id, run.id);
    expect(shipped.status).toBe("shipped");
    expect(shipped.reason).toContain("https://pr/1");
    expect(h.store.get(loop.id)!.cleanGatedLaps).toBe(1);
    // A second open on the shipped run is a BadCommand (idempotent / stale gate).
    await expect(h.engine.openGate(loop.id, run.id)).rejects.toThrow(/not at the gate/);
  } finally {
    h.cleanup();
  }
});

test("a lap whose diff exits scope fails scope-violation (checks not consulted)", async () => {
  const loop = makeLoop();
  const h = harness([
    { diffFiles: ["src/other/x.ts"], command: { exit: 0 } }, // outside src/upload/ — would pass checks, but scope wins
    { diffFiles: ["src/upload/a.ts"], command: { exit: 0 } }, // back in scope → passes
  ]);
  try {
    h.store.save(loop);
    const run = await h.engine.run(loop, { kind: "manual" });
    expect(run.laps[0]!.verdicts[0]!.v).toBe("scope-violation");
    expect(run.laps[0]!.verdicts[0]!.detail).toContain("src/other/x.ts");
    expect(run.status).toBe("at-gate"); // lap 2 recovered
  } finally {
    h.cleanup();
  }
});

test("a lap that edits the check's locked test file fails check-tampering (worst verdict wins)", async () => {
  const loop = makeLoop();
  const h = harness([
    { diffFiles: ["src/upload/a.ts", "test/upload.test.ts"], command: { exit: 0 } }, // touched a locked input
    { diffFiles: ["src/upload/a.ts"], command: { exit: 0 } },
  ]);
  try {
    h.store.save(loop);
    const run = await h.engine.run(loop, { kind: "manual" });
    expect(run.laps[0]!.verdicts[0]!.v).toBe("check-tampering");
    expect(run.laps[0]!.verdicts[0]!.detail).toContain("test/upload.test.ts");
  } finally {
    h.cleanup();
  }
});

test("the lap ceiling is hard: with a 5-lap cap and never-passing distinct laps, the 6th never runs", async () => {
  const loop = makeLoop({ hardStops: { maxLaps: 5, tokenBudget: 300_000, noProgressLaps: 99 } });
  // Distinct diffs each lap so no-progress never fires — only the ceiling stops it.
  const script: ScriptLap[] = Array.from({ length: 8 }, (_, i) => ({ diffFiles: [`src/upload/f${i}.ts`], command: { exit: 1, output: "still red" } }));
  const h = harness(script);
  try {
    h.store.save(loop);
    const run = await h.engine.run(loop, { kind: "manual" });
    expect(run.laps.length).toBe(5); // exactly the cap — the 6th lap never ran
    expect(run.status).toBe("failed");
    expect(run.reason).toContain("5-lap ceiling");
  } finally {
    h.cleanup();
  }
});

test("a run hitting no-progress ends terminal no-progress WITHOUT parking at the gate", async () => {
  const loop = makeLoop({ hardStops: { maxLaps: 10, tokenBudget: 300_000, noProgressLaps: 2 } });
  // Two identical failing laps (same empty diff) → no-progress.
  const h = harness([
    { diffFiles: [], command: { exit: 1, output: "red" } },
    { diffFiles: [], command: { exit: 1, output: "red" } },
    { diffFiles: [], command: { exit: 1, output: "red" } },
  ]);
  try {
    h.store.save(loop);
    const run = await h.engine.run(loop, { kind: "manual" });
    expect(run.status).toBe("no-progress");
    expect(run.laps.length).toBe(2); // stopped as soon as the 2nd identical failing lap landed
    expect(run.status).not.toBe("at-gate");
  } finally {
    h.cleanup();
  }
});

test("over-budget: the token budget is enforced at the lap boundary", async () => {
  const loop = makeLoop({ hardStops: { maxLaps: 10, tokenBudget: 2500, noProgressLaps: 99 } });
  const h = harness([
    { diffFiles: ["src/upload/a.ts"], tokens: 2000, command: { exit: 1, output: "red" } }, // 2000 total
    { diffFiles: ["src/upload/b.ts"], tokens: 2000, command: { exit: 1, output: "red" } }, // 4000 → next boundary trips
    { diffFiles: ["src/upload/c.ts"], tokens: 2000, command: { exit: 0 } }, // never runs
  ]);
  try {
    h.store.save(loop);
    const run = await h.engine.run(loop, { kind: "manual" });
    expect(run.status).toBe("over-budget");
    expect(run.laps.length).toBe(2); // 3rd lap blocked at the boundary (4000 ≥ 2500)
    expect(run.reason).toContain("budget");
  } finally {
    h.cleanup();
  }
});

test("Send back a lap runs EXACTLY one more lap carrying the note; refused at the ceiling", async () => {
  const loop = makeLoop({ hardStops: { maxLaps: 5, tokenBudget: 300_000, noProgressLaps: 99 } });
  const h = harness([
    { diffFiles: ["src/upload/a.ts"], command: { exit: 0 } }, // lap 1 passes → at-gate
    { diffFiles: ["src/upload/a.ts"], command: { exit: 0 } }, // the single sendback lap (passes → back at-gate)
  ]);
  try {
    h.store.save(loop);
    const run = await h.engine.run(loop, { kind: "manual" });
    expect(run.status).toBe("at-gate");
    expect(run.laps.length).toBe(1);
    const after = await h.engine.sendback(loop.id, run.id, "please also handle retries");
    expect(after.laps.length).toBe(2); // exactly one more lap ran
    expect(after.gate?.sentBackNote).toBe("please also handle retries");
    expect(after.status).toBe("at-gate");
    // Sendback on a non-at-gate run is a BadCommand.
    const shipped = await h.engine.openGate(loop.id, run.id);
    expect(shipped.status).toBe("shipped");
    await expect(h.engine.sendback(loop.id, run.id, "x")).rejects.toThrow(/not at the gate/);
  } finally {
    h.cleanup();
  }
});

test("gate open is idempotent under concurrent verbs (no double-ship)", async () => {
  const loop = makeLoop();
  let gateCalls = 0;
  const dir = mkdtempSync(join(tmpdir(), "anvil-loop-"));
  const store = new LoopStore(dir);
  let clock = Date.parse("2026-08-11T00:00:00.000Z");
  const engine = new LoopEngine({
    store,
    now: () => new Date(clock),
    genRunId: () => "run_g",
    runLap: async () => {
      clock += 1000;
      return { diffFiles: ["src/upload/a.ts"], summary: "lap", tokens: 100, transcript: "x", cwd: dir };
    },
    judge: async () => ({ met: true }),
    runCommand: async () => ({ exit: 0, output: "" }),
    openGateAction: async () => {
      gateCalls++;
      await new Promise((r) => setTimeout(r, 5)); // straddle the guard/mutation window
      return { summary: "opened PR", url: "https://pr/1" };
    },
    onRun: () => {},
  });
  try {
    store.save(loop);
    const run = await engine.run(loop, { kind: "manual" });
    expect(run.status).toBe("at-gate");
    // Two concurrent opens: exactly one ships; the other is rejected.
    const results = await Promise.allSettled([engine.openGate(loop.id, run.id), engine.openGate(loop.id, run.id)]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(ok).toBe(1);
    expect(rejected).toBe(1);
    expect(gateCalls).toBe(1); // the ship action ran once — no double PR
    expect(store.get(loop.id)!.cleanGatedLaps).toBe(1); // no double autonomy credit
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gate action that throws grants NO autonomy credit and leaves the run at-gate", async () => {
  const loop = makeLoop();
  const h = harness([{ diffFiles: ["src/upload/a.ts"], command: { exit: 0 } }], { summary: "n/a" });
  // Override openGateAction to throw (simulates the lost-worktree restart case).
  // Rebuild the engine with a throwing gate action over the same store.
  const dir = mkdtempSync(join(tmpdir(), "anvil-loop-"));
  const store = new LoopStore(dir);
  let clock = Date.parse("2026-08-11T00:00:00.000Z");
  const engine = new LoopEngine({
    store, now: () => new Date(clock), genRunId: () => "run_g",
    runLap: async () => { clock += 1000; return { diffFiles: ["src/upload/a.ts"], summary: "lap", tokens: 100, transcript: "x", cwd: dir }; },
    judge: async () => ({ met: true }), runCommand: async () => ({ exit: 0, output: "" }),
    openGateAction: async () => { throw new Error("worktree is gone"); },
    onRun: () => {},
  });
  try {
    store.save(loop);
    const run = await engine.run(loop, { kind: "manual" });
    expect(run.status).toBe("at-gate");
    await expect(engine.openGate(loop.id, run.id)).rejects.toThrow(/worktree is gone/);
    expect(store.runById(loop.id, run.id)?.status).toBe("at-gate"); // still at-gate, not shipped
    expect(store.get(loop.id)!.cleanGatedLaps).toBe(0); // no unearned credit
  } finally {
    rmSync(dir, { recursive: true, force: true });
    h.cleanup();
  }
});

test("dry run drives exactly one lap, flags dryRun, and the gate refuses it (no branch/PR)", async () => {
  const loop = makeLoop();
  const h = harness([
    { diffFiles: ["src/upload/a.ts"], command: { exit: 0 } }, // would pass
    { diffFiles: ["src/upload/a.ts"], command: { exit: 0 } }, // must NOT run (dry run = one lap)
  ]);
  try {
    h.store.save(loop);
    const run = await h.engine.dryRun(loop);
    expect(run.dryRun).toBe(true);
    expect(run.laps.length).toBe(1); // exactly one lap
    expect(run.reason).toMatch(/dry run/i);
    // The gate refuses a dry run — no ship action can ever push a branch or open a PR.
    await expect(h.engine.openGate(loop.id, run.id)).rejects.toThrow(/dry run/i);
  } finally {
    h.cleanup();
  }
});

test("check-error does not fail the loop; it counts toward no-progress", async () => {
  const loop = makeLoop({
    checks: [{ kind: "judge", condition: "it works" }],
    scope: { allow: ["src/upload/"] },
    hardStops: { maxLaps: 10, tokenBudget: 300_000, noProgressLaps: 2 },
  });
  // Judge throws → check-error both laps, identical empty diff → no-progress (not "failed" on the error).
  const dir = mkdtempSync(join(tmpdir(), "anvil-loop-"));
  const store = new LoopStore(dir);
  let clock = Date.parse("2026-08-11T00:00:00.000Z");
  let n = 0;
  const runs: string[] = [];
  const engine = new LoopEngine({
    store,
    now: () => new Date(clock),
    genRunId: () => "run_ce",
    runLap: async () => {
      clock += 1000;
      n++;
      return { diffFiles: [], summary: `lap ${n}`, tokens: 100, transcript: "x", cwd: dir };
    },
    judge: async () => {
      throw new Error("judge unreachable");
    },
    runCommand: async () => ({ exit: 0, output: "" }),
    openGateAction: async () => ({ summary: "n/a" }),
    onRun: (r) => runs.push(r.status),
  });
  try {
    store.save(loop);
    const run = await engine.run(loop, { kind: "manual" });
    expect(run.laps[0]!.verdicts[0]!.v).toBe("check-error");
    expect(run.status).toBe("no-progress"); // NOT "failed" on the check-error
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
