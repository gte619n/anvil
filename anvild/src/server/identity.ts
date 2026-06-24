import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import type { ServerHelloEvent } from "@protocol";
import { PROTOCOL_VERSION } from "@protocol";
import { now } from "../util/envelope";
import { newId } from "../util/ids";
import { VERSION } from "../version";

/**
 * This server's stable identity (anvil-multi-server.md §3). `serverId` is generated once and
 * persisted to `<stateDir>/server-id`, so a client federating many servers can key each
 * socket's sessions/environments by it and survive daemon restarts. `serverName` is a display
 * label — `ANVIL_SERVER_NAME` if set, else the hostname.
 */
export interface ServerIdentity {
  serverId: string;
  serverName: string;
}

export function loadServerIdentity(stateDir: string, env: Record<string, string | undefined> = process.env): ServerIdentity {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, "server-id");
  let serverId = "";
  if (existsSync(file)) serverId = readFileSync(file, "utf8").trim();
  if (!serverId) {
    serverId = newId("srv");
    writeFileSync(file, `${serverId}\n`);
  }
  const serverName = (env.ANVIL_SERVER_NAME ?? "").trim() || hostname();
  return { serverId, serverName };
}

/** The `server.hello` frame emitted first on every WS connection (§6). */
export function serverHelloEvent(id: ServerIdentity): ServerHelloEvent {
  return {
    v: PROTOCOL_VERSION,
    type: "server.hello",
    ts: now(),
    serverId: id.serverId,
    serverName: id.serverName,
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
  };
}
