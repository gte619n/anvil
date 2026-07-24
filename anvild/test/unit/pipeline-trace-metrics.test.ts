import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTrace, recordAssignment, renderTraceRecord } from "../../src/pipeline/trace";
import { AdversaryMetrics } from "../../src/pipeline/metrics";
import { saveMetrics, loadMetrics } from "../../src/pipeline/metrics-store";

// ── Trace record (§7) ──

test("renderTraceRecord emits the structured PR body with the spine fields", () => {
  const t = newTrace("wu_1", "Add a retry to the upload client");
  t.riskTier = "standard";
  t.acceptanceCriteria = [
    { id: "AC1", text: "uploads retry 3× on 5xx", kind: "automatable" },
    { id: "AC2", text: "the retry banner reads well", kind: "human-validates" },
  ];
  t.nonGoals = ["no change to auth"];
  t.planRef = "plan#abc";
  t.diffRef = "diff#def";
  t.verification = { criteriaTests: "pass", adversaryTests: "pass", lintTypesBuild: "pass", coverage: "88%" };
  t.validation.operatorSignoff = "yes";
  recordAssignment(t, { phase: "requirements", author: "GLM 5.2", adversary: "Claude Opus 5" });
  recordAssignment(t, { phase: "design", author: "Claude Opus 5", adversary: "GLM 5.2" });
  t.loopbackCount = { requirements: 1 };

  const md = renderTraceRecord(t);
  expect(md).toContain("## Trace record");
  expect(md).toContain("task_id: wu_1");
  expect(md).toContain("original_task_text:");
  expect(md).toContain("Add a retry to the upload client");
  expect(md).toContain("AC1 [automatable] uploads retry 3× on 5xx");
  expect(md).toContain("AC2 [human-validates]");
  expect(md).toContain("criteria_tests: pass");
  expect(md).toContain("requirements: author=GLM 5.2 adversary=Claude Opus 5");
  expect(md).toContain("requirements: 1");
});

test("a multi-line plan_ref is rendered as an indented YAML block (doesn't break the structure)", () => {
  const t = newTrace("wu", "task");
  t.planRef = "# Plan\nStep one.\nStep two.";
  const md = renderTraceRecord(t);
  // block scalar opener, and every plan line indented under it so the YAML stays valid
  expect(md).toContain("plan_ref: |\n  # Plan\n  Step one.\n  Step two.");
  // no plan line escapes to column 0 (which would be parsed as a new top-level key)
  expect(md).not.toMatch(/\nStep two\./);
});

test("recordAssignment overwrites a phase's prior assignment rather than duplicating it", () => {
  const t = newTrace("x", "y");
  recordAssignment(t, { phase: "implementation", author: "GLM 5.2" });
  recordAssignment(t, { phase: "implementation", author: "Claude Opus 5" }); // escalated to Claude
  expect(t.modelAssignment).toHaveLength(1);
  expect(t.modelAssignment[0]!.author).toBe("Claude Opus 5");
});

// ── Collusion / theater metric (§6.3) ──

test("first-pass rejection rate is tracked per gate/adversary", () => {
  const m = new AdversaryMetrics();
  // Claude auditing requirements: rejects 2 of 4 first submissions.
  m.recordFirstPass("requirements", "claude", true);
  m.recordFirstPass("requirements", "claude", false);
  m.recordFirstPass("requirements", "claude", true);
  m.recordFirstPass("requirements", "claude", false);
  expect(m.rejectionRate("requirements", "claude")).toBe(0.5);
  expect(m.rejectionRate("design", "glm")).toBeUndefined(); // never exercised
});

test("decorative() flags an adversary that almost never rejects over a real sample", () => {
  const m = new AdversaryMetrics();
  for (let i = 0; i < 20; i++) m.recordFirstPass("design", "glm", false); // rubber-stamps everything
  for (let i = 0; i < 20; i++) m.recordFirstPass("requirements", "claude", i < 6); // 30% rejects — healthy
  const flagged = m.decorative(0.1, 10);
  expect(flagged.map((t) => t.adversary)).toEqual(["glm"]); // only the rubber-stamper
});

test("metrics round-trip through JSON for cross-run persistence", () => {
  const m = new AdversaryMetrics();
  m.recordFirstPass("verification", "glm", true);
  const restored = AdversaryMetrics.fromJSON(m.toJSON());
  expect(restored.rejectionRate("verification", "glm")).toBe(1);
});

// ── Metrics persistence (§6.3) — the store BE-13 relies on to survive across runs ──
test("saveMetrics/loadMetrics round-trips recorded first-pass tallies", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-metrics-"));
  const m = new AdversaryMetrics();
  m.recordFirstPass("requirements", "claude", true);
  m.recordFirstPass("requirements", "claude", false);
  m.recordFirstPass("design", "glm", true);
  saveMetrics(dir, m);

  const back = loadMetrics(dir);
  expect(back.rejectionRate("requirements", "claude")).toBe(0.5);
  expect(back.rejectionRate("design", "glm")).toBe(1);
  expect(back.toJSON()).toEqual(m.toJSON()); // exact structural round-trip
});

test("loadMetrics returns empty (never throws) when the file is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-metrics-empty-"));
  expect(loadMetrics(dir).rejectionRate("requirements", "claude")).toBeUndefined();
});
