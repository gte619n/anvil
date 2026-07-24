/**
 * Regression guard for the "Autopilot refine spinner turns forever" bug.
 *
 * refinePlanQuery runs a plan-mode (readonly) SDK query, where the model delivers its plan via an
 * approval-gated `ExitPlanMode` tool call. With no PreToolUse hook (and no canUseTool) that ask has
 * no responder and the query never reaches a terminal result — the run blocks forever and, because
 * refine has no watchdog, the client spinner never resolves. The fix installs the same SEC-H4
 * PreToolUse guard hook the dev pipeline uses, so ExitPlanMode is ALLOWED and the run completes.
 *
 * These assert, through the injectable query seam:
 *   1. refine installs a PreToolUse hook in plan mode whose decision for ExitPlanMode is "allow",
 *   2. refine actually completes (returns the plan) when the query yields an ExitPlanMode block.
 */
import { test, expect } from "bun:test";
import { refinePlanQuery } from "../../src/integrations/autopilot";
import type { QueryLike } from "../../src/agent/query";

// A `claude`-profile spawn now REQUIRES a subscription token (agent/env.ts) — a tokenless machine
// fails loudly with a pair-this-machine message instead of an opaque SDK error. These tests drive
// the SDK layer with a fake query, so give them a placeholder credential to get past that gate.
process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";

/** A fake SDK query that captures the options and yields a canned ExitPlanMode plan + result. */
function captureQuery(): { fn: QueryLike; opts: () => Record<string, any> } {
  let captured: Record<string, any> = {};
  const fn: QueryLike = (args) => {
    captured = args.options;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant", message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: "REVISED PLAN" } }] } };
        yield { type: "result", result: "the plan is ready" };
      },
    };
  };
  return { fn, opts: () => captured };
}

test("refine installs a PreToolUse hook that ALLOWS ExitPlanMode (so the plan-mode query can terminate)", async () => {
  const cap = captureQuery();
  await refinePlanQuery({ title: "t", currentPlan: "old", feedback: "make it better", repoRoot: "/repo", queryFn: cap.fn });

  const o = cap.opts();
  expect(o.permissionMode).toBe("plan"); // refine is readonly → plan mode → ExitPlanMode is the delivery path
  const hooks = (o.hooks as any)?.PreToolUse;
  expect(Array.isArray(hooks)).toBe(true);
  const installed = hooks[0].hooks[0] as (i: unknown) => Promise<any>;
  // The exact op that pinned the spinner: without an allow decision here, plan mode never exits.
  const verdict = await installed({ tool_name: "ExitPlanMode", tool_input: { plan: "x" } });
  expect(verdict.hookSpecificOutput.permissionDecision).toBe("allow");
});

test("refine returns the revised plan captured from the ExitPlanMode call", async () => {
  const cap = captureQuery();
  const res = await refinePlanQuery({ title: "t", currentPlan: "old", feedback: "fix", repoRoot: "/repo", queryFn: cap.fn });
  expect(res.plan).toBe("REVISED PLAN");
});
