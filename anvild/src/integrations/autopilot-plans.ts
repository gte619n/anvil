/**
 * [Phase 3 / BE-7] Pure autopilot plan selection + presentation, extracted from Supervisor.
 *
 * These are the decision/shape functions behind the Autopilot card grid and a build session's
 * opening brief — no I/O, no state, so they're independently unit-testable. The Supervisor keeps the
 * orchestration (it owns sessions, stores, Todoist, push) and calls these for the grid + brief.
 */
import type { AutopilotPlanInfo } from "@protocol";
import type { WorkUnit, WorkUnitVerification } from "./workunit";
import type { MarkdownRenderer } from "../render/markdown";
import { toPipelineTraceInfo } from "../pipeline/daemon-adapters";

/** Pending plans = what the Autopilot card grid shows. `liveIds` lets a unit carrying a verification
 *  overlay (likely-complete or mismatch) surface even when its base status wouldn't otherwise render it
 *  (spec §4.1/R2-S8) — e.g. a `blocked` unit with no devPipeline. */
export function selectPendingPlans(units: WorkUnit[], liveIds: ReadonlySet<string> = new Set()): WorkUnit[] {
  return units.filter(
    (u) =>
      // Event-proposed units awaiting a human approve (propose-don't-run) live on the grid with a badge.
      (u.status === "proposed" && !u.sessionId) ||
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
      (u.devPipeline !== undefined && (u.status === "review" || u.status === "blocked")) ||
      // A verification overlay (likely-complete badge or mismatch warning) must always be visible, even
      // on a unit whose base status wouldn't otherwise render it (R2-S8).
      hasOverlay(u, liveIds),
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
  const verification = toVerificationInfo(u.verification, renderer);
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
    ...(u.hold ? { hold: u.hold } : {}),
    // Strip the server-only dedupeKey — the card only needs kind/source/at.
    ...(u.trigger ? { trigger: { kind: u.trigger.kind, source: u.trigger.source, at: u.trigger.at } } : {}),
    ...(u.goalCondition ? { goalCondition: u.goalCondition } : {}),
    ...(verification ? { verification } : {}),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

// ── Completion verification (completion-verification spec §4.3/§4.4) — pure, SDK-free, unit-tested ──
// These are the decision/shape functions behind the "Likely complete" overlay. No I/O, no model: the
// Supervisor runs the (plan-mode) verifier and persists; these judge eligibility, fold the signals, and
// decide visibility. Kept here beside the existing selectors so the grid, the auto-start gate, and the
// web badge all key on ONE source of truth. Extracted from json.ts's extractJson (tolerant parse).
import { extractJson } from "./json";

/** A unit-level completion verdict. `partial` = some-but-not-all tasks look done (advisory only). */
export type Verdict = "done" | "partial" | "not-done";

/** Statuses whose work could already be built out-of-band, so they're worth checking: the whole actionable
 *  backlog — `planned`, `blocked`, AND `needs-clarification` (owner override of the original §4.3, which
 *  excluded it: an underspecified unit can perfectly well already be implemented, and catching that is
 *  worth more than preserving its open questions — a not-done verdict leaves it untouched anyway).
 *  Still excluded, for cause: `review`/open-PR (work is on a branch, NOT the base ref we read, so it would
 *  always read not-done), `planning`/`building`/live (owned by a running session), `proposed` (pre-approval),
 *  and the terminal states (`completed`/`dismissed`/`expired`). */
export const VERIFIABLE_STATUSES: ReadonlySet<WorkUnit["status"]> = new Set(["planned", "blocked", "needs-clarification"]);

/** The parsed completion verdict: per-task judgments + the derived unit verdict, carrying the raw model
 *  output for debugging (spec §4.7). `confidence` is DISPLAY ONLY and never gates control flow (R2-T3). */
export interface ParsedVerdict {
  verdict: Verdict;
  perTask: { taskId: string; verdict: "done" | "not-done"; cited: boolean; note?: string }[];
  confidence?: number;
  raw: string;
}

/**
 * Normalize the verifier model's (tolerant) JSON into a typed verdict, judged against the unit's EXPECTED
 * task ids so an omitted task reads as not-done rather than silently vanishing. A per-task `done` only
 * counts when the model also gave a `file:line` citation — "done" with no evidence is treated as not-done
 * (the whole point is grounded verification). Unit verdict: `done` iff every task is done-with-citation,
 * `partial` if some are, else `not-done`. Never throws — malformed/empty output degrades to `not-done`
 * (fail-open discipline mirrors parseIntakeVerdict), carrying `raw` for forensics.
 */
export function parseVerdict(raw: string, taskIds: string[]): ParsedVerdict {
  let parsed: { tasks?: unknown; confidence?: unknown } | undefined;
  try {
    parsed = extractJson<{ tasks?: unknown; confidence?: unknown }>(raw);
  } catch {
    parsed = undefined; // no/garbled JSON → prose fallback below
  }
  // Prose fallback (hardening): the model sometimes narrates its verdict instead of emitting the JSON
  // contract. We NEVER infer `done` from prose (a done demands the structured, cited JSON — that strict
  // contract is what keeps the verifier from over-reporting), but we DO recover any `path:line` citations
  // the prose mentioned so the evidence isn't generic. Verdict stays the safe `not-done`.
  if (!Array.isArray(parsed?.tasks)) {
    const cites = [...raw.matchAll(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+)/g)].map((m) => m[1]!);
    const note = cites.length
      ? `model narrated without the JSON contract; cited ${[...new Set(cites)].slice(0, 3).join(", ")}`
      : "model returned no structured verdict";
    const perTask = taskIds.map((taskId) => ({ taskId, verdict: "not-done" as const, cited: false, note }));
    return { verdict: "not-done", perTask, raw };
  }
  const entries = Array.isArray(parsed?.tasks) ? (parsed.tasks as Record<string, unknown>[]) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const e of entries) if (e && typeof e.taskId === "string") byId.set(e.taskId, e);
  const perTask = taskIds.map((taskId) => {
    const e = byId.get(taskId);
    const cite = typeof e?.cite === "string" ? (e.cite as string).trim() : "";
    const cited = cite.length > 0 || e?.cited === true;
    // A citation is REQUIRED for a `done` to stand (path-less "done" is exactly the hallucination we guard).
    const verdict: "done" | "not-done" = e?.verdict === "done" && cited ? "done" : "not-done";
    const modelNote = typeof e?.note === "string" ? (e.note as string).trim() : "";
    const note = [cite, modelNote].filter(Boolean).join(" — ") || undefined;
    return { taskId, verdict, cited, ...(note ? { note } : {}) };
  });
  const doneCount = perTask.filter((t) => t.verdict === "done").length;
  const verdict: Verdict = taskIds.length > 0 && doneCount === taskIds.length ? "done" : doneCount > 0 ? "partial" : "not-done";
  const confidence = typeof parsed?.confidence === "number" ? (parsed.confidence as number) : undefined;
  return { verdict, perTask, ...(confidence !== undefined ? { confidence } : {}), raw };
}

