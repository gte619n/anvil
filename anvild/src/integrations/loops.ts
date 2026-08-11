/**
 * The unified "Loops" projection (loop-engineering: one surface that names every active loop so the
 * whole autonomy system is reasonable-about). Pure + SDK-free: it folds already-projected inputs — the
 * autopilot schedule, sessions carrying a `/goal`, in-flight pipelines, and pending event proposals —
 * into a flat `LoopSummary[]` the UI renders. Each row answers the four questions the article frames a
 * loop around: what triggers it, what stops it, where it is now, and (for run-until-done loops) which
 * iteration it's on.
 *
 * Kept a pure fold (inputs in, rows out) so the ordering + labelling is unit-testable and the supervisor
 * only has to gather the projections.
 */
import { GOAL_MAX_ITERATIONS, type LoopSummary } from "@protocol";

export type { LoopSummary } from "@protocol";

export interface LoopsInput {
  schedule?: {
    enabled: boolean;
    timeOfDay: string;
    running: boolean;
    autoStart: boolean;
    nextRunAt?: string;
  };
  /** Sessions with an armed `/goal`. */
  goals: {
    sessionId: string;
    title: string;
    condition: string;
    iterations: number;
    lastReason?: string;
    paused?: boolean;
  }[];
  /** Work units whose autonomous dev pipeline is currently running. */
  pipelines: { id: string; title: string; phaseReached?: string }[];
  /** Event-proposed units awaiting a human approve (the propose-don't-run queue). */
  proposals: { id: string; title: string; source: string }[];
}

/**
 * Fold the projections into ordered loop rows. Order = the schedule (the heartbeat) first, then the
 * live run-until-done loops (goals, pipelines), then the waiting event queue — most-active first so the
 * panel reads top-down from "beating now" to "waiting on a human".
 */
export function buildLoopsSnapshot(input: LoopsInput): LoopSummary[] {
  const rows: LoopSummary[] = [];

  if (input.schedule?.enabled) {
    const s = input.schedule;
    rows.push({
      kind: "schedule",
      id: "schedule",
      title: "Nightly autopilot",
      trigger: `Daily at ${s.timeOfDay}`,
      stopCondition: s.autoStart ? "Plans + auto-starts, then idle" : "Plans, holds for review",
      status: s.running ? "running" : "armed",
      ...(s.nextRunAt ? { nextFireAt: s.nextRunAt } : {}),
    });
  }

  for (const g of input.goals) {
    rows.push({
      kind: "goal",
      id: g.sessionId,
      title: g.title,
      trigger: "Every stop attempt",
      stopCondition: g.condition,
      status: g.paused ? "armed" : "running",
      iteration: { current: g.iterations, max: GOAL_MAX_ITERATIONS },
      sessionId: g.sessionId,
      ...(g.lastReason ? { detail: g.lastReason } : {}),
    });
  }

  for (const p of input.pipelines) {
    rows.push({
      kind: "pipeline",
      id: p.id,
      title: p.title,
      trigger: "Autopilot / manual start",
      stopCondition: "Ships a PR or blocks",
      status: "running",
      ...(p.phaseReached ? { detail: `Phase: ${p.phaseReached}` } : {}),
    });
  }

  for (const pr of input.proposals) {
    rows.push({
      kind: "trigger",
      id: pr.id,
      title: pr.title,
      trigger: pr.source,
      stopCondition: "Awaiting your approval",
      status: "waiting",
    });
  }

  return rows;
}
