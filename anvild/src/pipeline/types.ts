/**
 * Core types + control-flow policy for the autonomous-dev-pipeline (spec §4, §6). The orchestrator
 * (orchestrator.ts) drives a sequence of phases, each of which returns a GateOutcome; this module
 * defines the outcomes, the loop-back caps (§6.1), the risk tiers (§6.2), and the escalation policy
 * (the operator is paged only on CRITICAL findings at P1/P5 — the "autonomous unless critical" rule).
 */
import type { PipelinePhase } from "../agent/model-roster";

export type { PipelinePhase } from "../agent/model-roster";

/** Risk tier assigned at intake (§6.2). Governs how much of the gauntlet a task pays for. */
export type RiskTier = "trivial" | "standard" | "high";

/** Terminal state of a pipeline run. */
export type PipelineStatus =
  | "shipped" // reached Transfer with a complete trace record
  | "operator_required" // paused for a human at an operator gate (P1/P5), CRITICAL finding
  | "blocked"; // could not converge autonomously (cap breach at a non-operator gate)

/**
 * What a phase reports back to the orchestrator. `pass` advances; `reject` bounces to the same phase's
 * author (adversary found fixable issues); `loopback` jumps to an earlier phase (e.g. P3 finds the plan
 * infeasible → P2; P5 finds a built-vs-asked gap → P1); `escalate` is a CRITICAL finding that a machine
 * shouldn't resolve alone.
 */
export type GateOutcome =
  | { status: "pass" }
  | { status: "reject"; reasons: string[] }
  | { status: "loopback"; to: PipelinePhase; reason: string }
  | { status: "escalate"; reason: string };

/** Loop-back caps (§6.1). Same-phase author/adversary ping-pong is bounded so a stubborn disagreement
 *  can't run up an infinite bill. Phases absent here have no same-phase cap (they don't ping-pong). */
export const LOOPBACK_CAPS: Partial<Record<PipelinePhase, number>> = {
  requirements: 3,
  design: 2,
  verification: 3,
};

/** Cross-phase loop-backs (P3→P2, P5→P1) are rarer and more expensive; bound them globally. */
export const CROSS_PHASE_LOOPBACK_CAP = 2;

/** Phases where the operator may be paged (spec §5 + the operator's "gate at 1 or 5" rule). A CRITICAL
 *  escalation or a cap breach at these phases pauses for a human; anywhere else it fails autonomously. */
export const OPERATOR_GATES: ReadonlySet<PipelinePhase> = new Set<PipelinePhase>(["requirements", "validation"]);

/** The full phase order (§4). The orchestrator prunes this per risk tier via `phasesForTier`. */
export const ALL_PHASES: readonly PipelinePhase[] = [
  "intake",
  "requirements",
  "design",
  "implementation",
  "verification",
  "validation",
  "transfer",
] as const;

/**
 * Which phases run for a tier (§6.2). Trivial skips the judgment gates entirely (straight to build +
 * verify + ship, single model, no adversary). Standard/high run the full pipeline; the high-tier
 * escalations (Claude as Implementer, operator required at Validation) are applied by the orchestrator.
 * Intake is assumed already done (it produced the tier), so it's not re-run here.
 */
export function phasesForTier(tier: RiskTier): PipelinePhase[] {
  if (tier === "trivial") return ["implementation", "verification", "transfer"];
  return ["requirements", "design", "implementation", "verification", "validation", "transfer"];
}
