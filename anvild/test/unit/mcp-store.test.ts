/**
 * [C1] McpIntegrationStore + presets (mcp-integrations spec §4.2, §6, §7): persistence, corrupt-file
 * quarantine, key grammar and collisions, loopback-only URLs, preset kinds.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpIntegrationStore, MCP_STORE_FILE } from "../../src/mcp/store";
import { CUSTOM_PRESET, mcpPreset, mcpPresetKinds, registerMcpPreset, substituteCwd } from "../../src/mcp/presets";
import { MCP_KEY_RE, PACKAGE_RUNNERS, RESERVED_MCP_KEYS, keyProblem, loopbackUrlProblem, relativeCommandProblem } from "../../src/mcp/validate";
import { tmpDir } from "../helpers";
import { echoInput } from "../helpers/mcp";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function stateDir(): string {
  const t = tmpDir("anvil-mcp-store-");
  cleanups.push(t.cleanup);
  return t.dir;
}

describe("McpIntegrationStore", () => {
  test("[C1] add assigns an mcpi_ id, persists, and a new store over the same dir reloads it", () => {
    const dir = stateDir();
    const store = new McpIntegrationStore(dir);
    const added = store.add(echoInput());
    expect(added.id).toMatch(/^mcpi_/);
    expect(added).toMatchObject({ key: "echo", kind: "custom", label: "Echo", exclusive: false, enabled: true });
    expect(existsSync(join(dir, MCP_STORE_FILE))).toBe(true);

    const reloaded = new McpIntegrationStore(dir); // a daemon restart
    expect(reloaded.list()).toEqual([added]);
    expect(reloaded.byKey("echo")?.id).toBe(added.id);
    expect(reloaded.get(added.id)?.transport).toEqual(added.transport);
  });

  test("[C1] a corrupt mcp-integrations.json is quarantined to .corrupt-<ts> and the store starts empty", () => {
    const dir = stateDir();
    writeFileSync(join(dir, MCP_STORE_FILE), "{ this is not json");
    const store = new McpIntegrationStore(dir, () => 4242);
    expect(store.list()).toEqual([]);
    expect(store.quarantined).toBe(join(dir, `${MCP_STORE_FILE}.corrupt-4242`));
    expect(readFileSync(store.quarantined!, "utf8")).toBe("{ this is not json"); // the evidence survives
    expect(existsSync(join(dir, MCP_STORE_FILE))).toBe(false);
    // …and the store is usable straight away.
    store.add(echoInput());
    expect(new McpIntegrationStore(dir).list()).toHaveLength(1);
  });

  test("[C1] a file of the wrong shape is quarantined too", () => {
    const dir = stateDir();
    writeFileSync(join(dir, MCP_STORE_FILE), JSON.stringify({ integrations: "nope" }));
    const store = new McpIntegrationStore(dir, () => 7);
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toContain(`${MCP_STORE_FILE}.corrupt-7`);
  });

  test("[C1] a malformed or duplicate row is dropped and the rest of the file loads", () => {
    const dir = stateDir();
    const good = { id: "mcpi_1", key: "echo", kind: "custom", label: "Echo", transport: { type: "stdio", command: "echo-mcp", args: [] }, exclusive: false, enabled: true };
    writeFileSync(
      join(dir, MCP_STORE_FILE),
      JSON.stringify({ integrations: [good, { ...good, id: "mcpi_2" }, { ...good, id: "mcpi_3", key: "anvil" }, { id: "mcpi_4", key: "x" }, "junk"] }),
    );
    const store = new McpIntegrationStore(dir);
    expect(store.list().map((i) => i.id)).toEqual(["mcpi_1"]);
    expect(store.quarantined).toBeUndefined();
  });

  test("[C1] add rejects a key that collides with a built-in server name", () => {
    const store = new McpIntegrationStore(stateDir());
    for (const key of RESERVED_MCP_KEYS) {
      expect(() => store.add(echoInput({ key }))).toThrow();
    }
    expect(() => store.add(echoInput({ key: "anvil" }))).toThrow(/reserved/);
    expect(RESERVED_MCP_KEYS).toEqual(["anvil", "anvil_team", "anvil_member", "anvil_planning", "anvil_cad", "anvil_human"]);
    expect(store.list()).toEqual([]);
  });

  test("[C1] add rejects a key that another integration already uses", () => {
    const store = new McpIntegrationStore(stateDir());
    store.add(echoInput());
    expect(() => store.add(echoInput({ label: "Second" }))).toThrow(/already used/);
    expect(store.list()).toHaveLength(1);
  });

  test("[C1] the key grammar is /^[a-z][a-z0-9]{1,23}$/ — no underscores, no capitals, 2 to 24 characters", () => {
    expect(MCP_KEY_RE.source).toBe("^[a-z][a-z0-9]{1,23}$");
    const store = new McpIntegrationStore(stateDir());
    for (const key of ["e", "Echo", "my_tool", "1echo", "echo-x", "a".repeat(25), "", "echo__x"]) {
      expect(keyProblem(key)).toBeString();
      expect(() => store.add(echoInput({ key }))).toThrow(/key must be/);
    }
    for (const key of ["ec", "echo2", "a".repeat(24)]) expect(keyProblem(key)).toBeUndefined();
  });

  test("[C1] an http integration must be loopback: scheme http, no credentials, host 127.0.0.1 / localhost / [::1]", () => {
    const store = new McpIntegrationStore(stateDir());
    const http = (url: string) => echoInput({ key: "web", transport: { type: "http", url } });
    for (const url of ["https://127.0.0.1:9/mcp", "http://10.0.0.5:9/mcp", "http://example.com/mcp", "http://user:pw@127.0.0.1:9/mcp", "http://user@localhost:9/", "http://127.0.0.1.evil.test/", "ftp://localhost/", "not a url", "http://0.0.0.0:9/"]) {
      expect(loopbackUrlProblem(url)).toBeString();
      expect(() => store.add(http(url))).toThrow();
    }
    expect(store.list()).toEqual([]);
    for (const [key, url] of [["weba", "http://127.0.0.1:27182/mcp"], ["webb", "http://localhost:8080/"], ["webc", "http://[::1]:9000/mcp"]] as const) {
      expect(store.add({ ...http(url), key }).transport).toEqual({ type: "http", url });
    }
  });

  test("[C1] update re-validates the transport, and can never change key or kind", () => {
    const store = new McpIntegrationStore(stateDir());
    const i = store.add(echoInput({ key: "web", transport: { type: "http", url: "http://127.0.0.1:9/mcp" } }));
    expect(() => store.update(i.id, { transport: { type: "http", url: "http://192.168.1.4:9/mcp" } })).toThrow(/this machine/);
    expect(store.get(i.id)!.transport).toEqual({ type: "http", url: "http://127.0.0.1:9/mcp" });

    const after = store.update(i.id, { label: "Web tool", enabled: false, exclusive: true, ...({ key: "other", kind: "browser" } as object) });
    expect(after).toMatchObject({ key: "web", kind: "custom", label: "Web tool", enabled: false, exclusive: true });
    expect(() => store.update("mcpi_missing", { enabled: false })).toThrow(/no such integration/);
  });

  test("[C1] a stdio integration needs a command and string args", () => {
    const store = new McpIntegrationStore(stateDir());
    expect(() => store.add(echoInput({ transport: { type: "stdio", command: "  ", args: [] } }))).toThrow(/command is required/);
    expect(() => store.add(echoInput({ transport: { type: "stdio", command: "x", args: [1 as unknown as string] } }))).toThrow(/args/);
    expect(() => store.add(echoInput({ transport: { type: "sse", url: "http://127.0.0.1/" } as never }))).toThrow(/transport type/);
  });

  test("[C1] a stdio command is a bare name (found on the daemon's PATH) or an absolute path; a relative path, which would run a file from the session's repo, is refused on add and on update", () => {
    const store = new McpIntegrationStore(stateDir());
    for (const command of ["./server", "node_modules/.bin/some-mcp", "bin/mcp", "../mcp", "sub\\\\mcp.exe", ".", ".."]) {
      expect(() => store.add(echoInput({ transport: { type: "stdio", command, args: [] } }))).toThrow(/bare name .* or an absolute path/);
    }
    const ok = store.add(echoInput({ transport: { type: "stdio", command: "some-mcp", args: ["./relative-arg-is-fine"] } }));
    expect(() => store.update(ok.id, { transport: { type: "stdio", command: "./node_modules/.bin/some-mcp", args: [] } })).toThrow(/absolute path/);
    store.update(ok.id, { transport: { type: "stdio", command: "/opt/acme/bin/some-mcp", args: [] } });
    expect(store.get(ok.id)!.transport).toEqual({ type: "stdio", command: "/opt/acme/bin/some-mcp", args: [] });
    // Package runners are allowed (with a warning in the UI); the list is shared with the web.
    expect(PACKAGE_RUNNERS).toEqual(["npx", "npm", "bunx", "pnpm", "yarn"]);
    expect(relativeCommandProblem("npx")).toBeUndefined();
  });

  test("[C1] remove reports whether anything was removed, and a re-add under the same key gets a NEW id", () => {
    const store = new McpIntegrationStore(stateDir());
    const first = store.add(echoInput());
    expect(store.remove(first.id)).toBe(true);
    expect(store.remove(first.id)).toBe(false);
    const second = store.add(echoInput());
    expect(second.key).toBe("echo");
    expect(second.id).not.toBe(first.id);
  });
});

describe("presets", () => {
  test("[C1] custom is the only kind this phase can add; browser is refused until its preset registers", () => {
    expect(mcpPresetKinds()).toEqual(["custom"]);
    expect(mcpPreset("custom")).toBe(CUSTOM_PRESET);
    const store = new McpIntegrationStore(stateDir());
    expect(() => store.add(echoInput({ kind: "browser" }))).toThrow(/not available on this server/);
    expect(() => store.add(echoInput({ kind: "fusion" as never }))).toThrow(/unknown integration kind/);
    expect(() => store.add(echoInput({ kind: "solidcraft" as never }))).toThrow(/unknown integration kind/);

    // What Phase C2 does: register the kind, after which the same add succeeds.
    const unregister = registerMcpPreset({ kind: "browser", title: "Browser" });
    try {
      expect(mcpPresetKinds()).toEqual(["custom", "browser"]);
      expect(store.add(echoInput({ key: "browser", kind: "browser" })).kind).toBe("browser");
    } finally {
      unregister();
    }
    expect(mcpPresetKinds()).toEqual(["custom"]);
  });

  test("[C1] {cwd} is replaced with the worktree and is the only substitution", () => {
    expect(substituteCwd(["mcp", "--allow-path", "{cwd}", "--out={cwd}/out", "{home}", "$HOME", "{CWD}"], "/wt/a b")).toEqual([
      "mcp",
      "--allow-path",
      "/wt/a b",
      "--out=/wt/a b/out",
      "{home}",
      "$HOME",
      "{CWD}",
    ]);
  });
});
