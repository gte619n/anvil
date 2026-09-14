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

// ── Status re-assert on reconnect (spec D6) ──────────────────────────────────────────────────────
// session.list / session.updated carry each session's live status and drive the sidebar, but never
// drove the conversation pane's thinking indicator — so on an Android resume the pane sat on its
// frozen pre-drop state until the attach round-trip's trailing `status` landed 10–25s later. This is
// the pure predicate main's relightActiveStatus uses to repaint the indicator from those authoritative
// frames, without waiting for the attach.

export interface RelightInputs {
  /** The authoritative status just reported for the session (undefined if the frame omitted it). */
  status: string | undefined;
  /** Whether that session is the one currently open in the pane. */
  isActive: boolean;
  /** Whether the pane already has content on screen (a fresh load owns its own status re-establish). */
  onScreen: boolean;
  /** Whether a local Stop is still draining — relighting a stale "thinking" then would be wrong. */
  turnCanceled: boolean;
  /** The status the pane's indicator already reflects (null before any is applied). */
  paneStatus: string | null;
}

/**
 * True iff an authoritative session status should be re-asserted onto the pane's indicator now:
 *   - the frame actually carried a status, AND
 *   - it's the active, on-screen session (a fresh load re-establishes its own status), AND
 *   - no local cancel is still draining (which would otherwise re-light a stale "thinking"), AND
 *   - it differs from what the pane already shows (so repeated session.updated frames don't churn).
 */
export function shouldRelightStatus(i: RelightInputs): boolean {
  return !!i.status && i.isActive && i.onScreen && !i.turnCanceled && i.status !== i.paneStatus;
}
