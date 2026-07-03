/**
 * The seven gate implementations (spec §4). Each is a factory over `PhaseDeps` returning a `PhaseRun`
 * the orchestrator drives. Authorship flips by phase per the roster (§3.2); the adversary is always the
 * OTHER model (§2.2, enforced via assertIndependent); adversary first-pass verdicts feed the §6.3 metric.
 *
 * All model + side-effect access is behind injected adapters (`agent`, `checks`, `implement`, `openPr`,
 * `captureDiff`) so the gate *logic* — prompt, parse, decide, record — is unit-testable with fakes. The
 * real adapters (defaults in ./adapters) drive the Agent SDK and the repo; the daemon wires them in.
 */
import { extractJson } from "../integrations/json";
import { assertIndependent, roster as buildRoster, type ModelSpec, type PipelinePhase } from "../agent/model-roster";
import type { AgentQueryResult } from "../agent/query";
import type { PhaseContext, PhaseRun } from "./orchestrator";
import { recordAssignment, type AcceptanceCriterion, type PassFail } from "./trace";
import type { GateOutcome, RiskTier } from "./types";

/** Drives one model for one turn. Mirrors runAgentQuery; injected so tests need no subprocess. */
export type AgentFn = (
  prompt: string,
  opts: { model: ModelSpec; cwd?: string; readonly?: boolean; signal?: AbortSignal },
) => Promise<AgentQueryResult>;

/** Runs the deterministic verification suite against the repo (§4 P4 "primary"). */
export type ChecksFn = (repoRoot: string, signal?: AbortSignal) => Promise<PassFail>;

/** Opens the release PR with the trace record as its body (§4 P6). Returns a reference. */
export type OpenPrFn = (input: { title: string; body: string; repoRoot: string; signal?: AbortSignal }) => Promise<string>;

/** Captures a reference to the implemented change (e.g. HEAD sha or diff stat). */
export type CaptureDiffFn = (repoRoot: string, signal?: AbortSignal) => Promise<string>;

export interface PhaseDeps {
  task: { id: string; text: string };
  repoRoot: string;
  glmSlug?: string; // override GLM's OpenRouter slug (config)
  agent: AgentFn;
  checks?: ChecksFn;
  openPr?: OpenPrFn;
  captureDiff?: CaptureDiffFn;
}

// ── structured payloads the models emit ──
interface IntakeJson {
  classification?: unknown;
  riskTier?: unknown;
  reason?: unknown;
}
interface RequirementsJson {
  criteria?: { id?: unknown; text?: unknown; kind?: unknown }[];
  nonGoals?: unknown[];
  interfaceContract?: unknown;
}
interface GateVerdictJson {
  accept?: unknown;
  critical?: unknown;
  findings?: unknown;
}
interface ValidationJson {
  satisfies?: unknown;
  critical?: unknown;
  gap?: unknown;
}

/** Parse a model's structured reply, preferring the plan-mode payload, then the wrap-up text. */
function parseJson<T>(out: AgentQueryResult): T {
  const primary = out.plan ?? out.text;
  try {
    return extractJson<T>(primary);
  } catch {
    // plan-mode sometimes puts the JSON in the wrap-up text instead of ExitPlanMode.
    if (out.plan && out.text) return extractJson<T>(out.text);
    throw new Error(`could not parse structured reply: ${primary.slice(0, 200)}`);
  }
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter((s) => s.trim()) : []);
const truthy = (v: unknown): boolean => v === true || v === "true" || v === "yes";

// ── prompts ──
const PIPELINE_RESULT = 'Respond with ONLY a JSON object, no prose or code fences.';

function intakePrompt(taskText: string): string {
  return `You are the User Advocate at intake. Classify this task; do not solve it.
- classification: "well-formed" (clear enough to implement), "needs-clarification" (intent ambiguous), or "out-of-scope" (not an actionable software change).
- riskTier: "trivial" (config/one-liner/doc edit), "standard" (normal feature or fix), or "high" (novel design, security-relevant, or external-facing).
${PIPELINE_RESULT}
{"classification": "...", "riskTier": "...", "reason": "one sentence"}

Task: ${taskText}`;
}

