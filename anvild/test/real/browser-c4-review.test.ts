/**
 * Real-tool repro of the C4 review's veto items 1–3: real Chrome (headless, throwaway profile, the
 * preset's own launch line in `env -i`), the real pinned Playwright MCP server, the daemon's real proxy
 * and real gate. The session's "test daemon" is the fake runner's in-process stand-in (nothing is built
 * or booted — what matters here is that its ORIGIN is the session's own), serving pages an
 * agent-modified daemon could serve. B at `localhost:<b>` is a locked logged-in site; A at
 * `127.0.0.1:<a>` is an allowed site. B records every press: it must record ZERO.
 *
 *   1. an own-origin page that moves itself to B by a timer, and one that frames B;
 *   2. allowed A frames B and then makes 2,100 same-site requests (the traffic log overflows);
 *   3. a background loop that keeps replacing every PNG in `.anvil-browser/` with a planted one while
 *      a screenshot is taken: the hard-stop card shows the server's inline image, byte for byte.
 *
 * No Claude API call, no headed browser, nothing of the live daemon. Skipped unless ANVIL_REAL_TOOLS=1;
 * under it a machine without Chrome, node or npm FAILS.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
let own = ""; // the test daemon's origin
let a: ReturnType<typeof Bun.serve> | undefined;
let b: ReturnType<typeof Bun.serve> | undefined;
let presses = 0;
let pings = 0;
const FLOOD = 2100;
const html = (title: string, body: string, head = "") => new Response(`<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });
const A = (path: string) => `http://127.0.0.1:${a!.port}${path}`;
const B = (path: string) => `http://localhost:${b!.port}${path}`;
/** A frame from B that takes the focus, so a key press on the page would land on B's button. */
const frameOfB = () => `<iframe src="${B("/pay")}" width="400" height="200" onload="this.focus()"></iframe>`;

const browser = () => rig.sup.mcp.browser!;
const hook = (tool: string, input: Record<string, unknown> = {}) => callHookFull(session, rig.broker, `mcp__browser__${tool}`, { inProcessKeys: [], gate: rig.sup.mcp.gate }, input);
async function run(tool: string, input: Record<string, unknown> = {}): Promise<{ text: string; content: unknown[] }> {
  const { reply, text } = await client!.tool(tool, input);
  rig.sup.mcp.gate.onToolResult(session, "browser", { tool, input, content: reply.content, isError: reply.isError === true });
  return { text, content: (reply.content ?? []) as unknown[] };
}
/** Ask the gate, and run the call on the real server only if it was allowed (what the CLI does). */
async function attempt(tool: string, input: Record<string, unknown> = {}): Promise<{ decision: string; reason?: string }> {
  const v = await hook(tool, input);
  if (v.decision === "allow") await run(tool, input);
  return v;
}
/** A click the gate may first refuse with "the page may have changed" (the page's own loads after
 *  the result): then a snapshot, and the click is asked again. Returns the final verdict (not run). */
