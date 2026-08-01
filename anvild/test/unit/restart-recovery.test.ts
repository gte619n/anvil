import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";

const tempState = () => mkdtempSync(join(tmpdir(), "anvil-recover-"));
const createExisting = (sup: Supervisor, cwd: string) =>
  sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd });

// ── Hard gate: daemon restart → recovery (spec §7.4 gate 2) ────────────────────────────────────────
// After a restart the client reconnects and delta-resumes from its cached lastSeq. This proves the
// server side of that: the epoch is stable (so the client stays in delta mode), the persisted log
// survives, and a delta resume returns ONLY the missed events, always ending with a live status — so a
// client whose spinner was "optimistically" left running self-heals the moment it re-attaches (D6).
test("after a restart, a client delta-resumes the missed tail and status re-asserts", () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = createExisting(sup1, dir);

  // The client has seen up to here (its cached watermark).
  const clientLastSeq = sup1.get(s.id)!.lastSeq;
  const epochBefore = s.epoch;

  // While the client is disconnected, the session emits more events (e.g. a turn finishing).
  sup1.get(s.id)!.emit({ type: "assistant.message", blocks: [{ kind: "markdown", rendered: { source: "done", html: "done" } }] });
  sup1.get(s.id)!.setStatus("idle");
  const serverLastSeq = sup1.get(s.id)!.lastSeq;
  expect(serverLastSeq).toBeGreaterThan(clientLastSeq);

  // ── restart ──
  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const restored = sup2.get(s.id)!;
  expect(restored).toBeDefined();
  expect(restored.epoch).toBe(epochBefore); // stable lineage → client stays in delta mode

  // The watermark the reconnecting client verifies against reflects the advanced seq.
  const wm = sup2.resumeWatermarksEvent().watermarks.find((w) => w.sessionId === s.id)!;
  expect(wm.epoch).toBe(epochBefore);
  expect(wm.lastSeq).toBe(restored.lastSeq);

  // A delta resume from the client's cached seq returns ONLY newer events, and ALWAYS ends with a
  // status (so an "optimistically" stuck spinner is corrected on re-attach — the D6 safety property).
  const delta = sup2.resume(s.id, clientLastSeq);
  expect(delta.length).toBeGreaterThan(0);
  expect(delta.every((e) => (e as { seq?: number }).seq === undefined || (e as { seq: number }).seq > clientLastSeq || e.type === "status")).toBe(true);
  expect(delta[delta.length - 1]!.type).toBe("status"); // resume always re-asserts live status
  // It must NOT be a full snapshot (that's the cross-reload win we're protecting).
  expect(delta.some((e) => e.type === "conversation.snapshot")).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

// A cold client (no cached seq) still gets a full snapshot after restart — the safe fallback.
test("after a restart, a cold client (no lastSeq) gets a full snapshot", () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = createExisting(sup1, dir);
  sup1.get(s.id)!.emit({ type: "assistant.message", blocks: [{ kind: "markdown", rendered: { source: "x", html: "x" } }] });

  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const events = sup2.resume(s.id); // no lastSeq → cold
  const snap = events.find((e) => e.type === "conversation.snapshot") as { epoch?: string } | undefined;
  expect(snap).toBeDefined();
  expect(snap!.epoch).toBe(s.epoch); // snapshot seeds the client's epoch for future delta resumes
  rmSync(dir, { recursive: true, force: true });
});
