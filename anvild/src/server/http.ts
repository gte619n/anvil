import type { ServerWebSocket } from "bun";
import type { rest } from "@protocol";
import { checkAuth } from "../auth/guard";
import { newId } from "../util/ids";
import { dispatch } from "./dispatch";
import { ConnectionRegistry } from "./registry";
import { PushRegistry } from "../push/registry";
import { Supervisor } from "../session/supervisor";
import type { MarkdownRenderer } from "../render/markdown";
import type { ConnState } from "./connection";
import { join } from "node:path";
import { hostname } from "node:os";

export const VERSION = "0.1.0";

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

  const server = Bun.serve<ConnState>({
    hostname: opts.host ?? "127.0.0.1",
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);

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

      // ADB wifi (Android client): connect the Mac to a phone's wireless-debugging endpoint
      if (url.pathname === "/api/adb/connect" && req.method === "POST") {
        try {
          const { host, port } = (await req.json()) as { host?: string; port?: number };
          if (!host || !port) return new Response("host and port required", { status: 400 });
          const target = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`; // IPv6 needs brackets
          return Response.json(runAdb(["connect", target]));
        } catch {
          return new Response("bad request", { status: 400 });
        }
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

      // worktree files (arch §8.1): serve a binary/image file from the session worktree
      const fileMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/files$/);
      if (fileMatch && req.method === "GET") {
        const sessionId = fileMatch[1]!;
        const path = url.searchParams.get("path") ?? "";
        try {
          const abs = supervisor.fsResolve(sessionId, path);
          const file = Bun.file(abs);
          if (!(await file.exists())) return new Response("not found", { status: 404 });
          return new Response(file);
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
    },
    websocket: {
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
    },
  });

  return {
    port: server.port ?? opts.port,
    stop: () => server.stop(true),
  };
}
