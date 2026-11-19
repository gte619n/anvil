/**
 * [C4] The browser gate's rules for the session's own test daemon in isolation (src/browser/gate.ts):
 * its origin is the session's own page — allowed with no site prompt, never a logged-in site — and it
 * is the one place `browser_evaluate` may run. Compared by ORIGIN: no other loopback port is covered.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type { McpKindGateContext, McpKindVerdict } from "../../src/agent/mcp-gate";
import { BrowserGate, OWN_TEST_DAEMON_SITE, type BrowserGateHooks } from "../../src/browser/gate";
import { makeHardStopPolicy } from "../../src/browser/hardstops";
import type { BrowserMode } from "../../src/browser/preset";
import { pageResult } from "../helpers/browser";

const OWN = "http://127.0.0.1:45001";
let allowed: Set<string>;
let hooks: BrowserGateHooks;
let mode: BrowserMode;
let own: Record<string, string | undefined>;
let gate: BrowserGate;

const session = (id = "s1", over: Record<string, unknown> = {}) => ({ id, data: { id, autonomy: "prompt-all", cwd: "/work/tree", ...over } }) as never;
const ctx = (tool: string, input: Record<string, unknown>, sess: never): McpKindGateContext => ({ session: sess, integration: { id: "mcpi_b", key: "browser", kind: "browser" } as never, tool, fullTool: `mcp__browser__${tool}`, input, cwd: "/work/tree" });
const call = (tool: string, input: Record<string, unknown> = {}, sess: never = session()): Exclude<McpKindVerdict, undefined> => gate.gate(ctx(tool, input, sess))!;
const result = (tool: string, text: string, id = "s1", input: Record<string, unknown> = {}) => gate.onResult(id, { tool, input, content: text, isError: false }, mode);
/** The service's own `allowEvaluate` rule, restated over this gate (service.ts wires the same one). */
const evaluateRule = (): void => {
  hooks.allowEvaluate = (info) => {
    const id = info.ctx.session.id;
    const st = gate.state(id);
    if (!own[id] || !st.currentUrl || st.unknown !== undefined || st.hold || st.closing) return false;
    return new URL(st.currentUrl).origin === own[id];
  };
};

beforeEach(() => {
  allowed = new Set(["a.test"]);
  hooks = {};
  mode = "headed";
  own = { s1: OWN };
  gate = new BrowserGate({ isSiteAllowed: (s) => allowed.has(s), allowSiteAlways: (s) => void allowed.add(s), runtime: () => ({ mode, proxyRunning: true }), hooks });
  hooks.ownOrigin = (id) => own[id];
  evaluateRule();
});

