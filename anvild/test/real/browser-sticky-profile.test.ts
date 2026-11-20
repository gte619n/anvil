/**
 * Real-tool repro of the fix-c-final veto, headed rules (the persistent agent profile): a NEW Chrome
 * process on the same profile must not show a locked logged-in site's frame unseen.
 *   - HTTP cache: the headed launch line puts Chrome's cache in a new folder per launch, outside the
 *     profile (`--disk-cache-dir`), so the second launch fetches B's cacheable frame again through the
 *     proxy (and the profile has no cache of its own);
 *   - service workers: B's worker, registered in launch one, serves B's frame in launch two with no
 *     request for the frame at all — so in headed mode every locked logged-in site counts as loaded
 *     from the first call (gate.ts), and the click is a hard stop anyway.
 *
 * Real Chrome, the real pinned Playwright MCP server, the daemon's real proxy and real gate. To emulate
 * the persistent profile WITHOUT a headed window, the service's own HEADED launch line (its
 * `--user-data-dir` is the rig's throwaway state folder's `browser-profile`, reused by both launches;
 * its config holds the per-launch `--disk-cache-dir`) is started with `--headless` appended. That is the
 * only change. Launch two runs in a SECOND session, whose sticky set starts empty: what stops the click
 * there is the profile rule, not anything session one saw.
 *
 * A at `127.0.0.1:<a>` is allowed; B at `localhost:<b>` is a locked logged-in site and records every press
 * of its "Pay now": it must record ZERO. No Claude API call, no headed browser, nothing of the live
 * daemon. Skipped unless ANVIL_REAL_TOOLS=1; under it a machine without Chrome, node or npm FAILS.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpIntegration } from "@protocol";
import { browserIntegrationDefaults } from "../../src/browser/service";
import type { Session } from "../../src/session/session";
import { McpStdioClient } from "../fixtures/browser/mcp-stdio-client";
import { callHookFull, isPending, mcpRig, parked, settle, type McpRig } from "../helpers/mcp";
import { REAL } from "../helpers/real-tools";
import { fakeAnvilCheckout } from "../helpers/testdaemon";

let rig: McpRig;
let worktree: string;
let s1: Session;
let s2: Session;
let session: Session; // the one acting now
let integration: McpIntegration;
let client: McpStdioClient | undefined;
let a: ReturnType<typeof Bun.serve> | undefined;
let b: ReturnType<typeof Bun.serve> | undefined;
let presses = 0;
const served: { path: string; at: number }[] = [];
const html = (title: string, body: string, headers: Record<string, string> = {}) => new Response(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html", ...headers } });
const A = (path: string) => `http://127.0.0.1:${a!.port}${path}`;
const B = (path: string) => `http://localhost:${b!.port}${path}`;
const framing = (src: string) => A(`/frame?src=${encodeURIComponent(src)}`);
const servedSince = (t: number, path: string) => served.filter((x) => x.at >= t && x.path === path).length;
const profileDir = () => join(rig.dir, "browser-profile");

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
async function snapshot(): Promise<string> {
  expect((await hook("browser_snapshot")).decision).toBe("allow");
  return (await run("browser_snapshot")).text;
}
async function payRef(label = "Pay now"): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const m = new RegExp(`button "${label}" \\[ref=([^\\]]+)\\]`).exec(await snapshot());
    if (m) return m[1]!;
    await Bun.sleep(250);
  }
  throw new Error(`the frame from B never showed its ${label} button`);
}
async function clickFrame(): Promise<string> {
  const before = presses;
  let reason = "";
  for (let i = 0; i < 4; i++) {
    expect((await attempt("browser_take_screenshot")).decision).toBe("allow");
    const ref = await payRef();
    const input = { target: ref, element: "Pay now" };
    const gated = hook("browser_click", input);
    if (await isPending(gated)) {
      const card = parked(session) as ReturnType<typeof parked> & { reason?: string };
      reason = card.reason ?? "";
      rig.sup.resolvePermission(card.requestId, "deny");
      expect((await gated).decision).toBe("deny");
      break;
    }
    const v = await gated;
    if (v.decision === "allow") {
      await run("browser_click", input); // the hole: the click reaches B
      reason = "ALLOWED";
      break;
    }
    reason = v.reason ?? "";
    if (!/page may have changed|browser_snapshot first|browser_take_screenshot first/.test(reason)) break;
  }
  await Bun.sleep(600);
  expect(presses).toBe(before);
  expect(reason).not.toBe("ALLOWED");
  return reason;
}
/** The service's HEADED launch line for `s` (resolveTransport), started with `--headless` appended. */
async function launchHeaded(s: Session): Promise<{ cacheDir: string }> {
  const line = rig.sup.mcp.serversFor(s, undefined)!.browser as { command: string; args: string[] };
  expect(line.args[line.args.indexOf("--user-data-dir") + 1]).toBe(profileDir());
  expect(line.args).not.toContain("--headless");
  const cfg = JSON.parse(readFileSync(line.args[line.args.indexOf("--config") + 1]!, "utf8"));
  const cacheArg = (cfg.browser.launchOptions.args as string[]).find((x) => x.startsWith("--disk-cache-dir="))!;
  const cacheDir = cacheArg.slice("--disk-cache-dir=".length);
  expect(cacheDir.startsWith(`${profileDir()}/`)).toBe(false);
  session = s;
  client = await McpStdioClient.start(line.command, [...line.args, "--headless"], { cwd: worktree });
  return { cacheDir };
}
function openPorts(s: Session): void {
  for (const port of [a!.port as number, b!.port as number]) {
    expect(browser().registerTestDaemon(s.id, port)).toEqual({ ok: true });
    expect(browser().allowLoopbackPort(s.id, port)).toBe(true);
  }
  browser().gate.state(s.id).once.add("127.0.0.1");
  browser().gate.state(s.id).once.add("localhost");
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
      served.push({ path: u.pathname, at: Date.now() });
      const pay = (k: string) => `<h1>Pay ${k}</h1><button onclick="fetch('/pressed',{method:'POST'})">Pay now</button>`;
      if (u.pathname === "/pay-cached") return html("B Pay", pay("cached"), { "cache-control": "public, max-age=3600" });
      // B's service worker: on install it caches /swpay, and then serves /swpay from that cache.
      if (u.pathname === "/sw-reg") return html("B reg", `<h1>B registers</h1><button>Registered</button><script>navigator.serviceWorker.register('/sw.js')</script>`);
      if (u.pathname === "/sw.js")
        return new Response(
          `self.addEventListener('install',e=>{e.waitUntil(caches.open('c').then(c=>c.add('/swpay')));self.skipWaiting()});self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/swpay')e.respondWith(caches.match('/swpay').then(r=>r||fetch(e.request)))});`,
          { headers: { "content-type": "text/javascript", "cache-control": "no-store" } },
        );
      if (u.pathname === "/swpay") return html("B SW Pay", pay("from the worker"), { "cache-control": "no-store" });
      if (u.pathname === "/pressed") return (presses++, new Response("ok", { headers: { "cache-control": "no-store" } }));
      return new Response("nf", { status: 404 });
    },
  });
  a = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/frame") return html("A Frame", `<h1>A with a frame</h1><iframe src="${u.searchParams.get("src")}" width="400" height="200"></iframe>`);
      return new Response("nf", { status: 404 });
    },
  });
  rig = mcpRig({
    features: ["mcp-integrations", "browser"],
    realProber: true,
    browser: {
      desktopProbe: () => ({ desktop: true, reason: "the gate applies the headed rules; the browser started is headless on a throwaway --user-data-dir" }),
      sitesIntervalMs: 0,
      agentBrowserLauncher: () => {
        throw new Error("the real suite never opens the owner's Chrome");
      },
    },
  });
  integration = rig.sup.mcp.add(browserIntegrationDefaults());
  await rig.sup.browserRuntimeInstall();
  await rig.sup.mcpIntegrationCheck();
  s1 = await rig.session({ cwd: worktree, autonomy: "bypass" });
  s2 = await rig.session({ cwd: worktree, autonomy: "bypass" });
  for (const s of [s1, s2]) rig.sup.setSessionMcpIntegrations(s.id, [integration.id]);
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