/** True when a unit's live session (if any) is currently running — it owns its own lifecycle, so the
 *  verifier leaves it alone. `liveIds` is threaded in by the caller (there's no `isLive` field). */
function isLiveUnit(u: Pick<WorkUnit, "sessionId">, liveIds: ReadonlySet<string>): boolean {
  return !!u.sessionId && liveIds.has(u.sessionId);
}

/**
 * Which units a verification sweep should (re-)judge. Eligible = a verifiable status (`planned`/`blocked`),
 * no live build session, not `keptAsWork` (the human already said "this is still work, leave it"), and
 * STALE — either never verified, or verified at a base SHA that has since moved (OD4: `origin/<base>`
 * advancing is the real "the code changed" signal; there's no wall-clock timer). A unit whose environment
 * couldn't be resolved to a current base SHA (`baseShaByEnv` has no entry) is skipped — staleness is
 * undecidable, and the verifier has nothing to read against. A dismissed done-overlay is naturally skipped
 * while its SHA is current (it isn't stale) and re-judged once the base moves — "suppress until stale".
 */
export function selectVerifiableUnits(
  units: WorkUnit[],
  baseShaByEnv: ReadonlyMap<string, string>,
  liveIds: ReadonlySet<string>,
): WorkUnit[] {
  return units.filter((u) => {
    if (!VERIFIABLE_STATUSES.has(u.status)) return false;
    if (isLiveUnit(u, liveIds)) return false;
    if (u.verification?.keptAsWork) return false;
    if (u.taskIds.length === 0) return false; // nothing concrete to verify (event-triggered draft)
    const cur = baseShaByEnv.get(u.environmentId);
    if (cur === undefined) return false; // base SHA unknown → can't decide staleness or read against it
    return !u.verification || u.verification.baseSha !== cur;
  });
}

/** Fold the two independent signals — the Todoist "closed" observation and the code verdict — into the
 *  action a sweep should take (spec §4.3 table). `closedSeen` is the STICKY `todoistClosedSeen`, computed
 *  by the caller, so an aged-out completion doesn't flip a unit back to "open". Dismiss-suppression of a
 *  `done` overlay is a DISPLAY concern handled by `hasOverlay`, not here (a fresh verdict clears a stale
 *  dismiss), so `overlay` here is the raw "there is something to surface" bit. */
