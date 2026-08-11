/**
 * The unified "Loops" projection (loop-engineering: one surface that names every active loop so the
 * whole autonomy system is reasonable-about). Pure + SDK-free: it folds already-projected inputs — the
 * autopilot schedule, sessions carrying a `/goal`, in-flight pipelines, pending event proposals, and
 * work-unit drafts awaiting a human — into a flat `LoopSummary[]` the UI renders. Each row answers the
 * four questions the article frames a loop around: what triggers it, what stops it, where it is now, and
 * (for run-until-done loops) which iteration/lap it's on. It also carries the circuit-display fields
 * (`act`/`rung`/`runnerAt`/`scope`) so the Loops home can draw every row as the same circuit.
 *
 * Kept a pure fold (inputs in, rows out) so the ordering + labelling + circuit mapping is unit-testable
 * and the supervisor only has to gather the projections.
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
    environmentId?: string;
    environmentName?: string;
  }[];
  /** Work units whose autonomous dev pipeline is currently running. */
  pipelines: { id: string; title: string; phaseReached?: string; environmentId?: string; environmentName?: string }[];
  /** Event-proposed units awaiting a human approve (the propose-don't-run queue). */
  proposals: { id: string; title: string; source: string; environmentId?: string; environmentName?: string }[];
  /** Work-unit drafts a human owns next: planned/needs-clarification units not yet built (Loops home's
   *  "drafts at your gate" section — the row opens the plan reader / converts to a real Loop in Phase 2). */
  drafts?: { id: string; title: string; status: string; source?: string; environmentId?: string; environmentName?: string }[];
}

const envFields = (o: { environmentId?: string; environmentName?: string }): { environmentId?: string; environmentName?: string } => ({
  ...(o.environmentId ? { environmentId: o.environmentId } : {}),
  ...(o.environmentName ? { environmentName: o.environmentName } : {}),
});

/**
 * Fold the projections into ordered loop rows. Order = the schedule (the heartbeat) first, then the
 * live run-until-done loops (goals, pipelines), then the waiting event queue + drafts — most-active
 * first so the home reads top-down from "beating now" to "waiting on a human".
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
      act: "Re-plan linked projects into drafts",
      stopCondition: s.autoStart ? "Plans + auto-starts, then idle" : "Plans, holds for review",
      status: s.running ? "running" : "armed",
      rung: "suggest",
      ...(s.running ? { runnerAt: "act" as const } : {}),
      ...(s.nextRunAt ? { nextFireAt: s.nextRunAt } : {}),
    });
  }

  for (const g of input.goals) {
    rows.push({
      kind: "goal",
      id: g.sessionId,
      title: g.title,
      trigger: "Every stop attempt",
      act: "Drive the session toward the goal",
      stopCondition: g.condition,
      status: g.paused ? "paused" : "running",
      // The runner laps Act ⇄ Check: a live goal sits at Check (it just tried and is being judged).
      ...(g.paused ? {} : { runnerAt: "check" as const }),
      rung: "pr",
      iteration: { current: g.iterations, max: GOAL_MAX_ITERATIONS },
      sessionId: g.sessionId,
      ...(g.lastReason ? { detail: g.lastReason } : {}),
      ...envFields(g),
    });
  }

  for (const p of input.pipelines) {
    rows.push({
      kind: "pipeline",
      id: p.id,
      title: p.title,
      trigger: "Autopilot / manual start",
      act: p.phaseReached ? `Pipeline: ${p.phaseReached}` : "Autonomous dev pipeline",
      stopCondition: "Ships a PR or blocks",
      status: "running",
      runnerAt: "act",
      rung: "pr",
      ...(p.phaseReached ? { detail: `Phase: ${p.phaseReached}` } : {}),
      ...envFields(p),
    });
  }

  for (const pr of input.proposals) {
    rows.push({
      kind: "trigger",
      id: pr.id,
      title: pr.title,
      trigger: pr.source,
      act: "Approve to plan & build",
      stopCondition: "Awaiting your approval",
      status: "gated",
      runnerAt: "gate",
      rung: "suggest",
      ...envFields(pr),
    });
  }

  for (const d of input.drafts ?? []) {
    rows.push({
      kind: "draft",
      id: d.id,
      title: d.title,
      trigger: d.source ?? "Draft",
      act: d.status === "needs-clarification" ? "Answer the open questions" : "Review & convert to a loop",
      stopCondition: "Waiting at your gate",
      status: "gated",
      runnerAt: "gate",
      rung: "suggest",
      ...envFields(d),
    });
  }

  return rows;
}
