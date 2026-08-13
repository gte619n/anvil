import { test, expect } from "bun:test";
import { completeLoop, defaultTokenBudget, checkLocks, chainCycleReason, chainedTargets, eventTargets, promotionSuggestion, shipUnlocked, mergeMethodFor, mergeRequiresGreen, singleNumberCommand, PROMOTION_THRESHOLD, SESSION_TOKEN_BUDGET, PIPELINE_TOKEN_BUDGET, DEFAULT_MAX_LAPS, DEFAULT_NO_PROGRESS_LAPS } from "../../src/loops/contract";
import type { Loop, LoopInput } from "../../protocol";

const opts = { now: "2026-08-11T00:00:00.000Z", genId: () => "loop_1" };
const base: LoopInput = {
  name: "Fix flaky test",
  trigger: { kind: "manual" },
  act: { kind: "session-prompt", prompt: "fix it" },
  checks: [{ kind: "command", command: "bun test" }],
};

test("defaults: checksMode all, rung pr, maxLaps 10, noProgressLaps 2, session token budget", () => {
  const { loop, warnings } = completeLoop(base, opts);
  expect(loop.checksMode).toBe("all");
  expect(loop.rung).toBe("pr");
  expect(loop.hardStops.maxLaps).toBe(DEFAULT_MAX_LAPS);
  expect(loop.hardStops.noProgressLaps).toBe(DEFAULT_NO_PROGRESS_LAPS);
  expect(loop.hardStops.tokenBudget).toBe(SESSION_TOKEN_BUDGET);
  expect(loop.status).toBe("draft");
  expect(loop.configRevision).toBe(1);
  expect(warnings).toEqual([]);
});

test("token budget is ALWAYS present (mandatory-budget guarantee) and defaults by act body", () => {
  expect(defaultTokenBudget({ kind: "session-prompt", prompt: "x" })).toBe(SESSION_TOKEN_BUDGET);
  expect(defaultTokenBudget({ kind: "skill-check", command: "x" })).toBe(SESSION_TOKEN_BUDGET);
  expect(defaultTokenBudget({ kind: "pipeline" })).toBe(PIPELINE_TOKEN_BUDGET);
  const pipe = completeLoop({ ...base, act: { kind: "pipeline" } }, opts);
  expect(pipe.loop.hardStops.tokenBudget).toBe(PIPELINE_TOKEN_BUDGET);
});

test("act: autopilot is rejected on user loops, allowed for the singleton", () => {
  expect(() => completeLoop({ ...base, act: { kind: "autopilot" } }, opts)).toThrow(/reserved/);
  const ok = completeLoop({ ...base, act: { kind: "autopilot" } }, { ...opts, allowAutopilotAct: true });
  expect(ok.loop.act.kind).toBe("autopilot");
});

test("zero checks and 'any' mode warn (not reject)", () => {
  const noChecks = completeLoop({ ...base, checks: [] }, opts);
  expect(noChecks.warnings[0]).toMatch(/no checks/i);
  const anyMode = completeLoop({ ...base, checks: [{ kind: "command", command: "a" }, { kind: "command", command: "b" }], checksMode: "any" }, opts);
  expect(anyMode.warnings.some((w) => /any/i.test(w))).toBe(true);
});

test("fatal validations: blank name, missing prompt/command", () => {
  expect(() => completeLoop({ ...base, name: "  " }, opts)).toThrow(/name/);
  expect(() => completeLoop({ ...base, act: { kind: "session-prompt", prompt: "" } }, opts)).toThrow(/prompt/);
  expect(() => completeLoop({ ...base, act: { kind: "skill-check", command: "" } }, opts)).toThrow(/command/);
});

test("update path preserves createdAt/cleanGatedLaps/workUnitId and bumps configRevision", () => {
  const first = completeLoop(base, opts).loop;
  const existing = { ...first, cleanGatedLaps: 3, workUnitId: "wu9", configRevision: 4, createdAt: "2026-01-01T00:00:00.000Z" };
  const { loop } = completeLoop({ ...base, id: first.id, name: "Renamed" }, { now: "2026-08-12T00:00:00.000Z", genId: () => "nope", existing });
  expect(loop.id).toBe(first.id);
  expect(loop.name).toBe("Renamed");
  expect(loop.cleanGatedLaps).toBe(3);
  expect(loop.workUnitId).toBe("wu9");
  expect(loop.configRevision).toBe(5); // bumped
  expect(loop.createdAt).toBe("2026-01-01T00:00:00.000Z");
  expect(loop.updatedAt).toBe("2026-08-12T00:00:00.000Z");
});

