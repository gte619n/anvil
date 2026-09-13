import { test, expect, beforeAll } from "bun:test";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildBootBundle } from "./boot-bundle";

// Regression: "backgrounded response never renders" (the 5.0 offline work broke reopen-after-background).
// Two invariants, both broken by the same root cause — background writers (Android staged history sync,
// greedy prefetch) advanced the resume watermark after writing only to the MIRROR, while the pane painted
// from a staler source and then delta-resumed from the inflated seq (empty delta → the assistant response
// existed in IndexedDB but never reached the DOM, on that open and every open after):
//   A. When the mirror's coverage is ahead of the HTML accelerator's stamp, the mirror must win the
//      paint — a device already poisoned by the old build self-heals this way, because its mirror holds
//      the full staged snapshot.
//   B. A staged batch for the ACTIVE session must not stomp its resume watermark, and must repaint the
//      pane from the now-complete mirror when there's no live socket to pull the tail from.

let bundle = "";
beforeAll(async () => {
  bundle = await buildBootBundle();
});

const BASE = "https://appassets.androidplatform.net/";
const ORIGIN = "https://appassets.androidplatform.net";
const SENT_MSG = "WHAT_I_SENT";
const RESPONSE_MSG = "THE_ASSISTANT_RESPONSE";

interface Result {
  early: string;
  final: string;
  initErr: string | null;
}

const SESSION = {
  id: "sess_m",
  title: "m",
  cwd: "/tmp/x",
  source: "existing-dir",
  model: "sonnet",
  autonomy: "mostly-autonomous",
  status: "idle",
  createdAt: "2026-08-01T00:00:00.000Z",
  lastActivityAt: "2026-08-01T00:00:00.000Z",
  usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
};
const userEvent = (text: string) => ({ kind: "user", ts: "t", rendered: { html: `<p>${text}</p>` }, attachments: [] });
const assistantEvent = (text: string) => ({ kind: "assistant", ts: "t", blocks: [{ kind: "markdown", rendered: { html: `<p>${text}</p>` } }] });

