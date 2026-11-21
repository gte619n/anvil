/**
 * [C1] The MCP branch of the permission gate (mcp-integrations spec §4.4, §7) and the canUseTool
 * backstop. The hook is called directly; the registry behind it is the real service on a real
 * Supervisor (fake prober, fake clock).
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import type { McpIntegration } from "@protocol";
import { parseMcpTool, isInProcessTool, registerMcpKindGate, resetMcpKindGatesForTest, type McpHookContext } from "../../src/agent/mcp-gate";
import { registerMcpPreset } from "../../src/mcp/presets";
import { registerProtectedRule, resetProtectedRulesForTest } from "../../src/agent/protected";
import { makeCanUseTool, QuestionBroker } from "../../src/agent/questions";
import type { Session } from "../../src/session/session";
import { callHook, echoInput, isPending, mcpRig, parked, type McpRig } from "../helpers/mcp";

let rig: McpRig;
let echo: McpIntegration;
let s: Session;
let ctx: McpHookContext;
const undo: (() => void)[] = [];

beforeEach(async () => {
  rig = mcpRig();
  echo = rig.sup.mcp.add(echoInput());
  s = await rig.session();
  rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
  ctx = { inProcessKeys: [], gate: rig.sup.mcp.gate };
});
afterEach(async () => {
  for (const u of undo.splice(0)) u();
  resetMcpKindGatesForTest();
  resetProtectedRulesForTest();
  await rig.cleanup();
});

const hook = (tool: string, session: Session = s, c: McpHookContext | undefined = ctx, input: Record<string, unknown> = {}) => callHook(session, rig.broker, tool, c, input);
const answer = (session: Session, decision: "allow" | "allow_always" | "deny") => rig.sup.resolvePermission(parked(session).requestId, decision);

describe("integration tools", () => {
  test("[C1] under mostly-autonomous an integration call parks a permission request with Allow once / Always allow <label> this session / Deny", async () => {
    const p = hook("mcp__echo__ping");
    expect(await isPending(p)).toBe(true);
    const req = parked(s);
    expect(req.tool).toBe("mcp__echo__ping");
    expect(req.suggestions).toEqual([
      { decision: "allow", label: "Allow once" },
      { decision: "allow_always", label: "Always allow Echo this session" },
      { decision: "deny", label: "Deny" },
    ]);
    expect(s.data.status).toBe("awaiting_permission");
    answer(s, "allow");
    expect((await p).decision).toBe("allow");
    expect(s.data.mcpAllowed).toBeUndefined(); // "Allow once" remembers nothing
    // …so the next call prompts again.
    const again = hook("mcp__echo__ping");
    expect(await isPending(again)).toBe(true);
    answer(s, "deny");
    expect(await again).toEqual({ decision: "deny", reason: "denied by user" });
  });

  test("[C1] answering always lets every tool of that integration through with no prompt, and is recorded in session.mcpAllowed", async () => {
    const p = hook("mcp__echo__ping");
    await isPending(p);
    answer(s, "allow_always");
    expect((await p).decision).toBe("allow");
    expect(s.data.mcpAllowed).toEqual([echo.id]);
    expect(s.isAlwaysAllowed("mcp__echo__ping")).toBe(false); // separate from the per-tool always-allow set
    expect((await hook("mcp__echo__pong")).decision).toBe("allow"); // a DIFFERENT tool: the rule is the server key
    expect(s.pendingPermissions.size).toBe(0);
  });

  test("[C1] switching the integration off for the session denies immediately with no prompt; switching it back on prompts again", async () => {
    const p = hook("mcp__echo__ping");
    await isPending(p);
    answer(s, "allow_always");
    await p;

    rig.sup.setSessionMcpIntegrations(s.id, []);
    expect(s.data.mcpAllowed).toBeUndefined(); // the allow went with it
    const off = await hook("mcp__echo__ping");
    expect(off.decision).toBe("deny");
    expect(off.reason).toMatch(/not switched on for this session/);
    expect(s.pendingPermissions.size).toBe(0);

    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
    const back = hook("mcp__echo__ping");
    expect(await isPending(back)).toBe(true); // the earlier "always" did not survive
    answer(s, "allow");
    expect((await back).decision).toBe("allow");
  });

  test("[C1] an unknown mcp__<key>__ tool is denied with no prompt", async () => {
    const out = await hook("mcp__other__x");
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/unknown MCP server/);
    expect(s.pendingPermissions.size).toBe(0);
    // Under bypass too, and for names that are not even well-formed.
    s.data.autonomy = "bypass";
    for (const t of ["mcp__other__x", "mcp__", "mcp__echo", "mcp__echo_evil__x", "mcp__anvil__list_sessions"]) {
      expect((await hook(t)).decision).toBe("deny");
    }
  });

  test("[C1] bypass allows an integration call with no prompt", async () => {
    s.data.autonomy = "bypass";
    expect(await hook("mcp__echo__ping")).toEqual({ decision: "allow", reason: "bypass: permissions skipped" });
    expect(s.pendingPermissions.size).toBe(0);
    expect(s.data.mcpAllowed).toBeUndefined();
  });

  test("[C1] every non-bypass policy prompts — there is no follow-the-autonomy-policy mode", async () => {
    for (const autonomy of ["prompt-all", "allowlist", "mostly-autonomous"] as const) {
      s.data.autonomy = autonomy;
      const p = hook("mcp__echo__ping");
      expect(await isPending(p)).toBe(true);
      answer(s, "deny");
      expect((await p).decision).toBe("deny");
    }
  });

  test("[C1] the branch runs before the remembered-allow lookup: a per-tool always-allow does not skip it", async () => {
    s.rememberAllow("mcp__echo__ping");
    s.rememberAllow("mcp__other__x");
    expect((await hook("mcp__other__x")).decision).toBe("deny");
    const p = hook("mcp__echo__ping");
    expect(await isPending(p)).toBe(true);
    answer(s, "deny");
    await p;
  });

  test("[C1] an integration switched off in Settings is denied, even with an always-allow and under bypass", async () => {
    const p = hook("mcp__echo__ping");
    await isPending(p);
    answer(s, "allow_always");
    await p;
    rig.sup.mcpIntegrationUpdate(echo.id, { enabled: false });
    const out = await hook("mcp__echo__ping");
    expect(out).toEqual({ decision: "deny", reason: "Echo is switched off in Settings" });
    s.data.autonomy = "bypass";
    expect((await hook("mcp__echo__ping")).decision).toBe("deny");
  });

  test("[C1] the lookup is live: switching off while a prompt is parked denies the call even if it is then approved", async () => {
    const p = hook("mcp__echo__ping");
    expect(await isPending(p)).toBe(true);
    const requestId = parked(s).requestId;
    rig.sup.setSessionMcpIntegrations(s.id, []);
    rig.sup.resolvePermission(requestId, "allow_always");
    const out = await p;
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/not switched on/);
    expect(s.data.mcpAllowed).toBeUndefined(); // a refused approval is not remembered
  });

  test("[C1] an integration is denied in a session that is not an ordinary one", async () => {
    for (const over of [{ isDefault: true }, { teamRole: "lead" }, { teamRole: "member", parentId: "x" }, { workUnitRole: "planner", workUnitId: "wu" }, { workUnitRole: "builder", workUnitId: "wu" }] as const) {
      const other = await rig.session({ autonomy: "bypass" });
      rig.sup.setSessionMcpIntegrations(other.id, [echo.id]);
      Object.assign(other.data, over);
      const out = await hook("mcp__echo__ping", other);
      expect(out.decision).toBe("deny");
      expect(out.reason).toMatch(/not available in this kind of session/);
    }
  });

  test("[C1] another session's integration list does not leak: a session without it on is denied", async () => {
    const other = await rig.session({ autonomy: "bypass" });
    expect((await hook("mcp__echo__ping", other)).decision).toBe("deny");
  });

  test("[C1] with no registry behind the hook every integration call is denied", async () => {
    s.data.autonomy = "bypass";
    expect((await hook("mcp__echo__ping", s, { inProcessKeys: [] })).decision).toBe("deny");
  });

  test("[C1] with the feature off the gate denies, whatever the store holds", async () => {
    const off = mcpRig({ features: [], stateDir: rig.dir }); // same state dir: the store has `echo`
    const t = await off.session({ autonomy: "bypass", mcpIntegrations: [echo.id] });
    expect((await callHook(t, off.broker, "mcp__echo__ping", { inProcessKeys: [], gate: off.sup.mcp.gate })).decision).toBe("deny");
    off.sup.mcp.stop();
  });
});

describe("the session's own in-process servers", () => {
  test("[C1] a key in the session's in-process server map keeps the existing behaviour — the four role servers and anvil_cad alike", async () => {
    const keys = ["anvil", "anvil_team", "anvil_member", "anvil_planning", "anvil_cad"];
    const c: McpHookContext = { inProcessKeys: keys, gate: rig.sup.mcp.gate };
    for (const k of keys) {
      // mostly-autonomous + not on the danger list → auto-allowed by policy, exactly as before.
      expect(await hook(`mcp__${k}__some_tool`, s, c)).toEqual({ decision: "allow", reason: "auto-allowed by autonomy policy" });
    }
    // prompt-all still prompts for them with the ordinary per-tool card, and "always" is per tool.
    s.data.autonomy = "prompt-all";
    const p = hook("mcp__anvil_cad__measure", s, c);
    expect(await isPending(p)).toBe(true);
    expect(parked(s).suggestions[1]).toEqual({ decision: "allow_always", label: "Always allow mcp__anvil_cad__measure this session" });
    answer(s, "allow_always");
    await p;
    expect(s.isAlwaysAllowed("mcp__anvil_cad__measure")).toBe(true);
    expect(s.data.mcpAllowed).toBeUndefined();
    // A role server's name is role → existing behaviour ONLY when it is in this session's map.
    expect((await hook("mcp__anvil_cad__measure", s, { inProcessKeys: ["anvil"], gate: rig.sup.mcp.gate })).decision).toBe("deny");
  });

  test("[C1] a hook built without an MCP context keeps the pre-registry behaviour for every tool", async () => {
    expect(await callHook(s, rig.broker, "mcp__anything__x", undefined)).toEqual({ decision: "allow", reason: "auto-allowed by autonomy policy" });
  });

  test("[C1] parseMcpTool splits integration names only; isInProcessTool matches whole keys", () => {
    expect(parseMcpTool("mcp__echo__ping")).toEqual({ key: "echo", tool: "ping" });
    expect(parseMcpTool("mcp__echo__browser__x")).toEqual({ key: "echo", tool: "browser__x" });
    expect(parseMcpTool("mcp__anvil_team__create_member")).toBeUndefined();
    expect(parseMcpTool("mcp__echo")).toBeUndefined();
    expect(parseMcpTool("Bash")).toBeUndefined();
    expect(isInProcessTool("mcp__anvil__x", ["anvil"])).toBe(true);
    expect(isInProcessTool("mcp__anvilx__x", ["anvil"])).toBe(false);
    expect(isInProcessTool("mcp__anvil_cad__x", ["anvil"])).toBe(false);
  });
});

describe("per-kind gate (the hook Phase C2 plugs into)", () => {
  /** A second integration of kind `browser`, on for the session. */
  function browser(): McpIntegration {
    undo.push(registerMcpPreset({ kind: "browser", title: "Browser" }));
    const b = rig.sup.mcp.add(echoInput({ key: "browser", kind: "browser", label: "Browser" }));
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id, b.id]);
    return b;
  }

  test("[C1] a kind gate sees the short tool name, the input and the integration, and only for its own kind", async () => {
    browser();
    const seen: unknown[] = [];
    registerMcpKindGate("browser", (c) => {
      seen.push({ tool: c.tool, fullTool: c.fullTool, input: c.input, key: c.integration.key, cwd: c.cwd, sid: c.session.id });
      return { kind: "allow", reason: "site already allowed" };
    });
    expect(await hook("mcp__browser__browser_navigate", s, ctx, { url: "https://a.test" })).toEqual({ decision: "allow", reason: "site already allowed" });
    expect(seen).toEqual([{ tool: "browser_navigate", fullTool: "mcp__browser__browser_navigate", input: { url: "https://a.test" }, key: "browser", cwd: s.data.cwd, sid: s.id }]);
    // `echo` is kind custom: the browser gate is not consulted and the generic prompt applies.
    const p = hook("mcp__echo__ping");
    expect(await isPending(p)).toBe(true);
    answer(s, "deny");
    await p;
    expect(seen).toHaveLength(1);
  });

  test("[C1] a kind gate's deny wins under bypass and over a session-wide allow", async () => {
    const b = browser();
    s.data.autonomy = "bypass";
    s.data.mcpAllowed = [b.id];
    registerMcpKindGate("browser", () => ({ kind: "deny", reason: "browser_run_code_unsafe is never allowed" }));
    expect(await hook("mcp__browser__browser_run_code_unsafe")).toEqual({ decision: "deny", reason: "browser_run_code_unsafe is never allowed" });
  });

  test("[C1] a kind gate's `always` prompt parks a card under bypass with its own choices; onAnswer records the kind's approval", async () => {
    browser();
    s.data.autonomy = "bypass";
    const answers: string[] = [];
    registerMcpKindGate("browser", () => ({
      kind: "prompt",
      always: true,
      reason: "click on a logged-in site",
      suggestions: [
        { decision: "allow", label: "Allow once" },
        { decision: "deny", label: "Deny" },
      ],
      onAnswer: (d) => void answers.push(d),
    }));
    const p = hook("mcp__browser__browser_click");
    expect(await isPending(p)).toBe(true);
    expect(parked(s).suggestions.map((x) => x.label)).toEqual(["Allow once", "Deny"]);
    answer(s, "allow_always"); // a client sending it anyway is NOT a session-wide allow for a kind prompt
    expect(await p).toEqual({ decision: "allow", reason: "click on a logged-in site" });
    expect(answers).toEqual(["allow_always"]);
    expect(s.data.mcpAllowed).toBeUndefined();
  });

  test("[C1] a kind gate's ordinary prompt is skipped under bypass, and onAnswer can still refuse", async () => {
    browser();
    registerMcpKindGate("browser", () => ({
      kind: "prompt",
      reason: "first visit to a.test",
      suggestions: [{ decision: "allow_always", label: "Allow a.test this session" }, { decision: "deny", label: "Deny" }],
      onAnswer: () => ({ deny: "a.test is on the logged-in list and there is no desktop session" }),
    }));
    const p = hook("mcp__browser__browser_navigate");
    expect(await isPending(p)).toBe(true);
    answer(s, "allow_always");
    expect(await p).toEqual({ decision: "deny", reason: "a.test is on the logged-in list and there is no desktop session" });
    s.data.autonomy = "bypass";
    expect((await hook("mcp__browser__browser_navigate")).decision).toBe("allow");
  });

  test("[C1] a kind gate with no opinion falls through to the generic flow, and one that throws fails closed", async () => {
    browser();
    registerMcpKindGate("browser", () => undefined);
    const p = hook("mcp__browser__browser_snapshot");
    expect(await isPending(p)).toBe(true);
    expect(parked(s).suggestions[1]!.label).toBe("Always allow Browser this session");
    answer(s, "allow");
    expect((await p).decision).toBe("allow");

    s.data.autonomy = "bypass";
    registerMcpKindGate("browser", () => {
      throw new Error("classifier crashed");
    });
    const out = await hook("mcp__browser__browser_snapshot");
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("classifier crashed");
  });

  test("[C1] the generic checks run before the kind gate: unknown, switched-off and locked calls never reach it", async () => {
    const b = browser();
    let calls = 0;
    registerMcpKindGate("browser", () => {
      calls++;
      return { kind: "allow" };
    });
    rig.sup.mcpIntegrationUpdate(b.id, { exclusive: true });
    const other = await rig.session({ autonomy: "bypass" });
    rig.sup.setSessionMcpIntegrations(other.id, [b.id]);
    expect((await hook("mcp__browser__x", other)).decision).toBe("allow"); // `other` now holds the lock
    expect(calls).toBe(1);
    expect((await hook("mcp__browser__x")).decision).toBe("deny"); // held by `other`
    rig.sup.setSessionMcpIntegrations(s.id, []);
    expect((await hook("mcp__browser__x")).decision).toBe("deny"); // not on for this session
    expect(calls).toBe(1);
  });
});

