/**
 * The agent browser on one daemon (agent-cad-and-browser Phase C2): owns the per-session proxies,
 * the allowed-sites list and its sync, the per-session approval state, and registers the `browser`
 * preset, its kind gate, its result hook and a protected rule for its files.
 *
 * Created by `McpIntegrationService` only when BOTH the "mcp-integrations" and the "browser" features
 * are on. Without it nothing here exists: the preset is not registered (so `mcp.integration.add`
 * refuses the kind), no proxy listens and nothing is written.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { BrowserIntegrationInfo, McpHealth, McpIntegration, McpTransport, ServerEvent, ToolResultImage } from "@protocol";
import type { McpChildEnv } from "../agent/mcp-external";
import { registerMcpKindGate, registerMcpKindResultHook, type McpKindGateContext, type McpKindVerdict } from "../agent/mcp-gate";
import { registerProtectedRule, type ProtectedRule } from "../agent/protected";
import { isUnder, realish, resolveToolPath } from "../agent/tool-paths";
import { resolveOnPath } from "../mcp/health";
import { registerMcpPreset, type McpPreset, type McpPresetContext } from "../mcp/presets";
import { DOWNLOADS_DIRNAME, downloadContext, downloadNotice, downloadsProtectedRule, outputDirProblem, parseDownloadLines, quarantineFile, requestedOutputFiles, sweepOutputDir, type DownloadOutcome } from "./downloads";
import { BrowserGate, TRAFFIC_LOST_SITE, type BrowserGateHooks } from "./gate";
import { makeHardStopPolicy } from "./hardstops";
import { BROWSER_LOGGEDIN_FILE, LoggedInSitesService, runOwnerBrowser, type AgentBrowserLauncher, type AgentBrowserProcess } from "./loggedin";
import {
  BROWSER_COMMAND,
  BROWSER_KEY,
  BROWSER_OUTPUT_DIRNAME,
  BROWSER_STATE_DIRNAME,
  PLAYWRIGHT_MCP_PACKAGE,
  browserProfileDir,
  buildBrowserLaunch,
  chooseBrowserMode,
  defaultDesktopProbe,
  presetArgProblems,
  type BrowserMode,
  type DesktopProbe,
  type DesktopProbeResult,
} from "./preset";
import { browserRuntimeCli, browserRuntimeProblem, installBrowserRuntime } from "./runtime";
import { BrowserProxyManager, ownHosts, type BrowserProxyOptions, type ProxyFactory, type ProxyResolver } from "./proxy";
import { BROWSER_SITES_FILE, registrableDomain, resultFileLinks, toolResultText } from "./sites";
import { TestDaemonService, type TestDaemonSeams } from "./testdaemon";
import { classifyBrowserTool } from "./tools";
import { AllowedSitesService, type BrowserFleetLink } from "./sites-sync";

export interface BrowserServiceDeps {
  stateDir: string;
  /** The environment a stdio integration is started with (`env -i` PATH/HOME/TMPDIR). */
  childEnv: McpChildEnv;
  broadcast: (event: ServerEvent) => void;
  /** Drop a session's driver if it is idle (kills its browser). False when it is mid-turn. */
  dropIdleDriver: (sessionId: string) => boolean;
  /** Rebuild a session's driver now if idle, else when its turn ends. */
  requestRebuild: (sessionId: string) => void;
  notice: (sessionId: string, markdown: string) => void;
  /** Whether `integrationId` is in THIS daemon's store. The preset, gate and result-hook registries
   *  are per process, so each call is routed to the service that owns the integration. */
  hasIntegration: (integrationId: string) => boolean;
  // ── test seams ──
  desktopProbe?: DesktopProbe;
  resolver?: ProxyResolver;
  /** Whether `command` resolves on the child PATH. */
  commandExists?: (command: string, pathEnv: string) => boolean;
  chromeInstalled?: () => boolean;
  proxyFactory?: ProxyFactory;
  onProxyDecision?: BrowserProxyOptions["onDecision"];
  selfHosts?: () => readonly string[];
  fetchImpl?: typeof fetch;
  clock?: () => number;
  /** Allowed-sites sync timer; 0 = none. (The logged-in list uses the same period.) */
  sitesIntervalMs?: number;
  /** Absolute path of `node` / `npm` (default: resolved on the child PATH). */
  nodePath?: () => string | undefined;
  npmPath?: () => string | undefined;
  /** Installs the pinned server runtime into the state dir (default: `installBrowserRuntime`). */
  runtimeInstaller?: (stateDir: string) => Promise<void>;
  /** Health may have changed without a command (the runtime finished installing): probe again. */
  reprobe?: () => void;
  // ── Phase C3 ──
  /** Whether a session holds the browser integration's exclusive lock right now. */
  lockHeld?: () => boolean;
  /** Something the integration's status row shows has changed ("in use by owner"): re-broadcast it. */
  statusChanged?: () => void;
  /** Persist an image as an attachment of the session and return its id (the supervisor's store).
   *  Without it a hard-stop card can carry no screenshot, so hard-stop calls are denied. */
  saveImage?: (sessionId: string, mediaType: string, dataBase64: string) => string;
  /** Starts the owner's Chrome for "Open agent browser" (test seam; default spawns Chrome). */
  agentBrowserLauncher?: AgentBrowserLauncher;
  /** Where the installed Chrome's binary is (test seam). */
  chromePath?: () => string | undefined;
  /** How long a hard-stop card waits before it is denied. */
  hardStopTimeoutMs?: number;
  /** The per-file download limit (default 200 MB). */
  maxDownloadBytes?: number;
  /** The browser gate's clock for its freshness rule (default `Date.now`; a test seam). */
  pageClock?: () => number;
  // ── Phase C4 ──
  /** How the throwaway test daemon is built, started, probed and timed (test seams). */
  testDaemon?: Partial<TestDaemonSeams>;
}

