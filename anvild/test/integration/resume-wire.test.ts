import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { createServer, type ServerHandle } from "../../src/server/http";

// End-to-end over a real WebSocket: proves the v4 resume path on the wire (watermark on connect, delta
// vs snapshot on attach, epoch on the snapshot) — the server half of the "cold reload → delta, not
// snapshot" acceptance scenario (spec §7.5) and the recovery gate.

let srv: ServerHandle;
let stateDir: string;

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "anvil-rw-"));
  srv = createServer({ port: 0, stateDir });
});
afterAll(() => {
  srv.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

const base = { v: PROTOCOL_VERSION, ts: "2026-06-19T00:00:00.000Z" };

/** Open a WS, run a scripted exchange, and resolve with every frame received until `done(frames)`. */
function session(steps: Array<object>, done: (frames: any[]) => boolean): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    const frames: any[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout; got ${frames.map((f) => f.type).join(",")}`));
    }, 3000);
    let sent = false;
    ws.onmessage = (ev) => {
      frames.push(JSON.parse(String(ev.data)));
      if (!sent) {
        sent = true;
        for (const s of steps) ws.send(JSON.stringify(s));
      }
      if (done(frames)) {
        clearTimeout(timer);
        resolve(frames);
        ws.close();
      }
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(e);
    };
  });
}

test("connect sends resume.watermarks (before session.list) and telemetry.snapshot", async () => {
  const frames = await session([], (f) => f.some((x) => x.type === "telemetry.snapshot"));
  const types = frames.map((f) => f.type);
  expect(types).toContain("resume.watermarks");
  expect(types.indexOf("resume.watermarks")).toBeLessThan(types.indexOf("session.list"));
  const wm = frames.find((f) => f.type === "resume.watermarks");
  expect(Array.isArray(wm.watermarks)).toBe(true);
  const tel = frames.find((f) => f.type === "telemetry.snapshot");
  expect(typeof tel.server).toBe("object");
});

test("attach without lastSeq → conversation.snapshot carrying an epoch", async () => {
  // Create a session, then cold-attach it.
  const created = await session([{ ...base, type: "session.create", cid: "c1", source: "existing-dir", cwd: stateDir }], (f) =>
    f.some((x) => x.type === "session.created" && x.cid === "c1"),
  );
  const sid = created.find((f) => f.type === "session.created").session.id as string;

  const frames = await session([{ ...base, type: "session.attach", cid: "a1", sessionId: sid }], (f) =>
    f.some((x) => x.type === "conversation.snapshot" && x.sessionId === sid),
  );
  const snap = frames.find((f) => f.type === "conversation.snapshot");
  expect(typeof snap.epoch).toBe("string");
  expect(snap.epoch.length).toBeGreaterThan(0);
  expect(snap.lastSeq).toBeGreaterThanOrEqual(0);

  // The watermark on THIS connection must report the same epoch the snapshot carries.
  const wm = frames.find((f) => f.type === "resume.watermarks").watermarks.find((w: any) => w.sessionId === sid);
  expect(wm.epoch).toBe(snap.epoch);
});

test("attach WITH lastSeq → a delta (status), never a full snapshot", async () => {
  const created = await session([{ ...base, type: "session.create", cid: "c2", source: "existing-dir", cwd: stateDir }], (f) =>
    f.some((x) => x.type === "session.created" && x.cid === "c2"),
  );
  const sid = created.find((f) => f.type === "session.created").session.id as string;
  const wm = created.find((f) => f.type === "resume.watermarks").watermarks.find((w: any) => w.sessionId === sid);

  // Warm attach from the current watermark: expect the trailing status, and NO snapshot.
  const frames = await session([{ ...base, type: "session.attach", cid: "a2", sessionId: sid, lastSeq: wm?.lastSeq ?? 0 }], (f) =>
    f.some((x) => x.type === "status" && x.sessionId === sid),
  );
  expect(frames.some((f) => f.type === "conversation.snapshot" && f.sessionId === sid)).toBe(false);
  const status = frames.find((f) => f.type === "status" && f.sessionId === sid);
  expect(status.status).toBe("idle"); // a fresh session re-asserts idle — spinner self-heals (D6)
});
