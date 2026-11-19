/**
 * The `browser` MCP preset's launch line (agent-cad-and-browser §4.12, §4.14 items 20, 21, 34, 37).
 *
 * Everything here is pure or takes its probes as arguments: `buildBrowserLaunch` turns a mode, a proxy
 * port and three folders into the exact `npx` command and the JSON config Playwright MCP reads, and
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
import { join } from "node:path";

/** The pinned Playwright MCP release (item 20). The tool table in `tools.ts` is for this version. */
export const PLAYWRIGHT_MCP_VERSION = "0.0.86";
export const PLAYWRIGHT_MCP_PACKAGE = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;
export const BROWSER_COMMAND = "npx";
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
 */
export const BROWSER_CHROME_ARGS: readonly string[] = ["--proxy-bypass-list=<-loopback>", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"];

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
}

export function browserOutputDir(worktree: string): string {
  return join(worktree, BROWSER_OUTPUT_DIRNAME);
}
export function browserProfileDir(stateDir: string): string {
  return join(stateDir, BROWSER_PROFILE_DIRNAME);
}
export function browserConfigPath(stateDir: string, sessionId: string): string {
  return join(stateDir, BROWSER_STATE_DIRNAME, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"), BROWSER_CONFIG_FILENAME);
}

/** The complete command line and config for one session's browser server. Pure. */
export function buildBrowserLaunch(input: BrowserLaunchInput): BrowserLaunch {
  if (!Number.isInteger(input.proxyPort) || input.proxyPort < 1 || input.proxyPort > 65535) throw new Error("the browser cannot start without its proxy");
  const outputDir = browserOutputDir(input.worktree);
  const configPath = browserConfigPath(input.stateDir, input.sessionId);
  const profileDir = input.mode === "headed" ? browserProfileDir(input.stateDir) : undefined;
  const args = [
    "-y",
    PLAYWRIGHT_MCP_PACKAGE,
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
  return { command: BROWSER_COMMAND, args, configPath, configJson: { browser: { launchOptions: { args: [...BROWSER_CHROME_ARGS] } } }, outputDir, ...(profileDir ? { profileDir } : {}) };
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
export function presetArgProblems(launch: Pick<BrowserLaunch, "command" | "args" | "configJson">): string[] {
  const problems: string[] = [];
  const { args } = launch;
  if (launch.command !== BROWSER_COMMAND) problems.push(`command is ${launch.command}, not ${BROWSER_COMMAND}`);
  if (args[0] !== "-y" || args[1] !== PLAYWRIGHT_MCP_PACKAGE) problems.push(`must start with -y ${PLAYWRIGHT_MCP_PACKAGE}`);
  const seen = new Map<string, string | true>();
  for (let i = 2; i < args.length; i++) {
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

  // The config file: `browser.launchOptions.args` with exactly the three Chrome arguments, no other key.
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
    for (const a of chromeArgs) if (!BROWSER_CHROME_ARGS.includes(a as string)) problems.push(`Chrome argument not on the allow list: ${String(a)}`);
    for (const a of BROWSER_CHROME_ARGS) if (!chromeArgs.includes(a)) problems.push(`missing Chrome argument ${a}`);
    if (chromeArgs.length !== BROWSER_CHROME_ARGS.length) problems.push("Chrome arguments must be listed exactly once each");
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