async function clickAfterSettling(input: Record<string, unknown>): Promise<{ decision: string; reason?: string }> {
  let v = await hook("browser_click", input);
  for (let i = 0; i < 3 && v.decision === "deny" && /page may have changed|browser_snapshot first/.test(v.reason ?? ""); i++) {
    await run("browser_snapshot");
    v = await hook("browser_click", input);
  }
  return v;
}
/** Screenshot, then a snapshot (so the page block is fresh), then the click parks a hard-stop card. */
async function cardFor(input: Record<string, unknown>): Promise<{ gated: Promise<{ decision: string }>; card: ReturnType<typeof parked> & { reason?: string; image?: { attachmentId: string } } }> {
  expect((await attempt("browser_take_screenshot")).decision).toBe("allow");
  await run("browser_snapshot");
  const gated = hook("browser_click", input);
  expect(await isPending(gated)).toBe(true);
  return { gated, card: parked(session) as never };
}

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
      if (u.pathname === "/ping") return (pings++, new Response("pong", { headers: { "cache-control": "no-store" } }));
      if (u.pathname === "/plain") return html("A Plain", `<h1>A</h1><button id="mine">Mine</button>`);
      if (u.pathname === "/flood")
        return html("A Flood", `<h1>A floods</h1><button id="mine">Mine</button>${frameOfB()}<script>(async()=>{await new Promise(r=>setTimeout(r,800));for(let i=0;i<${FLOOD};i++){try{await fetch('/ping?i='+i,{cache:'no-store'})}catch{}}document.title='flooded'})()</script>`);
      return new Response("nf", { status: 404 });
    },
  });
  // The pages the session's own (agent-written) test daemon serves.
  runner = fakeRunner((req) => {
    const u = new URL(req.url);
    if (u.pathname === "/timer") return html("Own Timer", `<h1>own</h1><script>setTimeout(()=>{location=${JSON.stringify(B("/pay"))}},1500)</script>`);
    if (u.pathname === "/frame") return html("Own Frame", `<h1>own with a frame</h1><button id="mine">Mine</button>${frameOfB()}`);
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

describe("real Chrome: the C4 review's bypasses", () => {
  test.skipIf(!REAL)("[C4] real review: setup — the real server starts headless through the real proxy; the session's test daemon (stand-in) is running and its origin is the session's own; A (127.0.0.1) is allowed, B (localhost) is a locked logged-in site", async () => {
    expect(rig.sup.mcp.serversFor(session, undefined)?.browser).toBeDefined();
    const proxyPort = browser().proxies.get(session.id)!.port;
    const launch = buildBrowserLaunch({ mode: "headless", proxyPort, worktree, stateDir: rig.dir, sessionId: session.id, nodePath: resolveOnPath("node")!, cliPath: browserRuntimeCli(rig.dir) });
    const line = wrapStdio(launch.command, launch.args, defaultMcpChildEnv());
    client = await McpStdioClient.start(line.command, line.args, { cwd: worktree });
    const started = await browser().testDaemons.start({ id: session.id, data: { cwd: worktree } });
    if ("error" in started) throw new Error(started.error);
    own = started.url;
    expect(browser().testDaemons.origin(session.id)).toBe(own);
    for (const port of [a!.port as number, b!.port as number]) {
      expect(browser().registerTestDaemon(session.id, port)).toEqual({ ok: true });
      expect(browser().allowLoopbackPort(session.id, port)).toBe(true);
    }
    browser().gate.state(session.id).once.add("127.0.0.1");
    browser().gate.state(session.id).once.add("localhost");
    rig.sup.browserLoggedInAdd("localhost");
    expect(browser().loggedIn.isLocked("localhost")).toBe(true);
  }, 180_000);

  test.skipIf(!REAL)("[C4] real review 1 (timer): after the own-origin page's own timer sends it to locked B, the next key press and click are refused, B records zero presses, and the snapshot then shows B under its hard stop", async () => {
    const before = presses;
    expect((await attempt("browser_navigate", { url: `${own}/timer` })).decision).toBe("allow");
    expect((await attempt("browser_snapshot")).decision).toBe("allow");
    expect(browser().gate.state(session.id).currentUrl).toBe(`${own}/timer`);
    await Bun.sleep(3500); // the page moves itself; no tool call is made
    const press = await attempt("browser_press_key", { key: "Enter" });
    expect(press.decision).toBe("deny");
    expect(press.reason).toMatch(/page may have changed by itself.*localhost/);
    const click = await attempt("browser_click", { target: "#pay", element: "Pay now" });
    expect(click.decision).toBe("deny");
    expect(presses).toBe(before);
    expect((await hook("browser_snapshot")).decision).toBe("allow");
    expect((await run("browser_snapshot")).text).toContain(`Page URL: ${B("/pay")}`);
    const again = await attempt("browser_press_key", { key: "Enter" });
    expect(again.decision).not.toBe("allow");
    expect(presses).toBe(before);
    expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
  }, 180_000);

  test.skipIf(!REAL)("[C4] real review 1 (frame): an own-origin page that frames locked B — a key press and a click are hard stops naming B (screenshot first, then a card), browser_evaluate is refused, and B records zero presses", async () => {
    const before = presses;
    expect((await attempt("browser_navigate", { url: `${own}/frame` })).decision).toBe("allow");
    expect((await attempt("browser_snapshot")).decision).toBe("allow");
    await Bun.sleep(700); // the frame loads
    const v = await clickAfterSettling({ target: "#mine", element: "Mine" });
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/this session's test daemon.*has loaded localhost, a logged-in site.*browser_take_screenshot/);
    await run("browser_snapshot");
    const press = await attempt("browser_press_key", { key: "Enter" });
    expect(press.decision).toBe("deny");
    const script = await attempt("browser_evaluate", { function: "() => document.title" });
    expect(script).toMatchObject({ decision: "deny", reason: expect.stringMatching(/not allowed on a page that has loaded localhost/) });
    const { gated, card } = await cardFor({ target: "#mine", element: "Mine" });
    expect(card.reason).toMatch(/localhost/);
    rig.sup.resolvePermission(card.requestId, "deny");
    expect((await gated).decision).toBe("deny");
    expect(presses).toBe(before);
    expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
  }, 180_000);

  test.skipIf(!REAL)(`[C3] real review C4-2: allowed A frames locked B, then makes ${FLOOD} same-site fetches — after a snapshot the click is still a hard stop naming that Anvil lost track, and B records zero presses`, async () => {
    const before = presses;
    pings = 0;
    expect((await attempt("browser_navigate", { url: A("/flood") })).decision).toBe("allow");
    for (let i = 0; i < 600 && pings < FLOOD; i++) await Bun.sleep(100);
    expect(pings).toBe(FLOOD);
    await Bun.sleep(300);
    // The first input after the flood needs a snapshot (traffic since the last result)…
    const first = await hook("browser_press_key", { key: "Enter" });
    expect(first.decision).toBe("deny");
    expect(first.reason).toMatch(/page may have changed by itself.*lost track|browser_snapshot first/);
    // …and after the snapshot it is still stopped: the frame's entry was dropped from the log.
    expect((await attempt("browser_snapshot")).decision).toBe("allow");
    const v = await hook("browser_click", { target: "#mine", element: "Mine" });
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/embedded content is unknown.*lost track.*browser_take_screenshot/);
    const { gated, card } = await cardFor({ target: "#mine", element: "Mine" });
    expect(card.reason).toMatch(/lost track/);
    expect(card.suggestions.map((s) => s.label)).toEqual(["Allow once", "Deny"]);
    rig.sup.resolvePermission(card.requestId, "deny");
    expect((await gated).decision).toBe("deny");
    // A key press is the same hard stop (the screenshot is still current, so it parks a card too).
    const press = hook("browser_press_key", { key: "Enter" });
    expect(await isPending(press)).toBe(true);
    const again = parked(session) as ReturnType<typeof parked> & { reason?: string };
    expect(again.reason).toMatch(/lost track/);
    rig.sup.resolvePermission(again.requestId, "deny");
    expect((await press).decision).toBe("deny");
    expect(presses).toBe(before);
    expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
  }, 300_000);

  test.skipIf(!REAL)("[C3] real review C4-3: while a background loop keeps replacing every PNG in .anvil-browser/ with a planted one, browser_take_screenshot with a filename is refused and the hard-stop card shows the real server's inline image, byte for byte — never the planted file", async () => {
    expect((await attempt("browser_navigate", { url: A("/plain") })).decision).toBe("allow");
    expect((await attempt("browser_snapshot")).decision).toBe("allow");
    rig.sup.browserLoggedInAdd("127.0.0.1"); // A is now a locked logged-in site: a click needs a card
    const out = join(worktree, ".anvil-browser");
    mkdirSync(out, { recursive: true });
    const plantedDir = join(worktree, "planted");
    mkdirSync(plantedDir, { recursive: true });
    const plantedFile = join(plantedDir, "planted.png");
    writeFileSync(plantedFile, Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from("PLANTED-BY-THE-AGENT".repeat(50))]));
    const loop = Bun.spawn(["/bin/bash", "-c", 'while :; do for f in "$1"/*.png "$1"/*.jpeg "$1"/*.jpg; do [ -e "$f" ] && cp "$2" "$f"; done; cp "$2" "$1/shot.png"; cp "$2" "$1/page-planted.png"; done', "loop", out, plantedFile], { stdout: "ignore", stderr: "ignore" });
    try {
      for (const filename of ["shot.png", "page-planted.png"]) {
        const v = await attempt("browser_take_screenshot", { filename });
        expect(v).toMatchObject({ decision: "deny", reason: expect.stringMatching(/may not save to a file/) });
      }
      expect((await hook("browser_take_screenshot")).decision).toBe("allow");
      const shot = await run("browser_take_screenshot");
      const inline = shot.content.find((c) => (c as { type?: string }).type === "image") as { data?: string } | undefined;
      expect(inline?.data?.length ?? 0).toBeGreaterThan(100); // the server returned the picture inline
      await Bun.sleep(300); // the loop has had time to replace whatever the server wrote
      await run("browser_snapshot");
      const gated = hook("browser_click", { target: "#mine", element: "Mine" });
      expect(await isPending(gated)).toBe(true);
      const card = parked(session) as ReturnType<typeof parked> & { image?: { attachmentId: string } };
      const stored = readFileSync(rig.sup.attachmentBytes(session.id, card.image!.attachmentId)!.path);
      expect(stored.equals(Buffer.from(inline!.data!, "base64"))).toBe(true);
      expect(stored.toString("latin1")).not.toContain("PLANTED-BY-THE-AGENT");
      rig.sup.resolvePermission(card.requestId, "deny");
      expect((await gated).decision).toBe("deny");
      // The loop really was replacing files in the output folder.
      expect(existsSync(join(out, "page-planted.png"))).toBe(true);
      expect(readdirSync(out).length).toBeGreaterThan(0);
    } finally {
      loop.kill("SIGKILL");
      await loop.exited;
      rig.sup.browserLoggedInRemove("127.0.0.1");
    }
    expect((await attempt("browser_close")).decision).toBe("allow");
  }, 180_000);
});
