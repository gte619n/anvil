import { test, expect } from "bun:test";
import { bootServer } from "../helpers";

// Phase 4a (comprehensive-offline §4.4a): the socketless REST mirror of `session.history`, used by
// Android's background WorkManager sync. Same resolution as the WS command (reuses supervisor.history).

/** Create a session over WS and resolve its id. */
function createSession(port: number, dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("timeout creating session"));
    }, 3000);
    let sent = false;
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data));
      if (!sent) {
        sent = true;
        ws.send(JSON.stringify({ v: 4, ts: "2026-09-12T00:00:00.000Z", type: "session.create", cid: "c1", source: "existing-dir", cwd: dir }));
      }
      if (f.type === "session.created" && f.cid === "c1") {
        clearTimeout(t);
        resolve(f.session.id as string);
        ws.close();
      }
    };
    ws.onerror = (e) => {
      clearTimeout(t);
      reject(e as unknown as Error);
    };
  });
}

test("GET /api/sessions/:id/history returns a snapshot (no sinceSeq) and a delta (with sinceSeq)", async () => {
  const srv = await bootServer();
  try {
    const sid = await createSession(srv.port, srv.dir);

    // REST returns the SAME wire-event shape as the WS session.history response (symmetric contract).
    const snapRes = await fetch(`${srv.base}/api/sessions/${sid}/history`);
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as { type: string; snapshot?: { type: string; epoch: string } };
    expect(snap.type).toBe("session.history.snapshot");
    expect(snap.snapshot?.type).toBe("conversation.snapshot");
    expect(typeof snap.snapshot?.epoch).toBe("string");

    const deltaRes = await fetch(`${srv.base}/api/sessions/${sid}/history?sinceSeq=0`);
    expect(deltaRes.status).toBe(200);
    const delta = (await deltaRes.json()) as { type: string; events?: unknown[]; epoch?: string };
    expect(delta.type).toBe("session.history.events");
    expect(Array.isArray(delta.events)).toBe(true);

    const missing = await fetch(`${srv.base}/api/sessions/sess_nope/history`);
    expect(missing.status).toBe(404);
  } finally {
    srv.cleanup();
  }
});
