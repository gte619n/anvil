/**
 * [C1] The driver side of MCP integrations (mcp-integrations spec §4.3/§4.5; agent-cad-and-browser
 * §4.14 item 31): the options every session's query gets, and what the driver reports to the registry
 * as the SDK stream goes by. A scripted queryFn stands in for the SDK.
 */
import { test, expect } from "bun:test";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Session as SessionData } from "@protocol";
import { AgentDriver, MCP_RESOURCE_TOOLS } from "../../src/agent/driver";
import type { McpSessionGate } from "../../src/agent/mcp-gate";
import { PermissionBroker } from "../../src/agent/permissions";
import { QuestionBroker } from "../../src/agent/questions";
import { Session } from "../../src/session/session";

function session(over: Partial<SessionData> = {}): Session {
  const data = { id: "sess_d", title: "t", cwd: "/tmp/wt", model: "opus", autonomy: "mostly-autonomous", status: "idle", source: "existing-dir", usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...over } as SessionData;
  return new Session(data, 0, () => {}, () => {});
}

/** A queryFn that records its options and replays `messages`. */
function scripted(messages: unknown[]) {
  const calls: any[] = [];
  const fn = (args: any) => {
    calls.push(args);
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
      },
      interrupt: async () => {},
      setModel: async () => {},
      getContextUsage: async () => undefined,
    };
  };
  return { fn: fn as never, calls };
}

function recordingGate(): { gate: McpSessionGate; log: string[] } {
  const log: string[] = [];
  const gate: McpSessionGate = {
    lookup: () => ({ deny: "n/a" }),
    heldByOther: () => undefined,
    acquire: () => ({ ok: true }),
    isAllowed: () => false,
    rememberAllowed: () => {},
    onToolResult: (_s, key) => void log.push(`result:${key}`),
    onInit: (_s, servers) => void log.push(`init:${servers.map((x) => `${x.name}=${x.status}`).join(",")}`),
    onTurnEnd: () => void log.push("turn-end"),
    onConsumeExit: () => void log.push("consume-exit"),
  };
  return { gate, log };
}

function driver(s: Session, queryFn: never, servers?: Record<string, McpServerConfig>, allowed?: string[], gate?: McpSessionGate): AgentDriver {
  return new AgentDriver(s, { render: (x: string) => ({ source: x, html: x }) } as never, new PermissionBroker(), new QuestionBroker(), {}, () => {}, servers, allowed, undefined, queryFn, undefined, undefined, undefined, undefined, undefined, undefined, undefined, gate);
}

const wait = () => new Promise((r) => setTimeout(r, 15));

test("[C1] every session's query gets strictMcpConfig: true and the three resource tools disallowed — with no servers at all, too", async () => {
  const q = scripted([]);
  driver(session(), q.fn).prompt("hi");
  await wait();
  expect(q.calls).toHaveLength(1);
  const o = q.calls[0].options;
  expect(o.strictMcpConfig).toBe(true);
  expect(o.disallowedTools).toEqual(["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]);
  expect(MCP_RESOURCE_TOOLS).toEqual(o.disallowedTools);
  expect(o.mcpServers).toBeUndefined();
  expect(o.allowedTools).toBeUndefined();
  expect(o.settingSources).toEqual([]); // still no on-disk settings: the daemon stays the permission authority
});

test("[C1] a role session keeps its in-process server and its role tool ids under strictMcpConfig", async () => {
  const q = scripted([]);
  const anvil = { type: "sdk", name: "anvil", instance: {} } as never;
  driver(session({ isDefault: true }), q.fn, { anvil }, ["mcp__anvil__list_sessions"]).prompt("hi");
  await wait();
  const o = q.calls[0].options;
  expect(o.strictMcpConfig).toBe(true);
  expect(o.mcpServers).toEqual({ anvil });
  expect(o.mcpServers.anvil).toBe(anvil);
  expect(o.allowedTools).toEqual(["mcp__anvil__list_sessions"]);
  expect(o.disallowedTools).toEqual(["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]);
});

test("[C1] an integration server is passed to the SDK but never contributes an allowedTools entry", async () => {
  const q = scripted([]);
  const echo = { command: "/usr/bin/env", args: ["-i", "PATH=/usr/bin", "HOME=/h", "TMPDIR=/t", "echo-mcp"], alwaysLoad: true };
  driver(session(), q.fn, { echo }).prompt("hi");
  await wait();
  const o = q.calls[0].options;
  expect(o.mcpServers).toEqual({ echo });
  expect(o.allowedTools ?? []).toEqual([]);
  expect(JSON.stringify(o.allowedTools ?? [])).not.toContain("mcp__echo__");
});

test("[C1] the driver reports init-time server status, integration tool results, the turn end and the loop exit to the registry", async () => {
  const { gate, log } = recordingGate();
  const q = scripted([
    { type: "system", subtype: "init", session_id: "c1", slash_commands: [], mcp_servers: [{ name: "echo", status: "failed", source: "sdk" }, { name: "anvil_cad", status: "connected" }, { bogus: true }] },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "mcp__echo__ping", input: {} }, { type: "tool_use", id: "tu_2", name: "Bash", input: {} }, { type: "tool_use", id: "tu_3", name: "mcp__anvil_cad__measure", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "ok" }, { type: "tool_result", tool_use_id: "tu_3", content: "ok" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "pong" }] } },
    // A sub-agent's integration call: hidden from the transcript, still tracked for the lock.
    { type: "assistant", parent_tool_use_id: "task_1", message: { content: [{ type: "tool_use", id: "tu_4", name: "mcp__web__fetch", input: {} }] } },
    { type: "user", parent_tool_use_id: "task_1", message: { content: [{ type: "tool_result", tool_use_id: "tu_4", content: "ok" }] } },
    { type: "result", subtype: "success", total_cost_usd: 0, usage: {} },
  ]);
  const s = session();
  driver(s, q.fn, { anvil_cad: { type: "sdk", name: "anvil_cad", instance: {} } as never, echo: { command: "/usr/bin/env", args: ["-i"] } }, undefined, gate).prompt("go");
  await wait();
  expect(log).toEqual(["init:echo=failed,anvil_cad=connected", "result:echo", "result:web", "turn-end", "consume-exit"]);
  expect(s.data.status).toBe("idle");
});

test("[C1] a turn that throws still reports the loop exit, so no lock outlives a dead turn", async () => {
  const { gate, log } = recordingGate();
  const fn = (() => ({
    async *[Symbol.asyncIterator]() {
      throw new Error("network timeout");
    },
    interrupt: async () => {},
  })) as never;
  const s = session();
  s.emitError = () => {};
  driver(s, fn, undefined, undefined, gate).prompt("go");
  await wait();
  expect(log).toEqual(["consume-exit"]);
});
