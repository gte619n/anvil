import { test, expect } from "bun:test";
import { canDeltaResume, shouldRelightStatus, type RelightInputs } from "../../web/src/resume";

// The cross-reload win (spec A1/A3): with a matching epoch and a fresh-enough server, we delta-resume.
test("delta-resumes when the epoch matches and the server is at or ahead of our cache", () => {
  expect(canDeltaResume({ epoch: "ep1", lastSeq: 10 }, "ep1", 10)).toBe(true); // equal → empty delta, fine
  expect(canDeltaResume({ epoch: "ep1", lastSeq: 42 }, "ep1", 10)).toBe(true); // server ahead → real delta
});

// The safety guard (spec A2): a changed epoch means the log lineage reset — must take a full snapshot.
test("falls back to a snapshot when the epoch differs (lineage reset)", () => {
  expect(canDeltaResume({ epoch: "ep2", lastSeq: 99 }, "ep1", 10)).toBe(false);
});

test("falls back to a snapshot with no watermark, no cached epoch, or no cached seq", () => {
  expect(canDeltaResume(undefined, "ep1", 10)).toBe(false); // server never reported a watermark
  expect(canDeltaResume({ epoch: "ep1", lastSeq: 10 }, "", 10)).toBe(false); // nothing cached (first ever load)
  expect(canDeltaResume({ epoch: "ep1", lastSeq: 10 }, "ep1", 0)).toBe(false); // seq 0 → no cached content
});

// Defensive: if our cache is somehow AHEAD of the server (shouldn't happen under append-only), snapshot.
test("falls back to a snapshot when the client's cached seq is ahead of the server", () => {
  expect(canDeltaResume({ epoch: "ep1", lastSeq: 5 }, "ep1", 10)).toBe(false);
});

// ── shouldRelightStatus (spec D6): re-assert live status on reconnect without waiting for the attach ──
const base: RelightInputs = { status: "thinking", isActive: true, onScreen: true, turnCanceled: false, paneStatus: "idle" };

// The core Android-resume fix: an authoritative status that differs from the frozen pane repaints it now.
test("relights when the active on-screen session's status changed", () => {
  expect(shouldRelightStatus(base)).toBe(true); // idle pane, session now thinking → relight
  expect(shouldRelightStatus({ ...base, status: "idle", paneStatus: "thinking" })).toBe(true); // stale spinner → settle
});

// Guards: don't touch the indicator when there's nothing to change or it isn't ours to change.
test("does NOT relight when unchanged, inactive, off-screen, canceled, or status-less", () => {
  expect(shouldRelightStatus({ ...base, status: "idle", paneStatus: "idle" })).toBe(false); // no change → no churn
  expect(shouldRelightStatus({ ...base, isActive: false })).toBe(false); // not the open session
  expect(shouldRelightStatus({ ...base, onScreen: false })).toBe(false); // fresh load owns its own re-establish
  expect(shouldRelightStatus({ ...base, turnCanceled: true })).toBe(false); // a local Stop is still draining
  expect(shouldRelightStatus({ ...base, status: undefined })).toBe(false); // frame carried no status
});

// A first relight against a never-set pane (paneStatus null) still fires as long as a status is present.
test("relights against a not-yet-painted pane (paneStatus null)", () => {
  expect(shouldRelightStatus({ ...base, paneStatus: null })).toBe(true);
  expect(shouldRelightStatus({ ...base, status: undefined, paneStatus: null })).toBe(false);
});
