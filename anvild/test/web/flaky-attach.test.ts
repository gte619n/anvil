import { test, expect, beforeAll } from "bun:test";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildBootBundle } from "./boot-bundle";

// Regression for the flaky-link "blank pane" bug (spec D1) AND the premature-cold-attach it caused.
//
// On a HALF-OPEN socket — readyState still OPEN (isOpen() true) but no frames flowing — a cold load used
// to send a `session.attach` with no lastSeq and stare at a skeleton until the heartbeat gave up (~25s).
// Worse, when the link recovered the daemon answered that cold attach with a FULL conversation.snapshot,
// wiping and repainting the whole pane.
//
// The fix: when we hold a cached transcript but the server hasn't reported a watermark for the session
// yet (half-open / still connecting), DON'T fire a cold attach. Paint the cache after a short budget and
// let the reconnect's session.list drive attachReconnect → a clean delta-resume that APPENDS the missing
// tail. This test boots the real bundle with a half-open socket, then simulates recovery and asserts the
// tail is appended (cache preserved, no wipe) and the only attach we ever sent carried a lastSeq.
//
// Runs under node (not bun) because bun's jsdom can't execute page scripts; node's jsdom runs them fine.

let bundle = "";
beforeAll(async () => {
  bundle = await buildBootBundle();
});

const BASE = "https://appassets.androidplatform.net/";
const ORIGIN = "https://appassets.androidplatform.net";
const MARKER = "CACHED_TRANSCRIPT_MARKER";
const TAIL = "APPENDED_TAIL_MARKER";

interface FlakyResult {
  early: string; // #conversation before the paint budget — a skeleton
  afterPaint: string; // after the budget — the cached transcript
  attachesBefore: { lastSeq: number | null }[]; // attaches sent before recovery — must be none
  afterRecovery: string; // after the reconnect delivers a delta
  attachesAfter: { lastSeq: number | null }[]; // attaches sent in total — one delta attach, no cold attach
  prunedEpoch: string | null; // anvil.epoch.* after a session.list that no longer lists the session — forgotten
  prunedIndex: string | null; // anvil.convo.index after that prune — no longer references the gone session
  initErr: string | null;
}