test("chainCycleReason: detects a self-loop and a longer cycle; passes an acyclic chain", () => {
  const mk = (id: string, onLoopId?: string): Loop => ({
    id, name: id, status: "armed",
    trigger: onLoopId ? { kind: "chained", onLoopId, on: "success" } : { kind: "manual" },
    act: { kind: "session-prompt", prompt: "x" }, checks: [], checksMode: "all", rung: "pr",
    hardStops: { maxLaps: 10, tokenBudget: 300_000, noProgressLaps: 2 }, assumptions: [],
    notify: { onGate: true, onFailure: true, onSuccess: false, dailyDigest: false },
    cleanGatedLaps: 0, configRevision: 1, createdAt: "t", updatedAt: "t",
  });
  // A → B → C, and we try to save A chained onto C (A→B→C→A would cycle).
  const b = mk("B", "C");
  const c = mk("C", "A"); // C already chains to A
  const loops = [b, c];
  expect(chainCycleReason(loops, { id: "A", trigger: { kind: "chained", onLoopId: "C", on: "any" } })).toMatch(/loops back/);
  // Self-loop.
  expect(chainCycleReason([], { id: "A", trigger: { kind: "chained", onLoopId: "A", on: "any" } })).toMatch(/loops back/);
  // Acyclic: A → B (B is manual) is fine.
  expect(chainCycleReason([mk("B")], { id: "A", trigger: { kind: "chained", onLoopId: "B", on: "any" } })).toBeNull();
  // A non-chained trigger is never a cycle.
  expect(chainCycleReason([], { id: "A", trigger: { kind: "manual" } })).toBeNull();
});

test("chainedTargets fires only armed chained loops matching the parent + outcome", () => {
  const mk = (id: string, onLoopId: string, on: "success" | "failure" | "any", status: Loop["status"] = "armed"): Loop => ({
    id, name: id, status, trigger: { kind: "chained", onLoopId, on },
    act: { kind: "session-prompt", prompt: "x" }, checks: [], checksMode: "all", rung: "pr",
    hardStops: { maxLaps: 10, tokenBudget: 300_000, noProgressLaps: 2 }, assumptions: [],
    notify: { onGate: true, onFailure: true, onSuccess: false, dailyDigest: false },
    cleanGatedLaps: 0, configRevision: 1, createdAt: "t", updatedAt: "t",
  });
  const loops = [
    mk("onSuccess", "P", "success"),
    mk("onFailure", "P", "failure"),
    mk("onAny", "P", "any"),
    mk("otherParent", "Q", "any"),
    mk("paused", "P", "any", "paused"),
  ];
  // Parent P shipped (success): onSuccess + onAny fire; onFailure/otherParent/paused don't.
  expect(chainedTargets(loops, "P", "shipped").map((l) => l.id).sort()).toEqual(["onAny", "onSuccess"]);
  // Parent P failed: onFailure + onAny fire.
  expect(chainedTargets(loops, "P", "no-progress").map((l) => l.id).sort()).toEqual(["onAny", "onFailure"]);
});

test("eventTargets selects only armed event loops subscribed to the kind", () => {
  const mk = (id: string, kind: "event" | "manual", eventKind?: string, status: Loop["status"] = "armed"): Loop => ({
    id, name: id, status,
    trigger: kind === "event" ? { kind: "event", eventKind: eventKind as never } : { kind: "manual" },
    act: { kind: "session-prompt", prompt: "x" }, checks: [], checksMode: "all", rung: "pr",
    hardStops: { maxLaps: 10, tokenBudget: 300_000, noProgressLaps: 2 }, assumptions: [],
    notify: { onGate: true, onFailure: true, onSuccess: false, dailyDigest: false },
    cleanGatedLaps: 0, configRevision: 1, createdAt: "t", updatedAt: "t",
  });
  const loops = [mk("ci", "event", "ci-failure"), mk("gh", "event", "github"), mk("ciPaused", "event", "ci-failure", "paused"), mk("man", "manual")];
  expect(eventTargets(loops, "ci-failure").map((l) => l.id)).toEqual(["ci"]);
  expect(eventTargets(loops, "github").map((l) => l.id)).toEqual(["gh"]);
});

