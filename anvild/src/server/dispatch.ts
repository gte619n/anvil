import { PROTOCOL_VERSION, type ClientCommand, type ServerEvent } from "@protocol";
import { now } from "../util/envelope";
import type { ConnState } from "./connection";
import type { ConnectionRegistry } from "./registry";
import type { PushRegistry } from "../push/registry";
import { BadCommand, type Supervisor } from "../session/supervisor";
import { listDirs } from "../fs/dirs";

export interface DispatchDeps {
  push: PushRegistry;
  supervisor: Supervisor;
  registry: ConnectionRegistry;
  /** Hub-only: replicate the stored Todoist token to fleet members (defined in http.ts, where the
   *  FleetStore lives). Omitted/no-op on leaf members. */
  propagateTodoist?: (targets?: string[]) => void;
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

/** Command types in the contract but not yet built. */
const PENDING: ReadonlySet<string> = new Set<string>([]);

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
        deps.supervisor.viewed(cmd.sessionId); // viewing a session dismisses its "your turn" reminder everywhere
        if (cid) send(ack(cid));
        // replay events with seq > lastSeq, or a conversation.snapshot (arch §6.4)
        for (const event of deps.supervisor.resume(cmd.sessionId, cmd.lastSeq)) send(event);
        void deps.supervisor.refreshPrState(cmd.sessionId); // best-effort: surface an external merge's badge
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

      case "session.archive":
        deps.supervisor
          .archive(cmd.sessionId)
          .then(() => {
            if (cid) send(ack(cid));
          })
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "session.unarchive":
        deps.supervisor.unarchive(cmd.sessionId);
        if (cid) send(ack(cid));
        return;

      case "session.arrange":
        deps.supervisor.arrange(cmd.order, cmd.finished);
        if (cid) send(ack(cid));
        return;

      case "session.reset":
        deps.supervisor
          .reset(cmd.sessionId)
          .then(() => {
            if (cid) send(ack(cid));
          })
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "session.new_topic":
        deps.supervisor
          .newTopic(cmd.sessionId)
          .then(() => {
            if (cid) send(ack(cid));
          })
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "git": {
        const result = deps.supervisor.gitOp(cmd);
        send({ ...result, cid });
        return;
      }

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
        deps.supervisor.prompt(cmd.sessionId, text, cmd.attachmentIds ?? []);
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

      case "question.respond":
        deps.supervisor.resolveQuestion(cmd.requestId, cmd.answers ?? [], Boolean(cmd.cancelled));
        if (cid) send(ack(cid));
        return;

      case "dirs.list": {
        const listing = listDirs(cmd.path);
        send({
          v: PROTOCOL_VERSION,
          type: "dirs.list.result",
          ts: now(),
          cid,
          path: listing.path,
          parent: listing.parent,
          entries: listing.entries,
        });
        return;
      }

      case "env.list":
        send(deps.supervisor.environmentsEvent());
        if (cid) send(ack(cid));
        return;

      case "env.add":
        deps.supervisor.addEnvironment(cmd.name, cmd.repoRoot, cmd.defaultBase, cmd.color);
        if (cid) send(ack(cid));
        return;

      case "env.clone":
        deps.supervisor.cloneEnvironment(cmd.url, cmd.name, cmd.defaultBase, cmd.color);
        if (cid) send(ack(cid));
        return;

      case "daemon.update":
        deps.supervisor
          .daemonUpdate(cmd.checkOnly ?? false)
          .then((result) => send({ ...result, cid }))
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "env.update":
        deps.supervisor.updateEnvironment(cmd.id, {
          name: cmd.name,
          defaultBase: cmd.defaultBase,
          color: cmd.color,
          todoistProjectId: cmd.todoistProjectId,
          validation: cmd.validation,
        });
        if (cid) send(ack(cid));
        return;

      case "env.remove":
        deps.supervisor.removeEnvironment(cmd.id);
        if (cid) send(ack(cid));
        return;

      case "todoist.status":
        send(deps.supervisor.todoistStatusEvent(cid));
        return;

      case "todoist.connect":
        deps.supervisor
          .connectTodoist(cmd.token, cid)
          .then((event) => send(event))
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "todoist.disconnect":
        send(deps.supervisor.disconnectTodoist(cid));
        return;

      case "todoist.propagate":
        deps.propagateTodoist?.(cmd.targets);
        if (cid) send(ack(cid));
        return;

      case "todoist.projects.list":
        deps.supervisor
          .listTodoistProjects(cid)
          .then((event) => send(event))
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "fs.list": {
        const r = deps.supervisor.fsList(cmd.sessionId, cmd.path);
        send({ v: PROTOCOL_VERSION, type: "fs.list.result", ts: now(), cid, sessionId: cmd.sessionId, path: r.path, entries: r.entries });
        return;
      }
      case "fs.read":
        send({ v: PROTOCOL_VERSION, type: "fs.read.result", ts: now(), cid, content: deps.supervisor.fsRead(cmd.sessionId, cmd.path) });
        return;
      case "fs.watch":
        deps.supervisor.fsWatch(cmd.sessionId, cmd.path);
        if (cid) send(ack(cid));
        return;
      case "fs.unwatch":
        deps.supervisor.fsUnwatch(cmd.sessionId, cmd.path);
        if (cid) send(ack(cid));
        return;

      case "terminal.open":
        deps.supervisor.terminalOpen(cmd.sessionId, cmd.cols, cmd.rows);
        if (cid) send(ack(cid));
        return;
      case "terminal.input":
        deps.supervisor.terminalInput(cmd.sessionId, cmd.data);
        return;
      case "terminal.resize":
        deps.supervisor.terminalResize(cmd.sessionId, cmd.cols, cmd.rows);
        return;
      case "terminal.close":
        if (cid) send(ack(cid)); // PTY persists (arch §7); the client just stops rendering
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
