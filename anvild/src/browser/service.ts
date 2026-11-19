/**
 * The agent browser on one daemon (agent-cad-and-browser Phase C2): owns the per-session proxies,
 * the allowed-sites list and its sync, the per-session approval state, and registers the `browser`
 * preset, its kind gate, its result hook and a protected rule for its files.
 *
 * Created by `McpIntegrationService` only when BOTH the "mcp-integrations" and the "browser" features
 * are on. Without it nothing here exists: the preset is not registered (so `mcp.integration.add`
 * refuses the kind), no proxy listens and nothing is written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { BrowserIntegrationInfo, McpHealth, McpIntegration, McpTransport, ServerEvent } from "@protocol";
import type { McpChildEnv } from "../agent/mcp-external";
import { registerMcpKindGate, registerMcpKindResultHook, type McpKindGateContext, type McpKindVerdict } from "../agent/mcp-gate";
import { registerProtectedRule, type ProtectedRule } from "../agent/protected";
import { resolveOnPath } from "../mcp/health";
import { registerMcpPreset, type McpPreset, type McpPresetContext } from "../mcp/presets";
import { BrowserGate, type BrowserGateHooks } from "./gate";
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
import { BrowserProxyManager, ownHosts, type BrowserProxyOptions, type ProxyFactory, type ProxyResolver } from "./proxy";
import { BROWSER_SITES_FILE, toolResultText } from "./sites";
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
  /** Allowed-sites sync timer; 0 = none. */
  sitesIntervalMs?: number;
}

/** The entry "Add → Browser" creates. Every field but `label` and `enabled` is fixed by the preset. */
export function browserIntegrationDefaults(): Omit<McpIntegration, "id"> {
  return { key: BROWSER_KEY, kind: "browser", label: "Browser", transport: { type: "stdio", command: BROWSER_COMMAND, args: ["-y", PLAYWRIGHT_MCP_PACKAGE] }, exclusive: true, enabled: true };
}

