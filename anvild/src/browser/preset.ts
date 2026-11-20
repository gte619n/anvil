/**
 * The `browser` MCP preset's launch line (agent-cad-and-browser §4.12, §4.14 items 20, 21, 34, 37).
 *
 * Everything here is pure or takes its probes as arguments: `buildBrowserLaunch` turns a mode, a proxy
 * port and three folders into the exact command and the JSON config Playwright MCP reads — `node`
 * by absolute path, running the server script of the daemon-owned pinned runtime (`runtime.ts`) by
 * absolute path; never `npx`, which would read `node_modules` and `.npmrc` from the worktree — and
 * `presetArgProblems` checks any argument list against the closed allow list. The service that owns
 * the proxy and writes the files is `browser/service.ts`.
 *
 * No evasion (item 37): the preset passes the flags listed here and nothing else. It neither removes
 * Playwright's own default arguments nor adds any; there is no stealth plugin, no user-agent or
 * fingerprint override, no CAPTCHA solver and no proxy rotation, and `presetArgProblems` fails on any
 * flag that is not on the list.
 */
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { basename, isAbsolute, join } from "node:path";

/** The pinned Playwright MCP release (item 20). The tool table in `tools.ts` is for this version. */
export const PLAYWRIGHT_MCP_VERSION = "0.0.86";
export const PLAYWRIGHT_MCP_PACKAGE = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;
/** What the launch runs: `node` (resolved to an absolute path once, from the daemon's PATH). */
export const BROWSER_COMMAND = "node";
/** The server script inside the daemon-owned runtime folder. */
export const BROWSER_CLI_SUFFIX = "/node_modules/@playwright/mcp/cli.js";
export const BROWSER_KEY = "browser";

/** Playwright's output folder inside the session worktree (snapshots, screenshots, downloads). */
export const BROWSER_OUTPUT_DIRNAME = ".anvil-browser";
/** The dedicated headed profile, under the daemon's state dir. */
export const BROWSER_PROFILE_DIRNAME = "browser-profile";
/** Per-session generated config files live in `<stateDir>/browser/<sessionId>/`. */
export const BROWSER_STATE_DIRNAME = "browser";
export const BROWSER_CONFIG_FILENAME = "playwright-mcp.json";

/**
 * The extra Chrome arguments, passed through the config file's `browser.launchOptions.args`:
 *  - `--proxy-bypass-list=<-loopback>`: Chrome otherwise skips the proxy for loopback addresses;
 *  - `--disable-quic`: QUIC is UDP and would not go through an HTTP proxy;
 *  - `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`: no WebRTC UDP around the proxy.
 * Headed mode adds one more, `--disk-cache-dir=<folder>` (`BROWSER_DISK_CACHE_FLAG`), below.
 */
