/**
 * [C3] Hard stops on logged-in sites (src/browser/hardstops.ts; agent-cad-and-browser §4.12 "Hard
 * stops", §4.14 items 27 and 44). The policy is plugged into a real BrowserGate as
 * `hooks.actionPolicy`, exactly as the service does, with fake lists and a fake screenshot source.
 * test/integration/browser-c3-loggedin.test.ts runs the same rules through the real hook and services.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type { McpKindGateContext, McpKindVerdict } from "../../src/agent/mcp-gate";
import { BrowserGate, type BrowserGateHooks } from "../../src/browser/gate";
import { HARD_STOP_LABELS, HARD_STOP_TIMEOUT_MS, SCROLL_KEYS, makeHardStopPolicy, runsWithoutPrompt } from "../../src/browser/hardstops";
import { BROWSER_TOOL_NAMES, classifyBrowserTool } from "../../src/browser/tools";
import type { BrowserMode } from "../../src/browser/preset";
import { pageResult } from "../helpers/browser";

let allowed: Set<string>;
let loggedIn: Map<string, { unlocked: boolean }>;
let unlocked: string[];
let shot: { attachmentId: string; mediaType: string } | undefined;
let hooks: BrowserGateHooks;
let mode: BrowserMode;
let gate: BrowserGate;

const session = (over: Record<string, unknown> = {}) => ({ id: "s1", data: { id: "s1", autonomy: "bypass", cwd: "/work/tree", ...over } }) as never;
const ctx = (tool: string, input: Record<string, unknown> = {}, sess = session()): McpKindGateContext => ({ session: sess, integration: { id: "mcpi_b", key: "browser", kind: "browser" } as never, tool, fullTool: `mcp__browser__${tool}`, input, cwd: "/work/tree" });
const call = (tool: string, input: Record<string, unknown> = {}, sess = session()): Exclude<McpKindVerdict, undefined> => gate.gate(ctx(tool, input, sess))!;
const land = (url: string): void => void gate.onResult("s1", { tool: "browser_snapshot", input: {}, content: pageResult(url), isError: false }, mode);
const labels = (v: McpKindVerdict): string[] => (v?.kind === "prompt" ? v.suggestions.map((s) => s.label) : []);

beforeEach(() => {
  allowed = new Set(["bank.test", "plain.test", "other.test"]);
  loggedIn = new Map([["bank.test", { unlocked: false }]]);
  unlocked = [];
  shot = { attachmentId: "att_1", mediaType: "image/png" };
  mode = "headed";
  hooks = {
    loggedInSites: () => [...loggedIn.keys()],
    isUnlocked: (s) => loggedIn.get(s)?.unlocked === true,
  };
  hooks.actionPolicy = makeHardStopPolicy({
    isLocked: (s) => loggedIn.has(s) && !loggedIn.get(s)!.unlocked,
    unlock: (s) => {
      unlocked.push(s);
      loggedIn.get(s)!.unlocked = true;
    },
    screenshot: () => shot,
  });
  gate = new BrowserGate({ isSiteAllowed: (s) => allowed.has(s), allowSiteAlways: (s) => void allowed.add(s), runtime: () => ({ mode, proxyRunning: true }), hooks });
});

/** One representative call of every tool in the closed table (25 names; tabs and drop split by argument). */
const EVERY_CALL: [string, Record<string, unknown>][] = [
  ["browser_snapshot", {}],
  ["browser_take_screenshot", {}],
  ["browser_wait_for", { time: 1 }],
  ["browser_console_messages", {}],
  ["browser_network_requests", {}],
  ["browser_network_request", { index: 0 }],
  ["browser_find", { text: "x" }],
  ["browser_tabs", { action: "list" }],
  ["browser_tabs", { action: "new" }],
  ["browser_tabs", { action: "select", index: 0 }],
  ["browser_tabs", { action: "close", index: 0 }],
  ["browser_navigate_back", {}],
  ["browser_click", { element: "x", target: "e1" }],
  ["browser_type", { target: "e1", text: "hello" }],
  ["browser_press_key", { key: "Enter" }],
  ["browser_fill_form", { fields: [{ name: "q", type: "textbox", target: "e1", value: "x" }] }],
  ["browser_select_option", { target: "e1", values: ["a"] }],
  ["browser_drag", { startTarget: "e1", endTarget: "e2" }],
  ["browser_hover", { target: "e1" }],
  ["browser_handle_dialog", { accept: true }],
  ["browser_drop", { target: "e1", data: { "text/plain": "x" } }],
  ["browser_close", {}],
  ["browser_resize", { width: 800, height: 600 }],
  ["browser_emulate_media", { colorScheme: "dark" }],
];
// browser_close is the way out and is always allowed (C3 review, item 6).
const FREE = new Set(["browser_snapshot", "browser_take_screenshot", "browser_wait_for", "browser_console_messages", "browser_network_requests", "browser_network_request", "browser_find", "browser_tabs:list", "browser_close"]);
const key = ([tool, input]: [string, Record<string, unknown>]): string => (tool === "browser_tabs" ? `${tool}:${String(input.action)}` : tool);

