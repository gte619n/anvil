/**
 * [P1] Completion-verification pure logic (spec Phase 1): parseVerdict, selectVerifiableUnits,
 * combineSignals, and the isLikelyComplete / hasOverlay predicates. No I/O, no model — these encode the
 * §4.3 table and the overlay-visibility rules the grid, the auto-start gate, and the web badge all share.
 */
import { test, expect } from "bun:test";
import type { WorkUnit, WorkUnitVerification } from "../../src/integrations/workunit";
import {
  parseVerdict,
  selectVerifiableUnits,
  combineSignals,
  isLikelyComplete,
  hasOverlay,
} from "../../src/integrations/autopilot-plans";

const wu = (o: Partial<WorkUnit>): WorkUnit =>
  ({
    id: "u1",
    environmentId: "e1",
    todoistProjectId: "p1",
    taskIds: ["t1"],
    title: "Do the thing",
    status: "planned",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as WorkUnit;

const ver = (o: Partial<WorkUnitVerification> = {}): WorkUnitVerification => ({
  verdict: "done",
  evidence: "",
  raw: "{}",
  baseRef: "origin/main",
  baseSha: "sha1",
  at: "2026-01-01T00:00:00Z",
  ...o,
});

const NO_LIVE = new Set<string>();

// ── parseVerdict ────────────────────────────────────────────────────────────────────────────────
test("[P1] parseVerdict: all tasks done-with-citation → unit verdict done; carries raw + confidence", () => {
  const raw = JSON.stringify({
    tasks: [
      { taskId: "t1", verdict: "done", cite: "src/a.ts:10", note: "added fn" },
      { taskId: "t2", verdict: "done", cite: "src/b.ts:20" },
    ],
    confidence: 0.9,
  });
  const p = parseVerdict(raw, ["t1", "t2"]);
  expect(p.verdict).toBe("done");
  expect(p.perTask.map((t) => t.verdict)).toEqual(["done", "done"]);
  expect(p.perTask.every((t) => t.cited)).toBe(true);
  expect(p.confidence).toBe(0.9);
  expect(p.raw).toBe(raw);
});

test("[P1] parseVerdict: a 'done' with NO citation does not count — path-less done → not-done", () => {
  const raw = JSON.stringify({ tasks: [{ taskId: "t1", verdict: "done" }] });
  const p = parseVerdict(raw, ["t1"]);
  expect(p.perTask[0]!.cited).toBe(false);
  expect(p.perTask[0]!.verdict).toBe("not-done");
  expect(p.verdict).toBe("not-done");
});

test("[P1] parseVerdict: some-but-not-all done → partial", () => {
  const raw = JSON.stringify({
    tasks: [
      { taskId: "t1", verdict: "done", cite: "a.ts:1" },
      { taskId: "t2", verdict: "not-done" },
    ],
  });
  expect(parseVerdict(raw, ["t1", "t2"]).verdict).toBe("partial");
});

test("[P1] parseVerdict: a task the model OMITTED reads as not-done (judged against expected ids)", () => {
  const raw = JSON.stringify({ tasks: [{ taskId: "t1", verdict: "done", cite: "a.ts:1" }] });
  const p = parseVerdict(raw, ["t1", "t2"]);
  expect(p.verdict).toBe("partial"); // t2 missing → not-done → not all done
  expect(p.perTask.find((t) => t.taskId === "t2")!.verdict).toBe("not-done");
});

test("[P1] parseVerdict: malformed / non-JSON output never throws — fails open to not-done, keeps raw", () => {
  const garbage = "the model rambled and emitted no json at all";
  const p = parseVerdict(garbage, ["t1"]);
  expect(p.verdict).toBe("not-done");
  expect(p.raw).toBe(garbage);
  expect(p.confidence).toBeUndefined();
});

test("[P1] parseVerdict prose fallback: narrated verdict stays not-done but RECOVERS cited paths; never infers done", () => {
  // The model narrated a (correct) not-done with real citations but didn't emit the JSON contract.
  const prose = "**Verdict: not-done** — no implementation exists. Checked `src/foo/Bar.java:42` and `web/x.ts:10`; neither wires it up.";
  const p = parseVerdict(prose, ["t1"]);
  expect(p.verdict).toBe("not-done");
  expect(p.perTask[0]!.note).toContain("src/foo/Bar.java:42");
  // Even if the prose claims "done", with no structured JSON we must NOT infer done (anti-over-report).
  const proseDone = "Verdict: done — fully implemented in `src/foo.ts:1`.";
  expect(parseVerdict(proseDone, ["t1"]).verdict).toBe("not-done");
});

// ── selectVerifiableUnits ───────────────────────────────────────────────────────────────────────
const baseShas = new Map([["e1", "sha1"]]);

test("[P1] selectVerifiableUnits: checks the whole actionable backlog (planned + blocked + needs-clarification), skips the rest", () => {
  const units = [
    wu({ id: "a", status: "planned" }),
    wu({ id: "b", status: "blocked" }),
    wu({ id: "c", status: "review" }), // on a branch, not base → excluded
    wu({ id: "d", status: "needs-clarification" }), // owner override: now checked (could already be built)
    wu({ id: "e", status: "building" }), // live → excluded
    wu({ id: "f", status: "completed" }), // terminal → excluded
    wu({ id: "g", status: "proposed" }), // pre-approval → excluded
  ];
  expect(selectVerifiableUnits(units, baseShas, NO_LIVE).map((u) => u.id).sort()).toEqual(["a", "b", "d"]);
});

test("[P1] selectVerifiableUnits: staleness — no verdict → eligible; same baseSha → skip; moved baseSha → eligible", () => {
  const noVerdict = wu({ id: "a" });
  const current = wu({ id: "b", verification: ver({ baseSha: "sha1" }) });
  const stale = wu({ id: "c", verification: ver({ baseSha: "OLD" }) });
  const picked = selectVerifiableUnits([noVerdict, current, stale], baseShas, NO_LIVE).map((u) => u.id);
  expect(picked.sort()).toEqual(["a", "c"]);
});

test("[P1] selectVerifiableUnits: a dismissed done-overlay is skipped while current, re-picked once baseSha moves", () => {
  const dismissedCurrent = wu({ id: "a", verification: ver({ baseSha: "sha1", dismissedAt: "2026-01-02T00:00:00Z" }) });
  expect(selectVerifiableUnits([dismissedCurrent], baseShas, NO_LIVE)).toEqual([]);
  const moved = new Map([["e1", "sha2"]]);
  expect(selectVerifiableUnits([dismissedCurrent], moved, NO_LIVE).map((u) => u.id)).toEqual(["a"]);
});

test("[P1] selectVerifiableUnits: keptAsWork, live sessions, taskless units, and unknown-base envs are skipped", () => {
  const kept = wu({ id: "a", verification: ver({ verdict: "not-done", baseSha: "OLD", keptAsWork: "mistake" }) });
  const live = wu({ id: "b", sessionId: "s1" });
  const taskless = wu({ id: "c", taskIds: [] });
  const unknownEnv = wu({ id: "d", environmentId: "eX" });
  const picked = selectVerifiableUnits([kept, live, taskless, unknownEnv], baseShas, new Set(["s1"]));
  expect(picked).toEqual([]);
});

// ── combineSignals (the §4.3 table) ───────────────────────────────────────────────────────────
test("[P1] combineSignals: closed-seen + done → auto-complete", () => {
  expect(combineSignals("done", true)).toEqual({ autoComplete: true, mismatch: false, overlay: false });
});
test("[P1] combineSignals: closed-seen + not-done → mismatch (never auto-complete, never reopen)", () => {
  expect(combineSignals("not-done", true)).toEqual({ autoComplete: false, mismatch: true, overlay: true });
});
test("[P1] combineSignals: closed-seen + partial → mismatch (code can't confirm it's fully done)", () => {
  expect(combineSignals("partial", true)).toEqual({ autoComplete: false, mismatch: true, overlay: true });
});
test("[P1] combineSignals: open + done → overlay (Likely complete); open + partial/not-done → nothing", () => {
  expect(combineSignals("done", false)).toEqual({ autoComplete: false, mismatch: false, overlay: true });
  expect(combineSignals("partial", false)).toEqual({ autoComplete: false, mismatch: false, overlay: false });
  expect(combineSignals("not-done", false)).toEqual({ autoComplete: false, mismatch: false, overlay: false });
});

// ── isLikelyComplete / hasOverlay predicates ──────────────────────────────────────────────────
test("[P1] isLikelyComplete: done + planned + not dismissed/kept/live", () => {
  expect(isLikelyComplete(wu({ verification: ver({ verdict: "done" }) }), NO_LIVE)).toBe(true);
  expect(isLikelyComplete(wu({ status: "blocked", verification: ver({ verdict: "done" }) }), NO_LIVE)).toBe(true);
});

test("[P1] isLikelyComplete: false when dismissed, kept-as-work, live, non-verifiable status, or not done", () => {
  expect(isLikelyComplete(wu({ verification: ver({ dismissedAt: "x" }) }), NO_LIVE)).toBe(false);
  expect(isLikelyComplete(wu({ verification: ver({ keptAsWork: "x" }) }), NO_LIVE)).toBe(false);
  expect(isLikelyComplete(wu({ sessionId: "s1", verification: ver() }), new Set(["s1"]))).toBe(false);
  expect(isLikelyComplete(wu({ status: "review", verification: ver() }), NO_LIVE)).toBe(false);
  expect(isLikelyComplete(wu({ verification: ver({ verdict: "partial" }) }), NO_LIVE)).toBe(false);
  expect(isLikelyComplete(wu({}), NO_LIVE)).toBe(false); // no verification at all
});

test("[P1] hasOverlay = likely-complete ∨ mismatch — a mismatch on an off-grid blocked unit still shows", () => {
  const likely = wu({ verification: ver({ verdict: "done" }) });
  const mismatch = wu({ status: "blocked", verification: ver({ verdict: "not-done", mismatch: true }) });
  const kept = wu({ verification: ver({ verdict: "not-done", mismatch: true, keptAsWork: "x" }) });
  const none = wu({ verification: ver({ verdict: "not-done" }) });
  expect(hasOverlay(likely, NO_LIVE)).toBe(true);
  expect(hasOverlay(mismatch, NO_LIVE)).toBe(true);
  expect(hasOverlay(kept, NO_LIVE)).toBe(false); // resolved via Keep-as-work → no longer surfaced
  expect(hasOverlay(none, NO_LIVE)).toBe(false); // not-done with no mismatch → nothing to show
});
