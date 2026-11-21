/**
 * [C3] The fixes for the Phase C3 review (decision log: C3 veto). Real Supervisor, real gate, real
 * permission hook and real per-session proxies; the browser's network traffic is reported to the
 * service exactly as the proxy reports it (`onSessionDecision`). Nothing here starts a browser.
 * test/real/browser-c3-review.test.ts repeats item 1 against real Chrome.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpIntegration } from "@protocol";
import { buildFileOffer } from "../../src/agent/file-offer";
import { BROWSER_LOGGEDIN_FILE, LoggedInSitesService, defaultLauncherRefusal, runOwnerBrowser } from "../../src/browser/loggedin";
import { PROFILE_UNKNOWN_SITE } from "../../src/browser/gate";
import { browserProfileDir } from "../../src/browser/preset";
import { resolveRealNode } from "../../src/browser/service";
import { WorkUnitStore } from "../../src/integrations/workunit";
import type { Session } from "../../src/session/session";
import { addCookies } from "../helpers/cookies";
import { addBrowser, browserHook, browserOf, browserRig, browserSession, feedResult, pageResult, startBrowser } from "../helpers/browser";
import { isPending, parked, settle, type McpRig } from "../helpers/mcp";

let rig: McpRig;
let integration: McpIntegration;
let worktree: string;
const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

beforeEach(async () => {
  rig = browserRig();
  integration = await addBrowser(rig);
  worktree = tmp("anvil-c3r-wt-");
  mkdirSync(join(worktree, ".git", "info"), { recursive: true });
});
afterEach(async () => {
  await rig.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The proxy saw the session's browser connect to `host` (allowed or refused). */
/** The headless fallback (a throwaway profile), where the sticky set is exactly the traffic the proxy
 *  saw; in headed mode every locked logged-in site counts from the start (fix-c-final, below). */
async function headless(): Promise<void> {
  await rig.cleanup();
  rig = browserRig({ desktop: false });
  integration = await addBrowser(rig);
}
const contact = (s: Session, host: string, port = 443, allowed = true): void => browserOf(rig).proxies.onSessionDecision!(s.id, { kind: "connect", host, port, allowed });
/** A navigation that lands on `url`, with the traffic its page load made (as a real one would). */
async function land(s: Session, url: string, loads: string[] = []): Promise<void> {
  const v = await browserHook(rig, s, "browser_navigate", { url });
  expect(v.decision).toBe("allow");
  contact(s, new URL(url).hostname);
  for (const h of loads) contact(s, h);
  feedResult(rig, s, "browser_navigate", pageResult(url), { url });
}
const allow = (s: Session, ...sites: string[]): void => {
  for (const x of sites) browserOf(rig).gate.state(s.id).once.add(x);
};
const shotResult = (s: Session): void => rig.sup.mcp.gate.onToolResult(s, "browser", { tool: "browser_take_screenshot", input: {}, content: [{ type: "text", text: "### Result\nTook a screenshot" }, { type: "image", data: Buffer.from("\x89PNG\r\n\x1a\nreal").toString("base64"), mimeType: "image/png" }], isError: false });

