/**
 * [A4] The gap state (`report_gap`, D17; owner item 42): kept in part.json AND the hub-synced lock
 * store, so an edit of the file cannot clear it, a restart keeps it, and every machine sees it; only a
 * clear (the owner's, or an approved expectation change) — itself a fleet-synced record — ends it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCKS_APPROVE_PATH, LOCKS_PUSH_PATH, LockStore, LockSync, type FleetRole, type GapLock } from "../../src/cadwork/locks";
import { evaluateGate } from "../../src/cadwork/gate";
import { gapOf } from "../../src/cadwork/refresh";
import { cleanupTemp, tempDir } from "../helpers/cad-work";

afterEach(() => cleanupTemp());

const REPO = "git@example.com:o/widgets";
const gap = (at: string, feature = "thread"): GapLock => ({ repo: REPO, part: "plate", gap: { feature, detail: "no thread feature", at }, at });
const clear = (at: string): GapLock => ({ repo: REPO, part: "plate", at });
const okPart = (g?: { feature: string; detail: string; at: string }) => ({ kind: "ok" as const, text: "", file: { schema: 1 as const, process: "fdm-0.4", status: "dimensioned" as const, ...(g ? { gap: g } : {}) } });

describe("gap state", () => {
  test("[A4] gapOf: the store's gap wins; a gap only in part.json counts (a fresh clone) unless a later clear is on record; a clear in the store is not undone by the file", () => {
    const g = { feature: "thread", detail: "x", at: "2026-11-19T10:00:00.000Z" };
    expect(gapOf(okPart(), gap("2026-11-19T10:00:00.000Z"))).toMatchObject({ feature: "thread" }); // edited out of the file: still a gap
    expect(gapOf(okPart(g), undefined)).toEqual(g);
    expect(gapOf(okPart(g), clear("2026-11-19T11:00:00.000Z"))).toBeUndefined();
    expect(gapOf(okPart(g), clear("2026-11-19T09:00:00.000Z"))).toEqual(g); // reported after the clear
    expect(gapOf({ kind: "missing" }, undefined)).toBeUndefined();
  });

  test("[A4] the gate's state is gap whenever a gap is in force — over pass, fail, concept and unverified — and the gap rides on the result", () => {
    const base = { part: { kind: "missing" as const }, rules: { kind: "missing" as const }, featureErrors: [], warnings: [] };
    const r = evaluateGate({ ...base, gap: { feature: "thread", detail: "d", at: "t" } });
    expect(r.state).toBe("gap");
    expect(r.gap).toEqual({ feature: "thread", detail: "d", at: "t" });
    expect(evaluateGate(base).state).toBe("unverified");
    expect(evaluateGate(base).gap).toBeUndefined();
  });

  test("[A4] the lock store keeps gaps across a restart, merges them latest-wins, and a clear is a record that travels too", () => {
    const dir = tempDir();
    const s = new LockStore(dir);
    s.putGap(gap("2026-11-19T10:00:00.000Z"));
    const again = new LockStore(dir); // a restart
    const id = { key: REPO, remote: REPO, path: "/x" };
    expect(again.findGap(id, "plate")!.gap!.feature).toBe("thread");
    expect(JSON.parse(readFileSync(join(dir, "cadwork", "locks.json"), "utf8")).gaps).toHaveLength(1);
    expect(again.merge({ gaps: [clear("2026-11-19T09:00:00.000Z")] })).toBe(0); // older: ignored
    expect(again.merge({ gaps: [clear("2026-11-19T11:00:00.000Z")] })).toBe(1);
    expect(again.findGap(id, "plate")!.gap).toBeUndefined();
    // A hub too old to know gaps says nothing about them: this machine keeps its own.
    again.replaceFromHub({ parts: [], rules: [] });
    expect(again.findGap(id, "plate")).toBeDefined();
    // A store with no gaps reads and writes exactly as before Phase A4.
    expect(new LockStore(tempDir()).snapshot()).toEqual({ parts: [], rules: [] });
  });

  test("[A4] a gap reported on a member reaches the hub and the other members; the owner's clear follows the same way", async () => {
    const daemons = new Map<string, LockSync>();
    const fetchImpl = (async (input: any, init: any) => {
      const url = new URL(String(input));
      const target = daemons.get(`http://${url.host}`)!;
      const body = JSON.parse(init.body);
      if (url.pathname === LOCKS_APPROVE_PATH) return Response.json(target.acceptFromMember(body));
      if (url.pathname === LOCKS_PUSH_PATH) {
        target.acceptFromHub(body);
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const add = (origin: string, role: FleetRole) => {
      const sync = new LockSync(new LockStore(tempDir()), { fetchImpl, timeoutMs: 500 });
      sync.setRole(() => role);
      daemons.set(origin, sync);
      return sync;
    };
    const hub = add("http://hub:7701", { kind: "hub", serverId: "srv_hub", selfUrl: async () => "http://hub:7701", members: () => [{ serverId: "srv_m1", url: "http://m1:7701" }, { serverId: "srv_m2", url: "http://m2:7701" }] });
    const m1 = add("http://m1:7701", { kind: "member", serverId: "srv_m1", hubServerId: "srv_hub" });
    const m2 = add("http://m2:7701", { kind: "member", serverId: "srv_m2", hubServerId: "srv_hub" });
    await hub.broadcast(); // members learn the hub
    const id = { key: REPO, remote: REPO, path: "/x" };
    m1.setGap(gap("2026-11-19T10:00:00.000Z"));
    await m1.settled();
    await hub.settled();
    for (const s of [hub, m2]) expect(s.store.findGap(id, "plate")!.gap!.feature).toBe("thread");
    expect(m1.store.pending()).toEqual([]);
    hub.setGap(clear("2026-11-19T12:00:00.000Z"));
    await hub.settled();
    for (const s of [m1, m2]) expect(s.store.findGap(id, "plate")!.gap).toBeUndefined();
  });
});
