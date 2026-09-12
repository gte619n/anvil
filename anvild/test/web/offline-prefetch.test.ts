import { test, expect, beforeAll } from "bun:test";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildBootBundle } from "./boot-bundle";

// Phase 2 acceptance (comprehensive-offline spec §5): two sessions A (active) and B (never viewed this
// boot). On connect, with zero user action, the client greedily pulls B's history via `session.history`
// into its mirror — so B is readable offline afterwards. We assert the prefetch happened (a
// session.history for B, but NOT for the active A) and that B's mirror + resume watermark were written.

let bundle = "";
beforeAll(async () => {
  bundle = await buildBootBundle();
});

const BASE = "https://appassets.androidplatform.net/";
const ORIGIN = "https://appassets.androidplatform.net";
const B_MSG = "PREFETCHED_B_MSG";

interface Result {
  historyForB: number; // count of session.history sends targeting B
  historyForA: number; // must be 0 — the active session is attached, not prefetched
  mirrorIndex: string | null;
  epochB: string | null;
  initErr: string | null;
}

function run(bundle: string): Result {
  const anvildRoot = join(import.meta.dir, "../..");
  const htmlPath = existsSync(join(anvildRoot, "web/dist/index.html")) ? join(anvildRoot, "web/dist/index.html") : join(anvildRoot, "web/index.html");
  const fakeIdbPath = join(anvildRoot, "test/web/fake-idb.mjs");
  const mk = (id: string) => ({ id, title: id, cwd: "/tmp/x", source: "existing-dir", model: "sonnet", autonomy: "mostly-autonomous", status: "idle", createdAt: "2026-08-01T00:00:00.000Z", lastActivityAt: "2026-08-01T00:00:00.000Z", usage: { inputTokens: 0, outputTokens: 0, turns: 0 } });

  const seeds: Record<string, string> = {
    "anvil.active": "sess_A",
    "anvil.sessions": JSON.stringify([mk("sess_A"), mk("sess_B")]),
    "anvil.sessionServer": JSON.stringify([["sess_A", ORIGIN], ["sess_B", ORIGIN]]),
  };
  const seedJs = Object.entries(seeds).map(([k, v]) => `w.localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n");

  const harness = join(anvildRoot, `.prefetch-harness-${process.pid}.mjs`);
  writeFileSync(
    harness,
    `import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { installFakeIdb } from ${JSON.stringify(fakeIdbPath)};
const html = readFileSync(${JSON.stringify(htmlPath)}, "utf8");
const dom = new JSDOM(html, { url: ${JSON.stringify(BASE)}, runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.__sent = [];
const snapshotFor = (sessionId, cid) => ({ v: 4, type: "session.history.snapshot", ts: "t", sessionId, cid, snapshot: { v: 4, type: "conversation.snapshot", ts: "t", sessionId, seq: 7, lastSeq: 7, epoch: "ep1", events: [{ kind: "user", ts: "t", rendered: { source: ${JSON.stringify(B_MSG)}, html: ${JSON.stringify(`<p>${B_MSG}</p>`)} }, attachments: [] }] } });
class FakeWS {
  constructor(u){ this.url = u; this.readyState = 1; w.__ws = this; }
  send(d){
    let m; try { m = JSON.parse(d); } catch { m = null; }
    if (m) w.__sent.push(m);
    // Auto-respond to a background history pull with a snapshot, echoing the cid.
    if (m && m.type === "session.history" && m.sessionId && m.cid) {
      setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(snapshotFor(m.sessionId, m.cid)) }), 0);
    }
    return true;
  }
  close(){ this.readyState = 3; } addEventListener(){}
}
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
w.WebSocket = FakeWS;
w.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
w.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0); // jsdom lacks a firing ric
installFakeIdb(w, {});
${seedJs}
const code = readFileSync(${JSON.stringify(bundle)}, "utf8");
const s = w.document.createElement("script");
s.textContent = 'var __APP_VERSION__="test";\\ntry{' + code + '\\n}catch(e){window.__initErr=(e&&(e.name+": "+e.message))||String(e);}';
w.document.body.appendChild(s);
const deliver = (frame) => w.__ws && w.__ws.onmessage && w.__ws.onmessage({ data: JSON.stringify(frame) });
setTimeout(() => {
  w.__ws && w.__ws.onopen && w.__ws.onopen();
  deliver({ v: 4, type: "server.hello", ts: "t", serverId: "srv1", serverName: "srv", version: "test", protocolVersion: 4, capabilities: ["history"], role: "standalone" });
  deliver({ v: 4, type: "resume.watermarks", ts: "t", watermarks: [{ sessionId: "sess_A", epoch: "ep1", lastSeq: 3 }, { sessionId: "sess_B", epoch: "ep1", lastSeq: 7 }] });
  deliver({ v: 4, type: "session.list", ts: "t", sessions: [${JSON.stringify(mk("sess_A"))}, ${JSON.stringify(mk("sess_B"))}] });
}, 400);
setTimeout(() => {
  const hist = w.__sent.filter((m) => m && m.type === "session.history");
  console.log(JSON.stringify({
    historyForB: hist.filter((m) => m.sessionId === "sess_B").length,
    historyForA: hist.filter((m) => m.sessionId === "sess_A").length,
    mirrorIndex: w.localStorage.getItem("anvil.mirror.index"),
    epochB: w.localStorage.getItem("anvil.epoch.sess_B"),
    initErr: w.__initErr || null,
  }));
}, 1400);
`,
  );
  try {
    const proc = Bun.spawnSync(["node", harness], { cwd: anvildRoot, stderr: "pipe", stdout: "pipe" });
    const out = proc.stdout.toString() || proc.stderr.toString();
    const line = out.split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "{}";
    return JSON.parse(line) as Result;
  } finally {
    rmSync(harness, { force: true });
  }
}

test("on connect, a never-viewed session is prefetched into the mirror (active session excluded)", () => {
  const r = run(bundle);
  expect(r.initErr).toBeNull();
  expect(r.historyForB).toBeGreaterThanOrEqual(1); // B was pulled
  expect(r.historyForA).toBe(0); // A is the active session — attached, never prefetched
  expect(r.mirrorIndex ?? "").toContain("sess_B"); // B's mirror was written
  expect(r.epochB).toBe("ep1"); // …and its resume watermark, so a later attach can delta-resume
}, 30_000);
