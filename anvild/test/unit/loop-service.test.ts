/**
 * LoopService intake + convert wiring (loops-circuit spec §4.3/§4.4). Uses a real EnvironmentStore +
 * LoopStore over a temp dir and a fake registry; no SDK/worktree (intakeSuggest is heuristic, convert is
 * pure store work).
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// (writeFileSync is used by the durability test to plant a `running` run before the second boot.)
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { LoopService } from "../../src/session/loop-service";
import { EnvironmentStore } from "../../src/env/store";
import type { ConnectionRegistry } from "../../src/server/registry";

type IntakeModelFn = (
  ctx: { prompt: string; isFeature: boolean; testScript?: string; repoRoot?: string },
  opts: { onStep?: (step: { tool: string; detail: string }) => void; signal?: AbortSignal },
) => Promise<import("../../src/loops/intake-model").IntakeOverlay | undefined>;

function harness(overrides?: { intakeModel?: IntakeModelFn }) {
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-loopsvc-"));
  const repo = mkdtempSync(join(tmpdir(), "anvil-loopsvc-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  const envStore = new EnvironmentStore(stateDir);
  const env = envStore.add("proj", repo);
  const events: string[] = [];
  const progress: string[] = []; // loop.intake.progress lines (streamed analysis steps)
  const runEvents: { type: string; run?: { loopId: string; status: string } }[] = [];
  const registry = { toAll: (e: { type: string; run?: { loopId: string; status: string }; line?: string }) => { events.push(e.type); if (e.type === "loop.run") runEvents.push(e); if (e.type === "loop.intake.progress" && e.line) progress.push(e.line); } } as unknown as ConnectionRegistry;
  let autopilotCalls = 0;
  const resolveCalls: { workUnitId: string; status: string; closeTodoist: boolean }[] = [];
  const notes: { title: string; body: string; tag: string; hash?: string }[] = [];
  const svc = new LoopService({
    registry,
    stateDir,
    envStore,
    worktreeRoot: () => join(stateDir, "worktrees"),
    judgeEnv: () => ({}),
    onCatalogChange: () => {},
    autopilotRun: async () => { autopilotCalls++; return { created: 3, summary: "3 new" }; },
    resolveWorkUnit: async (workUnitId, status, closeTodoist) => { resolveCalls.push({ workUnitId, status, closeTodoist }); },
    notify: (title, body, tag, hash) => notes.push({ title, body, tag, ...(hash ? { hash } : {}) }),
    ...(overrides?.intakeModel ? { intakeModel: overrides.intakeModel } : {}),
  });
  return { svc, env, events, progress, runEvents, notes, resolveCalls, autopilotCalls: () => autopilotCalls, cleanup: () => { rmSync(stateDir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); } };
}

test("intakeSuggest is repo-aware: reads the env's test script and narrows by a keyword", async () => {
  const h = harness();
  try {
    const ev = await h.svc.intakeSuggest("Fix the flaky upload test", h.env.id);
    expect(ev.type).toBe("loop.intake.result");
    expect(ev.suggestion.isFeature).toBe(false); // "fix"/"flaky" → a fix
    expect(ev.suggestion.checkCommand).toBe("bun test upload"); // repo test script + keyword
    expect(ev.suggestion.scopeAllow).toContain("src/upload/");
    expect(ev.suggestion.maxLaps).toBe(10);
    expect(ev.suggestion.assumptions.length).toBeGreaterThanOrEqual(1);
    expect(ev.suggestion.rung).toBe("pr");
  } finally {
    h.cleanup();
  }
});

test("intakeSuggest flags a feature (build-something-new) with a wider budget", async () => {
  const h = harness();
  try {
    const ev = await h.svc.intakeSuggest("Add CSV export to the reports page", h.env.id);
    expect(ev.suggestion.isFeature).toBe(true);
    expect(ev.suggestion.maxLaps).toBe(12);
    expect(ev.suggestion.tokenBudget).toBeGreaterThan(300_000);
  } finally {
    h.cleanup();
  }
});

test("FU-1: a wired intakeModel overlays the heuristic (sharper check/scope/name)", async () => {
  const h = harness({
    intakeModel: async () => ({ name: "CSV export for reports", checkCommand: "bun test export", scopeAllow: ["src/reports/"], assumptions: ["comma delimiter, UTF-8"], rung: "draft" }),
  });
  try {
    const ev = await h.svc.intakeSuggest("Add export to the reports page", h.env.id);
    expect(ev.suggestion.name).toBe("CSV export for reports");
    expect(ev.suggestion.checkCommand).toBe("bun test export"); // model's, not the heuristic default
    expect(ev.suggestion.scopeAllow).toEqual(["src/reports/"]);
    expect(ev.suggestion.assumptions).toEqual(["comma delimiter, UTF-8"]);
    expect(ev.suggestion.rung).toBe("draft");
    // Structural fields stay heuristic-driven (the model never sets budgets).
    expect(ev.suggestion.tokenBudget).toBeGreaterThan(0);
  } finally {
    h.cleanup();
  }
});

test("FU-1: a throwing intakeModel silently falls back to the heuristic", async () => {
  const h = harness({ intakeModel: async () => { throw new Error("model unreachable"); } });
  try {
    const ev = await h.svc.intakeSuggest("Fix the flaky upload test", h.env.id);
    expect(ev.type).toBe("loop.intake.result");
    expect(ev.suggestion.checkCommand).toBe("bun test upload"); // heuristic value survives
    expect(ev.suggestion.isFeature).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("intakeSuggest gets the repo root and streams each analysis step as loop.intake.progress", async () => {
  const h = harness({
    intakeModel: async (ctx, opts) => {
      expect(ctx.repoRoot).toBe(h.env.repoRoot); // the model can actually read the checkout
      opts.onStep?.({ tool: "Read", detail: `${ctx.repoRoot}/CLAUDE.md` }); // repo-relative in the line
      opts.onStep?.({ tool: "Grep", detail: "export" });
      return { checkCommand: "bun test export" };
    },
  });
  try {
    const ev = await h.svc.intakeSuggest("Add export to reports", h.env.id, "cid-1");
    expect(ev.suggestion.checkCommand).toBe("bun test export");
    expect(h.events).toContain("loop.intake.progress");
    expect(h.progress).toEqual(["Reading CLAUDE.md", "Searching for “export”"]);
  } finally {
    h.cleanup();
  }
});

test("intakeSuggest skips the model entirely when there is no repo (heuristic only)", async () => {
  let called = false;
  const h = harness({ intakeModel: async () => { called = true; return {}; } });
  try {
    const ev = await h.svc.intakeSuggest("Fix the flaky upload test"); // no environmentId → no repo to read
    expect(called).toBe(false);
    expect(ev.suggestion.checkCommand).toBe("bun test upload"); // heuristic floor
  } finally {
    h.cleanup();
  }
});

test("loop.save honours a workUnitId (intake convert linkage); byWorkUnit finds it", () => {
  const h = harness();
  try {
    const ev = h.svc.save({
      name: "From a draft",
      environmentId: h.env.id,
      trigger: { kind: "manual" },
      act: { kind: "session-prompt", prompt: "do it" },
      checks: [],
      workUnitId: "wu42",
    });
    expect(ev.type).toBe("loop.updated");
    expect(ev.loop.workUnitId).toBe("wu42");
    // A second save of a new loop won't duplicate; the linked loop is discoverable.
    expect(h.svc.list().loops.find((l) => l.workUnitId === "wu42")).toBeTruthy();
  } finally {
    h.cleanup();
  }
});

test("the scheduler ensures a Todoist-intake singleton and fires it in its window (autopilot act)", async () => {
  const h = harness();
  try {
    h.svc.startScheduler(); // creates loop_autopilot (schedule 02:00, act autopilot)
    h.svc.stopScheduler(); // don't let the real interval fire during the test
    const auto = h.svc.list().loops.find((l) => l.id === "loop_autopilot");
    expect(auto).toBeTruthy();
    expect(auto!.act.kind).toBe("autopilot");
    // Fire the 02:00 window on an arbitrary day; the autopilot run executes and the run ships.
    h.svc.tick(new Date("2026-08-11T02:05:00.000Z"));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.autopilotCalls()).toBe(1);
    const run = h.svc.runsEvent("loop_autopilot").runs[0];
    expect(run?.status).toBe("shipped");
    expect(run?.reason).toContain("draft");
    // Edge-triggered: ticking again inside the same window (already ran) does NOT re-fire.
    h.svc.tick(new Date("2026-08-11T02:06:00.000Z"));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.autopilotCalls()).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("the daily digest fires once per day (after 09:00) when a loop opts in, and deep-links to #loops", () => {
  const h = harness();
  try {
    h.svc.startScheduler(); // the autopilot singleton opts into dailyDigest
    h.svc.stopScheduler();
    // Before 09:00 → no digest.
    h.svc.tick(new Date(2026, 7, 11, 8, 0, 0));
    expect(h.notes.some((n) => n.tag === "loops-digest")).toBe(false);
    // After 09:00 → one digest, deep-linking to #loops.
    h.svc.tick(new Date(2026, 7, 11, 9, 30, 0));
    const digest = h.notes.filter((n) => n.tag === "loops-digest");
    expect(digest.length).toBe(1);
    expect(digest[0]!.hash).toBe("#loops");
    // Same day again → no second digest.
    h.svc.tick(new Date(2026, 7, 11, 10, 0, 0));
    expect(h.notes.filter((n) => n.tag === "loops-digest").length).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("durability: a run left `running` after a crash is recovered as `interrupted` on the next boot", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-loopsvc-"));
  const repo = mkdtempSync(join(tmpdir(), "anvil-loopsvc-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const envStore = new EnvironmentStore(stateDir);
  const env = envStore.add("proj", repo);
  const registry = { toAll: () => {} } as unknown as ConnectionRegistry;
  const mk = () => new LoopService({ registry, stateDir, envStore, worktreeRoot: () => join(stateDir, "worktrees"), judgeEnv: () => ({}) });
  try {
    // First daemon: create a loop and hand-write a `running` run (simulating a crash mid-lap).
    const svc1 = mk();
    const loop = svc1.save({ name: "L", environmentId: env.id, trigger: { kind: "manual" }, act: { kind: "session-prompt", prompt: "x" }, checks: [] }).loop;
    // The store is private; write the run file directly under the loops runs dir.
    const runsDir = join(stateDir, "loops", "runs");
    const run = { id: "run_x", loopId: loop.id, configRevision: 1, trigger: { kind: "manual", at: "t" }, status: "running", laps: [{ n: 1, summary: "mid-lap", verdicts: [], at: "t" }], startedAt: "t" };
    writeFileSync(join(runsDir, `${loop.id}.jsonl`), JSON.stringify(run) + "\n");
    // Also plant an at-gate run for a PR-rung loop (its in-memory worktree is lost on restart, so it
    // must NOT stay openable — else the gate would false-ship + bank unearned autonomy credit).
    const prLoop = svc1.save({ name: "PR", environmentId: env.id, trigger: { kind: "manual" }, act: { kind: "session-prompt", prompt: "x" }, checks: [], rung: "pr" }).loop;
    const gate = { id: "run_g", loopId: prLoop.id, configRevision: 1, trigger: { kind: "manual", at: "t" }, status: "at-gate", laps: [{ n: 1, summary: "passed", verdicts: [{ check: "c", v: "pass" }], at: "t" }], startedAt: "t" };
    writeFileSync(join(runsDir, `${prLoop.id}.jsonl`), JSON.stringify(gate) + "\n");
    // Second daemon boot over the same stateDir → recovery marks the running run interrupted, never latched.
    const svc2 = mk();
    const recovered = svc2.runsEvent(loop.id).runs.find((r) => r.id === "run_x");
    expect(recovered?.status).toBe("interrupted");
    expect(recovered?.reason).toMatch(/restart/i);
    // No run remains `running`.
    expect(svc2.runsEvent(loop.id).runs.some((r) => r.status === "running")).toBe(false);
    // The stale at-gate PR run is recovered too (worktree gone → can't ship).
    expect(svc2.runsEvent(prLoop.id).runs.find((r) => r.id === "run_g")?.status).toBe("interrupted");
    // Its loop earned NO autonomy credit from the phantom gate.
    expect(svc2.list().loops.find((l) => l.id === prLoop.id)?.cleanGatedLaps).toBe(0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("save rejects a chain cycle (a chained loop that reaches itself)", () => {
  const h = harness();
  try {
    const a = h.svc.save({ name: "A", environmentId: h.env.id, trigger: { kind: "manual" }, act: { kind: "session-prompt", prompt: "x" }, checks: [] }).loop;
    // B chained on A — fine.
    const b = h.svc.save({ name: "B", environmentId: h.env.id, trigger: { kind: "chained", onLoopId: a.id, on: "success" }, act: { kind: "session-prompt", prompt: "x" }, checks: [] }).loop;
    h.svc.pause(a.id);
    // Now editing A to chain onto B would form A→B→A → rejected.
    expect(() => h.svc.save({ id: a.id, name: "A", environmentId: h.env.id, trigger: { kind: "chained", onLoopId: b.id, on: "success" }, act: { kind: "session-prompt", prompt: "x" }, checks: [] })).toThrow(/loops back|cycle|can't save/i);
  } finally {
    h.cleanup();
  }
});

test("edit-while-armed is rejected (pause to edit); configRevision bumps on save", () => {
  const h = harness();
  try {
    const created = h.svc.save({ name: "L", environmentId: h.env.id, trigger: { kind: "manual" }, act: { kind: "session-prompt", prompt: "x" }, checks: [] }).loop;
    expect(created.configRevision).toBe(1);
    h.svc.arm(created.id);
    expect(() => h.svc.save({ id: created.id, name: "L2", trigger: created.trigger, act: created.act, checks: [] })).toThrow(/pause/i);
    h.svc.pause(created.id);
    const edited = h.svc.save({ id: created.id, name: "L2", trigger: created.trigger, act: created.act, checks: [] }).loop;
    expect(edited.configRevision).toBe(2);
    expect(edited.name).toBe("L2");
  } finally {
    h.cleanup();
  }
});

test("complete: sets `completed`, resolves the linked work unit, and passes the closeTodoist choice through", async () => {
  const h = harness();
  try {
    const loop = h.svc.save({ name: "Fix upload", environmentId: h.env.id, trigger: { kind: "manual" }, act: { kind: "session-prompt", prompt: "x" }, checks: [], workUnitId: "wu7" }).loop;
    const ev = await h.svc.complete(loop.id, true);
    expect(ev.loop.status).toBe("completed");
    expect(h.svc.list().loops.find((l) => l.id === loop.id)?.status).toBe("completed");
    expect(h.resolveCalls).toEqual([{ workUnitId: "wu7", status: "completed", closeTodoist: true }]);
  } finally {
    h.cleanup();
  }
});

test("complete: a loop with no linked work unit skips the Todoist resolve entirely", async () => {
  const h = harness();
  try {
    const loop = h.svc.save({ name: "Standalone", environmentId: h.env.id, trigger: { kind: "manual" }, act: { kind: "session-prompt", prompt: "x" }, checks: [] }).loop;
    const ev = await h.svc.complete(loop.id, true);
    expect(ev.loop.status).toBe("completed");
    expect(h.resolveCalls).toEqual([]);
  } finally {
    h.cleanup();
  }
});

test("archive retires a loop to `archived` (no Todoist side effects); restore re-pauses it", () => {
  const h = harness();
  try {
    const loop = h.svc.save({ name: "Old", environmentId: h.env.id, trigger: { kind: "manual" }, act: { kind: "session-prompt", prompt: "x" }, checks: [] }).loop;
    expect(h.svc.archive(loop.id).loop.status).toBe("archived");
    expect(h.resolveCalls).toEqual([]);
    // "Restore" is a plain pause back to an editable, inactive loop.
    expect(h.svc.pause(loop.id).loop.status).toBe("paused");
  } finally {
    h.cleanup();
  }
});

test("the daemon-managed Todoist-intake singleton can't be completed or archived", async () => {
  const h = harness();
  try {
    h.svc.startScheduler(); // ensures the loop_autopilot singleton exists
    h.svc.stopScheduler();
    expect(() => h.svc.archive("loop_autopilot")).toThrow(/can't be archived/i);
    await expect(h.svc.complete("loop_autopilot", false)).rejects.toThrow(/can't be completed/i);
  } finally {
    h.cleanup();
  }
});
