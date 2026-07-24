import { PROTOCOL_VERSION, type ServerEvent } from "@protocol";
import { now } from "../util/envelope";
import { parseCommandFrame } from "./command-frame";
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

/**
 * Routes one inbound client frame (arch §6.1/§6.3): validates the envelope (parseCommandFrame),
 * narrows on `type`, mutates session state via the supervisor, and replies `ack` (for correlated
 * commands) or `command.error`.
 */
export function dispatch(conn: ConnState, raw: string, send: Send, deps: DispatchDeps): void {
  const parsed = parseCommandFrame(raw);
  if (!parsed.ok) {
    send(cmdError(parsed.message, parsed.cid));
    return;
  }
  const { cmd, cid } = parsed;
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

      case "session.set_adversarial_review":
        deps.supervisor.setAdversarialReview(cmd.sessionId, cmd.enabled);
        if (cid) send(ack(cid));
        return;

      case "team.plan.approve":
        deps.supervisor.approveTeamPlan(cmd.sessionId, cmd.plan);
        if (cid) send(ack(cid));
        return;

      case "team.plan.reject":
        deps.supervisor.rejectTeamPlan(cmd.sessionId);
        if (cid) send(ack(cid));
        return;

      case "team.integrate":
        deps.supervisor.integrateTeam(cmd.sessionId);
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
        deps.supervisor.noteHumanPrompt(cmd.sessionId); // a human in the loop resets the team relay guard
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
        deps.supervisor.addEnvironment(cmd.name, cmd.repoRoot, cmd.defaultBase, cmd.color, cmd.icon);
        if (cid) send(ack(cid));
        return;

      case "env.clone":
        deps.supervisor.cloneEnvironment(cmd.url, cmd.name, cmd.defaultBase, cmd.color, cmd.icon);
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
          icon: cmd.icon,
          todoistProjectId: cmd.todoistProjectId,
          validation: cmd.validation,
        });
        if (cid) send(ack(cid));
        return;

      case "env.remove":
        deps.supervisor.removeEnvironment(cmd.id);
        if (cid) send(ack(cid));
        return;

      case "prompt.list":
        send(deps.supervisor.promptsEvent());
        if (cid) send(ack(cid));
        return;

      case "prompt.save":
        deps.supervisor.savePrompt({ id: cmd.id, title: cmd.title, shortTitle: cmd.shortTitle, icon: cmd.icon, body: cmd.body });
        if (cid) send(ack(cid));
        return;

      case "prompt.remove":
        deps.supervisor.removePrompt(cmd.id);
        if (cid) send(ack(cid));
        return;

      case "todoist.status":
        send(deps.supervisor.todoistStatusEvent(cid));
        return;

      case "todoist.connect":
        deps.supervisor
          .connectTodoist(cmd.token, cid)
          .then((event) => {
            send(event);
            // Fan the freshly-connected token out to the whole fleet (untargeted) so every member that
            // hosts a linked environment can run autopilot — and so stale member records self-heal.
            // No-op on a leaf (empty fleet) or if no token is set.
            deps.propagateTodoist?.();
          })
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

      case "lapo.status":
        send(deps.supervisor.lapoStatusEvent(cid));
        return;

      case "lapo.connect":
        // Begin the OAuth handshake: discovers endpoints, then returns the authorize URL for the client
        // to open. The exchange itself lands on the daemon's HTTP callback (http.ts) → broadcasts status.
        deps.supervisor
          .beginLapoAuth(cmd.redirectBase, cid)
          .then((event) => send(event))
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "lapo.disconnect":
        send(deps.supervisor.disconnectLapo(cid));
        return;

      case "auth.status":
        send(deps.supervisor.authStatus(cmd.provider ?? "claude", cid));
        return;

      case "auth.set":
        send(deps.supervisor.setAuthToken(cmd.provider ?? "claude", cmd.token, cid)); // BadCommand (empty/metered key) → command.error via the outer catch
        return;

      case "auth.clear":
        send(deps.supervisor.clearAuthToken(cmd.provider ?? "claude", cid));
        return;

      case "autopilot.plans.list":
        send(deps.supervisor.autopilotPlansEvent(cid));
        return;

      case "autopilot.refine":
        deps.supervisor
          .refinePlan(cmd.workUnitId, cmd.feedback, cid)
          .then((event) => send(event))
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "autopilot.dismiss":
        deps.supervisor
          .dismissPlan(cmd.workUnitId)
          .then(() => {
            if (cid) send(ack(cid));
          })
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "autopilot.start":
        send(deps.supervisor.startPlan(cmd.workUnitId, cmd.model, cmd.autonomy, cid));
        return;

      case "autopilot.pipeline.start":
        // Long-running (many model calls). Progress broadcasts from inside the supervisor; the final
        // result returns to the caller (cid). Mirrors autopilot.run's fire-and-report shape.
        deps.supervisor
          .runDevPipeline(cmd.workUnitId)
          .then((o) => send({ v: PROTOCOL_VERSION, type: "autopilot.pipeline.result", ts: now(), cid, ok: true, workUnitId: cmd.workUnitId, status: o.status, phaseReached: o.phaseReached, output: o.reason ?? `pipeline ${o.status}` }))
          .catch((e) => send({ v: PROTOCOL_VERSION, type: "autopilot.pipeline.result", ts: now(), cid, ok: false, workUnitId: cmd.workUnitId, output: errMsg(e) }));
        return;

      case "autopilot.pipeline.metrics":
        send(deps.supervisor.devPipelineMetricsEvent(cid));
        return;

      case "autopilot.resolve":
        deps.supervisor
          .resolvePlan(cmd.workUnitId, cmd.status, cmd.closeTodoist)
          .then(() => {
            if (cid) send(ack(cid));
          })
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "autopilot.link":
        send(deps.supervisor.linkPlan(cmd.workUnitId, cmd.sessionId, cid));
        return;

      case "autopilot.reassign":
        deps.supervisor
          .reassignPlan(cmd.workUnitId, cmd.environmentId, cid)
          .then((event) => send(event))
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "autopilot.run":
        deps.supervisor
          // Progress + plan-grid updates broadcast to every client from inside the supervisor (so manual
          // and scheduled runs behave identically); only the final result returns to the caller (cid).
          .runAutopilot({
            environmentId: cmd.environmentId,
            notify: false, // interactive run — the open screen updates live; push is for scheduled runs
          })
          .then((r) => send({ v: PROTOCOL_VERSION, type: "autopilot.run.result", ts: now(), cid, ok: true, created: r.created, skipped: r.skipped, output: r.output }))
          .catch((e) => send({ v: PROTOCOL_VERSION, type: "autopilot.run.result", ts: now(), cid, ok: false, created: 0, skipped: 0, output: errMsg(e) }));
        return;

      case "autopilot.tags.reset":
        deps.supervisor
          .resetAnvilTags(cid)
          .then((event) => send(event))
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "autopilot.clear":
        deps.supervisor
          .clearAutopilot(cid)
          .then((event) => send(event))
          .catch((e) => send(cmdError(errMsg(e), cid)));
        return;

      case "autopilot.schedule.get":
        send(deps.supervisor.autopilotScheduleEvent(cid));
        return;

      case "autopilot.schedule.set":
        send(
          deps.supervisor.setAutopilotSchedule(
            { enabled: cmd.enabled, timeOfDay: cmd.timeOfDay, days: cmd.days, autoStart: cmd.autoStart, usePipeline: cmd.usePipeline, maxAutoStart: cmd.maxAutoStart },
            cid,
          ),
        );
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

      case "ping":
        // Heartbeat (§6.4): echo pong so the client can prove the socket is still alive and
        // detect a half-open connection. Deliberately not correlated — no cid, no ack.
        send({ v: PROTOCOL_VERSION, type: "pong", ts: now() });
        return;

      default:
        send(cmdError(`unknown command type: '${(cmd as { type: string }).type}'`, cid));
    }
  } catch (e) {
    // BadCommand and anything thrown synchronously becomes a clean command.error
    if (e instanceof BadCommand) send(cmdError(e.message, cid));
    else send(cmdError(`internal error: ${errMsg(e)}`, cid));
  }
}
