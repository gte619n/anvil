import type { ServerWebSocket } from "bun";
import type { rest, PermissionDecision } from "@protocol";
import { checkAuth } from "../auth/guard";
import { newId } from "../util/ids";
import { dispatch } from "./dispatch";
import { ConnectionRegistry } from "./registry";
import { isAllowedWsOrigin, configuredAllowedOrigins } from "./origin";
import { loadServerIdentity, serverHelloEvent } from "./identity";
import { discoverFleet, inviteMac, propagateTodoist, resolveMember, rotateToken, tailnetPeers } from "./fleet";
import { FleetStore } from "../fleet/store";
import { PushRegistry } from "../push/registry";
import { Supervisor } from "../session/supervisor";
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
  /** Clone destination for repos added by git URL (see `Config.clonesDir`). Defaults to `<stateDir>/repos`. */
  clonesDir?: string;
  warnFraction?: number;
  softStopFraction?: number;
  renderer?: MarkdownRenderer;
  /** OpenRouter key + models for the adversarial planning panel (see `Config`). */
  adversarialModels?: string[];
  adversarialProvider?: string;
}

/**
 * The HTTP/WS server (arch §6). `fetch` serves the REST control plane (`/api/health`) and
 * upgrades `/ws`; on open it sends the connecting client a `session.list`; `message` hands
 * frames to the dispatcher. Returns a handle so tests can start it on an ephemeral port
 * (`port: 0`) against a temp `stateDir` and stop it.
 */
