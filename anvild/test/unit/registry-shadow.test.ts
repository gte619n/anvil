/**
 * Phase 3 (comprehensive-offline §4.3): shadow subscriptions. A connection that shadow-subscribes to a
 * session it is NOT attached to receives that session's DURABLE frames (to keep its offline mirror warm)
 * but never `assistant.delta`, and every shadow copy is droppable under back-pressure — a shed frame is
 * reconciled by the next connect-time prefetch, so shedding is correct, not lossy.
 */
import { test, expect } from "bun:test";
import { ConnectionRegistry } from "../../src/server/registry";
import type { ServerEvent } from "@protocol";

function fakeWs(id: string, opts: { buffered?: number; attached?: string[]; shadow?: "all" | string[] } = {}) {
  return {
    data: {
      id,
      attached: new Set(opts.attached ?? []),
      shadow: opts.shadow === undefined ? undefined : opts.shadow === "all" ? "all" : new Set(opts.shadow),
    },
    buffered: opts.buffered ?? 0,
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

const userMsg = { v: 4, ts: "t", type: "message.user", sessionId: "s", seq: 2, rendered: { source: "hi", html: "<p>hi</p>" }, attachments: [] } as unknown as ServerEvent;
const delta = { v: 4, ts: "t", type: "assistant.delta", sessionId: "s", seq: 3, text: "x" } as unknown as ServerEvent;

test("a shadow subscriber (not attached) receives a durable message.user for that session", () => {
  const reg = new ConnectionRegistry();
  const shadow = fakeWs("c1", { shadow: ["s"] });
  reg.add(shadow as never);
  reg.toAttached("s", userMsg);
  expect(shadow.sent).toHaveLength(1);
});

test('shadow "all" subscribes to every session', () => {
  const reg = new ConnectionRegistry();
  const shadow = fakeWs("c2", { shadow: "all" });
  reg.add(shadow as never);
  reg.toAttached("some-other-session", { ...userMsg, sessionId: "some-other-session" } as ServerEvent);
  expect(shadow.sent).toHaveLength(1);
});

test("a shadow subscriber never receives assistant.delta (not a mirrored/durable kind)", () => {
  const reg = new ConnectionRegistry();
  const shadow = fakeWs("c3", { shadow: ["s"] });
  reg.add(shadow as never);
  reg.toAttached("s", delta);
  expect(shadow.sent).toHaveLength(0);
});

test("a shadow subscriber for a DIFFERENT session gets nothing", () => {
  const reg = new ConnectionRegistry();
  const shadow = fakeWs("c4", { shadow: ["other"] });
  reg.add(shadow as never);
  reg.toAttached("s", userMsg);
  expect(shadow.sent).toHaveLength(0);
});

test("a connection with no shadow subscription and no attach gets nothing", () => {
  const reg = new ConnectionRegistry();
  const idle = fakeWs("c5", {});
  reg.add(idle as never);
  reg.toAttached("s", userMsg);
  expect(idle.sent).toHaveLength(0);
});

test("shadow copies are DROPPABLE under back-pressure (shed past the soft cap), unlike an attached copy of the same durable frame", () => {
  const reg = new ConnectionRegistry();
  const shadowBusy = fakeWs("c6", { buffered: 2 << 20, shadow: ["s"] }); // past 1 MiB soft cap
  const attachedBusy = fakeWs("c7", { buffered: 2 << 20, attached: ["s"] });
  reg.add(shadowBusy as never);
  reg.add(attachedBusy as never);
  reg.toAttached("s", userMsg);
  expect(shadowBusy.sent).toHaveLength(0); // shadow copy shed under pressure (reconciled by next prefetch)
  expect(attachedBusy.sent).toHaveLength(1); // the attached copy of a durable frame is NOT droppable → delivered
});

test("attached wins over shadow: an attached conn that also shadow-subscribes gets exactly one copy", () => {
  const reg = new ConnectionRegistry();
  const both = fakeWs("c8", { attached: ["s"], shadow: "all" });
  reg.add(both as never);
  reg.toAttached("s", userMsg);
  expect(both.sent).toHaveLength(1); // the attached branch handles it; the shadow branch is `else`
});