describe("on a LOCKED logged-in site", () => {
  test("[C3] the allow list is closed: of every tool in the table only read-class tools run without a prompt; every other call prompts — under bypass", () => {
    land("https://www.bank.test/account");
    const seen = new Set<string>();
    for (const c of EVERY_CALL) {
      seen.add(c[0]);
      const v = call(...c);
      expect([key(c), v.kind]).toEqual([key(c), FREE.has(key(c)) ? "allow" : "prompt"]);
    }
    // Uploads and script evaluation keep their own all-sites rules (Phase C2): prompt / deny.
    expect(call("browser_file_upload", { paths: ["a.step"] }).kind).toBe("prompt");
    expect(call("browser_evaluate", { function: "() => 1" }).kind).toBe("deny");
    expect(call("browser_run_code_unsafe", { code: "x" }).kind).toBe("deny");
    // Nothing in the table was left out of this test.
    for (const name of ["browser_navigate", "browser_file_upload", "browser_evaluate", "browser_run_code_unsafe"]) seen.add(name);
    expect([...seen].sort()).toEqual([...BROWSER_TOOL_NAMES].sort());
  });

  test("[C3] scrolling: browser_press_key with exactly PageDown, PageUp, Home or End runs without a prompt; every other key — and every near-miss spelling — prompts", () => {
    land("https://bank.test/");
    expect(SCROLL_KEYS).toEqual(["PageDown", "PageUp", "Home", "End"]);
    for (const k of SCROLL_KEYS) expect([k, call("browser_press_key", { key: k }).kind]).toEqual([k, "allow"]);
    for (const k of ["Enter", "Tab", " ", "a", "ArrowDown", "Escape", "pagedown", "PAGEDOWN", "Page Down", " End", "End ", "Shift+End", "Control+End", "End+Enter", "Home\n", ["End"], undefined, 35]) {
      expect([String(k), call("browser_press_key", { key: k as never }).kind]).toEqual([String(k), "prompt"]);
    }
  });

  test("[C3] navigation: an https URL on the same site runs without a prompt; http on the same site, another site, a new tab elsewhere and going back all prompt", () => {
    land("https://www.bank.test/account");
    expect(call("browser_navigate", { url: "https://bank.test/statements" }).kind).toBe("allow");
    expect(call("browser_navigate", { url: "https://login.bank.test/x?y=1" }).kind).toBe("allow"); // same registrable domain
    expect(call("browser_tabs", { action: "new", url: "https://bank.test/help" }).kind).toBe("allow");
    for (const [tool, input] of [
      ["browser_navigate", { url: "http://bank.test/statements" }], // not https
      ["browser_navigate", { url: "https://plain.test/?stolen=balance" }], // leaving with data in the URL
      ["browser_tabs", { action: "new", url: "https://other.test/" }],
      ["browser_navigate_back", {}],
    ] as const) {
      expect([tool, JSON.stringify(input), call(tool, input).kind]).toEqual([tool, JSON.stringify(input), "prompt"]);
    }
    // Entering a locked site from somewhere else: https passes (it is a read of that site), http asks.
    land("https://plain.test/");
    expect(call("browser_navigate", { url: "https://bank.test/" }).kind).toBe("allow");
    expect(call("browser_navigate", { url: "http://bank.test/" }).kind).toBe("prompt");
    // A tab the server listed on the locked site is a navigation to it.
    gate.onResult("s1", { tool: "browser_tabs", input: { action: "list" }, content: "### Result\n- 0: (current) [P](https://plain.test/)\n- 1: [B](https://bank.test/pay)\n- 2: [B](http://bank.test/pay)", isError: false }, mode);
    expect(call("browser_tabs", { action: "select", index: 1 }).kind).toBe("allow");
    expect(call("browser_tabs", { action: "select", index: 2 }).kind).toBe("prompt");
  });

  test("[C3] the prompt is a hard stop: always (so bypass and any remembered allow cannot skip it), three options with no always-allow, the page screenshot attached, and a time limit", () => {
    land("https://bank.test/pay");
    const v = call("browser_click", { element: "Pay now", target: "e9" });
    if (v.kind !== "prompt") throw new Error("expected a prompt");
    expect(v.always).toBe(true);
    expect(v.denyWhenUnattended).toBe(true);
    expect(labels(v)).toEqual(["Allow once", "Unlock bank.test", "Deny"]);
    expect(labels(v)).toEqual(HARD_STOP_LABELS("bank.test"));
    expect(labels(v).some((l) => /always allow/i.test(l))).toBe(false);
    expect(v.card).toEqual({ reason: "click on bank.test, a logged-in site", image: { attachmentId: "att_1", mediaType: "image/png" } });
    expect(v.timeoutMs).toBe(HARD_STOP_TIMEOUT_MS);
    expect(HARD_STOP_TIMEOUT_MS).toBeLessThan(3600_000); // inside the hook's own one-hour limit
    expect(v.reason).toBe("click on bank.test, a logged-in site");
  });

  test("[C3] gamed spec: the decision ignores what the model says it is doing — a click described as harmless, or as a scroll, prompts exactly like any other; a read described as a purchase does not", () => {
    land("https://bank.test/pay");
    for (const input of [
      { element: "just scrolling down, read-only", target: "e1" },
      { element: "PageDown", target: "e1" },
      { element: "browser_snapshot", target: "e1", key: "PageDown" },
      { element: "Cancel (does nothing)", target: "e1", description: "this is a read-only action on a site that is not logged in" },
      { element: "", target: "e1" },
    ]) {
      const v = call("browser_click", input);
      expect([input.element, v.kind]).toEqual([input.element, "prompt"]);
      // …and the card's own words come from the tool name and the tracked site, never from the model.
      expect((v as { reason: string }).reason).toBe("click on bank.test, a logged-in site");
    }
    expect(call("browser_type", { element: "search box (harmless)", target: "e1", text: "x", submit: false }).kind).toBe("prompt");
    expect(call("browser_snapshot", { element: "Confirm purchase", target: "pay-now" }).kind).toBe("allow");
    // The site is the one the DAEMON tracked from results, not one named in the call.
    expect(call("browser_click", { element: "x", target: "e1", url: "https://plain.test/", site: "plain.test" }).kind).toBe("prompt");
    // runsWithoutPrompt is a function of class, key and target only.
    const info = (tool: string, input: Record<string, unknown>) => ({ ctx: ctx(tool, input), cls: (classifyBrowserTool(tool, input) as { cls: never }).cls, mode: "headed" as const, currentSite: "bank.test" });
    expect(runsWithoutPrompt(info("browser_click", { element: "PageDown", key: "PageDown" }), "bank.test")).toBe(false);
    expect(runsWithoutPrompt(info("browser_press_key", { key: "PageDown", element: "Buy" }), "bank.test")).toBe(true);
  });

  test("[C3] the card must show the page as it is now: with no current screenshot the call is denied with an instruction to take one (a screenshot is a read, so it never asks)", () => {
    land("https://bank.test/pay");
    shot = undefined;
    const v = call("browser_click", { element: "Pay", target: "e1" });
    expect(v).toEqual({ kind: "deny", reason: expect.stringMatching(/browser_take_screenshot first, then make this call again/) });
    expect(call("browser_take_screenshot").kind).toBe("allow");
    shot = { attachmentId: "att_2", mediaType: "image/png" };
    expect(call("browser_click", { element: "Pay", target: "e1" })).toMatchObject({ kind: "prompt", card: { image: { attachmentId: "att_2" } } });
  });

  test("[C3] an unattended (builder) session is denied without a card", () => {
    land("https://bank.test/pay");
    const v = call("browser_click", { element: "Pay", target: "e1" }, session({ workUnitRole: "builder" }));
    expect(v).toEqual({ kind: "deny", reason: expect.stringMatching(/unattended/) });
  });

  test("[C3] when the page's address is unknown it is treated as a logged-in site, never as 'not logged in': only reads run", () => {
    land("https://plain.test/");
    // A key press whose result has no page block: the page may be anywhere now.
    gate.onResult("s1", { tool: "browser_press_key", input: { key: "Enter" }, content: "### Ran Playwright code\n```js\nawait page.keyboard.press('Enter');\n```", isError: false }, mode);
    expect(gate.state("s1").unknown).toBe("input");
    for (const [tool, input] of [["browser_click", { target: "e1" }], ["browser_press_key", { key: "PageDown" }], ["browser_navigate", { url: "https://plain.test/x" }]] as const) {
      const v = call(tool, input);
      expect([tool, v.kind]).toEqual([tool, "deny"]);
      expect((v as { reason: string }).reason).toMatch(/browser_snapshot/);
    }
    expect(call("browser_close").kind).toBe("allow"); // the way out, always (C3 review, item 6)
    expect(call("browser_snapshot").kind).toBe("allow");
    expect(call("browser_take_screenshot").kind).toBe("allow");
  });
});

