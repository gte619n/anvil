/**
 * Codebase-grounded model intake (loops-circuit FU-1, extended). Proves the JSON parse/validation is
 * strict, the run is driven by an injectable `queryFn` (no subprocess / model spend), each tool the agent
 * uses streams through `onStep`, and every malformed reply throws so the LoopService caller falls back to
 * the heuristic. In plan mode the agent answers via ExitPlanMode (captured as `plan`); we parse that.
 */
import { test, expect } from "bun:test";
import { modelIntake, parseOverlay, type IntakeQueryLike } from "../../src/loops/intake-model";
import type { ModelSpec } from "../../src/agent/model-roster";

// runAgentQuery builds the agent env (which requires a Claude token) before it ever touches the injected
// queryFn, so give it a dummy — no subprocess is spawned, and in production a missing token just makes
// modelIntake throw and the caller falls back to the heuristic.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= "test-token";

const ctx = { prompt: "Add CSV export to reports", isFeature: true, testScript: "bun test" };
const SONNET: ModelSpec = { id: "claude", profile: "claude", sdkModel: "sonnet", label: "Claude Sonnet" };

/** A scripted SDK `query`: yields optional tool_use steps, then delivers `reply` as the final result. */
function scripted(reply: string, steps: { name: string; input?: Record<string, unknown> }[] = []): IntakeQueryLike {
  return () =>
    (async function* () {
      if (steps.length) yield { type: "assistant", message: { content: steps.map((s) => ({ type: "tool_use", name: s.name, input: s.input ?? {} })) } };
      yield { type: "result", result: reply };
    })();
}

/** A scripted agent that answers via ExitPlanMode (the plan-mode shape the real intake uses). */
function scriptedPlan(plan: string, steps: { name: string; input?: Record<string, unknown> }[] = []): IntakeQueryLike {
  return () =>
    (async function* () {
      if (steps.length) yield { type: "assistant", message: { content: steps.map((s) => ({ type: "tool_use", name: s.name, input: s.input ?? {} })) } };
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan } }] } };
      yield { type: "result", result: "" };
    })();
}

test("parseOverlay accepts a well-formed object and caps the rung at pr", () => {
  const o = parseOverlay(
    `{"name":"CSV export","checkCommand":"bun test export","checkLocks":["test/export.test.ts"],"scopeAllow":["src/reports/"],"assumptions":["comma delimiter"],"rung":"ship"}`,
    ctx,
  );
  expect(o.name).toBe("CSV export");
  expect(o.checkCommand).toBe("bun test export");
  expect(o.checkLocks).toEqual(["test/export.test.ts"]);
  expect(o.scopeAllow).toEqual(["src/reports/"]);
  expect(o.assumptions).toEqual(["comma delimiter"]);
  expect(o.rung).toBeUndefined(); // "ship" is refused — a new loop can't be trusted into auto-merge
});

test("parseOverlay pulls JSON out of surrounding prose/fences", () => {
  const o = parseOverlay("Sure! Here you go:\n```json\n{\"checkCommand\":\"bun test\"}\n```\nHope that helps", ctx);
  expect(o.checkCommand).toBe("bun test");
});

test("parseOverlay throws on no JSON, on invalid JSON, and on an all-empty object", () => {
  expect(() => parseOverlay("no json here", ctx)).toThrow();
  expect(() => parseOverlay("{not valid json}", ctx)).toThrow();
  expect(() => parseOverlay("{}", ctx)).toThrow(/no usable fields/);
  // An object with only junk/blank fields is also unusable.
  expect(() => parseOverlay(`{"name":"   ","checkLocks":[]}`, ctx)).toThrow();
});

test("modelIntake drives the injected query and returns the parsed overlay", async () => {
  const overlay = await modelIntake(ctx, { model: SONNET, queryFn: scripted(`{"checkCommand":"bun test export","rung":"draft"}`) });
  expect(overlay.checkCommand).toBe("bun test export");
  expect(overlay.rung).toBe("draft");
});

test("modelIntake reads the repo, streams each step via onStep, and parses the overlay from the plan", async () => {
  const seen: { tool: string; detail: string }[] = [];
  const q = scriptedPlan(`{"checkCommand":"bun test export","scopeAllow":["src/reports/"]}`, [
    { name: "Read", input: { file_path: "/repo/CLAUDE.md" } },
    { name: "Grep", input: { pattern: "export" } },
  ]);
  const overlay = await modelIntake(
    { prompt: "Add export", isFeature: true, repoRoot: "/repo" },
    { model: SONNET, onStep: (s) => seen.push(s), queryFn: q },
  );
  expect(overlay.checkCommand).toBe("bun test export"); // parsed from the ExitPlanMode plan
  expect(overlay.scopeAllow).toEqual(["src/reports/"]);
  expect(seen.map((s) => s.tool)).toEqual(["Read", "Grep"]);
  expect(seen[0]?.detail).toBe("/repo/CLAUDE.md"); // ExitPlanMode itself is not reported as a step
});

test("modelIntake throws on a garbage reply (caller falls back to the heuristic)", async () => {
  await expect(modelIntake(ctx, { model: SONNET, queryFn: scripted("I couldn't do that") })).rejects.toThrow();
});
