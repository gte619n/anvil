import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { createServer, type ServerHandle } from "../../src/server/http";

let srv: ServerHandle;
let stateDir: string;

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "anvil-state-"));
  srv = createServer({ port: 0, stateDir });
});
afterAll(() => {
  srv.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

/**
 * Open a WS, send `payload`, resolve with the first reply that ISN'T the on-connect
 * `session.list` snapshot (sent automatically on open — arch §6.2), then close.
 */
function rpc(payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timeout waiting for reply"));
    }, 2000);
    ws.onopen = () => ws.send(JSON.stringify(payload));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "session.list" || m.type === "budget" || m.type === "environments" || m.type === "todoist.status") return; // ignore connect snapshots
      clearTimeout(timer);
      resolve(m);
      ws.close();
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(e);
    };
  });
}

const base = { v: PROTOCOL_VERSION, ts: "2026-06-19T00:00:00.000Z" };

test("unknown command type → command.error, cid echoed", async () => {
  const r = await rpc({ ...base, type: "bogus.command", cid: "c1" });
  expect(r.type).toBe("command.error");
  expect(r.cid).toBe("c1");
  expect(r.message).toContain("unknown command type");
});

test("terminal.open on an unknown session → command.error", async () => {
  const r = await rpc({ ...base, type: "terminal.open", cid: "c2", sessionId: "x", cols: 80, rows: 24 });
  expect(r.type).toBe("command.error");
  expect(r.cid).toBe("c2");
  expect(r.message).toContain("no such session");
});

test("session.create (existing-dir) → session.created with cid", async () => {
  const r = await rpc({ ...base, type: "session.create", cid: "c5", source: "existing-dir", cwd: stateDir });
  expect(r.type).toBe("session.created");
  expect(r.cid).toBe("c5");
  expect(r.session.id).toMatch(/^sess_/);
  expect(r.session.model).toBe("opus");
  expect(r.session.autonomy).toBe("mostly-autonomous");
});

test("connecting client receives a session.list on open", async () => {
  const list = await new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    const timer = setTimeout(() => reject(new Error("timeout")), 2000);
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(ev.data)));
      ws.close();
    };
  });
  expect(list.type).toBe("session.list");
  expect(Array.isArray(list.sessions)).toBe(true);
});

test("env.add rejects a nonexistent path", async () => {
  const r = await rpc({ ...base, type: "env.add", cid: "e1", name: "x", repoRoot: "/no/such/dir/anvil-xyz" });
  expect(r.type).toBe("command.error");
  expect(r.message).toContain("no such directory");
});

test("push.register with cid → ack", async () => {
  const r = await rpc({ ...base, type: "push.register", cid: "c3", platform: "fcm", token: "tok-1" });
  expect(r.type).toBe("ack");
  expect(r.cid).toBe("c3");
});

test("bad protocol version → command.error", async () => {
  const r = await rpc({ v: 999, ts: base.ts, type: "push.register", cid: "c4", platform: "fcm", token: "x" });
  expect(r.type).toBe("command.error");
  expect(r.message).toContain("protocol version");
});

test("invalid JSON → command.error", async () => {
  const reply = await new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    const timer = setTimeout(() => reject(new Error("timeout")), 2000);
    ws.onopen = () => ws.send("{not json");
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "session.list" || m.type === "budget" || m.type === "environments" || m.type === "todoist.status") return;
      clearTimeout(timer);
      resolve(m);
      ws.close();
    };
  });
  expect(reply.type).toBe("command.error");
});

test("/api/health reports liveness + the §3 auth self-check", async () => {
  const res = await fetch(`http://localhost:${srv.port}/api/health`);
  const j = (await res.json()) as any;
  expect(j.ok).toBe(true);
  expect(typeof j.subscriptionAuthOk).toBe("boolean");
  expect(j.version).toBeDefined();
  // No turn has run, so the rate-limit gauge is present but reports "unavailable" (no plan data yet).
  expect(typeof j.budget.available).toBe("boolean");
  expect(typeof j.budget.warn).toBe("boolean");
});
