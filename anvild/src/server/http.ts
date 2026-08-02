import type { ServerWebSocket } from "bun";
import type { rest, PermissionDecision } from "@protocol";
import { UPDATE_API_VERSION } from "@protocol";
import { AccountStore, resolveAuthStatus } from "../auth/accounts";
import { newId } from "../util/ids";
import { dispatch } from "./dispatch";
import { ConnectionRegistry } from "./registry";
import { isAllowedWsOrigin, configuredAllowedOrigins } from "./origin";
import { loadServerIdentity, serverHelloEvent, SERVER_CAPABILITIES } from "./identity";
import { ackPair, discoverFleet, invitePeer, peerIPv4, planMemberUrlHeals, propagateTodoist, resolveMember, rotateToken, tailnetPeers } from "./fleet";
import {
  DEFAULT_ARM_TTL_MS,
  isLocalNoIdentityCaller,
  PairedHubStore,
  PairingWindow,
  resolveCallerIdentity,
  tailscaleSelfLogin,
  tailscaleWhois,
  type PeerTrust,
} from "./pairing";
import { bindDegradeStateDir } from "../auth/degrade";
import { setClaudeToken } from "../auth/store";
import { setOpenRouterKey } from "../auth/openrouter";
import { FleetStore } from "../fleet/store";
import { PushRegistry } from "../push/registry";
import { Supervisor } from "../session/supervisor";
import { UpdateStateStore } from "../daemon/update-state";
import { updateApply, updateCheck, updateStatus, settleAfterBoot, type UpdateApiDeps } from "../daemon/update-api";
import { isManaged, scheduleRestart, webBundleOk } from "../daemon/selfupdate";
import { FleetRolloutCoordinator, DesiredTargetStore, httpMemberUpdateClient } from "./fleet-rollout";
import { FleetJobs } from "./fleet-jobs";
import { resolveTargetSha } from "../daemon/selfupdate";
import { FileExists } from "../fs/session-fs";
import type { MarkdownRenderer } from "../render/markdown";
import type { ConnState } from "./connection";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { VERSION } from "../version";

export { VERSION };

// The built web client (anvild/web/dist), resolved relative to this source file. When packaged via
// `bun build --compile`, import.meta.dir points into the read-only $bunfs, so the launcher sets
// ANVIL_WEB_DIR to the bundle's web/dist on disk (Phase 0/B — anvil-server-app.md §3.1).
const WEB_DIR = process.env.ANVIL_WEB_DIR || join(import.meta.dir, "..", "..", "web", "dist");

// CSP for the app shell. Mermaid + the markdown body run here, but all markdown HTML is
// DOMPurify-sanitized server-side (arch §8.3); scripts are limited to our own bundle.
const CSP = [
  "default-src 'self'",
  // Attachment images for a member-hosted session render from that member's REST URL
  // (https://member:7701/api/…/attachments/<id>) — cross-origin, on a non-default port — so the same
  // *.ts.net:* host-sources as connect-src below are needed, or the <img> is blocked and shows broken.
  "img-src 'self' data: https://*.ts.net:* http://*.ts.net:*",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // Shiki/KaTeX/mermaid + Material Symbols (CDN)
  "script-src 'self'",
  // 'self' = the hub's own daemon; the *.ts.net entries let the hub web app federate other servers on
  // the tailnet. Both http/ws (daemons bound directly to the tailnet IP) and https/wss (behind
  // `tailscale serve`) are allowed (fleet — anvil-multi-server.md §4.1/§5.1).
  // The `:*` port wildcard is REQUIRED: members serve on non-default ports (:7701, :7702), and a CSP
  // host-source with no port only matches the scheme default (443/80) — so https://*.ts.net would
  // silently block an upload to https://member:7701/api/…/attachments. WebSockets dodge this via the
  // bare ws:/wss: scheme-sources (any host/port), which is why text worked but REST uploads didn't.
  "connect-src 'self' ws: wss: http://*.ts.net:* ws://*.ts.net:* https://*.ts.net:* wss://*.ts.net:*",
  "font-src 'self' https://fonts.gstatic.com", // Material Symbols woff2 from Google's CDN (bundled in native apps)
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/** This host's non-internal IPv4 addresses (so the phone can be put on the same subnet). */
function lanIPv4(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}
const adbTarget = (host: string, port: number): string => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);

// [BE-14] adb connect/pair reach out over the network and can hang for seconds. Run async with a
// timeout so an ADB call can't freeze the single-threaded daemon (and every other client) — the old
// Bun.spawnSync blocked the whole event loop for the call's duration.
const ADB_TIMEOUT_MS = 15_000;

/** Run `adb` (from PATH or the common SDK locations); returns its combined output. */
async function runAdb(args: string[]): Promise<{ ok: boolean; output: string }> {
  const home = process.env.HOME ?? "";
  const candidates = ["adb", "/opt/homebrew/bin/adb", "/usr/local/bin/adb", join(home, "Library/Android/sdk/platform-tools/adb"), join(home, "Android/Sdk/platform-tools/adb")];
  for (const adb of candidates) {
    try {
      // A missing binary throws synchronously (ENOENT) → try the next path. A present-but-slow adb is
      // killed by the timeout signal; its reads still resolve with whatever it emitted (ok=false).
      const p = Bun.spawn([adb, ...args], { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(ADB_TIMEOUT_MS) });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      const output = `${out}${err}`.trim();
      return { ok: /connected to/i.test(output) && !/failed|cannot|unable/i.test(output), output: output || "(no output)" };
    } catch {
      /* not at this path — try the next */
    }
  }
  return { ok: false, output: "adb not found on the server (install Android platform-tools)" };
}

/**
 * Cache-Control for a served web asset. The mutable app shell — index.html, main.js, app.css, sw.js,
 * manifest, vendored css — lives at STABLE, unhashed URLs, so it MUST revalidate on every load: with
 * no directive the browser heuristically caches it and a new deploy is invisible (the daemon serves
 * fresh bytes but the browser keeps the old main.js across git pull / restart / hard refresh — and,
 * because the service worker's fetch reads through the HTTP cache, the stale bundle is sticky). Only
 * Bun's content-hashed split chunks and binary font/image assets are safe to cache hard.
 */
export function webCacheControl(rel: string): string {
  if (/(^|\/)chunk-[A-Za-z0-9]+\.js$/.test(rel)) return "public, max-age=31536000, immutable";
  if (/\.(woff2?|ttf|otf|svg|png|ico)$/.test(rel)) return "public, max-age=604800";
  return "no-cache"; // revalidate every load — never serve a stale app shell
}

/** The self-closing HTML page shown after a lapo OAuth redirect. Kept dependency-free (no bundle, no
 *  CSP concerns) — just a status line and a best-effort auto-close, since the app updates off the
 *  broadcast lapo.status regardless of what this popup does. */
