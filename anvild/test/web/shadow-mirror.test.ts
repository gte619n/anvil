import { test, expect, beforeAll } from "bun:test";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildBootBundle } from "./boot-bundle";

// Phase 3 acceptance (comprehensive-offline §4.3): with A active and B shadow-subscribed, a durable
// event pushed for B lands in the mirror (advancing its coverage) with NO attach and NO DOM churn — the
// pane still shows A. We also assert the client actually sent a shadow.subscribe on connect.

let bundle = "";
beforeAll(async () => {
  bundle = await buildBootBundle();
});

const BASE = "https://appassets.androidplatform.net/";
const ORIGIN = "https://appassets.androidplatform.net";
const SHADOW_MSG = "SHADOW_PUSHED_MSG";

interface Result {
  shadowSubscribeSent: boolean;
  mirrorLastSeqB: number | null; // from the fake IDB mirror meta for B
  domHasShadowMsg: boolean; // must be false — a background push must not render into the active pane
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

  const harness = join(anvildRoot, `.shadow-harness-${process.pid}.mjs`);
  writeFileSync(
    harness,
    `import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { installFakeIdb } from ${JSON.stringify(fakeIdbPath)};
const html = readFileSync(${JSON.stringify(htmlPath)}, "utf8");
const dom = new JSDOM(html, { url: ${JSON.stringify(BASE)}, runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.__sent = [];
const snapshotFor = (sessionId, cid) => ({ v: 4, type: "session.history.snapshot", ts: "t", sessionId, cid, snapshot: { v: 4, type: "conversation.snapshot", ts: "t", sessionId, seq: 7, lastSeq: 7, epoch: "ep1", events: [{ kind: "user", ts: "t", rendered: { source: "b-base", html: "<p>b-base</p>" }, attachments: [] }] } });
class FakeWS {
  constructor(u){ this.url = u; this.readyState = 1; w.__ws = this; }
  send(d){ let m; try { m = JSON.parse(d); } catch { m = null; } if (m) w.__sent.push(m);
    if (m && m.type === "session.history" && m.sessionId && m.cid) setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(snapshotFor(m.sessionId, m.cid)) }), 0);
    return true; }
  close(){ this.readyState = 3; } addEventListener(){}
}
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
w.WebSocket = FakeWS;
w.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
w.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
const dbs = installFakeIdb(w, {});
${seedJs}
const code = readFileSync(${JSON.stringify(bundle)}, "utf8");
const s = w.document.createElement("script");
s.textContent = 'var __APP_VERSION__="test";\\ntry{' + code + '\\n}catch(e){window.__initErr=(e&&(e.name+": "+e.message))||String(e);}';
w.document.body.appendChild(s);
const deliver = (frame) => w.__ws && w.__ws.onmessage && w.__ws.onmessage({ data: JSON.stringify(frame) });
setTimeout(() => {
  w.__ws && w.__ws.onopen && w.__ws.onopen();
  deliver({ v: 4, type: "server.hello", ts: "t", serverId: "srv1", serverName: "srv", version: "test", protocolVersion: 4, capabilities: ["history", "shadow"], role: "standalone" });
  deliver({ v: 4, type: "resume.watermarks", ts: "t", watermarks: [{ sessionId: "sess_A", epoch: "ep1", lastSeq: 3 }, { sessionId: "sess_B", epoch: "ep1", lastSeq: 7 }] });
  deliver({ v: 4, type: "session.list", ts: "t", sessions: [${JSON.stringify(mk("sess_A"))}, ${JSON.stringify(mk("sess_B"))}] });
}, 400);
// After prefetch has filled B's mirror base (seq 7), push a SHADOW durable event for B at seq 8.
setTimeout(() => {
  deliver({ v: 4, type: "message.user", ts: "t", sessionId: "sess_B", seq: 8, rendered: { source: ${JSON.stringify(SHADOW_MSG)}, html: ${JSON.stringify(`<p>${SHADOW_MSG}</p>`)} }, attachments: [] });
}, 1100);
setTimeout(() => {
  const metaMap = dbs.get("anvil-mirror") && dbs.get("anvil-mirror").stores.get("meta");
  const metaB = metaMap && metaMap.get(JSON.stringify("sess_B"));
  const convo = (w.document.getElementById("conversation") || {}).innerHTML || "";
  console.log(JSON.stringify({
    shadowSubscribeSent: w.__sent.some((m) => m && m.type === "shadow.subscribe"),
    mirrorLastSeqB: metaB ? metaB.value.lastSeq : null,
    domHasShadowMsg: convo.includes(${JSON.stringify(SHADOW_MSG)}),
    initErr: w.__initErr || null,
  }));
}, 1700);
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

test("a shadow-pushed durable event advances the background session's mirror without touching the DOM", () => {
  const r = run(bundle);
  expect(r.initErr).toBeNull();
  expect(r.shadowSubscribeSent).toBe(true); // client subscribed on connect
  expect(r.mirrorLastSeqB).toBe(8); // the pushed event advanced B's mirror coverage
  expect(r.domHasShadowMsg).toBe(false); // …but never rendered into the active (A) pane
}, 30_000);
