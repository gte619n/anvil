import { test, expect } from "bun:test";
import { PermissionBroker, makePreToolUseHook } from "../../src/agent/permissions";
import type { Session } from "../../src/session/session";

/** Minimal Session stub. `mostly-autonomous` + read-only tools auto-allow without parking. */
function fakeSession(autonomy = "mostly-autonomous"): Session {
  return {
    id: "sess_1",
    data: { autonomy, cwd: "/tmp" },
    isAlwaysAllowed: () => false,
    rememberAllow: () => {},
    requestPermission: () => {},
  } as unknown as Session;
}

const ctx = { signal: new AbortController().signal } as any;

// Regression guard for the "interview mode" bug: a PreToolUse hook that returns ANY concrete
// permission decision (even "allow") for AskUserQuestion short-circuits the permission flow before
// canUseTool — so the tool runs with empty answers and the model continues with "The user did not
// answer the questions." The hook MUST fall through with no decision so the tool's "ask" verdict
// reaches canUseTool, where the question card is surfaced and the answer fed back via updatedInput.
test("AskUserQuestion falls through with no permission decision (so 'ask' reaches canUseTool)", async () => {
  const hook = makePreToolUseHook(fakeSession(), new PermissionBroker());
  const out = (await hook({ tool_name: "AskUserQuestion", tool_input: { questions: [] } } as any, "tool_1", ctx)) as any;
  expect(out).toEqual({ continue: true });
  // Crucially, it must NOT carry a permission decision (that is what short-circuits canUseTool).
  expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
});

test("other tools still receive a permission decision from the hook", async () => {
  const hook = makePreToolUseHook(fakeSession(), new PermissionBroker());
  const out = (await hook({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } } as any, "tool_2", ctx)) as any;
  expect(out.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
  expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
});

test("ExitPlanMode runs the plan-review hook with the plan text, then still decides", async () => {
  const seen: string[] = [];
  const hook = makePreToolUseHook(fakeSession(), new PermissionBroker(), async (plan) => {
    seen.push(plan);
  });
  const out = (await hook(
    { tool_name: "ExitPlanMode", tool_input: { plan: "## Step 1\ndo the thing" } } as any,
    "tool_3",
    ctx,
  )) as any;
  expect(seen).toEqual(["## Step 1\ndo the thing"]);
  // Advisory: the review runs but the tool is still gated by the normal permission decision.
  expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
});

test("plan review is advisory — a throwing reviewer never blocks ExitPlanMode", async () => {
  const hook = makePreToolUseHook(fakeSession(), new PermissionBroker(), async () => {
    throw new Error("openrouter down");
  });
  const out = (await hook({ tool_name: "ExitPlanMode", tool_input: { plan: "x" } } as any, "tool_4", ctx)) as any;
  expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
});

test("the plan-review hook does NOT fire for ordinary tools", async () => {
  let fired = false;
  const hook = makePreToolUseHook(fakeSession(), new PermissionBroker(), async () => {
    fired = true;
  });
  await hook({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } } as any, "tool_5", ctx);
  expect(fired).toBe(false);
});
