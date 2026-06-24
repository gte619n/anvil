/**
 * The anvil autopilot's status model, expressed as namespaced Todoist labels so it never
 * collides with the user's own labels (waiting, monday, phase2, …). Exactly one `anvil:*`
 * status label is kept on a task at a time; the rest of its labels are preserved.
 *
 * Lifecycle:
 *   (none) → planned → building → review → ✓ completed
 *                  │           ↘ blocked (needs a human decision)
 *                  └→ dismissed (the user rejected the plan in the Autopilot UI; never re-planned)
 */
export const STATUS_PREFIX = "anvil:";

export const STATUSES = ["planned", "building", "review", "blocked", "dismissed"] as const;
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
