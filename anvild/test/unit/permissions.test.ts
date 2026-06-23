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
// permission decision (even "allow") for AskUserQuestion preempts the CLI's
// permission_ask_user_question dialog — onUserDialog never fires, the tool runs with empty answers,
// and the model continues with "The user did not answer the questions." The hook MUST fall through
// with no decision so the native question dialog (the card) is shown.
test("AskUserQuestion falls through with no permission decision (lets the dialog fire)", async () => {
  const hook = makePreToolUseHook(fakeSession(), new PermissionBroker());
  const out = (await hook({ tool_name: "AskUserQuestion", tool_input: { questions: [] } } as any, "tool_1", ctx)) as any;
  expect(out).toEqual({ continue: true });
  // Crucially, it must NOT carry a permission decision (that is what suppresses the dialog).
  expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
});

test("other tools still receive a permission decision from the hook", async () => {
  const hook = makePreToolUseHook(fakeSession(), new PermissionBroker());
  const out = (await hook({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } } as any, "tool_2", ctx)) as any;
  expect(out.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
  expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
});
