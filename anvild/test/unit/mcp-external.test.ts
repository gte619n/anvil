/** [C1] buildMcpServers (mcp-integrations spec §4.3, §6, §7). */
import { describe, test, expect, afterEach } from "bun:test";
import type { McpIntegrationStatus, Session as SessionData } from "@protocol";
import { buildMcpServers, defaultMcpChildEnv, inProcessKeys, isOrdinarySession, wrapStdio } from "../../src/agent/mcp-external";
import { registerMcpPreset } from "../../src/mcp/presets";

const ENV = { PATH: "/opt/bin:/usr/bin:/bin", HOME: "/Users/op", TMPDIR: "/tmp/x" };

const session = (over: Partial<SessionData> = {}): SessionData =>
  ({ id: "sess_1", title: "t", cwd: "/work/tree", autonomy: "mostly-autonomous", status: "idle", mcpIntegrations: ["mcpi_echo"], ...over }) as SessionData;

const echo = (over: Partial<McpIntegrationStatus> = {}): McpIntegrationStatus => ({
  id: "mcpi_echo",
  key: "echo",
  kind: "custom",
  label: "Echo",
  transport: { type: "stdio", command: "echo-mcp", args: ["--root", "{cwd}", "--name={cwd}/x"] },
  exclusive: false,
  enabled: true,
  health: { state: "ready" },
  checkedAt: 1,
  ...over,
});

/** A stand-in for an in-process sdk server config (the instance is opaque to buildMcpServers). */
const sdk = (name: string) => ({ type: "sdk", name, instance: { marker: name } }) as never;

const unregister: (() => void)[] = [];
afterEach(() => {
  for (const u of unregister.splice(0)) u();
});

