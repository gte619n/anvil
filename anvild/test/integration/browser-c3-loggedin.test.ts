/**
 * [C3] Agent browser — logged-in sites, hard stops and unlocks, downloads, hand-off: functional
 * scenarios (agent-cad-and-browser Phase C3 Acceptance, read with §4.14 items 27–30 and 44, and §7's
 * C3 row).
 *
 * Real stores and services on a real Supervisor; every browser call goes through the real
 * PreToolUse hook and the real `hooks.actionPolicy`; results arrive through the registry's
 * `onToolResult` (and, for downloads, through a real AgentDriver reading a scripted SDK stream);
 * the logged-in list syncs over real HTTP between daemons in the fleet simulator and between real
 * `createServer` daemons. No browser is launched ("Open agent browser" gets a fake launcher and a
 * real SQLite cookie database) and no Claude API call is made. The real Chrome run is
 * test/real/browser-c3.test.ts.
 *
 * Amended bullets: the `/checkout` URL rule is gone (item 44); bullet 2 is item 28.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type McpIntegration } from "@protocol";
import { AgentDriver } from "../../src/agent/driver";
import { humanTools } from "../../src/agent/human-tools";
import { QuestionBroker } from "../../src/agent/questions";
import { DOWNLOAD_MAX_BYTES } from "../../src/browser/downloads";
import type { LoggedInOpBody, LoggedInSyncBody } from "../../src/browser/loggedin";
import type { SitesOpBody, SitesSyncBody } from "../../src/browser/sites-sync";
import { createServer, type ServerHandle } from "../../src/server/http";
import { loadServerIdentity } from "../../src/server/identity";
import type { Session } from "../../src/session/session";
import { addBrowser, browserHook, browserOf, browserRig, browserSession, feedResult, pageResult, type BrowserRigOptions } from "../helpers/browser";
import { addCookies } from "../helpers/cookies";
import { callHook, isPending, parked, settle, type McpRig } from "../helpers/mcp";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const HARD_STOP = (site: string): string[] => ["Allow once", `Unlock ${site}`, "Deny"];
const cardLabels = (s: Session): string[] => parked(s).suggestions.map((x) => x.label);

/** The browser returned a screenshot (as the driver delivers it: a text block and an image block). */
function screenshot(rig: McpRig, s: Session): void {
  rig.sup.mcp.gate.onToolResult(s, "browser", {
    tool: "browser_take_screenshot",
    input: {},
    content: [{ type: "text", text: "### Result\n- [Screenshot of viewport](/x/page-2026-11-19T10-00-00-000Z.png)" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }],
    isError: false,
  });
}
/** Put the session's page at `url` (a snapshot result) with a current screenshot of it. */
function onPage(rig: McpRig, s: Session, url: string): void {
  feedResult(rig, s, "browser_snapshot", pageResult(url));
  screenshot(rig, s);
}
/** A call that must be decided with no card. */
async function direct(rig: McpRig, s: Session, tool: string, input: Record<string, unknown> = {}) {
  const out = await browserHook(rig, s, tool, input);
  expect([tool, s.pendingPermissions.size]).toEqual([tool, 0]);
  return out;
}
/** A call that must park a hard-stop card; answers it and returns the outcome and the card. */
async function hardStop(rig: McpRig, s: Session, tool: string, input: Record<string, unknown>, site: string, decision: "allow" | "allow_always" | "deny") {
  const call = browserHook(rig, s, tool, input);
  expect([tool, await isPending(call)]).toEqual([tool, true]);
  const card = [...s.pendingPermissions.values()][0]!;
  expect(card.suggestions.map((x) => x.label)).toEqual(HARD_STOP(site));
  rig.sup.resolvePermission(card.requestId, decision);
  return { out: await call, card };
}
async function pngOf(rig: McpRig, s: Session, attachmentId: string): Promise<Buffer> {
  const stored = rig.sup.attachmentBytes(s.id, attachmentId)!;
  expect(stored.mediaType).toBe("image/png");
  return Buffer.from(await Bun.file(stored.path).arrayBuffer());
}
const notices = (rig: McpRig, s: Session): string =>
  JSON.stringify(rig.sup.resume(s.id).flatMap((e: any) => (e.type === "conversation.snapshot" ? e.events : [])).filter((e: any) => e.kind === "assistant"));
const fileCards = (rig: McpRig, s: Session): unknown[] => rig.sup.resume(s.id).flatMap((e: any) => (e.type === "conversation.snapshot" ? e.events : [])).filter((e: any) => e.kind === "file_offer");

