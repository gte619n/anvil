/**
 * [F0] The protected check (agent-cad-and-browser spec §4.4). A registered rule is consulted at the
 * very top of the permission gate — before the remembered-allow lookup and before `bypass` — so a
 * "deny" can't be skipped and an "always-prompt" action is asked every single time with no "always
 * allow". With NO rule registered the gate must behave exactly as before (permissions.test.ts pins
 * that; the last tests here pin it against an explicit no-opinion rule too).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { PermissionSuggestion } from "@protocol";
import { PermissionBroker, makePreToolUseHook } from "../../src/agent/permissions";
import {
  isUnattended,
  protectedVerdict,
  registerProtectedRule,
  resetProtectedRulesForTest,
  type ProtectedRule,
} from "../../src/agent/protected";
import { QuestionBroker, makeCanUseTool } from "../../src/agent/questions";
import type { Session } from "../../src/session/session";

interface Asked {
  requestId: string;
  tool: string;
  suggestions: PermissionSuggestion[];
}

/** A Session stub that really remembers allows, so "not remembered" is observable. */
function fakeSession(data: Record<string, unknown> = {}) {
  const asked: Asked[] = [];
  const remembered = new Set<string>();
  const session = {
    id: "sess_1",
    data: { autonomy: "mostly-autonomous", cwd: "/tmp/wt", ...data },
    isAlwaysAllowed: (tool: string) => remembered.has(tool),
    rememberAllow: (tool: string) => void remembered.add(tool),
    requestPermission: (requestId: string, tool: string, _input: unknown, suggestions: PermissionSuggestion[]) => {
      asked.push({ requestId, tool, suggestions });
    },
  } as unknown as Session;
  return { session, asked, remembered };
}

const ctx = { signal: new AbortController().signal } as any;
const decisionOf = (out: any) => out.hookSpecificOutput?.permissionDecision as string | undefined;
const reasonOf = (out: any) => out.hookSpecificOutput?.permissionDecisionReason as string | undefined;
const call = (hook: ReturnType<typeof makePreToolUseHook>, tool: string, input: Record<string, unknown> = {}) =>
  hook({ tool_name: tool, tool_input: input } as any, "tool_x", ctx) as Promise<any>;
/** Let the hook reach its parked prompt. */
const tick = () => new Promise((r) => setTimeout(r, 0));

const denyRelease: ProtectedRule = ({ tool }) => (tool === "Release" ? { kind: "deny", reason: "release is locked" } : undefined);
const promptRelease: ProtectedRule = ({ tool }) =>
  tool === "Release" ? { kind: "always-prompt", reason: "releasing a part", label: "Release this part" } : undefined;
const promptReleaseAttendedOnly: ProtectedRule = ({ tool }) =>
  tool === "Release" ? { kind: "always-prompt", reason: "releasing a part", denyWhenUnattended: true } : undefined;

afterEach(() => resetProtectedRulesForTest());

describe("protected rule registry", () => {
  test("[F0] no rule registered → no verdict", () => {
    const { session } = fakeSession();
    expect(protectedVerdict({ session, tool: "Release", input: {}, cwd: "/tmp/wt" })).toBeUndefined();
  });

  test("[F0] the first non-undefined verdict wins, and a rule sees tool, input and cwd", () => {
    const seen: unknown[] = [];
    registerProtectedRule((c) => {
      seen.push([c.tool, c.input, c.cwd, c.session.id]);
      return undefined;
    });
    registerProtectedRule(() => ({ kind: "always-prompt", reason: "first" }));
    registerProtectedRule(() => ({ kind: "always-prompt", reason: "second" }));
    const { session } = fakeSession();
    const v = protectedVerdict({ session, tool: "Edit", input: { file_path: "a" }, cwd: "/tmp/wt" });
    expect(v).toEqual({ kind: "always-prompt", reason: "first" });
    expect(seen).toEqual([["Edit", { file_path: "a" }, "/tmp/wt", "sess_1"]]);
  });

  test("[F0] deny outranks always-prompt regardless of registration order", () => {
    registerProtectedRule(promptRelease);
    registerProtectedRule(denyRelease);
    const { session } = fakeSession();
    expect(protectedVerdict({ session, tool: "Release", input: {}, cwd: "/tmp/wt" })).toEqual({ kind: "deny", reason: "release is locked" });
  });

  test("[F0] a throwing rule fails closed (deny)", () => {
    registerProtectedRule(() => {
      throw new Error("boom");
    });
    const { session } = fakeSession();
    const v = protectedVerdict({ session, tool: "Read", input: {}, cwd: "/tmp/wt" });
    expect(v?.kind).toBe("deny");
    expect(v?.reason).toContain("boom");
  });

  test("[F0] registering is idempotent and the returned thunk unregisters", () => {
    const off = registerProtectedRule(denyRelease);
    registerProtectedRule(denyRelease);
    const { session } = fakeSession();
    const c = { session, tool: "Release", input: {}, cwd: "/tmp/wt" };
    expect(protectedVerdict(c)?.kind).toBe("deny");
    off();
    expect(protectedVerdict(c)).toBeUndefined();
  });

  test("[F0] isUnattended is true only for an autopilot builder session", () => {
    expect(isUnattended(fakeSession({ workUnitRole: "builder" }).session)).toBe(true);
    expect(isUnattended(fakeSession({ workUnitRole: "planner" }).session)).toBe(false);
    expect(isUnattended(fakeSession().session)).toBe(false);
  });
});

