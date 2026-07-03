/**
 * Adapters that bind the pipeline's injected effect ports to the daemon's real machinery: the
 * environment's configured validation commands (P4 checks), and the existing git/gh ops (P6 PR). Kept
 * separate from the gate logic (phases.ts) and injectable so the mapping is unit-testable with fakes.
 */
import * as gitOps from "../git/ops";
import type { AnvilStatus } from "../integrations/status";
import type { PipelineAdversaryStat, PipelineTraceInfo } from "@protocol";
import type { PipelinePhase } from "../agent/model-roster";
import type { AdversaryMetrics } from "./metrics";
import type { PipelineOutcome } from "./orchestrator";
import type { ChecksFn, OpenPrFn } from "./phases";
import type { PassFail, TraceRecord } from "./trace";
import type { PipelineStatus } from "./types";

/** Runs a shell command in a directory, returning success + combined output. */
export type CmdRunner = (cmd: string, cwd: string, signal?: AbortSignal) => Promise<{ ok: boolean; output: string }>;

const shellRun: CmdRunner = async (cmd, cwd, signal) => {
  const p = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe", signal });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { ok: code === 0, output: `${out}${err}`.trim() };
};

/**
 * A ChecksFn that runs the environment's configured validation commands (e.g. ["bun run typecheck",
 * "bun test"]) in the worktree. Commands mentioning "test" map to the criteria/adversary-test buckets
 * (the GLM-generated adversarial tests run inside the same suite); the rest map to lint/types/build.
 */
export function envChecks(commands: string[], run: CmdRunner = shellRun): ChecksFn {
  return async (repoRoot, signal) => {
    const results: { cmd: string; ok: boolean }[] = [];
    for (const cmd of commands) {
      if (signal?.aborted) break;
      results.push({ cmd, ok: (await run(cmd, repoRoot, signal)).ok });
    }
    const isTest = (c: string) => /\btests?\b/i.test(c);
    const tests = results.filter((r) => isTest(r.cmd));
    const others = results.filter((r) => !isTest(r.cmd));
    const allOk = (rs: { ok: boolean }[]) => rs.every((r) => r.ok);
    const pf: PassFail = {};
    if (others.length) pf.lintTypesBuild = allOk(others) ? "pass" : "fail";
    if (tests.length) {
      pf.criteriaTests = allOk(tests) ? "pass" : "fail";
      pf.adversaryTests = pf.criteriaTests; // adversary tests live in the same suite
    }
    // No command matched either bucket → reflect the overall result so a red run still blocks.
    if (!others.length && !tests.length && results.length) pf.lintTypesBuild = allOk(results) ? "pass" : "fail";
    return pf;
  };
}

/** The subset of git/ops.ts the PR opener needs (injectable for tests). */
export interface GitPrOps {
  commit(cwd: string, message: string): { ok: boolean; output: string };
  push(cwd: string, branch: string): { ok: boolean; output: string };
  createPr(cwd: string, title: string, body: string): { ok: boolean; output: string; url?: string };
}

/**
 * An OpenPrFn that commits the worktree, pushes the branch, and opens a PR with the trace record as the
 * body. Throws on a hard failure (so P6 escalates) but tolerates an empty commit (nothing to commit).
 */
export function gitPrOpener(branch: string, ops: GitPrOps = gitOps): OpenPrFn {
  return async ({ title, body, repoRoot }) => {
    const c = ops.commit(repoRoot, title);
    if (!c.ok && !/nothing to commit/i.test(c.output)) throw new Error(`commit failed: ${c.output}`);
    const p = ops.push(repoRoot, branch);
    if (!p.ok) throw new Error(`push failed: ${p.output}`);
    const pr = ops.createPr(repoRoot, title, body);
    if (!pr.ok) throw new Error(`gh pr create failed: ${pr.output}`);
    return pr.url ?? pr.output.trim();
  };
}

/** The "operator's words" fed to intake/validation: the unit title + rationale (its original intent). */
export function workUnitTaskText(u: { title: string; rationale?: string }): string {
  return u.rationale?.trim() ? `${u.title}\n\n${u.rationale.trim()}` : u.title;
}

/** Project a stored pipeline result onto the reader's wire type (the full plan stays in AutopilotPlanInfo.plan). */
export function toPipelineTraceInfo(dp: {
  status: PipelineStatus;
  phaseReached: PipelinePhase;
  reason?: string;
  trace: TraceRecord;
}): PipelineTraceInfo {
  const t = dp.trace;
  return {
    status: dp.status,
    phaseReached: dp.phaseReached,
    ...(dp.reason ? { reason: dp.reason } : {}),
    ...(t.riskTier ? { riskTier: t.riskTier } : {}),
    criteria: t.acceptanceCriteria.map((c) => ({ id: c.id, text: c.text, kind: c.kind })),
    nonGoals: t.nonGoals,
    verification: t.verification,
    ...(t.validation.builtVsAskedNote ? { validationNote: t.validation.builtVsAskedNote } : {}),
    ...(t.prRef ? { prRef: t.prRef } : {}),
    assignments: t.modelAssignment.map((a) => ({ phase: a.phase, author: a.author, ...(a.adversary ? { adversary: a.adversary } : {}) })),
    loopbacks: Object.entries(t.loopbackCount).map(([phase, count]) => ({ phase, count: count as number })),
  };
}

/** Project the §6.3 metric into the wire stats, flagging decorative (rubber-stamp) adversaries. */
export function adversaryStats(m: AdversaryMetrics): PipelineAdversaryStat[] {
  const decorative = new Set(m.decorative().map((t) => `${t.gate}·${t.adversary}`));
  return m.all().map((t) => ({
    gate: t.gate,
    adversary: t.adversary,
    firstSubmissions: t.firstSubmissions,
    firstPassRejections: t.firstPassRejections,
    rejectionRate: t.firstSubmissions ? t.firstPassRejections / t.firstSubmissions : 0,
    decorative: decorative.has(`${t.gate}·${t.adversary}`),
  }));
}

/** Map a pipeline outcome onto the WorkUnit's status + fields the grid renders. */
export function pipelineStatusToUnit(outcome: PipelineOutcome): { status: AnvilStatus; blockedReason?: string; prUrl?: string } {
  switch (outcome.status) {
    case "shipped":
      return { status: "review", ...(outcome.trace.prRef ? { prUrl: outcome.trace.prRef } : {}) };
    case "operator_required":
      return { status: "blocked", blockedReason: `pipeline paused at ${outcome.phaseReached}: ${outcome.reason ?? "operator input required"}` };
    case "blocked":
      return { status: "blocked", blockedReason: `pipeline blocked at ${outcome.phaseReached}: ${outcome.reason ?? "could not converge autonomously"}` };
  }
}
