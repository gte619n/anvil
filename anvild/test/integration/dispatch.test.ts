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

// Frames the server sends automatically on connect (arch §6.2, fleet §6) — not RPC replies.
// `autopilot.schedule` carries the live `running` state; `autopilot.run.snapshot` follows only when a
// run is actually in flight (never in these tests), so it's listed for completeness.
const CONNECT_FRAMES = new Set([
  "server.hello",
  "session.list",
  "team.info",
  "budget",
  "environments",
  "prompts",
  "todoist.status",
  "lapo.status",
  "autopilot.schedule",
  "autopilot.run.snapshot",
]);

/**
 * Open a WS, send `payload`, resolve with the first reply that ISN'T one of the on-connect
 * snapshot frames (sent automatically on open), then close.
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
      if (CONNECT_FRAMES.has(m.type)) return; // ignore connect snapshots
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

test("ping → pong (heartbeat, §6.4), no cid required", async () => {
  const r = await rpc({ ...base, type: "ping" });
  expect(r.type).toBe("pong");
  expect(r.v).toBe(PROTOCOL_VERSION);
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

test("on open: server.hello is the first frame, followed by session.list", async () => {
  const frames = await new Promise<any[]>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    const got: any[] = [];
    const timer = setTimeout(() => reject(new Error("timeout")), 2000);
    ws.onmessage = (ev) => {
      got.push(JSON.parse(String(ev.data)));
      if (got.length >= 2) {
        clearTimeout(timer);
        resolve(got);
        ws.close();
      }
    };
  });
  expect(frames[0].type).toBe("server.hello"); // identifies the server before anything else (fleet §6)
  expect(frames[0].serverId).toMatch(/^srv_/);
  expect(typeof frames[0].serverName).toBe("string");
  expect(frames[1].type).toBe("session.list");
  expect(Array.isArray(frames[1].sessions)).toBe(true);
});

test("env.add rejects a nonexistent path", async () => {
  const r = await rpc({ ...base, type: "env.add", cid: "e1", name: "x", repoRoot: "/no/such/dir/anvil-xyz" });
  expect(r.type).toBe("command.error");
  expect(r.message).toContain("no such directory");
});

test("prompt.save broadcasts a prompts event and acks (cross-device sync)", async () => {
  // A save must fan out a `prompts` snapshot to every connection (not just an ack to the sender) —
  // that broadcast is what syncs the library across a user's devices. Collect both frames.
  const { ack, broadcast } = await new Promise<{ ack: any; broadcast: any }>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    let ackFrame: any, promptsFrame: any;
    const timer = setTimeout(() => reject(new Error("timeout")), 2000);
    ws.onopen = () => ws.send(JSON.stringify({ ...base, type: "prompt.save", cid: "p1", title: "Review", shortTitle: "Review", icon: "rate_review", body: "Review this diff." }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      // Ignore the initial connect-burst `prompts` snapshot; keep the one that carries our new prompt.
      if (m.type === "prompts" && m.prompts.some((p: any) => p.shortTitle === "Review")) promptsFrame = m;
      if (m.type === "ack" && m.cid === "p1") ackFrame = m;
      if (ackFrame && promptsFrame) {
        clearTimeout(timer);
        resolve({ ack: ackFrame, broadcast: promptsFrame });
        ws.close();
      }
    };
  });
  expect(ack.cid).toBe("p1");
  const saved = broadcast.prompts.find((p: any) => p.shortTitle === "Review");
  expect(saved.id).toMatch(/^prompt_/);
  expect(saved.body).toBe("Review this diff.");
  expect(saved.icon).toBe("rate_review");
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
      if (CONNECT_FRAMES.has(m.type)) return;
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
  expect(j.serverId).toMatch(/^srv_/); // stable fleet identity (§3)
  expect(typeof j.serverName).toBe("string");
  // No turn has run, so the rate-limit gauge is present but reports "unavailable" (no plan data yet).
  expect(typeof j.budget.available).toBe("boolean");
  expect(typeof j.budget.warn).toBe("boolean");
});

test("/api/fleet/discover returns a well-formed result (with or without Tailscale)", async () => {
  const res = await fetch(`http://localhost:${srv.port}/api/fleet/discover`);
  expect(res.ok).toBe(true);
  const j = (await res.json()) as any;
  expect(typeof j.ok).toBe("boolean"); // ok:true if tailscale present, ok:false+warning otherwise
  expect(Array.isArray(j.servers)).toBe(true);
});
