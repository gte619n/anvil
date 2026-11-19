/**
 * [C2] The browser service on a real Supervisor (src/browser/service.ts wired through
 * session/mcp-integration-service.ts): the "browser" feature flag, the fixed preset, the launch line
 * a session gets (through C1's `env -i` wrap), fail-closed behaviour when the proxy cannot run, the
 * health check, the session lifecycle, and the protected rule for the browser's own files.
 * No browser is started: machine probes are faked (test/helpers/browser.ts).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { connect } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpPreset } from "../../src/mcp/presets";
import { mcpKindGate, mcpKindResultHook } from "../../src/agent/mcp-gate";
import { BROWSER_CHROME_ARGS, presetArgProblems } from "../../src/browser/preset";
import { BROWSER_SITES_FILE } from "../../src/browser/sites";
import { browserIntegrationDefaults } from "../../src/browser/service";
import { serverCapabilities } from "../../src/server/identity";
import { addBrowser, browserHook, browserOf, browserRig, browserSession, feedResult, pageResult, startBrowser } from "../helpers/browser";
import { callHook, driversOf, fakeDriver, settle, type McpRig } from "../helpers/mcp";

let rig: McpRig;
afterEach(() => rig.cleanup());

const row = () => rig.sup.mcp.statuses().find((i) => i.kind === "browser")!;
const refused = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(false)));
    s.once("error", () => resolve(true));
  });

describe("feature flag", () => {
  test("[C2] with `browser` absent from ANVIL_FEATURES the preset is not registered, no proxy listens, nothing is written and the commands are refused", async () => {
    rig = browserRig({ features: ["mcp-integrations"] });
    expect(rig.sup.mcp.browser).toBeUndefined();
    expect(mcpPreset("browser")).toBeUndefined();
    expect(mcpKindGate("browser")).toBeUndefined();
    expect(mcpKindResultHook("browser")).toBeUndefined();
    expect(() => rig.sup.mcp.add(browserIntegrationDefaults())).toThrow(/not available on this server/);
    expect(() => rig.sup.browserSitesEvent()).toThrow(/not enabled/);
    expect(() => rig.sup.browserSiteAdd("a.test")).toThrow(/not enabled/);
    expect(() => rig.sup.browserSiteRemove("a.test")).toThrow(/not enabled/);
    await settle();
    expect(readdirSync(rig.dir).filter((f) => /browser/.test(f))).toEqual([]);
    expect(serverCapabilities(["mcp-integrations"])).not.toContain("browser");
    expect(rig.registry.ofType("browser.sites")).toEqual([]);
  });

  test("[C2] `browser` without `mcp-integrations` is inert too; with both, the preset, gate and result hook are registered and removed again on shutdown", async () => {
    rig = browserRig({ features: ["browser"] });
    expect(rig.sup.mcp.browser).toBeUndefined();
    expect(mcpPreset("browser")).toBeUndefined();
    await rig.cleanup();

    rig = browserRig();
    expect(rig.sup.mcp.browser).toBeDefined();
    expect(mcpPreset("browser")?.title).toBe("Browser");
    expect(mcpKindGate("browser")).toBeDefined();
    expect(mcpKindResultHook("browser")).toBeDefined();
    expect(serverCapabilities(["mcp-integrations", "browser"])).toContain("browser");
    await rig.cleanup();
    expect(mcpPreset("browser")).toBeUndefined();
    expect(mcpKindGate("browser")).toBeUndefined();
    rig = browserRig({ features: [] }); // for afterEach
  });
});

describe("the preset", () => {
  test("[C2] the browser integration is key `browser`, stdio, exclusive — whatever the client sends — and update cannot change its transport or exclusivity", async () => {
    rig = browserRig();
    const added = rig.sup.mcp.add({ key: "evil", kind: "browser", label: "My browser", transport: { type: "stdio", command: "/bin/sh", args: ["-c", "evil"] }, exclusive: false, enabled: true });
    expect(added).toMatchObject({ key: "browser", kind: "browser", label: "My browser", exclusive: true, transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@0.0.86"] } });
    expect(() => rig.sup.mcp.add(browserIntegrationDefaults())).toThrow(/already used/); // one per machine

    rig.sup.mcp.update(added.id, { transport: { type: "stdio", command: "/bin/sh", args: [] }, exclusive: false, label: "Agent browser" });
    expect(rig.sup.mcp.store.get(added.id)).toMatchObject({ label: "Agent browser", exclusive: true, transport: { command: "npx" } });
  });

  test("[C2] a session's launch line is the preset's, wrapped in env -i with a PATH for npx and node; the config file holds exactly the three Chrome arguments; the proxy port is the session's own listener", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await browserSession(rig, integration);
    const cfg = startBrowser(rig, s)!;
    expect(cfg.command).toBe("/usr/bin/env");
    expect(cfg.args[0]).toBe("-i");
    const at = cfg.args.indexOf("npx");
    expect(cfg.args.slice(1, at).map((a) => a.split("=")[0])).toEqual(["PATH", "HOME", "TMPDIR"]);
    expect(cfg.args[1]).toBe(`PATH=${process.env.PATH}`);

    const args = cfg.args.slice(at + 1);
    expect(presetArgProblems({ command: "npx", args, configJson: { browser: { launchOptions: { args: [...BROWSER_CHROME_ARGS] } } } })).toEqual([]);
    const port = browserOf(rig).proxies.get(s.id)!.port;
    expect(args[args.indexOf("--proxy-server") + 1]).toBe(`http://127.0.0.1:${port}`);
    expect(args[args.indexOf("--output-dir") + 1]).toBe(join(s.data.cwd, ".anvil-browser"));
    expect(args[args.indexOf("--user-data-dir") + 1]).toBe(join(rig.dir, "browser-profile")); // headed: the desktop probe says yes
    expect(args).not.toContain("--headless");

    const configPath = args[args.indexOf("--config") + 1]!;
    expect(configPath.startsWith(join(rig.dir, "browser", s.id))).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ browser: { launchOptions: { args: ["--proxy-bypass-list=<-loopback>", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] } } });
    expect(existsSync(join(s.data.cwd, ".anvil-browser"))).toBe(true);
  });

  test("[C2] a hand-edited store cannot add a flag: the stored transport is ignored when the launch line is built", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await browserSession(rig, integration);
    rig.sup.mcp.store.update(integration.id, { transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--proxy-bypass", "<loopback>", "--caps", "vision"] } });
    const cfg = startBrowser(rig, s)!;
    const joined = cfg.args.join(" ");
    expect(joined).toContain("@playwright/mcp@0.0.86");
    expect(joined).not.toContain("--proxy-bypass ");
    expect(joined).not.toContain("--caps");
    expect(joined).not.toContain("@latest");
  });

  test("[C2] no desktop session: the session's launch line is headless with a temporary profile, and the row says why", async () => {
    rig = browserRig({ desktop: false });
    const integration = await addBrowser(rig);
    const s = await browserSession(rig, integration);
    const args = startBrowser(rig, s)!.args;
    expect(args.slice(-2)).toEqual(["--isolated", "--headless"]);
    expect(args).not.toContain("--user-data-dir");
    expect(existsSync(join(rig.dir, "browser-profile"))).toBe(false);
    expect(row().browser).toEqual({ mode: "headless", modeReason: "Headless with a throwaway profile: nobody is logged in at this machine's screen.", proxy: { state: "ready", sessions: 1 } });
  });

  test("[C2] the worktree's .git/info/exclude gains .anvil-browser/ when the session folder is a checkout", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const wt = join(rig.dir, "checkout");
    mkdirSync(join(wt, ".git", "info"), { recursive: true });
    writeFileSync(join(wt, ".git", "info", "exclude"), "");
    await browserSession(rig, integration, { cwd: wt });
    expect(readFileSync(join(wt, ".git", "info", "exclude"), "utf8")).toBe(".anvil-browser/\n");
  });

  test("[C2] the row in mcp.integrations carries the mode with its reason and the proxy state", async () => {
    rig = browserRig();
    await addBrowser(rig);
    expect(row().health).toEqual({ state: "ready" });
    expect(row().browser).toEqual({ mode: "headed", modeReason: "Headed, with the agent profile: evan is logged in at the screen.", proxy: { state: "ready", sessions: 0 } });
    expect(rig.sup.mcpIntegrationsEvent().integrations[0]!.browser?.mode).toBe("headed");
  });
});

describe("health and fail closed", () => {
  test("[C2] the browser is unavailable when npx or node is not on the PATH it would be started with, or Chrome is not installed", async () => {
    for (const [seams, reason] of [
      [{ commandExists: (c: string) => c !== "npx" }, /npx was not found/],
      [{ commandExists: (c: string) => c !== "node" }, /node was not found/],
      [{ chromeInstalled: () => false }, /Google Chrome is not installed/],
    ] as const) {
      rig = browserRig({ browser: seams });
      await addBrowser(rig);
      const h = row().health;
      expect(h.state).toBe("unavailable");
      expect((h as { reason: string }).reason).toMatch(reason);
      await rig.cleanup();
    }
    rig = browserRig({ features: [] });
  });

  test("[C2] proxy not running: the preset is skipped with a reason (no launch line, no config file), health reports unavailable, and every browser call is denied", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await rig.session();
    rig.sup.setSessionMcpIntegrations(s.id, [integration.id]);
    browserOf(rig).proxies.stop("the browser's network block is stopped");

    expect(startBrowser(rig, s)).toBeUndefined(); // the browser is never started without its proxy
    expect(existsSync(join(rig.dir, "browser", s.id))).toBe(false);
    await rig.sup.mcp.probe("timer");
    expect(row().health).toEqual({ state: "unavailable", reason: "the browser's network block is stopped" });
    expect(row().browser!.proxy.state).toBe("stopped");
    const out = await browserHook(rig, s, "browser_navigate", { url: "https://a.test/" });
    expect(out.decision).toBe("deny");
  });

  test("[C2] proxy dies under a running session: its port refuses connections (no route out), browser calls are denied, health flips to unavailable, and Check recovers with a new listener", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await browserSession(rig, integration);
    rig.sup.browserSiteAdd("a.test");
    expect((await browserHook(rig, s, "browser_navigate", { url: "https://a.test/" })).decision).toBe("allow");

    const port = browserOf(rig).proxies.get(s.id)!.port;
    browserOf(rig).proxies.get(s.id)!.close(); // the listener dies
    expect(await refused(port)).toBe(true);
    const out = await browserHook(rig, s, "browser_navigate", { url: "https://a.test/" });
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/network block is not running/);
    expect((await browserHook(rig, s, "browser_snapshot")).decision).toBe("deny");
    await rig.sup.mcp.probe("timer");
    expect(row().health.state).toBe("unavailable");

    await rig.sup.mcpIntegrationCheck();
    expect(row().health).toEqual({ state: "ready" });
    startBrowser(rig, s); // the next driver gets a fresh listener
    expect(browserOf(rig).proxies.get(s.id)!.port).not.toBe(port);
    expect((await browserHook(rig, s, "browser_navigate", { url: "https://a.test/" })).decision).toBe("allow");
  });

  test("[C2] a browser call from a session whose browser Anvil never started is denied", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await rig.session();
    rig.sup.setSessionMcpIntegrations(s.id, [integration.id]); // on, but no driver was built
    rig.sup.browserSiteAdd("a.test");
    expect((await browserHook(rig, s, "browser_navigate", { url: "https://a.test/" })).decision).toBe("deny");
  });

  test("[C2] a headed launch that fails switches the machine to headless for the next launch, until Check", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await browserSession(rig, integration);
    expect(startBrowser(rig, s)!.args).toContain("--user-data-dir");
    feedResult(rig, s, "browser_navigate", "### Error\nError: browserType.launchPersistentContext: Failed to launch chrome because no display is available", { url: "https://a.test/" }, true);
    expect(row().browser!.mode).toBe("headless");
    expect(startBrowser(rig, s)!.args.slice(-2)).toEqual(["--isolated", "--headless"]);
    await rig.sup.mcpIntegrationCheck();
    expect(row().browser!.mode).toBe("headed");
  });
});

describe("session lifecycle", () => {
  test("[C2] a session's listener and approvals go when it is reset, deleted, or the browser is switched off for it", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const a = await browserSession(rig, integration);
    const b = await browserSession(rig, integration);
    const c = await browserSession(rig, integration);
    const ports = [a, b, c].map((s) => browserOf(rig).proxies.get(s.id)!.port);
    browserOf(rig).gate.state(a.id).once.add("once.test");

    rig.sup.mcp.onSessionReset(a.id);
    rig.sup.mcp.onSessionGone(b.id);
    rig.sup.setSessionMcpIntegrations(c.id, []);
    await settle();
    for (const s of [a, b, c]) expect(browserOf(rig).proxies.get(s.id)).toBeUndefined();
    for (const p of ports) expect(await refused(p)).toBe(true);
    expect(browserOf(rig).gate.state(a.id).once.size).toBe(0);
    expect(row().browser!.proxy).toEqual({ state: "ready", sessions: 0 });
  });

  test("[C2] the same listener serves a session across driver rebuilds, and a rebuild forgets the old page", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await browserSession(rig, integration);
    const port = browserOf(rig).proxies.get(s.id)!.port;
    feedResult(rig, s, "browser_navigate", pageResult("https://c.test/"));
    expect(browserOf(rig).gate.state(s.id).hold).toBeDefined();
    startBrowser(rig, s);
    expect(browserOf(rig).proxies.get(s.id)!.port).toBe(port);
    expect(browserOf(rig).gate.state(s.id).hold).toBeUndefined();
  });

  test("[C2] when a session uses the headed browser, the idle drivers of other sessions that started one are dropped (one Chrome per profile)", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    rig.sup.browserSiteAdd("a.test");
    const a = await browserSession(rig, integration);
    const b = await browserSession(rig, integration);
    const driverA = fakeDriver();
    driversOf(rig.sup).set(a.id, driverA);
    expect((await browserHook(rig, b, "browser_navigate", { url: "https://a.test/" })).decision).toBe("allow");
    expect(driverA.stopped).toBe(true);
    // A's next call finds no browser of its own until its driver is rebuilt.
    rig.sup.mcp.gate.onTurnEnd(b);
    expect((await browserHook(rig, a, "browser_snapshot")).decision).toBe("deny");
    startBrowser(rig, a);
    expect((await browserHook(rig, a, "browser_snapshot")).decision).toBe("allow");
  });

  test("[C2] the browser is exclusive: while one session holds it, another session's call is denied naming the holder", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    rig.sup.browserSiteAdd("a.test");
    const a = await browserSession(rig, integration, { title: "Session A" });
    const b = await browserSession(rig, integration, { title: "Session B" });
    a.setStatus("thinking"); // mid-turn, so its driver is not dropped
    expect((await browserHook(rig, a, "browser_navigate", { url: "https://a.test/" })).decision).toBe("allow");
    const out = await browserHook(rig, b, "browser_navigate", { url: "https://a.test/" });
    expect(out).toMatchObject({ decision: "deny", reason: "Browser is in use by Session A" });
  });
});

describe("protected files", () => {
  test("[C2] session Bash that launches Chrome on the agent profile is denied, as is any Bash or file tool that touches the profile, the allowed-sites list or the launch files", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    const stateDir = realpathSync(rig.dir);
    const tool = (name: string, input: Record<string, unknown>) => callHook(s, rig.broker, name, { inProcessKeys: [], gate: rig.sup.mcp.gate }, input);

    for (const command of [
      `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=${join(rig.dir, "browser-profile")} https://bank.test/`,
      `open -a "Google Chrome" --args --user-data-dir=$ANVIL_STATE_DIR/browser-profile`,
      `sqlite3 ${join(rig.dir, "browser-profile")}/Default/Cookies 'select * from cookies'`,
      `echo '{"sites":[{"site":"evil.test","addedAt":1}]}' > ${join(rig.dir, BROWSER_SITES_FILE)}`,
      `cat ~/.anvil/browser-sites.json`,
      `cat ${join(rig.dir, "browser", s.id, "playwright-mcp.json")}`,
    ]) {
      const out = await tool("Bash", { command });
      expect([command, out.decision]).toEqual([command, "deny"]);
      expect(out.reason).toMatch(/off limits/);
    }
    for (const [name, input] of [
      ["Read", { file_path: join(rig.dir, "browser-profile", "Default", "Cookies") }],
      ["Write", { file_path: join(rig.dir, BROWSER_SITES_FILE), content: "{}" }],
      ["Edit", { file_path: join(rig.dir, "browser", s.id, "playwright-mcp.json"), old_string: "a", new_string: "b" }],
      ["Glob", { pattern: "*", path: join(rig.dir, "browser-profile") }],
    ] as const) {
      expect([name, (await tool(name, input)).decision]).toEqual([name, "deny"]);
    }
    // Ordinary work is untouched (bypass allows it).
    expect((await tool("Bash", { command: "ls -la && git status" })).decision).toBe("allow");
    expect((await tool("Read", { file_path: join(s.data.cwd, "README.md") })).decision).toBe("allow");
    expect(stateDir.length).toBeGreaterThan(0);
  });
});
