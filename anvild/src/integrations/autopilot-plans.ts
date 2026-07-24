/**
 * [Phase 3 / BE-7] Pure autopilot plan selection + presentation, extracted from Supervisor.
 *
 * These are the decision/shape functions behind the Autopilot card grid and a build session's
 * opening brief — no I/O, no state, so they're independently unit-testable. The Supervisor keeps the
 * orchestration (it owns sessions, stores, Todoist, push) and calls these for the grid + brief.
 */
import type { AutopilotPlanInfo } from "@protocol";
import type { WorkUnit } from "./workunit";
import type { MarkdownRenderer } from "../render/markdown";
import { toPipelineTraceInfo } from "../pipeline/daemon-adapters";

/** Pending plans = what the Autopilot card grid shows. */
export function selectPendingPlans(units: WorkUnit[]): WorkUnit[] {
  return units.filter(
    (u) =>
      (u.status === "planned" && !u.sessionId) ||
      // Held-for-clarification units live on the grid too, so the reviewer can read the open questions
      // and answer them (by opening a planning session, which promotes the unit back to `planned`) or dismiss.
      (u.status === "needs-clarification" && !u.sessionId) ||
      // A unit with a live planning session ("Plan with Claude") stays on the grid — its card shows a
      // jump-link into that session — until the session saves the settled plan or it's built/dismissed.
      u.status === "planning" ||
      // Keep pipeline-completed units on the grid so their trace + PR stay reviewable until the
      // operator resolves them. Only pipeline-run units gain this visibility — a normal
      // planned→built unit has no devPipeline.
      (u.devPipeline !== undefined && (u.status === "review" || u.status === "blocked")),
  );
}

/**
 * Statuses a work unit can be auto-completed FROM when its source task is checked off in Todoist.
 * These are the non-terminal, awaiting-a-human states — the ones still riding on the open Todoist
 * task. A unit that's already completed/expired/dismissed is terminal, and one that's actively
 * `building` is mid-flight (its live session is handled separately), so neither is reconciled here.
 */
export const RECONCILABLE_STATUSES: ReadonlySet<WorkUnit["status"]> = new Set([
  "planned",
  "needs-clarification",
  "blocked",
  "review",
]);

/**
 * Inbound completion sync: which work units should flip to `completed` because the human checked off
 * their source task(s) in Todoist. A unit qualifies when it's in a reconcilable status, has no live
 * build session (`isLive`), and EVERY one of its member tasks is in `completedTaskIds` (the set Todoist
 * reports closed). Requiring all tasks avoids closing a multi-task unit while some of its work is still
 * open. Pure — the caller persists the status change + broadcasts.
 */
export function selectCompletedUnits(
  units: WorkUnit[],
  completedTaskIds: ReadonlySet<string>,
  isLive: (u: WorkUnit) => boolean,
): WorkUnit[] {
  return units.filter(
    (u) =>
      RECONCILABLE_STATUSES.has(u.status) &&
      !isLive(u) &&
      u.taskIds.length > 0 &&
      u.taskIds.every((id) => completedTaskIds.has(id)),
  );
}

/** Shape a WorkUnit for the card grid + reader (env name + the rendered plan markdown). */
export function toPlanInfo(u: WorkUnit, environmentName: string | undefined, renderer: Pick<MarkdownRenderer, "render">): AutopilotPlanInfo {
  return {
    id: u.id,
    environmentId: u.environmentId,
    ...(environmentName ? { environmentName } : {}),
    todoistProjectId: u.todoistProjectId,
    title: u.title,
    ...(u.rationale ? { rationale: u.rationale } : {}),
    ...(u.summary ? { summary: u.summary } : {}),
    status: u.status,
    ...(u.source ? { source: u.source } : {}),
    ...(u.effort ? { effort: u.effort } : {}),
    ...(u.sessionId ? { sessionId: u.sessionId } : {}),
    taskCount: u.taskIds.length,
    ...(u.plan ? { plan: renderer.render(u.plan) } : {}),
    ...(u.devPipeline ? { pipeline: toPipelineTraceInfo(u.devPipeline) } : {}),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

/** The opening brief handed to a plan's build session: the rationale + plan, framed as a build task. */
export function buildAutopilotBrief(u: WorkUnit): string {
  const head = `You are implementing the autopilot work unit “${u.title}”.${u.rationale ? `\n\n${u.rationale}` : ""}`;
  const body = u.plan ? `\n\nHere is the plan to implement:\n\n${u.plan}` : "";
  return `${head}${body}\n\nImplement it end to end in this worktree, then summarize what you changed.`;
}

/**
 * The opening brief handed to an interactive "Plan with Claude" planning session (replaces the old
 * refine chat). Unlike a build brief, this hands over the FULL context — the live Todoist prompt, the
 * design worked out so far, and any open questions the planner held on — and asks the session to settle
 * the plan WITH the user before writing code. A held unit's `plan` field is its open questions, so it's
 * framed as questions to answer; otherwise it's the design so far. `todoistPrompt` is best-effort: an
 * empty string (Todoist unreachable) just drops that section, the plan still carries the intent.
 */
export function buildPlanningBrief(u: WorkUnit, todoistPrompt: string): string {
  const held = u.status === "needs-clarification";
  const parts: string[] = [
    `You are planning the autopilot work unit “${u.title}” with the user, in this worktree.${u.rationale ? `\n\n${u.rationale}` : ""}`,
  ];
  if (todoistPrompt.trim()) {
    parts.push(`## The original request (from Todoist)\n\n${todoistPrompt.trim()}`);
  }
  if (u.plan?.trim()) {
    parts.push(held ? `## Open questions to resolve first\n\n${u.plan.trim()}` : `## The design worked out so far\n\n${u.plan.trim()}`);
  }
  parts.push(
    [
      "## How to work",
      held
        ? "- This unit was held because it's underspecified. Start by asking the user the open questions above (use AskUserQuestion) — do not guess. Explore the repo read-only to inform the questions."
        : "- Review the design against the request and the actual repo. Raise anything unclear or risky with the user before building (use AskUserQuestion) — do not silently diverge from the request.",
      "- Once you and the user agree on the plan, call the `save_plan` tool (with `ready: true`) to store the settled plan back on the work unit. This un-holds the card so it's buildable, and posts the plan to Todoist.",
      "- Then, when the user is ready, either implement it here yourself, or call the `run_pipeline` tool to hand the settled plan to the autonomous review→development→testing pipeline (it builds in a fresh worktree and opens a PR).",
    ].join("\n"),
  );
  return parts.join("\n\n");
}