let launch1Cache = "";

describe("real Chrome on a reused profile (headed rules): a new process does not show a locked site's frame unseen", () => {
  test.skipIf(!REAL)("[C3] real fix-c-final (profile, launch one): session one loads A framing B (cacheable) and A framing B's page that registers B's service worker; its HTTP cache is in the launch's own folder, not in the profile", async () => {
    const { cacheDir } = await launchHeaded(s1);
    launch1Cache = cacheDir;
    openPorts(s1);
    rig.sup.browserLoggedInAdd("localhost");
    expect(browser().loggedIn.isLocked("localhost")).toBe(true);
    expect((await attempt("browser_navigate", { url: framing(B("/pay-cached")) })).decision).toBe("allow");
    await payRef();
    expect((await attempt("browser_navigate", { url: framing(B("/sw-reg")) })).decision).toBe("allow");
    await payRef("Registered");
    for (let i = 0; i < 40 && servedSince(0, "/swpay") === 0; i++) await Bun.sleep(250); // the worker installs and caches /swpay
    expect(servedSince(0, "/sw.js")).toBeGreaterThan(0);
    expect(servedSince(0, "/swpay")).toBeGreaterThan(0);
    await Bun.sleep(1000);
    await client!.close(); // the browser process ends; the profile stays
    client = undefined;
    rig.sup.mcp.gate.onTurnEnd(s1); // session one's turn is over: it lets go of the browser's lock
    expect(readdirSync(cacheDir).length).toBeGreaterThan(0); // the cache went to the launch's own folder…
    expect(existsSync(join(profileDir(), "Default", "Cache"))).toBe(false); // …and the profile has none
    expect(existsSync(join(profileDir(), "Default", "Service Worker"))).toBe(true); // B's worker is in the profile
  }, 240_000);

  test.skipIf(!REAL)("[C3] real fix-c-final (profile, service worker): launch two, in a second session whose set starts empty, shows B's frame from B's service worker with no request for it — a click on B's Pay now by its frame ref is a hard stop naming B, and B records zero presses", async () => {
    const t0 = Date.now();
    browser().revokeLoopbackPort(s1.id); // B's port is session two's now (one session per registered port)
    await launchHeaded(s2);
    openPorts(s2);
    expect(browser().gate.state(s2.id).contacted?.has("localhost") ?? false).toBe(false);
    const nav = await attempt("browser_navigate", { url: framing(B("/swpay")) });
    expect(nav).toMatchObject({ decision: "allow" });
    const seen = browser().gate.state(s2.id).contacted?.has("localhost") ?? false;
    expect(await snapshot()).toContain("Pay from the worker");
    expect(servedSince(t0, "/swpay")).toBe(0); // the frame came from the worker: no request for it reached B
    console.log(`[real] service-worker frame shown; the proxy had ${seen ? "" : "NOT "}seen B when the navigation returned; B requests since launch two: ${JSON.stringify(served.filter((x) => x.at >= t0).map((x) => x.path))}`);
    const reason = await clickFrame();
    console.log(`[real] the click on the worker-served frame was stopped: ${reason}`);
    expect(reason).toMatch(/localhost/);
  }, 240_000);

  test.skipIf(!REAL)("[C3] real fix-c-final (profile, cache folder): in launch two B's cacheable frame is fetched AGAIN through the proxy (the HTTP cache is per launch, outside the profile), the old launch's cache folder is gone — a click on B's Pay now by its frame ref is a hard stop naming B, and B records zero presses", async () => {
    expect(existsSync(launch1Cache)).toBe(true); // session one's browser has not been replaced
    const seq = browser().hooks.trafficSeq!(s2.id);
    const t0 = Date.now();
    expect((await attempt("browser_navigate", { url: framing(B("/pay-cached")) })).decision).toBe("allow");
    await payRef();
    expect(servedSince(t0, "/pay-cached")).toBe(1);
    expect(browser().trafficSince(s2.id, seq)).toContain("localhost");
    expect(await clickFrame()).toMatch(/has loaded localhost/);
    // A new launch for session two replaces its cache folder; forgetting session one removes its own.
    await client!.close();
    client = undefined;
    browser().forgetSession(s1.id);
    expect(existsSync(launch1Cache)).toBe(false);
  }, 240_000);
});
