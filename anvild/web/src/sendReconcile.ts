// ── Optimistic-send reconciliation (incremental-offline-resilience.md Phase 4 / spec A6) ──────────
// Exactly-once in the UI: every send carries a stable `cid`. When the authoritative `message.user`
// echoes back (live broadcast or delta re-attach), we match it to any optimistic bubble by cid and
// retire it — and if an authoritative bubble with that cid is ALREADY on screen, the echo is a true
// duplicate and must be dropped. Extracted from main.ts so the DOM matching is unit-testable.

export type ReconcileResult = "new" | "duplicate";

/**
 * Reconcile an incoming authoritative user message with `cid` against what's on screen:
 *  - removes the matching optimistic (`.queued`) bubble if present (normal offline→online reconcile);
 *  - returns "duplicate" if a non-optimistic bubble with this cid already exists (drop the echo);
 *  - returns "new" otherwise (the caller renders it, tagging the bubble with the cid).
 */
export function reconcileOptimistic(conversation: Element, cid: string): ReconcileResult {
  conversation.querySelector(`.bubble.user.queued[data-cid="${cid}"]`)?.remove();
  if (conversation.querySelector(`.bubble.user:not(.queued)[data-cid="${cid}"]`)) return "duplicate";
  return "new";
}

/** Whether `text` is a command the daemon handles itself and echoes NO `message.user` (`/clear`,
 *  `/compact[ …]`, `/goal[ …]`). Mirrors the server's prompt() branches — an offline optimistic bubble
 *  for one of these would never be retired (no echo), so the caller must skip it. */
export function isDaemonHandledCommand(text: string): boolean {
  const t = text.trim();
  return t === "/clear" || t === "/compact" || t.startsWith("/compact ") || t === "/goal" || t.startsWith("/goal ");
}