describe("Phase C3 acceptance: hard stops on a logged-in site", () => {
  let rig: McpRig;
  let integration: McpIntegration;
  beforeEach(async () => {
    rig = browserRig();
    integration = await addBrowser(rig);
    rig.sup.browserSiteAdd("bank.test");
    rig.sup.browserSiteAdd("plain.test");
    rig.sup.browserLoggedInAdd("bank.test"); // the owner listed it; locked
  });
  afterEach(() => rig.cleanup());

  test("[C3] on a LOCKED logged-in site under bypass: a snapshot, a PageDown key press and a same-site https navigation do not prompt; a click, an Enter key press and a form fill each prompt with a screenshot attached and no always-allow option", async () => {
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    onPage(rig, s, "https://www.bank.test/account");

    expect((await direct(rig, s, "browser_snapshot")).decision).toBe("allow");
    expect((await direct(rig, s, "browser_press_key", { key: "PageDown" })).decision).toBe("allow");
    expect((await direct(rig, s, "browser_navigate", { url: "https://www.bank.test/statements" })).decision).toBe("allow");

    for (const [tool, input] of [
      ["browser_click", { element: "Transfer", target: "e12" }],
      ["browser_press_key", { key: "Enter" }],
      ["browser_fill_form", { fields: [{ name: "amount", type: "textbox", target: "e3", value: "100" }] }],
    ] as const) {
      const call = browserHook(rig, s, tool, input);
      expect([tool, await isPending(call)]).toEqual([tool, true]); // bypass does not skip it
      const card = parked(s) as ReturnType<typeof parked> & { reason?: string; image?: { attachmentId: string; mediaType: string } };
      // Three options, none of them an "always allow".
      expect(cardLabels(s)).toEqual(["Allow once", "Unlock bank.test", "Deny"]);
      expect(cardLabels(s).some((l) => /always allow/i.test(l))).toBe(false);
      // The page screenshot is attached: a session attachment holding a real, non-empty PNG.
      expect(card.image).toEqual({ attachmentId: expect.any(String), mediaType: "image/png" });
      const png = await pngOf(rig, s, card.image!.attachmentId);
      expect(png.length).toBeGreaterThan(50);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(card.reason).toMatch(/on bank\.test, a logged-in site$/);
      // …and it is on the wire: what a device that attaches now receives.
      const wire = rig.sup.resume(s.id).find((e: any) => e.type === "permission.request" && e.requestId === card.requestId) as any;
      expect(wire).toMatchObject({ tool: `mcp__browser__${tool}`, reason: card.reason, image: card.image, replay: true });
      rig.sup.resolvePermission(card.requestId, "allow");
      expect([tool, (await call).decision]).toEqual([tool, "allow"]);
    }
    // "Allow once" was once: the same click asks again, and a session-wide allow of the browser changes nothing.
    rig.sup.mcp.gate.rememberAllowed(s, integration);
    expect((await hardStop(rig, s, "browser_click", { element: "Transfer", target: "e12" }, "bank.test", "deny")).out.decision).toBe("deny");
    expect(rig.sup.browserLoggedInEvent().sites).toEqual([expect.objectContaining({ site: "bank.test", unlocked: false })]);
  });

  test("[C3] on an allowed site that is not logged-in, a click, an Enter key press and a form fill do not prompt — in a bypass session and in an ordinary one (headed: only once no logged-in site is locked, fix-c-final)", async () => {
    for (const autonomy of ["bypass", "mostly-autonomous"] as const) {
      const s = await browserSession(rig, integration, { autonomy });
      onPage(rig, s, "https://plain.test/checkout");
      // Headed (fix-c-final): the agent profile holds the locked bank.test, and a frame of it can load
      // from the profile with no traffic — so even here the click is a hard stop naming it…
      const { out, card } = await hardStop(rig, s, "browser_click", { element: "Buy", target: "e1" }, "bank.test", "deny");
      expect(out.decision).toBe("deny");
      expect((card as { reason?: string }).reason).toMatch(/^click on plain\.test in the headed agent browser, whose profile holds bank\.test, a logged-in site/);
      // …until the owner unlocks it: then nothing on the page asks.
      rig.clock.advance(1000); // (the list orders its changes by time)
      rig.sup.browserLoggedInSetUnlocked("bank.test", true);
      onPage(rig, s, "https://plain.test/checkout");
      expect((await direct(rig, s, "browser_click", { element: "Buy", target: "e1" })).decision).toBe("allow");
      expect((await direct(rig, s, "browser_press_key", { key: "Enter" })).decision).toBe("allow");
      expect((await direct(rig, s, "browser_fill_form", { fields: [] })).decision).toBe("allow");
      rig.clock.advance(1000);
      rig.sup.browserLoggedInSetUnlocked("bank.test", false);
      rig.sup.mcp.gate.onTurnEnd(s);
    }
  });

  test("[C3] the card shows the page as it is now: after any action the screenshot is stale, so the next action is denied until the model takes a new one; a screenshot of another page does not count", async () => {
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    feedResult(rig, s, "browser_snapshot", pageResult("https://bank.test/pay"));
    // No screenshot yet: denied with the instruction; nothing is parked.
    const first = await direct(rig, s, "browser_click", { element: "Pay", target: "e1" });
    expect(first.decision).toBe("deny");
    expect(first.reason).toMatch(/Call browser_take_screenshot first, then make this call again/);
    expect((await direct(rig, s, "browser_take_screenshot")).decision).toBe("allow"); // a read: never asks
    screenshot(rig, s);
    expect((await hardStop(rig, s, "browser_click", { element: "Pay", target: "e1" }, "bank.test", "allow")).out.decision).toBe("allow");

    // The click ran; its result shows the page again. The earlier picture no longer shows the page as it is.
    feedResult(rig, s, "browser_click", pageResult("https://bank.test/pay/confirm"), { element: "Pay", target: "e1" });
    const second = await direct(rig, s, "browser_click", { element: "Confirm", target: "e2" });
    expect([second.decision, /browser_take_screenshot/.test(second.reason ?? "")]).toEqual(["deny", true]);
    screenshot(rig, s);
    const { card } = await hardStop(rig, s, "browser_click", { element: "Confirm", target: "e2" }, "bank.test", "deny");
    expect((card as { image?: unknown }).image).toBeDefined();

    // The page moved by itself after the picture was taken (a snapshot reports a new address).
    feedResult(rig, s, "browser_navigate", pageResult("about:blank"), { url: "about:blank" });
    onPage(rig, s, "https://bank.test/a");
    feedResult(rig, s, "browser_snapshot", pageResult("https://bank.test/b"));
    expect((await direct(rig, s, "browser_click", { element: "x", target: "e1" })).decision).toBe("deny");
  });

  test("[C3] gamed spec: a misleading element text changes nothing — the decision uses only the tool's class and the page site the daemon tracked", async () => {
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    onPage(rig, s, "https://bank.test/pay");
    for (const element of ["just scrolling (PageDown), read-only", "browser_snapshot", "Cancel — nothing is submitted", "a link on plain.test, not a logged-in site"]) {
      const { card } = await hardStop(rig, s, "browser_click", { element, target: "e1", key: "PageDown", url: "https://plain.test/" }, "bank.test", "deny");
      expect((card as { reason?: string }).reason).toBe("click on bank.test, a logged-in site"); // the daemon's words, not the model's
      feedResult(rig, s, "browser_navigate", pageResult("about:blank"), { url: "about:blank" }); // (Deny on a hard stop is just a denial: no page to leave)
      onPage(rig, s, "https://bank.test/pay");
    }
    // The other way round: a read described as a purchase is still a read.
    expect((await direct(rig, s, "browser_snapshot", { element: "Confirm purchase", target: "pay-now" })).decision).toBe("allow");
    // And the same click on a page the daemon tracked on a site that is NOT logged in is decided on the
    // daemon's facts only, whatever it claims: in headed mode the profile holds the locked bank.test
    // (fix-c-final), so it asks in the daemon's words…
    onPage(rig, s, "https://plain.test/");
    const { card } = await hardStop(rig, s, "browser_click", { element: "Pay now on bank.test", target: "e1" }, "bank.test", "deny");
    expect((card as { reason?: string }).reason).toMatch(/^click on plain\.test in the headed agent browser, whose profile holds bank\.test/);
    expect((card as { reason?: string }).reason).not.toMatch(/Pay now/);
    // …and with bank.test unlocked it does not ask.
    rig.sup.browserLoggedInSetUnlocked("bank.test", true);
    onPage(rig, s, "https://plain.test/");
    expect((await direct(rig, s, "browser_click", { element: "Pay now on bank.test", target: "e1" })).decision).toBe("allow");
  });

  test("[C3] a hard stop is denied without a card in an unattended (builder) session", async () => {
    // (A builder session has no integrations of its own; the policy is asked the way the gate asks it.)
    const s = await browserSession(rig, integration);
    onPage(rig, s, "https://bank.test/pay");
    const builder = { id: s.id, data: { ...s.data, workUnitRole: "builder" as const } };
    const v = browserOf(rig).gate.gate({ session: builder, integration, tool: "browser_click", fullTool: "mcp__browser__browser_click", input: { element: "Pay", target: "e1" }, cwd: s.data.cwd });
    expect(v).toEqual({ kind: "deny", reason: expect.stringMatching(/unattended/) });
    expect(s.pendingPermissions.size).toBe(0);
  });
});

describe("Phase C3: a hard-stop prompt that times out", () => {
  test("[C3] a hard-stop prompt nobody answers times out and is denied: the card is retired on every device and a late answer is refused", async () => {
    const rig = browserRig({ browser: { hardStopTimeoutMs: 60 } });
    try {
      const integration = await addBrowser(rig);
      rig.sup.browserSiteAdd("bank.test");
      rig.sup.browserLoggedInAdd("bank.test");
      const s = await browserSession(rig, integration, { autonomy: "bypass" });
      onPage(rig, s, "https://bank.test/pay");
      const call = browserHook(rig, s, "browser_click", { element: "Pay", target: "e1" });
      expect(await isPending(call)).toBe(true);
      const { requestId } = parked(s);
      expect(s.data.status).toBe("awaiting_permission");
      const out = await call; // nobody answers
      expect(out.decision).toBe("deny");
      expect(out.reason).toMatch(/click on bank\.test, a logged-in site \(denied: nobody answered in time\)/);
      expect(s.pendingPermissions.size).toBe(0);
      expect(s.data.status).not.toBe("awaiting_permission");
      expect(rig.sup.resume(s.id).some((e: any) => e.type === "permission.request")).toBe(false);
      expect(() => rig.sup.resolvePermission(requestId, "allow")).toThrow(/no pending permission request/);
      expect(rig.sup.browserLoggedInEvent().sites[0]!.unlocked).toBe(false);
      // Answered in time, the same prompt goes through (the limit is not a denial by itself).
      const again = browserHook(rig, s, "browser_click", { element: "Pay", target: "e1" });
      expect(await isPending(again)).toBe(true);
      rig.sup.resolvePermission(parked(s).requestId, "allow");
      expect((await again).decision).toBe("allow");
      await settle(100);
      expect(s.pendingPermissions.size).toBe(0);
    } finally {
      await rig.cleanup();
    }
  });
});

