/**
 * LoopService intake + convert wiring (loops-circuit spec §4.3/§4.4). Uses a real EnvironmentStore +
 * LoopStore over a temp dir and a fake registry; no SDK/worktree (intakeSuggest is heuristic, convert is
 * pure store work).
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { LoopService } from "../../src/session/loop-service";
import { EnvironmentStore } from "../../src/env/store";
import type { ConnectionRegistry } from "../../src/server/registry";

function harness() {
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-loopsvc-"));
  const repo = mkdtempSync(join(tmpdir(), "anvil-loopsvc-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  const envStore = new EnvironmentStore(stateDir);
  const env = envStore.add("proj", repo);
  const events: string[] = [];
  const registry = { toAll: (e: { type: string }) => events.push(e.type) } as unknown as ConnectionRegistry;
  const svc = new LoopService({
    registry,
    stateDir,
    envStore,
    worktreeRoot: () => join(stateDir, "worktrees"),
    judgeEnv: () => ({}),
    onCatalogChange: () => {},
  });
  return { svc, env, events, cleanup: () => { rmSync(stateDir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); } };
}

test("intakeSuggest is repo-aware: reads the env's test script and narrows by a keyword", () => {
  const h = harness();
  try {
    const ev = h.svc.intakeSuggest("Fix the flaky upload test", h.env.id);
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

test("intakeSuggest flags a feature (build-something-new) with a wider budget", () => {
  const h = harness();
  try {
    const ev = h.svc.intakeSuggest("Add CSV export to the reports page", h.env.id);
    expect(ev.suggestion.isFeature).toBe(true);
    expect(ev.suggestion.maxLaps).toBe(12);
    expect(ev.suggestion.tokenBudget).toBeGreaterThan(300_000);
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
