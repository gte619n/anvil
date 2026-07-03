/**
 * The single entry point for the autonomous-dev-pipeline: intake (P0) → the tier-selected gauntlet
 * (P1–P6). Intake runs first because it produces the risk tier that selects which phases run; a
 * non-`well-formed` task is routed to the operator rather than guessed at (spec §4 P0).
 */
import { newTrace } from "./trace";
import { runIntake, buildPhases, type PhaseDeps } from "./phases";
import { runPipeline, type PipelineOutcome } from "./orchestrator";
import type { AdversaryMetrics } from "./metrics";

export async function runDevPipeline(
  deps: PhaseDeps,
  opts: { metrics?: AdversaryMetrics; log?: (msg: string) => void; signal?: AbortSignal } = {},
): Promise<PipelineOutcome> {
  const log = opts.log ?? (() => {});
  const trace = newTrace(deps.task.id, deps.task.text);

  const intake = await runIntake(deps, opts.signal);
  trace.riskTier = intake.riskTier;
  log(`P0 intake: ${intake.classification} · ${intake.riskTier} — ${intake.reason}`);
  if (!intake.proceed) {
    // Ambiguous or out-of-scope intent is the P0/P1-class case: page the operator, don't guess.
    return { status: "operator_required", phaseReached: "intake", reason: `${intake.classification}: ${intake.reason}`, trace };
  }

  return runPipeline(trace, intake.riskTier, {
    phases: buildPhases(deps),
    metrics: opts.metrics,
    log,
    signal: opts.signal,
  });
}