describe("item 1: a page that moves by itself", () => {
  test("[C3] review 1: after the result, traffic to a locked logged-in site makes the page unknown — a key press or a click is refused with 'take a snapshot first', under bypass; the snapshot then applies the hard stop on that site", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "shop.test", "bank.test");
    browserOf(rig).loggedIn.add("bank.test", "owner"); // listed, locked
    await land(s, "https://shop.test/");
    feedResult(rig, s, "browser_snapshot", pageResult("https://shop.test/"));
    // The page's own timer sends it to the bank: the browser connects there, no tool call is involved.
    contact(s, "www.bank.test");
    for (const [tool, input] of [["browser_press_key", { key: "Enter" }], ["browser_click", { target: "#pay" }], ["browser_type", { target: "e1", text: "x" }], ["browser_navigate", { url: "https://shop.test/other" }]] as const) {
      const v = await browserHook(rig, s, tool, input);
      expect([tool, v.decision]).toEqual([tool, "deny"]);
      expect(v.reason).toMatch(/page may have changed by itself.*bank\.test \(a locked logged-in site\).*browser_snapshot/);
    }
    expect(browserOf(rig).gate.state(s.id).unknown).toBe("traffic");
    // Reads still run; the way out always does.
    expect((await browserHook(rig, s, "browser_take_screenshot")).decision).toBe("allow");
    expect((await browserHook(rig, s, "browser_close")).decision).toBe("allow");
    expect((await browserHook(rig, s, "browser_snapshot")).decision).toBe("allow");
    feedResult(rig, s, "browser_snapshot", pageResult("https://www.bank.test/pay"));
    // Now the page is known to be on the locked bank: the press is a hard stop (it needs a fresh screenshot first).
    const press = await browserHook(rig, s, "browser_press_key", { key: "Enter" });
    expect(press).toMatchObject({ decision: "deny", reason: expect.stringMatching(/needs the owner's approval.*browser_take_screenshot/) });
    shotResult(s);
    const gated = browserHook(rig, s, "browser_press_key", { key: "Enter" });
    expect(await isPending(gated)).toBe(true);
    expect((parked(s) as { reason?: string }).reason).toMatch(/bank\.test/);
    rig.sup.resolvePermission(parked(s).requestId, "deny");
    expect((await gated).decision).toBe("deny");
  });

  test("[C3] review 1: traffic to a site not allowed in this session also makes the page unknown; traffic only to the page's own site does not, nor does traffic that came before the result", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "shop.test");
    await land(s, "https://shop.test/", ["cdn.other.test"]); // before the result: part of the page
    contact(s, "img.shop.test");
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).decision).toBe("allow");
    feedResult(rig, s, "browser_click", pageResult("https://shop.test/"), { target: "e1" });
    contact(s, "elsewhere.test", 443, false); // even a refused connection counts
    const v = await browserHook(rig, s, "browser_click", { target: "e1" });
    expect(v).toMatchObject({ decision: "deny", reason: expect.stringMatching(/elsewhere\.test \(not allowed in this session\)/) });
    feedResult(rig, s, "browser_snapshot", pageResult("https://shop.test/"));
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).decision).toBe("allow");
  });

  test("[C3] review 4: a locked logged-in site contacted since the navigation to the current page (a frame from it) makes input on that page a hard stop naming it; reads and navigations are not stopped; a new page does not clear it, nor does about:blank; a browser_close that ended the (headless) browser does", async () => {
    await headless();
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "shop.test", "bank.test", "news.test");
    browserOf(rig).loggedIn.add("bank.test", "owner");
    await land(s, "https://shop.test/embed", ["bank.test"]); // the page loads a frame from the bank
    expect((await browserHook(rig, s, "browser_snapshot")).decision).toBe("allow");
    const click = await browserHook(rig, s, "browser_click", { target: "e1" });
    expect(click).toMatchObject({ decision: "deny", reason: expect.stringMatching(/shop\.test that has loaded bank\.test, a logged-in site.*browser_take_screenshot/) });
    shotResult(s);
    const gated = browserHook(rig, s, "browser_click", { target: "e1" });
    expect(await isPending(gated)).toBe(true);
    expect(parked(s).suggestions.map((x) => x.label)).toEqual(["Allow once", "Unlock bank.test", "Deny"]);
    rig.sup.resolvePermission(parked(s).requestId, "deny");
    await gated;
    // Sticky (fix-round re-review): a new page does NOT clear it — the frame may still be there…
    expect((await browserHook(rig, s, "browser_navigate", { url: "https://news.test/" })).decision).toBe("allow");
    contact(s, "news.test");
    feedResult(rig, s, "browser_navigate", pageResult("https://news.test/"), { url: "https://news.test/" });
    expect(await browserHook(rig, s, "browser_click", { target: "e1" })).toMatchObject({ decision: "deny", reason: expect.stringMatching(/has loaded bank\.test/) });
    // …nor does about:blank (fix-c-final: a fresh load of the framing page can show the frame again
    // from Chrome's cache or over a tunnel it holds, with no traffic)…
    expect((await browserHook(rig, s, "browser_navigate", { url: "about:blank" })).decision).toBe("allow");
    feedResult(rig, s, "browser_navigate", pageResult("about:blank"), { url: "about:blank" });
    await land(s, "https://news.test/");
    expect(await browserHook(rig, s, "browser_click", { target: "e1" })).toMatchObject({ decision: "deny", reason: expect.stringMatching(/has loaded bank\.test/) });
    // …only a browser_close after which no process of the browser is left.
    feedResult(rig, s, "browser_close", "### Result\nNo open tabs.");
    await land(s, "https://news.test/");
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).decision).toBe("allow");
  });

  test("[C3] review 6: browser_close is allowed in every state — unknown, held, closing, and on a locked logged-in site", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "prompt-all" });
    const close = async () => (await browserHook(rig, s, "browser_close")).decision;
    browserOf(rig).gate.state(s.id).unknown = "navigation";
    expect(await close()).toBe("allow");
    browserOf(rig).gate.state(s.id).unknown = undefined;
    browserOf(rig).gate.state(s.id).hold = { kind: "ambiguous" };
    expect(await close()).toBe("allow");
    browserOf(rig).gate.state(s.id).hold = undefined;
    browserOf(rig).gate.state(s.id).closing = { reason: "x" };
    expect(await close()).toBe("allow");
    browserOf(rig).gate.state(s.id).closing = undefined;
    allow(s, "bank.test");
    browserOf(rig).loggedIn.add("bank.test", "owner");
    feedResult(rig, s, "browser_snapshot", pageResult("https://bank.test/"));
    expect(await close()).toBe("allow");
    expect(s.pendingPermissions.size).toBe(0);
  });
});