test("earned autonomy: promotionSuggestion appears only after 3 clean gated laps, and never past Ship", () => {
  expect(promotionSuggestion({ rung: "pr", cleanGatedLaps: 2 })).toBeNull(); // not earned yet
  expect(promotionSuggestion({ rung: "pr", cleanGatedLaps: PROMOTION_THRESHOLD })).toBe("ship"); // earned → suggest Ship
  expect(promotionSuggestion({ rung: "suggest", cleanGatedLaps: 5 })).toBe("draft");
  expect(promotionSuggestion({ rung: "ship", cleanGatedLaps: 9 })).toBeNull(); // already at the top
  expect(shipUnlocked({ rung: "pr", cleanGatedLaps: 2 })).toBe(false);
  expect(shipUnlocked({ rung: "pr", cleanGatedLaps: 3 })).toBe(true);
});

test("the Ship rung must be earned — completeLoop rejects it below the threshold, allows it once earned", () => {
  expect(() => completeLoop({ ...base, rung: "ship" }, opts)).toThrow(/earned/i);
  const earned = { ...completeLoop(base, opts).loop, rung: "pr" as const, cleanGatedLaps: 3 };
  const promoted = completeLoop({ ...base, id: earned.id, rung: "ship" }, { ...opts, existing: earned });
  expect(promoted.loop.rung).toBe("ship");
});

test("checkLocks is the union of every check's locks", () => {
  expect(checkLocks([{ kind: "command", command: "a", locks: ["x", "y"] }, { kind: "command", command: "b", locks: ["y", "z"] }])).toEqual(["x", "y", "z"]);
  expect(checkLocks([{ kind: "judge", condition: "c" }])).toEqual([]);
});

// ── FU-3: configurable Ship merge ────────────────────────────────────────────────────────────────────
test("mergeMethodFor defaults to squash (historical behaviour) and honours a valid method", () => {
  expect(mergeMethodFor({})).toBe("squash");
  expect(mergeMethodFor({ merge: { method: "merge" } })).toBe("merge");
  expect(mergeMethodFor({ merge: { method: "rebase" } })).toBe("rebase");
  // A bogus method falls back to squash rather than passing garbage to `gh pr merge`.
  expect(mergeMethodFor({ merge: { method: "bogus" as "squash" } })).toBe("squash");
});

test("mergeRequiresGreen is opt-in (false unless explicitly set)", () => {
  expect(mergeRequiresGreen({})).toBe(false);
  expect(mergeRequiresGreen({ merge: { method: "squash" } })).toBe(false);
  expect(mergeRequiresGreen({ merge: { method: "squash", requireGreen: true } })).toBe(true);
});

test("completeLoop carries a valid merge config and drops an invalid one; update preserves it", () => {
  const withMerge = completeLoop({ ...base, merge: { method: "rebase", requireGreen: true } }, opts).loop;
  expect(withMerge.merge).toEqual({ method: "rebase", requireGreen: true });
  const noMerge = completeLoop({ ...base, merge: { method: "nope" as "squash" } }, opts).loop;
  expect(noMerge.merge).toBeUndefined();
  // An update that omits merge keeps the existing one (edit a paused ship loop without re-stating merge).
  const kept = completeLoop({ ...base, name: "renamed" }, { ...opts, existing: withMerge }).loop;
  expect(kept.merge).toEqual({ method: "rebase", requireGreen: true });
});

test("singleNumberCommand narrows a metric command to its last line (idempotent)", () => {
  expect(singleNumberCommand("wc -l < f")).toBe("wc -l < f | tail -1");
  expect(singleNumberCommand("bun test | grep -c pass | tail -1")).toBe("bun test | grep -c pass | tail -1"); // already piped to tail
  expect(singleNumberCommand("42")).toBe("42"); // already a bare number
  expect(singleNumberCommand("")).toBe("");
});

test("completeLoop normalizes a metric check's command to a single number line (D-029)", () => {
  const { loop } = completeLoop({ ...base, checks: [{ kind: "metric", command: "wc -l < out", op: "lte", threshold: 5 }] }, opts);
  const c = loop.checks[0]!;
  expect(c.kind).toBe("metric");
  expect((c as { command: string }).command).toBe("wc -l < out | tail -1");
  // A command/judge check is left untouched.
  const { loop: l2 } = completeLoop({ ...base, checks: [{ kind: "command", command: "bun test" }] }, opts);
  expect((l2.checks[0] as { command: string }).command).toBe("bun test");
});