describe("Phase C3 acceptance: what makes a site logged-in (item 28)", () => {
  const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  let rig: McpRig;
  let integration: McpIntegration;
  let launches: { command: string; args: string[] }[];
  let closeChrome: (() => void) | undefined;
  const make = async (opts: BrowserRigOptions = {}) => {
    launches = [];
    rig = browserRig({
      ...opts,
      browser: {
        chromePath: () => CHROME,
        agentBrowserLauncher: (command, args) => {
          launches.push({ command, args });
          return { exited: new Promise<void>((r) => (closeChrome = r)), kill: () => closeChrome?.() };
        },
        ...opts.browser,
      },
    });
    integration = await addBrowser(rig);
  };
  const row = () => rig.sup.mcp.statuses().find((i) => i.kind === "browser")!;
  const loggedIn = () => rig.sup.browserLoggedInEvent().sites;
  afterEach(() => rig.cleanup());

  test("[C3] a site becomes logged-in when the profile gains a cookie for it during an Open agent browser session — with no list edit — and does NOT when cookies appear outside such a session", async () => {
    await make();
    const profile = join(rig.dir, "browser-profile");
    rig.sup.browserSiteAdd("shop.test");
    rig.sup.browserSiteAdd("news.test");

    // Cookies set while an AGENT session browses (most sites set one on the first visit): not logged-in.
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    onPage(rig, s, "https://news.test/");
    addCookies(profile, [[".news.test", "consent"], ["www.shop.test", "anon_cart"]]);
    rig.sup.mcp.gate.onTurnEnd(s);
    expect(loggedIn()).toEqual([]);
    expect((await direct(rig, s, "browser_click", { element: "Read more", target: "e1" })).decision).toBe("allow");
    rig.sup.mcp.gate.onTurnEnd(s);

    // The owner opens the agent browser and logs in to shop.test.
    rig.sup.browserOpenAgentBrowser();
    expect(launches).toEqual([{ command: CHROME, args: [`--user-data-dir=${profile}`, "--password-store=basic", "--use-mock-keychain", "--no-first-run", "--no-default-browser-check"] }]);
    expect(loggedIn()).toEqual([]); // nothing is decided while it is open
    addCookies(profile, [[".shop.test", "session_id"], ["accounts.bank.co.uk", "auth"]]);
    closeChrome!();
    expect(await browserOf(rig).ownerBrowserDone).toEqual(["bank.co.uk", "shop.test"]);
    expect(loggedIn()).toEqual([
      { site: "bank.co.uk", source: "login-session", unlocked: false, addedAt: expect.any(Number) },
      { site: "shop.test", source: "login-session", unlocked: false, addedAt: expect.any(Number) },
    ]);
    // news.test only ever had its first-visit cookie: still not a logged-in site.
    expect(loggedIn().some((x) => x.site === "news.test")).toBe(false);
    expect(rig.registry.ofType("browser.loggedin").at(-1)!.sites.map((x) => x.site)).toEqual(["bank.co.uk", "shop.test"]);

    // From now on a click on shop.test is a hard stop naming it. On news.test it is one too, in headed
    // mode, but because the profile holds the locked logged-in sites (fix-c-final), not as news.test.
    startAgain(rig, s);
    onPage(rig, s, "https://www.shop.test/cart");
    expect((await hardStop(rig, s, "browser_click", { element: "Buy", target: "e1" }, "shop.test", "deny")).out.decision).toBe("deny");
    onPage(rig, s, "https://news.test/");
    const news = await hardStop(rig, s, "browser_click", { element: "Read more", target: "e1" }, "bank.co.uk", "deny");
    expect((news.card as { reason?: string }).reason).toMatch(/^click on news\.test in the headed agent browser, whose profile holds bank\.co\.uk, a logged-in site.*its profile also holds shop\.test/);
    rig.sup.mcp.gate.onTurnEnd(s);
    s.setStatus("idle"); // the session's turn is over

    // A second owner session in which nothing new is set adds nothing; cookies after it closes add nothing.
    rig.sup.browserOpenAgentBrowser();
    closeChrome!();
    expect(await browserOf(rig).ownerBrowserDone).toEqual([]);
    addCookies(profile, [[".later.test", "x"]]);
    expect(loggedIn().map((x) => x.site)).toEqual(["bank.co.uk", "shop.test"]);
  });

  test("[C3] while Open agent browser is running the browser is in use by owner: its row says so, every session's browser call is denied, and a second open is refused; closing the window frees it", async () => {
    await make();
    rig.sup.browserSiteAdd("plain.test");
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    expect(row().browser).toMatchObject({ desktop: true });
    expect(row().browser!.ownerBrowser).toBeUndefined();
    const before = rig.registry.ofType("mcp.integrations").length;

    rig.clock.advance(5_000);
    rig.sup.browserOpenAgentBrowser();
    expect(row().browser!.ownerBrowser).toEqual({ since: rig.clock.now });
    expect(rig.registry.ofType("mcp.integrations").length).toBeGreaterThan(before); // clients are told
    for (const [tool, input] of [["browser_navigate", { url: "https://plain.test/" }], ["browser_snapshot", {}], ["browser_click", { target: "e1" }]] as const) {
      const out = await direct(rig, s, tool, input);
      expect([tool, out.decision]).toEqual([tool, "deny"]);
      expect(out.reason).toMatch(/in use by the owner \(Open agent browser\)/);
    }
    expect(rig.sup.mcp.lock.holder(integration.id)).toBeUndefined(); // no session took the lock
    expect(() => rig.sup.browserOpenAgentBrowser()).toThrow(/already open/);
    expect(launches).toHaveLength(1);

    closeChrome!();
    await browserOf(rig).ownerBrowserDone;
    expect(row().browser!.ownerBrowser).toBeUndefined();
    startAgain(rig, s);
    expect((await direct(rig, s, "browser_navigate", { url: "https://plain.test/" })).decision).toBe("allow");
  });

  test("[C3] Open agent browser is refused where nobody is logged in at the screen, while a session holds the browser, and without Chrome — and nothing is launched", async () => {
    await make({ desktop: false });
    expect(row().browser!.desktop).toBe(false);
    expect(() => rig.sup.browserOpenAgentBrowser()).toThrow(/only be opened where someone is logged in at the screen \(nobody is logged in at this machine's screen\)/);
    await rig.cleanup();

    await make();
    rig.sup.browserSiteAdd("plain.test");
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    s.setStatus("thinking"); // mid-turn
    expect((await direct(rig, s, "browser_navigate", { url: "https://plain.test/" })).decision).toBe("allow"); // it now holds the exclusive lock
    expect(() => rig.sup.browserOpenAgentBrowser()).toThrow(/a session is using the agent browser/);
    rig.sup.mcp.gate.onTurnEnd(s);
    s.setStatus("idle");
    await rig.cleanup();

    await make({ browser: { chromePath: () => undefined } });
    expect(() => rig.sup.browserOpenAgentBrowser()).toThrow(/Google Chrome is not installed/);
    expect(launches).toEqual([]);
    expect(existsSync(join(rig.dir, "browser-profile"))).toBe(false);
  });

  test("[C3] the logged-in list and the agent profile's cookies are off limits to the session's own tools", async () => {
    await make();
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    const tool = (name: string, input: Record<string, unknown>) => callHook(s, rig.broker, name, { inProcessKeys: [], gate: rig.sup.mcp.gate }, input);
    for (const command of [
      `echo '{"sites":[{"site":"bank.test","unlocked":true}]}' > ${join(rig.dir, "browser-loggedin.json")}`,
      "sed -i '' 's/false/true/' ~/.anvil/browser-loggedin.json",
      `curl -s -X POST http://127.0.0.1:7701/api/browser/loggedin/op -H 'content-type: application/json' -d '{"from":"x","ops":[{"op":"unlock","site":"bank.test"}]}'`,
    ]) {
      expect([command, (await tool("Bash", { command })).decision]).toEqual([command, "deny"]);
    }
    expect((await tool("Write", { file_path: join(rig.dir, "browser-loggedin.json"), content: "{}" })).decision).toBe("deny");
    expect((await tool("Edit", { file_path: join(rig.dir, "browser-loggedin.json"), old_string: "false", new_string: "true" })).decision).toBe("deny");
  });
});

/** The session's next turn: its driver is rebuilt, so the launch line (and the session's runtime) is resolved again. */
function startAgain(rig: McpRig, s: Session): void {
  rig.sup.mcp.gate.onTurnEnd(s);
  rig.sup.mcp.serversFor(s, undefined);
}

// ── Fleet simulator (as test/integration/browser-c2-sites.test.ts) ─────────────────────────────
// Several daemons in one process, each a real Supervisor with its own state dir, joined by real HTTP
// on loopback: a listener per daemon hands the sync routes to that daemon's real services.

interface SimDaemon {
  rig: McpRig;
  serverId: string;
  url: string;
  integration: McpIntegration;
  offline(): void;
  online(): void;
  stop(): Promise<void>;
}

async function simDaemon(serverId: string, fleet: { members: () => SimDaemon[]; hub: () => SimDaemon | undefined }, opts: BrowserRigOptions = {}): Promise<SimDaemon> {
  const rig = browserRig(opts);
  let server: ReturnType<typeof Bun.serve> | undefined;
  let port = 0;
  const serve = (): void => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const b = browserOf(rig);
        if (req.method !== "POST") return new Response("not found", { status: 404 });
        if (path === "/api/browser/sites/sync") return Response.json(b.sites.receiveSync((await req.json()) as SitesSyncBody));
        if (path === "/api/browser/sites/op") return Response.json(b.sites.receiveOps((await req.json()) as SitesOpBody));
        if (path === "/api/browser/loggedin/sync") return Response.json(b.loggedIn.receiveSync((await req.json()) as LoggedInSyncBody));
        if (path === "/api/browser/loggedin/op") return Response.json(b.loggedIn.receiveOps((await req.json()) as LoggedInOpBody));
        return new Response("not found", { status: 404 });
      },
    });
    port = server.port as number;
  };
  serve();
  const d: SimDaemon = {
    rig,
    serverId,
    url: `http://127.0.0.1:${port}`,
    integration: await addBrowser(rig),
    offline: () => void server?.stop(true),
    online: serve,
    stop: async () => {
      server?.stop(true);
      await rig.cleanup();
    },
  };
  browserOf(rig).setFleet({
    selfServerId: serverId,
    members: () => fleet.members().filter((m) => m !== d && fleet.hub() === d).map((m) => ({ serverId: m.serverId, url: `${m.url}/`, host: "127.0.0.1" })),
    pairedHubId: () => (fleet.hub() && fleet.hub() !== d ? fleet.hub()!.serverId : null),
    selfUrl: async () => d.url,
  });
  return d;
}