export const BROWSER_CHROME_ARGS: readonly string[] = ["--proxy-bypass-list=<-loopback>", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"];

/**
 * Headed mode only: Chrome's HTTP cache goes to a NEW folder for every launch of the session's browser
 * server, outside the persistent agent profile (`<stateDir>/browser/<session>/disk-cache-<launch id>`;
 * the service deletes it when that browser is replaced or the session ends). Without it the profile's
 * own cache outlives the browser, and a fresh process shows a cached page or frame of a logged-in site
 * without one connection through the proxy, so the gate's traffic log could not see it (verified with
 * real Chrome on a reused profile: launch two loaded the cached frame with zero proxy traffic; with this
 * flag it fetched it again, and the profile had no `Default/Cache` at all). `--media-cache-dir` is not
 * passed: Chrome ignores it (it created no folder in the same run). The headless fallback needs neither:
 * its whole profile, cache included, is Playwright's throwaway folder.
 */
export const BROWSER_DISK_CACHE_FLAG = "--disk-cache-dir";
export const BROWSER_DISK_CACHE_PREFIX = "disk-cache-";

export type BrowserMode = "headed" | "headless";

export interface BrowserLaunchInput {
  mode: BrowserMode;
  /** The port of this session's loopback proxy (`browser/proxy.ts`). */
  proxyPort: number;
  /** The session's worktree (absolute). */
  worktree: string;
  /** The daemon's state dir (absolute). */
  stateDir: string;
  sessionId: string;
  /** Absolute path of `node`. */
  nodePath: string;
  /** Absolute path of the pinned runtime's `cli.js` (`runtime.ts`). */
  cliPath: string;
  /** Headed mode: a new id for every launch (letters, digits, `-`): names the launch's own HTTP cache
   *  folder (`BROWSER_DISK_CACHE_FLAG`). Required for headed, ignored for headless. */
  launchId?: string;
}

export interface BrowserLaunch {
  command: string;
  args: string[];
  /** Where the caller must write `configJson` before the server starts. */
  configPath: string;
  configJson: { browser: { launchOptions: { args: string[] } } };
  outputDir: string;
  /** The profile folder — headed mode only. Headless uses Playwright's own throwaway profile. */
  profileDir?: string;
  /** This launch's HTTP cache folder, outside the profile — headed mode only. */
  diskCacheDir?: string;
}

export function browserOutputDir(worktree: string): string {
  return join(worktree, BROWSER_OUTPUT_DIRNAME);
}
export function browserProfileDir(stateDir: string): string {
  return join(stateDir, BROWSER_PROFILE_DIRNAME);
}
/** The session's own folder for generated launch files: `<stateDir>/browser/<session>/`. */
export function browserSessionDir(stateDir: string, sessionId: string): string {
  return join(stateDir, BROWSER_STATE_DIRNAME, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
}
export function browserConfigPath(stateDir: string, sessionId: string): string {
  return join(browserSessionDir(stateDir, sessionId), BROWSER_CONFIG_FILENAME);
}
/** One headed launch's HTTP cache folder (see `BROWSER_DISK_CACHE_FLAG`). */
export function browserDiskCacheDir(stateDir: string, sessionId: string, launchId: string): string {
  return join(browserSessionDir(stateDir, sessionId), `${BROWSER_DISK_CACHE_PREFIX}${launchId}`);
}

/** The complete command line and config for one session's browser server. Pure. */
export function buildBrowserLaunch(input: BrowserLaunchInput): BrowserLaunch {
  if (!Number.isInteger(input.proxyPort) || input.proxyPort < 1 || input.proxyPort > 65535) throw new Error("the browser cannot start without its proxy");
  const outputDir = browserOutputDir(input.worktree);
  const configPath = browserConfigPath(input.stateDir, input.sessionId);
  const profileDir = input.mode === "headed" ? browserProfileDir(input.stateDir) : undefined;
  if (!isAbsolute(input.nodePath) || !isAbsolute(input.cliPath)) throw new Error("the browser is started by absolute paths only");
  if (profileDir && !/^[A-Za-z0-9-]{1,64}$/.test(input.launchId ?? "")) throw new Error("a headed launch needs its own launch id (for its HTTP cache folder outside the profile)");
  const diskCacheDir = profileDir ? browserDiskCacheDir(input.stateDir, input.sessionId, input.launchId!) : undefined;
  const args = [
    input.cliPath,
    "--browser",
    "chrome",
    "--proxy-server",
    `http://127.0.0.1:${input.proxyPort}`,
    "--output-dir",
    outputDir,
    "--file-paths",
    "absolute",
    "--no-webmcp",
    "--config",
    configPath,
    ...(profileDir ? ["--user-data-dir", profileDir] : ["--isolated", "--headless"]),
  ];
  const chromeArgs = [...BROWSER_CHROME_ARGS, ...(diskCacheDir ? [`${BROWSER_DISK_CACHE_FLAG}=${diskCacheDir}`] : [])];
  return { command: input.nodePath, args, configPath, configJson: { browser: { launchOptions: { args: chromeArgs } } }, outputDir, ...(profileDir ? { profileDir, diskCacheDir } : {}) };
}

// ── The argument allow list ─────────────────────────────────────────────────────────────────────

/** Every Playwright MCP flag the preset may pass, and whether it takes a value. */
export const PRESET_FLAG_ALLOW_LIST: Readonly<Record<string, "value" | "none">> = {
  "--browser": "value",
  "--proxy-server": "value",
  "--output-dir": "value",
  "--file-paths": "value",
  "--no-webmcp": "none",
  "--config": "value",
  "--user-data-dir": "value",
  "--isolated": "none",
  "--headless": "none",
};

/**
 * Why `launch` is not a launch the preset may make; empty when it is. Checked by the unit test and
 * again by the service before every launch (a launch with a problem is skipped, not started).
 */
export function presetArgProblems(launch: Pick<BrowserLaunch, "command" | "args" | "configJson">, expectedCli?: string): string[] {
  const problems: string[] = [];
  const { args } = launch;
  // `node` by absolute path, then the runtime's server script by absolute path. A bare name or a
  // relative path would be resolved against the session's worktree or its PATH.
  if (!isAbsolute(launch.command) || basename(launch.command) !== BROWSER_COMMAND) problems.push(`command must be an absolute path to ${BROWSER_COMMAND}, not ${launch.command}`);
  const cli = args[0] ?? "";
  if (!isAbsolute(cli) || !cli.endsWith(BROWSER_CLI_SUFFIX) || cli.split("/").includes("..")) problems.push(`the first argument must be the absolute path of the pinned runtime's server script (…${BROWSER_CLI_SUFFIX})`);
  else if (expectedCli !== undefined && cli !== expectedCli) problems.push("the server script is not the daemon's own runtime");
  const seen = new Map<string, string | true>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    const kind = Object.hasOwn(PRESET_FLAG_ALLOW_LIST, flag) ? PRESET_FLAG_ALLOW_LIST[flag] : undefined;
    if (!kind) {
      problems.push(`argument not on the allow list: ${flag}`);
      continue;
    }
    if (seen.has(flag)) problems.push(`flag passed twice: ${flag}`);
    if (kind === "value") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) problems.push(`${flag} needs a value`);
      seen.set(flag, value ?? "");
    } else seen.set(flag, true);
  }
  if (seen.get("--browser") !== "chrome") problems.push("--browser must be chrome");
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(String(seen.get("--proxy-server") ?? ""))) problems.push("--proxy-server must be the daemon's loopback proxy");
  if (seen.get("--file-paths") !== "absolute") problems.push("--file-paths must be absolute");
  for (const required of ["--output-dir", "--no-webmcp", "--config"]) if (!seen.has(required)) problems.push(`missing ${required}`);
  const headed = seen.has("--user-data-dir");
  const fallback = seen.has("--isolated") || seen.has("--headless");
  if (headed && fallback) problems.push("--user-data-dir cannot be combined with --isolated or --headless");
  if (!headed && !(seen.has("--isolated") && seen.has("--headless"))) problems.push("without a profile the browser must be --isolated and --headless");

  // The config file: `browser.launchOptions.args` with exactly the three Chrome arguments — plus, in
  // headed mode, exactly one `--disk-cache-dir=` naming an absolute folder outside the profile — and
  // no other key.
  const cfg = launch.configJson as unknown;
  const only = (o: unknown, key: string): unknown => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
    const keys = Object.keys(o);
    if (keys.length !== 1 || keys[0] !== key) return undefined;
    return (o as Record<string, unknown>)[key];
  };
  const chromeArgs = only(only(only(cfg, "browser"), "launchOptions"), "args");
  if (!Array.isArray(chromeArgs)) problems.push("the config must be exactly { browser: { launchOptions: { args: [...] } } }");
  else {
    const cacheFlag = `${BROWSER_DISK_CACHE_FLAG}=`;
    const caches = chromeArgs.filter((a): a is string => typeof a === "string" && a.startsWith(cacheFlag));
    for (const a of chromeArgs) if (!BROWSER_CHROME_ARGS.includes(a as string) && !caches.includes(a as string)) problems.push(`Chrome argument not on the allow list: ${String(a)}`);
    for (const a of BROWSER_CHROME_ARGS) if (!chromeArgs.includes(a)) problems.push(`missing Chrome argument ${a}`);
    if (chromeArgs.length !== BROWSER_CHROME_ARGS.length + caches.length || new Set(chromeArgs).size !== chromeArgs.length) problems.push("Chrome arguments must be listed exactly once each");
    if (headed) {
      const profile = String(seen.get("--user-data-dir") ?? "");
      const dir = caches[0]?.slice(cacheFlag.length) ?? "";
      if (caches.length !== 1) problems.push(`headed mode needs exactly one ${BROWSER_DISK_CACHE_FLAG} (the launch's HTTP cache, outside the profile)`);
      else if (!isAbsolute(dir) || dir.split("/").includes("..") || !basename(dir).startsWith(BROWSER_DISK_CACHE_PREFIX)) problems.push(`${BROWSER_DISK_CACHE_FLAG} must be an absolute ${BROWSER_DISK_CACHE_PREFIX}… folder`);
      else if (dir === profile || dir.startsWith(`${profile.replace(/\/+$/, "")}/`)) problems.push(`${BROWSER_DISK_CACHE_FLAG} must be outside the profile`);
    } else if (caches.length) problems.push(`${BROWSER_DISK_CACHE_FLAG} is for the headed profile only`);
  }
  return problems;
}