describe("fix-round re-review: the embedded locked-site set is sticky", () => {
  const tabsText = (cur: number, urls: string[]) => `### Result\n${urls.map((u, i) => `- ${i}: ${i === cur ? "(current) " : ""}[T](${u})`).join("\n")}\n### Page\n- Page URL: ${urls[cur]}\n- Page Title: T`;
  const stopped = async (s: Session, tool = "browser_click", input: Record<string, unknown> = { target: "f1e2" }) => {
    const v = await browserHook(rig, s, tool, input);
    expect([tool, v.decision]).toEqual([tool, "deny"]);
    expect(v.reason).toMatch(/has loaded bank\.test/);
  };

  test("[C3] re-review: pushState, a #fragment navigation, a new tab then select back, and going back all keep the locked frame's site — input stays a hard stop and browser_evaluate is refused; an unlocked site does not stop; about:blank does not clear it (in one tab or all), a browser_close that ended the (headless) browser does", async () => {
    await headless();
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "shop.test", "bank.test");
    browserOf(rig).loggedIn.add("bank.test", "owner");
    await land(s, "https://shop.test/embed", ["bank.test"]);
    await stopped(s);
    // The page moves its own address (history.pushState): no navigation, no traffic.
    feedResult(rig, s, "browser_snapshot", pageResult("https://shop.test/embed/moved"));
    await stopped(s);
    await stopped(s, "browser_type", { target: "f1e2", text: "x" });
    expect(await browserHook(rig, s, "browser_evaluate", { function: "(el) => el.click()", target: "f1e2" })).toMatchObject({ decision: "deny", reason: expect.stringMatching(/not allowed on a page that has loaded bank\.test/) });
    // A same-document navigation the agent makes.
    expect((await browserHook(rig, s, "browser_navigate", { url: "https://shop.test/embed#x" })).decision).toBe("allow");
    feedResult(rig, s, "browser_navigate", pageResult("https://shop.test/embed#x"), { url: "https://shop.test/embed#x" });
    await stopped(s);
    // A new tab (about:blank while the first tab still shows the page), then back to the first tab.
    expect((await browserHook(rig, s, "browser_tabs", { action: "new" })).decision).toBe("allow");
    feedResult(rig, s, "browser_tabs", tabsText(1, ["https://shop.test/embed#x", "about:blank"]), { action: "new" });
    expect(browserOf(rig).gate.state(s.id).contacted?.has("bank.test")).toBe(true);
    feedResult(rig, s, "browser_tabs", tabsText(1, ["https://shop.test/embed#x", "about:blank"]), { action: "list" });
    expect((await browserHook(rig, s, "browser_tabs", { action: "select", index: 0 })).decision).toBe("allow");
    feedResult(rig, s, "browser_tabs", tabsText(0, ["https://shop.test/embed#x", "about:blank"]), { action: "select", index: 0 });
    await stopped(s);
    // Away and back (the back/forward cache: no traffic at all).
    await land(s, "https://shop.test/plain");
    expect((await browserHook(rig, s, "browser_navigate_back")).decision).toBe("allow");
    feedResult(rig, s, "browser_navigate_back", pageResult("https://shop.test/embed#x"));
    await stopped(s);
    // Unlocked (decision 44): no hard stop for it.
    browserOf(rig).loggedIn.setUnlocked("bank.test", true);
    feedResult(rig, s, "browser_snapshot", pageResult("https://shop.test/embed#x"));
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).decision).toBe("allow");
    browserOf(rig).loggedIn.setUnlocked("bank.test", false);
    feedResult(rig, s, "browser_snapshot", pageResult("https://shop.test/embed#x"));
    await stopped(s);
    // about:blank in one tab while the other still shows a page does not clear it…
    expect((await browserHook(rig, s, "browser_navigate", { url: "about:blank" })).decision).toBe("allow");
    feedResult(rig, s, "browser_navigate", `### Open tabs\n- 0: (current) [B](about:blank)\n- 1: [T](https://shop.test/plain)\n### Page\n- Page URL: about:blank\n- Page Title: `, { url: "about:blank" });
    expect(browserOf(rig).gate.state(s.id).contacted?.has("bank.test")).toBe(true);
    // …nor does about:blank with every tab blank (fix-c-final: the same Chrome process can show the frame
    // again from its HTTP cache or over a tunnel it already holds, with no traffic at all)…
    feedResult(rig, s, "browser_tabs", `### Result\n- 0: (current) [B](about:blank)\n- 1: [B](about:blank)\n### Page\n- Page URL: about:blank\n- Page Title: `, { action: "list" });
    expect(browserOf(rig).gate.state(s.id).contacted?.has("bank.test")).toBe(true);
    await land(s, "https://shop.test/embed"); // a fresh navigate, no traffic to the bank (served from cache)
    await stopped(s);
    expect((await browserHook(rig, s, "browser_navigate_back")).decision).toBe("allow");
    feedResult(rig, s, "browser_navigate_back", pageResult("https://shop.test/plain"));
    await stopped(s);
    // …only browser_close, once the service has confirmed no process of that browser is left.
    feedResult(rig, s, "browser_close", "### Result\nNo open tabs.");
    expect(browserOf(rig).gate.state(s.id).contacted?.size ?? 0).toBe(0);
    await land(s, "https://shop.test/plain");
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).decision).toBe("allow");
  });

  test("[C3] fix-c-final: browser_close clears the set only when no process of the browser is left — a process still holding the session's proxy, or a process list that cannot be read, keeps it; and only in headless mode", async () => {
    await rig.cleanup();
    let ps: string | undefined = "";
    rig = browserRig({ desktop: false, browser: { processList: () => ps } });
    integration = await addBrowser(rig);
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "shop.test", "bank.test");
    browserOf(rig).loggedIn.add("bank.test", "owner");
    const port = browserOf(rig).proxies.get(s.id)!.port;
    const chrome = (p: number) => `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --proxy-server=http://127.0.0.1:${p} --user-data-dir=/tmp/x\n`;
    // Still running (or a list that cannot be read): the set stays.
    for (const still of [chrome(port), undefined]) {
      await land(s, "https://shop.test/embed", ["bank.test"]);
      ps = still;
      const t = Date.now();
      feedResult(rig, s, "browser_close", "### Result\nNo open tabs.");
      expect(Date.now() - t).toBeLessThan(3000); // it asks a few times, then gives up (fail closed)
      expect([still === undefined ? "unreadable" : "running", browserOf(rig).gate.state(s.id).contacted?.has("bank.test")]).toEqual([still === undefined ? "unreadable" : "running", true]);
      await land(s, "https://shop.test/plain");
      await stopped(s);
    }
    // Another session's browser (another proxy port — even one whose number starts with this one) is not this one.
    ps = `${chrome(Number(`${port}9`))}${chrome(port + 1)}`;
    feedResult(rig, s, "browser_close", "### Result\nNo open tabs.");
    expect(browserOf(rig).gate.state(s.id).contacted?.size ?? 0).toBe(0);
    await land(s, "https://shop.test/plain");
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).decision).toBe("allow");
  });

  test("[C3] fix-c-final (headed): every locked logged-in site counts as loaded from the first call of every launch, with no traffic — a click on a page that never touched it is a hard stop saying the profile holds it, and browser_evaluate is refused; about:blank, browser_close and a rebuilt browser do not end it; unlocking does", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "shop.test");
    browserOf(rig).loggedIn.add("bank.test", "owner");
    const fresh = async () => {
      await land(s, "https://shop.test/plain"); // no traffic to bank.test at all
      expect(browserOf(rig).gate.state(s.id).contacted?.has("bank.test") ?? false).toBe(false);
      const v = await browserHook(rig, s, "browser_click", { target: "e1" });
      expect(v).toMatchObject({ decision: "deny", reason: expect.stringMatching(/^click on shop\.test in the headed agent browser, whose profile holds bank\.test, a logged-in site: a frame of it can load from the profile with no network traffic.*browser_take_screenshot/) });
      expect(await browserHook(rig, s, "browser_evaluate", { function: "() => 1" })).toMatchObject({ decision: "deny", reason: expect.stringMatching(/not allowed on the agent profile, which holds bank\.test/) });
    };
    await fresh();
    shotResult(s);
    const gated = browserHook(rig, s, "browser_type", { target: "e1", text: "x" });
    expect(await isPending(gated)).toBe(true);
    expect(parked(s).suggestions.map((x) => x.label)).toEqual(["Allow once", "Unlock bank.test", "Deny"]);
    rig.sup.resolvePermission(parked(s).requestId, "deny");
    await gated;
    // Uploads name it too (an upload is always its own once-prompt).
    writeFileSync(join(worktree, "a.txt"), "x");
    await land(s, "https://shop.test/plain");
    const upload = { session: s, integration, tool: "browser_file_upload", fullTool: "mcp__browser__browser_file_upload", input: { paths: [join(worktree, "a.txt")] }, cwd: s.data.cwd };
    expect(browserOf(rig).gate.gate(upload)).toMatchObject({ kind: "prompt", reason: expect.stringMatching(/^upload .*a\.txt to shop\.test; this is the agent profile, which holds bank\.test .*so a frame from it may receive the file$/), suggestions: [{ label: "Allow once" }, { label: "Deny" }] });
    // Not ended by about:blank, by browser_close (the persistent profile stays), or by a new launch.
    feedResult(rig, s, "browser_navigate", pageResult("about:blank"), { url: "about:blank" });
    await fresh();
    feedResult(rig, s, "browser_close", "### Result\nNo open tabs.");
    await fresh();
    startBrowser(rig, s);
    await fresh();
    // A site logged in later counts at once (looked up live); unlocking every one ends it.
    browserOf(rig).loggedIn.add("mail.test", "owner");
    await land(s, "https://shop.test/plain");
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).reason).toMatch(/profile holds bank\.test.*its profile also holds mail\.test/);
    browserOf(rig).loggedIn.setUnlocked("bank.test", true);
    browserOf(rig).loggedIn.setUnlocked("mail.test", true);
    await land(s, "https://shop.test/plain");
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).decision).toBe("allow");
    expect((await browserHook(rig, s, "browser_evaluate", { function: "() => 1" })).reason).toMatch(/only allowed on this session's own throwaway test daemon/);
  });

  test("[C3] fix-c-final: the locked sites the headed browser starts with — the list's locked sites; with a damaged list every site the profile has cookies for, or (cookies unreadable) an unknown-sites marker, named by the gate", async () => {
    const dir = tmp("anvil-c3r-ls-");
    const svc = new LoggedInSitesService({ stateDir: dir, broadcast: () => {}, intervalMs: 0 });
    svc.add("bank.test", "owner");
    svc.add("mail.test", "owner");
    svc.setUnlocked("mail.test", true);
    expect(svc.lockedSites()).toEqual(["bank.test"]);
    svc.stop();
    writeFileSync(join(dir, BROWSER_LOGGEDIN_FILE), "{ damaged");
    const damaged = new LoggedInSitesService({ stateDir: dir, broadcast: () => {}, intervalMs: 0 });
    expect(damaged.lockedSites()).toEqual([]); // a profile with no cookie database holds no logins
    damaged.stop();
    mkdirSync(join(browserProfileDir(dir), "Default"), { recursive: true });
    writeFileSync(join(browserProfileDir(dir), "Default", "Cookies"), "not a database");
    const unreadable = new LoggedInSitesService({ stateDir: dir, broadcast: () => {}, intervalMs: 0 });
    expect(unreadable.lockedSites()).toEqual([PROFILE_UNKNOWN_SITE]);
    unreadable.stop();
    rmSync(join(browserProfileDir(dir), "Default", "Cookies"));
    addCookies(browserProfileDir(dir), [[".bank.test", "sid"], ["shop.test", "c"]]);
    const withCookies = new LoggedInSitesService({ stateDir: dir, broadcast: () => {}, intervalMs: 0 });
    expect(withCookies.lockedSites().sort()).toEqual(["bank.test", "shop.test"]);
    withCookies.stop();
    // Through the gate: every site counts as locked then (the page's own too), and the marker is named.
    await rig.cleanup();
    const stateDir = tmp("anvil-c3r-state-");
    writeFileSync(join(stateDir, BROWSER_LOGGEDIN_FILE), "not json");
    mkdirSync(join(browserProfileDir(stateDir), "Default"), { recursive: true });
    writeFileSync(join(browserProfileDir(stateDir), "Default", "Cookies"), "not a database");
    rig = browserRig({ stateDir });
    integration = await addBrowser(rig);
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "shop.test");
    await land(s, "https://shop.test/plain");
    shotResult(s);
    const gated = browserHook(rig, s, "browser_click", { target: "e1" });
    expect(await isPending(gated)).toBe(true);
    expect((parked(s) as { reason?: string }).reason).toBe("click on shop.test, a logged-in site");
    rig.sup.resolvePermission(parked(s).requestId, "deny");
    await gated;
    expect(await browserHook(rig, s, "browser_evaluate", { function: "() => 1" })).toMatchObject({ decision: "deny", reason: expect.stringContaining(`the agent profile, which holds ${PROFILE_UNKNOWN_SITE}`) });
  });
});

