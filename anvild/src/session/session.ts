import {
  PROTOCOL_VERSION,
  type PermissionSuggestion,
  type Question,
  type ServerEvent,
  type Session as SessionData,
  type SessionStatus,
} from "@protocol";
import { now } from "../util/envelope";
import { killGroup, type Group } from "./procgroup";

/** The session-scoped subset of ServerEvent (carries `sessionId` + `seq`). */
type SessionScopedEvent = Extract<ServerEvent, { sessionId: string; seq: number }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What `emit` accepts — a session-scoped event minus the fields the session fills in. */
export type SessionEventBody = DistributiveOmit<SessionScopedEvent, "v" | "ts" | "sessionId" | "seq">;

export type EventSink = (sessionId: string, event: ServerEvent) => void;

/**
 * One live session (arch §5). Owns the per-session monotonic `seq` counter and the single
 * `emit()` that assigns `seq` → (M6: appends to the event log) → broadcasts. This is the
 * ONLY place `seq` is minted, which guarantees per-session monotonicity (arch §6.1).
 */
/** A permission prompt currently parked in the PreToolUse hook (arch §6.6). */
export interface PendingPermission {
  requestId: string;
  tool: string;
  input: unknown;
  suggestions: PermissionSuggestion[];
}
/** An AskUserQuestion prompt currently parked in the canUseTool handler (arch §6.6). */
export interface PendingQuestion {
  requestId: string;
  questions: Question[];
}

export class Session {
  private nextSeq: number;
  private group: Group | undefined;
  private readonly alwaysAllow = new Set<string>();
  /** Prompts currently parked in the PreToolUse hook, keyed by requestId. A single session can hold
   *  SEVERAL at once — sub-agents (the `Agent`/Task tool) fan out and each parks its own tool prompt.
   *  A (re)attaching client re-surfaces all of them (arch §6.4/§6.6). */
  readonly pendingPermissions = new Map<string, PendingPermission>();
  /** AskUserQuestion prompts parked in canUseTool, keyed by requestId. Like permissions, sub-agents
   *  can fan out several at once, so a (re)attaching client re-surfaces all of them (arch §6.6). */
  readonly pendingQuestions = new Map<string, PendingQuestion>();
  /** The most recent assistant prose (plain text, trimmed) — used to give the "your turn"
   *  notification real context ("…here's the summary") instead of a generic "Finished". Transient. */
  lastAssistantText: string | undefined;
  /** Once disposed (killed/archived/shutdown) `emit` is a no-op — a late-draining agent turn must
   *  not write into a dead session (would target a removed dir/connection and crash the daemon). */
  private disposed = false;

  constructor(
    public data: SessionData,
    lastSeq: number,
    private readonly sink: EventSink,
    private readonly onChange: () => void,
    private readonly append: (event: ServerEvent) => void = () => {},
  ) {
    this.nextSeq = lastSeq + 1;
  }

  get id(): string {
    return this.data.id;
  }
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
  /** Stop accepting events (kill/archive/shutdown). Idempotent. */
  dispose(): void {
    this.disposed = true;
  }

  /** Mint `seq`, persist to the event log, broadcast to attached connections, mark dirty. The
   *  append/sink/persist steps are individually guarded so one failure (e.g. a removed dir or a
   *  dead socket on a session being torn down) is logged, not thrown into the agent turn loop. */
  emit(body: SessionEventBody): ServerEvent {
    const seq = this.nextSeq++;
    const event = { ...body, v: PROTOCOL_VERSION, ts: now(), sessionId: this.data.id, seq } as ServerEvent;
    if (this.disposed) return event; // session is gone; drop the late event silently
    try {
      this.append(event); // durable log (arch §6.4); skips deltas/terminal internally
    } catch (e) {
      console.error(`[session ${this.data.id}] append failed: ${e instanceof Error ? e.message : e}`);
    }
    try {
      this.sink(this.data.id, event);
    } catch (e) {
      console.error(`[session ${this.data.id}] broadcast failed: ${e instanceof Error ? e.message : e}`);
    }
    try {
      this.onChange();
    } catch (e) {
      console.error(`[session ${this.data.id}] persist failed: ${e instanceof Error ? e.message : e}`);
    }
    return event;
  }

  /** Per-session "always allow" set for allow_always decisions (arch §6.6). */
  rememberAllow(tool: string): void {
    this.alwaysAllow.add(tool);
  }
  isAlwaysAllowed(tool: string): boolean {
    return this.alwaysAllow.has(tool);
  }

  setStatus(status: SessionStatus): void {
    // The awaiting states are STICKY while ANY prompt (permission or question) is still parked:
    // during sub-agent fan-out an already-answered sub-agent keeps working and the driver reports
    // running_tool/thinking, but the session must keep advertising that it needs the user (fleet
    // badge + the parked sibling cards) until every prompt is resolved. The awaiting statuses
    // themselves, plus terminal/error/idle, always pass through. (arch §6.6)
    const parked = this.pendingPermissions.size > 0 || this.pendingQuestions.size > 0;
    if (
      parked &&
      status !== "awaiting_permission" &&
      status !== "awaiting_question" &&
      status !== "error" &&
      status !== "idle"
    ) {
      return;
    }
    this.data.status = status;
    this.data.lastActivityAt = now();
    this.emit({ type: "status", status });
  }

