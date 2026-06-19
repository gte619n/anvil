import {
  PROTOCOL_VERSION,
  type PermissionSuggestion,
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
export class Session {
  private nextSeq: number;
  private group: Group | undefined;
  private readonly alwaysAllow = new Set<string>();

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

  /** Mint `seq`, persist to the event log, broadcast to attached connections, mark dirty. */
  emit(body: SessionEventBody): ServerEvent {
    const seq = this.nextSeq++;
    const event = { ...body, v: PROTOCOL_VERSION, ts: now(), sessionId: this.data.id, seq } as ServerEvent;
    this.append(event); // durable log (arch §6.4); skips deltas/terminal internally
    this.sink(this.data.id, event);
    this.onChange();
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
    this.setStatus("awaiting_permission");
    this.emit({ type: "permission.request", requestId, tool, input, suggestions });
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
