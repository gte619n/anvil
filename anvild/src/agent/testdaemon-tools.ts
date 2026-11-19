import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { Session as SessionData } from "@protocol";
import type { TestDaemonStart } from "../browser/testdaemon";

/**
 * The throwaway test daemon's tools (agent-cad-and-browser §4.12, Phase C4): the in-process server
 * `anvil_test` with `start_test_daemon {}` and `stop_test_daemon {}`, given to ordinary sessions that
 * have the agent browser switched on. The work is `browser/testdaemon.ts`; this file is the tool
 * surface only.
 *
 * Permission: neither tool id is in the driver's `allowedTools`, so every call is decided by the
 * PreToolUse hook as an ordinary non-read-only tool — the session's autonomy policy applies
 * (`prompt-all` and `allowlist` ask; `mostly-autonomous` and `bypass` run it), and if the hook ever
 * fails the `canUseTool` backstop denies it.
 */

export const TEST_MCP_SERVER_NAME = "anvil_test";
export const TEST_DAEMON_TOOL_IDS = [`mcp__${TEST_MCP_SERVER_NAME}__start_test_daemon`, `mcp__${TEST_MCP_SERVER_NAME}__stop_test_daemon`];

/** The sentence a session with these tools gets in its system prompt (see `browserSessionPrompt`). */
export const TEST_DAEMON_SESSION_PROMPT =
  ` To look at Anvil's own UI from this worktree, call \`mcp__${TEST_MCP_SERVER_NAME}__start_test_daemon\`: it builds this ` +
  `worktree, starts a credential-less copy of the daemon on loopback and returns its URL, which only your ` +
  `browser can open. It is stopped when your turn ends (or after 15 minutes), so start it in the turn that ` +
  `uses it. \`browser_evaluate\` works on that page and nowhere else.`;

/** The slice of a live session the tools touch. A real `Session` satisfies it. */
export interface TestDaemonSession {
  id: string;
  data: SessionData;
}

/** What the tools drive. `TestDaemonService` satisfies it. */
export interface TestDaemonControl {
  start(session: TestDaemonSession): Promise<TestDaemonStart>;
  stop(sessionId: string, reason: string): boolean;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

/** The tool definitions (exported so tests can invoke the handlers without a live SDK server). */
export function testDaemonTools(control: TestDaemonControl, session: TestDaemonSession): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "start_test_daemon",
      "Build this worktree's web bundle and start a throwaway copy of the Anvil daemon from this worktree, " +
        "with no credentials, on 127.0.0.1 and a random port, in a new temporary home. Returns {url}. Only " +
        "this session's agent browser can reach it (open it with browser_navigate). One per session: a second " +
        "call returns the same one. It is stopped, and its temporary home deleted, when your turn ends or " +
        "after 15 minutes. Works only in a checkout of Anvil itself.",
      {},
      async () => {
        const out = await control.start(session);
        if ("error" in out) return text(out.error, true);
        return text(
          `${JSON.stringify({ url: out.url })}\n\n${out.existing ? "This session's test daemon is already running." : "The test daemon is running."} ` +
            `Open ${out.url}/ with browser_navigate. It has no credentials, so agent turns inside it are refused; the UI, the API and the WebSocket work. ` +
            `It stops when this turn ends.`,
        );
      },
    ),
    tool("stop_test_daemon", "Stop this session's throwaway test daemon now and delete its temporary home.", {}, async () =>
      text(control.stop(session.id, "stop_test_daemon was called") ? "The test daemon was stopped and its temporary home deleted." : "This session has no test daemon running."),
    ),
  ];
}

export function buildTestDaemonToolsServer(control: TestDaemonControl, session: TestDaemonSession): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: TEST_MCP_SERVER_NAME, version: "1.0.0", tools: testDaemonTools(control, session) });
}
