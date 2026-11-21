/**
 * Real-tool repro of the fix-c-final veto, headless fallback (throwaway `--isolated` profile): about:blank
 * must not empty the sticky set, because a FRESH `browser_navigate` back to the framing page does not
 * necessarily re-contact the framed site through the proxy —
 *   R1: B's frame has `Cache-Control: max-age`, so Chrome serves it from its HTTP cache;
 *   T1: B is HTTPS with `no-store`, and Chrome reuses the CONNECT tunnel it already holds;
 * and `browser_close` must still empty it when the browser process really ended.
 *
 * Real Chrome (headless, throwaway profile, the preset's own launch line from the service, in `env -i`),
 * the real pinned Playwright MCP server, the daemon's real proxy and real gate. A at `127.0.0.1:<a>` is
 * allowed; B at `localhost:<b>` (http) and `localhost:<bs>` (https, self-signed) is a locked logged-in
 * site. B records every press of its "Pay now": it must record ZERO.
 *
 * The ONE change to the preset's launch: this test's copy of the generated config adds
 * `--ignore-certificate-errors` to Chrome's arguments, only so that Chrome accepts B's self-signed
 * HTTPS fixture certificate. The product never passes it (presetArgProblems refuses it).
 *
 * No Claude API call, no headed browser, nothing of the live daemon. Skipped unless ANVIL_REAL_TOOLS=1;
 * under it a machine without Chrome, node, npm or openssl FAILS.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
let tls: string;
let session: Session;
let integration: McpIntegration;
let client: McpStdioClient | undefined;
let line: { command: string; args: string[] };
let a: ReturnType<typeof Bun.serve> | undefined;
let b: ReturnType<typeof Bun.serve> | undefined;
let bs: ReturnType<typeof Bun.serve> | undefined;
let presses = 0;
const html = (title: string, body: string, headers: Record<string, string> = {}) => new Response(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html", ...headers } });
const A = (path: string) => `http://127.0.0.1:${a!.port}${path}`;
const B = (path: string) => `http://localhost:${b!.port}${path}`;
const BS = (path: string) => `https://localhost:${bs!.port}${path}`;
const framing = (src: string) => A(`/frame?src=${encodeURIComponent(src)}`);

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
async function payRef(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const m = /button "Pay now" \[ref=([^\]]+)\]/.exec(await snapshot());
    if (m) return m[1]!;
    await Bun.sleep(250);
  }
  throw new Error("the frame from B never showed its Pay now button");
}
/** Click B's Pay now by its frame ref; a card is answered Deny, an allow (the bug) is RUN. B must record no press. */
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
/** The proxy saw B (`localhost`) since sequence `seq`. */
const sawB = (seq: number) => browser().trafficSince(session.id, seq).includes("localhost");
const seqNow = () => browser().hooks.trafficSeq!(session.id);
const chromeProcesses = () => {
  const port = browser().proxies.get(session.id)!.port;
  return Bun.spawnSync(["/bin/ps", "-axww", "-o", "command="]).stdout.toString().split("\n").filter((l) => new RegExp(`--proxy-server=http://127\\.0\\.0\\.1:${port}(?![0-9])`).test(l)).length;
};
/** Close the browser through the gate and check the gate emptied the set (the process really ended). */
async function closeAndClear(): Promise<void> {
  expect((await attempt("browser_close")).decision).toBe("allow");
  expect(chromeProcesses()).toBe(0);
  expect(browser().gate.state(session.id).contacted?.size ?? 0).toBe(0);
}

