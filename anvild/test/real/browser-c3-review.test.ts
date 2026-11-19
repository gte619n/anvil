/**
 * [C3] Real-tool repro of the C3 review's veto item 1 (and item 4, a cross-site frame): real Chrome
 * (headless, throwaway profile, the preset's own launch line in `env -i`), the real pinned Playwright
 * MCP server, the daemon's real proxy, and two loopback fixture servers that are two different SITES
 * to the gate: A at `127.0.0.1:<a>` (allowed) and B at `localhost:<b>` (listed as a logged-in site,
 * locked). A's page sends itself to B — by a timer, a meta refresh and `location.replace` — after the
 * result that established it. The agent's next key press or click must not reach B: B records ZERO
 * presses. No Claude API call, no headed browser, nothing of the live daemon.
 *
 * Skipped unless ANVIL_REAL_TOOLS=1; under it a machine without Chrome, node or npm FAILS.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpIntegration } from "@protocol";
import { defaultMcpChildEnv, wrapStdio } from "../../src/agent/mcp-external";
import { buildBrowserLaunch } from "../../src/browser/preset";
import { browserRuntimeCli } from "../../src/browser/runtime";
import { browserIntegrationDefaults } from "../../src/browser/service";
import { resolveOnPath } from "../../src/mcp/health";
import type { Session } from "../../src/session/session";
import { McpStdioClient } from "../fixtures/browser/mcp-stdio-client";
import { callHookFull, isPending, mcpRig, parked, settle, type McpRig } from "../helpers/mcp";
import { REAL } from "../helpers/real-tools";

let rig: McpRig;
let worktree: string;
let session: Session;
let integration: McpIntegration;
let client: McpStdioClient | undefined;
let a: ReturnType<typeof Bun.serve> | undefined;
let b: ReturnType<typeof Bun.serve> | undefined;
let presses = 0;
const html = (title: string, body: string, head = "") => new Response(`<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });
const A = (path: string) => `http://127.0.0.1:${a!.port}${path}`;
const B = (path: string) => `http://localhost:${b!.port}${path}`;

const browser = () => rig.sup.mcp.browser!;
const hook = (tool: string, input: Record<string, unknown> = {}) => callHookFull(session, rig.broker, `mcp__browser__${tool}`, { inProcessKeys: [], gate: rig.sup.mcp.gate }, input);
async function run(tool: string, input: Record<string, unknown> = {}): Promise<string> {
  const { reply, text } = await client!.tool(tool, input);
  rig.sup.mcp.gate.onToolResult(session, "browser", { tool, input, content: reply.content, isError: reply.isError === true });
  return text;
}
/** Ask the gate, and run the call on the real server only if it was allowed (what the CLI does). */
async function attempt(tool: string, input: Record<string, unknown> = {}): Promise<{ decision: string; reason?: string }> {
  const v = await hook(tool, input);
  if (v.decision === "allow") await run(tool, input);
  return v;
}

beforeAll(async () => {
  if (!REAL) return;
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c3r-real-wt-")));
  mkdirSync(join(worktree, ".git", "info"), { recursive: true });
  writeFileSync(join(worktree, ".git", "info", "exclude"), "");
  b = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/pay") return html("B Pay", `<h1>Pay</h1><button id="pay" autofocus onclick="fetch('/pressed',{method:'POST'});document.title='pressed'">Pay now</button>`);
      if (u.pathname === "/pressed") return (presses++, new Response("ok"));
      return new Response("nf", { status: 404 });
    },
  });
  a = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const to = B("/pay");
      if (u.pathname === "/timer") return html("A Timer", `<h1>A</h1><script>setTimeout(()=>{location=${JSON.stringify(to)}},1500)</script>`);
      if (u.pathname === "/meta") return html("A Meta", `<h1>A</h1>`, `<meta http-equiv="refresh" content="1;url=${to}">`);
      if (u.pathname === "/replace") return html("A Replace", `<h1>A</h1><script>setTimeout(()=>location.replace(${JSON.stringify(to)}),1500)</script>`);
      if (u.pathname === "/frame") return html("A Frame", `<h1>A with a frame</h1><button id="mine">Mine</button><iframe src="${to}" width="400" height="200"></iframe>`);
      return new Response("nf", { status: 404 });
    },
  });
  rig = mcpRig({
    features: ["mcp-integrations", "browser"],
    realProber: true,
    browser: {
      desktopProbe: () => ({ desktop: true, reason: "the gate applies the headed rules; the browser started is headless" }),
      sitesIntervalMs: 0,
      agentBrowserLauncher: () => {
        throw new Error("the real suite never opens the owner's Chrome");
      },
    },
  });
  integration = rig.sup.mcp.add(browserIntegrationDefaults());
  await rig.sup.browserRuntimeInstall();
  await rig.sup.mcpIntegrationCheck();
  session = await rig.session({ cwd: worktree, autonomy: "bypass" });
  rig.sup.setSessionMcpIntegrations(session.id, [integration.id]);
  await settle();
}, 600_000);

