/**
 * [C2] The browser's kind gate in isolation (src/browser/gate.ts): the order of its checks, the HOLD
 * and CLOSING states, and the seams Phase C3 and C4 plug into. The gate is called directly with fake
 * dependencies; test/integration/browser-c2-sites.test.ts runs the same rules through the real hook.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type { McpKindGateContext, McpKindVerdict } from "../../src/agent/mcp-gate";
import { BrowserGate, type BrowserGateHooks } from "../../src/browser/gate";
import type { BrowserMode } from "../../src/browser/preset";
import { pageResult } from "../helpers/browser";

let allowed: Set<string>;
let always: string[];
let hooks: BrowserGateHooks;
let runtime: { mode: BrowserMode; proxyRunning: boolean } | undefined;
let gate: BrowserGate;

const session = (over: Record<string, unknown> = {}) => ({ id: "s1", data: { id: "s1", autonomy: "mostly-autonomous", cwd: "/work/tree", ...over } }) as never;
const ctx = (tool: string, input: Record<string, unknown> = {}, sess = session()): McpKindGateContext => ({ session: sess, integration: { id: "mcpi_b", key: "browser", kind: "browser" } as never, tool, fullTool: `mcp__browser__${tool}`, input, cwd: "/work/tree" });
const call = (tool: string, input: Record<string, unknown> = {}, sess = session()): Exclude<McpKindVerdict, undefined> => gate.gate(ctx(tool, input, sess))!;
const result = (tool: string, text: string, isError = false): void => gate.onResult("s1", { tool, input: {}, content: text, isError }, runtime?.mode);
const labels = (v: McpKindVerdict): string[] => (v?.kind === "prompt" ? v.suggestions.map((s) => s.label) : []);

beforeEach(() => {
  allowed = new Set(["a.test"]);
  always = [];
  hooks = {};
  runtime = { mode: "headed", proxyRunning: true };
  gate = new BrowserGate({ isSiteAllowed: (s) => allowed.has(s), allowSiteAlways: (s) => (always.push(s), void allowed.add(s)), runtime: () => runtime, hooks });
});

describe("fail closed", () => {
  test("[C2] with no proxy running for the session every browser call is denied, navigation and reads alike", () => {
    runtime = { mode: "headed", proxyRunning: false };
    for (const [tool, input] of [["browser_navigate", { url: "https://a.test/" }], ["browser_snapshot", {}], ["browser_click", { target: "e1" }], ["browser_close", {}]] as const) {
      const v = call(tool, input);
      expect(v.kind).toBe("deny");
      expect((v as { reason: string }).reason).toMatch(/network block is not running/);
    }
    runtime = undefined; // Anvil never started a browser for this session
    expect(call("browser_snapshot").kind).toBe("deny");
  });
});

describe("classification at the gate", () => {
  test("[C2] a tool outside the table, browser_run_code_unsafe and browser_evaluate are denied on an allowed site", () => {
    result("browser_navigate", pageResult("https://a.test/"));
    expect(call("browser_pdf_save")).toMatchObject({ kind: "deny" });
    expect(call("browser_run_code_unsafe", { code: "async (page) => 1" })).toMatchObject({ kind: "deny", reason: expect.stringMatching(/never allowed/) });
    expect(call("browser_run_code_unsafe", { filename: "x.js" })).toMatchObject({ kind: "deny" });
    expect(call("browser_evaluate", { function: "() => location.href" })).toMatchObject({ kind: "deny", reason: expect.stringMatching(/test daemon/) });
  });

  test("[C2] a filename argument that is absolute or contains .. is denied on any tool; a relative one passes", () => {
    result("browser_navigate", pageResult("https://a.test/"));
    expect(call("browser_take_screenshot", { filename: "/etc/x.png" })).toMatchObject({ kind: "deny" });
    expect(call("browser_snapshot", { filename: "../x.yml" })).toMatchObject({ kind: "deny" });
    expect(call("browser_console_messages", { filename: "a/../../x.log" })).toMatchObject({ kind: "deny" });
    expect(call("browser_take_screenshot", { filename: "shot.png" })).toMatchObject({ kind: "allow" });
  });

  test("[C2] the C4 hook can exempt browser_evaluate (the session's own test daemon); run_code_unsafe stays denied whatever the hook says", () => {
    result("browser_navigate", pageResult("https://a.test/"));
    const seen: unknown[] = [];
    hooks.allowEvaluate = (info) => (seen.push([info.cls, info.currentSite, info.mode]), true);
    expect(call("browser_evaluate", { function: "() => 1" })).toMatchObject({ kind: "allow" });
    expect(seen).toEqual([["script", "a.test", "headed"]]);
    expect(call("browser_run_code_unsafe", { code: "x" })).toMatchObject({ kind: "deny" });
    hooks.allowEvaluate = () => false;
    expect(call("browser_evaluate", { function: "() => 1" })).toMatchObject({ kind: "deny" });
  });
});

describe("navigation", () => {
  test("[C2] navigation to file:, chrome:, data:, view-source:, javascript: and about: pages is denied; about:blank is allowed", () => {
    for (const url of ["file:///etc/hosts", "chrome://settings", "data:text/html,<h1>x</h1>", "view-source:https://a.test/", "javascript:alert(1)", "about:config", "", undefined]) {
      expect([url, call("browser_navigate", { url }).kind]).toEqual([url, "deny"]);
      expect([url, call("browser_tabs", { action: "new", url: url ?? "ftp://x" }).kind]).toEqual([url, "deny"]);
    }
    expect(call("browser_navigate", { url: "about:blank" })).toMatchObject({ kind: "allow" });
    expect(call("browser_tabs", { action: "new" })).toMatchObject({ kind: "allow" }); // an empty tab
  });

  test("[C2] an allowed site passes without a prompt; a new one prompts Allow once / Always allow <site> / Deny; browser_tabs new with a url is gated the same way", () => {
    expect(call("browser_navigate", { url: "https://www.a.test/x" })).toMatchObject({ kind: "allow" });
    const v = call("browser_navigate", { url: "https://shop.b.test/cart" });
    expect(v.kind).toBe("prompt");
    expect(labels(v)).toEqual(["Allow once", "Always allow b.test", "Deny"]);
    expect((v as { always?: boolean }).always).toBeFalsy(); // a site prompt is not a hard stop
    expect((v as { denyWhenUnattended?: boolean }).denyWhenUnattended).toBe(true);
    expect(labels(call("browser_tabs", { action: "new", url: "https://b.test/" }))).toEqual(["Allow once", "Always allow b.test", "Deny"]);
  });

  test("[C2] Allow once covers the session only; Always allow goes to the fleet list", () => {
    const once = call("browser_navigate", { url: "https://b.test/" });
    if (once.kind !== "prompt") throw new Error("expected a prompt");
    once.onAnswer!("allow");
    expect(always).toEqual([]);
    expect(call("browser_navigate", { url: "https://b.test/2" })).toMatchObject({ kind: "allow" });

    const forever = call("browser_navigate", { url: "https://c.test/" });
    if (forever.kind !== "prompt") throw new Error("expected a prompt");
    forever.onAnswer!("allow_always");
    expect(always).toEqual(["c.test"]);

    gate.forget("s1"); // a new session: "once" is gone, the fleet list is not
    expect(call("browser_navigate", { url: "https://b.test/" }).kind).toBe("prompt");
    expect(call("browser_navigate", { url: "https://c.test/" }).kind).toBe("allow");
  });

  test("[C2] under bypass a new site is allowed without a prompt and counts as allowed for the session; scheme and classification denials still apply", () => {
    const bypass = session({ autonomy: "bypass" });
    expect(call("browser_navigate", { url: "https://b.test/" }, bypass)).toMatchObject({ kind: "allow" });
    result("browser_navigate", pageResult("https://b.test/"));
    expect(gate.state("s1").hold).toBeUndefined(); // …so landing there is not a hold
    expect(always).toEqual([]); // and nothing was written to the fleet list
    expect(call("browser_navigate", { url: "file:///etc/hosts" }, bypass).kind).toBe("deny");
    expect(call("browser_run_code_unsafe", { code: "x" }, bypass).kind).toBe("deny");
    expect(call("browser_evaluate", { function: "x" }, bypass).kind).toBe("deny");
  });

  test("[C2] an unattended builder session is denied a new site, with or without bypass, and never prompted", () => {
    for (const autonomy of ["mostly-autonomous", "bypass"]) {
      const v = call("browser_navigate", { url: "https://b.test/" }, session({ autonomy, workUnitRole: "builder" }));
      expect(v).toMatchObject({ kind: "deny", reason: expect.stringMatching(/unattended/) });
    }
    expect(call("browser_navigate", { url: "https://a.test/" }, session({ workUnitRole: "builder" })).kind).toBe("allow"); // an allowed site is fine
  });

  test("[C2] headless fallback: a navigation to a listed logged-in site is denied, even if the site is allowed; headed mode is not affected", () => {
    hooks.loggedInSites = () => ["a.test", "bank.test"];
    runtime = { mode: "headless", proxyRunning: true };
    expect(call("browser_navigate", { url: "https://a.test/" })).toMatchObject({ kind: "deny", reason: expect.stringMatching(/logged-in site/) });
    expect(call("browser_navigate", { url: "https://login.bank.test/" })).toMatchObject({ kind: "deny" });
    expect(call("browser_tabs", { action: "new", url: "https://bank.test/" })).toMatchObject({ kind: "deny" });
    allowed.add("other.test");
    expect(call("browser_navigate", { url: "https://other.test/" }).kind).toBe("allow");
    runtime = { mode: "headed", proxyRunning: true };
    expect(call("browser_navigate", { url: "https://a.test/" }).kind).toBe("allow");
  });
});

describe("uploads", () => {
  test("[C2] an upload always prompts — Allow once / Deny, no always-allow, even under bypass — and is denied when unattended", () => {
    result("browser_navigate", pageResult("https://a.test/"));
    for (const [tool, input] of [["browser_file_upload", { paths: ["parts/a.step"] }], ["browser_drop", { target: "e1", paths: ["parts/a.step", "b.step"] }]] as const) {
      for (const sess of [session(), session({ autonomy: "bypass" })]) {
        const v = call(tool, input, sess);
        expect(v.kind).toBe("prompt");
        expect(labels(v)).toEqual(["Allow once", "Deny"]);
        expect(v).toMatchObject({ always: true, denyWhenUnattended: true });
      }
    }
  });

  test("[C2] an upload whose path leaves the worktree is denied before any prompt", () => {
    expect(call("browser_file_upload", { paths: ["/etc/passwd"] })).toMatchObject({ kind: "deny", reason: expect.stringMatching(/outside this session's worktree/) });
    expect(call("browser_file_upload", { paths: ["ok.step", "../../.ssh/id_ed25519"] })).toMatchObject({ kind: "deny" });
    expect(call("browser_drop", { paths: ["/Users/x/.anvil/state.json"] })).toMatchObject({ kind: "deny" });
    expect(call("browser_file_upload", {})).toMatchObject({ kind: "deny" });
  });
});

describe("reads and inputs on an allowed site", () => {
  test("[C2] read-only and input tools on an allowed site run without a prompt", () => {
    result("browser_navigate", pageResult("https://a.test/"));
    for (const [tool, input] of [
      ["browser_snapshot", {}], ["browser_take_screenshot", {}], ["browser_wait_for", { time: 1 }], ["browser_tabs", { action: "list" }], ["browser_find", { text: "x" }],
      ["browser_click", { target: "e1" }], ["browser_type", { target: "e1", text: "hi" }], ["browser_press_key", { key: "End" }], ["browser_fill_form", { fields: [] }], ["browser_hover", { target: "e1" }],
      ["browser_drop", { target: "e1", data: { "text/plain": "x" } }], ["browser_navigate_back", {}], ["browser_tabs", { action: "select", index: 0 }], ["browser_resize", { width: 800, height: 600 }], ["browser_close", {}],
    ] as const) {
      expect([tool, call(tool, input).kind]).toEqual([tool, "allow"]);
    }
  });

  test("[C2] the C3 hook sees every call that would be allowed and can replace the allow with its own verdict (a hard stop)", () => {
    result("browser_navigate", pageResult("https://a.test/"));
    const seen: string[] = [];
    hooks.actionPolicy = (info) => {
      seen.push(`${info.ctx.tool}:${info.cls}:${info.currentSite ?? "-"}:${info.target?.site ?? "-"}`);
      return info.cls === "input" ? { kind: "prompt", reason: "hard stop", suggestions: [{ decision: "allow", label: "Allow once" }, { decision: "deny", label: "Deny" }], always: true } : undefined;
    };
    expect(call("browser_snapshot").kind).toBe("allow");
    expect(call("browser_click", { target: "e1" })).toMatchObject({ kind: "prompt", reason: "hard stop", always: true });
    expect(call("browser_navigate", { url: "https://a.test/next" }).kind).toBe("allow");
    expect(seen).toEqual(["browser_snapshot:read:a.test:-", "browser_click:input:a.test:-", "browser_navigate:navigation:a.test:a.test"]);
    // It is not consulted for calls that are refused or still need a site approval.
    seen.length = 0;
    call("browser_navigate", { url: "https://b.test/" });
    call("browser_run_code_unsafe", { code: "x" });
    expect(seen).toEqual([]);
  });
});

describe("HOLD and about:blank", () => {
  test("[C2] a result reporting a page on unapproved c.test holds the next call — any class — behind a prompt for c.test, under bypass too", () => {
    result("browser_click", pageResult("https://www.c.test/landing"));
    expect(gate.state("s1").hold).toEqual({ kind: "site", site: "c.test", url: "https://www.c.test/landing" });
    for (const [tool, input] of [["browser_snapshot", {}], ["browser_click", { target: "e1" }], ["browser_navigate", { url: "https://a.test/" }], ["browser_tabs", { action: "list" }]] as const) {
      for (const sess of [session(), session({ autonomy: "bypass" })]) {
        const v = call(tool, input, sess);
        expect(v.kind).toBe("prompt");
        expect(labels(v)).toEqual(["Allow once", "Always allow c.test", "Deny"]);
        expect(v).toMatchObject({ always: true, reason: expect.stringMatching(/moved to c\.test/) });
      }
    }
  });

  test("[C2] approving the hold records the site, clears the hold and lets the held call run", () => {
    result("browser_click", pageResult("https://c.test/"));
    const v = call("browser_snapshot");
    if (v.kind !== "prompt") throw new Error("expected a prompt");
    expect(v.onAnswer!("allow_always")).toBeUndefined();
    expect(always).toEqual(["c.test"]);
    expect(gate.state("s1").hold).toBeUndefined();
    expect(call("browser_click", { target: "e1" }).kind).toBe("allow");
  });

  test("[C2] Deny on a held browser_navigate turns that very call into a navigation to about:blank", () => {
    result("browser_click", pageResult("https://c.test/"));
    const v = call("browser_navigate", { url: "https://a.test/" });
    if (v.kind !== "prompt") throw new Error("expected a prompt");
    expect(v.onDeny!()).toEqual({ allow: { updatedInput: { url: "about:blank" }, reason: expect.stringMatching(/about:blank/) } });
    expect(gate.state("s1").closing).toBeDefined();
    result("browser_navigate", pageResult("about:blank"));
    expect(gate.state("s1").closing).toBeUndefined();
    expect(gate.state("s1").hold).toBeUndefined();
    expect(call("browser_navigate", { url: "https://a.test/" })).toMatchObject({ kind: "allow" });
    expect((call("browser_navigate", { url: "https://a.test/" }) as { updatedInput?: unknown }).updatedInput).toBeUndefined();
  });

  test("[C2] Deny on any other held call denies it and leaves only the way out: browser_navigate (rewritten to about:blank) or browser_close", () => {
    result("browser_click", pageResult("https://c.test/"));
    const v = call("browser_snapshot");
    if (v.kind !== "prompt") throw new Error("expected a prompt");
    expect(v.onDeny!()).toEqual({ deny: expect.stringMatching(/browser_navigate.*about:blank/) });

    for (const [tool, input] of [["browser_snapshot", {}], ["browser_click", { target: "e1" }], ["browser_take_screenshot", {}], ["browser_tabs", { action: "new", url: "https://a.test/" }], ["browser_navigate_back", {}]] as const) {
      expect([tool, call(tool, input).kind]).toEqual([tool, "deny"]);
    }
    // Whatever the model asks to open — even the refused site, even a bad scheme — it gets about:blank.
    for (const url of ["https://c.test/again", "https://a.test/", "javascript:alert(1)", undefined]) {
      expect(call("browser_navigate", { url })).toMatchObject({ kind: "allow", updatedInput: { url: "about:blank" } });
    }
    expect(call("browser_close")).toMatchObject({ kind: "allow" });

    // A result that still shows the refused page does not end it; about:blank does.
    result("browser_navigate", pageResult("https://c.test/"));
    expect(call("browser_snapshot").kind).toBe("deny");
    result("browser_navigate", pageResult("about:blank"));
    expect(call("browser_snapshot").kind).toBe("allow");
  });

  test("[C2] closing the browser also ends a hold or a refused page", () => {
    result("browser_click", pageResult("https://c.test/"));
    const v = call("browser_snapshot");
    if (v.kind === "prompt") v.onDeny!();
    result("browser_close", "### Result\nBrowser closed");
    expect(gate.state("s1")).toMatchObject({ currentUrl: undefined, hold: undefined, closing: undefined });
    expect(call("browser_navigate", { url: "https://a.test/" }).kind).toBe("allow");
  });

  test("[C2] a result with more than one ### Page block holds the next call behind an Allow once / Deny prompt", () => {
    result("browser_navigate", pageResult("https://a.test/"));
    result("browser_handle_dialog", `${pageResult("https://a.test/")}\n### Events\n- [LOG] x\n### Page\n- Page URL: https://a.test/`);
    expect(gate.state("s1").hold).toEqual({ kind: "ambiguous" });
    const v = call("browser_snapshot", {}, session({ autonomy: "bypass" }));
    expect(v).toMatchObject({ kind: "prompt", always: true, reason: expect.stringMatching(/more than one page/) });
    expect(labels(v)).toEqual(["Allow once", "Deny"]);
    if (v.kind === "prompt") expect(v.onAnswer!("allow")).toBeUndefined();
    expect(call("browser_snapshot").kind).toBe("allow");
  });

  test("[C2] a page that ends up on a scheme that is not allowed goes straight to closing, with no prompt to approve it", () => {
    result("browser_click", pageResult("chrome://settings/"));
    expect(gate.state("s1").closing?.reason).toMatch(/not allowed/);
    expect(call("browser_snapshot").kind).toBe("deny");
    expect(call("browser_navigate", { url: "https://a.test/" })).toMatchObject({ kind: "allow", updatedInput: { url: "about:blank" } });
  });

  test("[C2] an unattended session with a hold is sent to about:blank without a prompt", () => {
    const builder = session({ workUnitRole: "builder" });
    result("browser_click", pageResult("https://c.test/"));
    expect(call("browser_snapshot", {}, builder)).toMatchObject({ kind: "deny", reason: expect.stringMatching(/unattended/) });
    expect(call("browser_navigate", { url: "https://a.test/" }, builder)).toMatchObject({ kind: "allow", updatedInput: { url: "about:blank" } });
  });

  test("[C2] the held call still has to pass on its own after the hold is approved: a refused one stays refused, one needing its own approval is asked again", () => {
    result("browser_click", pageResult("https://c.test/"));
    expect(call("browser_run_code_unsafe", { code: "x" }).kind).toBe("deny"); // refused outright: no prompt spent on it

    const nav = call("browser_navigate", { url: "https://d.test/" });
    if (nav.kind !== "prompt") throw new Error("expected a prompt");
    expect(labels(nav)).toEqual(["Allow once", "Always allow c.test", "Deny"]); // the hold's prompt, not d.test's
    expect(nav.onAnswer!("allow")).toEqual({ deny: expect.stringMatching(/c\.test is now allowed.*call it again/) });
    expect(labels(call("browser_navigate", { url: "https://d.test/" }))).toEqual(["Allow once", "Always allow d.test", "Deny"]);
  });

  test("[C2] a hold ends by itself when the owner allows the site in Settings, or the page moves back to an allowed site", () => {
    result("browser_click", pageResult("https://c.test/"));
    allowed.add("c.test"); // added in Settings → Integrations
    expect(call("browser_snapshot").kind).toBe("allow");

    allowed.delete("c.test");
    result("browser_click", pageResult("https://c.test/"));
    expect(gate.state("s1").hold).toBeDefined();
    result("browser_navigate_back", pageResult("https://a.test/"));
    expect(gate.state("s1").hold).toBeUndefined();
  });

  test("[C2] headless fallback: a page that lands on a logged-in site is closed, not offered for approval", () => {
    hooks.loggedInSites = () => ["bank.test"];
    runtime = { mode: "headless", proxyRunning: true };
    allowed.add("bank.test");
    result("browser_click", pageResult("https://bank.test/account"));
    expect(gate.state("s1").closing?.reason).toMatch(/logged-in site/);
    expect(call("browser_snapshot").kind).toBe("deny");
  });

  test("[C2] a result with no page block changes nothing; a new server process (pageGone) drops the page state but keeps the session's approvals", () => {
    result("browser_navigate", pageResult("https://a.test/"));
    result("browser_press_key", "### Ran Playwright code\n```js\nawait page.keyboard.press('End');\n```");
    expect(gate.state("s1").currentUrl).toBe("https://a.test/");

    const once = call("browser_navigate", { url: "https://b.test/" });
    if (once.kind === "prompt") once.onAnswer!("allow");
    result("browser_click", pageResult("https://c.test/"));
    gate.pageGone("s1");
    expect(gate.state("s1")).toMatchObject({ currentUrl: undefined, hold: undefined, closing: undefined });
    expect(call("browser_navigate", { url: "https://b.test/" }).kind).toBe("allow");
  });
});
