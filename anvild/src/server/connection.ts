/** Per-WebSocket-connection state (arch §6.2). Lives in `ServerWebSocket.data`. */
export interface ConnState {
  id: string;
  /** sessionIds this connection is attached to (used for live broadcast / resume). */
  attached: Set<string>;
  /** Shadow subscription (comprehensive-offline §4.3): durable events for sessions this conn is NOT
   *  attached to are also fanned out here (as droppable copies) to keep its offline mirror warm.
   *  `"all"` = every session; a Set = a bounded list; undefined = not subscribed. */
  shadow?: "all" | Set<string>;
}
