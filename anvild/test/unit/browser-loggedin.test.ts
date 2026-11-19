/**
 * [C3] Logged-in sites (src/browser/loggedin.ts; agent-cad-and-browser §4.14 items 28, 29 and 44): the
 * list on disk with its unlock switch, the member's queue, the cookie snapshot read from a real
 * SQLite cookie database, and the "Open agent browser" command line and run (fake launcher — Chrome
 * is never started here).
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_BROWSER_FLAG_ALLOW_LIST,
  BROWSER_LOGGEDIN_FILE,
  LoggedInSitesService,
  LoggedInSitesStore,
  agentBrowserArgProblems,
  buildAgentBrowserCommand,
  cookieDbPath,
  readCookieSnapshot,
  runOwnerBrowser,
  sitesThatGainedCookies,
} from "../../src/browser/loggedin";
import { BROWSER_CHROME_ARGS } from "../../src/browser/preset";
import { addCookies, resetCookie } from "../helpers/cookies";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anvil-c3-loggedin-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("LoggedInSitesStore", () => {
  test("[C3] a logged-in site has site, source, unlocked and addedAt; add, unlock, lock and remove persist and reload; a new site starts LOCKED", () => {
    const store = new LoggedInSitesStore(dir, () => 111);
    expect(store.apply({ op: "add", site: "bank.test", source: "owner" })).toBe(true);
    expect(store.apply({ op: "add", site: "shop.test", source: "login-session" })).toBe(true);
    expect(store.list()).toEqual([
      { site: "bank.test", source: "owner", unlocked: false, addedAt: 111 },
      { site: "shop.test", source: "login-session", unlocked: false, addedAt: 111 },
    ]);
    expect(store.apply({ op: "unlock", site: "shop.test" })).toBe(true);
    expect(store.apply({ op: "unlock", site: "shop.test" })).toBe(false); // already
    expect(store.apply({ op: "unlock", site: "nope.test" })).toBe(false); // not a logged-in site: nothing to unlock
    expect(new LoggedInSitesStore(dir).get("shop.test")).toMatchObject({ unlocked: true, source: "login-session" });
    // Adding it again (another login) changes neither its source nor its switch.
    expect(store.apply({ op: "add", site: "shop.test", source: "owner" })).toBe(false);
    expect(store.get("shop.test")).toMatchObject({ unlocked: true, source: "login-session" });
    expect(store.apply({ op: "lock", site: "shop.test" })).toBe(true);
    expect(new LoggedInSitesStore(dir).get("shop.test")!.unlocked).toBe(false);
    expect(store.apply({ op: "remove", site: "bank.test" })).toBe(true);
    expect(new LoggedInSitesStore(dir).list().map((s) => s.site)).toEqual(["shop.test"]);
    expect(JSON.parse(readFileSync(join(dir, BROWSER_LOGGEDIN_FILE), "utf8")).sites).toHaveLength(1);
  });

  test("[C3] a corrupt file unlocks nothing and is kept aside; a hand-edited row unlocks only with the literal true, and a row that is not a site is dropped", () => {
    writeFileSync(join(dir, BROWSER_LOGGEDIN_FILE), "{ not json");
    const damaged = new LoggedInSitesStore(dir, () => 5);
    expect(damaged.list()).toEqual([]); // nothing is UNLOCKED by a damaged file…
    expect(readdirSync(dir).some((f) => f.startsWith(`${BROWSER_LOGGEDIN_FILE}.corrupt-`))).toBe(true);
    // …and the store says it is damaged, so the service fails closed (C3 review, item 5; see
    // browser-c3-review.test.ts) instead of treating "no rows" as "no logged-in sites". A restart keeps that.
    expect(damaged.corrupt()).toMatchObject({ at: 5, reason: expect.stringMatching(/JSON/) });
    expect(new LoggedInSitesStore(dir).corrupt()).toBeDefined();
    rmSync(join(dir, BROWSER_LOGGEDIN_FILE));

    writeFileSync(
      join(dir, BROWSER_LOGGEDIN_FILE),
      JSON.stringify({
        sites: [
          { site: "a.test", source: "owner", unlocked: true, addedAt: 1 },
          { site: "b.test", source: "owner", unlocked: "true", addedAt: 1 },
          { site: "c.test", source: "owner", unlocked: 1, addedAt: 1 },
          { site: "d.test", source: "weird", addedAt: 1 },
          { site: "*", unlocked: true },
          { site: "WWW.Example.com", unlocked: true },
          null,
        ],
      }),
    );
    expect(new LoggedInSitesStore(dir).list()).toEqual([
      { site: "a.test", source: "owner", unlocked: true, addedAt: 1 },
      { site: "b.test", source: "owner", unlocked: false, addedAt: 1 },
      { site: "c.test", source: "owner", unlocked: false, addedAt: 1 },
      { site: "d.test", source: "owner", unlocked: false, addedAt: 1 },
    ]);
  });

  test("[C3] a member's own changes are queued in order, survive the hub's list replacing the local one, and leave the queue when confirmed", () => {
    const store = new LoggedInSitesStore(dir, () => 9);
    store.applyAndQueue({ op: "add", site: "mine.test", source: "login-session" });
    store.applyAndQueue({ op: "unlock", site: "mine.test" });
    store.applyAndQueue({ op: "lock", site: "mine.test" });
    store.applyAndQueue({ op: "unlock", site: "mine.test" }); // the latest word on the switch replaces the earlier ones
    expect(store.pending()).toEqual([{ op: "add", site: "mine.test", source: "login-session", at: 9 }, { op: "unlock", site: "mine.test", at: 9 }]); // stamped with when they were made

    expect(store.replaceFromHub([{ site: "hub.test", source: "owner", unlocked: true, addedAt: 2 }], { serverId: "srv_hub", url: "http://hub:7701" })).toBe(true);
    expect(store.list().map((s) => [s.site, s.unlocked])).toEqual([["hub.test", true], ["mine.test", true]]);
    const again = new LoggedInSitesStore(dir);
    expect(again.pending()).toHaveLength(2);
    expect(again.hub()).toEqual({ serverId: "srv_hub", url: "http://hub:7701" });
    again.confirm(again.pending());
    again.replaceFromHub([{ site: "hub.test", source: "owner", unlocked: false, addedAt: 2 }], { serverId: "srv_hub" });
    expect(again.list()).toEqual([{ site: "hub.test", source: "owner", unlocked: false, addedAt: 2 }]); // the hub is the authority — for the switch too
    // Removing a site drops whatever was queued for it.
    again.applyAndQueue({ op: "unlock", site: "hub.test" });
    again.applyAndQueue({ op: "remove", site: "hub.test" });
    expect(again.pending()).toEqual([{ op: "remove", site: "hub.test", at: expect.any(Number) }]);
  });

  test("[C3] on the authority the later change wins: a queued unlock cannot undo a lock set afterwards, a queued add cannot bring back a site removed afterwards, and a tie leaves the site locked", () => {
    let now = 1_000;
    const hub = new LoggedInSitesStore(dir, () => now);
    hub.apply({ op: "add", site: "bank.test", source: "owner" });
    now = 2_000;
    hub.apply({ op: "unlock", site: "bank.test" });
    now = 5_000;
    hub.apply({ op: "lock", site: "bank.test" }); // the owner switches the unlock off in Settings

    // A member's "unlock", made at t=3000 and delivered only now, is older than the lock: it does nothing.
    now = 6_000;
    expect(hub.apply({ op: "unlock", site: "bank.test", at: 3_000 })).toBe(false);
    expect(hub.get("bank.test")!.unlocked).toBe(false);
    expect(new LoggedInSitesStore(dir, () => now).apply({ op: "unlock", site: "bank.test", at: 4_999 })).toBe(false); // remembered across a restart
    expect(new LoggedInSitesStore(dir, () => now).apply({ op: "unlock", site: "bank.test", at: 5_000 })).toBe(false); // a tie: locked wins
    // An unlock made AFTER the lock does apply, and a lock older than it then does not.
    const again = new LoggedInSitesStore(dir, () => now);
    expect(again.apply({ op: "unlock", site: "bank.test", at: 5_500 })).toBe(true);
    expect(again.apply({ op: "lock", site: "bank.test", at: 5_400 })).toBe(false);
    expect(again.get("bank.test")!.unlocked).toBe(true);
    // The wire shape carries none of the bookkeeping.
    expect(again.list()).toEqual([{ site: "bank.test", source: "owner", unlocked: true, addedAt: 1_000 }]);

    // Removed at t=7000; an add queued at t=6500 does not bring it back (and with it its old unlock); a later add does, locked.
    now = 7_000;
    again.apply({ op: "remove", site: "bank.test" });
    expect(again.apply({ op: "add", site: "bank.test", source: "login-session", at: 6_500 })).toBe(false);
    expect(again.get("bank.test")).toBeUndefined();
    expect(again.apply({ op: "add", site: "bank.test", source: "login-session", at: 7_500 })).toBe(true);
    expect(again.get("bank.test")).toEqual({ site: "bank.test", source: "login-session", unlocked: false, addedAt: 7_500 });
  });
});

describe("LoggedInSitesService", () => {
  test("[C3] list, add, remove and set-unlocked: a site is its registrable domain, each change is broadcast as browser.loggedin, and only a listed site can be unlocked", () => {
    const sent: any[] = [];
    const svc = new LoggedInSitesService({ stateDir: dir, broadcast: (e) => void sent.push(e), clock: () => 7, intervalMs: 0 });
    expect(svc.add("https://www.Bank.test/login")).toBe("bank.test");
    expect(svc.isLoggedIn("bank.test")).toBe(true);
    expect([svc.isLocked("bank.test"), svc.isUnlocked("bank.test")]).toEqual([true, false]);
    expect(() => svc.add("not a site")).toThrow(/enter a site/);
    expect(() => svc.setUnlocked("other.test", true)).toThrow(/not a logged-in site/);
    expect(svc.setUnlocked("login.bank.test", true)).toBe("bank.test");
    expect([svc.isLocked("bank.test"), svc.isUnlocked("bank.test")]).toEqual([false, true]);
    expect(svc.sites()).toEqual(["bank.test"]); // still a logged-in site (the headless rule keys on this)
    svc.setUnlocked("bank.test", false);
    expect(svc.isLocked("bank.test")).toBe(true);
    svc.remove("bank.test");
    expect([svc.isLoggedIn("bank.test"), svc.isLocked("bank.test"), svc.isUnlocked("bank.test")]).toEqual([false, false, false]);
    expect(sent.map((e) => e.type)).toEqual(["browser.loggedin", "browser.loggedin", "browser.loggedin", "browser.loggedin"]);
    expect(sent[1].sites).toEqual([{ site: "bank.test", source: "owner", unlocked: true, addedAt: 7 }]);
    expect(svc.event()).toMatchObject({ type: "browser.loggedin", sites: [] });
    svc.stop();
  });
});

describe("the cookie snapshot", () => {
  const profile = () => join(dir, "browser-profile");

  test("[C3] reads the profile's cookie hosts from a real SQLite cookie database, by registrable domain, without changing the file", () => {
    addCookies(profile(), [[".shop.test", "sid"], ["www.shop.test", "cart"], ["login.bank.co.uk", "auth"], ["127.0.0.1", "x"]]);
    const before = readFileSync(cookieDbPath(profile()));
    const snap = readCookieSnapshot(profile())!;
    expect([...snap.keys()].sort()).toEqual(["127.0.0.1", "bank.co.uk", "shop.test"]);
    expect(snap.get("shop.test")!.size).toBe(2);
    expect(readFileSync(cookieDbPath(profile())).equals(before)).toBe(true); // opened read-only
  });

  test("[C3] a profile with no cookie database has no cookies; a file that is not a database is 'unknown' (tolerated, never thrown)", () => {
    expect(readCookieSnapshot(profile())).toEqual(new Map());
    mkdirSync(join(profile(), "Default"), { recursive: true });
    writeFileSync(cookieDbPath(profile()), "this is not sqlite");
    expect(readCookieSnapshot(profile())).toBeUndefined();
  });

  test("[C3] a site gained cookies when it has a cookie that was not there before — a new site, a new cookie, or one set again; untouched sites did not", () => {
    addCookies(profile(), [[".news.test", "consent"], [".shop.test", "anon"]]);
    const before = readCookieSnapshot(profile());
    expect(sitesThatGainedCookies(before, readCookieSnapshot(profile()))).toEqual([]);
    addCookies(profile(), [[".bank.test", "session"], [".shop.test", "auth"]]); // a first cookie; a second cookie
    expect(sitesThatGainedCookies(before, readCookieSnapshot(profile()))).toEqual(["bank.test", "shop.test"]);
    const mid = readCookieSnapshot(profile());
    resetCookie(profile(), ".news.test", "consent"); // the same cookie, set again by a login
    expect(sitesThatGainedCookies(mid, readCookieSnapshot(profile()))).toEqual(["news.test"]);
    // "Before" unknown (the database could not be read): every site with cookies counts — the safe side.
    expect(sitesThatGainedCookies(undefined, readCookieSnapshot(profile()))).toEqual(["bank.test", "news.test", "shop.test"]);
    expect(sitesThatGainedCookies(before, undefined)).toEqual([]);
  });
});

describe("Open agent browser", () => {
  const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  test("[C3] the command line is the installed Chrome on the agent profile with --password-store=basic and --use-mock-keychain — no proxy, no debugging port, no automation switch", () => {
    const cmd = buildAgentBrowserCommand({ chromePath: CHROME, stateDir: "/state" });
    expect(cmd).toEqual({
      command: CHROME,
      args: ["--user-data-dir=/state/browser-profile", "--password-store=basic", "--use-mock-keychain", "--no-first-run", "--no-default-browser-check"],
      profileDir: "/state/browser-profile",
    });
    expect(agentBrowserArgProblems(cmd.args, "/state")).toEqual([]);
    for (const a of cmd.args) expect(AGENT_BROWSER_FLAG_ALLOW_LIST).toContain(a.split("=")[0]!);
    const joined = cmd.args.join(" ");
    for (const never of ["--proxy-server", "--remote-debugging", "--enable-automation", "--headless", "--user-agent", "--disable-blink-features", "--load-extension", "--no-sandbox", ...BROWSER_CHROME_ARGS.map((a) => a.split("=")[0]!)]) {
      expect([never, joined.includes(never)]).toEqual([never, false]);
    }
  });

  test("[C3] the command-line check refuses anything else: an extra flag, a URL, another profile, a missing or changed password-store", () => {
    const ok = buildAgentBrowserCommand({ chromePath: CHROME, stateDir: "/state" }).args;
    for (const extra of ["--remote-debugging-port=9222", "--proxy-server=http://127.0.0.1:1", "--enable-automation", "--headless=new", "--user-agent=x", "--disable-blink-features=AutomationControlled", "https://example.com/"]) {
      expect([extra, agentBrowserArgProblems([...ok, extra], "/state").length > 0]).toEqual([extra, true]);
    }
    expect(agentBrowserArgProblems(ok.map((a) => (a.startsWith("--user-data-dir") ? "--user-data-dir=/Users/x/Library/Application Support/Google/Chrome" : a)), "/state").join()).toMatch(/agent browser's own folder/);
    expect(agentBrowserArgProblems(ok.filter((a) => a !== "--use-mock-keychain"), "/state").join()).toMatch(/--use-mock-keychain must be passed exactly once/);
    expect(agentBrowserArgProblems(ok.map((a) => (a === "--password-store=basic" ? "--password-store=keychain" : a)), "/state").join()).toMatch(/must be basic/);
    expect(agentBrowserArgProblems(ok, "/other-state").join()).toMatch(/own folder/);
  });

  test("[C3] a run snapshots cookies before launch and after exit and reports the sites that gained cookies; the launcher gets exactly the built command and a clean environment", async () => {
    const profile = join(dir, "browser-profile");
    addCookies(profile, [[".news.test", "consent"]]); // there before the owner's session
    const launches: { command: string; args: string[]; env: Record<string, string> }[] = [];
    let exit!: () => void;
    const closed: string[][] = [];
    const run = runOwnerBrowser({
      stateDir: dir,
      chromePath: CHROME,
      env: { PATH: "/usr/bin", HOME: "/Users/x", TMPDIR: "/tmp" },
      launcher: (command, args, env) => {
        launches.push({ command, args, env });
        return { exited: new Promise<void>((r) => (exit = r)), kill: () => exit() };
      },
      onClosed: (gained) => void closed.push(gained),
    });
    expect(launches).toEqual([{ command: CHROME, args: buildAgentBrowserCommand({ chromePath: CHROME, stateDir: dir }).args, env: { PATH: "/usr/bin", HOME: "/Users/x", TMPDIR: "/tmp" } }]);
    expect(existsSync(profile)).toBe(true);
    expect(closed).toEqual([]); // nothing is decided while it is open
    addCookies(profile, [[".bank.test", "session"]]); // the owner logs in
    exit();
    expect(await run.done).toEqual(["bank.test"]);
    expect(closed).toEqual([["bank.test"]]);
  });
});