const CHROME_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")];
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
  readonly gate: BrowserGate;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly unregister: (() => void)[] = [];
  private headedFailed = false;
  private started = false;
  private probed: { at: number; result: DesktopProbeResult } | undefined;

  constructor(private readonly deps: BrowserServiceDeps) {
    this.sites = new AllowedSitesService({ stateDir: deps.stateDir, broadcast: deps.broadcast, clock: deps.clock, fetchImpl: deps.fetchImpl, intervalMs: deps.sitesIntervalMs });
    this.proxies = new BrowserProxyManager(
      {
        resolve: deps.resolver,
        fleetHosts: () => this.sites.fleetHosts(),
        selfHosts: deps.selfHosts ?? ownHosts,
        onDecision: deps.onProxyDecision,
      },
      deps.proxyFactory,
    );
    this.gate = new BrowserGate({
      isSiteAllowed: (site) => this.sites.isAllowed(site),
      allowSiteAlways: (site) => void this.sites.add(site),
      runtime: (sessionId) => {
        const rt = this.runtimes.get(sessionId);
        return rt ? { mode: rt.mode, proxyRunning: this.proxies.running(sessionId) } : undefined;
      },
      hooks: this.hooks,
    });
  }

  /** Register the preset, the kind gate, the result hook and the protected rule. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    attach(this);
    this.unregister.push(() => detach(this), registerProtectedRule(this.protectedRule));
  }

  owns(integrationId: string): boolean {
    return this.deps.hasIntegration(integrationId);
  }

  stop(): void {
    for (const off of this.unregister.splice(0)) off();
    this.started = false;
    this.proxies.stop("the daemon is shutting down");
    this.sites.stop();
    this.runtimes.clear();
  }

  setFleet(link: BrowserFleetLink): void {
    this.sites.setFleet(link);
  }

  // ── what the preset asks ────────────────────────────────────────────────────────────────────

  /** The operator pressed Check: try headed again, and re-prove the network block can run. */
  onCheck(): void {
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
    return { mode: m.mode, modeReason: m.reason, proxy: this.proxies.state() };
  }

  /** Beyond "npx is on PATH": node, an installed Chrome, and a network block that can run. */
  health(): McpHealth {
    const path = this.deps.childEnv.PATH;
    const exists = this.deps.commandExists ?? ((c: string, p: string) => !!resolveOnPath(c, p));
    for (const cmd of [BROWSER_COMMAND, "node"]) {
      if (!exists(cmd, path)) return { state: "unavailable", reason: `${cmd} was not found on the PATH the browser is started with (${path})` };
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
    const proxy = this.proxies.ensure(sessionId);
    if ("error" in proxy) return { skip: proxy.error };

    const { mode } = this.mode();
    const launch = buildBrowserLaunch({ mode, proxyPort: proxy.port, worktree, stateDir: this.deps.stateDir, sessionId });
    const problems = presetArgProblems(launch);
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

    // A new server process means a new, empty browser: the old page (and any hold on it) is gone.
    this.gate.pageGone(sessionId);
    this.runtimes.set(sessionId, { mode, integrationId: integration.id });
    return { type: "stdio", command: launch.command, args: launch.args };
  }

  // ── the gate ────────────────────────────────────────────────────────────────────────────────

  readonly kindGate = (ctx: McpKindGateContext): McpKindVerdict => {
    const verdict = this.gate.gate(ctx);
    if (verdict?.kind !== "deny") this.retireOtherHeadedBrowsers(ctx.session.id);
    return verdict;
  };

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
    this.gate.onResult(sessionId, result, rt?.mode ?? "headed");
    // Item 34: a headed launch that fails falls back to headless from the next turn on.
    if (rt?.mode === "headed" && result.isError && !this.headedFailed) {
      const text = toolResultText(result.content);
      if (/browserType\.launch|Failed to launch|launchPersistentContext/i.test(text) && !/already in use/i.test(text)) {
        this.headedFailed = true;
        this.deps.notice(sessionId, "⚠️ _The headed browser could not start on this machine. From the next turn the agent browser runs headless with a throwaway profile; press Check in Settings → Integrations to try headed again._");
        this.deps.requestRebuild(sessionId);
      }
    }
  }

  // ── session lifecycle ───────────────────────────────────────────────────────────────────────

  /** The session was reset, deleted or archived, or the browser was switched off for it. */
  forgetSession(sessionId: string): void {
    this.runtimes.delete(sessionId);
    this.proxies.closeSession(sessionId);
    this.gate.forget(sessionId);
  }

  // ── Phase C4 ────────────────────────────────────────────────────────────────────────────────

  /** Let this session's browser reach one loopback port (its throwaway test daemon). False when the
   *  session has no running proxy. */
  allowLoopbackPort(sessionId: string, port: number): boolean {
    return this.proxies.allowLoopbackPort(sessionId, port);
  }
  /** Close it again; with no port, every exemption the session has. */
  revokeLoopbackPort(sessionId: string, port?: number): void {
    this.proxies.revoke(sessionId, port);
  }

  // ── protected files ─────────────────────────────────────────────────────────────────────────

  /**
   * The agent's own Bash and file tools may not touch the browser's profile, the allowed-sites list
   * or the generated configs. A tripwire, not a sandbox: the agent runs as the daemon's user (§6).
   */
  private readonly protectedRule: ProtectedRule = (ctx) => {
    const guarded = [browserProfileDir(this.deps.stateDir), join(this.deps.stateDir, BROWSER_SITES_FILE), join(this.deps.stateDir, BROWSER_STATE_DIRNAME)];
    const reason = "the agent browser's profile, allowed-sites list and launch files are off limits to the session";
    if (ctx.tool === "Bash") {
      const cmd = typeof ctx.input.command === "string" ? ctx.input.command : "";
      if (guarded.some((p) => cmd.includes(p)) || /\bbrowser-profile\b|\bbrowser-sites\.json\b/.test(cmd)) return { kind: "deny", reason };
      return undefined;
    }
    for (const key of ["file_path", "path", "notebook_path"]) {
      const v = ctx.input[key];
      if (typeof v !== "string" || !v) continue;
      const abs = resolve(ctx.cwd, v);
      if (guarded.some((p) => abs === p || abs.startsWith(p + sep))) return { kind: "deny", reason };
    }
    return undefined;
  };
}
