import { PROTOCOL_VERSION, type ClientCommand, type ServerEvent } from "@protocol";
import { now } from "../util/envelope";
import type { ConnState } from "./connection";
import type { ConnectionRegistry } from "./registry";
import type { PushRegistry } from "../push/registry";
import { BadCommand, type Supervisor } from "../session/supervisor";

export interface DispatchDeps {
  push: PushRegistry;
  supervisor: Supervisor;
  registry: ConnectionRegistry;
}

type Send = (event: ServerEvent) => void;

function ack(cid: string): ServerEvent {
  return { v: PROTOCOL_VERSION, type: "ack", ts: now(), cid };
}
function cmdError(message: string, cid?: string): ServerEvent {
  return { v: PROTOCOL_VERSION, type: "command.error", ts: now(), cid, message };
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Command types in the contract but not built until later milestones. */
const PENDING: ReadonlySet<string> = new Set([
  "fs.list",
  "fs.read",
  "fs.watch",
  "fs.unwatch",
  "terminal.open",
  "terminal.input",
  "terminal.resize",
  "terminal.close",
]);

/**
 * Routes one inbound client frame (arch §6.1/§6.3): validates the envelope, narrows on
 * `type`, mutates session state via the supervisor, and replies `ack` (for correlated
 * commands) or `command.error`.
 */
export function dispatch(conn: ConnState, raw: string, send: Send, deps: DispatchDeps): void {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    send(cmdError("invalid JSON"));
    return;
  }
  if (typeof msg !== "object" || msg === null) {
    send(cmdError("malformed message: expected an object"));
    return;
  }

  const record = msg as Record<string, unknown>;
  const cid = typeof record.cid === "string" ? record.cid : undefined;

  if (record.v !== PROTOCOL_VERSION) {
    send(cmdError(`unsupported protocol version: ${String(record.v)} (expected ${PROTOCOL_VERSION})`, cid));
    return;
  }
  if (typeof record.type !== "string") {
    send(cmdError("missing command type", cid));
    return;
  }

  const cmd = msg as ClientCommand;
  try {
    switch (cmd.type) {
      case "push.register":
        deps.push.register(conn.id, cmd.platform, cmd.token, now());
        if (cid) send(ack(cid));
        return;

      case "push.unregister":
        deps.push.unregister(cmd.token);
        if (cid) send(ack(cid));
        return;

      case "session.create": {
        const session = deps.supervisor.create(cmd);
        conn.attached.add(session.id);
        const created: ServerEvent = { v: PROTOCOL_VERSION, type: "session.created", ts: now(), session: session.data };
        send({ ...created, cid }); // creator: carries the cid
        deps.registry.toAll(created, conn.id); // other devices: no cid
        return;
      }

      case "session.attach": {
        if (!deps.supervisor.get(cmd.sessionId)) {
          send(cmdError(`no such session: ${cmd.sessionId}`, cid));
          return;
        }
        conn.attached.add(cmd.sessionId);
        if (cid) send(ack(cid));
        // replay events with seq > lastSeq, or a conversation.snapshot (arch §6.4)
        for (const event of deps.supervisor.resume(cmd.sessionId, cmd.lastSeq)) send(event);
        return;
      }

      case "session.detach":
        conn.attached.delete(cmd.sessionId);
        if (cid) send(ack(cid));
        return;

      case "session.kill":
        deps.supervisor
          .kill(cmd.sessionId)
          .then(() => {
            if (cid) send(ack(cid));
          })
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "session.set_model":
        deps.supervisor.setModel(cmd.sessionId, cmd.model);
        if (cid) send(ack(cid));
        return;

      case "session.set_autonomy":
        deps.supervisor.setAutonomy(cmd.sessionId, cmd.policy);
        if (cid) send(ack(cid));
        return;

      case "prompt.send": {
        // attach so this connection receives the streamed turn (arch §6.4)
        conn.attached.add(cmd.sessionId);
        let text = cmd.text;
        if (cmd.cites?.length) {
          const ctx = cmd.cites
            .map((c) => `> ${c.path}:${c.startLine}-${c.endLine}\n${c.excerpt}`)
            .join("\n\n");
          text = `${ctx}\n\n${text}`;
        }
        // NOTE: attachmentIds are accepted but not yet materialized (REST upload is §6.5).
        deps.supervisor.prompt(cmd.sessionId, text);
        if (cid) send(ack(cid));
        return;
      }

      case "interrupt":
        deps.supervisor.interrupt(cmd.sessionId);
        if (cid) send(ack(cid));
        return;

      case "permission.respond":
        deps.supervisor.resolvePermission(cmd.requestId, cmd.decision, cmd.updatedInput);
        if (cid) send(ack(cid));
        return;

      default: {
        const type = record.type;
        if (PENDING.has(type)) {
          send(cmdError(`'${type}' is recognized but not implemented yet (pending a later milestone)`, cid));
        } else {
          send(cmdError(`unknown command type: '${type}'`, cid));
        }
      }
    }
  } catch (e) {
    // BadCommand and anything thrown synchronously becomes a clean command.error
    if (e instanceof BadCommand) send(cmdError(e.message, cid));
    else send(cmdError(`internal error: ${errMsg(e)}`, cid));
  }
}
