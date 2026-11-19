/**
 * [C2] Real-tool suite for the agent browser (agent-cad-and-browser §8.3, Phase C2 Acceptance).
 *
 * Real Chrome, real `npx -y @playwright/mcp@0.0.86`, launched from the EXACT command the preset
 * builds in fallback mode (headless, Playwright's throwaway `--isolated` profile) through the real
 * registry (`buildMcpServers`, so the `env -i` wrap is part of it), with the daemon's real proxy as
 * its only route out. The test speaks MCP to the server over stdio, standing where the Claude CLI
 * would; no Claude API call is made.
 *
 * "A daemon the browser must not reach" is a local fixture server on a random loopback port. Nothing
 * here touches the live Anvil daemon, `~/.anvil` or a real Chrome profile.
 *
 * Skipped unless ANVIL_REAL_TOOLS=1. Under it, a machine without Chrome or npx FAILS (the first
 * test asserts the integration is ready) rather than skipping.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpIntegration } from "@protocol";
import { buildMcpServers } from "../../src/agent/mcp-external";
import { BROWSER_CHROME_ARGS, PLAYWRIGHT_MCP_PACKAGE, buildBrowserLaunch, presetArgProblems } from "../../src/browser/preset";
import { ownHosts, type ProxyDecision } from "../../src/browser/proxy";
import { parsePageReport } from "../../src/browser/sites";
import { BROWSER_TOOL_NAMES } from "../../src/browser/tools";
import { browserIntegrationDefaults } from "../../src/browser/service";
import type { Session } from "../../src/session/session";
import { startFixtureSite, type FixtureSite } from "../fixtures/browser/fixture-site";
import { McpStdioClient } from "../fixtures/browser/mcp-stdio-client";
import { callHookFull, isPending, mcpRig, parked, settle, type McpRig } from "../helpers/mcp";
import { REAL } from "../helpers/real-tools";

let rig: McpRig;
let worktree: string;
let site: FixtureSite; // the "daemon" the browser must not reach (until its port is opened)
let other: FixtureSite; // a second loopback server that is never opened
let session: Session;
let integration: McpIntegration;
let client: McpStdioClient | undefined;
let launched: { command: string; args: string[] };
let proxyPort = 0;
const decisions: ProxyDecision[] = [];

const ps = (): string[] => Bun.spawnSync(["ps", "-axww", "-o", "command="]).stdout.toString().split("\n");
const browser = () => rig.sup.mcp.browser!;
const hook = (tool: string, input: Record<string, unknown>) => callHookFull(session, rig.broker, `mcp__browser__${tool}`, { inProcessKeys: [], gate: rig.sup.mcp.gate }, input);

/** Call a real tool and hand the result to the registry, exactly as the driver does. */
async function run(tool: string, input: Record<string, unknown> = {}, sent: Record<string, unknown> = input): Promise<string> {
  const { reply, text } = await client!.tool(tool, sent);
  rig.sup.mcp.gate.onToolResult(session, "browser", { tool, input, content: reply.content, isError: reply.isError === true });
  return text;
}

beforeAll(async () => {
  if (!REAL) return;
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c2-real-wt-")));
  site = startFixtureSite();
  other = startFixtureSite();
  rig = mcpRig({
    features: ["mcp-integrations", "browser"],
    realProber: true, // the real PATH probe plus the browser's own health check (node, Chrome, proxy)
    browser: {
      desktopProbe: () => ({ desktop: false, reason: "the real suite always runs headless" }),
      onProxyDecision: (d) => void decisions.push(d),
      sitesIntervalMs: 0,
    },
  });
  integration = rig.sup.mcp.add(browserIntegrationDefaults());
  await rig.sup.mcpIntegrationCheck();
  session = await rig.session({ cwd: worktree });
  rig.sup.setSessionMcpIntegrations(session.id, [integration.id]);
  await settle();
}, 60_000);

afterAll(async () => {
  if (!REAL) return;
  await client?.close();
  site?.stop();
  other?.stop();
  await rig?.cleanup();
  if (worktree) rmSync(worktree, { recursive: true, force: true });
  // Nothing this suite started may outlive it.
  if (proxyPort) expect(ps().filter((l) => l.includes(`127.0.0.1:${proxyPort}`))).toEqual([]);
}, 60_000);

