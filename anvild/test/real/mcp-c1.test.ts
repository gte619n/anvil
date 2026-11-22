/**
 * [C1] Real-tool check for the MCP integrations registry (agent-cad-and-browser §8.3). No Claude API
 * call and no browser: it launches the exact command line `buildMcpServers` produces for the `echo`
 * fixture as a real child process, speaks MCP to it over stdio, and reads back the environment the
 * server actually got. Skipped unless ANVIL_REAL_TOOLS=1.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { buildMcpServers } from "../../src/agent/mcp-external";
import { ConnectionRegistry } from "../../src/server/registry";
import { Supervisor } from "../../src/session/supervisor";
import { REAL } from "../helpers/real-tools";
import { echoInput } from "../helpers/mcp";

/** Newline-delimited JSON-RPC over a child's stdio. */
function rpcClient(proc: ReturnType<typeof Bun.spawn>) {
  const pending = new Map<number, (m: any) => void>();
  let nextId = 1;
  let buf = "";
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      }
    }
  })();
  const write = (o: unknown) => {
    (proc.stdin as { write: (s: string) => void; flush?: () => void }).write(JSON.stringify(o) + "\n");
    (proc.stdin as { flush?: () => void }).flush?.();
  };
  return {
    notify: (method: string, params: unknown = {}) => write({ jsonrpc: "2.0", method, params }),
    request: (method: string, params: unknown = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = nextId++;
        const t = setTimeout(() => reject(new Error(`no reply to ${method} within 10 s`)), 10_000);
        pending.set(id, (m) => (clearTimeout(t), resolve(m)));
        write({ jsonrpc: "2.0", id, method, params });
      }),
  };
}

test.skipIf(!REAL)("[C1] the env -i command line buildMcpServers produces starts the echo server, which answers MCP and sees only PATH, HOME and TMPDIR", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-mcp-real-state-"));
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "anvil-mcp-real-wt-")));
  // Real store, real service, REAL prober (it resolves the command on PATH; it does not launch it).
  const sup = new Supervisor({ stateDir, envFile: join(stateDir, "env"), features: ["mcp-integrations"], mcp: { intervalMs: 0 } }, new ConnectionRegistry());
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const echo = sup.mcp.add(echoInput());
    await sup.mcpIntegrationCheck();
    expect(sup.mcpIntegrationsEvent().integrations[0]!.health).toEqual({ state: "ready" });
    const s = await sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: worktree });
    sup.setSessionMcpIntegrations(s.id, [echo.id]);

    const { servers, skipped } = buildMcpServers(s.data, undefined, sup.mcp.statuses());
    expect(skipped).toEqual([]);
    const cfg = servers.echo as { command: string; args: string[] };
    expect(cfg.command).toBe("/usr/bin/env");
    expect(cfg.args[0]).toBe("-i");

    // Launch it the way the SDK would: that command, those args, cwd = the session worktree, and a
    // parent environment full of credentials the server must never inherit.
    proc = Bun.spawn([cfg.command, ...cfg.args], {
      cwd: worktree,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-must-not-leak",
        ANTHROPIC_API_KEY: "sk-ant-api-must-not-leak",
        OPENROUTER_API_KEY: "sk-or-must-not-leak",
        CLAUDE_CODE_MESSAGING_TOKEN: "msg-must-not-leak",
        CLAUDE_CODE_SESSION_ID: "session-must-not-leak",
        PLAYWRIGHT_MCP_PROXY_BYPASS: "must-not-leak",
      },
    });
    const rpc = rpcClient(proc);

    const init = await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "anvil-c1-real", version: "0" } });
    expect(init.result.serverInfo.name).toBe("echo-mcp");
    rpc.notify("notifications/initialized");

    const tools = await rpc.request("tools/list");
    expect(tools.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["envkeys", "ping"]);

    const pong = await rpc.request("tools/call", { name: "ping", arguments: { text: "hello" } });
    expect(pong.result.content).toEqual([{ type: "text", text: "pong hello" }]);

    const env = await rpc.request("tools/call", { name: "envkeys", arguments: {} });
    const seen = JSON.parse(env.result.content[0].text) as { keys: string[]; argv: string[]; cwd: string };
    // Only PATH, HOME and TMPDIR — plus the one variable macOS itself adds to every process.
    expect(seen.keys.filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["HOME", "PATH", "TMPDIR"]);
    expect(seen.keys.filter((k) => /TOKEN|KEY|ANTHROPIC|CLAUDE|PLAYWRIGHT/.test(k))).toEqual([]);
    expect(seen.argv).toEqual(["--root", worktree]); // {cwd} was substituted
    expect(realpathSync(seen.cwd)).toBe(worktree);
  } finally {
    proc?.kill();
    await sup.shutdown();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});
