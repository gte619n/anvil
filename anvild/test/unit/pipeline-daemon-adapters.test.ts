import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envChecks, gitPrOpener, workUnitTaskText, pipelineStatusToUnit, toPipelineTraceInfo, adversaryStats, type CmdRunner, type GitPrOps } from "../../src/pipeline/daemon-adapters";
import { recordAssignment } from "../../src/pipeline/trace";
import { loadMetrics, saveMetrics } from "../../src/pipeline/metrics-store";
import { AdversaryMetrics } from "../../src/pipeline/metrics";
import { newTrace } from "../../src/pipeline/trace";
import type { PipelineOutcome } from "../../src/pipeline/orchestrator";

// ── envChecks: maps the environment's validation commands onto the PassFail buckets ──

function fakeRunner(fails: Set<string> = new Set()): CmdRunner {
  return async (cmd) => ({ ok: !fails.has(cmd), output: fails.has(cmd) ? "boom" : "ok" });
}

test("envChecks buckets test vs non-test commands and reports pass when all green", async () => {
  const checks = envChecks(["bun run typecheck", "bun test"], fakeRunner());
  const pf = await checks("/repo");
  expect(pf.lintTypesBuild).toBe("pass");
  expect(pf.criteriaTests).toBe("pass");
  expect(pf.adversaryTests).toBe("pass"); // adversary tests ride the same suite
});

test("envChecks marks the failing bucket, leaving the other green", async () => {
  const pf = await envChecks(["bun run typecheck", "bun test"], fakeRunner(new Set(["bun test"])))("/repo");
  expect(pf.lintTypesBuild).toBe("pass");
  expect(pf.criteriaTests).toBe("fail");
});

test("envChecks with no test command leaves criteriaTests unset (verification treats it as green)", async () => {
  const pf = await envChecks(["bun run typecheck"], fakeRunner())("/repo");
  expect(pf.lintTypesBuild).toBe("pass");
  expect(pf.criteriaTests).toBeUndefined();
});

// ── gitPrOpener: commit → push → createPr, tolerant of an empty commit, throws on hard failure ──

function fakeGit(over: Partial<GitPrOps> = {}): { ops: GitPrOps; calls: string[] } {
  const calls: string[] = [];
  const ops: GitPrOps = {
    commit: (_c, m) => (calls.push(`commit:${m}`), { ok: true, output: "committed" }),
    push: (_c, b) => (calls.push(`push:${b}`), { ok: true, output: "pushed" }),
    createPr: (_c, t) => (calls.push(`pr:${t}`), { ok: true, output: "created", url: "https://gh/pr/1" }),
    ...over,
  };
  return { ops, calls };
}

test("gitPrOpener commits, pushes, and opens the PR, returning the URL", async () => {
  const g = fakeGit();
  const url = await gitPrOpener("my-branch", g.ops)({ title: "T", body: "B", repoRoot: "/wt" });
  expect(url).toBe("https://gh/pr/1");
  expect(g.calls).toEqual(["commit:T", "push:my-branch", "pr:T"]);
});

test("gitPrOpener tolerates an empty commit but throws when push fails", async () => {
  const empty = fakeGit({ commit: () => ({ ok: false, output: "nothing to commit, working tree clean" }) });
  await expect(gitPrOpener("b", empty.ops)({ title: "T", body: "B", repoRoot: "/wt" })).resolves.toBe("https://gh/pr/1");
  const noPush = fakeGit({ push: () => ({ ok: false, output: "rejected" }) });
  await expect(gitPrOpener("b", noPush.ops)({ title: "T", body: "B", repoRoot: "/wt" })).rejects.toThrow(/push failed/);
});

// ── outcome → WorkUnit status mapping ──

test("pipelineStatusToUnit maps shipped→review (+PR url), operator/blocked→blocked (+reason)", () => {
  const trace = newTrace("wu", "task");
  trace.prRef = "https://gh/pr/9";
  const shipped: PipelineOutcome = { status: "shipped", phaseReached: "transfer", trace };
  expect(pipelineStatusToUnit(shipped)).toEqual({ status: "review", prUrl: "https://gh/pr/9" });

  const paused: PipelineOutcome = { status: "operator_required", phaseReached: "requirements", reason: "ambiguous need", trace };
  expect(pipelineStatusToUnit(paused)).toMatchObject({ status: "blocked" });
  expect(pipelineStatusToUnit(paused).blockedReason).toContain("requirements");

  const blocked: PipelineOutcome = { status: "blocked", phaseReached: "verification", trace };
  expect(pipelineStatusToUnit(blocked).blockedReason).toContain("verification");
});

test("workUnitTaskText joins title + rationale as the operator's words", () => {
  expect(workUnitTaskText({ title: "Add retry", rationale: "uploads flake" })).toBe("Add retry\n\nuploads flake");
  expect(workUnitTaskText({ title: "Add retry" })).toBe("Add retry");
});

// ── wire projections for the UI (trace card + calibration table) ──

test("toPipelineTraceInfo projects the trace onto the reader's wire shape", () => {
  const trace = newTrace("wu", "task");
  trace.riskTier = "standard";
  trace.acceptanceCriteria = [{ id: "AC1", text: "retries on 5xx", kind: "automatable" }];
  trace.nonGoals = ["no auth change"];
  trace.verification = { criteriaTests: "pass", lintTypesBuild: "pass" };
  trace.validation.builtVsAskedNote = "matches";
  trace.prRef = "https://gh/pr/3";
  trace.loopbackCount = { requirements: 2 };
  recordAssignment(trace, { phase: "requirements", author: "GLM 5.2", adversary: "Claude Opus 4.8" });

  const info = toPipelineTraceInfo({ status: "shipped", phaseReached: "transfer", trace });
  expect(info.status).toBe("shipped");
  expect(info.riskTier).toBe("standard");
  expect(info.criteria).toEqual([{ id: "AC1", text: "retries on 5xx", kind: "automatable" }]);
  expect(info.prRef).toBe("https://gh/pr/3");
  expect(info.validationNote).toBe("matches");
  expect(info.assignments).toEqual([{ phase: "requirements", author: "GLM 5.2", adversary: "Claude Opus 4.8" }]);
  expect(info.loopbacks).toEqual([{ phase: "requirements", count: 2 }]);
});

test("adversaryStats computes rejection rate and flags rubber-stampers", () => {
  const m = new AdversaryMetrics();
  for (let i = 0; i < 20; i++) m.recordFirstPass("design", "glm", false); // never rejects
  for (let i = 0; i < 10; i++) m.recordFirstPass("requirements", "claude", i < 4); // 40%
  const stats = adversaryStats(m);
  const glm = stats.find((s) => s.gate === "design")!;
  const claude = stats.find((s) => s.gate === "requirements")!;
  expect(glm.rejectionRate).toBe(0);
  expect(glm.decorative).toBe(true);
  expect(claude.rejectionRate).toBeCloseTo(0.4, 5);
  expect(claude.decorative).toBe(false);
});

// ── metrics persistence ──

test("metrics survive a save/load round-trip through the state dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-pm-"));
  try {
    const m = new AdversaryMetrics();
    m.recordFirstPass("requirements", "claude", true);
    m.recordFirstPass("design", "glm", false);
    saveMetrics(dir, m);
    const back = loadMetrics(dir);
    expect(back.rejectionRate("requirements", "claude")).toBe(1);
    expect(back.rejectionRate("design", "glm")).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadMetrics returns an empty tracker when the file is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-pm2-"));
  try {
    expect(loadMetrics(dir).all()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