describe("Phase C3 acceptance: unlock is persistent and fleet-wide (item 44; fleet simulator)", () => {
  let hub: SimDaemon;
  let m1: SimDaemon;
  let m2: SimDaemon;
  const all: SimDaemon[] = [];
  const view = (d: SimDaemon): [string, boolean][] => d.rig.sup.browserLoggedInEvent().sites.map((s) => [s.site, s.unlocked]);
  const sync = async (): Promise<void> => {
    for (let round = 0; round < 2; round++) {
      for (const d of all) {
        await browserOf(d.rig).sites.syncNow();
        await browserOf(d.rig).loggedIn.syncNow();
      }
      await settle(20);
    }
  };

  beforeEach(async () => {
    all.length = 0;
    const fleet = { members: () => all, hub: () => hub as SimDaemon | undefined };
    hub = await simDaemon("srv_hub", fleet);
    all.push(hub);
    m1 = await simDaemon("srv_m1", fleet);
    all.push(m1);
    m2 = await simDaemon("srv_m2", fleet, { desktop: false }); // a machine with no screen: headless fallback
    all.push(m2);
    hub.rig.sup.browserSiteAdd("shop.test");
    hub.rig.sup.browserLoggedInAdd("shop.test");
    await sync();
  });
  afterEach(async () => {
    for (const d of all) await d.stop();
  });

  test("[C3] choosing Unlock <site> allows the call; a later click on that site in a NEW session and on a SECOND daemon after hub sync does not prompt, including on a /checkout page; switching the unlock off in Settings makes the next click prompt again", async () => {
    expect(view(hub)).toEqual([["shop.test", false]]);
    expect(view(m1)).toEqual([["shop.test", false]]); // the list itself is hub-synced

    // On the hub: a click on the locked site is a hard stop. The owner chooses "Unlock shop.test".
    const s = await browserSession(hub.rig, hub.integration, { autonomy: "bypass" });
    onPage(hub.rig, s, "https://shop.test/cart");
    const { out, card } = await hardStop(hub.rig, s, "browser_click", { element: "Buy", target: "e1" }, "shop.test", "allow_always");
    expect(out.decision).toBe("allow"); // the call goes through…
    expect(card.suggestions[1]).toEqual({ decision: "allow_always", label: "Unlock shop.test" });
    expect(view(hub)).toEqual([["shop.test", true]]); // …and the site is unlocked
    expect(s.data.mcpAllowed ?? []).toEqual([]); // it is an unlock of the SITE, not a session-wide allow of the browser

    // Nothing on that site asks any more — same session, checkout and payment pages included.
    for (const url of ["https://shop.test/cart", "https://shop.test/checkout", "https://pay.shop.test/checkout/confirm?order=1"]) {
      feedResult(hub.rig, s, "browser_snapshot", pageResult(url));
      for (const [tool, input] of [["browser_click", { element: "Place order", target: "e1" }], ["browser_press_key", { key: "Enter" }], ["browser_fill_form", { fields: [] }], ["browser_type", { target: "e2", text: "4111" }]] as const) {
        feedResult(hub.rig, s, "browser_snapshot", pageResult(url));
        expect([url, tool, (await direct(hub.rig, s, tool, input)).decision]).toEqual([url, tool, "allow"]);
      }
    }
    hub.rig.sup.mcp.gate.onTurnEnd(s);

    // A NEW session on the same daemon — also a non-bypass one.
    const fresh = await browserSession(hub.rig, hub.integration, { autonomy: "mostly-autonomous" });
    feedResult(hub.rig, fresh, "browser_snapshot", pageResult("https://shop.test/checkout"));
    expect((await direct(hub.rig, fresh, "browser_click", { element: "Place order", target: "e1" })).decision).toBe("allow");
    hub.rig.sup.mcp.gate.onTurnEnd(fresh);

    // A SECOND daemon, after hub sync.
    await sync();
    expect(view(m1)).toEqual([["shop.test", true]]);
    const onM1 = await browserSession(m1.rig, m1.integration, { autonomy: "bypass" });
    feedResult(m1.rig, onM1, "browser_snapshot", pageResult("https://shop.test/checkout/payment"));
    expect((await direct(m1.rig, onM1, "browser_click", { element: "Pay now", target: "e1" })).decision).toBe("allow");
    expect((await direct(m1.rig, onM1, "browser_press_key", { key: "Enter" })).decision).toBe("allow");
    // …and after that daemon restarts (the unlock is persistent).
    expect(JSON.parse(readFileSync(join(m1.rig.dir, "browser-loggedin.json"), "utf8")).sites).toEqual([expect.objectContaining({ site: "shop.test", unlocked: true })]);

    // The owner switches the unlock off in Settings (on the hub): the next click prompts again, on both machines.
    hub.rig.sup.browserLoggedInSetUnlocked("shop.test", false);
    await sync();
    expect(view(hub)).toEqual([["shop.test", false]]);
    expect(view(m1)).toEqual([["shop.test", false]]);
    onPage(m1.rig, onM1, "https://shop.test/checkout/payment");
    expect((await hardStop(m1.rig, onM1, "browser_click", { element: "Pay now", target: "e1" }, "shop.test", "deny")).out.decision).toBe("deny");
    startAgain(hub.rig, fresh);
    onPage(hub.rig, fresh, "https://shop.test/checkout");
    expect((await hardStop(hub.rig, fresh, "browser_click", { element: "Place order", target: "e1" }, "shop.test", "deny")).out.decision).toBe("deny");
  });

  test("[C3] Unlock chosen on a member reaches the hub and every other member; removing the site on the hub removes it everywhere", async () => {
    const onM1 = await browserSession(m1.rig, m1.integration, { autonomy: "bypass" });
    onPage(m1.rig, onM1, "https://shop.test/cart");
    expect((await hardStop(m1.rig, onM1, "browser_click", { element: "Buy", target: "e1" }, "shop.test", "allow_always")).out.decision).toBe("allow");
    expect(view(m1)).toEqual([["shop.test", true]]); // at once on the member, before the hub knows
    await sync();
    expect(view(hub)).toEqual([["shop.test", true]]);
    expect(view(m2)).toEqual([["shop.test", true]]);
    expect(browserOf(m1.rig).loggedIn.store.pending()).toEqual([]);

    hub.rig.sup.browserLoggedInRemove("shop.test");
    await sync();
    expect([view(hub), view(m1), view(m2)]).toEqual([[], [], []]);
  });

  test("[C3] an unlock queued on a member that was cut off cannot undo a lock the owner set on the hub afterwards", async () => {
    hub.rig.sup.browserLoggedInSetUnlocked("shop.test", true);
    await sync();
    m1.offline();
    hub.offline();
    // On the cut-off member someone locks and unlocks again (queued)…
    m1.rig.clock.advance(1_000);
    m1.rig.sup.browserLoggedInSetUnlocked("shop.test", false);
    m1.rig.clock.advance(1_000);
    m1.rig.sup.browserLoggedInSetUnlocked("shop.test", true);
    // …and later the owner switches the unlock off on the hub: the brake.
    hub.rig.clock.advance(60_000);
    hub.rig.sup.browserLoggedInSetUnlocked("shop.test", false);
    m1.online();
    hub.online();
    await sync();
    expect([view(hub), view(m1), view(m2)]).toEqual([[["shop.test", false]], [["shop.test", false]], [["shop.test", false]]]);
  });

  test("[C3] in headless fallback mode an unlocked logged-in site is still refused, at navigation and when a page lands on it", async () => {
    hub.rig.sup.browserLoggedInSetUnlocked("shop.test", true);
    await sync();
    expect(view(m2)).toEqual([["shop.test", true]]);
    expect(m2.rig.sup.mcp.statuses()[0]!.browser!.mode).toBe("headless");
    const s = await browserSession(m2.rig, m2.integration, { autonomy: "bypass" });
    const nav = await direct(m2.rig, s, "browser_navigate", { url: "https://shop.test/" });
    expect(nav.decision).toBe("deny");
    expect(nav.reason).toMatch(/shop\.test is a logged-in site.*headless/);
    expect((await direct(m2.rig, s, "browser_tabs", { action: "new", url: "https://www.shop.test/checkout" })).decision).toBe("deny");
    feedResult(m2.rig, s, "browser_click", pageResult("https://shop.test/account"));
    expect(browserOf(m2.rig).gate.state(s.id).closing?.reason).toMatch(/logged-in site that the headless browser may not open/);
    expect((await direct(m2.rig, s, "browser_snapshot")).decision).toBe("deny");
    // The same unlocked site in the headed browser of a machine with a screen: nothing asks.
    const onHub = await browserSession(hub.rig, hub.integration, { autonomy: "bypass" });
    expect((await direct(hub.rig, onHub, "browser_navigate", { url: "https://shop.test/" })).decision).toBe("allow");
  });
});

