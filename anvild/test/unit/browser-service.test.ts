/**
 * [C2] The browser service on a real Supervisor (src/browser/service.ts wired through
 * session/mcp-integration-service.ts): the "browser" feature flag, the fixed preset, the launch line
 * a session gets (through C1's `env -i` wrap), fail-closed behaviour when the proxy cannot run, the
 * health check, the session lifecycle, and the protected rule for the browser's own files.
 * No browser is started: machine probes are faked (test/helpers/browser.ts).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { connect } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpPreset } from "../../src/mcp/presets";
import { mcpKindGate, mcpKindResultHook } from "../../src/agent/mcp-gate";
import { BROWSER_CHROME_ARGS, presetArgProblems } from "../../src/browser/preset";
import { BROWSER_SITES_FILE } from "../../src/browser/sites";
import { RUNTIME_MARKER, browserRuntimeCli, browserRuntimeDir } from "../../src/browser/runtime";
import { browserIntegrationDefaults, daemonApiCommandProblem } from "../../src/browser/service";
import { serverCapabilities } from "../../src/server/identity";
import { TEST_NODE, addBrowser, browserHook, browserOf, browserRig, browserSession, feedResult, pageResult, seedBrowserRuntime, startBrowser } from "../helpers/browser";
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
    expect(added).toMatchObject({ key: "browser", kind: "browser", label: "My browser", exclusive: true, transport: { type: "stdio", command: "node", args: ["@playwright/mcp@0.0.86 (pinned runtime in the daemon's state folder)"] } });
    expect(() => rig.sup.mcp.add(browserIntegrationDefaults())).toThrow(/already used/); // one per machine

    rig.sup.mcp.update(added.id, { transport: { type: "stdio", command: "/bin/sh", args: [] }, exclusive: false, label: "Agent browser" });
    expect(rig.sup.mcp.store.get(added.id)).toMatchObject({ label: "Agent browser", exclusive: true, transport: { command: "node" } });
  });

  test("[C2] a session's launch line is the preset's, wrapped in env -i: node by absolute path running the daemon-owned runtime's script by absolute path; the config file holds exactly the three Chrome arguments; the proxy port is the session's own listener", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await browserSession(rig, integration);
    const cfg = startBrowser(rig, s)!;
    expect(cfg.command).toBe("/usr/bin/env");
    expect(cfg.args[0]).toBe("-i");
    const at = cfg.args.indexOf(TEST_NODE);
    expect(cfg.args.slice(1, at).map((a) => a.split("=")[0])).toEqual(["PATH", "HOME", "TMPDIR"]);
    expect(cfg.args[1]).toBe(`PATH=${process.env.PATH}`);
    // No package runner anywhere in the line, and nothing in it is relative to the worktree.
    expect(cfg.args.some((a) => /^(npx|npm|bunx|pnpm|yarn|-y)$/.test(a))).toBe(false);

    const args = cfg.args.slice(at + 1);
    const cli = browserRuntimeCli(rig.dir);
    expect(args[0]).toBe(cli);
    expect(cli.startsWith(join(rig.dir, "browser", "runtime-"))).toBe(true);
    expect(cli.startsWith(s.data.cwd + "/.")).toBe(false);
    expect(presetArgProblems({ command: TEST_NODE, args, configJson: { browser: { launchOptions: { args: [...BROWSER_CHROME_ARGS] } } } }, cli)).toEqual([]);
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
    expect(joined).toContain(browserRuntimeCli(rig.dir));
    expect(joined).not.toContain(" npx ");
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
    expect(row().browser).toEqual({ mode: "headless", modeReason: "Headless with a throwaway profile: nobody is logged in at this machine's screen.", proxy: { state: "ready", sessions: 1 }, runtime: { state: "installed", package: "@playwright/mcp@0.0.86" }, desktop: false });
  });

  test("[C2] the worktree's .git/info/exclude gains .anvil-browser/ when the session folder is a checkout", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const wt = join(rig.dir, "checkout");
    mkdirSync(join(wt, ".git", "info"), { recursive: true });
    writeFileSync(join(wt, ".git", "info", "exclude"), "");
    await browserSession(rig, integration, { cwd: wt });
    // (Phase C3 adds the download quarantine next to it.)
    expect(readFileSync(join(wt, ".git", "info", "exclude"), "utf8")).toBe(".anvil-browser/\n.anvil-downloads/\n");
  });

  test("[C2] the row in mcp.integrations carries the mode with its reason and the proxy state", async () => {
    rig = browserRig();
    await addBrowser(rig);
    expect(row().health).toEqual({ state: "ready" });
    expect(row().browser).toEqual({ mode: "headed", modeReason: "Headed, with the agent profile: evan is logged in at the screen.", proxy: { state: "ready", sessions: 0 }, runtime: { state: "installed", package: "@playwright/mcp@0.0.86" }, desktop: true });
    expect(rig.sup.mcpIntegrationsEvent().integrations[0]!.browser?.mode).toBe("headed");
  });
});

describe("health and fail closed", () => {
  test("[C2] the browser is unavailable when node is not on the PATH it would be started with, or Chrome is not installed", async () => {
    for (const [seams, reason] of [
      [{ nodePath: () => undefined }, /node was not found/],
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

  test("[C2] only a launch error counts as a failed headed launch: the words in a URL, in page text or in a successful result do not switch the machine to headless", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await browserSession(rig, integration);
    for (const [text, isError] of [
      ["### Error\nError: browserBackend.callTool: net::ERR_NAME_NOT_RESOLVED at https://a.test/Failed to launch/browserType.launch", true],
      ["### Error\nTimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - locator resolved to <a>browserType.launchPersistentContext: Failed to launch</a>", true],
      [`${pageResult("https://a.test/", "Failed to launch browserType.launch")}`, false],
      ["### Result\n[LOG] browserType.launchPersistentContext: Failed to launch", false],
      ["### Error\nError: browserType.launchPersistentContext: Failed to launch\nuser data directory is already in use", true],
    ] as const) {
      feedResult(rig, s, "browser_navigate", text, { url: "https://a.test/" }, isError);
      expect([text.slice(0, 40), row().browser!.mode]).toEqual([text.slice(0, 40), "headed"]);
    }
  });
});

describe("the pinned server runtime", () => {
  test("[C2] runtime not installed: health is unavailable with the reason, no launch line is built, the daemon tries one install by itself, and a failure is reported until Install succeeds", async () => {
    let attempts = 0;
    let online = false;
    rig = browserRig({
      runtime: false,
      browser: {
        runtimeInstaller: async (stateDir) => {
          attempts++;
          if (!online) throw new Error("npm ci failed (exit 1): getaddrinfo ENOTFOUND registry.npmjs.org");
          seedBrowserRuntime(stateDir);
        },
      },
    });
    const integration = await addBrowser(rig); // add → probe → health finds it missing → one automatic attempt
    await settle(10);
    await rig.sup.mcp.probe("timer");
    expect(attempts).toBe(1);
    expect(row().health.state).toBe("unavailable");
    expect((row().health as { reason: string }).reason).toMatch(/browser runtime is not installed.*could not be installed.*ENOTFOUND.*Install browser runtime/);
    expect(row().browser!.runtime).toMatchObject({ state: "missing", package: "@playwright/mcp@0.0.86", reason: expect.stringMatching(/ENOTFOUND/) });

    // Fail closed: no launch line, no proxy-less start, every call denied.
    const s = await rig.session();
    rig.sup.setSessionMcpIntegrations(s.id, [integration.id]);
    await settle(10);
    expect(startBrowser(rig, s)).toBeUndefined();
    expect((await browserHook(rig, s, "browser_snapshot")).decision).toBe("deny");
    // It does not hammer the registry: further probes do not retry by themselves.
    await rig.sup.mcp.probe("timer");
    await rig.sup.mcp.probe("timer");
    expect(attempts).toBe(1);

    // "Install browser runtime" while still offline: refused with the reason.
    await expect(rig.sup.browserRuntimeInstall()).rejects.toThrow(/ENOTFOUND/);
    expect(attempts).toBe(2);
    // Online: it installs, health turns ready, and the launch line appears.
    online = true;
    await rig.sup.browserRuntimeInstall();
    expect(attempts).toBe(3);
    expect(row().health).toEqual({ state: "ready" });
    expect(row().browser!.runtime).toEqual({ state: "installed", package: "@playwright/mcp@0.0.86" });
    expect(startBrowser(rig, s)!.args).toContain(browserRuntimeCli(rig.dir));
    await rig.sup.browserRuntimeInstall(); // already installed: nothing to do
    expect(attempts).toBe(3);
  });

  test("[C2] the runtime is verified before EVERY launch: a missing script, a changed lock copy or a marker for another lock stops the launch", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await browserSession(rig, integration);
    expect(startBrowser(rig, s)).toBeDefined();
    const dir = browserRuntimeDir(rig.dir);

    rmSync(browserRuntimeCli(rig.dir));
    expect(startBrowser(rig, s)).toBeUndefined();
    seedBrowserRuntime(rig.dir);
    expect(startBrowser(rig, s)).toBeDefined();

    writeFileSync(join(dir, "package-lock.json"), readFileSync(join(dir, "package-lock.json"), "utf8").replace("0.0.86", "0.0.87"));
    expect(startBrowser(rig, s)).toBeUndefined();
    seedBrowserRuntime(rig.dir);

    writeFileSync(join(dir, RUNTIME_MARKER), JSON.stringify({ lockSha256: "0".repeat(64) }));
    expect(startBrowser(rig, s)).toBeUndefined();
    seedBrowserRuntime(rig.dir);

    writeFileSync(join(dir, "node_modules", "@playwright", "mcp", "package.json"), JSON.stringify({ version: "9.9.9" }));
    expect(startBrowser(rig, s)).toBeUndefined();
  });

  test("[C2] a planted server in the worktree is never the launch target: node_modules/@playwright/mcp and node_modules/.bin in the session folder change nothing in the launch line", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const wt = join(rig.dir, "wt");
    mkdirSync(join(wt, "node_modules", "@playwright", "mcp"), { recursive: true });
    mkdirSync(join(wt, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "@playwright", "mcp", "package.json"), JSON.stringify({ name: "@playwright/mcp", version: "0.0.86", bin: { "playwright-mcp": "cli.js" } }));
    writeFileSync(join(wt, "node_modules", "@playwright", "mcp", "cli.js"), "require('fs').writeFileSync('PWNED','1')");
    writeFileSync(join(wt, "node_modules", ".bin", "playwright-mcp"), "#!/bin/sh\ntouch PWNED\n", { mode: 0o755 });
    writeFileSync(join(wt, ".npmrc"), "script-shell=/tmp/evil.sh\nnode-options=--require /tmp/evil.js\nregistry=http://127.0.0.1:1/\ncache=/tmp/evil-cache\n");
    const s = await browserSession(rig, integration, { cwd: wt });
    const line = startBrowser(rig, s)!;
    const at = line.args.indexOf(TEST_NODE);
    expect(line.args[at + 1]).toBe(browserRuntimeCli(rig.dir));
    expect(line.args.filter((a) => a.startsWith(wt)).map((a) => a.slice(wt.length))).toEqual(["/.anvil-browser"]); // only the output folder
    expect(line.args.slice(1, at).map((a) => a.split("=")[0])).toEqual(["PATH", "HOME", "TMPDIR"]); // env -i: no npm_config_*, no NODE_OPTIONS
  });
});

describe("what the model is told, and what it may not keep (review of Phase C2)", () => {
  test("[C2] a request the network block refused is told to the model with its next browser call, in plain words", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    rig.sup.browserSiteAdd("a.test");
    const s = await browserSession(rig, integration);
    const b = browserOf(rig);
    b.proxies.onSessionDecision!(s.id, { kind: "connect", host: "127.0.0.1", port: 7701, allowed: false, reason: "127.0.0.1 is a loopback address" });
    b.proxies.onSessionDecision!(s.id, { kind: "connect", host: "127.0.0.1", port: 7701, allowed: false, reason: "127.0.0.1 is a loopback address" });
    b.proxies.onSessionDecision!(s.id, { kind: "http", host: "public.example", port: 80, allowed: true });
    const out = await browserHook(rig, s, "browser_snapshot");
    expect(out.decision).toBe("allow");
    expect(out.additionalContext).toMatch(/Blocked by Anvil's network policy/);
    expect(out.additionalContext).toContain("127.0.0.1:7701 (127.0.0.1 is a loopback address)");
    expect(out.additionalContext!.split("127.0.0.1:7701").length - 1).toBe(1); // said once
    expect(out.additionalContext).not.toContain("public.example");
    expect((await browserHook(rig, s, "browser_snapshot")).additionalContext).toBeUndefined(); // and only once
    // On a denied call it rides in the reason the model reads.
    b.proxies.onSessionDecision!(s.id, { kind: "http", host: "10.0.0.5", port: 80, allowed: false, reason: "a private address (10.0.0.0/8)" });
    const denied = await browserHook(rig, s, "browser_run_code_unsafe", { code: "x" });
    expect(denied.reason).toMatch(/never allowed[\s\S]*Blocked by Anvil's network policy[\s\S]*10\.0\.0\.5:80/);
  });

  test("[C2] a result showing a page on a site that is not allowed has its snapshot and screenshot files deleted from .anvil-browser/ at once; files of allowed pages and files elsewhere are left alone", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    rig.sup.browserSiteAdd("a.test");
    const s = await browserSession(rig, integration);
    const out = join(s.data.cwd, ".anvil-browser");
    const outside = join(s.data.cwd, "keep.yml");
    const file = (name: string): string => (writeFileSync(join(out, name), "secret page text"), join(out, name));
    writeFileSync(outside, "mine");

    const ok = file("page-2026-11-19T10-00-00-000Z.yml");
    feedResult(rig, s, "browser_navigate", `### Page\n- Page URL: https://a.test/\n### Snapshot\n- [Snapshot](${ok})`);
    expect(existsSync(ok)).toBe(true);

    const leaked = file("page-2026-11-19T10-00-01-000Z.yml");
    feedResult(rig, s, "browser_navigate_back", `### Ran Playwright code\n\`\`\`js\nawait page.goBack();\n\`\`\`\n### Page\n- Page URL: https://c.test/secret\n### Snapshot\n- [Snapshot](${leaked})\n- [x](${outside})\n- [y](/etc/hosts.yml)`);
    expect(browserOf(rig).gate.state(s.id).hold).toMatchObject({ kind: "site", site: "c.test" });
    expect(existsSync(leaked)).toBe(false);
    expect(existsSync(ok)).toBe(true);
    expect(existsSync(outside)).toBe(true); // named in the result, but not in the output folder
  });

  test("[C2] session Bash that calls the daemon's browser or fleet routes, or talks to the daemon's own port, is denied (a tripwire: the agent runs as the daemon's user)", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    browserOf(rig).setFleet({ selfServerId: "srv_x", members: () => [], pairedHubId: () => null, selfUrl: async () => undefined, selfPort: 7701 });
    const tool = (command: string) => callHook(s, rig.broker, "Bash", { inProcessKeys: [], gate: rig.sup.mcp.gate }, { command });
    for (const command of [
      `curl -s -X POST http://127.0.0.1:7701/api/browser/sites/op -H 'content-type: application/json' -d '{"from":"x","ops":[{"op":"add","site":"evil.test"}]}'`,
      `wget -qO- https://m4.tail1234.ts.net/api/fleet/members`,
      `curl http://localhost:7701/api/health`,
      `nc 127.0.0.1 7701`,
      `node -e 'fetch("http://127.0.0.1:7701/api/sessions")'`,
      `bun -e 'new WebSocket("ws://127.0.0.1:7701/ws")'`,
      `python3 -c 'import urllib.request; urllib.request.urlopen("http://host/api/browser/sites/sync")'`,
    ]) {
      const out = await tool(command);
      expect([command, out.decision]).toEqual([command, "deny"]);
    }
    for (const command of ["curl -s https://example.com/api/v1/items", "git log -7701", "curl http://127.0.0.1:5173/", "echo 7701", "ls api/browser/"]) {
      expect([command, (await tool(command)).decision]).toEqual([command, "allow"]);
    }
    expect(daemonApiCommandProblem("curl http://127.0.0.1:7701/", undefined)).toBeUndefined(); // port unknown: only the routes are matched
    expect(daemonApiCommandProblem("curl http://127.0.0.1:7701/api/fleet/x", undefined)).toBeDefined();
  });

  test("[C2] the test-daemon exemption needs a registration: a bare port, the daemon's own port and another session's port are refused; revoke forgets it", async () => {
    rig = browserRig();
    const integration = await addBrowser(rig);
    const a = await browserSession(rig, integration);
    const b = await browserSession(rig, integration);
    const svc = browserOf(rig);
    svc.setFleet({ selfServerId: "srv_x", members: () => [], pairedHubId: () => null, selfUrl: async () => undefined, selfPort: 7701 });
    expect(svc.allowLoopbackPort(a.id, 45001)).toBe(false); // never registered
    expect(svc.registerTestDaemon(a.id, 7701)).toEqual({ ok: false, reason: expect.stringMatching(/own port/) });
    expect(svc.registerTestDaemon(a.id, 80)).toMatchObject({ ok: false });
    expect(svc.registerTestDaemon(a.id, svc.proxies.get(b.id)!.port)).toMatchObject({ ok: false });
    expect(svc.registerTestDaemon(a.id, 45001)).toEqual({ ok: true });
    expect(svc.registerTestDaemon(b.id, 45001)).toEqual({ ok: false, reason: expect.stringMatching(/another session/) });
    expect(svc.allowLoopbackPort(b.id, 45001)).toBe(false);
    expect(svc.allowLoopbackPort(a.id, 45001)).toBe(true);
    expect(svc.allowLoopbackPort(a.id, 7701)).toBe(false);
    svc.revokeLoopbackPort(a.id, 45001);
    expect(svc.proxies.get(a.id)!.allowedLoopbackPorts()).toEqual([]);
    expect(svc.allowLoopbackPort(a.id, 45001)).toBe(false); // the registration went with it
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