/** The entry "Add → Browser" creates. Every field but `label` and `enabled` is fixed by the preset. */
export function browserIntegrationDefaults(): Omit<McpIntegration, "id"> {
  // The stored transport is for show: every launch is built by `buildBrowserLaunch` from the
  // daemon-owned runtime (an absolute `node`, an absolute script).
  return { key: BROWSER_KEY, kind: "browser", label: "Browser", transport: { type: "stdio", command: BROWSER_COMMAND, args: [`${PLAYWRIGHT_MCP_PACKAGE} (pinned runtime in the daemon's state folder)`] }, exclusive: true, enabled: true };
}

const CHROME_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")];
/** The installed Chrome's binary on this machine, if there is one. */
export function installedChromePath(): string | undefined {
  if (process.platform === "darwin") return CHROME_PATHS.find((p) => existsSync(p));
  return ["google-chrome", "google-chrome-stable", "chrome"].map((c) => resolveOnPath(c)).find((p): p is string => !!p) ?? (existsSync("/opt/google/chrome/chrome") ? "/opt/google/chrome/chrome" : undefined);
}
function defaultChromeInstalled(): boolean {
  if (process.platform === "darwin") return CHROME_PATHS.some((p) => existsSync(p));
  return ["google-chrome", "google-chrome-stable", "chrome"].some((c) => !!resolveOnPath(c)) || existsSync("/opt/google/chrome/chrome");
}

/**
 * Add `entry` to the worktree's git exclude file (`.git/info/exclude`; for a linked worktree, the
 * common git dir's). Only when `worktree` itself is the root of a checkout — it never searches
 * upward, so a folder that merely sits inside some repository is left alone. Best effort.
 */
export function ensureGitExcluded(worktree: string, entry: string): boolean {
  try {
    const dotGit = join(worktree, ".git");
    if (!existsSync(dotGit)) return false;
    let gitDir = dotGit;
    const asFile = (() => {
      try {
        return readFileSync(dotGit, "utf8");
      } catch {
        return undefined; // a directory
      }
    })();
    if (asFile !== undefined) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(asFile);
      if (!m) return false;
      gitDir = resolve(worktree, m[1]!);
      const common = join(gitDir, "commondir");
      if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, "utf8").trim());
    }
    const file = join(gitDir, "info", "exclude");
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.split(/\r?\n/).some((l) => l.trim() === entry)) return true;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
    return true;
  } catch {
    return false;
  }
}

const DESKTOP_PROBE_TTL_MS = 10_000;

interface Runtime {
  mode: BrowserMode;
  integrationId: string;
  worktree: string;
}

/**
 * Whether a Bash command talks to a daemon's own API from inside a session: a tripwire for the
 * routes that change what the browser may do (and the fleet routes), and for this daemon's port.
 * The agent runs as the daemon's user, so this is not a boundary (§6) — it stops the obvious route.
 */