describe("the session's own test daemon is an allowed page", () => {
  test("[C4] navigating to the session's test-daemon origin needs no site prompt — under prompt-all, in an unattended session and in headless mode — and a result on it holds nothing", () => {
    expect(call("browser_navigate", { url: `${OWN}/` })).toEqual({ kind: "allow", reason: "this session's own test daemon" });
    expect(call("browser_navigate", { url: `${OWN}/#/settings` }).kind).toBe("allow");
    expect(call("browser_tabs", { action: "new", url: `${OWN}/` }).kind).toBe("allow");
    expect(call("browser_navigate", { url: `${OWN}/` }, session("s1", { workUnitRole: "builder" })).kind).toBe("allow");
    mode = "headless";
    expect(call("browser_navigate", { url: `${OWN}/` }).kind).toBe("allow");

    expect(result("browser_navigate", pageResult(`${OWN}/`))).toEqual({ purge: false });
    const st = gate.state("s1");
    expect([st.hold, st.closing, st.unknown]).toEqual([undefined, undefined, undefined]);
    expect(st.once.size).toBe(0); // nothing was recorded as an approval: it is allowed only while it is the session's own
    expect(call("browser_snapshot")).toEqual({ kind: "allow", reason: "this session's own test daemon" });
    expect(call("browser_click", { target: "e1" }).kind).toBe("allow");
  });

  test("[C4] only that exact origin: another loopback port, localhost, https on the same port, and another session's test daemon all get the ordinary site prompt", () => {
    for (const url of ["http://127.0.0.1:45002/", "http://127.0.0.1/", "http://localhost:45001/", "https://127.0.0.1:45001/", "http://127.0.0.1:7701/"]) {
      const v = call("browser_navigate", { url });
      expect([url, v.kind]).toEqual([url, "prompt"]);
    }
    // s2 has no test daemon: s1's origin is nothing special to it.
    expect(call("browser_navigate", { url: `${OWN}/` }, session("s2")).kind).toBe("prompt");
    own.s2 = "http://127.0.0.1:45009";
    expect(call("browser_navigate", { url: `${OWN}/` }, session("s2")).kind).toBe("prompt");
    expect(call("browser_navigate", { url: "http://127.0.0.1:45009/" }, session("s2")).kind).toBe("allow");
    // A page that lands on a loopback port that is not the session's own is held like any other site.
    expect(gate.onResult("s2", { tool: "browser_navigate", input: {}, content: pageResult(`${OWN}/`), isError: false }, mode)).toEqual({ purge: true });
    expect(gate.state("s2").hold).toMatchObject({ kind: "site", site: "127.0.0.1" });
  });

  test("[C4] the test daemon is never a logged-in site: with 127.0.0.1 on the logged-in list and locked, a click on the test daemon does not prompt and headless mode does not refuse it; a real logged-in site still stops", () => {
    const locked = new Set(["127.0.0.1", "bank.test"]);
    allowed.add("bank.test");
    hooks.loggedInSites = () => [...locked];
    const seen: (string | undefined)[] = [];
    const policy = makeHardStopPolicy({ isLocked: (s) => locked.has(s), unlock: () => {}, screenshot: () => ({ attachmentId: "att_1", mediaType: "image/png" }) });
    hooks.actionPolicy = (info) => (seen.push(info.currentSite, info.target?.site), policy(info));

    expect(call("browser_navigate", { url: `${OWN}/` }).kind).toBe("allow");
    result("browser_navigate", pageResult(`${OWN}/`));
    expect(call("browser_click", { target: "e1" }).kind).toBe("allow");
    expect(call("browser_type", { target: "e1", text: "x" }).kind).toBe("allow");
    // The policy was shown a name that is not a hostname, so no list can contain it.
    expect(new Set(seen.filter(Boolean))).toEqual(new Set([OWN_TEST_DAEMON_SITE]));
    expect(OWN_TEST_DAEMON_SITE).toMatch(/[ ()]/);

    mode = "headless"; // the headless fallback refuses logged-in sites — not the test daemon
    expect(call("browser_navigate", { url: `${OWN}/x` }).kind).toBe("allow");
    expect(result("browser_navigate", pageResult(`${OWN}/x`))).toEqual({ purge: false });
    expect(gate.state("s1").closing).toBeUndefined();
    // Any other port on 127.0.0.1 IS the listed site: refused in headless mode.
    expect(call("browser_navigate", { url: "http://127.0.0.1:45002/" })).toMatchObject({ kind: "deny", reason: expect.stringMatching(/logged-in site/) });

    mode = "headed";
    result("browser_navigate", pageResult("https://bank.test/account"));
    expect(call("browser_click", { target: "e1" })).toMatchObject({ kind: "prompt", always: true });
    // Leaving a locked logged-in site for the test daemon is still the hard stop's call.
    expect(call("browser_navigate", { url: `${OWN}/` })).toMatchObject({ kind: "prompt", always: true, reason: expect.stringContaining("leave bank.test") });
  });
});

