import { test, expect } from "bun:test";
import { buildPhases, runIntake, type AgentFn, type PhaseDeps } from "../../src/pipeline/phases";
import { runDevPipeline } from "../../src/pipeline/run";
import { newTrace } from "../../src/pipeline/trace";
import { AdversaryMetrics } from "../../src/pipeline/metrics";
import type { PhaseContext } from "../../src/pipeline/orchestrator";

// The gate LOGIC (prompt → parse → decide → record) is tested here with a fake agent that returns
// canned structured replies per persona. No subprocess, no models.

type Persona = "intake" | "requirements" | "audit" | "design" | "redteam" | "implement" | "testgen" | "validation";
function personaOf(prompt: string): Persona {
  if (prompt.includes("User Advocate at intake")) return "intake";
  if (prompt.includes("Requirements Engineer")) return "requirements";
  if (prompt.includes("Auditor")) return "audit";
  if (prompt.includes("Architect")) return "design";
  if (prompt.includes("Staff Engineer red-team")) return "redteam";
  if (prompt.includes("Implementer")) return "implement";
  if (prompt.includes("Test Adversary")) return "testgen";
  return "validation";
}
const HAPPY: Record<Persona, string> = {
  intake: '{"classification":"well-formed","riskTier":"standard","reason":"clear"}',
  requirements: '{"criteria":[{"id":"AC1","text":"does x","kind":"automatable"}],"nonGoals":["no auth change"],"interfaceContract":"fn(x)->y"}',
  audit: '{"accept":true,"critical":false,"findings":[]}',
  design: "# Plan\nBind AC1 to a unit test in x.test.ts.",
  redteam: '{"accept":true,"critical":false,"findings":[]}',
  implement: "Implemented exactly per the plan.",
  testgen: "Added adversarial edge-case tests.",
  validation: '{"satisfies":true,"critical":false,"gap":""}',
};

/** Fake agent: per-persona canned reply (string or fn), falling back to the happy-path reply. */
function fakeAgent(overrides: Partial<Record<Persona, string | ((prompt: string) => string)>> = {}): AgentFn {
  return async (prompt) => {
    const persona = personaOf(prompt);
    const o = overrides[persona];
    const text = typeof o === "function" ? o(prompt) : (o ?? HAPPY[persona]);
    return { text };
  };
}

const GREEN = async () => ({ criteriaTests: "pass" as const, adversaryTests: "pass" as const, lintTypesBuild: "pass" as const, coverage: "90%" });

function deps(overrides: Partial<Record<Persona, string | ((p: string) => string)>> = {}, extra: Partial<PhaseDeps> = {}): PhaseDeps {
  return {
    task: { id: "wu1", text: "Add a retry to the upload client" },
    repoRoot: "/repo",
    agent: fakeAgent(overrides),
    checks: GREEN,
    captureDiff: async () => "abc123 (2 files)",
    ...extra,
  };
}

function ctx(trace = newTrace("wu1", "Add a retry to the upload client"), over: Partial<PhaseContext> = {}): PhaseContext {
  return { trace, riskTier: "standard", log: () => {}, attempt: 1, firstVisit: true, ...over };
}

// ── P0 intake ──
test("intake proceeds on well-formed and sets the tier; routes ambiguous tasks to the operator", async () => {
  expect(await runIntake(deps())).toMatchObject({ proceed: true, riskTier: "standard" });
  const nc = await runIntake(deps({ intake: '{"classification":"needs-clarification","riskTier":"standard","reason":"which client?"}' }));
  expect(nc.proceed).toBe(false);
  expect(nc.classification).toBe("needs-clarification");
});

// ── P1 requirements ──
test("requirements: GLM drafts (persisted to trace), Claude audits; clean audit passes", async () => {
  const t = newTrace("wu1", "task");
  const m = new AdversaryMetrics();
  const out = await buildPhases(deps()).requirements(ctx(t, { metrics: m }));
  expect(out.status).toBe("pass");
  expect(t.acceptanceCriteria[0]).toMatchObject({ id: "AC1", kind: "automatable" });
  expect(t.nonGoals).toEqual(["no auth change"]);
  expect(t.modelAssignment.find((a) => a.phase === "requirements")).toMatchObject({ author: "GLM 5.2", adversary: "Claude Opus 5" });
  expect(m.rejectionRate("requirements", "claude")).toBe(0); // first-pass, not rejected
});

test("requirements: a non-critical audit finding rejects (author revises); records a rejection", async () => {
  const m = new AdversaryMetrics();
  const out = await buildPhases(deps({ audit: '{"accept":false,"critical":false,"findings":["AC1 is not machine-checkable"]}' })).requirements(ctx(undefined, { metrics: m }));
  expect(out.status).toBe("reject");
  expect(m.rejectionRate("requirements", "claude")).toBe(1);
});

