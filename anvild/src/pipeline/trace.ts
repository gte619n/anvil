/**
 * The trace record (spec §7) — the entire "Design History File", earned for one reason: reconstructing
 * *why* the agent shipped something wrong at 3am. It accumulates across phases and renders as the
 * structured PR body at Transfer. Deliberately lean: no separate process artifacts, just the spine that
 * binds original need → criteria → plan → diff → verification → validation, plus who did what.
 */
import type { PipelinePhase } from "../agent/model-roster";
import type { RiskTier } from "./types";

export type CriterionKind = "automatable" | "human-validates";

export interface AcceptanceCriterion {
  id: string;
  text: string;
  kind: CriterionKind;
}

export interface PassFail {
  criteriaTests?: "pass" | "fail";
  adversaryTests?: "pass" | "fail";
  lintTypesBuild?: "pass" | "fail";
  coverage?: string;
}

/** Records, per phase, which model authored and which adversaried — the residue that makes the §2.2
 *  independence rule auditable after the fact. */
export interface PhaseModelAssignment {
  phase: PipelinePhase;
  author: string; // ModelSpec label
  adversary?: string; // ModelSpec label, when the phase had one
}

export interface TraceRecord {
  taskId: string;
  originalTaskText: string; // operator's words, verbatim (P0)
  riskTier?: RiskTier;
  acceptanceCriteria: AcceptanceCriterion[]; // P1
  nonGoals: string[]; // P1
  interfaceContract?: string; // P1
  planRef?: string; // P2 plan + traceability map
  diffRef?: string; // P3 change
  prRef?: string; // P6 opened PR (url or gh output)
  verification: PassFail; // P4
  validation: {
    demoRef?: string;
    builtVsAskedNote?: string;
    operatorSignoff?: "yes" | "no";
  }; // P5
  modelAssignment: PhaseModelAssignment[];
  loopbackCount: Partial<Record<PipelinePhase, number>>; // per phase
}

/** A fresh trace seeded from the intake step. */
export function newTrace(taskId: string, originalTaskText: string): TraceRecord {
  return {
    taskId,
    originalTaskText,
    acceptanceCriteria: [],
    nonGoals: [],
    verification: {},
    validation: {},
    modelAssignment: [],
    loopbackCount: {},
  };
}

/** Record (or overwrite) a phase's author/adversary assignment. */
export function recordAssignment(trace: TraceRecord, a: PhaseModelAssignment): void {
  const existing = trace.modelAssignment.findIndex((m) => m.phase === a.phase);
  if (existing >= 0) trace.modelAssignment[existing] = a;
  else trace.modelAssignment.push(a);
}

function yamlList(items: string[], indent = "  "): string {
  if (!items.length) return " []";
  return "\n" + items.map((i) => `${indent}- ${i.replace(/\n/g, " ")}`).join("\n");
}

/**
 * Render the trace as the structured PR body (§7). YAML-shaped for grep-ability and diffability; this
 * is what a human reads to reconstruct the decision trail. Kept compact — it must not cost more tokens
 * than the code it describes.
 */
export function renderTraceRecord(t: TraceRecord): string {
  const criteria = t.acceptanceCriteria.map((c) => `${c.id} [${c.kind}] ${c.text}`);
  const assignments = t.modelAssignment.map(
    (m) => `${m.phase}: author=${m.author}${m.adversary ? ` adversary=${m.adversary}` : ""}`,
  );
  const loops = Object.entries(t.loopbackCount).map(([p, n]) => `${p}: ${n}`);
  return `## Trace record

\`\`\`yaml
task_id: ${t.taskId}
original_task_text: |
  ${t.originalTaskText.replace(/\n/g, "\n  ")}
risk_tier: ${t.riskTier ?? "—"}
acceptance_criteria:${yamlList(criteria)}
non_goals:${yamlList(t.nonGoals)}
interface_contract: ${t.interfaceContract ? `|\n  ${t.interfaceContract.replace(/\n/g, "\n  ")}` : "—"}
plan_ref: ${t.planRef ? `|\n  ${t.planRef.replace(/\n/g, "\n  ")}` : "—"}
diff_ref: ${t.diffRef ?? "—"}
pr_ref: ${t.prRef ?? "—"}
verification:
  criteria_tests: ${t.verification.criteriaTests ?? "—"}
  adversary_tests: ${t.verification.adversaryTests ?? "—"}
  lint_types_build: ${t.verification.lintTypesBuild ?? "—"}
  coverage: ${t.verification.coverage ?? "—"}
validation:
  demo_ref: ${t.validation.demoRef ?? "—"}
  built_vs_asked_note: ${t.validation.builtVsAskedNote ? `|\n    ${t.validation.builtVsAskedNote.replace(/\n/g, "\n    ")}` : "—"}
  operator_signoff: ${t.validation.operatorSignoff ?? "—"}
model_assignment:${yamlList(assignments)}
loopback_count:${yamlList(loops)}
\`\`\``;
}