describe("item 2: the card's picture", () => {
  test("[C3] review 2: a PNG planted in .anvil-browser and named in browser_find's text never becomes the card image; neither does a file a take_screenshot result links that was there before the call", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "bank.test");
    browserOf(rig).loggedIn.add("bank.test", "owner");
    await land(s, "https://bank.test/");
    const planted = join(worktree, ".anvil-browser", "benign.png");
    writeFileSync(planted, "\x89PNG\r\n\x1a\nplanted");
    // The repro: a read whose (page-controlled) text names the planted file.
    expect((await browserHook(rig, s, "browser_find", { text: planted })).decision).toBe("allow");
    feedResult(rig, s, "browser_find", `### Result\nNo match for ${planted}\n- [found](${planted})`, { text: planted });
    expect(browserOf(rig).screenshot(s.id, true)).toBeUndefined();
    const click = await browserHook(rig, s, "browser_click", { target: "e1" });
    expect(click).toMatchObject({ decision: "deny", reason: expect.stringMatching(/browser_take_screenshot first/) });
    // A take_screenshot result that only links the planted (older) file: still nothing.
    utimesSync(planted, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect((await browserHook(rig, s, "browser_take_screenshot")).decision).toBe("allow");
    rig.sup.mcp.gate.onToolResult(s, "browser", { tool: "browser_take_screenshot", input: {}, content: [{ type: "text", text: `### Result\n- [Screenshot of viewport](${planted})` }], isError: false });
    expect(browserOf(rig).screenshot(s.id, true)).toBeUndefined();
    // Since the C4 review not even a file the server writes during the call is used: only an inline image.
    const fresh = join(worktree, ".anvil-browser", "page-2026-11-19T10-00-00-000Z.png");
    expect((await browserHook(rig, s, "browser_take_screenshot")).decision).toBe("allow");
    writeFileSync(fresh, "\x89PNG\r\n\x1a\nfresh");
    rig.sup.mcp.gate.onToolResult(s, "browser", { tool: "browser_take_screenshot", input: {}, content: [{ type: "text", text: `### Result\n- [Screenshot of viewport](${fresh})` }], isError: false });
    expect(browserOf(rig).screenshot(s.id, true)).toBeUndefined();
    shotResult(s);
    const img = browserOf(rig).screenshot(s.id, true)!;
    expect(img).toBeDefined();
    expect(readFileSync(rig.sup.attachmentBytes(s.id, img.attachmentId)!.path, "latin1")).toContain("real");
  });

  test("[C3] review 2: the screenshot goes stale after an input call and when the browser contacts another site after it was taken", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "bank.test");
    await land(s, "https://bank.test/");
    shotResult(s);
    expect(browserOf(rig).screenshot(s.id, true)).toBeDefined();
    contact(s, "bank.test"); // its own site: still current
    expect(browserOf(rig).screenshot(s.id, true)).toBeDefined();
    contact(s, "tracker.test");
    expect(browserOf(rig).screenshot(s.id, true)).toBeUndefined();
    shotResult(s);
    expect(browserOf(rig).screenshot(s.id, true)).toBeDefined();
    feedResult(rig, s, "browser_click", pageResult("https://bank.test/"), { target: "e1" });
    expect(browserOf(rig).screenshot(s.id, true)).toBeUndefined();
  });
});

