import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import { planPrefetch, createPrefetcher, type PrefetchCandidate, type PrefetcherDeps } from "../../web/src/prefetch";
import { mirror } from "../../web/src/mirror";
import type { ServerEvent } from "../../protocol";

beforeAll(() => installDom());
afterAll(() => uninstallDom());
beforeEach(async () => {
  for (const id of mirror.keys()) await mirror.delete(id);
});

const cand = (over: Partial<PrefetchCandidate>): PrefetchCandidate => ({
  sessionId: "s",
  lastActivityAt: "2026-01-01",
  serverEpoch: "ep1",
  serverLastSeq: 5,
  mirrorEpoch: null,
  mirrorLastSeq: 0,
  ...over,
});

// ── planPrefetch (pure) ─────────────────────────────────────────────────────────────────────────
test("planPrefetch omits fresh sessions (mirror level with server, same epoch)", () => {
  const plan = planPrefetch([cand({ sessionId: "fresh", mirrorEpoch: "ep1", mirrorLastSeq: 5 })]);
  expect(plan).toEqual([]);
});

test("planPrefetch → delta (sinceSeq) for a compatible-prefix mirror, snapshot otherwise", () => {
  const plan = planPrefetch([
    cand({ sessionId: "delta", mirrorEpoch: "ep1", mirrorLastSeq: 3, serverLastSeq: 9 }), // same epoch, behind → delta
    cand({ sessionId: "cold", mirrorEpoch: null, mirrorLastSeq: 0 }), // no mirror → snapshot
    cand({ sessionId: "lineage", mirrorEpoch: "ep0", mirrorLastSeq: 4 }), // epoch changed → snapshot
  ]);
  const byId = Object.fromEntries(plan.map((p) => [p.sessionId, p.sinceSeq]));
  expect(byId["delta"]).toBe(3);
  expect(byId["cold"]).toBeUndefined();
  expect(byId["lineage"]).toBeUndefined();
});

test("planPrefetch orders newest-active first and honours the cap", () => {
  const cands = Array.from({ length: 25 }, (_, i) => cand({ sessionId: `s${i}`, lastActivityAt: `2026-01-${String(i + 1).padStart(2, "0")}` }));
  const plan = planPrefetch(cands, 20);
  expect(plan).toHaveLength(20);
  expect(plan[0]!.sessionId).toBe("s24"); // most recent lastActivityAt first
});

// ── createPrefetcher (controller) ─────────────────────────────────────────────────────────────────
function baseDeps(over: Partial<PrefetcherDeps>): PrefetcherDeps {
  return {
    supportsHistory: () => true,
    gateAllows: () => true,
    sessionsForServer: () => [],
    sessionServerUrl: () => "srv",
    fetchHistory: async () => null,
    setWatermark: () => {},
    nextTick: async () => {},
    now: () => "T",
    mark: () => {},
    ...over,
  };
}
const snapshotResp = (sessionId: string, lastSeq: number, epoch: string): ServerEvent =>
  ({ v: 4, type: "session.history.snapshot", ts: "t", sessionId, snapshot: { v: 4, type: "conversation.snapshot", ts: "t", sessionId, seq: lastSeq, lastSeq, epoch, events: [{ kind: "user", ts: "t", rendered: { source: "hi", html: "<p>hi</p>" }, attachments: [] }] }, cid: "x" }) as unknown as ServerEvent;
const eventsResp = (sessionId: string, lastSeq: number, epoch: string, seqs: number[]): ServerEvent =>
  ({ v: 4, type: "session.history.events", ts: "t", sessionId, lastSeq, epoch, events: seqs.map((seq) => ({ v: 4, type: "message.user", ts: "t", sessionId, seq, rendered: { source: `m${seq}`, html: `<p>m${seq}</p>` }, attachments: [] })), cid: "x" }) as unknown as ServerEvent;

test("skips entirely when the server lacks the history capability or the gate is closed", async () => {
  let calls = 0;
  const p1 = createPrefetcher(baseDeps({ supportsHistory: () => false, sessionsForServer: () => [{ sessionId: "a", lastActivityAt: "d", serverEpoch: "ep1", serverLastSeq: 1 }], fetchHistory: async () => (calls++, null) }));
  await p1.run("srv");
  const p2 = createPrefetcher(baseDeps({ gateAllows: () => false, sessionsForServer: () => [{ sessionId: "a", lastActivityAt: "d", serverEpoch: "ep1", serverLastSeq: 1 }], fetchHistory: async () => (calls++, null) }));
  await p2.run("srv");
  expect(calls).toBe(0);
});

test("applies a snapshot response to the mirror (readable offline afterwards)", async () => {
  const p = createPrefetcher(baseDeps({
    sessionsForServer: () => [{ sessionId: "b", lastActivityAt: "d", serverEpoch: "ep1", serverLastSeq: 4 }],
    fetchHistory: async () => snapshotResp("b", 4, "ep1"),
  }));
  await p.run("srv");
  const events = await mirror.read("b");
  expect(events).toHaveLength(1);
  expect((await mirror.getMeta("b"))?.completeAt).toBe("T"); // reconciled complete
});

test("applies a delta and advances coverage past trailing transient seqs (setCovered)", async () => {
  // Seed a base at seq 2, then prefetch a delta whose events reach seq 3 but server lastSeq is 5
  // (seqs 4,5 were transient status/deltas, never mirrored). Coverage must still reach 5 → complete.
  await mirror.applySnapshot("c", { events: [{ kind: "user", ts: "t", rendered: { source: "a", html: "<p>a</p>" }, attachments: [] }], lastSeq: 2, epoch: "ep1" }, "srv", "d");
  const p = createPrefetcher(baseDeps({
    sessionsForServer: () => [{ sessionId: "c", lastActivityAt: "d", serverEpoch: "ep1", serverLastSeq: 5 }],
    fetchHistory: async () => eventsResp("c", 5, "ep1", [3]),
  }));
  await p.run("srv");
  const meta = await mirror.getMeta("c");
  expect(meta?.lastSeq).toBe(5); // advanced to the server watermark despite the last durable event being seq 3
  expect(meta?.completeAt).toBe("T");
});

test("aborts the rest of the work-list on the first failed fetch (no retry storm)", async () => {
  const attempted: string[] = [];
  let aborts = 0;
  const p = createPrefetcher(baseDeps({
    sessionsForServer: () => [
      { sessionId: "s1", lastActivityAt: "2026-02", serverEpoch: "ep1", serverLastSeq: 1 },
      { sessionId: "s2", lastActivityAt: "2026-01", serverEpoch: "ep1", serverLastSeq: 1 },
    ],
    fetchHistory: async (_url, item) => {
      attempted.push(item.sessionId);
      return null; // simulate a stalled link on the very first fetch
    },
    mark: (k) => {
      if (k === "prefetchAborts") aborts++;
    },
  }));
  await p.run("srv");
  expect(attempted).toEqual(["s1"]); // stopped after the first failure — s2 never attempted
  expect(aborts).toBe(1);
});

test("single-flight: a second run for the same server while one is in flight is a no-op", async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const p = createPrefetcher(baseDeps({
    sessionsForServer: () => [{ sessionId: "a", lastActivityAt: "d", serverEpoch: "ep1", serverLastSeq: 1 }],
    fetchHistory: async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return snapshotResp("a", 1, "ep1");
    },
  }));
  await Promise.all([p.run("srv"), p.run("srv")]); // fire twice concurrently
  expect(maxConcurrent).toBe(1); // the second run bailed on the single-flight guard
});
