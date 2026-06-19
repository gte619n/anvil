import type { ServerWebSocket } from "bun";
import type { rest } from "@protocol";
import { checkAuth } from "../auth/guard";
import { newId } from "../util/ids";
import { dispatch } from "./dispatch";
import { ConnectionRegistry } from "./registry";
import { PushRegistry } from "../push/registry";
import { Supervisor } from "../session/supervisor";
import type { ConnState } from "./connection";

export const VERSION = "0.1.0";

export interface ServerHandle {
  port: number;
  stop: () => void;
}

export interface ServerOptions {
  port: number;
  stateDir: string;
  warnFraction?: number;
  softStopFraction?: number;
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
    { stateDir: opts.stateDir, warnFraction: opts.warnFraction, softStopFraction: opts.softStopFraction },
    registry,
  );

  const server = Bun.serve<ConnState>({
    port: opts.port,
    fetch(req, srv) {
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