// ── Desktop session detection (item 34) ─────────────────────────────────────────────────────────

export interface DesktopProbeResult {
  desktop: boolean;
  /** Why, in words fit to show on the integration's row. */
  reason: string;
}
export type DesktopProbe = () => DesktopProbeResult;

/**
 * Read `scutil`'s `show State:/Users/ConsoleUser` output: a desktop session exists for `user` when
 * the console user is `user` and one of its sessions has `kCGSSessionOnConsoleKey : TRUE`.
 */
export function parseConsoleUser(output: string, user: string): DesktopProbeResult {
  const name = /^\s*Name\s*:\s*(.+?)\s*$/m.exec(output)?.[1];
  if (!name) return { desktop: false, reason: "nobody is logged in at this machine's screen" };
  if (name !== user) return { desktop: false, reason: `the screen belongs to another user (${name === "loginwindow" ? "the login window" : name})` };
  // One `<dictionary> { … }` per session inside SessionInfo.
  const sessions = output.match(/\d+\s*:\s*<dictionary>\s*\{[^}]*\}/g) ?? [];
  const mine = sessions.filter((s) => {
    const owner = /kCGSSessionUserNameKey\s*:\s*(.+?)\s*$/m.exec(s)?.[1];
    return owner === undefined || owner === user;
  });
  if (mine.some((s) => /kCGSSessionOnConsoleKey\s*:\s*TRUE\b/.test(s))) return { desktop: true, reason: `${user} is logged in at the screen` };
  return { desktop: false, reason: `${user}'s desktop session is not on the screen` };
}

/** The real probe. Any failure to ask is "no desktop" (the fallback is the safe side). */
export const defaultDesktopProbe: DesktopProbe = () => {
  if (process.platform !== "darwin") return { desktop: false, reason: "headed mode needs macOS" };
  try {
    const r = spawnSync("/usr/sbin/scutil", [], { input: "show State:/Users/ConsoleUser\n", encoding: "utf8", timeout: 3000 });
    if (r.status !== 0 || typeof r.stdout !== "string") return { desktop: false, reason: "could not ask macOS who is at the screen" };
    return parseConsoleUser(r.stdout, userInfo().username);
  } catch {
    return { desktop: false, reason: "could not ask macOS who is at the screen" };
  }
};

/** Headed when a desktop session exists and no headed launch has failed since the daemon started. */
export function chooseBrowserMode(probe: DesktopProbeResult, headedFailed = false): { mode: BrowserMode; reason: string } {
  if (!probe.desktop) return { mode: "headless", reason: `Headless with a throwaway profile: ${probe.reason}.` };
  if (headedFailed) return { mode: "headless", reason: "Headless with a throwaway profile: the last headed launch failed (press Check to try headed again)." };
  return { mode: "headed", reason: `Headed, with the agent profile: ${probe.reason}.` };
}