  /** After a parked prompt resolves, the status to settle on: keep advertising any prompt STILL
   *  waiting (a sibling from sub-agent fan-out), else fall back to the caller's working status. */
  settleStatus(fallback: SessionStatus): SessionStatus {
    if (this.pendingPermissions.size > 0) return "awaiting_permission";
    if (this.pendingQuestions.size > 0) return "awaiting_question";
    return fallback;
  }

  /** Surface an agent/turn error to attached clients (arch §6.2). */
  emitError(message: string, fatal: boolean): void {
    if (fatal) this.data.status = "error";
    this.emit({ type: "error", message, fatal });
  }

  /** Whether any permission prompt is still parked (drives the "needs approval" fleet badge). */
  hasPendingPermission(): boolean {
    return this.pendingPermissions.size > 0;
  }

  /** Block on a permission decision (arch §6.6): flips to awaiting_permission + emits the request.
   *  Several may be parked at once (sub-agent fan-out) — each is tracked + re-surfaced by requestId. */
  requestPermission(requestId: string, tool: string, input: unknown, suggestions: PermissionSuggestion[]): void {
    this.pendingPermissions.set(requestId, { requestId, tool, input, suggestions });
    this.setStatus("awaiting_permission");
    this.emit({ type: "permission.request", requestId, tool, input, suggestions });
  }

  /** A parked permission was answered or superseded: stop re-surfacing it on reattach. With no
   *  requestId, drop ALL parked prompts (used by reset/teardown to unblock a wedged session). */
  clearPermission(requestId?: string): void {
    if (!requestId) this.pendingPermissions.clear();
    else this.pendingPermissions.delete(requestId);
  }

  /** Drop one parked permission AND tell every device to retire exactly that card (decoupled from
   *  the session's transient status, since a sibling prompt may still be parked). (arch §6.6) */
  permissionResolved(requestId: string): void {
    this.pendingPermissions.delete(requestId);
    this.emit({ type: "permission.resolved", requestId });
  }

  /** Supersede ALL parked permissions (reset/newTopic): announce each so clients retire its card,
   *  then drop them. The broker is unblocked separately (resolveSession). (arch §6.6) */
  resolveAllPermissions(): void {
    for (const requestId of [...this.pendingPermissions.keys()]) this.permissionResolved(requestId);
  }

  /** Every unresolved permission prompt, re-emitted so a cold-attaching client re-surfaces them all
   *  (the snapshot drops permission.request from history). */
  permissionRequestEvents(): ServerEvent[] {
    return [...this.pendingPermissions.values()].map(
      (p) =>
        ({
          v: PROTOCOL_VERSION,
          type: "permission.request",
          ts: now(),
          sessionId: this.data.id,
          seq: this.lastSeq,
          requestId: p.requestId,
          tool: p.tool,
          input: p.input,
          suggestions: p.suggestions,
        }) as ServerEvent,
    );
  }

  /** Whether any AskUserQuestion prompt is still parked. */
  hasPendingQuestion(): boolean {
    return this.pendingQuestions.size > 0;
  }

  /** Block on an AskUserQuestion answer (arch §6.6): flip to awaiting_question + emit the prompt.
   *  Several may be parked at once (sub-agent fan-out) — each tracked + re-surfaced by requestId. */
  requestQuestion(requestId: string, questions: Question[]): void {
    this.pendingQuestions.set(requestId, { requestId, questions });
    this.setStatus("awaiting_question");
    this.emit({ type: "question.request", requestId, questions });
  }

  /** A parked question was answered or superseded: stop re-surfacing it. No requestId → drop ALL. */
  clearQuestion(requestId?: string): void {
    if (!requestId) this.pendingQuestions.clear();
    else this.pendingQuestions.delete(requestId);
  }

  /** Drop one parked question AND tell every device to retire exactly that card (decoupled from the
   *  session's transient status, since a sibling prompt may still be parked). (arch §6.6) */
  questionResolved(requestId: string): void {
    this.pendingQuestions.delete(requestId);
    this.emit({ type: "question.resolved", requestId });
  }

  /** Supersede ALL parked questions (reset/newTopic): announce each so clients retire its card. */
  resolveAllQuestions(): void {
    for (const requestId of [...this.pendingQuestions.keys()]) this.questionResolved(requestId);
  }

  /** Every unresolved AskUserQuestion prompt, re-emitted so a cold-attaching client re-surfaces all
   *  (the snapshot drops question.request from history). */
  questionRequestEvents(): ServerEvent[] {
    return [...this.pendingQuestions.values()].map(
      (q) =>
        ({
          v: PROTOCOL_VERSION,
          type: "question.request",
          ts: now(),
          sessionId: this.data.id,
          seq: this.lastSeq,
          requestId: q.requestId,
          questions: q.questions,
        }) as ServerEvent,
    );
  }

  /** Attach the agent's process group (M5) so kill can reap it. */
  attachGroup(group: Group): void {
    this.group = group;
  }

  /** Reap the process group, if any (arch §5). */
  async stop(): Promise<void> {
    if (this.group) {
      await killGroup(this.group); // [BE-10] pass the Group so it won't signal a reused pgid
      this.group = undefined;
    }
  }
}
