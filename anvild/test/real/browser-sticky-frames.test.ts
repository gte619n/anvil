/**
 * Real-tool repro of the C3/C4 fix-round re-review veto (item 1): a locked logged-in site's frame must
 * keep input on the page a hard stop after URL changes that reload nothing. Real Chrome (headless,
 * throwaway profile, the preset's own launch line in `env -i`), the real pinned Playwright MCP server,
 * the daemon's real proxy and real gate. B at `localhost:<b>` is a locked logged-in site; A at
 * `127.0.0.1:<a>` is allowed; the session's "test daemon" is the fake runner's in-process stand-in
 * (its ORIGIN is the session's own). B records every press of its "Pay now": it must record ZERO.
 *
 * Each case clicks B's button by its FRAME REF from a real snapshot — the call the reviewer made —
 * and, if the gate (wrongly) allowed it, runs it on the real server, so a regression shows up as a
 * press on B, not only as a verdict.
 *
 * No Claude API call, no headed browser, nothing of the live daemon. Skipped unless ANVIL_REAL_TOOLS=1;
 * under it a machine without Chrome, node or npm FAILS.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { capturedTimers, fakeAnvilCheckout, fakeRunner, fakeTestDaemonSeams, type FakeRunner } from "../helpers/testdaemon";

let rig: McpRig;
let worktree: string;
let session: Session;
let integration: McpIntegration;
let client: McpStdioClient | undefined;
let runner: FakeRunner;
let own = "";
let a: ReturnType<typeof Bun.serve> | undefined;
let b: ReturnType<typeof Bun.serve> | undefined;
let presses = 0;
const html = (title: string, body: string) => new Response(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });
const A = (path: string) => `http://127.0.0.1:${a!.port}${path}`;
const B = (path: string) => `http://localhost:${b!.port}${path}`;
const frameOfB = () => `<iframe src="${B("/pay")}" width="400" height="200"></iframe>`;
/** The page moves its own address after a second: no navigation, no network traffic. */
const pushes = `<script>setTimeout(()=>history.pushState({}, "", location.pathname + "/moved"), 1000)</script>`;

const browser = () => rig.sup.mcp.browser!;
const hook = (tool: string, input: Record<string, unknown> = {}) => callHookFull(session, rig.broker, `mcp__browser__${tool}`, { inProcessKeys: [], gate: rig.sup.mcp.gate }, input);
async function run(tool: string, input: Record<string, unknown> = {}): Promise<{ text: string }> {
  const { reply, text } = await client!.tool(tool, input);
  rig.sup.mcp.gate.onToolResult(session, "browser", { tool, input, content: reply.content, isError: reply.isError === true });
  return { text };
}
async function attempt(tool: string, input: Record<string, unknown> = {}): Promise<{ decision: string; reason?: string }> {
  const v = await hook(tool, input);
  if (v.decision === "allow") await run(tool, input);
  return v;
}
/** A real snapshot (through the gate); returns its text. */
async function snapshot(): Promise<string> {
  expect((await hook("browser_snapshot")).decision).toBe("allow");
  return (await run("browser_snapshot")).text;
}
/** The ref of B's "Pay now" button inside the frame, from a real snapshot. */
async function payRef(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const m = /button "Pay now" \[ref=([^\]]+)\]/.exec(await snapshot());
    if (m) return m[1]!;
    await Bun.sleep(250);
  }
  throw new Error("the frame from B never showed its Pay now button");
}

/**
 * Act on B's button through the frame: screenshot and snapshot first (so a hard stop parks its card),
 * then the call. A card is answered Deny; an allow (the bug) is RUN on the real server. Returns what
 * the owner was shown, or the denial. B must record zero presses either way.
 */
async function actOnFrame(tool: string, input: (ref: string) => Record<string, unknown>, ref0?: string): Promise<string> {
  const before = presses;
  let reason = "";
  for (let i = 0; i < 4; i++) {
    expect((await attempt("browser_take_screenshot")).decision).toBe("allow");
    const ref = ref0 ?? (await payRef());
    if (ref0) await snapshot();
    const gated = hook(tool, input(ref));
    if (await isPending(gated)) {
      const card = parked(session) as ReturnType<typeof parked> & { reason?: string };
      reason = card.reason ?? "";
      rig.sup.resolvePermission(card.requestId, "deny");
      expect((await gated).decision).toBe("deny");
      break;
    }
    const v = await gated;
    if (v.decision === "allow") {
      await run(tool, input(ref)); // the hole: the click reaches B
      reason = "ALLOWED";
      break;
    }
    reason = v.reason ?? "";
    if (!/page may have changed|browser_snapshot first|browser_take_screenshot first/.test(reason)) break;
  }
  await Bun.sleep(600); // a press would have reached B by now
  expect(presses).toBe(before);
  expect(reason).not.toBe("ALLOWED");
  return reason;
}
const click = (ref: string) => ({ target: ref, element: "Pay now" });