describe("item 3: hand-off in an autopilot unit", () => {
  test("[C3] review 3: request_human in a builder session with a work unit marks that unit blocked with 'needs a human: <reason>'", async () => {
    const units = (rig.sup as unknown as { autopilot: { workUnits: WorkUnitStore } }).autopilot.workUnits;
    const unit = units.create({ environmentId: "env_1", todoistProjectId: "p", taskIds: ["t1"], title: "Order parts", status: "building" });
    const builder = await rig.session({ cwd: worktree, workUnitRole: "builder", workUnitId: unit.id } as never);
    const { humanTools } = await import("../../src/agent/human-tools");
    const out = (await humanTools(rig.sup.human, builder)[0]!.handler({ reason: "CAPTCHA on the supplier's site" }, {} as never)) as { isError?: boolean };
    expect(out.isError).toBe(true);
    expect(units.get(unit.id)).toMatchObject({ status: "blocked", blockedReason: "needs a human: CAPTCHA on the supplier's site" });
  });
});

describe("item 4: the output folder", () => {
  test("[C3] review 4: a symlinked .anvil-browser is never swept (nothing outside the worktree is moved, deleted or chmod-ed), the owner is told, and the browser is not started for that worktree", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree });
    const outside = tmp("anvil-c3r-outside-");
    writeFileSync(join(outside, "keep.step"), "outside data");
    writeFileSync(join(outside, "tool.dmg"), "outside binary");
    chmodSync(join(outside, "keep.step"), 0o644);
    rmSync(join(worktree, ".anvil-browser"), { recursive: true, force: true });
    symlinkSync(outside, join(worktree, ".anvil-browser"));
    rig.sup.mcp.gate.onTurnEnd(s);
    expect(readFileSync(join(outside, "keep.step"), "utf8")).toBe("outside data");
    expect(existsSync(join(outside, "tool.dmg"))).toBe(true);
    expect(statSync(join(outside, "keep.step")).mode & 0o777).toBe(0o644);
    expect(existsSync(join(worktree, ".anvil-downloads", "keep.step"))).toBe(false);
    expect(JSON.stringify(rig.sup.resume(s.id))).toMatch(/download sweep was refused.*symbolic link/);
    // A new browser for that worktree is refused.
    const s2 = await rig.session({ cwd: worktree });
    rig.sup.setSessionMcpIntegrations(s2.id, [integration.id]);
    await settle();
    expect(startBrowser(rig, s2)).toBeUndefined();
    expect(JSON.stringify(rig.sup.resume(s2.id))).toMatch(/symbolic link/);
  });

  test("[C3] review 4: a hard-linked file in the output folder is reported and left alone — not chmod-ed, moved or deleted", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree });
    const outside = tmp("anvil-c3r-hl-");
    writeFileSync(join(outside, "secret.step"), "outside data");
    chmodSync(join(outside, "secret.step"), 0o644);
    linkSync(join(outside, "secret.step"), join(worktree, ".anvil-browser", "secret.step"));
    rig.sup.mcp.gate.onTurnEnd(s);
    expect(statSync(join(outside, "secret.step")).mode & 0o777).toBe(0o644);
    expect(statSync(join(outside, "secret.step")).nlink).toBe(2);
    expect(existsSync(join(worktree, ".anvil-downloads", "secret.step"))).toBe(false);
    expect(JSON.stringify(rig.sup.resume(s.id))).toMatch(/was not touched: it has another name elsewhere on disk/);
  });
});

