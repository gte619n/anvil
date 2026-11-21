/**
 * [C4] The `anvil_test` tool surface (src/agent/testdaemon-tools.ts): the two tools, what they
 * return, the reserved server name, and the words the session's system prompt gains.
 */
import { describe, test, expect } from "bun:test";
import { BROWSER_SESSION_PROMPT, HUMAN_MCP_SERVER_NAME, browserSessionPrompt } from "../../src/agent/human-tools";
import { TEST_DAEMON_SESSION_PROMPT, TEST_DAEMON_TOOL_IDS, TEST_MCP_SERVER_NAME, buildTestDaemonToolsServer, testDaemonTools, type TestDaemonControl } from "../../src/agent/testdaemon-tools";
import { MCP_KEY_RE, RESERVED_MCP_KEYS, keyProblem } from "../../src/mcp/validate";

const session = { id: "s1", data: { id: "s1", cwd: "/work/tree" } } as never;
const run = async (control: TestDaemonControl, name: string): Promise<{ text: string; isError: boolean }> => {
  const t = testDaemonTools(control, session).find((x) => x.name === name)!;
  const out = (await t.handler({}, {} as never)) as { content: { text: string }[]; isError?: boolean };
  return { text: out.content[0]!.text, isError: out.isError === true };
};

describe("the anvil_test server", () => {
  test("[C4] the server is anvil_test with start_test_daemon {} and stop_test_daemon {}; the name is reserved, so no integration can take it", () => {
    expect(TEST_MCP_SERVER_NAME).toBe("anvil_test");
    expect(TEST_DAEMON_TOOL_IDS).toEqual(["mcp__anvil_test__start_test_daemon", "mcp__anvil_test__stop_test_daemon"]);
    const tools = testDaemonTools({ start: async () => ({ error: "x" }), stop: () => false }, session);
    expect(tools.map((t) => t.name)).toEqual(["start_test_daemon", "stop_test_daemon"]);
    for (const t of tools) expect(Object.keys(t.inputSchema as object)).toEqual([]); // both take no arguments
    expect(tools[0]!.description).toMatch(/no credentials[\s\S]*127\.0\.0\.1[\s\S]*temporary home[\s\S]*turn ends[\s\S]*15 minutes/);
    const srv = buildTestDaemonToolsServer({ start: async () => ({ error: "x" }), stop: () => false }, session);
    expect([srv.type, srv.name]).toEqual(["sdk", "anvil_test"]);
    expect(RESERVED_MCP_KEYS).toContain("anvil_test");
    expect(keyProblem("anvil_test")).toBeDefined();
    expect(MCP_KEY_RE.test("anvil_test")).toBe(false); // and the key grammar has no underscore anyway
  });

  test("[C4] start_test_daemon returns {url} as JSON on its first line, says when an existing one is returned, and reports a refusal as an error result", async () => {
    const calls: unknown[] = [];
    const ok = await run({ start: async (s) => (calls.push(s), { url: "http://127.0.0.1:45001", existing: false }), stop: () => false }, "start_test_daemon");
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.text.split("\n")[0]!)).toEqual({ url: "http://127.0.0.1:45001" });
    expect(ok.text).toMatch(/browser_navigate[\s\S]*no credentials[\s\S]*stops when this turn ends/);
    expect(calls).toEqual([session]); // the session the server was built for, not one the model names

    const again = await run({ start: async () => ({ url: "http://127.0.0.1:45001", existing: true }), stop: () => false }, "start_test_daemon");
    expect(JSON.parse(again.text.split("\n")[0]!)).toEqual({ url: "http://127.0.0.1:45001" });
    expect(again.text).toContain("already running");

    const refused = await run({ start: async () => ({ error: "start_test_daemon only works in a checkout of Anvil itself" }), stop: () => false }, "start_test_daemon");
    expect(refused).toEqual({ text: "start_test_daemon only works in a checkout of Anvil itself", isError: true });
  });

  test("[C4] stop_test_daemon stops this session's daemon and says whether there was one", async () => {
    const stops: [string, string][] = [];
    const control: TestDaemonControl = { start: async () => ({ error: "x" }), stop: (id, reason) => (stops.push([id, reason]), stops.length === 1) };
    expect(await run(control, "stop_test_daemon")).toEqual({ text: "The test daemon was stopped and its temporary home deleted.", isError: false });
    expect(await run(control, "stop_test_daemon")).toEqual({ text: "This session has no test daemon running.", isError: false });
    expect(stops).toEqual([["s1", "stop_test_daemon was called"], ["s1", "stop_test_daemon was called"]]);
  });
});

describe("the system prompt", () => {
  test("[C4] a session with anvil_human and anvil_test gets the browser paragraph plus one sentence about the test daemon; without the servers it gets nothing", () => {
    const extra = { [TEST_MCP_SERVER_NAME]: TEST_DAEMON_SESSION_PROMPT };
    expect(browserSessionPrompt([], extra)).toBe("");
    expect(browserSessionPrompt(["browser"], extra)).toBe("");
    expect(browserSessionPrompt([HUMAN_MCP_SERVER_NAME], extra)).toBe(BROWSER_SESSION_PROMPT);
    const both = browserSessionPrompt([HUMAN_MCP_SERVER_NAME, "browser", TEST_MCP_SERVER_NAME], extra);
    expect(both).toBe(BROWSER_SESSION_PROMPT + TEST_DAEMON_SESSION_PROMPT);
    expect(both.trim().split(/\n\n/)).toHaveLength(1); // still one paragraph
    expect(TEST_DAEMON_SESSION_PROMPT).toContain("mcp__anvil_test__start_test_daemon");
    expect(TEST_DAEMON_SESSION_PROMPT).toMatch(/credential-less[\s\S]*only your\s+browser can open[\s\S]*turn ends[\s\S]*15 minutes[\s\S]*browser_evaluate/);
  });
});
