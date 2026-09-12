import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import { mirror, foldEvent, MIRROR_MAX_SESSIONS } from "../../web/src/mirror";
import type { ConversationEvent, ServerEvent } from "../../protocol";

// jsdom has localStorage but NOT indexedDB, so these exercise the in-memory + index fallback — the same
// call surface main.ts uses, so the behavioural contract (base+tail, idempotency, epoch, eviction) holds.
beforeAll(() => installDom());
afterAll(() => uninstallDom());
beforeEach(async () => {
  for (const id of mirror.keys()) await mirror.delete(id);
});

function userEvent(sessionId: string, seq: number, text: string): ServerEvent {
  return { v: 4, type: "message.user", ts: "2026-09-12T00:00:00.000Z", sessionId, seq, rendered: { source: text, html: `<p>${text}</p>` }, attachments: [] } as unknown as ServerEvent;
}
function snap(events: ConversationEvent[], lastSeq: number, epoch: string): { events: ConversationEvent[]; lastSeq: number; epoch: string } {
  return { events, lastSeq, epoch };
}
const U = (t: string): ConversationEvent => ({ kind: "user", ts: "t", rendered: { source: t, html: `<p>${t}</p>` }, attachments: [] });

test("foldEvent keeps the 5 durable kinds and drops transient frames", () => {
  expect(foldEvent(userEvent("s", 1, "hi"))?.kind).toBe("user");
  expect(foldEvent({ v: 4, type: "assistant.delta", ts: "t", sessionId: "s", seq: 2, text: "x" } as unknown as ServerEvent)).toBeNull();
  expect(foldEvent({ v: 4, type: "status", ts: "t", sessionId: "s", seq: 3, status: "idle" } as unknown as ServerEvent)).toBeNull();
});

test("applySnapshot + applyEvent round-trip: read returns base ++ tail in seq order", async () => {
  await mirror.applySnapshot("s1", snap([U("a"), U("b")], 5, "ep1"), "srv", "2026-01-01");
  expect(mirror.has("s1")).toBe(true);
  await mirror.applyEvent("s1", 6, userEvent("s1", 6, "c"), "ep1", "srv", "2026-01-02");
  await mirror.applyEvent("s1", 7, userEvent("s1", 7, "d"), "ep1", "srv", "2026-01-03");
  const events = await mirror.read("s1");
  expect(events?.map((e) => (e.kind === "user" ? e.rendered.html : ""))).toEqual(["<p>a</p>", "<p>b</p>", "<p>c</p>", "<p>d</p>"]);
  expect((await mirror.getMeta("s1"))?.lastSeq).toBe(7);
});

test("applyEvent is idempotent by seq (re-delivery is a no-op)", async () => {
  await mirror.applySnapshot("s2", snap([U("a")], 1, "ep1"), "srv", "d");
  await mirror.applyEvent("s2", 2, userEvent("s2", 2, "b"), "ep1", "srv", "d");
  await mirror.applyEvent("s2", 2, userEvent("s2", 2, "b"), "ep1", "srv", "d"); // duplicate
  const events = await mirror.read("s2");
  expect(events).toHaveLength(2); // base(1) + one tail, not two
});

test("[D1.4] a lone delta with no base is skipped — a tail can't stand alone", async () => {
  const applied = await mirror.applyEvent("s3", 1, userEvent("s3", 1, "orphan"), "ep1", "srv", "d");
  expect(applied).toBe(false);
  expect(await mirror.read("s3")).toBeNull();
});

test("epoch mismatch on a delta invalidates the mirror (lineage reset → await fresh snapshot)", async () => {
  await mirror.applySnapshot("s4", snap([U("a")], 1, "ep1"), "srv", "d");
  const applied = await mirror.applyEvent("s4", 2, userEvent("s4", 2, "b"), "ep2", "srv", "d"); // different epoch
  expect(applied).toBe(false);
  expect(await mirror.read("s4")).toBeNull(); // invalidated
  expect(mirror.has("s4")).toBe(false);
});

test("applySnapshot clears tail entries the new base now covers", async () => {
  await mirror.applySnapshot("s5", snap([U("a")], 1, "ep1"), "srv", "d");
  await mirror.applyEvent("s5", 2, userEvent("s5", 2, "b"), "ep1", "srv", "d");
  // fresh snapshot covering seq 2 → the tail entry at seq 2 is folded into the base, not double-counted
  await mirror.applySnapshot("s5", snap([U("a"), U("b")], 2, "ep1"), "srv", "d");
  const events = await mirror.read("s5");
  expect(events).toHaveLength(2);
  expect((await mirror.getMeta("s5"))?.tailCount).toBe(0);
});

test("markComplete is the ONLY path that sets completeAt, and only when the watermark matches", async () => {
  await mirror.applySnapshot("s6", snap([U("a")], 3, "ep1"), "srv", "d");
  expect((await mirror.getMeta("s6"))?.completeAt).toBe(""); // snapshot alone never claims complete
  expect(await mirror.markComplete("s6", "ep1", 4, "T1")).toBe(false); // server ahead → not complete
  expect((await mirror.getMeta("s6"))?.completeAt).toBe("");
  expect(await mirror.markComplete("s6", "ep1", 3, "T2")).toBe(true); // exact match
  expect((await mirror.getMeta("s6"))?.completeAt).toBe("T2");
  expect(await mirror.markComplete("s6", "ep2", 3, "T3")).toBe(false); // epoch differs → not complete
});

test("delete drops the mirror AND its resume watermark ([D1.2] no mirror ⇒ no delta-resume)", async () => {
  localStorage.setItem("anvil.epoch.s7", "ep1");
  localStorage.setItem("anvil.seq.s7", "9");
  await mirror.applySnapshot("s7", snap([U("a")], 9, "ep1"), "srv", "d");
  await mirror.delete("s7");
  expect(mirror.has("s7")).toBe(false);
  expect(localStorage.getItem("anvil.epoch.s7")).toBeNull();
  expect(localStorage.getItem("anvil.seq.s7")).toBeNull();
});

test("move migrates an optimistic session's mirror to its real id", async () => {
  await mirror.applySnapshot("temp_1", snap([U("a")], 1, "ep1"), "srv", "d");
  await mirror.applyEvent("temp_1", 2, userEvent("temp_1", 2, "b"), "ep1", "srv", "d");
  await mirror.move("temp_1", "sess_real");
  expect(await mirror.read("sess_real")).toHaveLength(2);
  expect(mirror.has("temp_1")).toBe(false);
});

test("evictLRU enforces the session cap oldest-first and never evicts pinned sessions", async () => {
  // Seed MIRROR_MAX_SESSIONS + 3 mirrors with ascending lastActivityAt (s0 oldest).
  const n = MIRROR_MAX_SESSIONS + 3;
  for (let i = 0; i < n; i++) {
    await mirror.applySnapshot(`e${i}`, snap([U(`${i}`)], 1, "ep1"), "srv", `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`);
  }
  expect(mirror.keys().length).toBe(n);
  // Pin the oldest (e0) — it must survive despite being the LRU victim.
  const evicted = await mirror.evictLRU(new Set(["e0"]));
  expect(evicted).toBe(3);
  expect(mirror.keys().length).toBe(MIRROR_MAX_SESSIONS);
  expect(mirror.has("e0")).toBe(true); // pinned survived
  expect(mirror.has("e1")).toBe(false); // next-oldest evicted instead
});
