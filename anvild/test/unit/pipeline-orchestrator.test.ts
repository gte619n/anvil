import { test, expect } from "bun:test";
import { runPipeline, type PhaseRun } from "../../src/pipeline/orchestrator";
import { newTrace } from "../../src/pipeline/trace";
import type { GateOutcome, PipelinePhase, RiskTier } from "../../src/pipeline/types";

// The orchestrator's control flow is where the spec's cross-cutting controls live (caps, tiering,
// escalation). Scripted fake phases let us prove every transition deterministically, with no models.

/** A phase whose outcomes are read from a queue (one per visit); the log records the visit order. */
function scripted(outcomes: GateOutcome[]): { run: PhaseRun; visits: number } {
  const box = { visits: 0, run: (async () => ({ status: "pass" }) as GateOutcome) as PhaseRun };
  box.run = async () => {
    const o = outcomes[box.visits] ?? { status: "pass" };
    box.visits += 1;
    return o;
  };
  return box as { run: PhaseRun; visits: number };
}

const PASS: GateOutcome = { status: "pass" };
/** All standard-tier phases pass, unless overridden. */
function allPass(): Partial<Record<PipelinePhase, PhaseRun>> {
  const phases: PipelinePhase[] = ["requirements", "design", "implementation", "verification", "validation", "transfer"];
  const out: Partial<Record<PipelinePhase, PhaseRun>> = {};
  for (const p of phases) out[p] = async () => PASS;
  return out;
}

function run(tier: RiskTier, phases: Partial<Record<PipelinePhase, PhaseRun>>, log: string[] = []) {
  const trace = newTrace("t1", "do the thing");
  trace.riskTier = tier;
  return runPipeline(trace, tier, { phases, log: (m) => log.push(m) });
}

test("a clean standard run ships and reaches transfer", async () => {
  const out = await run("standard", allPass());
  expect(out.status).toBe("shipped");
  expect(out.phaseReached).toBe("transfer");
});

test("trivial tier skips the judgment gates (only impl → verify → transfer run)", async () => {
  const phases = allPass();
  const visited: PipelinePhase[] = [];
  for (const p of ["requirements", "design", "implementation", "verification", "validation", "transfer"] as PipelinePhase[]) {
    phases[p] = async () => {
      visited.push(p);
      return PASS;
    };
  }
  const out = await run("trivial", phases);
  expect(out.status).toBe("shipped");
  expect(visited).toEqual(["implementation", "verification", "transfer"]); // P1/P2/P5 skipped
});

test("same-phase rejects retry the author, then escalate to operator when P1 breaches its cap of 3", async () => {
  const phases = allPass();
  const req = scripted([{ status: "reject", reasons: ["a"] }, { status: "reject", reasons: ["b"] }, { status: "reject", reasons: ["c"] }, { status: "reject", reasons: ["d"] }]);
  phases.requirements = req.run;
  const out = await run("standard", phases);
  // requirements is an operator gate → cap breach pauses for a human, not a silent block
  expect(out.status).toBe("operator_required");
  expect(out.phaseReached).toBe("requirements");
  expect(out.trace.loopbackCount.requirements).toBe(4);
});

test("design (P2) cap breach fails autonomously (not an operator gate) — blocked, no human", async () => {
  const phases = allPass();
  phases.design = scripted([{ status: "reject", reasons: ["x"] }, { status: "reject", reasons: ["y"] }, { status: "reject", reasons: ["z"] }]).run; // cap 2 → 3rd breaches
  const out = await run("standard", phases);
  expect(out.status).toBe("blocked");
  expect(out.phaseReached).toBe("design");
});

test("a within-cap reject retries the same phase and then proceeds", async () => {
  const phases = allPass();
  const req = scripted([{ status: "reject", reasons: ["fixme"] }, PASS]); // reject once, then pass
  phases.requirements = req.run;
  const out = await run("standard", phases);
  expect(out.status).toBe("shipped");
  expect(req.visits).toBe(2);
  expect(out.trace.loopbackCount.requirements).toBe(1);
});

test("a cross-phase loop-back (P5 → P1) rewinds and re-runs the downstream phases", async () => {
  const phases = allPass();
  const order: PipelinePhase[] = [];
  for (const p of ["requirements", "design", "implementation", "verification", "validation", "transfer"] as PipelinePhase[]) {
    phases[p] = async () => {
      order.push(p);
      return PASS;
    };
  }
  // validation bounces to requirements once (built-vs-asked gap), then passes.
  let vCount = 0;
  phases.validation = async () => {
    order.push("validation");
    return vCount++ === 0 ? { status: "loopback", to: "requirements", reason: "need misunderstood" } : PASS;
  };
  const out = await run("standard", phases);
  expect(out.status).toBe("shipped");
  // requirements appears twice (initial + after the bounce)
  expect(order.filter((p) => p === "requirements").length).toBe(2);
  expect(out.trace.loopbackCount.requirements).toBe(1);
});

test("high-tier validation pauses for the operator even on a clean pass", async () => {
  const out = await run("high", allPass());
  expect(out.status).toBe("operator_required");
  expect(out.phaseReached).toBe("validation");
});

test("a CRITICAL escalate at a non-operator gate blocks; at an operator gate it pages the operator", async () => {
  const blocked = await run("standard", { ...allPass(), verification: async () => ({ status: "escalate", reason: "unrecoverable" }) });
  expect(blocked.status).toBe("blocked");
  expect(blocked.phaseReached).toBe("verification");

  const paged = await run("standard", { ...allPass(), validation: async () => ({ status: "escalate", reason: "ambiguous need" }) });
  expect(paged.status).toBe("operator_required");
  expect(paged.phaseReached).toBe("validation");
});

test("firstVisit is true only on the first execution of a phase", async () => {
  const seen: boolean[] = [];
  const phases = allPass();
  phases.requirements = async (ctx) => {
    seen.push(ctx.firstVisit);
    return seen.length < 2 ? { status: "reject", reasons: ["again"] } : PASS;
  };
  await run("standard", phases);
  expect(seen).toEqual([true, false]); // first submission, then a revision
});

test("aborting mid-run stops the pipeline as blocked", async () => {
  const ac = new AbortController();
  const trace = newTrace("t", "x");
  const phases = allPass();
  phases.design = async () => {
    ac.abort();
    return PASS;
  };
  const out = await runPipeline(trace, "standard", { phases, signal: ac.signal });
  expect(out.status).toBe("blocked");
  expect(out.reason).toContain("aborted");
});

test("missing a phase implementation for the tier throws (fail fast)", async () => {
  const trace = newTrace("t", "x");
  await expect(runPipeline(trace, "standard", { phases: { requirements: async () => PASS } })).rejects.toThrow(/missing phase implementations/);
});