describe("Phase C3 acceptance: uploads and script evaluation, on every site", () => {
  let rig: McpRig;
  let integration: McpIntegration;
  beforeEach(async () => {
    rig = browserRig();
    integration = await addBrowser(rig);
    for (const site of ["plain.test", "bank.test", "open.test"]) rig.sup.browserSiteAdd(site);
    rig.sup.browserLoggedInAdd("bank.test");
    rig.sup.browserLoggedInAdd("open.test");
    rig.sup.browserLoggedInSetUnlocked("open.test", true);
  });
  afterEach(() => rig.cleanup());

  test("[C3] an upload of a path outside the worktree is denied; inside it, it prompts — on a site that is not logged-in, on a locked one and on an unlocked one, under bypass", async () => {
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    writeFileSync(join(s.data.cwd, "part.step"), "ISO-10303-21;");
    for (const url of ["https://plain.test/upload", "https://bank.test/upload", "https://open.test/checkout/upload"]) {
      onPage(rig, s, url);
      for (const paths of [["/etc/passwd"], ["../outside.step"], [join(rig.dir, "..", "x.step")], ["part.step", "/Users/x/.ssh/id_ed25519"]]) {
        const out = await direct(rig, s, "browser_file_upload", { paths });
        expect([url, paths.join(), out.decision]).toEqual([url, paths.join(), "deny"]);
        expect(out.reason).toMatch(/outside this session's worktree/);
      }
      for (const tool of ["browser_file_upload", "browser_drop"]) {
        const call = browserHook(rig, s, tool, { paths: ["part.step"], target: "e1" });
        expect([url, tool, await isPending(call)]).toEqual([url, tool, true]);
        expect(cardLabels(s)).toEqual(["Allow once", "Deny"]); // asked every time: no always, no unlock
        rig.sup.resolvePermission(parked(s).requestId, "allow");
        expect((await call).decision).toBe("allow");
      }
    }
  });

  test("[C3] a script-evaluation call on a public site is denied — logged-in or not, unlocked or not, under bypass — and browser_run_code_unsafe always is", async () => {
    const s = await browserSession(rig, integration, { autonomy: "bypass" });
    // Phase C4 sets the hook (evaluate on the session's own test daemon only); this session has none.
    expect(typeof browserOf(rig).hooks.allowEvaluate).toBe("function");
    expect(browserOf(rig).testDaemons.origin(s.id)).toBeUndefined();
    for (const url of ["https://plain.test/", "https://bank.test/", "https://open.test/checkout"]) {
      onPage(rig, s, url);
      const evalOut = await direct(rig, s, "browser_evaluate", { function: "() => document.cookie" });
      expect([url, evalOut.decision]).toEqual([url, "deny"]);
      expect(evalOut.reason).toMatch(/only allowed on this session's own throwaway test daemon/);
      expect([url, (await direct(rig, s, "browser_run_code_unsafe", { code: "async (page) => 1" })).decision]).toEqual([url, "deny"]);
    }
  });
});

describe("Phase C3 acceptance: downloads", () => {
  let rig: McpRig;
  let integration: McpIntegration;
  let s: Session;
  let out: string;
  const quarantine = (): string => join(s.data.cwd, ".anvil-downloads");
  const make = async (opts: BrowserRigOptions = {}) => {
    rig = browserRig(opts);
    integration = await addBrowser(rig);
    rig.sup.browserSiteAdd("parts.test");
    const wt = mkdtempSync(join(rig.dir, "wt-"));
    mkdirSync(join(wt, ".git", "info"), { recursive: true });
    writeFileSync(join(wt, ".git", "info", "exclude"), "");
    s = await browserSession(rig, integration, { cwd: wt, autonomy: "bypass" });
    out = join(wt, ".anvil-browser");
  };
  afterEach(() => rig.cleanup());

  /** One turn of a real AgentDriver over a scripted SDK stream: each `[tool, input, resultText]` in order. */
  async function driverTurn(calls: [string, Record<string, unknown>, string][]): Promise<void> {
    const messages: unknown[] = [{ type: "system", subtype: "init", session_id: "claude-1", slash_commands: [], mcp_servers: [{ name: "browser", status: "connected" }] }];
    calls.forEach(([tool, input, text], i) => {
      messages.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `tu_${i}`, name: `mcp__browser__${tool}`, input }] } });
      messages.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: [{ type: "text", text }] }] } });
    });
    messages.push({ type: "result", subtype: "success", total_cost_usd: 0, usage: {} });
    const queryFn = (() => ({
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
      },
      interrupt: async () => {},
      setModel: async () => {},
      getContextUsage: async () => undefined,
    })) as never;
    // The server map as the supervisor built it for this session (not rebuilt here: a rebuild is a new browser).
    const driver = new AgentDriver(s, { render: (x: string) => ({ source: x, html: x }) } as never, rig.broker, new QuestionBroker(), {}, () => {}, { browser: { command: "x", args: [] } }, undefined, undefined, queryFn, undefined, undefined, undefined, undefined, undefined, undefined, undefined, rig.sup.mcp.gate);
    driver.prompt("go");
    await settle(30);
    await driver.stop();
  }
  const PAGE = pageResult("https://parts.test/bracket");
  const downloaded = (name: string): string => `${PAGE}\n### Events\n- Downloaded file ${name} to "${join(out, name)}"`;

  test("[C3] a 1 KB part.step download lands in .anvil-downloads/ with no file card; a .dmg is deleted and reported; a file over the limit is deleted and reported", async () => {
    await make();
    writeFileSync(join(out, "part.step"), Buffer.alloc(1024, 0x41));
    writeFileSync(join(out, "Installer.dmg"), Buffer.alloc(2048, 0x42));
    writeFileSync(join(out, "huge.zip"), "x");
    truncateSync(join(out, "huge.zip"), DOWNLOAD_MAX_BYTES + 1); // sparse: 200 MB + 1 byte with no real disk use
    await driverTurn([
      ["browser_click", { element: "Download STEP", target: "e1" }, downloaded("part.step")],
      ["browser_click", { element: "Download installer", target: "e2" }, downloaded("Installer.dmg")],
      ["browser_click", { element: "Download everything", target: "e3" }, downloaded("huge.zip")],
    ]);

    // The STEP file is in the quarantine, intact, and out of the browser's folder.
    expect(readdirSync(quarantine())).toEqual(["part.step"]);
    expect(readFileSync(join(quarantine(), "part.step")).length).toBe(1024);
    expect(existsSync(join(out, "part.step"))).toBe(false);
    // The other two are gone from disk altogether.
    expect(existsSync(join(out, "Installer.dmg"))).toBe(false);
    expect(existsSync(join(out, "huge.zip"))).toBe(false);
    expect(readdirSync(out).filter((f) => !f.startsWith("page-"))).toEqual([]);

    // No file card for any of them — the quarantined file included.
    expect(fileCards(rig, s)).toEqual([]);
    // Reported to the session as notice lines…
    const said = notices(rig, s);
    expect(said).toContain("Download `part.step` was put in quarantine at `.anvil-downloads/part.step`");
    expect(said).toContain("Download `Installer.dmg` was deleted: .dmg files are not allowed");
    expect(said).toMatch(/Download `huge\.zip` was deleted: it is 200\.0 MB, over the 200\.0 MB limit/);
    // …and to the model, with the next browser call it makes.
    const next = await browserHook(rig, s, "browser_snapshot");
    expect(next.decision).toBe("allow");
    expect(next.additionalContext).toContain('"part.step" was moved to .anvil-downloads/part.step');
    expect(next.additionalContext).toContain('"Installer.dmg" was DELETED: .dmg files are not allowed');
    expect(next.additionalContext).toMatch(/"huge\.zip" was DELETED: it is 200\.0 MB, over the 200\.0 MB limit/);
    expect((await browserHook(rig, s, "browser_snapshot")).additionalContext).toBeUndefined(); // told once
    // Both folders are git-excluded.
    expect(readFileSync(join(s.data.cwd, ".git", "info", "exclude"), "utf8")).toBe(".anvil-browser/\n.anvil-downloads/\n");
  });

  test("[C3] an injected size limit works the same way: a file one byte over it is deleted and reported, one at it is kept", async () => {
    await make({ browser: { maxDownloadBytes: 4096 } });
    writeFileSync(join(out, "big.pdf"), Buffer.alloc(4097));
    writeFileSync(join(out, "ok.pdf"), Buffer.alloc(4096));
    await driverTurn([["browser_click", { target: "e1" }, `${downloaded("big.pdf")}\n- Downloaded file ok.pdf to "${join(out, "ok.pdf")}"`]]);
    expect(readdirSync(quarantine())).toEqual(["ok.pdf"]);
    expect(existsSync(join(out, "big.pdf"))).toBe(false);
    expect(notices(rig, s)).toMatch(/Download `big\.pdf` was deleted: it is 4\.0 kB, over the 4\.0 kB limit/);
  });

  test("[C3] the Downloaded line arriving one result late still gets handled; Playwright's own page and console files, and a file the model asked for by filename, are not moved", async () => {
    await make();
    const own = ["page-2026-11-19T18-11-20-885Z.yml", "page-2026-11-19T18-11-21-783Z.png", "console-2026-11-19T18-11-20-859Z.log"];
    for (const f of own) writeFileSync(join(out, f), "playwright's own");
    await driverTurn([
      // The click that starts the download: only "Downloading…", the file is not there yet.
      ["browser_click", { element: "Download", target: "e1" }, `${PAGE}\n### Events\n- Downloading file part.step ...`],
      ["browser_take_screenshot", { filename: "evidence.png" }, "### Result\n- [Screenshot of viewport](" + join(out, "evidence.png") + ")"],
    ]);
    expect(existsSync(quarantine()) ? readdirSync(quarantine()) : []).toEqual([]);

    // The download finishes; the NEXT tool's result — an unrelated dialog — carries the line.
    writeFileSync(join(out, "part.step"), Buffer.alloc(1024, 0x41));
    writeFileSync(join(out, "evidence.png"), "the model's own screenshot");
    await driverTurn([["browser_handle_dialog", { accept: true }, `### Page\n- Page URL: https://parts.test/bracket\n### Events\n- Downloaded file part.step to "${join(out, "part.step")}"`]]);
    expect(readdirSync(quarantine())).toEqual(["part.step"]);
    expect(readdirSync(out).sort()).toEqual([...own, "evidence.png"].sort()); // none of these moved, at the result or at the end-of-turn sweep
    expect(notices(rig, s)).toContain("Download `part.step` was put in quarantine");
    expect(fileCards(rig, s)).toEqual([]);
  });

  test("[C3] a download no result ever names is caught by the sweep when the turn ends; a Downloaded line that names a file outside .anvil-browser/ moves nothing", async () => {
    await make();
    writeFileSync(join(s.data.cwd, "design.step"), "MINE");
    await driverTurn([["browser_click", { target: "e1" }, `${PAGE}\n### Events\n- Downloaded file design.step to "${join(s.data.cwd, "design.step")}"\n- Downloaded file hosts to "/etc/hosts"`]]);
    expect(readFileSync(join(s.data.cwd, "design.step"), "utf8")).toBe("MINE"); // page-influenced text cannot make the daemon move a file
    expect(existsSync(quarantine())).toBe(false);

    writeFileSync(join(out, "silent.csv"), "a,b\n1,2\n");
    writeFileSync(join(out, "silent.command"), "#!/bin/sh\necho pwned\n");
    await driverTurn([["browser_wait_for", { time: 1 }, "### Result\nWaited for 1 seconds"]]);
    expect(readdirSync(quarantine())).toEqual(["silent.csv"]);
    expect(existsSync(join(out, "silent.command"))).toBe(false);
    expect(notices(rig, s)).toContain("Download `silent.command` was deleted: .command files are not allowed");
    const next = await browserHook(rig, s, "browser_snapshot");
    expect(next.additionalContext).toContain('"silent.csv" was moved to .anvil-downloads/silent.csv');
  });

  test("[C3] files in the quarantine are never executed: session Bash that runs one is denied under every policy, while copying one out is not", async () => {
    await make();
    writeFileSync(join(out, "part.step"), "x");
    await driverTurn([["browser_click", { target: "e1" }, downloaded("part.step")]]);
    const tool = (command: string) => callHook(s, rig.broker, "Bash", { inProcessKeys: [], gate: rig.sup.mcp.gate }, { command });
    for (const command of ["sh .anvil-downloads/part.step", "./.anvil-downloads/part.step", "chmod +x .anvil-downloads/part.step", "python3 .anvil-downloads/part.step", "open .anvil-downloads/part.step", "cd .anvil-downloads && ./part.step"]) {
      const res = await tool(command);
      expect([command, res.decision]).toEqual([command, "deny"]);
      expect(res.reason).toMatch(/never executed/);
    }
    expect((await tool("cp .anvil-downloads/part.step cad/refs/part.step")).decision).toBe("allow"); // the deliberate copy
    expect((await tool("ls -la .anvil-downloads/")).decision).toBe("allow");
  });
});