function lapoCallbackPage(ok: boolean, message: string): Response {
  const safe = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>lapo — ${ok ? "connected" : "error"}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#0b0d12;color:#e6e8ee}
.card{max-width:22rem;padding:1.5rem 1.75rem;border-radius:12px;background:#151824;text-align:center}
.mark{font-size:2rem}.msg{margin:.5rem 0 0;color:#aab}.hint{margin-top:1rem;font-size:.85rem;color:#788}</style></head>
<body><div class="card"><div class="mark">${ok ? "✅" : "⚠️"}</div>
<h2 style="margin:.5rem 0 0">lapo ${ok ? "connected" : "couldn't connect"}</h2>
<p class="msg">${safe}</p>
<p class="hint">You can close this window and return to Anvil.</p></div>
<script>setTimeout(function(){try{window.close()}catch(e){}},${ok ? 1500 : 6000})</script></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Serve a file from the built web client; `/` → index.html. Returns null if not found. */
async function serveWeb(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = join(WEB_DIR, rel);
  if (!filePath.startsWith(WEB_DIR)) return null; // path-traversal guard
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  const headers: Record<string, string> = { "Cache-Control": webCacheControl(rel) };
  if (filePath.endsWith(".html")) headers["Content-Security-Policy"] = CSP;
  return new Response(file, { headers });
}

export interface ServerHandle {
  port: number;
  stop: () => void;
  /** Graceful shutdown: flush + reap drivers/terminals, then stop the HTTP server (arch §5). */
  shutdown: () => Promise<void>;
}

export interface ServerOptions {
  host?: string;
  port: number;
  stateDir: string;
  /** The Claude account roster (multi-account §3). The real daemon (main.ts) constructs it before the
   *  §3 guard so the boot migration runs first, and passes it in so there is exactly one instance per
   *  process. Tests that don't care about accounts may omit it — one is constructed over `stateDir`. */
  accounts?: AccountStore;
  /** Where the roster's default account is mirrored. Defaults to the real `~/.config/anvil/env`;
   *  override in tests so the suite can't overwrite a developer's own Claude credential. */
  envFile?: string;
  /** Clone destination for repos added by git URL (see `Config.clonesDir`). Defaults to `<stateDir>/repos`. */
  clonesDir?: string;
  warnFraction?: number;
  softStopFraction?: number;
  renderer?: MarkdownRenderer;
  /** OpenRouter key + models for the adversarial planning panel (see `Config`). */
  adversarialModels?: string[];
  adversarialProvider?: string;
  /** Set by the real daemon (main.ts) to refresh model labels from the Models API shortly after boot;
   *  omitted by tests so they never make a live API call. */
  refreshModelLabelsOnBoot?: boolean;
  /** [BE2-15] Test-only injection of the fleet fan-out network calls (rotate/invite jobs), so the job
   *  guard tests can simulate a slow/unreachable member deterministically. Production omits it and
   *  gets the real implementations from ./fleet. */
  fleetNet?: Partial<FleetNetOps>;
  /** [BE2-15] Test-only override of the caller-identity resolver (the real one shells out to the
   *  tailscale CLI, which makes identity-gated routes untestable hermetically). */
  resolveIdentity?: () => Promise<{ trust: PeerTrust; reject?: string }>;
}

/** The fleet fan-out network surface the rotate/invite paths reach the tailnet through ([BE2-15]). */
export interface FleetNetOps {
  rotateToken: typeof rotateToken;
  invitePeer: typeof invitePeer;
  resolveMember: typeof resolveMember;
  peerIPv4: typeof peerIPv4;
  ackPair: typeof ackPair;
}

/**
 * The HTTP/WS server (arch §6). `fetch` serves the REST control plane (`/api/health`) and
 * upgrades `/ws`; on open it sends the connecting client a `session.list`; `message` hands
 * frames to the dispatcher. Returns a handle so tests can start it on an ephemeral port
 * (`port: 0`) against a temp `stateDir` and stop it.
 */
export function createServer(opts: ServerOptions): ServerHandle {
  const identity = loadServerIdentity(opts.stateDir);
  // [BE2-15] The fleet fan-out's network calls, swappable by tests (see ServerOptions.fleetNet).
  const net: FleetNetOps = { rotateToken, invitePeer, resolveMember, peerIPv4, ackPair, ...opts.fleetNet };
  // [BE2-15] Rotate/invite run as background jobs so the POST never holds a socket open for the whole
  // fan-out (an offline member burns ~14s of pairing timeouts). Clients poll /api/fleet/jobs/:id.
  const fleetJobs = new FleetJobs();
  const accounts = opts.accounts ?? new AccountStore(opts.stateDir);
  const fleet = new FleetStore(opts.stateDir);
  // Bind the degrade marker's home so a credential write from ANY path (a direct paste via
  // `setClaudeToken`, a pair, a rotation) clears it without threading a state dir through (§4.6).
  bindDegradeStateDir(opts.stateDir);
  /** This machine's join window — default closed, armed only by a human in its own UI (§5.1/§8.2). */
  const pairWindow = new PairingWindow();
  /** The hub this machine was joined by, for rotation gating only (HJ-26). */
  const pairedHub = new PairedHubStore(opts.stateDir);
  const registry = new ConnectionRegistry();
  const push = new PushRegistry();
  const supervisor = new Supervisor(
    {
      stateDir: opts.stateDir,
      port: opts.port,
      accounts,
      pairedHub,
      // Lazy on purpose: `pushRosterInBackground` closes over `fleet`/`accounts`/`identity`, all of
      // which exist by the time a mutation can fire, but the function itself is hoisted below this
      // constructor call.
      onRosterChanged: (reason) => pushRosterInBackground(reason),
      envFile: opts.envFile,
      clonesDir: opts.clonesDir,
      warnFraction: opts.warnFraction,
      softStopFraction: opts.softStopFraction,
      renderer: opts.renderer,
      adversarialModels: opts.adversarialModels,
      adversarialProvider: opts.adversarialProvider,
      refreshModelLabelsOnBoot: opts.refreshModelLabelsOnBoot,
    },
    registry,
  );

  // Frozen update API v1 (stable-update-service spec §4.3). The state store persists the pre-pull SHA +
  // phase across the very restart it coordinates; `settleAfterBoot` is the in-daemon half of the
  // resilience model — if we just came up on the target build with a servable bundle, mark the update
  // healthy and adopt this SHA as the new known-good.
  const updateState = new UpdateStateStore(opts.stateDir);
  const updateDeps: UpdateApiDeps = { state: updateState, webDir: WEB_DIR, isManaged, scheduleRestart };
  settleAfterBoot(updateDeps);

  // Hub-orchestrated fleet rollout (spec §4.4): pins one SHA, fans it out to reachable members over the
  // frozen API, updates the hub itself last. The desired target persists so a member that was offline is
  // reconciled when it reconnects.
  const fleetRollout = new FleetRolloutCoordinator({
    self: { serverId: identity.serverId, serverName: identity.serverName },
    members: () => fleet.list().map((m) => ({ serverId: m.serverId, serverName: m.serverName, url: m.url })),
    resolveTargetSha: () => resolveTargetSha(),
    applySelf: async (targetSha) => {
      const r = await updateApply({ targetSha }, updateDeps);
      return { ok: r.ok, error: r.error };
    },
    client: httpMemberUpdateClient(),
    desired: new DesiredTargetStore(opts.stateDir),
  });

  // The bundled native clients serve their UI from a local origin and call the daemon's REST API
  // cross-origin, so /api/* needs permissive CORS. (The daemon is Tailscale-gated; no cookies are
  // used, so `*` is safe.) The PWA is same-origin and unaffected.
  const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };

  // Replicate this hub's Todoist token to member daemons so autopilot can run where each repo lives
  // (anvil-multi-server.md). `targets` = member serverIds; omit for all. No-op on a leaf member (its
  // fleet is empty) or before a token is set. Fire-and-forget + idempotent — members heal on reconnect.
  // Remember the token last *successfully* pushed to each member (by serverId), so a repeated trigger
  // doesn't re-POST an unchanged token to the whole fleet. The client re-sends `todoist.connect` on every
  // socket open, and a hub restart storm makes that fire on every reconnect — which otherwise produced
  // hundreds of identical "[todoist] replicated token" lines and a burst of outbound HTTPS per restart. A
  // member is only pushed when its token actually changes or it was never reached; a failed push isn't
  // recorded, so an offline member still heals on its next reconnect.
  const lastPropagated = new Map<string, string>(); // serverId → token last confirmed on that member
  function pushTodoist(targets?: string[]): void {
    const token = supervisor.todoistTokenForFleet();
    if (!token) return;
    const members = fleet
      .list()
      .filter((m) => (!targets || targets.includes(m.serverId)) && lastPropagated.get(m.serverId) !== token);
    if (members.length === 0) return;
    const serverIdByUrl = new Map(members.map((m) => [m.url, m.serverId]));
    void propagateTodoist({ members, token }).then((results) => {
      for (const r of results) {
        if (!r.ok) {
          console.warn(`[todoist] replication to ${r.url} failed: ${r.error ?? "unknown"}`);
          continue;
        }
        // Record success under the member's *real* serverId (the member self-reports it; the stored
        // record may still hold a legacy bare-host id until the heal below runs) so the dedup filter
        // above matches on the next trigger.
        const sid = r.serverId ?? serverIdByUrl.get(r.url);
        if (sid) lastPropagated.set(sid, token);
        console.log(`[todoist] replicated token → ${r.resolvedUrl ?? r.url}${r.account ? ` (${r.account})` : ""}`);
        // Heal the stored fleet record from what actually answered: the working transport (e.g.
        // http→https once the member enabled `tailscale serve`) and the member's real serverId (legacy
        // records stored the bare host, which breaks targeted propagation). Future pushes/management
        // then hit the right URL and match the right id without a re-pair.
        const stored = fleet.list().find((m) => m.url === r.url);
        if (!stored) continue;
        const healedUrl = r.resolvedUrl ?? stored.url;
        const healedServerId = r.serverId ?? stored.serverId;
        const healedServerName = r.serverName || stored.serverName;
        if (healedUrl !== stored.url || healedServerId !== stored.serverId || healedServerName !== stored.serverName) {
          fleet.upsert({ ...stored, url: healedUrl, serverId: healedServerId, serverName: healedServerName });
          if (healedUrl !== stored.url) console.log(`[fleet] healed member URL ${stored.url} → ${healedUrl}`);
          if (healedServerId !== stored.serverId) console.log(`[fleet] healed member serverId ${stored.serverId} → ${healedServerId}`);
        }
      }
    });
  }

  /**
   * Push this hub's credential + account roster to every member (multi-account §7.3). One path for
   * both the explicit "Sync now" button (/api/fleet/rotate) and the automatic push fired after every
   * roster mutation, so a manual retry can't diverge from what the automatic one sends.
   *
   * Capabilities are re-probed per member inside `rotateToken` (not read from the stored record), so a
   * member that upgraded after joining starts receiving rotation on :7701 — and the roster — without a
   * re-pair. On success the confirmed `rev` is recorded on that member's FleetMember so the Servers tab
   * can show in-sync / out-of-date per Mac.
   */
  async function pushRosterToMembers(): Promise<{ host: string; ok: boolean; error?: string; accountsRev?: number }[]> {
    const members = fleet.list();
    if (members.length === 0) return [];
    const payload = accounts.payload();
    const results = await net.rotateToken({
      members,
      token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
      hubServerId: identity.serverId,
      ...(payload ? { accounts: payload } : {}),
      port: opts.port,
    });
    for (const r of results) {
      if (r.accountsRev === undefined) continue;
      const stored = fleet.list().find((m) => m.host === r.host); // re-read: a concurrent heal may have moved it
      if (stored && stored.accountsRev !== r.accountsRev) fleet.upsert({ ...stored, accountsRev: r.accountsRev });
    }
    return results;
  }

  /** Fire-and-forget roster replication after a hub-side mutation. Logged, never thrown: a member being
   *  offline must not fail the mutation the user just made — the Servers tab shows it out of date and
   *  "Sync now" repairs it. No-op on a machine with no members (a leaf, or a standalone box). */
  function pushRosterInBackground(reason: string): void {
    if (fleet.list().length === 0) return;
    void pushRosterToMembers()
      .then((results) => {
        const okN = results.filter((r) => r.ok).length;
        if (okN < results.length) {
          const failed = results.filter((r) => !r.ok).map((r) => `${r.host} (${r.error ?? "unknown"})`);
          console.warn(`[fleet] roster push after ${reason}: ${okN}/${results.length} ok — failed: ${failed.join(", ")}`);
        } else {
          console.log(`[fleet] roster push after ${reason}: ${okN}/${results.length} ok`);
        }
      })
      .catch((e: unknown) => console.warn(`[fleet] roster push after ${reason} failed: ${e instanceof Error ? e.message : e}`));
  }

  // Re-resolve member records that never got a real identity at invite time. A `serverId` that isn't a
  // `srv_…` id is a legacy/unresolved record (the :7702 pairing outcome can omit one, so we fell back to
  // the bare host) — and those records also tend to carry a stale `http://` url even though the member
  // serves HTTPS behind `tailscale serve`. That stale scheme silently strands HTTP-page clients: the web
  // client only force-upgrades a member URL to https/wss when the *page itself* is https (securePageUrl /
  // serverWsUrl), so a client loaded over plain http (e.g. an iPad hitting the hub on the LAN) dials the
  // stored `http://` member, gets "Client sent an HTTP request to an HTTPS server", and the member never
  // connects — so its sessions never render and it appears missing. Re-probe https-then-http (a genuinely
  // http-only member stays http) and heal url + serverId so every client, on any page protocol, gets the
  // scheme the member actually answers on. Cheap: only unresolved records are probed, and once healed to a
  // real `srv_…` id they're skipped forever.
  // [BE2-10] Throttled + fully defensive. This used to be `await`ed on every GET /api/fleet/members with
  // no throttle, and a single malformed stored `m.url` made `new URL(...)` throw THROUGH `Promise.all`,
  // so the endpoint 500'd forever (until fleet.json was hand-edited). Now it is fire-and-forget
  // (`void`ed at the call site), throttled like healFleetUrlsByDiscovery, and every per-member step is
  // wrapped so one bad record can never reject the whole pass.
  let lastStaleHealAt = 0;
  async function healStaleFleetRecords(): Promise<void> {
    const stale = fleet.list().filter((m) => !m.serverId.startsWith("srv_"));
    if (stale.length === 0) return;
    const nowMs = Date.now();
    if (nowMs - lastStaleHealAt < 20_000) return; // bound the probe cost across a client's polling
    lastStaleHealAt = nowMs;
    await Promise.all(
      stale.map(async (m) => {
        try {
          let port = opts.port;
          try {
            port = Number(new URL(m.url).port) || opts.port; // a torn/legacy url must not throw the pass
          } catch {
            /* malformed stored url — fall back to the default port and still try to heal */
          }
          const r = await net.resolveMember(m.host, port);
          const healedUrl = r.url || m.url;
          const healedServerId = r.serverId ?? m.serverId;
          const healedServerName = r.serverName || m.serverName;
          if (healedUrl === m.url && healedServerId === m.serverId && healedServerName === m.serverName) return;
          fleet.upsert({ ...m, url: healedUrl, serverId: healedServerId, serverName: healedServerName });
          if (healedUrl !== m.url) console.log(`[fleet] healed member URL ${m.url} → ${healedUrl}`);
          if (healedServerId !== m.serverId) console.log(`[fleet] healed member serverId ${m.serverId} → ${healedServerId}`);
        } catch (e) {
          console.warn(`[fleet] heal of ${m.host} failed (ignored): ${e instanceof Error ? e.message : e}`);
        }
      }),
    );
  }

  // A member paired under a MagicDNS name goes dark the moment the tailnet disables MagicDNS: its stored
  // `https://name.ts.net:7701` no longer resolves, so every client renders it disconnected and there's no
  // name to re-probe. `healStaleFleetRecords` can't help — it dials the same dead name. This pass instead
  // runs a full discovery (which now reaches IP-only peers over `http://<tailnet-ip>`), correlates by
  // serverId, and rewrites any member's url to the address that actually answered — so clients reconnect
  // and token propagation (memberBases re-derives the host from the url) targets the live IP. Throttled and
  // fire-and-forget: discovery probes every online peer, so we never block the members GET on it.
  let lastUrlHealAt = 0;
  async function healFleetUrlsByDiscovery(): Promise<void> {
    if (!fleet.list().some((m) => m.serverId.startsWith("srv_"))) return; // nothing correlatable to heal
    const now = Date.now();
    if (now - lastUrlHealAt < 20_000) return; // bound the probe cost across a client's polling
    lastUrlHealAt = now;
    let disco: rest.FleetDiscoverResponse;
    try {
      disco = await discoverFleet({ port: opts.port, selfServerId: identity.serverId });
    } catch {
      return; // tailscale unavailable — nothing to reconcile against
    }
    if (!disco.ok) return;
    for (const heal of planMemberUrlHeals(fleet.list(), disco.servers)) {
      const stored = fleet.list().find((m) => m.serverId === heal.serverId);
      if (!stored || stored.url === heal.url) continue; // re-read: a concurrent upsert may have moved it
      fleet.upsert({ ...stored, url: heal.url });
      console.log(`[fleet] healed member URL ${stored.url} → ${heal.url} (via discovery)`);
    }
  }

  // [BE2-12] Wire the previously-DEAD reconcile() off the members path. A member that was offline at
  // rollout time is marked pending-offline and must be nudged to the pinned desired target when it
  // reappears (spec D18/D19) — without a call site those members stayed stranded on an old SHA forever.
  // Throttled + fire-and-forget; reconcile() is a no-op when there's no desired target or the member is
  // already converged, so the common case costs one cheap probe per member at most every 30s.
  let lastReconcileAt = 0;
  async function reconcileFleetMembers(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - lastReconcileAt < 30_000) return;
    lastReconcileAt = nowMs;
    for (const m of fleet.list()) {
      await fleetRollout.reconcile({ serverId: m.serverId, serverName: m.serverName, url: m.url }).catch(() => {});
    }
  }

  const WS = {
    open(ws: ServerWebSocket<ConnState>) {
      registry.add(ws);
      ws.send(
        JSON.stringify(
          serverHelloEvent(identity, { pairedHubId: pairedHub.get()?.hubServerId ?? null, memberCount: fleet.list().length }),
        ),
      ); // who am I — first frame (fleet §3/§6)
      // Resume watermarks BEFORE session.list (v4, §6.4): the client's session.list handler drives the
      // (re)attach, so the per-session {epoch,lastSeq} it verifies against must already be in hand.
      ws.send(JSON.stringify(supervisor.resumeWatermarksEvent()));
      ws.send(JSON.stringify(supervisor.sessionListEvent()));
      ws.send(JSON.stringify(supervisor.teamInfoEvent())); // derived team tree alongside the session list
      ws.send(JSON.stringify(supervisor.budgetEvent()));
      ws.send(JSON.stringify(supervisor.environmentsEvent()));
      ws.send(JSON.stringify(supervisor.promptsEvent()));
      ws.send(JSON.stringify(supervisor.modelLabelsEvent()));
      ws.send(JSON.stringify(supervisor.accountsEvent())); // roster before the new-session dialog/header render (§9)
      ws.send(JSON.stringify(supervisor.todoistStatusEvent()));
      ws.send(JSON.stringify(supervisor.lapoStatusEvent()));
      ws.send(JSON.stringify(supervisor.telemetrySnapshotEvent())); // §5.7 resilience counters
      const sched = supervisor.autopilotScheduleEvent(); // schedule + live `running` state
      ws.send(JSON.stringify(sched));
      if (sched.running) ws.send(JSON.stringify(supervisor.autopilotRunSnapshotEvent())); // replay the in-flight run's log

      // The session list above is the persisted (possibly stale) snapshot; reconcile every session's
      // PR/merge badge in the background so a PR merged on GitHub / another device shows up in the
      // sidebar without the user opening each session. Throttled + coalesced inside the supervisor.
      void supervisor.refreshAllPrStates();
    },
    close(ws: ServerWebSocket<ConnState>) {
      registry.remove(ws);
    },
    message(ws: ServerWebSocket<ConnState>, message: string | Buffer) {
      const raw = typeof message === "string" ? message : message.toString("utf8");
      dispatch(ws.data, raw, (event) => ws.send(JSON.stringify(event)), { push, supervisor, registry, propagateTodoist: pushTodoist });
    },
  };

  // Bind with a brief EADDRINUSE retry. A `launchctl kickstart -k` restart (arch §5 / self-update) can
  // launch the fresh daemon while the outgoing one is still inside its ~4s graceful-flush window and
  // hasn't released the port yet — and on the dev/hub box a stray worktree daemon can hold it too. A bare
  // `Bun.serve` throws synchronously there; the process exits and launchd's KeepAlive respawns it into
  // the same race, turning a clean restart into a multi-second crash loop that drops every client socket
  // (observed as repeated EADDRINUSE + "shutdown watchdog fired" in the error log). Spin on the bind for a
  // few seconds so the new instance simply waits the old one out. `Bun.sleepSync` is safe here — nothing
  // else runs until we're listening — and `port: 0` (tests) never collides, so this is a no-op there.
  const server = ((): ReturnType<typeof Bun.serve<ConnState>> => {
    const bindDeadline = Date.now() + 6000;
    for (;;) {
      try {
        return Bun.serve<ConnState>({
          hostname: opts.host ?? "127.0.0.1",
          port: opts.port,
          // Bun's default idleTimeout is 10s, but a fleet fan-out legitimately outlives that: a single
          // UNREACHABLE member burns postPairing's 12s timeout per attempt, and each member is tried on
          // two transports (:7701 then the :7702 fallback). The result was that /api/fleet/rotate could
          // never answer while any member was offline — Bun closed the socket first, so "Sync now"
          // returned an empty reply and the UI blamed the hub ("is the hub reachable?") when the hub was
          // perfectly healthy. Pre-existing, but the Servers tab now actively tells people to press that
          // button when a member is out of date, so it went from rare to routine.
          idleTimeout: 120,
          async fetch(req, srv) {
            const url = new URL(req.url);
            const isApi = url.pathname.startsWith("/api/");
            if (isApi && req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
            const res = await handle(req, srv, url);
            if (isApi && res) for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
            return res;
          },
          websocket: WS,
        });
      } catch (e) {
        if ((e as { code?: string } | null)?.code !== "EADDRINUSE" || Date.now() >= bindDeadline) throw e;
        console.warn(`[anvild] port ${opts.port} busy (EADDRINUSE) — a prior instance is still exiting; retrying…`);
        Bun.sleepSync(250);
      }
    }
  })();

  type Srv = ReturnType<typeof Bun.serve<ConnState>>;
  /** Per-request context handed to route handlers: the caller-identity resolvers ([SEC2-3]) and the
   *  Bun server (for `requestIP`/`upgrade`). Built once per request in `handle`. */
  interface ReqCtx {
    srv: Srv;
    /** Resolve who is calling, peer-address first (§7 · HJ-37). Never trust the header off loopback. */
    callerIdentity: () => Promise<{ trust: PeerTrust; reject?: string }>;
    /** [SEC2-3 refinement] A purely-LOCAL process on the box — loopback peer with NO injected
     *  `Tailscale-User-Login` header — is inside the trust boundary already (e.g. the native macOS
     *  updater hitting the REST route directly on localhost, not via `tailscale serve`). It's classified
     *  `otherUser` ("local caller without a Tailscale identity") only because it presents no identity, so
     *  the update routes permit it. NB: a loopback caller WITH a header is a serve-proxied tailnet user —
     *  if that header resolves to a DIFFERENT user, callerIdentity still returns otherUser and we still
     *  reject (this exception requires the ABSENCE of a header, so it can't wave a foreign user through). */
    localNoIdentityCaller: boolean;
  }
  type RouteHandler = (req: Request, url: URL, m: RegExpExecArray | null, ctx: ReqCtx) => Promise<Response | undefined> | Response | undefined;

  // [P7] Method+path route table (replaces the former 560-line if-ladder). Static routes match on
  // "METHOD pathname" exactly; pattern routes are tried in order (method "*" = the handler narrows the
  // method itself, e.g. the attachments 405). Dispatch wraps the handler in a try/catch→500, which
  // kills the BE2-10 crash-500 class for good: an unexpected throw used to reject through fetch(),
  // producing an unlogged, CORS-less 500.
  const routes = new Map<string, RouteHandler>();
  const patterns: { method: string; re: RegExp; handler: RouteHandler }[] = [];
  const route = (method: string, path: string, handler: RouteHandler): void => void routes.set(`${method} ${path}`, handler);
  const routeRe = (method: string, re: RegExp, handler: RouteHandler): void => void patterns.push({ method, re, handler });

  /** Tolerant JSON body: a missing/garbled body parses as {} — the route validates its own fields. */
  const jsonBody = async <T>(req: Request): Promise<Partial<T>> => (await req.json().catch(() => ({}))) as Partial<T>;
  /** [P7 DRY] The strict-body shape the copy-pasted push/adb handlers shared: parse + handle inside
   *  one try, so a garbled body — or a throwing handler, matching the old inline try/catch — is a 400. */
  const withJsonBody =
    <T>(fn: (body: T) => Response | Promise<Response>, badRequest = "bad request"): RouteHandler =>
    async (req) => {
      try {
        return await fn((await req.json()) as T);
      } catch {
        return new Response(badRequest, { status: 400 });
      }
    };

  /** Adopt a pushed credential set. Routed through `setClaudeToken` on purpose, so §8.4's
   *  metered-key rejection applies and a hub holding an `sk-ant-api…` key can't propagate it. */
  const adoptCredentials = (body: { token?: string; todoistToken?: string; openRouterKey?: string; accounts?: rest.RosterPush }): string | null => {
    // Snapshot BEFORE anything changes so only sessions whose own resolved token actually moved get
    // their driver restarted (Task 21). Must be taken ahead of adoptReplica for the diff to mean
    // anything.
    const before = supervisor.tokensBySession();
    // Adopt the roster BEFORE setClaudeToken, so the token being set is already consistent with the
    // roster those sessions will resolve against (§7.3). Absent `accounts` (an older hub) leaves
    // today's behaviour bit-for-bit unchanged.
    if (body.accounts) {
      try {
        accounts.adoptReplica(body.accounts);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }
    try {
      setClaudeToken(String(body.token ?? "")); // also clears the degrade marker + failure counter
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    // Siblings are best-effort: a bad Todoist token must not fail a pair that already succeeded in
    // handing over the credential that matters (HJ-24/HJ-27 — present keys overwrite).
    if (body.openRouterKey) {
      try {
        setOpenRouterKey(body.openRouterKey);
      } catch (e) {
        console.warn(`[fleet] pushed OpenRouter key rejected: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (body.todoistToken) {
      void supervisor.connectTodoist(body.todoistToken).catch((e: unknown) => console.warn(`[fleet] pushed Todoist token rejected: ${e instanceof Error ? e.message : e}`));
    }
    supervisor.authDegrade.recover();
    supervisor.broadcastAuthState();
    if (body.accounts) supervisor.broadcastAccounts();
    void supervisor.restartIdleSessionsForNewToken(before);
    return null;
  };

  route("GET", "/api/health", () => {
    const auth = resolveAuthStatus({ accounts });
    const body: rest.HealthResponse = {
      ok: true,
      // Honest now (§4.2): false for an absent token AND for an `sk-ant-api…` value. Note the daemon
      // still answers `ok: true` — "up but unauthed" is the state this pair of fields has always
      // modelled; headless-join is what made it reachable.
      subscriptionAuthOk: auth.subscriptionAuthOk,
      version: VERSION,
      serverId: identity.serverId,
      serverName: identity.serverName,
      budget: supervisor.budget(),
      // Discovery is REST — a hub has no WS session with a machine it hasn't joined yet — so the
      // capability list a client normally reads off `server.hello` is mirrored here (HJ-32/§3.5).
      // Deliberately NOT included: this window's arm-state, which would broadcast an open
      // credential window to the whole tailnet (HJ-9).
      capabilities: [...SERVER_CAPABILITIES],
      // Frozen update API version + boot smoke result. A hub reads updateApiVersion off health
      // (discovery is REST) to route this member through the stable path; the watchdog polls
      // health and treats webBundleOk:false as NOT-healthy (spec §4.3/D14).
      updateApiVersion: UPDATE_API_VERSION,
      webBundleOk: webBundleOk(WEB_DIR),
    };
    return Response.json(body);
  });

  // ── Frozen update API v1 (stable-update-service spec §4.3) ────────────────────────────────────
  // GET check (no mutation), POST apply (pull to a pinned target + restart), GET status (observe).
  route("GET", "/api/update/v1/check", async () => Response.json(await updateCheck(updateDeps)));
  route("POST", "/api/update/v1/apply", async (req, _url, _m, ctx) => {
    // [SEC2-2] Require a JSON content-type. A cross-origin CORS "simple request" (text/plain, no
    // preflight) can't set this, so a no-cors drive-by can't reach the apply path even if the Origin
    // check were somehow bypassed; a body-less/wrong-type POST is rejected before we mutate anything.
    const ct = (req.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) return new Response("application/json required", { status: 415 });
    // [SEC2-3] Identity gate — parity with /api/fleet/*: a PROVEN different tailnet user must not be
    // able to pin this member's checkout + force a restart onto it. sameUser/unknown proceed; a purely
    // local process on the box (loopback, no header — e.g. the native macOS updater) is also allowed.
    const who = await ctx.callerIdentity();
    if (who.trust === "otherUser" && !ctx.localNoIdentityCaller) return Response.json({ ok: false, error: who.reject ?? "different tailnet user" }, { status: 403 });
    const bodyReq = (await jsonBody<rest.update.ApplyRequest>(req)) as rest.update.ApplyRequest;
    const result = await updateApply({ targetSha: bodyReq.targetSha }, updateDeps);
    return Response.json(result, { status: result.ok ? 200 : 500 });
  });
  route("GET", "/api/update/v1/status", () => Response.json(updateStatus(updateDeps)));

  // Fleet discovery (anvil-multi-server.md §4.1): enumerate Tailscale peers + probe each
  // /api/health, return the Anvil daemons found (deduped by serverId) as add-suggestions.
  route("GET", "/api/fleet/discover", async () => {
    const body = await discoverFleet({ port: opts.port, selfServerId: identity.serverId });
    return Response.json(body satisfies rest.FleetDiscoverResponse);
  });

  // Fleet administration (anvil-server-app.md §6): manage the fleet from ANY client (web/Android),
  // not just the hub's Mac app. The hub daemon distributes its own OAuth token; it's never returned.
  route("GET", "/api/fleet/members", () => {
    // [BE2-10] Both heals are fire-and-forget so a slow/failed probe never blocks (or 500s) this GET;
    // the healed url/serverId lands on the next poll. The endpoint must always answer fast with the
    // current roster.
    void healStaleFleetRecords(); // repair legacy http://-stored members so http-page clients can reach them
    void healFleetUrlsByDiscovery(); // recover MagicDNS-off members over their tailnet IP
    void reconcileFleetMembers(); // [BE2-12] converge any pending-offline member to the pinned target
    return Response.json({ members: fleet.list() } satisfies rest.FleetMembersResponse);
  });
  // Read-only roster for the session-start picker, readable from ANY origin so a member's client
  // can render it. Masked previews only — never a raw token (§11).
  route("GET", "/api/fleet/accounts", () => {
    const snap = accounts.snapshot();
    const paired = pairedHub.get();
    return Response.json({
      rev: snap.rev,
      ...(snap.defaultId ? { defaultId: snap.defaultId } : {}),
      role: snap.role,
      ...(paired ? { hubServerId: paired.hubServerId } : {}),
      accounts: accounts.publicList(),
    } satisfies rest.FleetAccountsResponse);
  });
  // Tailnet Macs to pick from when adding to the fleet (so you choose a name, not an IP).
  route("GET", "/api/fleet/peers", async () => Response.json((await tailnetPeers()) satisfies rest.FleetPeersResponse));
  // [BE2-15] The invite fan-out body, run as a background job (the POST answers immediately in async
  // mode). Returns EXACTLY the response the old synchronous route produced; any throw becomes a clean
  // {ok:false} result so a poller can never hang on a died job.
  async function runInviteJob(host: string, code: string): Promise<rest.FleetInviteResponse> {
    try {
      // Resolve the joiner's tailnet IP up front so a plain-http member is recorded at its DNS-free
      // http://<ip> url rather than a MagicDNS name (which strands the member the moment MagicDNS drops).
      const memberIp = await net.peerIPv4(host);
      // Ask the joiner what it speaks BEFORE pushing, so the destination is a lookup rather than a
      // guess (HJ-15/§3.5). A peer that answers without capabilities is a pre-capability daemon →
      // :7702. `invitePeer` still falls back on a 404/405 from :7701, for an un-upgraded Mac that
      // answers on the daemon port but has no such route.
      const preflight = await net.resolveMember(host, opts.port, undefined, memberIp);
      const outcome = await net.invitePeer({
        host,
        ...(memberIp ? { ip: memberIp } : {}),
        code,
        token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
        hubServerId: identity.serverId,
        capabilities: preflight.capabilities,
        port: opts.port,
        // Sibling secrets ride along: joining a fleet means adopting its config (HJ-24/HJ-27).
        ...(supervisor.todoistTokenForFleet() ? { todoistToken: supervisor.todoistTokenForFleet()! } : {}),
        ...(process.env.OPENROUTER_API_KEY ? { openRouterKey: process.env.OPENROUTER_API_KEY } : {}),
        // The whole roster rides the first join too, so a new member arrives with every account
        // instead of only the mirrored default (§7.3).
        ...(accounts.payload() ? { accounts: accounts.payload()! } : {}),
      });
      if (!outcome.ok) return { ok: false, error: outcome.error };
      // Probe the joiner's transport (https if it serves, else plain http) AND its identity. Prefer
      // the probed serverId over the pairing outcome / host fallback: a host-as-serverId silently
      // breaks targeted token propagation (members are matched by serverId).
      // [BE2-15] Deduped double-probe: when the PREFLIGHT probe already resolved the joiner's identity
      // (serverId present ⇒ its /api/health answered), reuse it — the transport url and serverId a
      // health probe yields don't change during the seconds a pair takes (adopting a credential neither
      // restarts the daemon nor flips its scheme). Re-probe ONLY when the preflight came back empty
      // (fallback url, no identity): that's the joiner whose daemon wasn't answering yet — e.g. a
      // :7702-only Mac or a daemon still booting — and the post-pairing probe is what picks up the
      // identity/transport it NOW answers with. That late-boot pickup is the state change the second
      // probe existed for; the identified-preflight case never benefited from it.
      const resolved = preflight.serverId ? preflight : await net.resolveMember(host, opts.port, undefined, memberIp);
      // Record the rev the joiner confirmed taking, exactly as `pushRosterToMembers` does after a
      // rotation. Without it a freshly-paired member sits at an undefined rev and the Servers tab
      // reports "out of date — press Sync now" about a member that is in fact perfectly in sync,
      // until the next roster edit happens to paper over it. `invitePeer` reports what it actually
      // sent, so this can't drift from the capability gate.
      const member: rest.FleetMember = {
        serverId: resolved.serverId || outcome.serverId || host,
        serverName: outcome.serverName || resolved.serverName || host,
        host,
        url: resolved.url,
        ...(outcome.accountsRev !== undefined ? { accountsRev: outcome.accountsRev } : {}),
      };
      fleet.upsert(member);
      // The member is recorded — tell the joiner so it disarms (HJ-16). Best-effort and deliberately
      // AFTER the upsert: the joiner staying armed through a lost reply is the failure mode this
      // closes, so an un-acked-but-recorded member is the safe end state, not an un-recorded one.
      void net.ackPair({ host, code, hubServerId: identity.serverId, capabilities: preflight.capabilities, port: opts.port });
      pushTodoist([member.serverId]); // hand the joiner the Todoist token too, if we have one
      return { ok: true, member };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  route("POST", "/api/fleet/invite", async (req, url) => {
    const { host, code } = await jsonBody<rest.FleetInviteRequest>(req);
    if (!host || !code) return new Response("host and code required", { status: 400 });
    // Join-by-host: a double-click (or a second client) while this host's invite is in flight shares
    // the running job instead of double-pushing the credential.
    const { job, completion } = fleetJobs.start("invite", `invite:${host}`, () => runInviteJob(host, code));
    if (url.searchParams.get("async")) {
      return Response.json({ ok: true, jobId: job.jobId, kind: "invite", state: job.state } satisfies rest.FleetJobStartResponse, { status: 202 });
    }
    // Legacy synchronous mode (no ?async=1): bundled native web UIs predate the job model — keep the
    // original blocking behavior + response shape for them.
    return Response.json(await completion);
  });

  // ── Joiner side: receive credentials on this daemon's own port (headless-join §5.3) ────────
  // These are what let a NON-Mac machine be added to a fleet at all: the macOS Server.app's :7702
  // listener has no Linux equivalent, and until Phase 1 a tokenless machine had no running daemon
  // to host one anyway. Default closed, code + tailnet identity gated; see §8.2 for the full list.

  // Arm a join window on THIS machine and show its code. The code lives in exactly one place —
  // this UI (HJ-13) — so there is no log or CLI fallback to scrape.
  route("POST", "/api/fleet/arm", async (req) => {
    const { ttlMs } = await jsonBody<rest.FleetArmRequest>(req);
    const { code, expiresAt } = pairWindow.arm(ttlMs ?? DEFAULT_ARM_TTL_MS);
    const host = await supervisor.selfHost();
    console.log(`[fleet] pairing window open for ${Math.round((expiresAt - Date.now()) / 60_000)} min`);
    return Response.json({ ok: true, code, expiresAt: new Date(expiresAt).toISOString(), ...(host ? { host } : {}) } satisfies rest.FleetArmResponse);
  });
  route("DELETE", "/api/fleet/arm", () => {
    pairWindow.disarm();
    return Response.json({ ok: true } satisfies rest.FleetArmResponse);
  });
  // This machine's own setup state, for its takeover screen. Arm-state is exposed HERE and not on
  // /api/health precisely because health is the unauthenticated, tailnet-wide surface (HJ-9).
  route("GET", "/api/fleet/arm", async () => {
    const w = pairWindow.state();
    const host = await supervisor.selfHost();
    const hub = pairedHub.get();
    return Response.json({
      armed: w !== null,
      ...(w ? { code: w.code, expiresAt: new Date(w.expiresAt).toISOString() } : {}),
      ...(host ? { host } : {}),
      hasToken: (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim().length > 0,
      ...(hub ? { hubServerId: hub.hubServerId } : {}),
      serverId: identity.serverId,
      serverName: identity.serverName,
    } satisfies rest.FleetArmStatusResponse);
  });

  // First join: code-gated + identity-gated. Mirrors /anvil-pair's semantics and its rejection
  // vocabulary (Pairing.swift:129) so the two paths stay recognisably the same gate.
  route("POST", "/api/fleet/pair", async (req, _url, _m, ctx) => {
    const body = await jsonBody<rest.FleetPairRequest>(req);
    const reject = (error: string, status = 403): Response => {
      // Coalesce to at most one notification per armed window, with a count; an UNARMED machine
      // logs but never notifies, so a tailnet scanner can't use this as a doorbell (HJ-33).
      const alert = pairWindow.claimRejectionAlert();
      console.warn(`[fleet] pair rejected: ${error}`);
      if (alert.notify) supervisor.pushSystemAlert("Pairing attempt rejected", `Someone tried to pair this machine and was turned away (${error}).`, "pair-rejected");
      return Response.json({ ok: false, error } satisfies rest.FleetPairResponse, { status });
    };
    if (!body.token || !body.hubServerId) return reject("bad request", 400);

    const who = await ctx.callerIdentity();
    // A caller whois says is a DIFFERENT tailnet user is rejected even with a correct code.
    if (who.trust === "otherUser") return reject(who.reject ?? "different tailnet user");
    // whois-unknown falls back to code-only, matching `notOtherUser` (Pairing.swift:118).

    const codeError = pairWindow.accept(String(body.code ?? ""), body.hubServerId);
    if (codeError) return reject(codeError, codeError === "not accepting pairings" ? 409 : 403);

    const failure = adoptCredentials(body);
    if (failure) return reject(failure, 400);
    pairedHub.record(body.hubServerId, body.fleetName);
    console.log(`[fleet] paired with hub ${body.hubServerId}${body.fleetName ? ` (${body.fleetName})` : ""}`);
    supervisor.pushSystemAlert("Joined the fleet", `This machine now shares ${body.fleetName ? `the ${body.fleetName}` : "your"} Claude login.`, "pair-ok");
    // Stay armed until the hub ACKs (HJ-16) — the window is now locked to this hub (HJ-17), which
    // is what makes leaving it open a strictly smaller surface than a fresh one.
    const self = await supervisor.selfBaseUrl();
    return Response.json({
      ok: true,
      serverId: identity.serverId,
      serverName: identity.serverName,
      ...(self ? { url: self } : {}),
    } satisfies rest.FleetPairResponse);
  });

  // The hub confirms the member is recorded → disarm. Gated exactly as /pair is, and the body must
  // carry the SAME hubServerId and code the window locked to — otherwise any tailnet peer could
  // POST this and cancel someone else's pairing window mid-flow. Idempotent by design.
  route("POST", "/api/fleet/pair/ack", async (req, _url, _m, ctx) => {
    const body = await jsonBody<rest.FleetPairAckRequest>(req);
    const who = await ctx.callerIdentity();
    if (who.trust === "otherUser") return Response.json({ ok: false, error: who.reject ?? "different tailnet user" }, { status: 403 });
    if (!body.hubServerId || !pairWindow.ack(String(body.code ?? ""), body.hubServerId)) {
      return Response.json({ ok: false, error: "not your pairing window" }, { status: 403 });
    }
    return Response.json({ ok: true });
  });

  // Rotation counterpart: identity-gated, NOT code-gated — persistent rather than armed, so the hub
  // can push a refreshed token unattended. `hubServerId` is an anti-confusion check, not a
  // credential: read §8.6 before reading this as "rotation is authenticated". The real gate is
  // same-user tailnet reachability, so `unknown` trust is NOT enough here (unlike a coded pair).
  route("POST", "/api/fleet/token", async (req, _url, _m, ctx) => {
    const body = await jsonBody<rest.FleetTokenRequest>(req);
    const who = await ctx.callerIdentity();
    if (who.trust !== "sameUser") return Response.json({ ok: false, error: who.reject ?? "untrusted tailnet user" }, { status: 403 });
    const hub = pairedHub.get();
    if (!hub || !body.hubServerId || body.hubServerId !== hub.hubServerId) {
      return Response.json({ ok: false, error: "unknown hub" }, { status: 403 });
    }
    const failure = adoptCredentials(body);
    if (failure) return Response.json({ ok: false, error: failure }, { status: 400 });
    console.log(`[fleet] token rotated by hub ${hub.hubServerId}`);
    return Response.json({ ok: true, serverId: identity.serverId, serverName: identity.serverName } satisfies rest.FleetPairResponse);
  });

  // Hub→member Todoist replication landing point (anvil-multi-server.md): the hub POSTs its token
  // here so this daemon can run autopilot for its own linked environments. Validated against the
  // Todoist API before it's stored (mode 0600); tailnet-gated like the rest of the daemon API.
  route("POST", "/api/integrations/todoist", async (req) => {
    const { token } = await jsonBody<{ token?: string }>(req);
    if (!token) return Response.json({ ok: false, error: "token required" }, { status: 400 });
    try {
      const ev = await supervisor.connectTodoist(token);
      // Echo this daemon's identity so the hub can heal a stale fleet record (real serverId, and
      // the URL it actually reached us on) off the same POST — no extra probe needed.
      return Response.json({ ok: true, account: ev.account, serverId: identity.serverId, serverName: identity.serverName });
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  });
  // lapo OAuth2 authorization-code callback: lapo redirects the user's browser here with ?code&state
  // after they authorize. Exchange the code for tokens (validated + stored by the supervisor) and
  // return a tiny HTML page that reports the outcome and closes itself. The main app updates live off
  // the broadcast lapo.status, so this window closing (or not) doesn't matter to the connection.
  route("GET", "/api/integrations/lapo/callback", async (_req, url) => {
    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (err) return lapoCallbackPage(false, `lapo denied the authorization: ${err}`);
    if (!code || !state) return lapoCallbackPage(false, "The authorization response was missing its code or state.");
    try {
      const { account } = await supervisor.completeLapoAuth(code, state);
      return lapoCallbackPage(true, account ? `Connected as ${account}.` : "Connected.");
    } catch (e) {
      return lapoCallbackPage(false, e instanceof Error ? e.message : String(e));
    }
  });

  // "Sync now" — trigger an outbound roster push to this hub's own members. Identity-gated like the
  // rest of the credential surface: a confirmed DIFFERENT tailnet user must not be able to drive a
  // fleet credential operation, closing the asymmetry with /api/fleet/token (which ADOPTS a pushed
  // token and so demands the stricter `sameUser`). Rotate only re-pushes tokens we already hold to
  // members we already paired — it discloses nothing to the caller — so it takes /pair's posture
  // instead: reject a proven `otherUser`, but stay permissive when identity is unprovable (`unknown`,
  // e.g. whois momentarily down) rather than fail an operator's Sync now intermittently.
  // [BE2-15] The rotate fan-out body — same job treatment as invite. A throw becomes a clean
  // {ok:false} result (the old sync route surfaced it as a 500; the shape now carries it instead).
  async function runRotateJob(): Promise<rest.FleetRotateResponse> {
    try {
      const results = await pushRosterToMembers();
      return { ok: results.every((r) => r.ok), results };
    } catch (e) {
      return { ok: false, results: [], error: e instanceof Error ? e.message : String(e) };
    }
  }
  route("POST", "/api/fleet/rotate", async (_req, url, _m, ctx) => {
    const who = await ctx.callerIdentity();
    if (who.trust === "otherUser") return Response.json({ ok: false, error: who.reject ?? "different tailnet user" }, { status: 403 });
    // One rotate at a time: a second "Sync now" while one is running joins the in-flight fan-out.
    const { job, completion } = fleetJobs.start("rotate", "rotate", runRotateJob);
    if (url.searchParams.get("async")) {
      return Response.json({ ok: true, jobId: job.jobId, kind: "rotate", state: job.state } satisfies rest.FleetJobStartResponse, { status: 202 });
    }
    // Legacy synchronous mode (no ?async=1) — original blocking behavior + shape for old bundled UIs.
    return Response.json(await completion);
  });
  // [BE2-15] Job progress for the async rotate/invite fan-outs. `result` (present once done) is the
  // exact body the synchronous POST would have returned — no signal is lost by going async.
  routeRe("GET", /^\/api\/fleet\/jobs\/([^/]+)$/, (_req, _url, m) => {
    const j = fleetJobs.get(decodeURIComponent(m![1]!));
    if (!j) return Response.json({ ok: false, error: "no such job (it may have expired, or the daemon restarted)" } satisfies rest.FleetJobStatusResponse, { status: 404 });
    return Response.json({ ok: true, ...j, result: j.result as rest.FleetRotateResponse | rest.FleetInviteResponse | undefined } satisfies rest.FleetJobStatusResponse);
  });
  // Hub-orchestrated fleet update (spec §4.4). Same identity posture as /api/fleet/rotate — a
  // fleet-wide mutating action, so reject a PROVEN other tailnet user but stay permissive when
  // identity is unprovable (whois momentarily down) rather than fail an operator intermittently.
  route("POST", "/api/fleet/update", async (req, _url, _m, ctx) => {
    const who = await ctx.callerIdentity();
    if (who.trust === "otherUser") return Response.json({ ok: false, error: who.reject ?? "different tailnet user" }, { status: 403 });
    const bodyReq = (await jsonBody<rest.FleetUpdateRequest>(req)) as rest.FleetUpdateRequest;
    const result = await fleetRollout.start({ targetSha: bodyReq.targetSha });
    return Response.json(result satisfies rest.FleetUpdateResponse, { status: result.ok ? 200 : 409 });
  });
  route("GET", "/api/fleet/update/status", () => Response.json(fleetRollout.status() satisfies rest.FleetUpdateStatusResponse));

  routeRe("DELETE", /^\/api\/fleet\/members\/([^/]+)$/, (_req, _url, m) => {
    fleet.remove(decodeURIComponent(m![1]!));
    return Response.json({ ok: true });
  });

  // ADB wifi (Android client): connect / pair the Mac with a phone's wireless-debugging endpoint
  route("GET", "/api/adb/info", async () => Response.json({ serverIps: lanIPv4(), devices: (await runAdb(["devices", "-l"])).output }));
  route(
    "POST",
    "/api/adb/connect",
    withJsonBody<{ host?: string; port?: number }>(async ({ host, port }) => {
      if (!host || !port) return new Response("host and port required", { status: 400 });
      return Response.json(await runAdb(["connect", adbTarget(host, port)]));
    }),
  );
  route(
    "POST",
    "/api/adb/pair",
    withJsonBody<{ host?: string; port?: number; code?: string }>(async ({ host, port, code }) => {
      if (!host || !port || !code) return new Response("host, port, code required", { status: 400 });
      const r = await runAdb(["pair", adbTarget(host, port), String(code)]);
      return Response.json({ ok: /success/i.test(r.output), output: r.output });
    }),
  );

  // Daemon self-update (arch §5): GET checks whether an update is available; POST applies it
  // (pull + rebuild + restart). Mirrors the `daemon.update` WS command for native clients
  // (the macOS menu command) and scripts that have no open WebSocket.
  const daemonUpdate: RouteHandler = async (req, _url, _m, ctx) => {
    // [SEC2-3] Identity gate on the mutating (POST = apply) path only; GET is a read-only check.
    // Parity with /api/fleet/* and /api/update/v1/apply — reject a proven different tailnet user.
    if (req.method === "POST") {
      const who = await ctx.callerIdentity();
      if (who.trust === "otherUser" && !ctx.localNoIdentityCaller) {
        return Response.json({ ok: false, phase: "error", output: who.reject ?? "different tailnet user", currentVersion: VERSION } satisfies rest.DaemonUpdateResponse, { status: 403 });
      }
    }
    const result = await supervisor.daemonUpdate(req.method === "GET");
    const body: rest.DaemonUpdateResponse = {
      ok: result.ok,
      phase: result.phase,
      output: result.output,
      currentVersion: result.currentVersion,
      ...(result.behind !== undefined ? { behind: result.behind } : {}),
      ...(result.willRestart !== undefined ? { willRestart: result.willRestart } : {}),
    };
    return Response.json(body, { status: result.ok ? 200 : 500 });
  };
  route("GET", "/api/daemon/update", daemonUpdate);
  route("POST", "/api/daemon/update", daemonUpdate);

  // environment README (arch §8): rendered markdown for the settings/management view
  routeRe("GET", /^\/api\/environments\/([^/]+)\/readme$/, (_req, _url, m) => {
    try {
      return Response.json(supervisor.envReadme(m![1]!) satisfies rest.EnvReadmeResponse);
    } catch (e) {
      return new Response(e instanceof Error ? e.message : "not found", { status: 404 });
    }
  });

  // Web Push (arch §6.7): VAPID public key + browser subscription management
  route("GET", "/api/push/key", () => Response.json({ publicKey: supervisor.webpush.publicKey }));
  route(
    "POST",
    "/api/push/subscribe",
    withJsonBody<never>((body) => {
      supervisor.webpush.subscribe(body);
      return Response.json({ ok: true });
    }, "bad subscription"),
  );
  // Answer a parked permission prompt over REST — lets a native notification action button
  // resolve Allow/Deny without an open WebSocket (arch §6.6).
  route("POST", "/api/permission/respond", async (req) => {
    try {
      const { requestId, decision, updatedInput } = (await req.json()) as {
        requestId?: string;
        decision?: PermissionDecision;
        updatedInput?: unknown;
      };
      if (!requestId || (decision !== "allow" && decision !== "deny" && decision !== "allow_always")) {
        return new Response("bad request", { status: 400 });
      }
      supervisor.resolvePermission(requestId, decision, updatedInput);
      return Response.json({ ok: true });
    } catch (e) {
      // BadCommand → the request was already answered or expired; treat as gone, not a server error.
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 409 });
    }
  });
  // Un-stick a session over REST (parity with the WS command) — recovers a missing worktree,
  // clears parked permissions, and resets status to idle.
  routeRe("POST", /^\/api\/sessions\/([^/]+)\/reset$/, async (_req, _url, m) => {
    try {
      await supervisor.reset(decodeURIComponent(m![1]!));
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 409 });
    }
  });
  route(
    "POST",
    "/api/push/fcm/register",
    withJsonBody<{ token?: string }>(({ token }) => {
      if (token) supervisor.fcm.register(token);
      return Response.json({ ok: true });
    }),
  );
  route(
    "POST",
    "/api/push/fcm/unregister",
    withJsonBody<{ token?: string }>(({ token }) => {
      if (token) supervisor.fcm.unregister(token);
      return Response.json({ ok: true });
    }),
  );
  route(
    "POST",
    "/api/push/apns/register",
    withJsonBody<{ token?: string }>(({ token }) => {
      if (token) supervisor.apns.register(token);
      return Response.json({ ok: true });
    }),
  );
  route(
    "POST",
    "/api/push/apns/unregister",
    withJsonBody<{ token?: string }>(({ token }) => {
      if (token) supervisor.apns.unregister(token);
      return Response.json({ ok: true });
    }),
  );
  route(
    "POST",
    "/api/push/unsubscribe",
    withJsonBody<{ endpoint?: string }>(({ endpoint }) => {
      if (endpoint) supervisor.webpush.unsubscribe(endpoint);
      return Response.json({ ok: true });
    }),
  );

  routeRe("*", /^\/ws$/, (req, _url, _m, ctx) => {
    // [SEC-H3] Reject cross-site WebSocket hijack from a foreign browser origin. WS bypasses
    // CORS, so this is the one place the browser vector can be closed; native clients and the
    // same-origin PWA are allowlisted in isAllowedWsOrigin.
    if (!isAllowedWsOrigin(req.headers.get("origin"), req.headers.get("host"), configuredAllowedOrigins())) {
      return new Response("forbidden origin", { status: 403 });
    }
    const data: ConnState = { id: newId("conn"), attached: new Set() };
    if (ctx.srv.upgrade(req, { data })) return undefined;
    return new Response("expected a websocket upgrade", { status: 426 });
  });

  // worktree files (arch §8.1): serve a binary/image file from the session worktree.
  // `download=1` forces a save-as via Content-Disposition (used by file-offer download cards, §8).
  const FILES_RE = /^\/api\/sessions\/([^/]+)\/files$/;
  routeRe("GET", FILES_RE, async (_req, url, m) => {
    const sessionId = m![1]!;
    const path = url.searchParams.get("path") ?? "";
    try {
      const abs = supervisor.fsResolve(sessionId, path);
      const file = Bun.file(abs);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = {};
      if (url.searchParams.get("download")) {
        const name = (abs.split("/").pop() || "download").replace(/["\\]/g, "_");
        headers["Content-Disposition"] = `attachment; filename="${name}"`;
      }
      return new Response(file, { headers });
    } catch {
      return new Response("forbidden", { status: 403 });
    }
  });
  // Upload a dropped file into the worktree at `path` (streamed raw body, not base64). Refuses
  // to overwrite an existing path → 409, so a drag-drop can't silently clobber (arch §8.1).
  routeRe("PUT", FILES_RE, async (req, url, m) => {
    const sessionId = m![1]!;
    const path = url.searchParams.get("path") ?? "";
    try {
      const data = new Uint8Array(await req.arrayBuffer());
      const written = supervisor.fsWrite(sessionId, path, data);
      return Response.json(written);
    } catch (e) {
      if (e instanceof FileExists) return new Response("a file with that name already exists", { status: 409 });
      return new Response(e instanceof Error ? e.message : "upload failed", { status: 403 });
    }
  });

  // attachments (arch §6.5): POST uploads a pasted/dropped file, GET serves it back. Method "*":
  // the handler narrows POST/GET itself so any other method keeps answering 405 (not 404).
  routeRe("*", /^\/api\/sessions\/([^/]+)\/attachments(?:\/([^/]+))?$/, async (req, _url, m) => {
    const sessionId = m![1]!;
    const attId = m![2];
    if (req.method === "POST" && !attId) {
      try {
        const body = (await req.json()) as { name?: string; mediaType?: string; dataBase64?: string };
        // mediaType may be empty (Android's content picker often omits it); the store infers
        // it from the filename. Only dataBase64 is strictly required.
        if (!body.dataBase64) return new Response("dataBase64 required", { status: 400 });
        const attachment = supervisor.addAttachment(sessionId, body.name ?? "attachment", body.mediaType ?? "", body.dataBase64);
        return Response.json({ attachment } satisfies rest.UploadAttachmentResponse);
      } catch (e) {
        return new Response(e instanceof Error ? e.message : "upload failed", { status: 400 });
      }
    }
    if (req.method === "GET" && attId) {
      const b = supervisor.attachmentBytes(sessionId, attId);
      if (!b) return new Response("not found", { status: 404 });
      return new Response(Bun.file(b.path), { headers: { "Content-Type": b.mediaType, "Cache-Control": "max-age=31536000" } });
    }
    return new Response("method not allowed", { status: 405 });
  });

  async function handle(req: Request, srv: Srv, url: URL): Promise<Response | undefined> {
    // [SEC2-2] Origin gate on every state-mutating /api route (defense-in-depth on the browser vector).
    // WS is gated at /ws; the REST mutating routes were reachable via a CORS "simple request" (a
    // no-preflight text/plain POST still carries Origin). Reject a foreign browser origin here so a page
    // in a trusted device's browser can't drive update/fleet/daemon/permission/session/push mutations.
    // Native clients (no Origin), the same-origin PWA, and same-tailnet fleet peers are all allowed.
    if (url.pathname.startsWith("/api/") && (req.method === "POST" || req.method === "PUT" || req.method === "DELETE")) {
      if (!isAllowedWsOrigin(req.headers.get("origin"), req.headers.get("host"), configuredAllowedOrigins())) {
        return new Response("forbidden origin", { status: 403 });
      }
    }

    const ctx: ReqCtx = {
      srv,
      callerIdentity: async () =>
        opts.resolveIdentity // [BE2-15] test-only seam — the real resolver shells out to tailscale
          ? opts.resolveIdentity()
          : resolveCallerIdentity({
              peerAddress: srv.requestIP(req)?.address,
              headerLogin: req.headers.get("Tailscale-User-Login"),
              selfLogin: tailscaleSelfLogin,
              whois: tailscaleWhois,
            }),
      localNoIdentityCaller: isLocalNoIdentityCaller(srv.requestIP(req)?.address, req.headers.get("Tailscale-User-Login")),
    };

    try {
      const exact = routes.get(`${req.method} ${url.pathname}`);
      if (exact) return await exact(req, url, null, ctx);
      for (const p of patterns) {
        if (p.method !== "*" && p.method !== req.method) continue;
        const m = p.re.exec(url.pathname);
        if (m) return await p.handler(req, url, m, ctx);
      }
    } catch (e) {
      // [P7/BE2-10 class] A handler that throws unexpectedly is answered as a clean, logged 500 (with
      // CORS applied by fetch) instead of rejecting through fetch() — one bad request or record can
      // no longer take a route down with an opaque, headerless 500.
      console.error(`[http] ${req.method} ${url.pathname} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }

    // static web client (built into web/dist)
    const web = await serveWeb(url.pathname);
    if (web) return web;

    return new Response("not found", { status: 404 });
  }

  return {
    port: server.port ?? opts.port,
    stop: () => server.stop(true),
    shutdown: async () => {
      await supervisor.shutdown();
      server.stop(true);
    },
  };
}