beforeAll(async () => {
  if (!REAL) return;
  worktree = fakeAnvilCheckout();
  mkdirSync(join(worktree, ".git", "info"), { recursive: true });
  writeFileSync(join(worktree, ".git", "info", "exclude"), "");
  tls = mkdtempSync(join(tmpdir(), "anvil-real-tls-"));
  const gen = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tls, "key.pem"), "-out", join(tls, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stderr: "pipe" });
  if (gen.exitCode !== 0) throw new Error(`openssl could not make the HTTPS fixture certificate: ${gen.stderr.toString()}`);
  const bFetch = (req: Request): Response => {
    const u = new URL(req.url);
    const pay = (k: string) => `<h1>Pay ${k}</h1><button onclick="fetch('/pressed',{method:'POST'})">Pay now</button>`;
    if (u.pathname === "/pay-cached") return html("B Pay", pay("cached"), { "cache-control": "public, max-age=3600" });
    if (u.pathname === "/pay-nostore") return html("B Pay", pay("nostore"), { "cache-control": "no-store" });
    if (u.pathname === "/pressed") return (presses++, new Response("ok", { headers: { "cache-control": "no-store" } }));
    return new Response("nf", { status: 404 });
  };
  b = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: bFetch });
  bs = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: bFetch, tls: { cert: readFileSync(join(tls, "cert.pem"), "utf8"), key: readFileSync(join(tls, "key.pem"), "utf8") } });
  a = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/plain") return html("A Plain", `<h1>A</h1><button id="mine">Mine</button>`);
      if (u.pathname === "/frame") return html("A Frame", `<h1>A with a frame</h1><iframe src="${u.searchParams.get("src")}" width="400" height="200"></iframe>`);
      return new Response("nf", { status: 404 });
    },
  });
  rig = mcpRig({
    features: ["mcp-integrations", "browser"],
    realProber: true,
    browser: {
      desktopProbe: () => ({ desktop: false, reason: "the headless fallback: a throwaway profile" }),
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
  bs?.stop(true);
  await rig?.cleanup();
  if (worktree) rmSync(worktree, { recursive: true, force: true });
  if (tls) rmSync(tls, { recursive: true, force: true });
}, 60_000);

describe("real Chrome, headless fallback: a fresh load after about:blank need not re-contact the framed site", () => {
  test.skipIf(!REAL)("[C3] real fix-c-final: setup — the service's own headless launch line (--isolated --headless) through the real proxy; A is allowed, B (http and https) is a locked logged-in site", async () => {
    // The launch line the session gets (resolveTransport), as the driver would start it.
    line = rig.sup.mcp.serversFor(session, undefined)!.browser as { command: string; args: string[] };
    expect(line.args).toContain("--isolated");
    expect(line.args).toContain("--headless");
    expect(line.args).not.toContain("--user-data-dir");
    // This test's own copy of the config, + --ignore-certificate-errors for the self-signed B fixture only.
    const at = line.args.indexOf("--config") + 1;
    const cfg = JSON.parse(readFileSync(line.args[at]!, "utf8"));
    expect(cfg.browser.launchOptions.args).toHaveLength(3); // headless: no --disk-cache-dir
    cfg.browser.launchOptions.args.push("--ignore-certificate-errors");
    const ours = join(tls, "playwright-mcp-test.json");
    writeFileSync(ours, JSON.stringify(cfg));
    const args = [...line.args];
    args[at] = ours;
    client = await McpStdioClient.start(line.command, args, { cwd: worktree });
    for (const port of [a!.port as number, b!.port as number, bs!.port as number]) {
      expect(browser().registerTestDaemon(session.id, port)).toEqual({ ok: true });
      expect(browser().allowLoopbackPort(session.id, port)).toBe(true);
    }
    browser().gate.state(session.id).once.add("127.0.0.1");
    browser().gate.state(session.id).once.add("localhost");
    rig.sup.browserLoggedInAdd("localhost");
    expect(browser().loggedIn.isLocked("localhost")).toBe(true);
  }, 180_000);

  test.skipIf(!REAL)("[C3] real fix-c-final (close): browser_close on the isolated fallback ends the Chrome process (no process holds the session's proxy any more), so it empties the set — then a click on A's own button on a page with no frame runs without a prompt", async () => {
    expect((await attempt("browser_navigate", { url: framing(B("/pay-cached")) })).decision).toBe("allow");
    await payRef();
    expect(browser().gate.state(session.id).contacted?.has("localhost")).toBe(true);
    expect(chromeProcesses()).toBeGreaterThan(0);
    expect(browser().browserEnded(session.id)).toBe(false); // while it runs, it has not ended
    await closeAndClear();
    expect(browser().browserEnded(session.id)).toBe(true);
    // The next call starts a new browser (a new throwaway profile).
    expect((await attempt("browser_navigate", { url: A("/plain") })).decision).toBe("allow");
    await snapshot();
    expect(chromeProcesses()).toBeGreaterThan(0);
    const before = presses;
    expect((await attempt("browser_click", { target: "#mine", element: "Mine" })).decision).toBe("allow");
    expect(presses).toBe(before);
    await closeAndClear();
  }, 180_000);

  test.skipIf(!REAL)("[C3] real fix-c-final (R1, HTTP cache): A frames locked B with Cache-Control max-age; about:blank; a fresh browser_navigate to A/frame shows B's frame from Chrome's HTTP cache with NO proxy traffic to B — a click on B's Pay now by its frame ref is a hard stop naming B, and B records zero presses", async () => {
    expect(browser().gate.state(session.id).contacted?.has("localhost") ?? false).toBe(false);
    const first = seqNow();
    expect((await attempt("browser_navigate", { url: framing(B("/pay-cached")) })).decision).toBe("allow");
    await payRef();
    expect(sawB(first)).toBe(true);
    expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
    expect(browser().gate.state(session.id).contacted?.has("localhost")).toBe(true); // about:blank keeps it
    const fresh = seqNow();
    expect((await attempt("browser_navigate", { url: framing(B("/pay-cached")) })).decision).toBe("allow");
    await payRef();
    expect(sawB(fresh)).toBe(false); // the repro: B's frame is back with no connection to B
    expect(await clickFrame()).toMatch(/has loaded localhost/);
    await closeAndClear();
  }, 180_000);

  test.skipIf(!REAL)("[C3] real fix-c-final (T1, HTTPS tunnel reuse): A frames locked B over HTTPS with no-store; about:blank; a fresh browser_navigate to A/frame loads B's frame over the tunnel Chrome already holds, with NO new CONNECT to B — a click on B's Pay now by its frame ref is a hard stop naming B, and B records zero presses", async () => {
    expect(browser().gate.state(session.id).contacted?.has("localhost") ?? false).toBe(false);
    const first = seqNow();
    expect((await attempt("browser_navigate", { url: framing(BS("/pay-nostore")) })).decision).toBe("allow");
    await payRef();
    expect(sawB(first)).toBe(true);
    expect((await attempt("browser_navigate", { url: "about:blank" })).decision).toBe("allow");
    const fresh = seqNow();
    expect((await attempt("browser_navigate", { url: framing(BS("/pay-nostore")) })).decision).toBe("allow");
    await payRef();
    expect(sawB(fresh)).toBe(false); // the repro: no new CONNECT, the page came over the old tunnel
    expect(await clickFrame()).toMatch(/has loaded localhost/);
    await closeAndClear();
  }, 180_000);
});
