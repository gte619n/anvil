/**
 * [Phase 4] OutboxQueue — the persisted offline-write queue extracted from main.ts. Tested with a
 * plain fake Storage (no DOM needed): load, enqueue, replace (flush leftover), predicate removal
 * (drop a rejected create's dependents), and resilience to corrupt data / a quota-throwing save.
 */
import { test, expect } from "bun:test";
import { OutboxQueue, newCid, type OutboxItem } from "../../web/src/outbox";

function fakeStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set("anvil.outbox", initial);
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}
const item = (cid: string, o: Partial<OutboxItem> = {}): OutboxItem => ({ cid, cmd: { type: "prompt.send" }, ...o });

test("loads an existing queue from storage", () => {
  const s = fakeStorage(JSON.stringify([item("a"), item("b")]));
  const q = new OutboxQueue(s, "anvil.outbox");
  expect(q.size).toBe(2);
  expect(q.list().map((i) => i.cid)).toEqual(["a", "b"]);
});

test("enqueue appends and persists", () => {
  const s = fakeStorage();
  const q = new OutboxQueue(s, "anvil.outbox");
  q.enqueue(item("a"));
  expect(q.size).toBe(1);
  expect(JSON.parse(s.map.get("anvil.outbox")!)).toHaveLength(1);
});

test("replace swaps the queue and persists (flush leftover)", () => {
  const s = fakeStorage(JSON.stringify([item("a"), item("b")]));
  const q = new OutboxQueue(s, "anvil.outbox");
  q.replace([item("b")]); // 'a' was sent; 'b' stays
  expect(q.list().map((i) => i.cid)).toEqual(["b"]);
  expect(JSON.parse(s.map.get("anvil.outbox")!)).toHaveLength(1);
});

test("removeWhere drops matching items (a rejected create + its dependents)", () => {
  const s = fakeStorage();
  const q = new OutboxQueue(s, "anvil.outbox");
  q.enqueue(item("create", { tempId: "pending_1" }));
  q.enqueue(item("prompt", { cmd: { type: "prompt.send", sessionId: "pending_1" } }));
  q.enqueue(item("other", { cmd: { type: "prompt.send", sessionId: "real_9" } }));
  q.removeWhere((i) => i.cmd.sessionId === "pending_1" || i.tempId === "pending_1");
  expect(q.list().map((i) => i.cid)).toEqual(["other"]);
});

test("removeWhere is a no-op (no write) when nothing matches", () => {
  const s = fakeStorage(JSON.stringify([item("a")]));
  let writes = 0;
  const wrapped = { ...s, setItem: (k: string, v: string) => (writes++, s.setItem(k, v)) };
  const q = new OutboxQueue(wrapped, "anvil.outbox");
  q.removeWhere((i) => i.cid === "zzz");
  expect(writes).toBe(0);
  expect(q.size).toBe(1);
});

test("a corrupt stored value loads as empty (never throws)", () => {
  const q = new OutboxQueue(fakeStorage("{not json"), "anvil.outbox");
  expect(q.size).toBe(0);
});

test("a quota-throwing save is swallowed; the in-memory queue stays correct", () => {
  const throwing = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); } };
  const q = new OutboxQueue(throwing, "anvil.outbox");
  expect(() => q.enqueue(item("a"))).not.toThrow();
  expect(q.size).toBe(1);
});

test("newCid returns distinct ids", () => {
  expect(newCid()).not.toBe(newCid());
});