export function createServer(opts: ServerOptions): ServerHandle {
  const identity = loadServerIdentity(opts.stateDir);
  const fleet = new FleetStore(opts.stateDir);
  const registry = new ConnectionRegistry();
  const push = new PushRegistry();
  const supervisor = new Supervisor(
    {
      stateDir: opts.stateDir,
      clonesDir: opts.clonesDir,
      warnFraction: opts.warnFraction,
      softStopFraction: opts.softStopFraction,
      renderer: opts.renderer,
      adversarialModels: opts.adversarialModels,
      adversarialProvider: opts.adversarialProvider,
    },
    registry,
  );

  // The bundled native clients serve their UI from a local origin and call the daemon's REST API
  // cross-origin, so /api/* needs permissive CORS. (The daemon is Tailscale-gated; no cookies are
  // used, so `*` is safe.) The PWA is same-origin and unaffected.
  const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };

  // Replicate this hub's Todoist token to member daemons so autopilot can run where each repo lives
  // (anvil-multi-server.md). `targets` = member serverIds; omit for all. No-op on a leaf member (its
  // fleet is empty) or before a token is set. Fire-and-forget + idempotent — members heal on reconnect.
  function pushTodoist(targets?: string[]): void {
    const token = supervisor.todoistTokenForFleet();
    if (!token) return;
    const members = fleet.list().filter((m) => !targets || targets.includes(m.serverId));
    if (members.length === 0) return;
    void propagateTodoist({ members, token }).then((results) => {
      for (const r of results) {
        if (!r.ok) {
          console.warn(`[todoist] replication to ${r.url} failed: ${r.error ?? "unknown"}`);
          continue;
        }
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
  async function healStaleFleetRecords(): Promise<void> {
    const stale = fleet.list().filter((m) => !m.serverId.startsWith("srv_"));
    if (stale.length === 0) return;
    await Promise.all(
      stale.map(async (m) => {
        const port = Number(new URL(m.url).port) || opts.port;
        const r = await resolveMember(m.host, port);
        const healedUrl = r.url || m.url;
        const healedServerId = r.serverId ?? m.serverId;
        const healedServerName = r.serverName || m.serverName;
        if (healedUrl === m.url && healedServerId === m.serverId && healedServerName === m.serverName) return;
        fleet.upsert({ ...m, url: healedUrl, serverId: healedServerId, serverName: healedServerName });
        if (healedUrl !== m.url) console.log(`[fleet] healed member URL ${m.url} → ${healedUrl}`);
        if (healedServerId !== m.serverId) console.log(`[fleet] healed member serverId ${m.serverId} → ${healedServerId}`);
      }),
    );
  }

  const WS = {
    open(ws: ServerWebSocket<ConnState>) {
      registry.add(ws);
      ws.send(JSON.stringify(serverHelloEvent(identity))); // who am I — first frame (fleet §3/§6)
      ws.send(JSON.stringify(supervisor.sessionListEvent()));
      ws.send(JSON.stringify(supervisor.budgetEvent()));
      ws.send(JSON.stringify(supervisor.environmentsEvent()));
      ws.send(JSON.stringify(supervisor.todoistStatusEvent()));
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

  const server = Bun.serve<ConnState>({
    hostname: opts.host ?? "127.0.0.1",
    port: opts.port,
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

  async function handle(req: Request, srv: typeof server, url: URL): Promise<Response | undefined> {
      if (req.method === "GET" && url.pathname === "/api/health") {
        const auth = checkAuth();
        const body: rest.HealthResponse = {
          ok: true,
          subscriptionAuthOk: auth.subscriptionAuthOk,
          version: VERSION,
          serverId: identity.serverId,
          serverName: identity.serverName,
          budget: supervisor.budget(),
        };
        return Response.json(body);
      }

      // Fleet discovery (anvil-multi-server.md §4.1): enumerate Tailscale peers + probe each
      // /api/health, return the Anvil daemons found (deduped by serverId) as add-suggestions.
      if (url.pathname === "/api/fleet/discover" && req.method === "GET") {
        const body = await discoverFleet({ port: opts.port, selfServerId: identity.serverId });
        return Response.json(body satisfies rest.FleetDiscoverResponse);
      }

      // Fleet administration (anvil-server-app.md §6): manage the fleet from ANY client (web/Android),
      // not just the hub's Mac app. The hub daemon distributes its own OAuth token; it's never returned.
      if (url.pathname === "/api/fleet/members" && req.method === "GET") {
        await healStaleFleetRecords(); // repair legacy http://-stored members so http-page clients can reach them
        return Response.json({ members: fleet.list() } satisfies rest.FleetMembersResponse);
      }
      // Tailnet Macs to pick from when adding to the fleet (so you choose a name, not an IP).
      if (url.pathname === "/api/fleet/peers" && req.method === "GET") {
        return Response.json((await tailnetPeers()) satisfies rest.FleetPeersResponse);
      }
      if (url.pathname === "/api/fleet/invite" && req.method === "POST") {
        const { host, code } = (await req.json().catch(() => ({}))) as Partial<rest.FleetInviteRequest>;
        if (!host || !code) return new Response("host and code required", { status: 400 });
        const outcome = await inviteMac({ host, code, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "", hubServerId: identity.serverId });
        if (!outcome.ok) return Response.json({ ok: false, error: outcome.error } satisfies rest.FleetInviteResponse);
        // Probe the joiner's transport (https if it serves, else plain http) AND its identity. Prefer
        // the probed serverId over the pairing outcome / host fallback: a host-as-serverId silently
        // breaks targeted token propagation (members are matched by serverId).
        const resolved = await resolveMember(host, opts.port);
        const member: rest.FleetMember = {
          serverId: resolved.serverId || outcome.serverId || host,
          serverName: outcome.serverName || resolved.serverName || host,
          host,
          url: resolved.url,
        };
        fleet.upsert(member);
        pushTodoist([member.serverId]); // hand the joiner the Todoist token too, if we have one
        return Response.json({ ok: true, member } satisfies rest.FleetInviteResponse);
      }

      // Hub→member Todoist replication landing point (anvil-multi-server.md): the hub POSTs its token
      // here so this daemon can run autopilot for its own linked environments. Validated against the
      // Todoist API before it's stored (mode 0600); tailnet-gated like the rest of the daemon API.
      if (url.pathname === "/api/integrations/todoist" && req.method === "POST") {
        const { token } = (await req.json().catch(() => ({}))) as { token?: string };
        if (!token) return Response.json({ ok: false, error: "token required" }, { status: 400 });
        try {
          const ev = await supervisor.connectTodoist(token);
          // Echo this daemon's identity so the hub can heal a stale fleet record (real serverId, and
          // the URL it actually reached us on) off the same POST — no extra probe needed.
          return Response.json({ ok: true, account: ev.account, serverId: identity.serverId, serverName: identity.serverName });
        } catch (e) {
          return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }
      if (url.pathname === "/api/fleet/rotate" && req.method === "POST") {
        const results = await rotateToken({ members: fleet.list(), token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "", hubServerId: identity.serverId });
        return Response.json({ ok: results.every((r) => r.ok), results } satisfies rest.FleetRotateResponse);
      }
      const memberMatch = url.pathname.match(/^\/api\/fleet\/members\/([^/]+)$/);
      if (memberMatch && req.method === "DELETE") {
        fleet.remove(decodeURIComponent(memberMatch[1]!));
        return Response.json({ ok: true });
      }

      // ADB wifi (Android client): connect / pair the Mac with a phone's wireless-debugging endpoint
      if (url.pathname === "/api/adb/info" && req.method === "GET") {
        return Response.json({ serverIps: lanIPv4(), devices: (await runAdb(["devices", "-l"])).output });
      }
      if (url.pathname === "/api/adb/connect" && req.method === "POST") {
        try {
          const { host, port } = (await req.json()) as { host?: string; port?: number };
          if (!host || !port) return new Response("host and port required", { status: 400 });
          return Response.json(await runAdb(["connect", adbTarget(host, port)]));
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }
      if (url.pathname === "/api/adb/pair" && req.method === "POST") {
        try {
          const { host, port, code } = (await req.json()) as { host?: string; port?: number; code?: string };
          if (!host || !port || !code) return new Response("host, port, code required", { status: 400 });
          const r = await runAdb(["pair", adbTarget(host, port), String(code)]);
          return Response.json({ ok: /success/i.test(r.output), output: r.output });
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }

      // Daemon self-update (arch §5): GET checks whether an update is available; POST applies it
      // (pull + rebuild + restart). Mirrors the `daemon.update` WS command for native clients
      // (the macOS menu command) and scripts that have no open WebSocket.
      if (url.pathname === "/api/daemon/update" && (req.method === "GET" || req.method === "POST")) {
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
      }

      // environment README (arch §8): rendered markdown for the settings/management view
      const readmeMatch = url.pathname.match(/^\/api\/environments\/([^/]+)\/readme$/);
      if (readmeMatch && req.method === "GET") {
        try {
          return Response.json(supervisor.envReadme(readmeMatch[1]!) satisfies rest.EnvReadmeResponse);
        } catch (e) {
          return new Response(e instanceof Error ? e.message : "not found", { status: 404 });
        }
      }

      // Web Push (arch §6.7): VAPID public key + browser subscription management
      if (url.pathname === "/api/push/key" && req.method === "GET") {
        return Response.json({ publicKey: supervisor.webpush.publicKey });
      }
      if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
        try {
          supervisor.webpush.subscribe((await req.json()) as never);
          return Response.json({ ok: true });
        } catch {
          return new Response("bad subscription", { status: 400 });
        }
      }
      // Answer a parked permission prompt over REST — lets a native notification action button
      // resolve Allow/Deny without an open WebSocket (arch §6.6).
      if (url.pathname === "/api/permission/respond" && req.method === "POST") {
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
      }
      // Un-stick a session over REST (parity with the WS command) — recovers a missing worktree,
      // clears parked permissions, and resets status to idle.
      const resetMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reset$/);
      if (resetMatch && req.method === "POST") {
        try {
          await supervisor.reset(decodeURIComponent(resetMatch[1]!));
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 409 });
        }
      }
      if (url.pathname === "/api/push/fcm/register" && req.method === "POST") {
        try {
          const { token } = (await req.json()) as { token?: string };
          if (token) supervisor.fcm.register(token);
          return Response.json({ ok: true });
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }
      if (url.pathname === "/api/push/fcm/unregister" && req.method === "POST") {
        try {
          const { token } = (await req.json()) as { token?: string };
          if (token) supervisor.fcm.unregister(token);
          return Response.json({ ok: true });
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }
      if (url.pathname === "/api/push/apns/register" && req.method === "POST") {
        try {
          const { token } = (await req.json()) as { token?: string };
          if (token) supervisor.apns.register(token);
          return Response.json({ ok: true });
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }
      if (url.pathname === "/api/push/apns/unregister" && req.method === "POST") {
        try {
          const { token } = (await req.json()) as { token?: string };
          if (token) supervisor.apns.unregister(token);
          return Response.json({ ok: true });
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }
      if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
        try {
          const { endpoint } = (await req.json()) as { endpoint?: string };
          if (endpoint) supervisor.webpush.unsubscribe(endpoint);
          return Response.json({ ok: true });
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }

      if (url.pathname === "/ws") {
        // [SEC-H3] Reject cross-site WebSocket hijack from a foreign browser origin. WS bypasses
        // CORS, so this is the one place the browser vector can be closed; native clients and the
        // same-origin PWA are allowlisted in isAllowedWsOrigin.
        if (!isAllowedWsOrigin(req.headers.get("origin"), req.headers.get("host"), configuredAllowedOrigins())) {
          return new Response("forbidden origin", { status: 403 });
        }
        const data: ConnState = { id: newId("conn"), attached: new Set() };
        if (srv.upgrade(req, { data })) return undefined;
        return new Response("expected a websocket upgrade", { status: 426 });
      }

      // worktree files (arch §8.1): serve a binary/image file from the session worktree.
      // `download=1` forces a save-as via Content-Disposition (used by file-offer download cards, §8).
      const fileMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/files$/);
      if (fileMatch && req.method === "GET") {
        const sessionId = fileMatch[1]!;
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
      }

      // attachments (arch §6.5): POST uploads a pasted/dropped file, GET serves it back
      const attMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attachments(?:\/([^/]+))?$/);
      if (attMatch) {
        const sessionId = attMatch[1]!;
        const attId = attMatch[2];
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
