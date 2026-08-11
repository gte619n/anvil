import { test, expect } from "bun:test";
import { PROTOCOL_VERSION, type ServerEvent } from "@protocol";
import { Session } from "../../src/session/session";
import { dispatch, type DispatchDeps } from "../../src/server/dispatch";
import type { ConnState } from "../../src/server/connection";

// ── Session-level applied-cid ring (v4 exactly-once, spec A5) ──────────────────
test("session: recordPromptCid / isPromptApplied is idempotent and bounded", () => {
  const s = new Session({ id: "sess_x" } as never, 0, () => {}, () => {}, () => {}, "ep_x");
  expect(s.epoch).toBe("ep_x");
  expect(s.isPromptApplied("c1")).toBe(false);
  s.recordPromptCid("c1");
  s.recordPromptCid("c1"); // idempotent — no double-insert
  expect(s.isPromptApplied("c1")).toBe(true);

  // Evict the oldest once past the cap (1000). c1 (recorded first) should fall out.
  for (let i = 0; i < 1000; i++) s.recordPromptCid(`fill_${i}`);
  expect(s.isPromptApplied("c1")).toBe(false); // evicted
  expect(s.isPromptApplied("fill_999")).toBe(true); // newest retained
});

// ── Dispatcher exactly-once branch (the hard-gate logic, spec A5) ──────────────
// A stub supervisor lets us assert the router re-acks a duplicate cid WITHOUT re-running the turn,
// independent of the driver/auth machinery a real prompt would drag in.
function stubDeps(applied: Set<string>): { deps: DispatchDeps; promptCalls: string[] } {
  const promptCalls: string[] = [];
  const supervisor = {
    isPromptApplied: (_id: string, cid: string) => applied.has(cid),
    prompt: (_id: string, _text: string, _atts: string[], cid?: string) => {
      promptCalls.push(cid ?? "<none>");
      if (cid) applied.add(cid); // mirror the real apply → future sends are duplicates
    },
    noteHumanPrompt: () => {},
    noteServerCounter: () => {}, // §5.7 telemetry hook the dedupe branch calls
  } as unknown as DispatchDeps["supervisor"];
  return { deps: { supervisor, registry: {} as never, push: {} as never }, promptCalls };
}

test("dispatch: a re-flushed prompt.send (same cid) re-acks without re-applying", () => {
  const applied = new Set<string>();
  const { deps, promptCalls } = stubDeps(applied);
  const conn: ConnState = { id: "c", attached: new Set() };
  const sent: ServerEvent[] = [];
  const send = (e: ServerEvent) => sent.push(e);
  const frame = (cid: string) =>
    JSON.stringify({ v: PROTOCOL_VERSION, ts: "t", type: "prompt.send", sessionId: "sess_x", text: "hi", cid });

  dispatch(conn, frame("dup"), send, deps); // first send: applies + acks
  dispatch(conn, frame("dup"), send, deps); // re-flush: dedupe → ack only

  expect(promptCalls).toEqual(["dup"]); // applied exactly once
  expect(sent.filter((e) => e.type === "ack").length).toBe(2); // both acked (so the client dequeues)
  expect(sent.every((e) => e.type === "ack")).toBe(true); // no command.error, no second turn
});
