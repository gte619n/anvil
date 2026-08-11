/**
 * Loop check runners (loops-circuit spec §4.2). Maker–checker separated: `judge` checks run through an
 * injected judge (judgeGoal in a separate spawn, never the acting session); `command` checks execute in
 * the run's worktree. `metric`/`http` are Phase 5. Pure combination logic (`combineVerdicts`) lives here
 * too so the pass/fail rule per `checksMode` is unit-testable.
 *
 * A check that throws or times out yields `check-error` (spec §7): it counts toward no-progress but does
 * NOT fail the loop on its own — a dead judge never blocks a run forever.
 */
import { checkLabel } from "./contract";
import type { LapCheckResult, LapVerdict, LoopCheck } from "@protocol";

export interface CheckContext {
  /** A separate-spawn judge (maker–checker); returns met + reason. */
  judge: (condition: string, transcript: string) => Promise<{ met: boolean; reason?: string }>;
  /** Run a command in the worktree; returns exit code + combined output. */
  runCommand: (command: string, cwd: string) => Promise<{ exit: number; output: string }>;
  /** The acting lap's recent transcript (fed to judge checks). */
  transcript: string;
  /** The run's worktree. */
  cwd: string;
}

/** Run one check and render its verdict. Never throws — failure surfaces as `check-error`. */
export async function runCheck(check: LoopCheck, ctx: CheckContext): Promise<LapCheckResult> {
  const label = checkLabel(check);
  try {
    switch (check.kind) {
      case "judge": {
        const v = await ctx.judge(check.condition, ctx.transcript);
        return v.met ? { check: label, v: "pass" } : { check: label, v: "fail", ...(v.reason ? { detail: v.reason } : {}) };
      }
      case "command": {
        const { exit, output } = await ctx.runCommand(check.command, ctx.cwd);
        const want = check.expectExit ?? 0;
        return exit === want
          ? { check: label, v: "pass" }
          : { check: label, v: "fail", detail: `exit ${exit} (wanted ${want})${output ? `: ${lastLine(output)}` : ""}` };
      }
      case "metric":
      case "http":
        return { check: label, v: "check-error", detail: `${check.kind} checks arrive in Phase 5` };
    }
  } catch (e) {
    return { check: label, v: "check-error", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Run every check (in parallel) and render the per-check verdict rows. */
export async function runChecks(checks: LoopCheck[], ctx: CheckContext): Promise<LapCheckResult[]> {
  return Promise.all(checks.map((c) => runCheck(c, ctx)));
}

export interface CombinedVerdict {
  /** The lap-level outcome once scope has already passed: did the checks pass the gate? */
  passed: boolean;
  /** A single verdict word for the lap (mirrors the worst per-check verdict when not passed). */
  verdict: LapVerdict;
}

/**
 * Combine per-check verdicts per `checksMode`.
 * - `all`: passes only if every check is `pass`.
 * - `any`: passes if at least one check is `pass`.
 * A run with zero checks never passes (it always parks at the gate for a human) — enforced by the caller
 * treating an empty `checks` as "not passed".
 */
export function combineVerdicts(results: LapCheckResult[], mode: "all" | "any"): CombinedVerdict {
  if (results.length === 0) return { passed: false, verdict: "fail" };
  const passes = results.filter((r) => r.v === "pass").length;
  const passed = mode === "all" ? passes === results.length : passes >= 1;
  if (passed) return { passed: true, verdict: "pass" };
  // Not passed: surface the most informative non-pass verdict (fail beats check-error for the lap word).
  const hasFail = results.some((r) => r.v === "fail");
  return { passed: false, verdict: hasFail ? "fail" : "check-error" };
}

function lastLine(s: string): string {
  const lines = s.trim().split("\n");
  return lines[lines.length - 1] ?? "";
}