export function daemonApiCommandProblem(command: string, selfPort?: number): string | undefined {
  if (!/\b(curl|wget|nc|ncat|netcat|socat|http|https|xh|websocat)\b|fetch\s*\(|WebSocket\s*\(|urlopen|requests\.|http\.client|Invoke-WebRequest/.test(command)) return undefined;
  if (/\/api\/browser\/|\/api\/fleet\//.test(command)) return "a session may not call the daemon's browser or fleet routes";
  if (selfPort && new RegExp(`(^|[^0-9])${selfPort}([^0-9]|$)`).test(command) && /127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|100\.\d+\.\d+\.\d+|\.ts\.net|\b[a-z0-9-]+\.lan\b/i.test(command)) return "a session may not talk to the daemon's own port";
  return undefined;
}

/** A page screenshot a session's browser returned, kept for the hard-stop and hand-off cards. */
interface Shot {
  /** The proxy's traffic sequence when it was noted: traffic to another site since makes it stale. */
  seq: number;
  mediaType: string;
  dataBase64: string;
  /** The page address when it was taken. */
  url: string | undefined;
  /** Whether a call that could have changed the page has run since. */
  stale: boolean;
  attachmentId?: string;
}

const MAX_SHOT_BASE64 = 12 * 1024 * 1024;

/**
 * The image in a `browser_take_screenshot` result (C3 review, item 2: never another tool's): an INLINE
 * image content block only (the SDK's `source` shape or MCP's `data`/`mimeType` shape). A file — even
 * one the result links in the browser's own output folder — is never read (C4 review, item 3): the
 * agent can replace a file between the server writing it and the daemon reading it, and the gate
 * refuses `filename` on this tool, so the server always returns the picture inline.
 */
export function resultImage(content: unknown): { mediaType: string; dataBase64: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const b of [...content].reverse() as Record<string, unknown>[]) {
    if (!b || typeof b !== "object" || b.type !== "image") continue;
    const src = b.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
    const data = typeof b.data === "string" ? b.data : src?.type === "base64" && typeof src.data === "string" ? src.data : undefined;
    const mediaType = typeof b.mimeType === "string" ? b.mimeType : typeof src?.media_type === "string" ? src.media_type : "image/png";
    if (data && data.length <= MAX_SHOT_BASE64 && /^image\/(png|jpeg|webp)$/.test(mediaType)) return { mediaType, dataBase64: data };
  }
  return undefined;
}

const realNodeCache = new Map<string, string>();
/**
 * The real `node` binary behind `candidate` (C3 review, item 6): what `node -p process.execPath`
 * prints when run from a neutral folder the daemon owns. A version-manager shim on the PATH (asdf,
 * mise, nodenv…) picks a version from files like `.tool-versions` in the folder it runs in — and the
 * browser's server runs in the session's worktree — so the launch line names the binary the shim
 * resolved HERE, by absolute path, and no worktree file can change which program starts.
 */
export function resolveRealNode(candidate: string | undefined, neutralDir: string, env: { PATH: string; HOME: string; TMPDIR: string }): string | undefined {
  if (!candidate || !isAbsolute(candidate)) return undefined;
  const hit = realNodeCache.get(`${candidate}\0${neutralDir}`);
  if (hit && existsSync(hit)) return hit;
  try {
    mkdirSync(neutralDir, { recursive: true });
    const r = Bun.spawnSync([candidate, "-p", "process.execPath"], { cwd: neutralDir, env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR }, stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    const out = r.stdout.toString().trim().split("\n").pop()?.trim();
    if (r.exitCode !== 0 || !out || !isAbsolute(out) || !existsSync(out)) return undefined;
    realNodeCache.set(`${candidate}\0${neutralDir}`, out);
    return out;
  } catch {
    return undefined;
  }
}

// ── One registration per process, routed to the owning service ──────────────────────────────────
// `registerMcpPreset` / `registerMcpKindGate` / `registerMcpKindResultHook` hold one entry per kind
// for the whole process. A daemon has one BrowserService, but the functional tests run several
// daemons in one process (the fleet simulator), so the registered functions look the service up by
// the integration's id (ids are random and belong to exactly one daemon's store).

const live = new Set<BrowserService>();
let sharedOff: (() => void)[] = [];
const NOT_HERE = "the agent browser is not enabled on this server";

function owner(integration: { id: string }): BrowserService | undefined {
  for (const s of live) if (s.owns(integration.id)) return s;
  return undefined;
}

const SHARED_PRESET: McpPreset = {
  kind: "browser",
  title: "Browser",
  fixed: true,
  defaults: browserIntegrationDefaults,
  resolveTransport: (i, ctx) => owner(i)?.resolveTransport(i, ctx) ?? { skip: NOT_HERE },
  health: (i) => owner(i)?.health() ?? { state: "unavailable", reason: NOT_HERE },
  statusExtra: (i) => {
    const s = owner(i);
    return s ? { browser: s.info() } : {};
  },
  onCheck: (i) => owner(i)?.onCheck(),
};

/** Whether `preset` is the agent browser's own (as opposed to a stand-in a test registered). */
export function isBrowserPreset(preset: McpPreset | undefined): boolean {
  return preset === SHARED_PRESET;
}

function attach(service: BrowserService): void {
  live.add(service);
  if (sharedOff.length) return;
  sharedOff = [
    registerMcpPreset(SHARED_PRESET),
    registerMcpKindGate("browser", (ctx) => owner(ctx.integration)?.kindGate(ctx) ?? { kind: "deny", reason: NOT_HERE }),
    registerMcpKindResultHook("browser", ({ session, integration, result }) => owner(integration)?.onToolResult(session.id, result)),
  ];
}

function detach(service: BrowserService): void {
  live.delete(service);
  if (live.size) return;
  for (const off of sharedOff.splice(0)) off();
}

export class BrowserService {
  /** PHASE C3 / C4 plug-in points (see `BrowserGateHooks`). Assign fields; all start unset. */
  readonly hooks: BrowserGateHooks = {};
  readonly proxies: BrowserProxyManager;
  readonly sites: AllowedSitesService;
  /** PHASE C3: the logged-in sites and their unlock switches (hub-synced). */
  readonly loggedIn: LoggedInSitesService;
  /** PHASE C4: each session's throwaway test daemon. */
  readonly testDaemons: TestDaemonService;
  readonly gate: BrowserGate;
  private readonly shots = new Map<string, Shot>();
  /** Files each session asked Playwright to write by `filename` — not downloads. */
  private readonly requested = new Map<string, Set<string>>();
  /** What happened to downloads since the session's last browser call; told to the model with the next one. */
  private readonly reports = new Map<string, DownloadOutcome[]>();
  /** When each session's output folder was last swept (real time: compared with file times). */
  private readonly sweptAt = new Map<string, number>();
  private ownerBrowser: { since: number; proc: AgentBrowserProcess } | undefined;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly unregister: (() => void)[] = [];
  private headedFailed = false;
  private started = false;
  private probed: { at: number; result: DesktopProbeResult } | undefined;
  private runtimeInstall: Promise<void> | undefined;
  private runtimeTried = false;
  private runtimeError: string | undefined;
  private selfPort: number | undefined;
  /** Requests the network block refused since each session's last browser call (told to the model). */
  private readonly refusals = new Map<string, string[]>();
  /** Every site each session's browser contacted, in order (C3 review, item 1). */
  private readonly traffic = new Map<string, { seq: number; site: string }[]>();
  /** Per session: entries up to this sequence were dropped (the log is bounded). */
  private readonly trafficDropped = new Map<string, number>();
  private trafficCounter = 0;

  constructor(private readonly deps: BrowserServiceDeps) {
    this.sites = new AllowedSitesService({ stateDir: deps.stateDir, broadcast: deps.broadcast, clock: deps.clock, fetchImpl: deps.fetchImpl, intervalMs: deps.sitesIntervalMs });
    this.proxies = new BrowserProxyManager(
      {
        resolve: deps.resolver,
        fleetHosts: () => this.sites.fleetHosts(),
        selfHosts: deps.selfHosts ?? ownHosts,
        onDecision: deps.onProxyDecision,
        selfPort: () => this.selfPort,
      },
      deps.proxyFactory,
    );
    this.proxies.onSessionDecision = (sessionId, d) => {
      this.recordTraffic(sessionId, d.host, d.port);
      if (d.allowed) return;
      const line = `${d.host}:${d.port} (${d.reason ?? "refused"})`;
      const list = this.refusals.get(sessionId) ?? [];
      if (!list.includes(line) && list.length < 6) this.refusals.set(sessionId, [...list, line]);
    };
    this.gate = new BrowserGate({
      isSiteAllowed: (site) => this.sites.isAllowed(site),
      allowSiteAlways: (site) => void this.sites.add(site),
      runtime: (sessionId) => {
        const rt = this.runtimes.get(sessionId);
        return rt ? { mode: rt.mode, proxyRunning: this.proxies.running(sessionId) } : undefined;
      },
      hooks: this.hooks,
      ...(deps.pageClock ? { clock: deps.pageClock } : {}),
    });
    // Phase C3 fills the hooks Phase C2 left open.
    this.loggedIn = new LoggedInSitesService({ stateDir: deps.stateDir, broadcast: deps.broadcast, clock: deps.clock, fetchImpl: deps.fetchImpl, intervalMs: deps.sitesIntervalMs });
    this.hooks.loggedInSites = () => this.loggedIn.sites();
    this.hooks.isUnlocked = (site) => this.loggedIn.isUnlocked(site);
    this.hooks.isLocked = (site) => this.loggedIn.isLocked(site);
    this.hooks.actionPolicy = makeHardStopPolicy({
      isLocked: (site) => this.loggedIn.isLocked(site),
      unlock: (site) => void this.loggedIn.setUnlocked(site, true),
      screenshot: (sessionId) => this.screenshot(sessionId, true),
      timeoutMs: deps.hardStopTimeoutMs,
    });
    // Phase C4: the session's own test daemon. Its origin is the session's own page (no site prompt,
    // never a logged-in site), and the only place `browser_evaluate` may run.
    this.testDaemons = new TestDaemonService({
      stateDir: deps.stateDir,
      ports: {
        proxyRunning: (sessionId) => this.proxies.running(sessionId),
        registerTestDaemon: (sessionId, port) => this.registerTestDaemon(sessionId, port),
        allowLoopbackPort: (sessionId, port) => this.allowLoopbackPort(sessionId, port),
        revokeLoopbackPort: (sessionId, port) => this.revokeLoopbackPort(sessionId, port),
      },
      onStopped: (sessionId, origin) => this.gate.ownOriginGone(sessionId, origin),
      notice: deps.notice,
      ...deps.testDaemon,
    });
    this.hooks.ownOrigin = (sessionId) => this.testDaemons.origin(sessionId);
    this.hooks.trafficSeq = () => this.trafficCounter;
    this.hooks.trafficSince = (sessionId, seq) => this.trafficSince(sessionId, seq);
    this.hooks.allowEvaluate = (info) => {
      const sessionId = info.ctx.session.id;
      const own = this.testDaemons.origin(sessionId);
      const st = this.gate.state(sessionId);
      // The TRACKED address of the current tab, and only when it is known: exactly this origin.
      if (!own || !st.currentUrl || st.unknown !== undefined || st.hold || st.closing) return false;
      try {
        return new URL(st.currentUrl).origin === own;
      } catch {
        return false;
      }
    };
  }

  /** Register the preset, the kind gate, the result hook and the protected rule. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    attach(this);
    this.testDaemons.reapOrphans(); // test daemons a crashed run of this daemon left behind
    this.unregister.push(() => detach(this), registerProtectedRule(this.protectedRule), registerProtectedRule(this.downloadsRule));
  }

  owns(integrationId: string): boolean {
    return this.deps.hasIntegration(integrationId);
  }

  stop(): void {
    for (const off of this.unregister.splice(0)) off();
    this.started = false;
    this.testDaemons.stopAll(); // before the proxies go: revoke, kill, delete
    this.proxies.stop("the daemon is shutting down");
    this.sites.stop();
    this.loggedIn.stop();
    try {
      this.ownerBrowser?.proc.kill();
    } catch {
      /* already gone */
    }
    this.ownerBrowser = undefined;
    this.runtimes.clear();
  }

  setFleet(link: BrowserFleetLink): void {
    this.selfPort = link.selfPort;
    this.sites.setFleet(link);
    this.loggedIn.setFleet(link);
  }

  // ── what the preset asks ────────────────────────────────────────────────────────────────────

  /** The operator pressed Check: try headed again, and re-prove the network block can run. */
  onCheck(): void {
    this.runtimeTried = false; // Check also retries a runtime install that failed (offline earlier)
    this.headedFailed = false;
    this.probed = undefined;
    this.proxies.recheck();
  }

  /** Headed or headless, and why. The desktop probe runs `scutil`, and this is read for every
   *  `mcp.integrations` row, so its answer is kept for a few seconds. */
  mode(): { mode: BrowserMode; reason: string } {
    const at = (this.deps.clock ?? Date.now)();
    if (!this.probed || at - this.probed.at >= DESKTOP_PROBE_TTL_MS || at < this.probed.at) {
      this.probed = { at, result: (this.deps.desktopProbe ?? defaultDesktopProbe)() };
    }
    return chooseBrowserMode(this.probed.result, this.headedFailed);
  }

  info(): BrowserIntegrationInfo {
    const m = this.mode();
    return {
      mode: m.mode,
      modeReason: m.reason,
      proxy: this.proxies.state(),
      runtime: this.runtimeInfo(),
      desktop: this.probed?.result.desktop === true,
      ...(this.ownerBrowser ? { ownerBrowser: { since: this.ownerBrowser.since } } : {}),
    };
  }

  // ── "Open agent browser" (Phase C3, item 29) ────────────────────────────────────────────────

  /** Whether the owner has the agent browser open right now. */
  ownerBrowserOpen(): boolean {
    return this.ownerBrowser !== undefined;
  }

  /**
   * Open the owner's own Chrome window on the agent profile, so they can log in to sites at the desk.
   * While it is open the browser is "in use by owner": every session's browser call is denied. When
   * that Chrome exits, every site that gained cookies becomes a logged-in site (locked).
   * @throws when nobody is logged in at this machine's screen, a session is using the browser, it is
   * already open, or Chrome is not installed.
   */
  openAgentBrowser(): void {
    if (this.ownerBrowser) throw new Error("the agent browser is already open on this machine");
    this.probed = undefined; // ask the screen now, not ten seconds ago
    this.mode();
    const probe = this.probed as { at: number; result: DesktopProbeResult } | undefined;
    if (!probe?.result.desktop) throw new Error(`the agent browser can only be opened where someone is logged in at the screen (${probe?.result.reason ?? "no desktop session"})`);
    if (this.deps.lockHeld?.()) throw new Error("a session is using the agent browser; try again when its turn ends");
    const chromePath = (this.deps.chromePath ?? installedChromePath)();
    if (!chromePath) throw new Error("Google Chrome is not installed on this machine");
    // The profile can be open in one Chrome only: sessions that left a headed browser open let go of it.
    for (const [sessionId, rt] of [...this.runtimes]) {
      if (rt.mode !== "headed") continue;
      if (!this.deps.dropIdleDriver(sessionId)) throw new Error("a session is using the agent browser; try again when its turn ends");
      this.gate.pageGone(sessionId);
      this.shots.delete(sessionId);
    }
    const since = (this.deps.clock ?? Date.now)();
    const run = runOwnerBrowser({
      stateDir: this.deps.stateDir,
      chromePath,
      env: { PATH: this.deps.childEnv.PATH, HOME: this.deps.childEnv.HOME, TMPDIR: this.deps.childEnv.TMPDIR },
      launcher: this.deps.agentBrowserLauncher,
      onClosed: (gained) => {
        this.ownerBrowser = undefined;
        for (const site of gained) {
          try {
            this.loggedIn.add(site, "login-session");
          } catch {
            /* not a site (a cookie for something that is not a hostname) */
          }
        }
        this.deps.statusChanged?.();
      },
    });
    this.ownerBrowser = { since, proc: run };
    this.ownerBrowserDone = run.done;
    this.deps.statusChanged?.();
  }
  /** Settles when the current (or last) "Open agent browser" session has been closed and recorded. */
  ownerBrowserDone: Promise<string[]> = Promise.resolve([]);

  // ── what the browser contacted (C3 review, item 1) ──────────────────────────────────────────

  private recordTraffic(sessionId: string, host: string, port: number): void {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    // The session's own test daemon is the session's own page.
    if (port === this.testDaemons.port(sessionId) && (h === "127.0.0.1" || h === "localhost" || h === "::1")) return;
    const site = registrableDomain(h);
    if (!site) return;
    let list = this.traffic.get(sessionId);
    if (!list) this.traffic.set(sessionId, (list = []));
    list.push({ seq: ++this.trafficCounter, site });
    if (list.length > 2000) this.trafficDropped.set(sessionId, list.splice(0, list.length - 1500).at(-1)!.seq);
  }

  /** The sites the session's browser contacted after `seq` (each once). When the bounded log no
   *  longer reaches back that far, `TRAFFIC_LOST_SITE` is reported too, and the gate fails closed on it
   *  (C4 review, item 2). */
  trafficSince(sessionId: string, seq: number): string[] {
    const out = new Set<string>();
    if ((this.trafficDropped.get(sessionId) ?? 0) > seq) out.add(TRAFFIC_LOST_SITE);
    for (const e of this.traffic.get(sessionId) ?? []) if (e.seq > seq) out.add(e.site);
    return [...out];
  }

  // ── the page screenshot (Phase C3) ──────────────────────────────────────────────────────────

  /**
   * The session's latest page screenshot as a card image. With `currentOnly`, only one that still
   * shows the page as it is: nothing that could change the page has run since, and the page is at
   * the same address. Saved as a session attachment the first time it is asked for.
   */
  screenshot(sessionId: string, currentOnly = false): ToolResultImage | undefined {
    const shot = this.shots.get(sessionId);
    if (!shot || !this.deps.saveImage) return undefined;
    const st = this.gate.state(sessionId);
    if (currentOnly && (shot.stale || st.unknown !== undefined || shot.url !== st.currentUrl)) return undefined;
    // The page may have changed itself since (C3 review, item 2): traffic to another site makes the
    // picture stale. Residual: a page can change its pixels without any network traffic.
    if (currentOnly) {
      let here: string | undefined;
      try {
        here = shot.url ? registrableDomain(new URL(shot.url).hostname) : undefined;
      } catch {
        here = undefined;
      }
      if (this.trafficSince(sessionId, shot.seq).some((s) => s !== here)) {
        shot.stale = true;
        return undefined;
      }
    }
    try {
      shot.attachmentId ??= this.deps.saveImage(sessionId, shot.mediaType, shot.dataBase64);
    } catch (e) {
      console.error(`[browser] could not save the page screenshot: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    return { attachmentId: shot.attachmentId, mediaType: shot.mediaType };
  }

  private noteShot(sessionId: string, rt: Runtime | undefined, result: Parameters<BrowserGate["onResult"]>[1]): void {
    const cls = classifyBrowserTool(result.tool, result.input);
    const read = "cls" in cls && cls.cls === "read";
    // Only browser_take_screenshot's own inline image is a picture of the page (C3 review item 2,
    // C4 review item 3).
    const image = result.tool === "browser_take_screenshot" && !result.isError ? resultImage(result.content) : undefined;
    if (image) this.shots.set(sessionId, { ...image, url: this.gate.state(sessionId).currentUrl, stale: false, seq: this.trafficCounter });
    else if (!read) {
      // A click, a key, a navigation, a resize…: whatever was photographed may look different now.
      const shot = this.shots.get(sessionId);
      if (shot) shot.stale = true;
    }
  }

  // ── downloads (Phase C3, item 30) ───────────────────────────────────────────────────────────

  private quarantineOptions() {
    return { maxBytes: this.deps.maxDownloadBytes, exclude: (worktree: string, entry: string) => void ensureGitExcluded(worktree, entry) };
  }

  private reportDownloads(sessionId: string, outcomes: DownloadOutcome[]): void {
    if (!outcomes.length) return;
    for (const o of outcomes) this.deps.notice(sessionId, downloadNotice(o));
    this.reports.set(sessionId, [...(this.reports.get(sessionId) ?? []), ...outcomes]);
  }

  private noteDownloads(sessionId: string, rt: Runtime | undefined, result: Parameters<BrowserGate["onResult"]>[1]): void {
    if (!rt) return;
    const asked = requestedOutputFiles(rt.worktree, result.input);
    if (asked.length) {
      let set = this.requested.get(sessionId);
      if (!set) this.requested.set(sessionId, (set = new Set()));
      for (const f of asked) set.add(f);
    }
    const outcomes: DownloadOutcome[] = [];
    for (const line of parseDownloadLines(toolResultText(result.content))) {
      const o = quarantineFile(rt.worktree, line.path, this.quarantineOptions());
      if (o) outcomes.push(o);
    }
    this.reportDownloads(sessionId, outcomes);
  }

  /** The session's turn ended: anything left in its output folder that is a download is dealt with. */
  onTurnEnd(sessionId: string): void {
    this.testDaemons.stop(sessionId, "the turn ended"); // Phase C4: a test daemon never outlives its turn
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    const since = this.sweptAt.get(sessionId);
    this.sweptAt.set(sessionId, Date.now());
    try {
      this.reportDownloads(sessionId, sweepOutputDir(rt.worktree, { ...this.quarantineOptions(), requested: this.requested.get(sessionId), ...(since !== undefined ? { since: since - 2000 } : {}) }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[browser] download sweep failed: ${msg}`);
      this.deps.notice(sessionId, `⚠️ _${msg.replace(/[`*_[\]<>]/g, "")}._`);
    }
  }

  /** Attach what happened to downloads to the verdict the model will see. */
  private withDownloadReport(sessionId: string, verdict: McpKindVerdict): McpKindVerdict {
    const outcomes = this.reports.get(sessionId);
    if (!outcomes?.length || !verdict) return verdict;
    const text = downloadContext(outcomes);
    if (verdict.kind === "allow") {
      this.reports.delete(sessionId);
      return { ...verdict, context: [verdict.context, text].filter(Boolean).join("\n\n") };
    }
    if (verdict.kind === "deny") {
      this.reports.delete(sessionId);
      return { ...verdict, reason: `${verdict.reason}\n\n${text}` };
    }
    return verdict; // a prompt: the report waits for the next call
  }

  // ── the pinned server runtime (runtime.ts) ──────────────────────────────────────────────────

  private nodePath(): string | undefined {
    if (this.deps.nodePath) return this.deps.nodePath();
    return resolveRealNode(resolveOnPath("node", this.deps.childEnv.PATH), join(this.deps.stateDir, BROWSER_STATE_DIRNAME), this.deps.childEnv);
  }

  runtimeInfo(): NonNullable<BrowserIntegrationInfo["runtime"]> {
    const problem = browserRuntimeProblem(this.deps.stateDir);
    if (!problem) return { state: "installed", package: PLAYWRIGHT_MCP_PACKAGE };
    if (this.runtimeInstall) return { state: "installing", package: PLAYWRIGHT_MCP_PACKAGE, reason: "installing the browser runtime" };
    return { state: "missing", package: PLAYWRIGHT_MCP_PACKAGE, reason: this.runtimeError ? `${problem}; the last install failed: ${this.runtimeError}` : problem };
  }

  /**
   * Install the pinned server runtime into the daemon's state folder (once; a call while one is in
   * flight shares it). Rejects with the reason when it cannot be installed (no network, a hash that
   * does not match the lock); the browser then stays unavailable.
   */
  installRuntime(): Promise<void> {
    if (!browserRuntimeProblem(this.deps.stateDir)) return Promise.resolve();
    if (this.runtimeInstall) return this.runtimeInstall;
    this.runtimeTried = true;
    const install =
      this.deps.runtimeInstaller ??
      ((stateDir: string) => {
        const npmPath = (this.deps.npmPath ?? (() => resolveOnPath("npm", this.deps.childEnv.PATH)))();
        if (!npmPath) throw new Error(`npm was not found on the PATH the browser is started with (${this.deps.childEnv.PATH})`);
        return installBrowserRuntime(stateDir, { npmPath, pathEnv: this.deps.childEnv.PATH, tmpdir: this.deps.childEnv.TMPDIR });
      });
    const run = (async () => {
      try {
        await install(this.deps.stateDir);
        const problem = browserRuntimeProblem(this.deps.stateDir);
        if (problem) throw new Error(problem);
        this.runtimeError = undefined;
      } catch (e) {
        this.runtimeError = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        this.runtimeInstall = undefined;
        this.deps.reprobe?.();
      }
    })();
    this.runtimeInstall = run;
    return run;
  }

  /** node, the pinned runtime, an installed Chrome, and a network block that can run. */
  health(): McpHealth {
    const path = this.deps.childEnv.PATH;
    const exists = this.deps.commandExists ?? ((c: string, p: string) => !!resolveOnPath(c, p));
    if (!exists("node", path) || !this.nodePath()) return { state: "unavailable", reason: `node was not found on the PATH the browser is started with (${path})` };
    const runtime = browserRuntimeProblem(this.deps.stateDir);
    if (runtime) {
      // The first time it is found missing the daemon installs it by itself; after a failure it waits
      // for Check or "Install browser runtime".
      if (!this.runtimeTried && !this.runtimeInstall) void this.installRuntime().catch(() => undefined);
      return {
        state: "unavailable",
        reason: this.runtimeInstall
          ? "the browser runtime is being installed into the daemon's state folder (one time)"
          : `${runtime}${this.runtimeError ? ` and could not be installed (${this.runtimeError})` : ""}. Press “Install browser runtime” in Settings → Integrations when this machine is online.`,
      };
    }
    if (!(this.deps.chromeInstalled ?? defaultChromeInstalled)()) return { state: "unavailable", reason: "Google Chrome is not installed on this machine" };
    const proxy = this.proxies.state();
    if (proxy.state !== "ready") return { state: "unavailable", reason: proxy.reason ?? "the browser's network block is not running" };
    return { state: "ready" };
  }

  /**
   * The launch line for one session. Starts (or reuses) the session's proxy listener first: with no
   * listener there is no launch line, so the browser cannot start without its network block. The
   * stored transport is ignored — every argument comes from `buildBrowserLaunch`, so an edited store
   * cannot add a flag.
   */
  resolveTransport(integration: McpIntegration, ctx: McpPresetContext): McpTransport | { skip: string } {
    const sessionId = ctx.session.id;
    const worktree = ctx.cwd;
    if (!worktree || !isAbsolute(worktree)) return { skip: "the session has no worktree" };
    // The output folder must be a real folder of this worktree, never a link out of it (C3 review, item 4).
    const outBad = outputDirProblem(worktree);
    if (outBad) return { skip: `the browser was not started: ${outBad}` };
    const proxy = this.proxies.ensure(sessionId);
    if ("error" in proxy) return { skip: proxy.error };

    // Checked before EVERY launch: the marker, the lock copy and the script of the daemon's runtime.
    const runtime = browserRuntimeProblem(this.deps.stateDir);
    if (runtime) return { skip: `${runtime} (press “Install browser runtime” in Settings → Integrations)` };
    const nodePath = this.nodePath();
    if (!nodePath || !isAbsolute(nodePath)) return { skip: "node was not found on the PATH the browser is started with" };
    const cliPath = browserRuntimeCli(this.deps.stateDir);

    const { mode } = this.mode();
    const launch = buildBrowserLaunch({ mode, proxyPort: proxy.port, worktree, stateDir: this.deps.stateDir, sessionId, nodePath, cliPath });
    const problems = presetArgProblems(launch, cliPath);
    if (problems.length) return { skip: `the browser's launch line failed its own check (${problems[0]})` };
    try {
      mkdirSync(dirname(launch.configPath), { recursive: true });
      writeFileSync(launch.configPath, `${JSON.stringify(launch.configJson, null, 2)}\n`);
      mkdirSync(launch.outputDir, { recursive: true });
      if (launch.profileDir) mkdirSync(launch.profileDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      return { skip: `could not prepare the browser's files: ${e instanceof Error ? e.message : String(e)}` };
    }
    ensureGitExcluded(worktree, `${BROWSER_OUTPUT_DIRNAME}/`);
    ensureGitExcluded(worktree, `${DOWNLOADS_DIRNAME}/`);
    if (!this.sweptAt.has(sessionId)) this.sweptAt.set(sessionId, Date.now());

    // A new server process means a new, empty browser: the old page (and any hold on it) is gone.
    this.gate.pageGone(sessionId);
    this.shots.delete(sessionId);
    this.runtimes.set(sessionId, { mode, integrationId: integration.id, worktree });
    return { type: "stdio", command: launch.command, args: launch.args };
  }

  // ── the gate ────────────────────────────────────────────────────────────────────────────────

  readonly kindGate = (ctx: McpKindGateContext): McpKindVerdict => {
    // "Open agent browser" is running: the profile is the owner's until they close that window.
    if (this.ownerBrowser) return { kind: "deny", reason: "the agent browser is in use by the owner (Open agent browser); it is free again when that Chrome window is closed" };
    const verdict = this.gate.gate(ctx);
    if (verdict?.kind !== "deny") this.retireOtherHeadedBrowsers(ctx.session.id);
    return this.withDownloadReport(ctx.session.id, this.withRefusals(ctx.session.id, verdict));
  };

  /**
   * Tell the model, with the verdict it is about to get, which requests the network block refused
   * since its last browser call. In the page a refusal looks like `HTTP status: 403` (http) or
   * `net::ERR_TUNNEL_CONNECTION_FAILED` (https); this says plainly that it was Anvil's policy.
   */
  private withRefusals(sessionId: string, verdict: McpKindVerdict): McpKindVerdict {
    const list = this.refusals.get(sessionId);
    if (!list?.length || !verdict || verdict.kind === "prompt") return verdict;
    this.refusals.delete(sessionId);
    const text = `Blocked by Anvil's network policy since your last browser call (the agent browser cannot reach private, local or fleet addresses; do not retry them): ${list.join("; ")}`;
    return verdict.kind === "allow" ? { ...verdict, context: text } : { ...verdict, reason: `${verdict.reason}\n\n${text}` };
  }

  /**
   * The headed profile can be open in one Chrome only, and a session's browser outlives its turn. So
   * when a session is about to use the headed browser, the idle drivers of the other sessions that
   * started one are dropped (their browsers close; their next turn starts a new one). A session that
   * is mid-turn is left alone — if it is using the browser, the exclusive lock has already refused
   * this call.
   */
  private retireOtherHeadedBrowsers(sessionId: string): void {
    if (this.runtimes.get(sessionId)?.mode !== "headed") return;
    for (const [other, rt] of [...this.runtimes]) {
      if (other === sessionId || rt.mode !== "headed") continue;
      if (this.deps.dropIdleDriver(other)) {
        this.runtimes.delete(other);
        this.gate.pageGone(other);
      }
    }
  }

  onToolResult(sessionId: string, result: Parameters<BrowserGate["onResult"]>[1]): void {
    const rt = this.runtimes.get(sessionId);
    const { purge } = this.gate.onResult(sessionId, result, rt?.mode ?? "headed");
    // The result showed a page the session may not see (a site that is not allowed): the snapshot
    // and screenshot files it wrote into the output folder are deleted before any tool can read them.
    if (purge && rt) this.purgeResultFiles(rt.worktree, toolResultText(result.content));
    try {
      this.noteShot(sessionId, rt, result);
      this.noteDownloads(sessionId, rt, result);
    } catch (e) {
      console.error(`[browser] result bookkeeping failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Item 34: a headed launch that fails falls back to headless from the next turn on. Only an ERROR
    // result whose `### Error` section starts with the launch call counts — text further in (a URL,
    // a page's own words) does not.
    if (rt?.mode === "headed" && result.isError && !this.headedFailed) {
      const text = toolResultText(result.content);
      if (/^\s*### Error[ \t]*\r?\n\s*(?:Error: )?browserType\.launch(?:PersistentContext)?\b/.test(text) && !/already in use/i.test(text.split(/\r?\n/).slice(0, 3).join("\n"))) {
        this.headedFailed = true;
        this.deps.notice(sessionId, "⚠️ _The headed browser could not start on this machine. From the next turn the agent browser runs headless with a throwaway profile; press Check in Settings → Integrations to try headed again._");
        this.deps.requestRebuild(sessionId);
      }
    }
  }

  /** Delete the files a result says it wrote, when they sit directly in this session's output folder. */
  private purgeResultFiles(worktree: string, text: string): void {
    let out: string;
    try {
      out = realpathSync(join(worktree, BROWSER_OUTPUT_DIRNAME));
    } catch {
      return;
    }
    for (const file of resultFileLinks(text)) {
      try {
        if (realpathSync(dirname(file)) === out) rmSync(file, { force: true });
      } catch {
        /* not there */
      }
    }
  }

  // ── session lifecycle ───────────────────────────────────────────────────────────────────────

  /** The session was reset, deleted or archived, or the browser was switched off for it. */
  forgetSession(sessionId: string): void {
    this.testDaemons.stop(sessionId, "the session was reset, deleted or lost its browser");
    this.runtimes.delete(sessionId);
    this.proxies.closeSession(sessionId);
    this.gate.forget(sessionId);
    this.refusals.delete(sessionId);
    this.shots.delete(sessionId);
    this.traffic.delete(sessionId);
    this.trafficDropped.delete(sessionId);
    this.requested.delete(sessionId);
    this.reports.delete(sessionId);
    this.sweptAt.delete(sessionId);
  }

  // ── Phase C4 ────────────────────────────────────────────────────────────────────────────────

  /**
   * The test-daemon launcher registers the port of the throwaway daemon it started for this session.
   * Only a registered port can be opened. Refused: this daemon's own port, a privileged port, a
   * browser proxy's port, a port registered for another session.
   */
  registerTestDaemon(sessionId: string, port: number): { ok: true } | { ok: false; reason: string } {
    return this.proxies.registerTestDaemon(sessionId, port);
  }
  /** Let this session's browser reach its registered test daemon's port. False when the session has
   *  no running proxy or the port was not registered for it. */
  allowLoopbackPort(sessionId: string, port: number): boolean {
    return this.proxies.allowLoopbackPort(sessionId, port);
  }
  /** Close it again (open connections to it are dropped) and forget the registration; with no port,
   *  everything the session has. */
  revokeLoopbackPort(sessionId: string, port?: number): void {
    this.proxies.revoke(sessionId, port);
  }

  /** Quarantined downloads are never executed. (One function per service, so that one daemon
   *  stopping does not remove the rule for another in the same process.) */
  private readonly downloadsRule: ProtectedRule = (ctx) => downloadsProtectedRule(ctx);

  // ── protected files ─────────────────────────────────────────────────────────────────────────

  /**
   * The agent's own Bash and file tools may not touch the browser's profile, the allowed-sites list
   * or the generated configs. A tripwire, not a sandbox: the agent runs as the daemon's user (§6).
   */
  private readonly protectedRule: ProtectedRule = (ctx) => {
    const guarded = [browserProfileDir(this.deps.stateDir), join(this.deps.stateDir, BROWSER_SITES_FILE), join(this.deps.stateDir, BROWSER_LOGGEDIN_FILE), join(this.deps.stateDir, BROWSER_STATE_DIRNAME)];
    const reason = "the agent browser's profile, its allowed-sites and logged-in-sites lists and its launch files are off limits to the session";
    if (ctx.tool === "Bash") {
      const cmd = typeof ctx.input.command === "string" ? ctx.input.command : "";
      const api = daemonApiCommandProblem(cmd, this.selfPort);
      if (api) return { kind: "deny", reason: api };
      if (guarded.some((p) => cmd.includes(p)) || /\bbrowser-profile\b|\bbrowser-sites\.json\b|\bbrowser-loggedin\.json\b/.test(cmd)) return { kind: "deny", reason };
      return undefined;
    }
    // Every tool that names a path, resolved by Track A's shared resolver (`~` as the CLI expands it,
    // symlinks followed, case-insensitive): the same file the tool would touch.
    for (const key of ["file_path", "path", "notebook_path"]) {
      const r = resolveToolPath(ctx.input[key], ctx.cwd);
      if (!r) continue;
      if (!r.ok) return { kind: "deny", reason: r.reason };
      if (guarded.some((p) => isUnder(r.abs, realish(p)))) return { kind: "deny", reason };
      // `.anvil-browser/` (the browser's output folder, C4 review item 3) is denied to the file tools
      // by the ONE state-folder rule (agent/state-protected.ts), registered with the browser feature.
    }
    return undefined;
  };
}
