import { test, expect } from "bun:test";
import { dedupeKeyFor, normalizeTrigger, type TriggerEvent } from "../../src/integrations/event-trigger";

const NOW = "2026-07-30T12:00:00.000Z";

const base: TriggerEvent = { kind: "ci-failure", source: "CI build #1421", title: "Fix failing build on main" };

// ── dedupeKeyFor: same event collapses onto one card ──

test("dedupeKeyFor prefers the caller's explicit key", () => {
  expect(dedupeKeyFor({ kind: "webhook", title: "anything", dedupeKey: "run-77" })).toBe("run-77");
});

test("dedupeKeyFor derives a stable slug from kind+title", () => {
  const k1 = dedupeKeyFor({ kind: "ci-failure", title: "Fix failing build on main" });
  const k2 = dedupeKeyFor({ kind: "ci-failure", title: "Fix failing build on main" });
  expect(k1).toBe(k2); // re-delivery of the same failure → same key
  expect(k1).toBe("ci-failure:fix-failing-build-on-main");
});

test("dedupeKeyFor never yields a bare kind for a symbol-only title", () => {
  expect(dedupeKeyFor({ kind: "webhook", title: "!!!" })).toBe("webhook:untitled");
});

// ── normalizeTrigger: validate + shape into a proposed intent ──

test("normalizeTrigger builds a proposed intent that defaults to needing approval", () => {
  const intent = normalizeTrigger({ ...base, body: "TypeError in src/a.ts\nstack…" }, NOW);
  expect(intent.title).toBe("Fix failing build on main");
  expect(intent.summary).toBe("CI build #1421 — TypeError in src/a.ts");
  expect(intent.autoApprove).toBe(false); // propose, don't run
  expect(intent.trigger).toEqual({ kind: "ci-failure", source: "CI build #1421", at: NOW, dedupeKey: "ci-failure:fix-failing-build-on-main" });
});

test("normalizeTrigger honors an explicit trusted auto-approve", () => {
  expect(normalizeTrigger({ ...base, autoApprove: true }, NOW).autoApprove).toBe(true);
});

test("normalizeTrigger carries an environment route when given", () => {
  expect(normalizeTrigger({ ...base, environmentId: "env-1" }, NOW).environmentId).toBe("env-1");
  expect(normalizeTrigger(base, NOW).environmentId).toBeUndefined();
});

test("normalizeTrigger falls back to the kind when source is blank", () => {
  expect(normalizeTrigger({ ...base, source: "  " }, NOW).trigger.source).toBe("ci-failure");
});

test("normalizeTrigger rejects an unknown kind or an empty title", () => {
  expect(() => normalizeTrigger({ ...base, kind: "bogus" as TriggerEvent["kind"] }, NOW)).toThrow(/unknown trigger kind/);
  expect(() => normalizeTrigger({ ...base, title: "   " }, NOW)).toThrow(/no title/);
});