describe("real Chrome through the real proxy", () => {
  test.skipIf(!REAL)("[C2] real: Chrome and npx are present, and the preset's fallback command starts Playwright MCP 0.0.86 with exactly the 25 classified tools", async () => {
    // Not a skip: with ANVIL_REAL_TOOLS a machine missing Chrome, npx or node fails here.
    expect(rig.sup.mcp.statuses()[0]!.health).toEqual({ state: "ready" });
    expect(rig.sup.mcp.statuses()[0]!.browser!.mode).toBe("headless");

    const { servers, skipped } = buildMcpServers(session.data, undefined, rig.sup.mcp.statuses());
    expect(skipped).toEqual([]);
    launched = servers.browser as { command: string; args: string[] };
    expect(launched.command).toBe("/usr/bin/env");
    expect(launched.args[0]).toBe("-i");
    proxyPort = browser().proxies.get(session.id)!.port;

    // The wrapped line IS the preset's fallback launch line, argument for argument.
    const expected = buildBrowserLaunch({ mode: "headless", proxyPort, worktree, stateDir: rig.dir, sessionId: session.id });
    const npxAt = launched.args.indexOf("npx");
    expect(launched.args.slice(npxAt)).toEqual(["npx", ...expected.args]);
    expect(launched.args.slice(npxAt + 1, npxAt + 3)).toEqual(["-y", PLAYWRIGHT_MCP_PACKAGE]);
    expect(expected.args).toContain("--headless");
    expect(expected.args).toContain("--isolated");
    expect(presetArgProblems(expected)).toEqual([]);
    expect(JSON.parse(readFileSync(expected.configPath, "utf8"))).toEqual({ browser: { launchOptions: { args: [...BROWSER_CHROME_ARGS] } } });

    // Launched as the SDK would: that command, cwd = the worktree, from a parent full of secrets.
    client = await McpStdioClient.start(launched.command, launched.args, {
      cwd: worktree,
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-must-not-leak", PLAYWRIGHT_MCP_PROXY_BYPASS: "127.0.0.1", PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: "1" },
    });
    const tools = (await client.request("tools/list")).tools.map((t: { name: string }) => t.name).sort();
    expect(tools).toEqual([...BROWSER_TOOL_NAMES].sort());
    expect(tools).toHaveLength(25);
  }, 180_000);

  test.skipIf(!REAL)("[C2] real (a): navigating to a loopback fixture server shows HTTP status: 403 and the fixture records zero requests", async () => {
    const text = await run("browser_navigate", { url: site.url("/page2") });
    expect(text).toContain("HTTP status: 403");
    expect(text).not.toContain("Fixture Two");
    expect(site.requests).toEqual([]);
    const d = decisions.filter((x) => x.port === site.port);
    expect(d.length).toBeGreaterThan(0);
    expect(d.every((x) => !x.allowed)).toBe(true);
  }, 120_000);

  test.skipIf(!REAL)("[C2] real (b): the localhost and [::1] forms of the same server are refused too, with zero requests", async () => {
    for (const host of ["localhost", "[::1]"]) {
      const text = await run("browser_navigate", { url: site.url("/page2", host) });
      expect(text).toContain("HTTP status: 403");
      expect(text).not.toContain("Fixture Two");
    }
    expect(site.requests).toEqual([]);
    expect(decisions.some((x) => x.host === "localhost" && !x.allowed)).toBe(true);
    expect(decisions.some((x) => x.host === "::1" && !x.allowed)).toBe(true);
  }, 120_000);

  test.skipIf(!REAL)("[C2] real (b2): a tailnet address and this machine's own network address are refused the same way — the target is never contacted and the result shows 403", async () => {
    // The stand-in for "the daemon's tailnet address": an address in the tailnet range, and this
    // machine's real interface address. The proxy refuses both before any connection is made.
    const own = ownHosts().find((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h) && !h.startsWith("127."));
    const hosts = ["100.101.102.103", ...(own ? [own] : [])];
    for (const host of hosts) {
      const before = decisions.length;
      const text = await run("browser_navigate", { url: site.url("/api/health", host) });
      expect([host, text.includes("HTTP status: 403")]).toEqual([host, true]);
      const mine = decisions.slice(before).filter((x) => x.host === host);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((x) => !x.allowed && x.address === undefined)).toBe(true);
    }
    expect(site.requests).toEqual([]);
  }, 120_000);

  test.skipIf(!REAL)("[C2] real (d): after allowLoopbackPort the same navigation succeeds, for that port only", async () => {
    expect(browser().allowLoopbackPort(session.id, site.port)).toBe(true);
    const text = await run("browser_navigate", { url: site.url("/page2") });
    expect(text).toContain("Page Title: Fixture Two");
    expect(text).not.toContain("HTTP status: 403");
    expect(site.requests.map((r) => r.path)).toContain("/page2");

    const blocked = await run("browser_navigate", { url: other.url("/page2") }); // a different loopback port
    expect(blocked).toContain("HTTP status: 403");
    expect(other.requests).toEqual([]);
  }, 120_000);

  test.skipIf(!REAL)("[C2] real (c): a WebSocket from an allowed page to a loopback server fails and never arrives", async () => {
    // The page itself loads (its port is open); its script dials the OTHER loopback server.
    await run("browser_navigate", { url: site.url(`/ws.html?to=${other.port}`) });
    await run("browser_wait_for", { time: 1.5 });
    const snap = await run("browser_snapshot");
    expect(snap).toContain("ws-error");
    expect(snap).not.toContain("ws-got");
    expect(other.requests).toEqual([]);
    expect(decisions.some((x) => x.kind === "connect" && x.port === other.port && !x.allowed)).toBe(true);

    // Control: the same page dialing its own (opened) port does connect, so the failure above is the proxy's.
    await run("browser_navigate", { url: site.url("/ws.html") });
    await run("browser_wait_for", { time: 1.5 });
    expect(await run("browser_snapshot")).toContain("ws-got:echo:hi");
  }, 120_000);

  test.skipIf(!REAL)("[C2] real (e): Chrome's real command line has the proxy, the loopback un-bypass, no QUIC and the WebRTC policy, and the server's has nothing off the allow list", async () => {
    const lines = ps();
    const chrome = lines.find((l) => l.includes(`--proxy-server=http://127.0.0.1:${proxyPort}`) && !l.includes("--type="));
    expect(chrome).toBeDefined();
    for (const flag of BROWSER_CHROME_ARGS) expect(chrome).toContain(flag);
    // Playwright adds its own copy of the loopback un-bypass; the other two come from the preset alone.
    expect(chrome!.split("--disable-quic").length - 1).toBe(1);
    expect(chrome!.split("--force-webrtc-ip-handling-policy=").length - 1).toBe(1);
    expect(chrome).toContain("--headless");
    // Nothing that hides automation or weakens the block was added on top of Playwright's defaults.
    for (const bad of ["--user-agent", "--load-extension", "--disable-web-security", "--ignore-certificate-errors", "--host-resolver-rules", "--host-rules", "--proxy-pac-url", "--no-proxy-server", "--proxy-auto-detect"]) {
      expect(chrome).not.toContain(bad);
    }
    expect(new Set(chrome!.match(/--proxy-bypass-list=\S*/g))).toEqual(new Set(["--proxy-bypass-list=<-loopback>"]));
    expect(chrome!.match(/--proxy-server=\S*/g)).toEqual([`--proxy-server=http://127.0.0.1:${proxyPort}`]);

    // The Playwright MCP server process: its own arguments, read back from ps, pass the allow list.
    const server = lines.find((l) => l.includes(`--proxy-server http://127.0.0.1:${proxyPort}`) && l.includes("--browser chrome") && !l.includes("/usr/bin/env"));
    expect(server).toBeDefined();
    const expected = buildBrowserLaunch({ mode: "headless", proxyPort, worktree, stateDir: rig.dir, sessionId: session.id });
    const fromPs = server!.slice(server!.indexOf("--browser chrome")).trim().split(/\s+/);
    expect(fromPs).toEqual(expected.args.slice(2));
    expect(presetArgProblems({ command: "npx", args: ["-y", PLAYWRIGHT_MCP_PACKAGE, ...fromPs], configJson: expected.configJson })).toEqual([]);
  }, 60_000);

  test.skipIf(!REAL)("[C2] real (f): the page-URL parser reads the URL from real navigate, snapshot and click results", async () => {
    const nav = await run("browser_navigate", { url: site.url("/") });
    expect(parsePageReport(nav)).toEqual({ blocks: 1, url: site.url("/") });

    const snap = await run("browser_snapshot");
    expect(parsePageReport(snap)).toEqual({ blocks: 1, url: site.url("/") });

    const ref = /Go to page two.*?\[ref=([^\]]+)\]/.exec(snap)?.[1] ?? /\[ref=([^\]]+)\][^\n]*Go to page two/.exec(snap)?.[1];
    expect(ref).toBeDefined();
    const click = await run("browser_click", { element: "Go to page two link", target: ref, ref });
    expect(parsePageReport(click)).toEqual({ blocks: 1, url: site.url("/page2") });

    // A redirect reports the FINAL address.
    const redir = await run("browser_navigate", { url: site.url(`/redir?to=${encodeURIComponent(site.url("/page2", "localhost"))}`) });
    expect(parsePageReport(redir).url).toBe(site.url("/page2", "localhost"));
    // A result with nothing new about the page has no block at all: unchanged.
    expect(parsePageReport(await run("browser_wait_for", { time: 0.1 })).blocks).toBeLessThanOrEqual(1);
  }, 120_000);

  test.skipIf(!REAL)("[C2] real: a page that lands on an unapproved site is held; Deny leaves the real browser on about:blank", async () => {
    browser().gate.forget(session.id); // start from a session with no approvals and no page state
    await run("browser_navigate", { url: "about:blank" });

    // 127.0.0.1 is approved once; the fixture then redirects to `localhost` — another site.
    const first = hook("browser_navigate", { url: site.url("/") });
    expect(await isPending(first)).toBe(true);
    expect(parked(session).suggestions.map((s) => s.label)).toEqual(["Allow once", "Always allow 127.0.0.1", "Deny"]);
    rig.sup.resolvePermission(parked(session).requestId, "allow");
    expect((await first).decision).toBe("allow");
    const redirect = { url: site.url(`/redir?to=${encodeURIComponent(site.url("/page2", "localhost"))}`) };
    expect((await hook("browser_navigate", redirect)).decision).toBe("allow"); // same site: no prompt
    expect(await run("browser_navigate", redirect)).toContain(`Page URL: ${site.url("/page2", "localhost")}`);
    expect(browser().gate.state(session.id).hold).toEqual({ kind: "site", site: "localhost", url: site.url("/page2", "localhost") });

    // The next call — a read — is held. Deny: the read is refused and only the way out is open.
    const held = hook("browser_snapshot", {});
    expect(await isPending(held)).toBe(true);
    expect(parked(session).suggestions.map((s) => s.label)).toEqual(["Allow once", "Always allow localhost", "Deny"]);
    rig.sup.resolvePermission(parked(session).requestId, "deny");
    const refused = await held;
    expect(refused.decision).toBe("deny");
    expect(refused.reason).toMatch(/browser_navigate/);
    expect((await hook("browser_click", { element: "x", target: "e1" })).decision).toBe("deny");

    // Whatever URL the model now asks for, the gate turns it into about:blank — run it for real.
    const out = await hook("browser_navigate", { url: site.url("/page2", "localhost") });
    expect(out.decision).toBe("allow");
    expect(out.updatedInput).toEqual({ url: "about:blank" });
    const blank = await run("browser_navigate", { url: site.url("/page2", "localhost") }, out.updatedInput);
    expect(parsePageReport(blank).url).toBe("about:blank");
    const after = await client!.tool("browser_snapshot");
    expect(parsePageReport(after.text).url).toBe("about:blank"); // the real page really is blank
    expect(browser().gate.state(session.id).closing).toBeUndefined();
    expect(browser().gate.state(session.id).hold).toBeUndefined();

    // The other route: the held call is itself a navigation, so Deny performs the blanking at once.
    await run("browser_navigate", redirect);
    expect(browser().gate.state(session.id).hold?.kind).toBe("site");
    const heldNav = hook("browser_navigate", { url: site.url("/") });
    expect(await isPending(heldNav)).toBe(true);
    rig.sup.resolvePermission(parked(session).requestId, "deny");
    const rewritten = await heldNav;
    expect(rewritten.decision).toBe("allow");
    expect(rewritten.updatedInput).toEqual({ url: "about:blank" });
    expect(parsePageReport(await run("browser_navigate", { url: site.url("/") }, rewritten.updatedInput)).url).toBe("about:blank");
    expect(parsePageReport((await client!.tool("browser_snapshot")).text).url).toBe("about:blank");
  }, 180_000);
});