describe("protected check in the permission gate", () => {
  test("[F0] deny beats bypass, with the rule's reason and no prompt", async () => {
    registerProtectedRule(denyRelease);
    const { session, asked } = fakeSession({ autonomy: "bypass" });
    const out = await call(makePreToolUseHook(session, new PermissionBroker()), "Release");
    expect(decisionOf(out)).toBe("deny");
    expect(reasonOf(out)).toBe("release is locked");
    expect(asked).toHaveLength(0);
  });

  test("[F0] deny beats a remembered allow for the same tool", async () => {
    registerProtectedRule(denyRelease);
    const { session, asked, remembered } = fakeSession();
    remembered.add("Release");
    const out = await call(makePreToolUseHook(session, new PermissionBroker()), "Release");
    expect(decisionOf(out)).toBe("deny");
    expect(asked).toHaveLength(0);
  });

  test("[F0] always-prompt prompts under bypass", async () => {
    registerProtectedRule(promptRelease);
    const broker = new PermissionBroker();
    const { session, asked } = fakeSession({ autonomy: "bypass" });
    const outP = call(makePreToolUseHook(session, broker), "Release", { part: "plate" });
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.tool).toBe("Release");
    expect(broker.resolve(asked[0]!.requestId, "allow")).toBe(true);
    const out = await outP;
    expect(decisionOf(out)).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput).toEqual({ part: "plate" });
  });

  test("[F0] always-prompt prompts even after a prior rememberAllow for the same tool", async () => {
    registerProtectedRule(promptRelease);
    const broker = new PermissionBroker();
    const { session, asked } = fakeSession();
    session.rememberAllow("Release");
    expect(session.isAlwaysAllowed("Release")).toBe(true);
    const outP = call(makePreToolUseHook(session, broker), "Release");
    await tick();
    expect(asked).toHaveLength(1);
    broker.resolve(asked[0]!.requestId, "deny");
    const out = await outP;
    expect(decisionOf(out)).toBe("deny");
    expect(reasonOf(out)).toContain("releasing a part");
  });

  test("[F0] an always-prompt card offers Allow once / Deny only — no allow_always suggestion", async () => {
    registerProtectedRule(promptRelease);
    const broker = new PermissionBroker();
    const { session, asked } = fakeSession({ autonomy: "prompt-all" });
    const outP = call(makePreToolUseHook(session, broker), "Release");
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.suggestions.map((s) => s.decision)).toEqual(["allow", "deny"]);
    expect(asked[0]!.suggestions.some((s) => s.decision === "allow_always")).toBe(false);
    // The rule's label names the allow button.
    expect(asked[0]!.suggestions[0]!.label).toBe("Release this part");
    broker.resolve(asked[0]!.requestId, "deny");
    await outP;
  });

  test("[F0] an allow_always answer is an allow-once and is never remembered", async () => {
    registerProtectedRule(promptRelease);
    const broker = new PermissionBroker();
    const { session, asked, remembered } = fakeSession();
    const hook = makePreToolUseHook(session, broker);

    const first = call(hook, "Release");
    await tick();
    expect(asked).toHaveLength(1);
    broker.resolve(asked[0]!.requestId, "allow_always");
    expect(decisionOf(await first)).toBe("allow");
    expect(remembered.has("Release")).toBe(false);
    expect(session.isAlwaysAllowed("Release")).toBe(false);

    // …so the very next call is asked again.
    const second = call(hook, "Release");
    await tick();
    expect(asked).toHaveLength(2);
    broker.resolve(asked[1]!.requestId, "allow");
    expect(decisionOf(await second)).toBe("allow");
  });

  test("[F0] unattended + denyWhenUnattended denies with no request emitted", async () => {
    registerProtectedRule(promptReleaseAttendedOnly);
    const { session, asked } = fakeSession({ autonomy: "bypass", workUnitId: "wu_1", workUnitRole: "builder" });
    const out = await call(makePreToolUseHook(session, new PermissionBroker()), "Release");
    expect(decisionOf(out)).toBe("deny");
    expect(reasonOf(out)).toContain("unattended");
    expect(asked).toHaveLength(0);
  });

  test("[F0] an attended session with denyWhenUnattended still gets the card", async () => {
    registerProtectedRule(promptReleaseAttendedOnly);
    const broker = new PermissionBroker();
    const { session, asked } = fakeSession({ workUnitId: "wu_1", workUnitRole: "planner" });
    const outP = call(makePreToolUseHook(session, broker), "Release");
    await tick();
    expect(asked).toHaveLength(1);
    broker.resolve(asked[0]!.requestId, "allow");
    expect(decisionOf(await outP)).toBe("allow");
  });

  test("[F0] an unattended session without denyWhenUnattended is still prompted", async () => {
    registerProtectedRule(promptRelease);
    const broker = new PermissionBroker();
    const { session, asked } = fakeSession({ workUnitRole: "builder" });
    const outP = call(makePreToolUseHook(session, broker), "Release");
    await tick();
    expect(asked).toHaveLength(1);
    broker.resolve(asked[0]!.requestId, "deny");
    expect(decisionOf(await outP)).toBe("deny");
  });

  test("[F0] a tool no rule covers is unchanged: bypass allows, remembered allow allows", async () => {
    registerProtectedRule(denyRelease);
    registerProtectedRule(promptRelease);
    const bypass = fakeSession({ autonomy: "bypass" });
    const a = await call(makePreToolUseHook(bypass.session, new PermissionBroker()), "Bash", { command: "rm -rf /" });
    expect(decisionOf(a)).toBe("allow");
    expect(reasonOf(a)).toBe("bypass: permissions skipped");
    expect(bypass.asked).toHaveLength(0);

    const remembered = fakeSession({ autonomy: "prompt-all" });
    remembered.session.rememberAllow("Edit");
    const b = await call(makePreToolUseHook(remembered.session, new PermissionBroker()), "Edit", { file_path: "/tmp/wt/a" });
    expect(decisionOf(b)).toBe("allow");
    expect(reasonOf(b)).toBe("remembered allow");
    expect(remembered.asked).toHaveLength(0);
  });

  test("[F0] with no rule, the normal prompt keeps its three suggestions and allow_always is remembered", async () => {
    const broker = new PermissionBroker();
    const { session, asked, remembered } = fakeSession({ autonomy: "prompt-all" });
    const outP = call(makePreToolUseHook(session, broker), "Edit", { file_path: "/tmp/wt/a" });
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.suggestions).toEqual([
      { decision: "allow", label: "Allow once" },
      { decision: "allow_always", label: "Always allow Edit this session" },
      { decision: "deny", label: "Deny" },
    ]);
    broker.resolve(asked[0]!.requestId, "allow_always");
    const out = await outP;
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: undefined,
        updatedInput: { file_path: "/tmp/wt/a" },
      },
    });
    expect(remembered.has("Edit")).toBe(true);
  });
});