function runBoot(opts: { idbSeed: Record<string, unknown>; seeds: Record<string, string>; afterBootJs?: string }): Result {
  const anvildRoot = join(import.meta.dir, "../..");
  const htmlPath = existsSync(join(anvildRoot, "web/dist/index.html")) ? join(anvildRoot, "web/dist/index.html") : join(anvildRoot, "web/index.html");
  const fakeIdbPath = join(anvildRoot, "test/web/fake-idb.mjs");
  const seedJs = Object.entries(opts.seeds)
    .map(([k, v]) => `w.localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n");

  const harness = join(anvildRoot, `.stale-paint-harness-${process.pid}.mjs`);
  writeFileSync(
    harness,
    `import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { installFakeIdb } from ${JSON.stringify(fakeIdbPath)};
const html = readFileSync(${JSON.stringify(htmlPath)}, "utf8");
const dom = new JSDOM(html, { url: ${JSON.stringify(BASE)}, runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.__sent = [];
class FakeWS { constructor(u){ this.url = u; this.readyState = 3; w.__ws = this; } send(d){ try { w.__sent.push(JSON.parse(d)); } catch { w.__sent.push(d); } return true; } close(){ this.readyState = 3; } addEventListener(){} }
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
w.WebSocket = FakeWS;
w.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
installFakeIdb(w, ${JSON.stringify(opts.idbSeed)});
${seedJs}
const code = readFileSync(${JSON.stringify(bundle)}, "utf8");
const s = w.document.createElement("script");
s.textContent = 'var __APP_VERSION__="test";\\ntry{' + code + '\\n}catch(e){window.__initErr=(e&&(e.name+": "+e.message))||String(e);}';
w.document.body.appendChild(s);
const convo = () => (w.document.getElementById("conversation") || {}).innerHTML || "";
const report = {};
setTimeout(() => { report.early = convo(); ${opts.afterBootJs ?? ""} }, 700);
setTimeout(() => { report.final = convo(); report.initErr = w.__initErr || null; console.log(JSON.stringify(report)); }, 1800);
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

test("A: a mirror ahead of the stale HTML accelerator wins the paint (poisoned device self-heals)", () => {
  // The old-build aftermath: the staged sync wrote the full snapshot (incl. the response) to the mirror
  // and poisoned anvil.seq to the server's latest, while the HTML cache (legacy, unstamped) still shows
  // only what the user sent. The reopen must paint the mirror — response visible — not the stale HTML.
  const meta = { sessionId: "sess_m", epoch: "ep1", baseSeq: 6, lastSeq: 6, serverUrl: ORIGIN, lastActivityAt: "2026-08-01", bytes: 100, completeAt: "", tailCount: 0 };
  const r = runBoot({
    idbSeed: {
      "anvil-mirror": { meta: [["sess_m", meta]], base: [["sess_m", [userEvent(SENT_MSG), assistantEvent(RESPONSE_MSG)]]], tail: [] },
      anvil: { conversations: [["sess_m", `<div class="msg user"><p>${SENT_MSG}</p></div>`]] }, // legacy unstamped entry
    },
    seeds: {
      "anvil.active": "sess_m",
      "anvil.sessions": JSON.stringify([SESSION]),
      "anvil.sessionServer": JSON.stringify([["sess_m", ORIGIN]]),
      "anvil.mirror.index": JSON.stringify(["sess_m"]),
      "anvil.convo.index": JSON.stringify(["sess_m"]),
      "anvil.epoch.sess_m": "ep1",
      "anvil.seq.sess_m": "6", // poisoned: server-level, far beyond what the HTML cache shows
    },
  });
  expect(r.initErr).toBeNull();
  expect(r.final).toContain(RESPONSE_MSG); // the whole bug: this used to be missing forever
  expect(r.final).toContain(SENT_MSG);
  expect(r.final).not.toContain("convo-skeleton");
}, 30_000); // spawns node+JSDOM and parses the full web bundle — well over bun's 5s default under CI load

test("B: a staged history batch for the active session repaints the pane with the response", () => {
  // Fresh reopen offline: the pane painted the pre-background mirror (user message only), THEN the
  // native shell hands over the staged snapshot the FCM-triggered background sync fetched. The response
  // must show up — and the handler must not stomp the watermark of the pane on screen to get there.
  const meta = { sessionId: "sess_m", epoch: "ep1", baseSeq: 2, lastSeq: 2, serverUrl: ORIGIN, lastActivityAt: "2026-08-01", bytes: 100, completeAt: "", tailCount: 0 };
  const staged = [
    {
      sessionId: "sess_m",
      response: {
        v: 4,
        type: "session.history.snapshot",
        ts: "t",
        sessionId: "sess_m",
        snapshot: { events: [userEvent(SENT_MSG), assistantEvent(RESPONSE_MSG)], lastSeq: 6, epoch: "ep1" },
      },
    },
  ];
  const r = runBoot({
    idbSeed: { "anvil-mirror": { meta: [["sess_m", meta]], base: [["sess_m", [userEvent(SENT_MSG)]]], tail: [] } },
    seeds: {
      "anvil.active": "sess_m",
      "anvil.sessions": JSON.stringify([SESSION]),
      "anvil.sessionServer": JSON.stringify([["sess_m", ORIGIN]]),
      "anvil.mirror.index": JSON.stringify(["sess_m"]),
      "anvil.epoch.sess_m": "ep1",
      "anvil.seq.sess_m": "2",
    },
    afterBootJs: `w.__anvilApplyStagedHistory && w.__anvilApplyStagedHistory(${JSON.stringify(JSON.stringify(staged))});`,
  });
  expect(r.initErr).toBeNull();
  expect(r.early).toContain(SENT_MSG); // pre-background state painted from the old mirror
  expect(r.early).not.toContain(RESPONSE_MSG);
  expect(r.final).toContain(RESPONSE_MSG); // the staged batch surfaced the backgrounded response
  expect(r.final).toContain(SENT_MSG);
}, 30_000);
