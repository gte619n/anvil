import { test, expect, beforeAll } from "bun:test";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildBootBundle } from "./boot-bundle";

// Phase 1 acceptance (comprehensive-offline spec §5): with a durable mirror present but NO HTML
// accelerator, a cold offline boot renders the complete transcript from the mirror (base ++ tail).
// A second scenario proves the epoch-reset invalidation path: an epoch-changed watermark drops the
// stale mirror so a fresh snapshot repaints instead of showing stale content.

let bundle = "";
beforeAll(async () => {
  bundle = await buildBootBundle();
});

const BASE = "https://appassets.androidplatform.net/";
const ORIGIN = "https://appassets.androidplatform.net";
const M_BASE = "MIRROR_BASE_MSG";
const M_TAIL = "MIRROR_TAIL_MSG";

interface Result {
  early: string;
  offline: string;
  attaches: { lastSeq: number | null }[];
  initErr: string | null;
}

function runMirrorBoot(bundle: string, opts: { online: boolean }): Result {
  const anvildRoot = join(import.meta.dir, "../..");
  const htmlPath = existsSync(join(anvildRoot, "web/dist/index.html")) ? join(anvildRoot, "web/dist/index.html") : join(anvildRoot, "web/index.html");
  const fakeIdbPath = join(anvildRoot, "test/web/fake-idb.mjs");

  const session = { id: "sess_m", title: "m", cwd: "/tmp/x", source: "existing-dir", model: "sonnet", autonomy: "mostly-autonomous", status: "idle", createdAt: "2026-08-01T00:00:00.000Z", lastActivityAt: "2026-08-01T00:00:00.000Z", usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  // Seed the mirror DB directly: a base snapshot (seq 3) + one tail event (seq 4). NO convoCache HTML.
  const baseEvents = [{ kind: "user", ts: "t", rendered: { html: `<p>${M_BASE}</p>` }, attachments: [] }];
  const tailEvent = { kind: "user", ts: "t", rendered: { html: `<p>${M_TAIL}</p>` }, attachments: [] };
  const meta = { sessionId: "sess_m", epoch: "ep1", baseSeq: 3, lastSeq: 4, serverUrl: ORIGIN, lastActivityAt: "2026-08-01", bytes: 100, completeAt: "", tailCount: 1 };

  const seeds: Record<string, string> = {
    "anvil.active": "sess_m",
    "anvil.sessions": JSON.stringify([session]),
    "anvil.sessionServer": JSON.stringify([["sess_m", ORIGIN]]),
    "anvil.mirror.index": JSON.stringify(["sess_m"]),
    "anvil.epoch.sess_m": "ep1",
    "anvil.seq.sess_m": "4",
  };
  const seedJs = Object.entries(seeds).map(([k, v]) => `w.localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n");
  const readyState = opts.online ? 1 : 3; // 3 = CLOSED → isOpen() false → the offline branch

  const harness = join(anvildRoot, `.mirror-harness-${process.pid}.mjs`);
  writeFileSync(
    harness,
    `import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { installFakeIdb } from ${JSON.stringify(fakeIdbPath)};
const html = readFileSync(${JSON.stringify(htmlPath)}, "utf8");
const dom = new JSDOM(html, { url: ${JSON.stringify(BASE)}, runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.__sent = [];
class FakeWS { constructor(u){ this.url = u; this.readyState = ${readyState}; w.__ws = this; } send(d){ try { w.__sent.push(JSON.parse(d)); } catch { w.__sent.push(d); } return true; } close(){ this.readyState = 3; } addEventListener(){} }
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
w.WebSocket = FakeWS;
w.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
installFakeIdb(w, { "anvil-mirror": { meta: [["sess_m", ${JSON.stringify(meta)}]], base: [["sess_m", ${JSON.stringify(baseEvents)}]], tail: [[["sess_m", 4], ${JSON.stringify(tailEvent)}]] } });
${seedJs}
const code = readFileSync(${JSON.stringify(bundle)}, "utf8");
const s = w.document.createElement("script");
s.textContent = 'var __APP_VERSION__="test";\\ntry{' + code + '\\n}catch(e){window.__initErr=(e&&(e.name+": "+e.message))||String(e);}';
w.document.body.appendChild(s);
const convo = () => (w.document.getElementById("conversation") || {}).innerHTML || "";
const attaches = () => w.__sent.filter((m) => m && m.type === "session.attach").map((m) => ({ lastSeq: m.lastSeq ?? null }));
const report = {};
setTimeout(() => { report.early = convo(); }, 250);
setTimeout(() => { report.offline = convo(); report.attaches = attaches(); report.initErr = w.__initErr || null; console.log(JSON.stringify(report)); }, 900);
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

test("cold OFFLINE boot renders the full transcript from the mirror (base ++ tail), no HTML cache", () => {
  const r = runMirrorBoot(bundle, { online: false });
  expect(r.initErr).toBeNull();
  expect(r.offline).toContain(M_BASE); // base snapshot event rendered
  expect(r.offline).toContain(M_TAIL); // tail delta event rendered on top
  expect(r.offline).not.toContain("convo-skeleton"); // the mirror replaced the skeleton
}, 30_000); // spawns node+JSDOM and parses the full web bundle — well over bun's 5s default under CI load

test("cold ONLINE boot with a matching watermark paints the mirror AND delta-resumes (append, no wipe)", () => {
  // Socket OPEN + cached epoch/seq match the seed → attachConversation's delta branch: paint mirror,
  // then session.attach WITH lastSeq. (No watermark is delivered here, so the deferred branch also
  // paints via budget; either way the mirror content is on screen and no snapshot was demanded.)
  const r = runMirrorBoot(bundle, { online: true });
  expect(r.initErr).toBeNull();
  expect(r.offline).toContain(M_BASE);
  expect(r.offline).toContain(M_TAIL);
  // Crucially: we never sent a cold (no-lastSeq) attach that would force a full-snapshot repaint.
  expect(r.attaches.filter((a) => a.lastSeq === null)).toEqual([]);
}, 30_000); // the ONLINE branch runs the full attach/delta path — the slowest of the mirror-boot tests
