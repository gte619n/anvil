/**
 * Shared fixtures for the agent-browser tests (Phase C2): the MCP rig with the "browser" feature on
 * and its machine probes faked (desktop session, npx/node/Chrome present), a session with the browser
 * switched on and its launch line resolved (so its proxy listener exists), and helpers to call the
 * real PreToolUse hook and feed tool results the way the driver does. Nothing here starts a browser.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpIntegration } from "@protocol";
import { PLAYWRIGHT_MCP_VERSION } from "../../src/browser/preset";
import { RUNTIME_MARKER, browserRuntimeCli, browserRuntimeDir, browserRuntimeManifest } from "../../src/browser/runtime";
import type { McpServiceSession } from "../../src/session/mcp-integration-service";
import type { BrowserService } from "../../src/browser/service";
import { browserIntegrationDefaults } from "../../src/browser/service";
import type { Session } from "../../src/session/session";
import { callHookFull, mcpRig, settle, type FullHookOutcome, type McpRig } from "./mcp";

export interface BrowserRigOptions {
  /** Whether the fake desktop probe reports a logged-in desktop (default true → headed). */
  desktop?: boolean;
  features?: string[];
  stateDir?: string;
  browser?: NonNullable<Parameters<typeof mcpRig>[0]>["browser"];
  /** false: leave the server runtime uninstalled (default: a stand-in is seeded). */
  runtime?: boolean;
}

/** The fake `node` the rig's launch lines name (nothing is started in these tests). */
export const TEST_NODE = "/opt/anvil-test/bin/node";

/**
 * Put a stand-in for the installed server runtime in `stateDir`: the marker, the lock copy and a
 * `cli.js`, exactly where `installBrowserRuntime` leaves them, so `browserRuntimeProblem` passes
 * without npm or the network. `cli` is the script's text (the real suite installs the real one).
 */
export function seedBrowserRuntime(stateDir: string, cli = "// stand-in for @playwright/mcp's cli.js\n"): string {
  const dir = browserRuntimeDir(stateDir);
  const m = browserRuntimeManifest();
  mkdirSync(join(dir, "node_modules", "@playwright", "mcp"), { recursive: true });
  writeFileSync(join(dir, "package.json"), m.packageJson);
  writeFileSync(join(dir, "package-lock.json"), m.packageLock);
  writeFileSync(join(dir, "node_modules", "@playwright", "mcp", "package.json"), JSON.stringify({ name: "@playwright/mcp", version: PLAYWRIGHT_MCP_VERSION }));
  writeFileSync(browserRuntimeCli(stateDir), cli);
  writeFileSync(join(dir, RUNTIME_MARKER), JSON.stringify({ lockSha256: m.lockSha256 }));
  return dir;
}

export function browserRig(opts: BrowserRigOptions = {}): McpRig {
  const desktop = opts.desktop ?? true;
  const rig = mcpRig({
    features: opts.features ?? ["mcp-integrations", "browser"],
    stateDir: opts.stateDir,
    browser: {
      desktopProbe: () => (desktop ? { desktop: true, reason: "evan is logged in at the screen" } : { desktop: false, reason: "nobody is logged in at this machine's screen" }),
      commandExists: () => true,
      chromeInstalled: () => true,
      sitesIntervalMs: 0,
      resolver: async (host) => {
        throw new Error(`unexpected DNS lookup of ${host} in a test`);
      },
      nodePath: () => TEST_NODE,
      runtimeInstaller: async () => {
        throw new Error("unexpected browser runtime install in a test");
      },
      // "Open agent browser" must never start a real Chrome from a test: tests that exercise it pass
      // their own fake launcher.
      chromePath: () => "/opt/anvil-test/Google Chrome",
      agentBrowserLauncher: () => {
        throw new Error("unexpected Chrome launch in a test");
      },
      ...opts.browser,
    },
  });
  if (opts.runtime !== false && rig.sup.mcp.browser) seedBrowserRuntime(rig.dir);
  return rig;
}

export const browserOf = (rig: McpRig): BrowserService => rig.sup.mcp.browser!;

/** Add the browser integration and probe it. */
export async function addBrowser(rig: McpRig): Promise<McpIntegration> {
  const integration = rig.sup.mcp.add(browserIntegrationDefaults());
  await rig.sup.mcpIntegrationCheck();
  return integration;
}

/**
 * A new ordinary session with the browser switched on and its driver's server map built once, which
 * is what resolves the launch line and starts the session's proxy listener.
 */
export async function browserSession(rig: McpRig, integration: McpIntegration, over: Partial<Session["data"]> = {}): Promise<Session> {
  const s = await rig.session(over);
  rig.sup.setSessionMcpIntegrations(s.id, [integration.id]);
  await settle();
  startBrowser(rig, s);
  return s;
}

/** What `ensureDriver` does for the MCP map: returns the launch line the session's browser gets. */
export function startBrowser(rig: McpRig, s: McpServiceSession): { command: string; args: string[] } | undefined {
  return rig.sup.mcp.serversFor(s, undefined)?.browser as { command: string; args: string[] } | undefined;
}

/** Call the real PreToolUse hook for `mcp__browser__<tool>`. */
export function browserHook(rig: McpRig, s: Session, tool: string, input: Record<string, unknown> = {}): Promise<FullHookOutcome> {
  return callHookFull(s, rig.broker, `mcp__browser__${tool}`, { inProcessKeys: [], gate: rig.sup.mcp.gate }, input);
}

/** A tool result in Playwright MCP's format reporting the page at `url`. */
export function pageResult(url: string, title = "Page"): string {
  return `### Ran Playwright code\n\`\`\`js\n// …\n\`\`\`\n### Page\n- Page URL: ${url}\n- Page Title: ${title}\n### Snapshot\n- [Snapshot](/abs/page.yml)`;
}

/** Deliver a tool result through the registry's `onToolResult`, as the driver does. */
export function feedResult(rig: McpRig, s: Session, tool: string, text: string, input: Record<string, unknown> = {}, isError = false): void {
  rig.sup.mcp.gate.onToolResult(s, "browser", { tool, input, content: [{ type: "text", text }], isError });
}