describe("buildMcpServers", () => {
  test("[C1] an ordinary session with stdio integration `echo` gets servers.echo wrapped in /usr/bin/env -i with {cwd} replaced and no secret-looking key", () => {
    // The daemon's own environment is full of things the server must never see.
    const saved = { ...process.env };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-secret";
    process.env.OPENROUTER_API_KEY = "sk-or-secret";
    try {
      const { servers, skipped } = buildMcpServers(session(), undefined, [echo()], ENV);
      expect(skipped).toEqual([]);
      expect(Object.keys(servers)).toEqual(["echo"]);
      const cfg = servers.echo as { command: string; args: string[]; alwaysLoad?: boolean; env?: unknown };
      expect(cfg.command).toBe("/usr/bin/env");
      expect(cfg.args[0]).toBe("-i");
      expect(cfg.args).toEqual(["-i", "PATH=/opt/bin:/usr/bin:/bin", "HOME=/Users/op", "TMPDIR=/tmp/x", "echo-mcp", "--root", "/work/tree", "--name=/work/tree/x"]);
      expect(cfg.alwaysLoad).toBe(true);
      expect(cfg.env).toBeUndefined(); // the SDK's `env` ADDS to the inherited environment — never used
      expect(JSON.stringify(servers)).not.toMatch(/TOKEN|KEY|ANTHROPIC/);
      expect(JSON.stringify(servers)).not.toContain("secret");

      // The default child env (no explicit one passed) is still only those three variables.
      const viaDefault = buildMcpServers(session(), undefined, [echo()]).servers.echo as { args: string[] };
      const assignments = viaDefault.args.slice(1, viaDefault.args.indexOf("echo-mcp"));
      expect(assignments.map((a) => a.split("=")[0])).toEqual(["PATH", "HOME", "TMPDIR"]);
      expect(JSON.stringify(viaDefault)).not.toMatch(/TOKEN|KEY|ANTHROPIC/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  test("[C1] the same call for a concierge session returns only `anvil`", () => {
    const anvil = sdk("anvil");
    const { servers, skipped } = buildMcpServers(session({ isDefault: true }), { anvil }, [echo()], ENV);
    expect(Object.keys(servers)).toEqual(["anvil"]);
    expect(servers.anvil).toBe(anvil);
    expect(skipped).toEqual([]);
  });

  test("[C1] lead, member, planner and builder sessions get their role server only", () => {
    for (const [over, key] of [
      [{ teamRole: "lead" }, "anvil_team"],
      [{ teamRole: "member", parentId: "sess_lead" }, "anvil_member"],
      [{ workUnitRole: "planner", workUnitId: "wu_1" }, "anvil_planning"],
      [{ workUnitRole: "builder", workUnitId: "wu_1" }, undefined],
    ] as const) {
      const s = session(over as Partial<SessionData>);
      expect(isOrdinarySession(s)).toBe(false);
      const { servers, skipped } = buildMcpServers(s, key ? { [key]: sdk(key) } : undefined, [echo()], ENV);
      expect(Object.keys(servers)).toEqual(key ? [key] : []);
      expect(skipped).toEqual([]);
    }
    expect(isOrdinarySession(session())).toBe(true);
  });

  test("[C1] an http integration becomes { type: http, url, alwaysLoad: true }", () => {
    const web = echo({ id: "mcpi_web", key: "web", label: "Web", transport: { type: "http", url: "http://127.0.0.1:27182/mcp" } });
    const { servers } = buildMcpServers(session({ mcpIntegrations: ["mcpi_web"] }), undefined, [web], ENV);
    expect(servers).toEqual({ web: { type: "http", url: "http://127.0.0.1:27182/mcp", alwaysLoad: true } });
  });

  test("[C1] a hand-edited non-loopback URL is rejected at build time and reported in skipped", () => {
    for (const url of ["http://evil.example.com/mcp", "https://127.0.0.1:9/mcp", "http://user:pw@localhost:9/mcp", "http://169.254.169.254/latest", "nonsense"]) {
      const web = echo({ id: "mcpi_web", key: "web", label: "Web", transport: { type: "http", url } });
      const { servers, skipped } = buildMcpServers(session({ mcpIntegrations: ["mcpi_web"] }), undefined, [web], ENV);
      expect(servers).toEqual({});
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({ id: "mcpi_web", label: "Web" });
      expect(skipped[0]!.reason).toMatch(/url/);
    }
  });

  test("[C1] an unavailable integration is left out and returned in skipped with its reason", () => {
    const down = echo({ health: { state: "unavailable", reason: "nothing is listening on port 27182" } });
    expect(buildMcpServers(session(), undefined, [down], ENV)).toEqual({ servers: {}, skipped: [{ id: "mcpi_echo", label: "Echo", reason: "nothing is listening on port 27182" }] });
  });

  test("[C1] a disabled integration is left out and returned in skipped", () => {
    const off = echo({ enabled: false, health: { state: "disabled" } });
    const { servers, skipped } = buildMcpServers(session(), undefined, [off], ENV);
    expect(servers).toEqual({});
    expect(skipped).toEqual([{ id: "mcpi_echo", label: "Echo", reason: "switched off in Settings" }]);
    // `enabled: false` wins even if a stale health says ready.
    expect(buildMcpServers(session(), undefined, [echo({ enabled: false })], ENV).servers).toEqual({});
  });

  test("[C1] the same id twice is added once; an unknown id is ignored; an integration not in the session's list is not attached", () => {
    const other = echo({ id: "mcpi_other", key: "other", label: "Other" });
    const { servers, skipped } = buildMcpServers(session({ mcpIntegrations: ["mcpi_echo", "mcpi_echo", "mcpi_gone"] }), undefined, [echo(), other], ENV);
    expect(Object.keys(servers)).toEqual(["echo"]);
    expect(skipped).toEqual([]);
    expect(buildMcpServers(session({ mcpIntegrations: undefined }), undefined, [echo()], ENV)).toEqual({ servers: {}, skipped: [] });
  });

  test("[C1] the in-process server map is passed through unchanged — including `anvil_cad` on an ordinary session", () => {
    const cad = sdk("anvil_cad");
    const inProcess = { anvil_cad: cad };
    const { servers } = buildMcpServers(session(), inProcess, [echo()], ENV);
    expect(Object.keys(servers)).toEqual(["anvil_cad", "echo"]);
    expect(servers.anvil_cad).toBe(cad);
    expect(inProcess).toEqual({ anvil_cad: cad }); // the caller's map is not mutated
    expect(inProcessKeys(servers)).toEqual(["anvil_cad"]);
    expect(inProcessKeys(undefined)).toEqual([]);
  });

  test("[C1] an integration whose key is reserved or already taken by an in-process server is never attached", () => {
    for (const key of ["anvil", "anvil_team", "anvil_member", "anvil_planning", "anvil_cad"]) {
      const bad = echo({ key }); // only reachable through a hand-edited store file
      const { servers, skipped } = buildMcpServers(session(), { anvil_cad: sdk("anvil_cad") }, [bad], ENV);
      expect(Object.keys(servers)).toEqual(["anvil_cad"]);
      expect(skipped).toHaveLength(1);
    }
  });

  test("[C1] gamed spec: the result is server configs only — no allowedTools, no mcp__echo__ id anywhere", () => {
    const built = buildMcpServers(session(), { anvil_cad: sdk("anvil_cad") }, [echo()], ENV);
    expect(Object.keys(built).sort()).toEqual(["servers", "skipped"]);
    expect(JSON.stringify(built.servers.echo)).not.toContain("mcp__");
    expect(JSON.stringify(built.servers.echo)).not.toContain("allowedTools");
  });

  test("[C1] a kind's preset can resolve the launch line per session, or skip with a reason; the result is still wrapped and checked", () => {
    const browser = echo({ id: "mcpi_b", key: "browser", kind: "browser", label: "Browser" });
    const s = session({ mcpIntegrations: ["mcpi_b"] });
    unregister.push(registerMcpPreset({ kind: "browser", title: "Browser", resolveTransport: (_i, ctx) => ({ type: "stdio", command: "npx", args: ["pw", "--output-dir", `${ctx.cwd}/.anvil-browser`] }) }));
    expect((buildMcpServers(s, undefined, [browser], ENV).servers.browser as { args: string[] }).args).toEqual([
      "-i",
      "PATH=/opt/bin:/usr/bin:/bin",
      "HOME=/Users/op",
      "TMPDIR=/tmp/x",
      "npx",
      "pw",
      "--output-dir",
      "/work/tree/.anvil-browser",
    ]);
    unregister.push(registerMcpPreset({ kind: "browser", title: "Browser", resolveTransport: () => ({ skip: "no desktop session" }) }));
    expect(buildMcpServers(s, undefined, [browser], ENV)).toEqual({ servers: {}, skipped: [{ id: "mcpi_b", label: "Browser", reason: "no desktop session" }] });
    unregister.push(registerMcpPreset({ kind: "browser", title: "Browser", resolveTransport: () => ({ type: "http", url: "http://example.com/" }) }));
    expect(buildMcpServers(s, undefined, [browser], ENV).servers).toEqual({});
    unregister.push(
      registerMcpPreset({
        kind: "browser",
        title: "Browser",
        resolveTransport: () => {
          throw new Error("kaboom");
        },
      }),
    );
    expect(buildMcpServers(s, undefined, [browser], ENV).skipped[0]!.reason).toContain("kaboom");
  });
});

test("[C1] wrapStdio puts -i first and passes exactly PATH, HOME and TMPDIR", () => {
  expect(wrapStdio("cmd", ["a b", "c"], ENV)).toEqual({ command: "/usr/bin/env", args: ["-i", "PATH=/opt/bin:/usr/bin:/bin", "HOME=/Users/op", "TMPDIR=/tmp/x", "cmd", "a b", "c"] });
  expect(Object.keys(defaultMcpChildEnv({ PATH: "/p", HOME: "/h", TMPDIR: "/t", CLAUDE_CODE_OAUTH_TOKEN: "x" }))).toEqual(["PATH", "HOME", "TMPDIR"]);
});
