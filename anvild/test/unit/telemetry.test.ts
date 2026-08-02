import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";

const tempState = () => mkdtempSync(join(tmpdir(), "anvil-tele-"));
const createExisting = (sup: Supervisor, cwd: string) =>
  sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd });

// ── Daemon telemetry aggregation (v4 §5.7 / spec D11) ──────────────────────────
test("resume() counts what it served (delta vs snapshot) — powers the 'delta not snapshot' assertion", async () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = await createExisting(sup, dir);

  sup.resume(s.id); // cold → snapshot
  sup.resume(s.id, 0); // warm → delta
  sup.resume(s.id, 0); // warm → delta

  const snap = sup.telemetrySnapshotEvent();
  expect(snap.type).toBe("telemetry.snapshot");
  expect(snap.server.resumeSnapshot).toBe(1);
  expect(snap.server.resumeDelta).toBe(2);
  rmSync(dir, { recursive: true, force: true });
});

test("noteServerCounter + recordClientTelemetry aggregate into the snapshot", async () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  sup.noteServerCounter("promptDeduped");
  sup.noteServerCounter("promptDeduped");
  sup.recordClientTelemetry("client_A", { reconnects: 3, resumeDelta: 5 });
  sup.recordClientTelemetry("client_B", { reconnects: 1 });
  // A client's later report replaces its earlier one (latest wins).
  sup.recordClientTelemetry("client_A", { reconnects: 4, resumeDelta: 9 });

  const snap = sup.telemetrySnapshotEvent();
  expect(snap.server.promptDeduped).toBe(2);
  expect(snap.clients.client_A).toEqual({ reconnects: 4, resumeDelta: 9 });
  expect(snap.clients.client_B).toEqual({ reconnects: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test("[BE2-23/SEC2-4] the client-telemetry map is LRU-capped at 50 (no unbounded growth / DoS)", async () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  for (let i = 0; i < 5000; i++) sup.recordClientTelemetry(`client_${i}`, { reconnects: i });
  const snap = sup.telemetrySnapshotEvent();
  expect(Object.keys(snap.clients).length).toBeLessThanOrEqual(50);
  // LRU: the most-recent ids survive, the oldest were evicted.
  expect(snap.clients.client_4999).toEqual({ reconnects: 4999 });
  expect(snap.clients.client_0).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("[BE2-23/SEC2-4] malformed reports are ignored (bad id, non-object, non-finite, key flood)", async () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  sup.recordClientTelemetry("", { a: 1 }); // empty id → rejected
  sup.recordClientTelemetry("x".repeat(500), { a: 1 }); // oversized id → rejected
  sup.recordClientTelemetry("bad_shape", [] as unknown as Record<string, number>); // array → rejected
  sup.recordClientTelemetry("bad_shape", 42 as unknown as Record<string, number>); // non-object → rejected
  const flood: Record<string, number> = {};
  for (let i = 0; i < 100; i++) flood[`k${i}`] = i;
  sup.recordClientTelemetry("flooder", flood); // >32 keys → whole report ignored
  // A valid report with some junk values keeps only the finite numbers.
  sup.recordClientTelemetry("client_ok", { good: 3, bad: NaN as number, inf: Infinity as number, s: "no" as unknown as number });

  const snap = sup.telemetrySnapshotEvent();
  expect(snap.clients[""]).toBeUndefined();
  expect(snap.clients.bad_shape).toBeUndefined();
  expect(snap.clients.flooder).toBeUndefined();
  expect(snap.clients.client_ok).toEqual({ good: 3 }); // NaN/Infinity/string dropped
  rmSync(dir, { recursive: true, force: true });
});
