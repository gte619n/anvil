/**
 * The pipeline orchestrator (spec §4 control flow). It drives the tier-selected phases in order, each
 * returning a GateOutcome, and enforces the cross-cutting controls: loop-back caps (§6.1), risk tiering
 * (§6.2), and the escalation policy (autonomous unless a CRITICAL finding lands at an operator gate,
 * P1/P5 — the operator's "gate at 1 or 5" rule).
 *
 * Phase implementations are INJECTED (`deps.phases`), so this control flow is fully unit-testable with
 * scripted fakes before the real model-driven gates exist. Each phase records its own model assignment
 * and adversary metric; the orchestrator owns only the transitions and the counters.
 */
import type { PipelinePhase } from "../agent/model-roster";
import type { AdversaryMetrics } from "./metrics";
import type { TraceRecord } from "./trace";
import {
  CROSS_PHASE_LOOPBACK_CAP,
  LOOPBACK_CAPS,
  OPERATOR_GATES,
  phasesForTier,
  type GateOutcome,
  type PipelineStatus,
  type RiskTier,
} from "./types";

export interface PhaseContext {
  trace: TraceRecord;
  riskTier: RiskTier;
  signal?: AbortSignal;
  log: (msg: string) => void;
  metrics?: AdversaryMetrics;
  /** 1-based count of how many times this phase has executed for this task (incl. this run). */
  attempt: number;
  /** True only the first time this phase ever runs for the task — the window the §6.3 metric samples. */
  firstVisit: boolean;
}

export type PhaseRun = (ctx: PhaseContext) => Promise<GateOutcome>;

export interface PipelineDeps {
  phases: Partial<Record<PipelinePhase, PhaseRun>>;
  log?: (msg: string) => void;
  metrics?: AdversaryMetrics;
  signal?: AbortSignal;
}

export interface PipelineOutcome {
  status: PipelineStatus;
  phaseReached: PipelinePhase;
  reason?: string;
  trace: TraceRecord;
}

export async function runPipeline(trace: TraceRecord, tier: RiskTier, deps: PipelineDeps): Promise<PipelineOutcome> {
  const log = deps.log ?? (() => {});
  const order = phasesForTier(tier);
  const missing = order.filter((p) => !deps.phases[p]);
  if (missing.length) throw new Error(`pipeline is missing phase implementations: ${missing.join(", ")}`);

  const runs = new Map<PipelinePhase, number>(); // total executions (drives attempt/firstVisit)
  const rejects = new Map<PipelinePhase, number>(); // same-phase author/adversary bounces
  const loopFrom = new Map<PipelinePhase, number>(); // cross-phase loop-backs, keyed by SOURCE (drives cap)

  const bump = (m: Map<PipelinePhase, number>, p: PipelinePhase): number => {
    const n = (m.get(p) ?? 0) + 1;
    m.set(p, n);
    return n;
  };
  const noteRevisit = (p: PipelinePhase): void => {
    trace.loopbackCount[p] = (trace.loopbackCount[p] ?? 0) + 1;
  };
  // Operator gate → pause for a human; anywhere else → autonomous failure.
  const escalateOrBlock = (phase: PipelinePhase, reason: string): PipelineOutcome => ({
    status: OPERATOR_GATES.has(phase) ? "operator_required" : "blocked",
    phaseReached: phase,
    reason,
    trace,
  });

  let i = 0;
  while (i < order.length) {
    if (deps.signal?.aborted) return { status: "blocked", phaseReached: order[i]!, reason: "run aborted", trace };
    const phase = order[i]!;
    const attempt = bump(runs, phase);
    const outcome = await deps.phases[phase]!({
      trace,
      riskTier: tier,
      signal: deps.signal,
      log,
      metrics: deps.metrics,
      attempt,
      firstVisit: attempt === 1,
    });

    switch (outcome.status) {
      case "pass": {
        // High-risk tasks always pause for operator sign-off at Validation (spec §6.2), even on a clean
        // autonomous pre-check — this is the sanctioned "critical → gate at 5".
        if (phase === "validation" && tier === "high") {
          return { status: "operator_required", phaseReached: phase, reason: "high-risk task requires operator sign-off at validation", trace };
        }
        log(`✓ ${phase}`);
        i += 1;
        break;
      }
      case "reject": {
        // Same-phase ping-pong: the author revises against the adversary's findings. Cap per §6.1.
        const n = bump(rejects, phase);
        noteRevisit(phase);
        const cap = LOOPBACK_CAPS[phase] ?? Infinity;
        log(`↩ ${phase} rejected (${n}/${cap === Infinity ? "∞" : cap}): ${outcome.reasons.join("; ")}`);
        if (n > cap) return escalateOrBlock(phase, `loop-back cap exceeded at ${phase}`);
        break; // re-run the same phase (i unchanged)
      }
      case "loopback": {
        // Cross-phase rewind (e.g. P4→P3, P5→P1). Cap by the SOURCE phase's §6.1 budget (so verification's
        // 3 governs the verify→implement loop), falling back to the cross-phase default; the trace counts
        // the TARGET as revisited.
        const n = bump(loopFrom, phase);
        noteRevisit(outcome.to);
        const cap = LOOPBACK_CAPS[phase] ?? CROSS_PHASE_LOOPBACK_CAP;
        log(`⟲ ${phase} → ${outcome.to} (${n}/${cap}): ${outcome.reason}`);
        if (n > cap) return escalateOrBlock(phase, `loop-back cap exceeded at ${phase} (→ ${outcome.to})`);
        const idx = order.indexOf(outcome.to);
        if (idx === -1) return { status: "blocked", phaseReached: phase, reason: `loop-back target ${outcome.to} is not active for the ${tier} tier`, trace };
        i = idx;
        break;
      }
      case "escalate":
        log(`⚠ ${phase} escalated: ${outcome.reason}`);
        return escalateOrBlock(phase, outcome.reason);
    }
  }
  return { status: "shipped", phaseReached: order[order.length - 1]!, trace };
}
