import type { ServerWebSocket } from "bun";
import type { ServerEvent } from "@protocol";
import type { ConnState } from "./connection";

/**
 * Tracks open connections and fans events out (arch §6.2):
 *  - `toAll` for global `session.*` events (optionally excluding the originating conn),
 *  - `toAttached` for session-scoped events, only to connections attached to that session.
 */
// [BE2-20] Outbound backpressure. The daemon never checked `ws.send()`'s buffer, so a half-open client
// (a backgrounded phone on a dead Tailscale tunnel keeps readyState OPEN for up to idleTimeout=120s)
// buffered every broadcast unbounded — an OOM vector under a delta stream. Two caps:
//   • SOFT — past it, DROP re-derivable delta frames. v4 incremental resume re-syncs the transcript on
//     reconnect (spec A3), so a dropped `assistant.delta` costs nothing; back-pressure relief is free.
//   • HARD — the socket is genuinely wedged; close it so the client reconnects fresh instead of the
//     daemon holding megabytes for a peer that will never drain them.
const SEND_SOFT_CAP = 1 << 20; // 1 MiB buffered → start dropping droppable frames
const SEND_HARD_CAP = 8 << 20; // 8 MiB buffered → close the wedged socket

/** Frames safe to drop under back-pressure because the client can re-derive them (v4 resume). */
function isDroppable(type: string): boolean {
  return type === "assistant.delta";
}

export class ConnectionRegistry {
  private readonly conns = new Set<ServerWebSocket<ConnState>>();

  add(ws: ServerWebSocket<ConnState>): void {
    this.conns.add(ws);
  }
  remove(ws: ServerWebSocket<ConnState>): void {
    this.conns.delete(ws);
  }
  all(): ServerWebSocket<ConnState>[] {
    return [...this.conns];
  }

  /** Send one frame with back-pressure applied (see the caps above). */
  private sendBp(ws: ServerWebSocket<ConnState>, json: string, droppable: boolean): void {
    const buffered = ws.getBufferedAmount?.() ?? 0;
    if (buffered > SEND_HARD_CAP) {
      try {
        ws.close(); // wedged peer — drop it; the registry's `remove` fires on close
      } catch {
        /* already closing */
      }
      return;
    }
    if (droppable && buffered > SEND_SOFT_CAP) return; // shed a re-derivable delta to relieve pressure
    ws.send(json);
  }

  toAll(event: ServerEvent, exceptConnId?: string): void {
    const json = JSON.stringify(event);
    const droppable = isDroppable(event.type);
    for (const ws of this.conns) {
      if (ws.data.id !== exceptConnId) this.sendBp(ws, json, droppable);
    }
  }

  toAttached(sessionId: string, event: ServerEvent): void {
    const json = JSON.stringify(event);
    const droppable = isDroppable(event.type);
    for (const ws of this.conns) {
      if (ws.data.attached.has(sessionId)) this.sendBp(ws, json, droppable);
    }
  }
}