beforeAll(async () => {
  if (!REAL) return;
  worktree = fakeAnvilCheckout();
  mkdirSync(join(worktree, ".git", "info"), { recursive: true });
  writeFileSync(join(worktree, ".git", "info", "exclude"), "");
  b = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/pay") return html("B Pay", `<h1>Pay</h1><button id="pay" onclick="fetch('/pressed',{method:'POST'});document.title='pressed'">Pay now</button>`);
      if (u.pathname === "/pressed") return (presses++, new Response("ok"));
      return new Response("nf", { status: 404 });
    },
  });
  a = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/plain") return html("A Plain", `<h1>A</h1><button id="mine">Mine</button>`);
      if (u.pathname === "/frame") return html("A Frame", `<h1>A with a frame</h1><button id="mine">Mine</button>${frameOfB()}`);
      if (u.pathname === "/push") return html("A Push", `<h1>A pushes</h1>${frameOfB()}${pushes}`);
      return new Response("nf", { status: 404 });
    },
  });
  runner = fakeRunner((req) => {
    const u = new URL(req.url);
    if (u.pathname === "/push") return html("Own Push", `<h1>own pushes</h1>${frameOfB()}${pushes}`);
    return undefined;
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
      testDaemon: fakeTestDaemonSeams(runner, capturedTimers()),
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
  browser()?.testDaemons.stopAll("the real suite is done");
  for (const s of runner?.starts ?? []) {
    s.proc.killGroup();
    rmSync(s.opts.env.HOME!, { recursive: true, force: true });
  }
  a?.stop(true);
  b?.stop(true);
  await rig?.cleanup();
  if (worktree) rmSync(worktree, { recursive: true, force: true });
}, 60_000);

