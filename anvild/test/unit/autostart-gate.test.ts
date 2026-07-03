import { test, expect } from "bun:test";
import { AUTOSTART_MIN_CONSENSUS, autoStartDecision, parseIntakeVerdict } from "../../src/integrations/autostart-gate";
import { extractPlanMeta } from "../../src/integrations/plan-meta";

// ── parseIntakeVerdict: normalize a classifier's JSON, failing OPEN so a garbled answer never wedges a run ──

test("parseIntakeVerdict recognizes a needs-clarification verdict + questions", () => {
  const v = parseIntakeVerdict({ classification: "needs-clarification", reason: "Where does the catalog live?", questions: ["Which sheet?", "  ", "What fields?"] });
  expect(v.classification).toBe("needs-clarification");
  expect(v.wellFormed).toBe(false);
  expect(v.reason).toBe("Where does the catalog live?");
  expect(v.questions).toEqual(["Which sheet?", "What fields?"]); // blanks dropped, trimmed
});

test("parseIntakeVerdict recognizes out-of-scope", () => {
  const v = parseIntakeVerdict({ classification: "out-of-scope", reason: "Pure data entry." });
  expect(v.classification).toBe("out-of-scope");
  expect(v.wellFormed).toBe(false);
  expect(v.questions).toEqual([]);
});

test("parseIntakeVerdict fails open on unknown/garbled input", () => {
  for (const bad of [null, undefined, {}, { classification: "maybe?" }, "not json", 42]) {
    const v = parseIntakeVerdict(bad);
    expect(v.classification).toBe("well-formed");
    expect(v.wellFormed).toBe(true);
  }
});

// ── autoStartDecision: the guard between a planned unit and an unattended bypass-permission build ──

test("autoStartDecision starts a clean, well-scored planned unit", () => {
  expect(autoStartDecision({ status: "planned", source: "project", adversarial: { consensusScore: 8 } })).toEqual({ start: true });
  expect(autoStartDecision({ status: "planned" }).start).toBe(true); // no panel → not held on quality
});

test("autoStartDecision holds a low-consensus plan for review", () => {
  const d = autoStartDecision({ status: "planned", adversarial: { consensusScore: 4 } });
  expect(d.start).toBe(false);
  expect(d.reason).toContain("4/10");
  // exactly at the bar is allowed; just below is held
  expect(autoStartDecision({ status: "planned", adversarial: { consensusScore: AUTOSTART_MIN_CONSENSUS } }).start).toBe(true);
  expect(autoStartDecision({ status: "planned", adversarial: { consensusScore: AUTOSTART_MIN_CONSENSUS - 1 } }).start).toBe(false);
});

test("autoStartDecision never auto-starts a held or label-sourced unit", () => {
  expect(autoStartDecision({ status: "needs-clarification" }).start).toBe(false);
  expect(autoStartDecision({ status: "building" }).start).toBe(false);
  expect(autoStartDecision({ status: "planned", source: "label" }).start).toBe(false);
});

// The real-world case this whole change exists for: the "Catalog marketing roles" plan (adversarial 4/10)
// must NOT auto-start.
test("autoStartDecision would have held the catalog incident (consensus 4)", () => {
  expect(autoStartDecision({ status: "planned", source: "project", adversarial: { consensusScore: 4 } }).start).toBe(false);
});

// ── planner escape hatch parsed out of the metadata block (Fix B) ──

test("extractPlanMeta surfaces an explicit needsClarification block", () => {
  const raw = `# Plan\n\nDo the thing.\n\n\`\`\`json\n{"summary": "s", "size": "m", "needsClarification": true, "questions": ["Which sheet?", "What columns?"]}\n\`\`\``;
  const { clarification, summary } = extractPlanMeta(raw);
  expect(summary).toBe("s");
  expect(clarification?.questions).toEqual(["Which sheet?", "What columns?"]);
});

test("extractPlanMeta ignores questions without an explicit needsClarification:true", () => {
  const raw = `Body.\n\n\`\`\`json\n{"size": "s", "questions": ["stray"]}\n\`\`\``;
  expect(extractPlanMeta(raw).clarification).toBeUndefined(); // a stray array must not park a shippable plan
});
