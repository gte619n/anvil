import type { ServerWebSocket } from "bun";
import type { rest, PermissionDecision } from "@protocol";
import { checkAuth } from "../auth/guard";
import { newId } from "../util/ids";
import { dispatch } from "./dispatch";
import { ConnectionRegistry } from "./registry";
import { PushRegistry } from "../push/registry";
import { Supervisor } from "../session/supervisor";
import type { MarkdownRenderer } from "../render/markdown";
import type { ConnState } from "./connection";
import { join } from "node:path";
import { hostname, networkInterfaces } from "node:os";
import { VERSION } from "../version";

export { VERSION };

// The built web client (anvild/web/dist), resolved relative to this source file.
const WEB_DIR = join(import.meta.dir, "..", "..", "web", "dist");

// CSP for the app shell. Mermaid + the markdown body run here, but all markdown HTML is
// DOMPurify-sanitized server-side (arch §8.3); scripts are limited to our own bundle.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // Shiki/KaTeX/mermaid + Material Symbols (CDN)
  "script-src 'self'",
  "connect-src 'self' ws: wss:",
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

/** Run `adb` (from PATH or the common SDK locations); returns its combined output. */
function runAdb(args: string[]): { ok: boolean; output: string } {
  const home = process.env.HOME ?? "";
  const candidates = ["adb", "/opt/homebrew/bin/adb", "/usr/local/bin/adb", join(home, "Library/Android/sdk/platform-tools/adb"), join(home, "Android/Sdk/platform-tools/adb")];
  for (const adb of candidates) {
    try {
      const r = Bun.spawnSync([adb, ...args], { stdout: "pipe", stderr: "pipe" });
      const output = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
      return { ok: /connected to/i.test(output) && !/failed|cannot|unable/i.test(output), output: output || "(no output)" };
    } catch {
      /* not at this path — try the next */
    }
  }
  return { ok: false, output: "adb not found on the server (install Android platform-tools)" };
}

/** Serve a file from the built web client; `/` → index.html. Returns null if not found. */
async function serveWeb(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = join(WEB_DIR, rel);
  if (!filePath.startsWith(WEB_DIR)) return null; // path-traversal guard
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  const isHtml = filePath.endsWith(".html");
  return new Response(file, {
    headers: isHtml ? { "Content-Security-Policy": CSP, "Cache-Control": "no-cache" } : undefined,
  });
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
  warnFraction?: number;
  softStopFraction?: number;
  renderer?: MarkdownRenderer;
}

/**
 * The HTTP/WS server (arch §6). `fetch` serves the REST control plane (`/api/health`) and
 * upgrades `/ws`; on open it sends the connecting client a `session.list`; `message` hands
 * frames to the dispatcher. Returns a handle so tests can start it on an ephemeral port
 * (`port: 0`) against a temp `stateDir` and stop it.
 */
export function createServer(opts: ServerOptions): ServerHandle {
  const registry = new ConnectionRegistry();
  const push = new PushRegistry();
  const supervisor = new Supervisor(
    {
      stateDir: opts.stateDir,
      warnFraction: opts.warnFraction,
      softStopFraction: opts.softStopFraction,
      renderer: opts.renderer,
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

  const WS = {
    open(ws: ServerWebSocket<ConnState>) {
      registry.add(ws);
      ws.send(JSON.stringify(supervisor.sessionListEvent()));
      ws.send(JSON.stringify(supervisor.budgetEvent()));
      ws.send(JSON.stringify(supervisor.environmentsEvent()));
    },
    close(ws: ServerWebSocket<ConnState>) {
      registry.remove(ws);
    },
    message(ws: ServerWebSocket<ConnState>, message: string | Buffer) {
      const raw = typeof message === "string" ? message : message.toString("utf8");
      dispatch(ws.data, raw, (event) => ws.send(JSON.stringify(event)), { push, supervisor, registry });
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
          serverName: process.env.ANVIL_SERVER_NAME || hostname(),
          budget: supervisor.budget(),
        };
        return Response.json(body);
      }

      // ADB wifi (Android client): connect / pair the Mac with a phone's wireless-debugging endpoint
      if (url.pathname === "/api/adb/info" && req.method === "GET") {
        return Response.json({ serverIps: lanIPv4(), devices: runAdb(["devices", "-l"]).output });
      }
      if (url.pathname === "/api/adb/connect" && req.method === "POST") {
        try {
          const { host, port } = (await req.json()) as { host?: string; port?: number };
          if (!host || !port) return new Response("host and port required", { status: 400 });
          return Response.json(runAdb(["connect", adbTarget(host, port)]));
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }
      if (url.pathname === "/api/adb/pair" && req.method === "POST") {
        try {
          const { host, port, code } = (await req.json()) as { host?: string; port?: number; code?: string };
          if (!host || !port || !code) return new Response("host, port, code required", { status: 400 });
          const r = runAdb(["pair", adbTarget(host, port), String(code)]);
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
            if (!body.mediaType || !body.dataBase64) return new Response("name, mediaType, dataBase64 required", { status: 400 });
            const attachment = supervisor.addAttachment(sessionId, body.name ?? "attachment", body.mediaType, body.dataBase64);
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