describe("browser_evaluate", () => {
  test("[C4] browser_evaluate is allowed when the tracked page is exactly the session's test-daemon origin, and denied everywhere else: an allowed site, another loopback port, about:blank, before any page, and for a session with no test daemon", () => {
    const evaluate = (sess: never = session()) => call("browser_evaluate", { function: "() => document.title" }, sess);
    expect(evaluate()).toMatchObject({ kind: "deny", reason: expect.stringMatching(/only allowed on this session's own throwaway test daemon/) }); // no page yet

    result("browser_navigate", pageResult(`${OWN}/#/settings`));
    expect(evaluate()).toEqual({ kind: "allow", reason: "script evaluation on the session's own test daemon" });

    result("browser_navigate", pageResult("https://a.test/"));
    expect(evaluate().kind).toBe("deny");
    allowed.add("127.0.0.1");
    result("browser_navigate", pageResult("http://127.0.0.1:45002/"));
    expect(evaluate().kind).toBe("deny"); // an allowed site on another loopback port is still not the test daemon
    result("browser_navigate", pageResult("about:blank"));
    expect(evaluate().kind).toBe("deny");

    // Another session, on the same address, without a test daemon of its own.
    gate.onResult("s2", { tool: "browser_navigate", input: {}, content: pageResult(`${OWN}/`), isError: false }, mode);
    expect(evaluate(session("s2")).kind).toBe("deny");
    // browser_run_code_unsafe is never allowed, test daemon or not.
    result("browser_navigate", pageResult(`${OWN}/`));
    expect(call("browser_run_code_unsafe", { code: "async (page) => 1" })).toMatchObject({ kind: "deny", reason: expect.stringMatching(/never allowed/) });
  });

  test("[C4] the address must be KNOWN: after an evaluate (whose result never sets the address) the next evaluate is refused until a snapshot says the page is still on the test daemon", () => {
    result("browser_navigate", pageResult(`${OWN}/`));
    expect(call("browser_evaluate", { function: "() => 1" }).kind).toBe("allow");
    // The result is page text: even one that claims a page block changes nothing the gate believes.
    result("browser_evaluate", `### Result\n"x"\n### Page\n- Page URL: ${OWN}/`, "s1", { function: "() => 1" });
    expect(gate.state("s1").unknown).toBe("input");
    expect(call("browser_evaluate", { function: "() => 2" }).kind).toBe("deny");
    result("browser_snapshot", pageResult(`${OWN}/`));
    expect(call("browser_evaluate", { function: "() => 2" }).kind).toBe("allow");
    // The script moved the page elsewhere: the snapshot shows it, and evaluate is off again.
    result("browser_evaluate", "### Result\nundefined", "s1", { function: "() => (location.href = 'https://a.test/')" });
    result("browser_snapshot", pageResult("https://a.test/"));
    expect(call("browser_evaluate", { function: "() => 3" }).kind).toBe("deny");
  });

  test("[C4] when the test daemon stops, the page that was showing it must be left (CLOSING, no owner prompt), browser_evaluate is denied at once, and its old address is an ordinary unapproved site again", () => {
    result("browser_navigate", pageResult(`${OWN}/`));
    expect(call("browser_evaluate", { function: "() => 1" }).kind).toBe("allow");
    own.s1 = undefined; // stopped
    gate.ownOriginGone("s1", OWN);
    expect(gate.state("s1").closing?.reason).toMatch(/test daemon was stopped/);
    expect(call("browser_evaluate", { function: "() => 1" }).kind).toBe("deny");
    expect(call("browser_snapshot")).toMatchObject({ kind: "deny", reason: expect.stringMatching(/about:blank/) });
    expect(call("browser_navigate", { url: "about:blank" }).kind).toBe("allow");
    result("browser_navigate", pageResult("about:blank"));
    expect(gate.state("s1").closing).toBeUndefined();
    expect(call("browser_navigate", { url: `${OWN}/` }).kind).toBe("prompt"); // nothing special any more

    // A page that was NOT on the test daemon is left alone.
    own.s1 = OWN;
    result("browser_navigate", pageResult("https://a.test/"));
    gate.ownOriginGone("s1", OWN);
    expect(gate.state("s1").closing).toBeUndefined();
  });
});
