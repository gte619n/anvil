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

export const VERSION = "0.1.0";

// The built web client (anvild/web/dist), resolved relative to this source file.
const WEB_DIR = join(import.meta.dir, "..", "..", "web", "dist");

// CSP for the app shell. Mermaid + the markdown body run here, but all markdown HTML is
// DOMPurify-sanitized server-side (arch §8.3); scripts are limited to our own bundle.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'", // Shiki inline color vars + KaTeX/mermaid styles
  "script-src 'self'",
  "connect-src 'self' ws: wss:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

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
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/api/health") {
        const auth = checkAuth();
        const body: rest.HealthResponse = {
          ok: true,
          subscriptionAuthOk: auth.subscriptionAuthOk,
          version: VERSION,
          budget: supervisor.budget(),
        };
        return Response.json(body);
      }

      if (url.pathname === "/ws") {
        const data: ConnState = { id: newId("conn"), attached: new Set() };
        if (srv.upgrade(req, { data })) return undefined;
        return new Response("expected a websocket upgrade", { status: 426 });
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
