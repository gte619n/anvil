/**
 * [BE-1] The session registry was re-serialized and fsynced in full on EVERY emitted event
 * (status/prose/seq) via emit → onChange → persist. During an active turn that's the hottest path in
 * the daemon. This debounces the high-frequency emit path so a burst coalesces into one write, while
 * lifecycle ops (create/delete/kill/shutdown) still flush immediately for durability.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const persistedSeq = (dir: string, id: string): number => {
  const parsed = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as {
    sessions: { data: { id: string }; lastSeq: number }[];
  };
  return parsed.sessions.find((s) => s.data.id === id)!.lastSeq;
};

test("create flushes immediately; emit-driven changes are debounced then flushed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-persist-"));
  try {
    const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
    const s = sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: dir });

    // create() persisted synchronously — the row is on disk right away.
    const afterCreate = persistedSeq(dir, s.id);

    // A burst of emit-driven status changes bumps the in-memory seq...
    s.setStatus("thinking");
    s.setStatus("idle");
    s.setStatus("thinking");
    expect(s.lastSeq).toBeGreaterThan(afterCreate);

    // ...but the file is NOT rewritten synchronously per event (debounced).
    expect(persistedSeq(dir, s.id)).toBe(afterCreate);

    // After the debounce window, the coalesced write lands with the latest seq.
    await delay(200);
    expect(persistedSeq(dir, s.id)).toBe(s.lastSeq);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kill flushes immediately (lifecycle ops are not debounced)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-persist-"));
  try {
    const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
    const a = sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: dir });
    sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: dir });

    await sup.kill(a.id);
    // Immediately on disk: the deleted session is gone without waiting for a debounce.
    const parsed = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as { sessions: { data: { id: string } }[] };
    expect(parsed.sessions.some((s) => s.data.id === a.id)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
