import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  type ConversationEvent,
  type ConversationSnapshotEvent,
  type ServerEvent,
} from "@protocol";
import { now } from "../util/envelope";

/**
 * Session-scoped events that carry `seq` but are NOT persisted to the durable conversation
 * log (arch §6.4, protocol note):
 *   - assistant.delta — transient streaming chunks, superseded by assistant.message
 *   - terminal.*      — high-volume PTY bytes; terminal resume is scrollback replay, not snapshot
 */
const SKIP_PERSIST: ReadonlySet<string> = new Set([
  "assistant.delta",
  "terminal.data",
  "terminal.exit",
  "fs.changed", // live re-render of a watched file; re-derivable, not conversation history
]);

/**
 * Append-only per-session event log (`events.ndjson`) — the source of truth for resume
 * (arch §5/§6.4). `since` replays raw events after a watermark; `snapshot` folds the log
 * into the compacted ConversationEvent form for a cold attach.
 */
export class EventLog {
  private readonly file: string;

  constructor(sessionDir: string) {
    this.file = join(sessionDir, "events.ndjson");
  }

  append(event: ServerEvent): void {
    if (SKIP_PERSIST.has(event.type)) return;
    try {
      appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    } catch (e) {
      // A killed session's dir is removed while its agent turn may still be draining (driver.stop
      // can't synchronously halt an in-flight consume()). A late emit then targets a gone file —
      // dropping it is correct (the session is dead). MUST NOT throw: this runs inside emit(), off
      // the async turn loop, so an uncaught ENOENT here would crash the whole daemon (all sessions).
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
  }

  private readAll(): ServerEvent[] {
    if (!existsSync(this.file)) return [];
    const out: ServerEvent[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ServerEvent);
      } catch {
        /* skip a torn final line */
      }
    }
    return out;
  }

  /** Raw events with `seq > lastSeq`, in order (replay path, arch §6.4). */
  since(lastSeq: number): ServerEvent[] {
    return this.readAll().filter((e) => {
      const seq = (e as { seq?: number }).seq;
      return typeof seq === "number" && seq > lastSeq;
    });
  }

  /** Compacted snapshot for a cold attach (no/stale lastSeq), arch §6.4. */
  snapshot(sessionId: string, lastSeq: number): ConversationSnapshotEvent {
    const events: ConversationEvent[] = [];
    for (const e of this.readAll()) {
      const a = e as any;
      switch (e.type) {
        case "message.user":
          events.push({ kind: "user", rendered: a.rendered, attachments: a.attachments ?? [] });
          break;
        case "assistant.message":
          events.push({ kind: "assistant", blocks: a.blocks });
          break;
        case "tool.result":
          events.push({ kind: "tool_result", toolUseId: a.toolUseId, content: a.content, isError: a.isError });
          break;
        case "result":
          events.push({ kind: "result", stopReason: a.stopReason, usage: a.usage });
          break;
        default:
          break; // status / usage / tool.use / permission.request / error are not part of the snapshot
      }
    }
    return { v: PROTOCOL_VERSION, type: "conversation.snapshot", ts: now(), sessionId, seq: lastSeq, events, lastSeq };
  }
}
