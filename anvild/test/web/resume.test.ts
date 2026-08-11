import { test, expect } from "bun:test";
import { canDeltaResume } from "../../web/src/resume";

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
