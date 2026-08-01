// ── Incremental resume decision (incremental-offline-resilience.md §5, spec A3) ───────────────────
// Pure logic extracted from main.ts so the delta-vs-snapshot rule is unit-testable without the DOM or
// a live socket. Given the server's resume watermark for a session and what the client has cached, it
// answers one question: can we pull ONLY new events (seq > lastSeq), or must we take a full snapshot?

export interface Watermark {
  epoch: string;
  lastSeq: number;
}

/**
 * True iff the cached transcript is still current and can be delta-resumed:
 *   - we hold a watermark for the session (the server reported it on connect), AND
 *   - our cached epoch matches it (same log lineage — nothing was reset/rebuilt), AND
 *   - we actually cached something (cachedSeq > 0), AND
 *   - the server has at least as many events as we cached (never fewer — a guard; equal is fine, it
 *     just means the delta is empty and only the trailing status re-asserts).
 * Because the durable log is append-only and never pruned (spec D7), an epoch match guarantees
 * `since(cachedSeq)` returns every event we're missing — so this is sufficient, not just necessary.
 */
export function canDeltaResume(wm: Watermark | undefined, cachedEpoch: string, cachedSeq: number): boolean {
  return !!wm && !!cachedEpoch && wm.epoch === cachedEpoch && cachedSeq > 0 && wm.lastSeq >= cachedSeq;
}