describe("canUseTool MCP backstop", () => {
  const opts = { signal: new AbortController().signal, toolUseID: "tool_1" } as any;
  const session = { id: "sess_1", requestQuestion: () => {} } as unknown as Session;

  test("[F0] an mcp__ tool reaching canUseTool is denied (fail closed)", async () => {
    const canUseTool = makeCanUseTool(session, new QuestionBroker());
    const res = (await canUseTool("mcp__github__create_issue", { title: "x" }, opts)) as any;
    expect(res.behavior).toBe("deny");
    expect(res.message).toContain("mcp__github__create_issue");
  });

  test("[F0] the session's own role tools (allowedTools) still pass canUseTool", async () => {
    const canUseTool = makeCanUseTool(session, new QuestionBroker(), ["mcp__anvil__list_sessions", "mcp__anvil_team__create_member"]);
    expect(await canUseTool("mcp__anvil__list_sessions", {}, opts)).toEqual({ behavior: "allow", updatedInput: {} });
    expect(await canUseTool("mcp__anvil_team__create_member", { a: 1 }, opts)).toEqual({ behavior: "allow", updatedInput: { a: 1 } });
    // …but an MCP tool outside that list is still refused, even from the same server prefix.
    expect(((await canUseTool("mcp__anvil__not_a_role_tool", {}, opts)) as any).behavior).toBe("deny");
  });

  test("[F0] non-MCP tools are unaffected by the backstop", async () => {
    const canUseTool = makeCanUseTool(session, new QuestionBroker());
    expect(await canUseTool("Read", { file_path: "/tmp/x" }, opts)).toEqual({ behavior: "allow", updatedInput: { file_path: "/tmp/x" } });
  });
});
