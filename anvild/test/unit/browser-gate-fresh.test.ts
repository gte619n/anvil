/**
 * [C3] C4 review item 4: the freshness rule of the browser gate, with a fake clock. Chrome can reuse
 * an HTTPS tunnel it already holds, so a page can move without the proxy seeing a new connection; an
 * input-like call therefore needs a result that said where the page is no more than FRESH_PAGE_MS ago.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type { McpKindGateContext, McpKindVerdict } from "../../src/agent/mcp-gate";
import { BrowserGate, FRESH_PAGE_MS } from "../../src/browser/gate";
import { pageResult } from "../helpers/browser";

let now: number;
let gate: BrowserGate;
const session = { id: "s1", data: { id: "s1", autonomy: "mostly-autonomous", cwd: "/work/tree" } } as never;
const ctx = (tool: string, input: Record<string, unknown> = {}): McpKindGateContext => ({ session, integration: { id: "mcpi_b", key: "browser", kind: "browser" } as never, tool, fullTool: `mcp__browser__${tool}`, input, cwd: "/work/tree" });
const call = (tool: string, input: Record<string, unknown> = {}): Exclude<McpKindVerdict, undefined> => gate.gate(ctx(tool, input))!;
const result = (tool: string, text: string, input: Record<string, unknown> = {}): void => void gate.onResult("s1", { tool, input, content: text, isError: false }, "headed");

beforeEach(() => {
  now = 1_000_000;
  gate = new BrowserGate({ isSiteAllowed: (s) => s === "a.test", allowSiteAlways: () => undefined, runtime: () => ({ mode: "headed", proxyRunning: true }), hooks: {}, clock: () => now });
});

describe("the freshness rule (C4 review, item 4)", () => {
  test("[C3] review C4-4: FRESH_PAGE_MS is 2 s; an input, upload or script call more than 2 s after the last result that said where the page is is refused with 'take a snapshot first', at 2 s it is not", () => {
    expect(FRESH_PAGE_MS).toBe(2000);
    result("browser_navigate", pageResult("https://a.test/"), { url: "https://a.test/" });
    now += FRESH_PAGE_MS;
    expect(call("browser_click", { target: "e1" })).toMatchObject({ kind: "allow" });
    now += 1;
    for (const [tool, input] of [["browser_click", { target: "e1" }], ["browser_type", { target: "e1", text: "x" }], ["browser_press_key", { key: "Enter" }], ["browser_file_upload", { paths: ["a.txt"] }], ["browser_evaluate", { function: "() => 1" }]] as const) {
      const v = call(tool, input);
      expect([tool, v.kind]).toEqual([tool, "deny"]);
      expect((v as { reason: string }).reason).toMatch(/2 s old.*page may have changed by itself.*browser_snapshot first/);
    }
    // Reads, navigations and the way out are not held by it.
    expect(call("browser_snapshot")).toMatchObject({ kind: "allow" });
    expect(call("browser_take_screenshot")).toMatchObject({ kind: "allow" });
    expect(call("browser_navigate", { url: "https://a.test/x" })).toMatchObject({ kind: "allow" });
    expect(call("browser_close")).toMatchObject({ kind: "allow" });
    // A snapshot's page block makes it fresh again.
    result("browser_snapshot", pageResult("https://a.test/"));
    expect(call("browser_click", { target: "e1" })).toMatchObject({ kind: "allow" });
    // A clock that went backwards is not fresh either.
    now -= 10_000;
    expect(call("browser_click", { target: "e1" })).toMatchObject({ kind: "deny" });
  });

  test("[C3] review C4-4: any result carrying the server's page block counts (a click's own result); one without it (a screenshot, a console read) does not refresh the clock", () => {
    result("browser_navigate", pageResult("https://a.test/"), { url: "https://a.test/" });
    now += 1500;
    result("browser_click", pageResult("https://a.test/"), { target: "e1" });
    now += 1500; // 3 s after the navigation, 1.5 s after the click's page block
    expect(call("browser_click", { target: "e1" })).toMatchObject({ kind: "allow" });
    result("browser_take_screenshot", "### Result\nTook a screenshot");
    result("browser_console_messages", pageResult("https://a.test/")); // page text: never an address
    now += 1000;
    expect(call("browser_click", { target: "e1" })).toMatchObject({ kind: "deny" });
  });

  test("[C3] review C4-4: a browser_wait_for whose result has no page block makes the page unknown for input even within 2 s; one whose result carries it is fresh", () => {
    result("browser_navigate", pageResult("https://a.test/"), { url: "https://a.test/" });
    result("browser_wait_for", "### Result\nWaited for 0.1", { time: 0.1 });
    expect(gate.state("s1").unknown).toBe("wait");
    expect(call("browser_click", { target: "e1" })).toMatchObject({ kind: "deny", reason: expect.stringMatching(/while browser_wait_for waited.*browser_snapshot first/) });
    expect(call("browser_take_screenshot")).toMatchObject({ kind: "allow" }); // reads may run
    result("browser_snapshot", pageResult("https://a.test/"));
    expect(call("browser_click", { target: "e1" })).toMatchObject({ kind: "allow" });
    now += 5000;
    result("browser_wait_for", `### Result\nWaited for 5\n${pageResult("https://a.test/")}`, { time: 5 });
    expect(call("browser_click", { target: "e1" })).toMatchObject({ kind: "allow" });
  });
});