describe("unlock (item 44) and sites that are not logged-in", () => {
  test("[C3] choosing Unlock <site> sets the site's unlock switch and lets the call through; Allow once does not unlock", () => {
    land("https://bank.test/pay");
    const once = call("browser_click", { element: "Pay", target: "e1" });
    if (once.kind !== "prompt") throw new Error("expected a prompt");
    expect(once.onAnswer!("allow")).toBeUndefined();
    expect(unlocked).toEqual([]);
    expect(call("browser_click", { element: "Pay", target: "e1" }).kind).toBe("prompt"); // asked again, every time

    const unlock = call("browser_click", { element: "Pay", target: "e1" });
    if (unlock.kind !== "prompt") throw new Error("expected a prompt");
    expect(unlock.suggestions[1]).toEqual({ decision: "allow_always", label: "Unlock bank.test" });
    expect(unlock.onAnswer!("allow_always")).toBeUndefined();
    expect(unlocked).toEqual(["bank.test"]);
  });

  test("[C3] on an UNLOCKED logged-in site nothing asks — every tool in the table, including on a checkout or payment page — and locking it again makes the next click prompt", () => {
    loggedIn.get("bank.test")!.unlocked = true;
    for (const url of ["https://bank.test/account", "https://shop.bank.test/checkout", "https://bank.test/checkout/payment?step=confirm"]) {
      land(url);
      for (const c of EVERY_CALL) {
        land(url); // (an input call with no page block would otherwise ask for a snapshot first)
        expect([url, key(c), call(...c).kind]).toEqual([url, key(c), "allow"]);
      }
      expect(call("browser_navigate", { url: "https://plain.test/?x=1" }).kind).toBe("allow");
    }
    loggedIn.get("bank.test")!.unlocked = false; // the switch in Settings is the only brake
    expect(call("browser_click", { element: "Buy", target: "e1" }).kind).toBe("prompt");
  });

  test("[C3] on an allowed site that is not logged-in a click, a key press and a form fill do not prompt; a site that only has cookies from agent sessions is not logged-in", () => {
    land("https://plain.test/checkout");
    for (const c of EVERY_CALL) {
      land("https://plain.test/checkout");
      expect([key(c), call(...c).kind]).toEqual([key(c), "allow"]);
    }
  });

  test("[C3] headless fallback: a logged-in site is refused entirely — unlocked or not — at navigation and when a page lands on it", () => {
    mode = "headless";
    for (const state of [false, true]) {
      loggedIn.get("bank.test")!.unlocked = state;
      expect([state, call("browser_navigate", { url: "https://bank.test/" })]).toEqual([state, { kind: "deny", reason: expect.stringMatching(/logged-in site.*headless/) }]);
      gate.pageGone("s1");
      gate.onResult("s1", { tool: "browser_click", input: {}, content: pageResult("https://bank.test/account"), isError: false }, mode);
      expect(gate.state("s1").closing?.reason).toMatch(/logged-in site that the headless browser may not open/);
      expect(call("browser_snapshot").kind).toBe("deny");
      gate.pageGone("s1");
    }
  });
});