export function combineSignals(verdict: Verdict, closedSeen: boolean): { autoComplete: boolean; mismatch: boolean; overlay: boolean } {
  if (closedSeen) {
    // Human checked it off. Code-`done` → auto-complete (NG1: needs BOTH closed-seen AND code-done).
    // Anything short of done (partial or not-done) → hold as a mismatch for the human (NG3), never reopen.
    if (verdict === "done") return { autoComplete: true, mismatch: false, overlay: false };
    return { autoComplete: false, mismatch: true, overlay: true };
  }
  // Not checked off. Code-`done` → "Likely complete" overlay (Confirm/Dismiss). Partial/not-done → no
  // status change (partial is advisory per-task; not-done just refreshes at/baseSha).
  return { autoComplete: false, mismatch: false, overlay: verdict === "done" };
}

/** Whether a unit should show the "Likely complete" badge (a confirmable done-overlay): a `done` verdict,
 *  not dismissed, not kept-as-work, in a verifiable status, and not live. The one predicate the badge,
 *  the Confirm action, and the (soft) build-anyway confirm all key on. */
export function isLikelyComplete(u: WorkUnit, liveIds: ReadonlySet<string>): boolean {
  const v = u.verification;
  return (
    v?.verdict === "done" &&
    !v.dismissedAt &&
    !v.keptAsWork &&
    !v.mismatch &&
    VERIFIABLE_STATUSES.has(u.status) &&
    !isLiveUnit(u, liveIds)
  );
}

/** Whether a unit carries ANY verification overlay the grid must render — a likely-complete badge OR a
 *  mismatch warning. The grid and web badge key on THIS (not `isLikelyComplete` alone) so a mismatch unit
 *  whose base status wouldn't otherwise render is still shown (R2-S8 / R3-#4). A `keptAsWork` mismatch is
 *  resolved and no longer shown. */
export function hasOverlay(u: WorkUnit, liveIds: ReadonlySet<string>): boolean {
  if (isLikelyComplete(u, liveIds)) return true;
  const v = u.verification;
  return !!v?.mismatch && !v.keptAsWork && !isLiveUnit(u, liveIds);
}

/** Shape a unit's verification overlay for the wire (null when there's nothing to surface). Renders the
 *  evidence markdown for the reader. Shared by toPlanInfo so the grid and reader agree. */
export function toVerificationInfo(
  v: WorkUnitVerification | undefined,
  renderer: Pick<MarkdownRenderer, "render">,
): AutopilotPlanInfo["verification"] | undefined {
  if (!v) return undefined;
  return {
    verdict: v.verdict,
    evidence: renderer.render(v.evidence),
    ...(v.perTask ? { perTask: v.perTask } : {}),
    ...(v.confidence !== undefined ? { confidence: v.confidence } : {}),
    ...(v.mismatch ? { mismatch: v.mismatch } : {}),
    ...(v.dismissedAt ? { dismissedAt: v.dismissedAt } : {}),
    ...(v.keptAsWork ? { keptAsWork: v.keptAsWork } : {}),
    baseRef: v.baseRef,
    baseSha: v.baseSha,
    at: v.at,
  };
}

/**
 * The stop-condition seeded onto a plan's build session as a `/goal` (loop-engineering: run-until-done).
 * A build session with a goal self-verifies — the Stop hook won't let it go idle until a judge agrees the
 * plan is actually implemented and the checks pass, instead of stopping the moment the model *claims* it's
 * done. Returns undefined for a unit with no plan (a bare title isn't a checkable goal). Pure + testable.
 */
export function buildAutopilotGoal(u: WorkUnit): string | undefined {
  if (!u.plan?.trim()) return undefined;
  return `the plan for “${u.title}” is fully implemented in this worktree and the project's build and tests pass`;
}

/** The opening brief handed to a plan's build session: the rationale + plan, framed as a build task.
 *  Structured markdown (headings + bullets) — this renders as the session's opening message. */
export function buildAutopilotBrief(u: WorkUnit): string {
  const parts: string[] = [`You are implementing the autopilot work unit “${u.title}”.`];
  if (u.rationale) parts.push(`## Why\n\n${u.rationale}`);
  if (u.plan) parts.push(`## The plan\n\n${u.plan}`);
  parts.push(["## Your job", "", "- Implement it end to end in this worktree.", "- Then summarize what you changed."].join("\n"));
  return parts.join("\n\n");
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
  const parts: string[] = [`You are planning the autopilot work unit “${u.title}” with the user, in this worktree.`];
  if (u.rationale) parts.push(`## Why\n\n${u.rationale}`);
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
