/**
 * The anvil autopilot's status model, expressed as namespaced Todoist labels so it never
 * collides with the user's own labels (waiting, monday, phase2, …). Exactly one `anvil:*`
 * status label is kept on a task at a time; the rest of its labels are preserved.
 *
 * Lifecycle:
 *   (none) → planned → building → review → ✓ completed (marked done in the Autopilot UI)
 *                  │           ↘ blocked (needs a human decision)
 *                  ├→ dismissed (the user rejected the plan in the Autopilot UI; never re-planned)
 *                  └→ expired (the plan went stale / no longer relevant; marked so in the Autopilot UI)
 *
 *   needs-clarification: intake (or the planner) judged the task too underspecified to build safely.
 *     The unit is held on the grid with its open questions, never auto-started. Opening a planning
 *     session on it (see `planning`) is how a human answers those questions and un-holds it. Kept out
 *     of the candidate set so it isn't re-planned from scratch every night while it waits on a human.
 *
 *   planning: a human opened an interactive "Plan with Claude" session on the unit — Claude has the
 *     Todoist prompt, the design so far, and any open questions, and works the plan out in a real
 *     session (which can then continue straight into building). Held out of auto-start while it runs.
 */
export const STATUS_PREFIX = "anvil:";

export const STATUSES = ["planned", "needs-clarification", "planning", "building", "review", "blocked", "dismissed", "completed", "expired"] as const;
export type AnvilStatus = (typeof STATUSES)[number];

export function statusLabel(status: AnvilStatus): string {
  return `${STATUS_PREFIX}${status}`;
}

function isStatusLabel(label: string): boolean {
  return label.startsWith(STATUS_PREFIX);
}

/** The current anvil status on a task, if any. */
export function readStatus(labels: string[] = []): AnvilStatus | undefined {
  for (const l of labels) {
    if (!isStatusLabel(l)) continue;
    const s = l.slice(STATUS_PREFIX.length) as AnvilStatus;
    if ((STATUSES as readonly string[]).includes(s)) return s;
  }
  return undefined;
}

/**
 * Return the label set a task should have to be in `status`: the user's non-anvil labels,
 * untouched, plus exactly one anvil status label. Pass `undefined` to clear anvil's status.
 */
export function withStatus(labels: string[] = [], status: AnvilStatus | undefined): string[] {
  const kept = labels.filter((l) => !isStatusLabel(l));
  return status ? [...kept, statusLabel(status)] : kept;
}