describe("protected rules and integrations", () => {
  test("[C1] a protected deny beats the integration branch; a protected always-prompt prompts under bypass with Allow once / Deny only", async () => {
    s.data.autonomy = "bypass";
    const off = registerProtectedRule((c) => (c.tool === "mcp__echo__ping" ? { kind: "always-prompt", reason: "sensitive echo" } : undefined));
    const p = hook("mcp__echo__ping");
    expect(await isPending(p)).toBe(true);
    expect(parked(s).suggestions.map((x) => x.decision)).toEqual(["allow", "deny"]);
    answer(s, "allow_always");
    expect(await p).toEqual({ decision: "allow", reason: "protected: sensitive echo" });
    expect(s.data.mcpAllowed).toBeUndefined();
    // …but an integration switched off still denies first.
    rig.sup.setSessionMcpIntegrations(s.id, []);
    expect((await hook("mcp__echo__ping")).decision).toBe("deny");
    off();
    registerProtectedRule(() => ({ kind: "deny", reason: "nope" }));
    expect(await hook("mcp__echo__ping")).toEqual({ decision: "deny", reason: "nope" });
  });
});

describe("canUseTool backstop", () => {
  test("[C1] canUseTool denies mcp__echo__ping: an integration call the hook did not decide fails closed", async () => {
    // What the driver passes: the session's ROLE tool ids only. An ordinary session has none.
    const canUse = makeCanUseTool(s, new QuestionBroker(), undefined);
    const opts = { signal: new AbortController().signal } as never;
    expect((await canUse("mcp__echo__ping", {}, opts))?.behavior).toBe("deny");
    // Even after the owner allowed the integration for the session — that approval lives in the hook.
    s.data.mcpAllowed = [echo.id];
    expect((await canUse("mcp__echo__ping", {}, opts))?.behavior).toBe("deny");
    expect((await canUse("Read", { file_path: "x" }, opts))?.behavior).toBe("allow");
  });
});
