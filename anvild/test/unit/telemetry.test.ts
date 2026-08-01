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
test("resume() counts what it served (delta vs snapshot) — powers the 'delta not snapshot' assertion", () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = createExisting(sup, dir);

  sup.resume(s.id); // cold → snapshot
  sup.resume(s.id, 0); // warm → delta
  sup.resume(s.id, 0); // warm → delta

  const snap = sup.telemetrySnapshotEvent();
  expect(snap.type).toBe("telemetry.snapshot");
  expect(snap.server.resumeSnapshot).toBe(1);
  expect(snap.server.resumeDelta).toBe(2);
  rmSync(dir, { recursive: true, force: true });
});

test("noteServerCounter + recordClientTelemetry aggregate into the snapshot", () => {
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