function requirementsPrompt(taskText: string): string {
  return `You are the Requirements Engineer. Inspect the repository read-only and convert this task into objectively verifiable acceptance criteria, explicit non-goals, and the interface contract (inputs, outputs, failure behavior). Every criterion must be machine-checkable, or tagged "human-validates" if it genuinely needs a human. No vague criteria ("fast", "high quality").
${PIPELINE_RESULT}
{"criteria": [{"id": "AC1", "text": "...", "kind": "automatable|human-validates"}], "nonGoals": ["..."], "interfaceContract": "..."}

Task: ${taskText}`;
}

function auditPrompt(taskText: string, req: RequirementsJson): string {
  return `You are the Auditor. Break the REQUIREMENTS, not the code. Given the original task and the drafted criteria, find: (a) any criterion that is not machine-checkable and not tagged "human-validates"; (b) any part of the original need not covered by any criterion. Material findings only — no style nits. You may return no issues, and should when the requirements are sound. If the ORIGINAL NEED itself is too ambiguous to write verifiable criteria for, set critical=true (this pages the operator).
${PIPELINE_RESULT}
{"accept": true|false, "critical": true|false, "findings": ["..."]}

Original task: ${taskText}
Drafted requirements: ${JSON.stringify(req)}`;
}

function designPrompt(taskText: string, criteria: AcceptanceCriterion[]): string {
  return `You are the Architect. Produce the SIMPLEST implementation plan that satisfies every acceptance criterion. Inspect the repo read-only. Include: files to touch, interfaces, dependencies, risks, test strategy, and a traceability map binding EACH criterion id to a specific planned test (no orphan criteria). Do not edit anything — planning only. Output the plan in markdown.

Task: ${taskText}
Acceptance criteria: ${JSON.stringify(criteria)}`;
}

function redteamPrompt(plan: string, criteria: AcceptanceCriterion[]): string {
  return `You are the Staff Engineer red-team. Attack this PLAN before any code exists: is there a simpler path? hidden coupling? any acceptance criterion with no planned test (an orphan)? Rejecting now is cheap. Material findings only. Set critical=true only if the approach is fundamentally unworkable.
${PIPELINE_RESULT}
{"accept": true|false, "critical": true|false, "findings": ["..."]}

Acceptance criteria: ${JSON.stringify(criteria)}
Plan:
${plan}`;
}

function implementPrompt(plan: string): string {
  return `You are the Implementer. Build EXACTLY this approved plan: code, tests, and config. Follow the repo's existing conventions. If the plan proves infeasible mid-implementation, STOP and reply with a single line "INFEASIBLE: <reason>" and make no further edits — do not silently deviate.

Approved plan:
${plan}`;
}

function testGenPrompt(criteria: AcceptanceCriterion[]): string {
  return `You are the Test Adversary. Write tests that try to BREAK the code, targeting the acceptance criteria the implementer likely under-tested and their edge cases. Add them to the repo's existing test suite following its conventions. Do not modify the implementation. Blind to the implementer's reasoning — go by the criteria and the code as written.

Acceptance criteria (target the automatable ones): ${JSON.stringify(criteria.filter((c) => c.kind === "automatable"))}`;
}

function validationPrompt(taskText: string): string {
  return `You are the Validation pre-check, blind to the implementation reasoning. Compare what was actually built to the ORIGINAL task text — NOT to the acceptance criteria (validating against the criteria you wrote is just re-running verification). Inspect the repo read-only and, if present, run/inspect the demo. Decide whether the built behavior satisfies the original need. If it does not, set satisfies=false; set critical=true only if the need was fundamentally misunderstood (a human should look), otherwise it will loop back to Requirements.
${PIPELINE_RESULT}
{"satisfies": true|false, "critical": true|false, "gap": "what's missing vs. the original ask, or empty"}

Original task: ${taskText}`;
}