describe("Phase C3 acceptance: hand-off", () => {
  test("[C3] request_human parks until I've cleared it; in an unattended session it returns an error at once and reports the session through onUnattendedHumanRequest", async () => {
    const rig = browserRig();
    try {
      const integration = await addBrowser(rig);
      rig.sup.browserSiteAdd("shop.test");
      const s = await browserSession(rig, integration);
      onPage(rig, s, "https://shop.test/login");
      const call = (session: Session, reason: string) => (humanTools(rig.sup.human, session)[0]!.handler as (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)({ reason }, {});

      const parkedCall = call(s, "Cloudflare wants a human on shop.test");
      expect(await isPending(parkedCall)).toBe(true);
      const card = [...s.pendingHumans.values()][0]!;
      expect(card).toMatchObject({ reason: "Cloudflare wants a human on shop.test", image: { mediaType: "image/png" } });
      expect((await pngOf(rig, s, card.image!.attachmentId)).subarray(1, 4).toString()).toBe("PNG"); // the same screenshot source as the hard-stop card
      await settle(40);
      expect(await isPending(parkedCall)).toBe(true); // still parked: only the owner's answer ends it
      rig.sup.resolveHumanRequest(card.requestId);
      expect((await parkedCall).content[0]!.text).toMatch(/The owner says it is cleared/);

      const blocked: [string, string][] = [];
      rig.sup.human.onUnattendedHumanRequest = (id, reason) => void blocked.push([id, reason]);
      const builder = await rig.session({ workUnitRole: "builder", workUnitId: "wu_7" });
      const res = await call(builder, "CAPTCHA on the supplier's site");
      expect(res.isError).toBe(true);
      expect(blocked).toEqual([[builder.id, "CAPTCHA on the supplier's site"]]);
      expect(builder.hasPendingHuman()).toBe(false);
    } finally {
      await rig.cleanup();
    }
  });
});

// ── The real HTTP server: dispatch, the on-connect event and the sync routes ────────────────────

describe("Phase C3: real daemons over HTTP and WebSocket", () => {
  const base = { v: PROTOCOL_VERSION, ts: "2026-11-19T00:00:00.000Z" };
  let dirs: string[] = [];
  let servers: ServerHandle[] = [];
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "anvil-c3-http-"));
    dirs.push(d);
    return d;
  };
  const boot = (stateDir: string, features: string[], selfUrl?: () => string): ServerHandle => {
    const srv = createServer({ host: "127.0.0.1", port: 0, stateDir, envFile: join(stateDir, "env"), features, resolveIdentity: async () => ({ trust: "unknown" }), selfBaseUrl: async () => selfUrl?.() });
    servers.push(srv);
    return srv;
  };
  afterEach(async () => {
    for (const s of servers) await s.shutdown();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    servers = [];
    dirs = [];
  });
  function client(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: any[] = [];
    const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      frames.push(m);
      for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
    };
    return {
      frames,
      send: (payload: object) => ws.send(JSON.stringify({ ...base, ...payload })),
      until: (pred: (m: any) => boolean, ms = 4000) =>
        new Promise<any>((resolve, reject) => {
          const hit = frames.find(pred);
          if (hit) return resolve(hit);
          const t = setTimeout(() => reject(new Error("timeout waiting for a frame")), ms);
          waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
        }),
      close: () => ws.close(),
    };
  }
  const reply = (cid: string) => (m: any) => m.cid === cid && (m.type === "ack" || m.type === "command.error");
  const listIs = (...rows: [string, boolean][]) => (m: any) => m.type === "browser.loggedin" && JSON.stringify(m.sites.map((s: any) => [s.site, s.unlocked])) === JSON.stringify(rows);
  const post = (port: number, path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  test("[C3] browser.loggedin arrives on connect; list / add / remove / set_unlocked are acked, validated and broadcast to every client; human.request.respond is dispatched; every command, open_agent_browser included, is refused on a daemon with the feature off", async () => {
    const on = boot(dir(), ["mcp-integrations", "browser"]);
    const a = client(on.port);
    const b = client(on.port);
    await a.until(listIs());
    await b.until(listIs());

    a.send({ type: "browser.loggedin.add", site: "https://www.Bank.test/login", cid: "c1" });
    expect((await a.until(reply("c1"))).type).toBe("ack");
    await b.until(listIs(["bank.test", false])); // listed by its registrable domain, locked, on the other client too
    expect((await b.until(listIs(["bank.test", false]))).sites[0]).toMatchObject({ source: "owner" });

    a.send({ type: "browser.loggedin.set_unlocked", site: "bank.test", unlocked: true, cid: "c2" });
    expect((await a.until(reply("c2"))).type).toBe("ack");
    await b.until(listIs(["bank.test", true]));
    a.send({ type: "browser.loggedin.set_unlocked", site: "bank.test", unlocked: "yes", cid: "c3" });
    expect(await a.until(reply("c3"))).toMatchObject({ type: "command.error", message: expect.stringMatching(/true or false/) });
    a.send({ type: "browser.loggedin.set_unlocked", site: "nope.test", unlocked: true, cid: "c4" });
    expect(await a.until(reply("c4"))).toMatchObject({ type: "command.error", message: expect.stringMatching(/not a logged-in site/) });
    a.send({ type: "browser.loggedin.add", site: "not a site", cid: "c5" });
    expect((await a.until(reply("c5"))).type).toBe("command.error");

    a.send({ type: "browser.loggedin.list", cid: "c6" });
    await a.until(reply("c6"));
    expect(a.frames.filter((m) => m.type === "browser.loggedin").at(-1).sites.map((s: any) => [s.site, s.unlocked])).toEqual([["bank.test", true]]);
    a.send({ type: "browser.loggedin.remove", site: "bank.test", cid: "c7" });
    expect((await a.until(reply("c7"))).type).toBe("ack");
    await b.until((m) => listIs()(m) && b.frames.indexOf(m) > b.frames.findIndex(listIs(["bank.test", true])));

    // (`browser.open_agent_browser` is NOT sent to this daemon: with the feature on it would start a real
    // Chrome window here. Its dispatch is shown below on the daemon with the feature off, and its
    // behaviour — with a fake launcher — in "what makes a site logged-in" above.)
    a.send({ type: "human.request.respond", requestId: "human_nope", cid: "c9" });
    expect(await a.until(reply("c9"))).toMatchObject({ type: "command.error", message: expect.stringMatching(/no pending request for a person/) });

    // Feature off: no event on connect, every command refused, the routes answer 404.
    const off = boot(dir(), ["mcp-integrations"]);
    const c = client(off.port);
    await c.until((m) => m.type === "server.hello");
    for (const [i, cmd] of [{ type: "browser.loggedin.list" }, { type: "browser.loggedin.add", site: "a.test" }, { type: "browser.loggedin.set_unlocked", site: "a.test", unlocked: true }, { type: "browser.open_agent_browser" }].entries()) {
      c.send({ ...cmd, cid: `o${i}` });
      expect(await c.until(reply(`o${i}`))).toMatchObject({ type: "command.error", message: expect.stringMatching(/not enabled/) });
    }
    expect(c.frames.some((m) => m.type === "browser.loggedin")).toBe(false);
    expect((await post(off.port, "/api/browser/loggedin/sync", { hubServerId: "x", sites: [] })).status).toBe(404);
    expect((await post(off.port, "/api/browser/loggedin/op", { from: "x", ops: [] })).status).toBe(404);
    for (const x of [a, b, c]) x.close();
  });

  test("[C3] two real daemons: a site listed and unlocked on the hub reaches the member's clients, and an unlock on the member reaches the hub's — over the real sync routes, which refuse an unknown hub or member, a foreign origin and a non-JSON body", async () => {
    const [hubDir, memberDir] = [dir(), dir()];
    const hubId = loadServerIdentity(hubDir).serverId;
    const memberId = loadServerIdentity(memberDir).serverId;
    writeFileSync(join(memberDir, "pairing.json"), JSON.stringify({ hubServerId: hubId, at: "2026-11-19T00:00:00.000Z" }));
    const member = boot(memberDir, ["mcp-integrations", "browser"]);
    writeFileSync(join(hubDir, "fleet.json"), JSON.stringify({ members: [{ serverId: memberId, serverName: "m1", host: "127.0.0.1", url: `http://127.0.0.1:${member.port}/` }] }));
    let hub!: ServerHandle;
    hub = boot(hubDir, ["mcp-integrations", "browser"], () => `http://127.0.0.1:${hub.port}`);
    const onHub = client(hub.port);
    const onMember = client(member.port);
    await onHub.until(listIs());
    await onMember.until(listIs());

    onHub.send({ type: "browser.loggedin.add", site: "shop.test", cid: "h1" });
    expect((await onHub.until(reply("h1"))).type).toBe("ack");
    await onMember.until(listIs(["shop.test", false]));
    onHub.send({ type: "browser.loggedin.set_unlocked", site: "shop.test", unlocked: true, cid: "h2" });
    await onMember.until(listIs(["shop.test", true]));
    onHub.send({ type: "browser.loggedin.set_unlocked", site: "shop.test", unlocked: false, cid: "h3" });
    await onMember.until((m) => listIs(["shop.test", false])(m) && onMember.frames.indexOf(m) > onMember.frames.findIndex(listIs(["shop.test", true])));

    // Member → hub.
    onMember.send({ type: "browser.loggedin.set_unlocked", site: "shop.test", unlocked: true, cid: "m1" });
    expect((await onMember.until(reply("m1"))).type).toBe("ack");
    await onHub.until((m) => listIs(["shop.test", true])(m) && onHub.frames.indexOf(m) > onHub.frames.findIndex(listIs(["shop.test", false])));

    // The routes' gates.
    const evil = [{ site: "evil.test", source: "owner", unlocked: true, addedAt: 1 }];
    expect((await post(member.port, "/api/browser/loggedin/sync", { hubServerId: "srv_someone_else", sites: evil })).status).toBe(403);
    expect((await post(hub.port, "/api/browser/loggedin/op", { from: "srv_not_a_member", ops: [{ op: "unlock", site: "shop.test" }] })).status).toBe(403);
    expect((await post(hub.port, "/api/browser/loggedin/sync", { hubServerId: hubId, sites: evil })).status).toBe(403); // the hub is nobody's member
    expect((await post(hub.port, "/api/browser/loggedin/op", { from: memberId, ops: [{ op: "unlock", site: "shop.test" }] }, { "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect((await post(hub.port, "/api/browser/loggedin/op", { from: memberId, ops: [{ op: "add", site: "evil.test", source: "owner" }] }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(member.port, "/api/browser/loggedin/sync", { hubServerId: hubId, sites: evil }, {})).status).toBe(415);
    onHub.send({ type: "browser.loggedin.list", cid: "h9" });
    await onHub.until(reply("h9"));
    expect(onHub.frames.filter((m) => m.type === "browser.loggedin").at(-1).sites.map((s: any) => s.site)).toEqual(["shop.test"]);
    onHub.close();
    onMember.close();
  });
});