function runFlakyBoot(bundle: string): FlakyResult {
  const anvildRoot = join(import.meta.dir, "../..");
  const distHtml = join(anvildRoot, "web/dist/index.html");
  const srcHtml = join(anvildRoot, "web/index.html");
  const htmlPath = existsSync(distHtml) ? distHtml : srcHtml;

  const session = {
    id: "sess_flaky",
    title: "flaky",
    cwd: "/tmp/x",
    source: "existing-dir",
    model: "sonnet",
    autonomy: "mostly-autonomous",
    status: "idle",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastActivityAt: "2026-08-01T00:00:00.000Z",
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  };
  const seeds: Record<string, string> = {
    "anvil.active": "sess_flaky",
    "anvil.sessions": JSON.stringify([session]),
    "anvil.sessionServer": JSON.stringify([["sess_flaky", ORIGIN]]), // route it to the (half-open) hub
    "anvil.convo.index": JSON.stringify(["sess_flaky"]), // has() → true, so we render a skeleton first
    "anvil.epoch.sess_flaky": "ep1", // cached resume lineage — lets the recovery delta-resume (append)
    "anvil.seq.sess_flaky": "5",
  };
  const seedJs = Object.entries(seeds)
    .map(([k, v]) => `w.localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n");

  const harness = join(anvildRoot, `.flaky-harness-${process.pid}.mjs`);
  writeFileSync(
    harness,
    `import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
const html = readFileSync(${JSON.stringify(htmlPath)}, "utf8");
const dom = new JSDOM(html, { url: ${JSON.stringify(BASE)}, runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;

// Half-open socket: readyState reports OPEN (isOpen() → true) but onopen/onmessage never fire until we
// drive them. We keep a handle to every socket + record every frame the client sends.
w.__sockets = []; w.__sent = [];
class FakeWS { constructor(url){ this.url = url; this.readyState = 1; w.__sockets.push(this); }
  send(data){ try { w.__sent.push(JSON.parse(data)); } catch { w.__sent.push(data); } return true; }
  close(){ this.readyState = 3; } addEventListener(){} }
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
w.WebSocket = FakeWS;
w.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });

// Minimal in-memory IndexedDB pre-seeded with the cached transcript for sess_flaky.
const stores = { conversations: new Map([["sess_flaky", ${JSON.stringify(`<div class="bubble user">${MARKER}</div>`)}]]) };
function req(resultFn) {
  const r = {};
  setTimeout(() => { try { r.result = resultFn(); r.onsuccess && r.onsuccess(); } catch (e) { r.error = e; r.onerror && r.onerror(); } }, 0);
  return r;
}
w.indexedDB = {
  open() {
    const db = {
      objectStoreNames: { contains: (n) => n in stores },
      createObjectStore(n) { stores[n] = stores[n] || new Map(); },
      transaction(_n, _mode) { return { objectStore(nn) {
        const m = stores[nn];
        return { get: (k) => req(() => m.get(k)), put: (v, k) => req(() => { m.set(k, v); }), delete: (k) => req(() => { m.delete(k); }) };
      } }; },
    };
    const r = {};
    setTimeout(() => { r.result = db; r.onupgradeneeded && r.onupgradeneeded(); r.onsuccess && r.onsuccess(); }, 0);
    return r;
  },
};

${seedJs}
const code = readFileSync(${JSON.stringify(bundle)}, "utf8");
const s = w.document.createElement("script");
s.textContent = 'var __APP_VERSION__="test";\\ntry{' + code + '\\n}catch(e){window.__initErr=(e&&(e.name+": "+e.message))||String(e);}';
w.document.body.appendChild(s);

const convo = () => (w.document.getElementById("conversation") || {}).innerHTML || "";
const attaches = () => w.__sent.filter((m) => m && m.type === "session.attach").map((m) => ({ lastSeq: m.lastSeq ?? null }));
const deliver = (frame) => { const sock = w.__sockets[0]; sock && sock.onmessage && sock.onmessage({ data: JSON.stringify(frame) }); };

const report = {};
setTimeout(() => { report.early = convo(); }, 250); // before the ~500ms budget → skeleton
setTimeout(() => {
  report.afterPaint = convo(); // after the budget → cached transcript, and NO cold attach fired yet
  report.attachesBefore = attaches();
  // Simulate the link recovering: the daemon delivers watermarks, then session.list (every connect),
  // then the missing tail as a delta event.
  const sock = w.__sockets[0]; sock && sock.onopen && sock.onopen();
  deliver({ v: 4, type: "resume.watermarks", ts: "2026-08-01T00:00:00.000Z", watermarks: [{ sessionId: "sess_flaky", epoch: "ep1", lastSeq: 5 }] });
  deliver({ v: 4, type: "session.list", ts: "2026-08-01T00:00:00.000Z", sessions: [${JSON.stringify(session)}] });
  deliver({ v: 4, type: "message.user", ts: "2026-08-01T00:00:00.000Z", sessionId: "sess_flaky", seq: 6, rendered: { html: ${JSON.stringify(`<p>${TAIL}</p>`)} }, attachments: [], cid: "c1" });
}, 750);
setTimeout(() => {
  report.afterRecovery = convo();
  report.attachesAfter = attaches();
  // The other side of the prune guard: a session.list that NO LONGER lists sess_flaky must still forget
  // it (the WEB2-11 cleanup) — the active session is gone, so the pane clears and anvil.active is dropped.
  deliver({ v: 4, type: "session.list", ts: "2026-08-01T00:00:00.000Z", sessions: [] });
}, 1050);
setTimeout(() => {
  report.prunedEpoch = w.localStorage.getItem("anvil.epoch.sess_flaky");
  report.prunedIndex = w.localStorage.getItem("anvil.convo.index");
  report.initErr = w.__initErr || null;
  console.log(JSON.stringify(report));
}, 1250);
`,
  );
  try {
    const proc = Bun.spawnSync(["node", harness], { cwd: anvildRoot, stderr: "pipe", stdout: "pipe" });
    const out = proc.stdout.toString() || proc.stderr.toString();
    const line = out.split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "{}";
    return JSON.parse(line) as FlakyResult;
  } finally {
    rmSync(harness, { force: true });
  }
}

test("half-open link: cache paints, no premature cold attach, recovery APPENDS the tail (no repaint)", () => {
  const r = runFlakyBoot(bundle);
  expect(r.initErr).toBeNull();

  // Before the budget: a skeleton (the snapshot we'd have waited for never came).
  expect(r.early).toContain("convo-skeleton");
  expect(r.early).not.toContain(MARKER);

  // After the budget: the last-known transcript is on screen, and — crucially — we did NOT fire a cold
  // attach that would earn a full-snapshot repaint on recovery.
  expect(r.afterPaint).toContain(MARKER);
  expect(r.afterPaint).not.toContain("convo-skeleton");
  expect(r.attachesBefore).toEqual([]);

  // After recovery: the missing tail is APPENDED beneath the cached transcript — the cache is still
  // there (no clearConversation/repaint), and the only attach we ever sent carried a lastSeq (delta).
  expect(r.afterRecovery).toContain(MARKER);
  expect(r.afterRecovery).toContain(TAIL);
  expect(r.attachesAfter).toEqual([{ lastSeq: 5 }]);

  // The prune guard still fires for a truly-gone session: dropped from the list → its resume state is
  // forgotten (WEB2-11 cleanup). Guards against the fix accidentally keeping orphaned sessions forever.
  expect(r.prunedEpoch).toBeNull();
  expect(r.prunedIndex ?? "").not.toContain("sess_flaky");
}, 30_000);