/** Turn an adversary's structured verdict into an orchestrator outcome, recording the §6.3 metric. */
function verdictToOutcome(
  phase: PipelinePhase,
  adversary: ModelSpec,
  ctx: PhaseContext,
  verdict: GateVerdictJson,
): GateOutcome {
  const accept = truthy(verdict.accept);
  const critical = truthy(verdict.critical);
  const findings = asStrings(verdict.findings);
  if (ctx.firstVisit) ctx.metrics?.recordFirstPass(phase, adversary.id, !accept);
  if (accept) return { status: "pass" };
  if (critical) return { status: "escalate", reason: findings[0] ?? `${phase}: critical finding` };
  return { status: "reject", reasons: findings.length ? findings : [`${phase}: adversary rejected`] };
}

/**
 * Build the six orchestrator-driven phases (P1–P6). Intake (P0) runs separately via `runIntake` because
 * it produces the risk tier that selects these phases.
 */
export function buildPhases(deps: PhaseDeps): Record<Exclude<PipelinePhase, "intake">, PhaseRun> {
  const { claude, glm } = buildRoster(deps.glmSlug);
  const sig = (ctx: PhaseContext) => ctx.signal;

  // P1 — Requirements: GLM drafts → Claude audits (judgment-stronger model on review, §2.3).
  const requirements: PhaseRun = async (ctx) => {
    assertIndependent("requirements", glm.id, claude.id);
    const draftOut = await deps.agent(requirementsPrompt(deps.task.text), { model: glm, cwd: deps.repoRoot, readonly: true, signal: sig(ctx) });
    const draft = parseJson<RequirementsJson>(draftOut);
    ctx.trace.acceptanceCriteria = (draft.criteria ?? []).map((c, i) => ({
      id: String(c.id ?? `AC${i + 1}`),
      text: String(c.text ?? ""),
      kind: c.kind === "human-validates" ? "human-validates" : "automatable",
    }));
    ctx.trace.nonGoals = asStrings(draft.nonGoals);
    ctx.trace.interfaceContract = draft.interfaceContract ? String(draft.interfaceContract) : undefined;
    recordAssignment(ctx.trace, { phase: "requirements", author: glm.label, adversary: claude.label });

    const auditOut = await deps.agent(auditPrompt(deps.task.text, draft), { model: claude, cwd: deps.repoRoot, readonly: true, signal: sig(ctx) });
    return verdictToOutcome("requirements", claude, ctx, parseJson<GateVerdictJson>(auditOut));
  };

  // P2 — Design: Claude authors the plan + traceability → GLM red-teams.
  const design: PhaseRun = async (ctx) => {
    assertIndependent("design", claude.id, glm.id);
    const planOut = await deps.agent(designPrompt(deps.task.text, ctx.trace.acceptanceCriteria), { model: claude, cwd: deps.repoRoot, readonly: true, signal: sig(ctx) });
    const plan = (planOut.plan ?? planOut.text).trim();
    ctx.trace.planRef = plan;
    recordAssignment(ctx.trace, { phase: "design", author: claude.label, adversary: glm.label });

    const rtOut = await deps.agent(redteamPrompt(plan, ctx.trace.acceptanceCriteria), { model: glm, cwd: deps.repoRoot, readonly: true, signal: sig(ctx) });
    return verdictToOutcome("design", glm, ctx, parseJson<GateVerdictJson>(rtOut));
  };

  // P3 — Implementation: GLM writes code; escalate to Claude on the high tier (§6.2). No adversary here.
  const implementation: PhaseRun = async (ctx) => {
    const author = ctx.riskTier === "high" ? claude : glm;
    recordAssignment(ctx.trace, { phase: "implementation", author: author.label });
    const out = await deps.agent(implementPrompt(ctx.trace.planRef ?? ""), { model: author, cwd: deps.repoRoot, readonly: false, signal: sig(ctx) });
    if (/^INFEASIBLE:/m.test(out.text)) {
      return { status: "loopback", to: "design", reason: out.text.match(/INFEASIBLE:.*/)?.[0] ?? "plan infeasible" };
    }
    ctx.trace.diffRef = deps.captureDiff ? await deps.captureDiff(deps.repoRoot, sig(ctx)) : "(diff captured)";
    return { status: "pass" };
  };

  // P4 — Verification: deterministic checks + GLM adversarial test-generation, then re-check.
  const verification: PhaseRun = async (ctx) => {
    recordAssignment(ctx.trace, { phase: "verification", author: glm.label });
    // Adversarial test generation (writes tests) — only worth doing on the first visit; reruns just re-check.
    if (ctx.firstVisit) {
      await deps.agent(testGenPrompt(ctx.trace.acceptanceCriteria), { model: glm, cwd: deps.repoRoot, readonly: false, signal: sig(ctx) });
    }
    const report = deps.checks ? await deps.checks(deps.repoRoot, sig(ctx)) : {};
    ctx.trace.verification = report;
    const green = (v?: "pass" | "fail") => v === undefined || v === "pass";
    const passed = green(report.criteriaTests) && green(report.adversaryTests) && green(report.lintTypesBuild);
    if (passed) return { status: "pass" };
    // A failure is fixed in Implementation, not here — bounce to P3 (bounded by verification's §6.1 cap).
    const failed = Object.entries(report).filter(([, v]) => v === "fail").map(([k]) => k);
    return { status: "loopback", to: "implementation", reason: `verification failed: ${failed.join(", ") || "checks"}` };
  };

  // P5 — Validation: blind Claude compares built behavior to the ORIGINAL task (not the criteria).
  const validation: PhaseRun = async (ctx) => {
    recordAssignment(ctx.trace, { phase: "validation", author: claude.label });
    const out = await deps.agent(validationPrompt(deps.task.text), { model: claude, cwd: deps.repoRoot, readonly: true, signal: sig(ctx) });
    const v = parseJson<ValidationJson>(out);
    ctx.trace.validation.builtVsAskedNote = v.gap ? String(v.gap) : "built behavior matches the original task";
    if (truthy(v.satisfies)) {
      ctx.trace.validation.operatorSignoff = "no"; // proxy pass; a human hasn't signed unless the operator gate fires
      return { status: "pass" };
    }
    if (truthy(v.critical)) return { status: "escalate", reason: v.gap ? String(v.gap) : "need fundamentally misunderstood" };
    return { status: "loopback", to: "requirements", reason: v.gap ? String(v.gap) : "built behavior does not satisfy the original task" };
  };

  // P6 — Transfer: assemble the trace record as the PR body and open the release PR.
  const transfer: PhaseRun = async (ctx) => {
    recordAssignment(ctx.trace, { phase: "transfer", author: glm.label });
    if (deps.openPr) {
      // Render lazily to avoid a cycle; the caller supplies the renderer via the body it wants. Here we
      // pass the plan title + let the daemon body-build; keep the diff/PR ref on the trace.
      const { renderTraceRecord } = await import("./trace");
      const prRef = await deps.openPr({ title: deps.task.text.slice(0, 72), body: renderTraceRecord(ctx.trace), repoRoot: deps.repoRoot, signal: sig(ctx) });
      ctx.trace.prRef = prRef;
    }
    return { status: "pass" };
  };

  return { requirements, design, implementation, verification, validation, transfer };
}

// ── Intake (P0), run before the orchestrator because it produces the risk tier ──
export interface IntakeOutcome {
  proceed: boolean; // well-formed → run the pipeline
  classification: "well-formed" | "needs-clarification" | "out-of-scope";
  riskTier: RiskTier;
  reason: string;
}

const TIERS: RiskTier[] = ["trivial", "standard", "high"];

export async function runIntake(deps: PhaseDeps, signal?: AbortSignal): Promise<IntakeOutcome> {
  const { glm } = buildRoster(deps.glmSlug);
  const out = await deps.agent(intakePrompt(deps.task.text), { model: glm, readonly: true, signal });
  const j = parseJson<IntakeJson>(out);
  const classification =
    j.classification === "needs-clarification" || j.classification === "out-of-scope" ? j.classification : "well-formed";
  const riskTier = TIERS.includes(j.riskTier as RiskTier) ? (j.riskTier as RiskTier) : "standard";
  return { proceed: classification === "well-formed", classification, riskTier, reason: String(j.reason ?? "") };
}