afterAll(async () => {
  if (!REAL) return;
  await client?.close();
  a?.stop(true);
  b?.stop(true);
  await rig?.cleanup();
  if (worktree) rmSync(worktree, { recursive: true, force: true });
}, 60_000);

describe("real Chrome: a page that moves itself to a locked logged-in site", () => {
  test.skipIf(!REAL)("[C3] real review 1: setup — the real server starts headless through the real proxy; A (127.0.0.1) is allowed, B (localhost) is a locked logged-in site", async () => {
    expect(rig.sup.mcp.serversFor(session, undefined)?.browser).toBeDefined();
    const proxyPort = browser().proxies.get(session.id)!.port;
    const launch = buildBrowserLaunch({ mode: "headless", proxyPort, worktree, stateDir: rig.dir, sessionId: session.id, nodePath: resolveOnPath("node")!, cliPath: browserRuntimeCli(rig.dir) });
    const line = wrapStdio(launch.command, launch.args, defaultMcpChildEnv());
    client = await McpStdioClient.start(line.command, line.args, { cwd: worktree });
    for (const port of [a!.port as number, b!.port as number]) {
      expect(browser().registerTestDaemon(session.id, port)).toEqual({ ok: true });
      expect(browser().allowLoopbackPort(session.id, port)).toBe(true);
    }
    browser().gate.state(session.id).once.add("127.0.0.1");
    browser().gate.state(session.id).once.add("localhost");
    rig.sup.browserLoggedInAdd("localhost");
    expect(browser().loggedIn.isLocked("localhost")).toBe(true);
  }, 180_000);

  for (const how of ["timer", "meta", "replace"] as const) {
    test.skipIf(!REAL)(`[C3] real review 1 (${how}): after A's own ${how} sends it to B, the next key press and click are refused, B records zero presses, and the snapshot then shows B under its hard stop`, async () => {
      const before = presses;
      expect((await attempt("browser_navigate", { url: A(`/${how}`) })).decision).toBe("allow");
      expect((await attempt("browser_snapshot")).decision).toBe("allow");
      expect(browser().gate.state(session.id).currentUrl).toBe(A(`/${how}`));
      await Bun.sleep(3500); // the page moves itself; no tool call is made
      const press = await attempt("browser_press_key", { key: "Enter" });
      expect(press.decision).toBe("deny");
      expect(press.reason).toMatch(/page may have changed by itself.*localhost/);
      const click = await attempt("browser_click", { target: "#pay", element: "Pay now" });
      expect(click.decision).toBe("deny");
      expect(presses).toBe(before); // zero input requests reached B
      // The snapshot establishes the page: it is B now, a locked logged-in site.
      expect((await hook("browser_snapshot")).decision).toBe("allow");
      expect(await run("browser_snapshot")).toContain(`Page URL: ${B("/pay")}`);
      const again = await attempt("browser_press_key", { key: "Enter" });
      expect(again.decision).not.toBe("allow");
      expect(presses).toBe(before);
      expect((await attempt("browser_close")).decision).toBe("allow"); // the way out, always
    }, 180_000);
  }

  test.skipIf(!REAL)("[C3] real review 4: a frame from the locked site B on allowed page A — a click on A is a hard stop naming B (screenshot first, then a card), and B records zero presses", async () => {
    const before = presses;
    expect((await attempt("browser_navigate", { url: A("/frame") })).decision).toBe("allow");
    expect((await attempt("browser_snapshot")).decision).toBe("allow");
    await Bun.sleep(500);
    // Any traffic after the result (the frame finishing) first makes the page unknown; a snapshot settles it.
    let v = await hook("browser_click", { target: "#mine", element: "Mine" });
    if (v.decision === "deny" && /page may have changed/.test(v.reason ?? "")) {
      await run("browser_snapshot");
      v = await hook("browser_click", { target: "#mine", element: "Mine" });
    }
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/has loaded localhost, a logged-in site.*browser_take_screenshot/);
    expect((await attempt("browser_take_screenshot")).decision).toBe("allow");
    const gated = hook("browser_click", { target: "#mine", element: "Mine" });
    expect(await isPending(gated)).toBe(true);
    expect((parked(session) as { reason?: string }).reason).toMatch(/localhost/);
    rig.sup.resolvePermission(parked(session).requestId, "deny");
    expect((await gated).decision).toBe("deny");
    expect(presses).toBe(before);
  }, 180_000);
});
