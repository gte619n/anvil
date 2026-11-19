/**
 * [C2] The browser preset's launch line (agent-cad-and-browser §4.14 items 20, 21, 34, 37): the
 * complete argument list in both modes, the closed allow list (the "gamed spec" angle: any flag that
 * is not on the list fails), desktop detection, and the git exclude entry.
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_CHROME_ARGS,
  PLAYWRIGHT_MCP_PACKAGE,
  PLAYWRIGHT_MCP_VERSION,
  PRESET_FLAG_ALLOW_LIST,
  buildBrowserLaunch,
  chooseBrowserMode,
  parseConsoleUser,
  presetArgProblems,
  type BrowserLaunch,
} from "../../src/browser/preset";
import { browserRuntimeManifest } from "../../src/browser/runtime";
import { ensureGitExcluded } from "../../src/browser/service";

const CLI = "/state/browser/runtime-0123456789abcdef/node_modules/@playwright/mcp/cli.js";
const IN = { proxyPort: 51234, worktree: "/work/tree", stateDir: "/state", sessionId: "sess_1", nodePath: "/opt/homebrew/bin/node", cliPath: CLI };
const headed = () => buildBrowserLaunch({ ...IN, mode: "headed" });
const headless = () => buildBrowserLaunch({ ...IN, mode: "headless" });

describe("buildBrowserLaunch", () => {
  test("[C2] the pinned version is 0.0.86, a named constant, and the launch is node by absolute path running the daemon's own runtime script by absolute path — never npx", () => {
    expect(PLAYWRIGHT_MCP_VERSION).toBe("0.0.86");
    expect(PLAYWRIGHT_MCP_PACKAGE).toBe("@playwright/mcp@0.0.86");
    for (const l of [headed(), headless()]) {
      expect(l.command).toBe("/opt/homebrew/bin/node");
      expect(l.args[0]).toBe(CLI);
      expect([l.command, ...l.args].some((a) => /^(npx|npm|bunx|pnpm|yarn)$/.test(a) || a === "-y")).toBe(false);
    }
    // The pinned manifest in the repo names that version, and every package in its lock has a hash.
    const m = browserRuntimeManifest();
    expect(JSON.parse(m.packageJson).dependencies).toEqual({ "@playwright/mcp": "0.0.86" });
    const pkgs = Object.entries(JSON.parse(m.packageLock).packages as Record<string, { integrity?: string; version?: string }>).filter(([k]) => k);
    expect(pkgs.length).toBeGreaterThanOrEqual(3);
    for (const [, v] of pkgs) expect(v.integrity).toMatch(/^sha512-/);
    expect(pkgs.find(([k]) => k === "node_modules/@playwright/mcp")![1].version).toBe("0.0.86");
    expect(m.lockSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("[C2] a launch that is not an absolute node and the absolute runtime script fails the check: npx, a bare node, a relative script, a script outside the runtime", () => {
    const ok = headless();
    expect(presetArgProblems(ok, CLI)).toEqual([]);
    const flags = ok.args.slice(1);
    expect(presetArgProblems({ ...ok, command: "npx", args: ["-y", "@playwright/mcp@0.0.86", ...flags] })).not.toEqual([]);
    expect(presetArgProblems({ ...ok, command: "node" }).join()).toMatch(/absolute path to node/);
    expect(presetArgProblems({ ...ok, command: "/work/tree/node_modules/.bin/playwright-mcp" }).join()).toMatch(/absolute path to node/);
    expect(presetArgProblems({ ...ok, args: ["node_modules/@playwright/mcp/cli.js", ...flags] }).join()).toMatch(/server script/);
    expect(presetArgProblems({ ...ok, args: ["/state/browser/x/../../../work/tree/node_modules/@playwright/mcp/cli.js", ...flags] }).join()).toMatch(/server script/);
    expect(presetArgProblems({ ...ok, args: ["/work/tree/node_modules/@playwright/mcp/cli.js", ...flags] }, CLI).join()).toMatch(/not the daemon's own runtime/);
    expect(() => buildBrowserLaunch({ ...IN, mode: "headless", nodePath: "node" })).toThrow(/absolute/);
    expect(() => buildBrowserLaunch({ ...IN, mode: "headless", cliPath: "cli.js" })).toThrow(/absolute/);
  });

  test("[C2] headed: the complete argument list, with the dedicated profile under the state dir", () => {
    expect(headed().args).toEqual([
      CLI,
      "--browser",
      "chrome",
      "--proxy-server",
      "http://127.0.0.1:51234",
      "--output-dir",
      "/work/tree/.anvil-browser",
      "--file-paths",
      "absolute",
      "--no-webmcp",
      "--config",
      "/state/browser/sess_1/playwright-mcp.json",
      "--user-data-dir",
      "/state/browser-profile",
    ]);
    expect(headed().profileDir).toBe("/state/browser-profile");
  });

  test("[C2] no desktop session: the built config is headless with a temporary profile (--isolated --headless, no --user-data-dir)", () => {
    const l = headless();
    expect(l.args).toEqual([
      CLI,
      "--browser",
      "chrome",
      "--proxy-server",
      "http://127.0.0.1:51234",
      "--output-dir",
      "/work/tree/.anvil-browser",
      "--file-paths",
      "absolute",
      "--no-webmcp",
      "--config",
      "/state/browser/sess_1/playwright-mcp.json",
      "--isolated",
      "--headless",
    ]);
    expect(l.args).not.toContain("--user-data-dir");
    expect(l.profileDir).toBeUndefined();
    // …and that is what the mode chooser picks when the desktop probe says nobody is there.
    expect(chooseBrowserMode({ desktop: false, reason: "nobody is logged in at this machine's screen" }).mode).toBe("headless");
  });

  test("[C2] the generated config carries the three Chrome arguments and nothing else — no ignoreDefaultArgs", () => {
    for (const l of [headed(), headless()]) {
      expect(l.configJson).toEqual({
        browser: { launchOptions: { args: ["--proxy-bypass-list=<-loopback>", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] } },
      });
      expect(JSON.stringify(l.configJson)).not.toContain("ignoreDefaultArgs");
      expect(Object.keys(l.configJson.browser.launchOptions)).toEqual(["args"]);
    }
  });

  test("[C2] the preset's arguments are a subset of the allow list: every flag in both modes is on it, with nothing else", () => {
    for (const l of [headed(), headless()]) {
      const flags = l.args.slice(1).filter((a) => a.startsWith("--"));
      for (const f of flags) expect(Object.keys(PRESET_FLAG_ALLOW_LIST)).toContain(f);
      expect(presetArgProblems(l)).toEqual([]);
    }
    expect(Object.keys(PRESET_FLAG_ALLOW_LIST).sort()).toEqual(["--browser", "--config", "--file-paths", "--headless", "--isolated", "--no-webmcp", "--output-dir", "--proxy-server", "--user-data-dir"]);
  });

  test("[C2] never --proxy-bypass, --caps, --blocked-origins or --allowed-origins, in either mode", () => {
    for (const l of [headed(), headless()]) {
      for (const never of ["--proxy-bypass", "--caps", "--blocked-origins", "--allowed-origins", "--allow-unrestricted-file-access", "--user-agent", "--cdp-endpoint", "--extension"]) {
        expect(l.args.some((a) => a === never || a.startsWith(`${never}=`))).toBe(false);
      }
    }
  });

  test("[C2] there is no launch line without a proxy port", () => {
    for (const proxyPort of [0, -1, 70000, NaN, 1.5]) expect(() => buildBrowserLaunch({ ...IN, mode: "headless", proxyPort })).toThrow(/proxy/);
  });
});

describe("the argument allow list (gamed spec)", () => {
  const withArgs = (extra: string[], base: BrowserLaunch = headless()): BrowserLaunch => ({ ...base, args: [...base.args, ...extra] });

  test("[C2] any flag not on the allow list fails the check", () => {
    for (const extra of [
      ["--proxy-bypass", "127.0.0.1"],
      ["--caps", "vision"],
      ["--blocked-origins", "x"],
      ["--allowed-origins", "x"],
      ["--user-agent", "Mozilla/5.0"],
      ["--ignore-https-errors"],
      ["--init-script", "stealth.js"],
      ["--cdp-endpoint", "http://127.0.0.1:9222"],
      ["--executable-path", "/tmp/chrome"],
      ["--no-sandbox"],
      ["--proxy-bypass=<loopback>"],
    ]) {
      const problems = presetArgProblems(withArgs(extra));
      expect(problems.some((p) => p.includes("not on the allow list"))).toBe(true);
    }
  });

  test("[C2] a config that adds anything — ignoreDefaultArgs, another Chrome argument, another key — fails the check", () => {
    const base = headless();
    const bad = (configJson: unknown) => presetArgProblems({ ...base, configJson: configJson as BrowserLaunch["configJson"] });
    expect(bad({ browser: { launchOptions: { args: [...BROWSER_CHROME_ARGS], ignoreDefaultArgs: ["--disable-blink-features=AutomationControlled"] } } })).not.toEqual([]);
    expect(bad({ browser: { launchOptions: { args: [...BROWSER_CHROME_ARGS, "--user-agent=Mozilla/5.0"] } } }).join()).toMatch(/Chrome argument not on the allow list/);
    expect(bad({ browser: { launchOptions: { args: [...BROWSER_CHROME_ARGS, "--disable-blink-features=AutomationControlled"] } } }).join()).toMatch(/not on the allow list/);
    expect(bad({ browser: { launchOptions: { args: [...BROWSER_CHROME_ARGS] }, contextOptions: { userAgent: "x" } } })).not.toEqual([]);
    expect(bad({ browser: { launchOptions: { args: [...BROWSER_CHROME_ARGS] } }, network: { blockedOrigins: [] } })).not.toEqual([]);
    expect(bad({ browser: { launchOptions: { args: BROWSER_CHROME_ARGS.slice(0, 2) } } }).join()).toMatch(/missing Chrome argument/);
    expect(bad({ browser: { launchOptions: { args: [...BROWSER_CHROME_ARGS, "--proxy-bypass-list=<loopback>"] } } })).not.toEqual([]);
  });

  test("[C2] the proxy must be the daemon's loopback one, the browser Chrome, and the two modes cannot be mixed", () => {
    const base = headless();
    const swap = (flag: string, value: string): BrowserLaunch => ({ ...base, args: base.args.map((a, i) => (base.args[i - 1] === flag ? value : a)) });
    expect(presetArgProblems(swap("--proxy-server", "http://proxy.example:8080")).join()).toMatch(/loopback proxy/);
    expect(presetArgProblems(swap("--proxy-server", "direct://")).join()).toMatch(/loopback proxy/);
    expect(presetArgProblems(swap("--browser", "chromium")).join()).toMatch(/must be chrome/);
    expect(presetArgProblems({ ...base, args: base.args.filter((a) => a !== "--proxy-server" && !a.startsWith("http://127")) }).join()).toMatch(/loopback proxy/);
    expect(presetArgProblems({ ...base, args: base.args.filter((a) => a !== "--no-webmcp") }).join()).toMatch(/missing --no-webmcp/);
    expect(presetArgProblems({ ...base, args: base.args.filter((a) => a !== "--headless") }).join()).toMatch(/--isolated and --headless/);
    expect(presetArgProblems(withArgs(["--user-data-dir", "/state/browser-profile"])).join()).toMatch(/cannot be combined/);
    expect(presetArgProblems(withArgs(["--headless"])).join()).toMatch(/twice/);
    expect(presetArgProblems({ ...base, command: "/usr/bin/python3" }).join()).toMatch(/absolute path to node/);
    expect(presetArgProblems({ ...base, args: ["-y", "@playwright/mcp@latest", ...base.args.slice(1)] }).join()).toMatch(/server script/);
  });
});

describe("desktop detection", () => {
  const SCUTIL = (name: string, onConsole: string, owner = name) => `<dictionary> {
  GID : 20
  Name : ${name}
  SessionInfo : <array> {
    0 : <dictionary> {
      kCGSSessionOnConsoleKey : ${onConsole}
      kCGSSessionUserIDKey : 501
      kCGSSessionUserNameKey : ${owner}
      kCGSessionLoginDoneKey : TRUE
    }
  }
  UID : 501
}`;

  test("[C2] headed needs the daemon's own user on the console: scutil's ConsoleUser names them with kCGSSessionOnConsoleKey TRUE", () => {
    expect(parseConsoleUser(SCUTIL("evan", "TRUE"), "evan")).toEqual({ desktop: true, reason: "evan is logged in at the screen" });
    expect(chooseBrowserMode(parseConsoleUser(SCUTIL("evan", "TRUE"), "evan")).mode).toBe("headed");
  });

  test("[C2] nobody logged in, the login window, another user, or a session off the console → no desktop → headless fallback", () => {
    for (const out of ["No such key\n", "", SCUTIL("loginwindow", "TRUE"), SCUTIL("alice", "TRUE"), SCUTIL("evan", "FALSE"), SCUTIL("evan", "TRUE", "alice")]) {
      const probe = parseConsoleUser(out, "evan");
      expect(probe.desktop).toBe(false);
      expect(probe.reason.length).toBeGreaterThan(5);
      const chosen = chooseBrowserMode(probe);
      expect(chosen.mode).toBe("headless");
      expect(chosen.reason).toContain("Headless with a throwaway profile");
    }
  });

  test("[C2] a headed launch that failed falls back to headless even with a desktop session", () => {
    const chosen = chooseBrowserMode({ desktop: true, reason: "evan is logged in at the screen" }, true);
    expect(chosen.mode).toBe("headless");
    expect(chosen.reason).toMatch(/last headed launch failed/);
  });
});

describe("git exclude", () => {
  test("[C2] .anvil-browser/ is added once to the checkout's .git/info/exclude; a linked worktree uses the common git dir; a plain folder is left alone", () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-c2-excl-"));
    try {
      // An ordinary checkout.
      const repo = join(root, "repo");
      mkdirSync(join(repo, ".git", "info"), { recursive: true });
      writeFileSync(join(repo, ".git", "info", "exclude"), "# local excludes\n*.log");
      expect(ensureGitExcluded(repo, ".anvil-browser/")).toBe(true);
      expect(ensureGitExcluded(repo, ".anvil-browser/")).toBe(true);
      expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toBe("# local excludes\n*.log\n.anvil-browser/\n");

      // A linked worktree: `.git` is a file; the exclude file lives in the common git dir.
      const wt = join(root, "wt");
      mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
      writeFileSync(join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
      mkdirSync(wt);
      writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
      writeFileSync(join(repo, ".git", "info", "exclude"), "");
      expect(ensureGitExcluded(wt, ".anvil-browser/")).toBe(true);
      expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toBe(".anvil-browser/\n");

      // A folder that is not the root of a checkout: nothing is written, and nothing is searched upward.
      const plain = join(repo, "sub");
      mkdirSync(plain);
      expect(ensureGitExcluded(plain, ".anvil-browser/")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