describe("real Chrome: a locked site's frame stays a hard stop", () => {
  test.skipIf(!REAL)("[C3] real re-review: setup — the real server starts headless through the real proxy; A (127.0.0.1) is allowed, B (localhost) is a locked logged-in site, and the session's test daemon (stand-in) is running", async () => {
    expect(rig.sup.mcp.serversFor(session, undefined)?.browser).toBeDefined();
    const proxyPort = browser().proxies.get(session.id)!.port;
    const launch = buildBrowserLaunch({ mode: "headless", proxyPort, worktree, stateDir: rig.dir, sessionId: session.id, nodePath: resolveOnPath("node")!, cliPath: browserRuntimeCli(rig.dir) });
    expect(launch.args).toContain("--headless");
    const line = wrapStdio(launch.command, launch.args, defaultMcpChildEnv());
    client = await McpStdioClient.start(line.command, line.args, { cwd: worktree });
    const started = await browser().testDaemons.start({ id: session.id, data: { cwd: worktree } });
    if ("error" in started) throw new Error(started.error);
    own = started.url;
    for (const port of [a!.port as number, b!.port as number]) {
      expect(browser().registerTestDaemon(session.id, port)).toEqual({ ok: true });
      expect(browser().allowLoopbackPort(session.id, port)).toBe(true);
    }
    browser().gate.state(session.id).once.add("127.0.0.1");
    browser().gate.state(session.id).once.add("localhost");
    rig.sup.browserLoggedInAdd("localhost");
    expect(browser().loggedIn.isLocked("localhost")).toBe(true);
  }, 180_000);

  test.skipIf(!REAL)("[C3] real re-review (pushState): A frames locked B, then moves its own address with history.pushState — a click on B's Pay now by its frame ref is a hard stop naming B, and B records zero presses", async () => {
    expect((await attempt("browser_navigate", { url: A("/push") })).decision).toBe("allow");
    await Bun.sleep(1800);
    expect(await snapshot()).toContain(`Page URL: ${A("/push/moved")}`);
    expect(await actOnFrame("browser_click", click)).toMatch(/has loaded localhost/);
    expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
  }, 180_000);

  test.skipIf(!REAL)("[C4] real re-review (own pushState): the session's own test daemon frames locked B and pushes its address — a click on B's Pay now by its frame ref is a hard stop naming B, and B records zero presses", async () => {
    expect((await attempt("browser_navigate", { url: `${own}/push` })).decision).toBe("allow");
    await Bun.sleep(1800);
    expect(await snapshot()).toContain(`Page URL: ${own}/push/moved`);
    expect(await actOnFrame("browser_click", click)).toMatch(/has loaded localhost/);
    expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
  }, 180_000);

  test.skipIf(!REAL)("[C4] real re-review (evaluate): on the session's own test daemon after it framed locked B and pushed its address, browser_evaluate with the frame's ref as target is refused naming B, and B records zero presses", async () => {
    expect((await attempt("browser_navigate", { url: `${own}/push` })).decision).toBe("allow");
    await Bun.sleep(1800);
    expect(await snapshot()).toContain(`Page URL: ${own}/push/moved`);
    const before = presses;
    const ref = await payRef();
    const v = await attempt("browser_evaluate", { function: "(el) => el.click()", target: ref, element: "Pay now" });
    expect(v).toMatchObject({ decision: "deny", reason: expect.stringMatching(/not allowed on a page that has loaded localhost/) });
    await Bun.sleep(600);
    expect(presses).toBe(before);
    expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
  }, 180_000);

  test.skipIf(!REAL)("[C3] real re-review (fragment): the agent navigates A/frame to A/frame#x (same document) — a click on B's Pay now by its frame ref is a hard stop naming B, and B records zero presses", async () => {
    expect((await attempt("browser_navigate", { url: A("/frame") })).decision).toBe("allow");
    await payRef();
    expect((await attempt("browser_navigate", { url: A("/frame#x") })).decision).toBe("allow");
    expect(await snapshot()).toContain(`Page URL: ${A("/frame#x")}`);
    expect(await actOnFrame("browser_click", click)).toMatch(/has loaded localhost/);
    expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
  }, 180_000);

  test.skipIf(!REAL)("[C3] real re-review (tabs): A frames locked B; a new tab, a tab list, then selecting the first tab again — a click on B's Pay now by its frame ref is a hard stop naming B, and B records zero presses", async () => {
    expect((await attempt("browser_navigate", { url: A("/frame") })).decision).toBe("allow");
    await payRef();
    expect((await attempt("browser_tabs", { action: "new" })).decision).toBe("allow");
    expect((await attempt("browser_tabs", { action: "list" })).decision).toBe("allow");
    expect((await attempt("browser_tabs", { action: "select", index: 0 })).decision).toBe("allow");
    expect(await snapshot()).toContain(`Page URL: ${A("/frame")}`);
    expect(await actOnFrame("browser_click", click)).toMatch(/has loaded localhost/);
    expect((await attempt("browser_close")).decision).toBe("allow");
  }, 180_000);

  test.skipIf(!REAL)("[C3] real re-review (back): A frames locked B; the agent opens A/plain, then browser_navigate_back restores A/frame (back/forward cache) — a click on B's Pay now by its frame ref is a hard stop naming B, and B records zero presses", async () => {
    expect((await attempt("browser_navigate", { url: A("/frame") })).decision).toBe("allow");
    await payRef();
    expect((await attempt("browser_navigate", { url: A("/plain") })).decision).toBe("allow");
    expect((await attempt("browser_navigate_back")).decision).toBe("allow");
    expect(await snapshot()).toContain(`Page URL: ${A("/frame")}`);
    expect(await actOnFrame("browser_click", click)).toMatch(/has loaded localhost/);
    expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
  }, 180_000);

  test.skipIf(!REAL)("[C3] real re-review (back after about:blank): A frames locked B; the agent sends the page to about:blank, then browser_navigate_back restores A/frame — a click on B's Pay now by its frame ref is a hard stop naming B, and B records zero presses", async () => {
    expect((await attempt("browser_navigate", { url: A("/frame") })).decision).toBe("allow");
    await payRef();
    expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
    expect(browser().gate.state(session.id).contacted?.has("localhost")).toBe(true); // fix-c-final: about:blank keeps it
    expect((await attempt("browser_navigate_back")).decision).toBe("allow");
    expect(await snapshot()).toContain(`Page URL: ${A("/frame")}`);
    expect(await actOnFrame("browser_click", click)).toMatch(/has loaded localhost/);
    expect((await attempt("browser_close")).decision).toBe("allow");
  }, 180_000);

  test.skipIf(!REAL)("[C3] real fix-c-final (headed: nothing clears): after about:blank and after browser_close the set still holds locked B — the headed agent profile is persistent — and a click on A's own button on a page with no frame is still a hard stop naming B", async () => {
    for (const out of ["about:blank", "close"] as const) {
      expect((await attempt("browser_navigate", { url: A("/frame") })).decision).toBe("allow");
      await payRef();
      expect(browser().gate.state(session.id).contacted?.has("localhost")).toBe(true);
      if (out === "close") expect((await attempt("browser_close")).decision).toBe("allow");
      else expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
      expect([out, browser().gate.state(session.id).contacted?.has("localhost")]).toEqual([out, true]);
      expect((await attempt("browser_navigate", { url: A("/plain") })).decision).toBe("allow");
      expect(await actOnFrame("browser_click", () => ({ target: "#mine", element: "Mine" }), "#mine")).toMatch(/localhost/);
    }
    expect((await attempt("browser_close")).decision).toBe("allow");
  }, 180_000);
});
