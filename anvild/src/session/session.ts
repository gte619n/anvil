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
  /** Set while blocked on a decision so a (re)attaching client can re-surface it (arch §6.4). */
  pendingPermission: PendingPermission | undefined;
  /** Set while blocked on an AskUserQuestion answer so a cold-attaching client re-surfaces it. */
  pendingQuestion: PendingQuestion | undefined;
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
    this.data.status = status;
    this.data.lastActivityAt = now();
    this.emit({ type: "status", status });
  }

  /** Surface an agent/turn error to attached clients (arch §6.2). */
  emitError(message: string, fatal: boolean): void {
    if (fatal) this.data.status = "error";
    this.emit({ type: "error", message, fatal });
  }

  /** Block on a permission decision (arch §6.6): flips to awaiting_permission + emits the request. */
  requestPermission(requestId: string, tool: string, input: unknown, suggestions: PermissionSuggestion[]): void {
    this.pendingPermission = { requestId, tool, input, suggestions };
    this.setStatus("awaiting_permission");
    this.emit({ type: "permission.request", requestId, tool, input, suggestions });
  }

  /** A parked permission was answered (or superseded): stop re-surfacing it on reattach. */
  clearPermission(requestId?: string): void {
    if (!requestId || this.pendingPermission?.requestId === requestId) this.pendingPermission = undefined;
  }

  /** The unresolved permission prompt, if this session is currently blocked on one. */
  permissionRequestEvent(): ServerEvent | undefined {
    if (!this.pendingPermission) return undefined;
    const p = this.pendingPermission;
    return {
      v: PROTOCOL_VERSION,
      type: "permission.request",
      ts: now(),
      sessionId: this.data.id,
      seq: this.lastSeq,
      requestId: p.requestId,
      tool: p.tool,
      input: p.input,
      suggestions: p.suggestions,
    };
  }

  /** Block on an AskUserQuestion answer (arch §6.6): flip to awaiting_question + emit the prompt. */
  requestQuestion(requestId: string, questions: Question[]): void {
    this.pendingQuestion = { requestId, questions };
    this.setStatus("awaiting_question");
    this.emit({ type: "question.request", requestId, questions });
  }

  /** A parked question was answered (or superseded): stop re-surfacing it on reattach. */
  clearQuestion(requestId?: string): void {
    if (!requestId || this.pendingQuestion?.requestId === requestId) this.pendingQuestion = undefined;
  }

  /** The unresolved AskUserQuestion prompt, if this session is currently blocked on one. */
  questionRequestEvent(): ServerEvent | undefined {
    if (!this.pendingQuestion) return undefined;
    const q = this.pendingQuestion;
    return {
      v: PROTOCOL_VERSION,
      type: "question.request",
      ts: now(),
      sessionId: this.data.id,
      seq: this.lastSeq,
      requestId: q.requestId,
      questions: q.questions,
    };
  }

  /** Attach the agent's process group (M5) so kill can reap it. */
  attachGroup(group: Group): void {
    this.group = group;
  }

  /** Reap the process group, if any (arch §5). */
  async stop(): Promise<void> {
    if (this.group) {
      await killGroup(this.group.pgid);
      this.group = undefined;
    }
  }
}
