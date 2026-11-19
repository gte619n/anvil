/**
 * Shared fixtures for the agent-browser tests (Phase C2): the MCP rig with the "browser" feature on
 * and its machine probes faked (desktop session, npx/node/Chrome present), a session with the browser
 * switched on and its launch line resolved (so its proxy listener exists), and helpers to call the
 * real PreToolUse hook and feed tool results the way the driver does. Nothing here starts a browser.
 */
import type { McpIntegration } from "@protocol";
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
}

export function browserRig(opts: BrowserRigOptions = {}): McpRig {
  const desktop = opts.desktop ?? true;
  return mcpRig({
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
      ...opts.browser,
    },
  });
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