test("requirements: a CRITICAL audit finding (ambiguous need) escalates to the operator", async () => {
  const out = await buildPhases(deps({ audit: '{"accept":false,"critical":true,"findings":["the need itself is ambiguous"]}' })).requirements(ctx());
  expect(out.status).toBe("escalate");
});

// ── P2 design ──
test("design: Claude authors the plan (stored on the trace), GLM red-teams", async () => {
  const t = newTrace("wu1", "task");
  const out = await buildPhases(deps()).design(ctx(t));
  expect(out.status).toBe("pass");
  expect(t.planRef).toContain("Bind AC1");
  expect(t.modelAssignment.find((a) => a.phase === "design")).toMatchObject({ author: "Claude Opus 5", adversary: "GLM 5.2" });
});

// ── P3 implementation ──
test("implementation: GLM by default; escalates authorship to Claude on the high tier", async () => {
  const t = newTrace("wu1", "task");
  await buildPhases(deps()).implementation(ctx(t, { riskTier: "high" }));
  expect(t.modelAssignment.find((a) => a.phase === "implementation")?.author).toBe("Claude Opus 5");
});

test("implementation: an INFEASIBLE report loops back to design", async () => {
  const out = await buildPhases(deps({ implement: "INFEASIBLE: the planned API doesn't exist" })).implementation(ctx());
  expect(out).toMatchObject({ status: "loopback", to: "design" });
});

// ── P4 verification ──
test("verification: all-green passes; a failing check loops back to implementation", async () => {
  const pass = await buildPhases(deps()).verification(ctx());
  expect(pass.status).toBe("pass");
  const fail = await buildPhases(deps({}, { checks: async () => ({ criteriaTests: "fail", lintTypesBuild: "pass" }) })).verification(ctx());
  expect(fail).toMatchObject({ status: "loopback", to: "implementation" });
});

// ── P5 validation ──
test("validation: satisfies passes; a non-critical gap loops back to requirements; critical escalates", async () => {
  expect((await buildPhases(deps()).validation(ctx())).status).toBe("pass");
  const gap = await buildPhases(deps({ validation: '{"satisfies":false,"critical":false,"gap":"ignores 5xx"}' })).validation(ctx());
  expect(gap).toMatchObject({ status: "loopback", to: "requirements" });
  const crit = await buildPhases(deps({ validation: '{"satisfies":false,"critical":true,"gap":"wrong feature entirely"}' })).validation(ctx());
  expect(crit.status).toBe("escalate");
});

// ── End-to-end composition ──
test("a clean run ships end-to-end, populating the trace and the adversary metrics", async () => {
  const m = new AdversaryMetrics();
  const out = await runDevPipeline(deps(), { metrics: m });
  expect(out.status).toBe("shipped");
  expect(out.trace.riskTier).toBe("standard");
  expect(out.trace.acceptanceCriteria.length).toBe(1);
  expect(out.trace.diffRef).toBe("abc123 (2 files)");
  // both judgment-gate adversaries were exercised on the first pass
  expect(m.rejectionRate("requirements", "claude")).toBe(0);
  expect(m.rejectionRate("design", "glm")).toBe(0);
});

test("a validation bounce rewinds to requirements, then ships (loop-back recorded once)", async () => {
  let vCalls = 0;
  const out = await runDevPipeline(
    deps({
      validation: () => (vCalls++ === 0 ? '{"satisfies":false,"critical":false,"gap":"missing retry cap"}' : '{"satisfies":true,"critical":false,"gap":""}'),
    }),
  );
  expect(out.status).toBe("shipped");
  expect(out.trace.loopbackCount.requirements).toBe(1);
});

test("an out-of-scope task never enters the gauntlet — operator required at intake", async () => {
  const out = await runDevPipeline(deps({ intake: '{"classification":"out-of-scope","riskTier":"trivial","reason":"not a code change"}' }));
  expect(out.status).toBe("operator_required");
  expect(out.phaseReached).toBe("intake");
});

test("a trivial task skips the judgment gates and ships on build+verify alone", async () => {
  const out = await runDevPipeline(deps({ intake: '{"classification":"well-formed","riskTier":"trivial","reason":"one-liner"}' }));
  expect(out.status).toBe("shipped");
  // requirements/design never ran, so no criteria were drafted
  expect(out.trace.acceptanceCriteria.length).toBe(0);
  expect(out.trace.modelAssignment.find((a) => a.phase === "implementation")).toBeTruthy();
});