describe("item 5: a damaged logged-in list", () => {
  test("[C3] review 5: a corrupt browser-loggedin.json fails closed — every site the profile has cookies for is a locked logged-in site, the event carries an error, the hub pushes nothing and refuses members' ops, and 'Start a new list' ends it", async () => {
    const dir = tmp("anvil-c3r-li-");
    addCookies(browserProfileDir(dir), [[".bank.test", "sid"]]);
    writeFileSync(join(dir, BROWSER_LOGGEDIN_FILE), "{ damaged");
    const sent: any[] = [];
    const posts: string[] = [];
    const svc = new LoggedInSitesService({ stateDir: dir, broadcast: (e) => void sent.push(e), intervalMs: 0, fetchImpl: (async (u: string) => (posts.push(String(u)), Response.json({ ok: true }))) as never });
    svc.setFleet({ selfServerId: "srv_hub", members: () => [{ url: "http://member.test:7701", host: "member.test", serverId: "srv_m" }], pairedHubId: () => null, selfUrl: async () => "http://hub.test:7701" });
    await svc.syncNow();
    expect(svc.isLocked("bank.test")).toBe(true);
    expect(svc.isLoggedIn("bank.test")).toBe(true);
    expect(svc.isUnlocked("bank.test")).toBe(false);
    expect(svc.isLocked("plain.test")).toBe(false); // no cookies there
    expect(svc.event()).toMatchObject({ sites: [], error: expect.stringMatching(/damaged/) });
    expect(posts).toEqual([]); // never pushed
    expect(svc.receiveOps({ from: "srv_m", ops: [] })).toMatchObject({ ok: false });
    // A restart remembers it.
    expect(new LoggedInSitesService({ stateDir: dir, broadcast: () => {}, intervalMs: 0 }).isLocked("bank.test")).toBe(true);
    svc.reset();
    expect(svc.isLocked("bank.test")).toBe(false);
    expect(svc.event().error).toBeUndefined();
    await svc.syncNow();
    expect(posts.some((u) => u.endsWith("/api/browser/loggedin/sync"))).toBe(true);
    svc.stop();
  });

  test("[C3] review 5: the gate applies it — with a damaged list a click on a profile site is a hard stop", async () => {
    await rig.cleanup();
    const stateDir = tmp("anvil-c3r-state-");
    addCookies(browserProfileDir(stateDir), [[".bank.test", "sid"]]);
    writeFileSync(join(stateDir, BROWSER_LOGGEDIN_FILE), "not json");
    rig = browserRig({ stateDir });
    integration = await addBrowser(rig);
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "bank.test");
    feedResult(rig, s, "browser_snapshot", pageResult("https://bank.test/"));
    expect(await browserHook(rig, s, "browser_click", { target: "e1" })).toMatchObject({ decision: "deny", reason: expect.stringMatching(/needs the owner's approval/) });
  });
});

describe("item 6: small gaps", () => {
  test("[C3] review 6: an updatedInput sent with the answer to a browser prompt is ignored — the call that runs is the one the card showed", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "prompt-all" });
    const asked = browserHook(rig, s, "browser_navigate", { url: "https://new.test/" });
    expect(await isPending(asked)).toBe(true);
    rig.sup.resolvePermission(parked(s).requestId, "allow", { url: "https://evil.test/" });
    const v = await asked;
    expect(v.decision).toBe("allow");
    expect(JSON.stringify(v)).not.toContain("evil.test");
  });

  test("[C3] review 6: the runtime's node is what `node -p process.execPath` prints from a neutral daemon folder, so a .tool-versions planted in the worktree cannot change it", () => {
    const bin = tmp("anvil-c3r-bin-");
    const shim = join(bin, "node");
    // A version-manager-like shim: answers differently when the folder it runs in has a .tool-versions.
    writeFileSync(shim, `#!/bin/sh\nif [ -f .tool-versions ]; then echo /bin/ls; else echo /bin/cat; fi\n`);
    chmodSync(shim, 0o755);
    writeFileSync(join(worktree, ".tool-versions"), "nodejs 99.0.0\n");
    const neutral = join(tmp("anvil-c3r-state2-"), "browser-state");
    const got = resolveRealNode(shim, neutral, { PATH: `${bin}:/usr/bin:/bin`, HOME: neutral, TMPDIR: tmpdir() });
    expect(got).toBe("/bin/cat");
    expect(resolveRealNode(shim, worktree, { PATH: `${bin}:/usr/bin:/bin`, HOME: worktree, TMPDIR: tmpdir() })).toBe("/bin/ls"); // (what running it in the worktree would have done)
  });

  test("[C3] review 6: the file-offer quarantine check compares real paths — a link inside the worktree that points into .anvil-downloads gets no download card", () => {
    mkdirSync(join(worktree, ".anvil-downloads"), { recursive: true });
    writeFileSync(join(worktree, ".anvil-downloads", "part.pdf"), "%PDF");
    symlinkSync(join(worktree, ".anvil-downloads"), join(worktree, "docs"));
    expect(buildFileOffer("s1", worktree, "docs/part.pdf")).toBeNull();
    writeFileSync(join(worktree, "report.pdf"), "%PDF");
    expect(buildFileOffer("s1", worktree, "report.pdf")).not.toBeNull();
  });
});

describe("item 7: test safety", () => {
  test("[C3] review 7: the default 'Open agent browser' launcher refuses under a test runner and for a state folder in the temp folder; a real daemon's folder outside it is not refused", async () => {
    expect(defaultLauncherRefusal(rig.dir)).toMatch(/test runner/);
    expect(defaultLauncherRefusal(rig.dir, {})).toMatch(/temporary folder/);
    expect(defaultLauncherRefusal("/Users/someone/.anvil", {})).toBeUndefined();
    expect(() => runOwnerBrowser({ stateDir: rig.dir, chromePath: "/bin/false", env: {}, onClosed: () => {} })).toThrow(/refused here/);
    // Through the service, with the rig's throwing launcher taken away (the real default is used).
    await rig.cleanup();
    rig = browserRig({ browser: { agentBrowserLauncher: undefined, chromePath: () => "/bin/false" } });
    expect(() => browserOf(rig).openAgentBrowser()).toThrow(/would start a visible Chrome window.*refused here/);
    expect(browserOf(rig).ownerBrowserOpen()).toBe(false);
  });
});
