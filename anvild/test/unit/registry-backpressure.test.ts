/**
 * [BE2-20] The registry fanned out every broadcast with a bare ws.send(), ignoring the send buffer. A
 * half-open client (backgrounded phone on a dead tunnel — readyState stays OPEN for idleTimeout=120s)
 * then buffered every frame unbounded, an OOM vector under a delta stream. These pin the two caps: a
 * re-derivable `assistant.delta` is DROPPED past the soft cap (v4 resume re-syncs it), a
 * non-droppable frame is always sent, and a genuinely wedged socket is CLOSED past the hard cap.
 */
import { test, expect } from "bun:test";
import { ConnectionRegistry } from "../../src/server/registry";
import type { ServerEvent } from "@protocol";

function fakeWs(id: string, buffered: number, attached: string[] = []) {
  return {
    data: { id, attached: new Set(attached) },
    buffered,
    sent: [] as string[],
    closed: false,
    getBufferedAmount() {
      return this.buffered;
    },
    send(s: string) {
      this.sent.push(s);
    },
    close() {
      this.closed = true;
    },
  };
}

const delta = { v: 4, ts: "t", type: "assistant.delta", sessionId: "s", seq: 1, text: "x" } as unknown as ServerEvent;
const listEvt = { v: 4, ts: "t", type: "session.list", sessions: [] } as unknown as ServerEvent;

test("[BE2-20] under back-pressure a droppable delta is shed but a normal frame is delivered", () => {
  const reg = new ConnectionRegistry();
  const busy = fakeWs("c1", 2 << 20); // 2 MiB buffered → past the 1 MiB soft cap
  reg.add(busy as never);

  reg.toAll(delta);
  expect(busy.sent).toHaveLength(0); // delta dropped

  reg.toAll(listEvt);
  expect(busy.sent).toHaveLength(1); // non-droppable frame always sent
  expect(busy.closed).toBe(false);
});

test("[BE2-20] a healthy socket receives deltas normally", () => {
  const reg = new ConnectionRegistry();
  const ok = fakeWs("c2", 0);
  reg.add(ok as never);
  reg.toAll(delta);
  expect(ok.sent).toHaveLength(1);
});

test("[BE2-20] a wedged socket past the hard cap is closed, not sent to", () => {
  const reg = new ConnectionRegistry();
  const wedged = fakeWs("c3", 16 << 20); // 16 MiB buffered → past the 8 MiB hard cap
  reg.add(wedged as never);
  reg.toAll(listEvt); // even a non-droppable frame closes a hopelessly-backed-up socket
  expect(wedged.closed).toBe(true);
  expect(wedged.sent).toHaveLength(0);
});

test("[BE2-20] toAttached applies the same back-pressure to attached conns only", () => {
  const reg = new ConnectionRegistry();
  const busyAttached = fakeWs("c4", 2 << 20, ["s"]);
  const idleUnattached = fakeWs("c5", 0, []);
  reg.add(busyAttached as never);
  reg.add(idleUnattached as never);
  reg.toAttached("s", delta);
  expect(busyAttached.sent).toHaveLength(0); // attached but backed up → dropped
  expect(idleUnattached.sent).toHaveLength(0); // not attached → never a candidate
});
