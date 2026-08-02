import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { SessionStore } from "../../src/session/store";
import { ConnectionRegistry } from "../../src/server/registry";

const tempState = () => mkdtempSync(join(tmpdir(), "anvil-wm-"));
const createExisting = (sup: Supervisor, cwd: string) =>
  sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd });

// ── watermark event (v4, spec A1) ──────────────────────────────────────────────
test("resumeWatermarksEvent lists every session's {epoch,lastSeq}", async () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = await createExisting(sup, dir);
  const ev = sup.resumeWatermarksEvent();
  expect(ev.type).toBe("resume.watermarks");
  const wm = ev.watermarks.find((w) => w.sessionId === s.id);
  expect(wm).toBeDefined();
  expect(wm!.epoch).toBe(s.epoch);
  expect(typeof wm!.epoch).toBe("string");
  expect(wm!.epoch.length).toBeGreaterThan(0);
  expect(wm!.lastSeq).toBe(sup.get(s.id)!.lastSeq);
  rmSync(dir, { recursive: true, force: true });
});

// ── epoch is stable across a daemon restart (spec A2/A3) ───────────────────────
test("epoch persists across restart so a cached transcript stays delta-resumable", async () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = await createExisting(sup1, dir);
  const epochBefore = s.epoch;
  expect(epochBefore.length).toBeGreaterThan(0);

  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry()); // restart
  expect(sup2.get(s.id)!.epoch).toBe(epochBefore); // same lineage token → delta resume still valid

  // A cold attach (no lastSeq) hands back a snapshot carrying that epoch.
  const events = sup2.resume(s.id);
  const snap = events.find((e) => e.type === "conversation.snapshot") as { epoch?: string } | undefined;
  expect(snap?.epoch).toBe(epochBefore);
  rmSync(dir, { recursive: true, force: true });
});

// ── a pre-v4 row (no epoch) gets a minted one on load (spec: migration) ─────────
test("a persisted session with no epoch is minted one on load (pre-v4 migration)", async () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = await createExisting(sup1, dir);

  // Rewrite the store row WITHOUT an epoch, as a v3 daemon would have left it.
  const store = new SessionStore(dir);
  const rows = store.loadAll().map((r) => (r.data.id === s.id ? { data: r.data, lastSeq: r.lastSeq } : r));
  store.saveAll(rows);

  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const minted = sup2.get(s.id)!.epoch;
  expect(typeof minted).toBe("string");
  expect(minted.length).toBeGreaterThan(0); // a fresh token → one harmless full snapshot next attach
  rmSync(dir, { recursive: true, force: true });
});

// ── dedupe set is seeded from the durable log across a restart (spec A5) ────────
test("applied prompt cids survive a daemon restart (seeded from the event log)", async () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = await createExisting(sup1, dir);

  // Simulate an applied prompt by appending its message.user (carrying the cid) to the durable log,
  // exactly as supervisor.prompt() would once a turn ran.
  const logFile = join(new SessionStore(dir).sessionDir(s.id), "events.ndjson");
  appendFileSync(
    logFile,
    JSON.stringify({ v: PROTOCOL_VERSION, ts: "t", type: "message.user", sessionId: s.id, seq: 1, rendered: { source: "hi", html: "hi" }, attachments: [], cid: "cid_persisted" }) + "\n",
  );

  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry()); // restart re-seeds from the log
  expect(sup2.isPromptApplied(s.id, "cid_persisted")).toBe(true);
  expect(sup2.isPromptApplied(s.id, "cid_unseen")).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
