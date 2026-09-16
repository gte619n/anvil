import { test, expect, beforeAll } from "bun:test";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildBootBundle } from "./boot-bundle";

// Functional gate (spec §8.2 / D11): drive the REAL web bundle under jsdom, feed a synthetic but
// SDK-shaped multi-sub-agent event stream through the actual WebSocket seam, and assert the actual
// #conversation DOM — proving the indicator renders/updates/settles, not merely that payloads are shaped
// right. Covers every §6 UX state: fan-out start, running, done, error, canceled, finalize summary,
// reload-from-history, reconnect snapshot, and the no-sub-agent regression guard.

let bundle = "";
beforeAll(async () => {
  bundle = await buildBootBundle();
});

const BASE = "https://appassets.androidplatform.net/";
const ORIGIN = "https://appassets.androidplatform.net";
const SID = "sess_sa";

const SESSION = {
  id: SID,
  title: "sa",
  cwd: "/tmp/x",
  source: "existing-dir",
  model: "sonnet",
  autonomy: "mostly-autonomous",
  status: "idle",
  createdAt: "2026-08-01T00:00:00.000Z",
  lastActivityAt: "2026-08-01T00:00:00.000Z",
  usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
};

// ── event builders (daemon-shaped) ────────────────────────────────────────────────
const env = (extra: Record<string, unknown>, seq?: number) => ({ v: 4, ts: "t", sessionId: SID, ...(seq !== undefined ? { seq } : {}), ...extra });
const user = (seq: number) => env({ type: "message.user", rendered: { html: "<p>audit please</p>", source: "audit please" }, attachments: [] }, seq);
const taskLaunch = (seq: number, id: string, type: string, description: string) =>
  env({ type: "assistant.message", blocks: [{ kind: "tool_use", toolUseId: id, name: "Agent", input: { subagent_type: type, description } }] }, seq);
const bashLaunch = (seq: number, id: string) =>
  env({ type: "assistant.message", blocks: [{ kind: "tool_use", toolUseId: id, name: "Bash", input: { command: "ls -la" } }] }, seq);
const activity = (agents: unknown[]) => env({ type: "subagent.activity", live: true, agents });
const view = (id: string, label: string, type: string, state: string, extra: Record<string, unknown> = {}) => ({ id, label, type, state, steps: 0, ...extra });
const subResult = (seq: number, id: string, v: Record<string, unknown>) => env({ type: "tool.result", toolUseId: id, content: "", isError: v.state === "error", subagent: v }, seq);
const toolResult = (seq: number, id: string, content: string) => env({ type: "tool.result", toolUseId: id, content, isError: false }, seq);
const status = (seq: number, s: string) => env({ type: "status", status: s }, seq);
const result = (seq: number) => env({ type: "result", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, turns: 1 } }, seq);

interface Report {
  html: string;
  rows: number;
  states: string[];
  initErr: string | null;
}

/** Boot the real bundle, open a fake socket, inject `events` (server→client frames), read #conversation. */
function runBoot(events: unknown[]): Report {
  const anvildRoot = join(import.meta.dir, "../..");
  const htmlPath = existsSync(join(anvildRoot, "web/dist/index.html")) ? join(anvildRoot, "web/dist/index.html") : join(anvildRoot, "web/index.html");
  const fakeIdbPath = join(anvildRoot, "test/web/fake-idb.mjs");
  const harness = join(anvildRoot, `.subagents-harness-${process.pid}.mjs`);
  writeFileSync(
    harness,
    `import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { installFakeIdb } from ${JSON.stringify(fakeIdbPath)};
const html = readFileSync(${JSON.stringify(htmlPath)}, "utf8");
const dom = new JSDOM(html, { url: ${JSON.stringify(BASE)}, runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.__sent = [];
class FakeWS {
  constructor(u){ this.url = u; this.readyState = 0; w.__ws = this; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0); }
  send(d){ try { w.__sent.push(JSON.parse(d)); } catch { w.__sent.push(d); } return true; }
  close(){ this.readyState = 3; this.onclose && this.onclose(); }
  addEventListener(){}
}
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
w.WebSocket = FakeWS;
w.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
installFakeIdb(w, {});
w.localStorage.setItem("anvil.active", ${JSON.stringify(SID)});
w.localStorage.setItem("anvil.sessions", ${JSON.stringify(JSON.stringify([SESSION]))});
w.localStorage.setItem("anvil.sessionServer", ${JSON.stringify(JSON.stringify([[SID, ORIGIN]]))});
const code = readFileSync(${JSON.stringify(bundle)}, "utf8");
const s = w.document.createElement("script");
s.textContent = 'var __APP_VERSION__="test";\\ntry{' + code + '\\n}catch(e){window.__initErr=(e&&(e.name+": "+e.message))||String(e);}';
w.document.body.appendChild(s);
const EVENTS = ${JSON.stringify(events)};
const convo = () => (w.document.getElementById("conversation") || {}).innerHTML || "";
// inject after the socket opened + the app attached (onopen is a setTimeout(0) hop)
setTimeout(() => { for (const ev of EVENTS) { try { w.__ws.onmessage({ data: JSON.stringify(ev) }); } catch(e) { window.__injErr = String(e); } } }, 400);
setTimeout(() => {
  const rows = w.document.querySelectorAll("#conversation .subagent-row");
  const report = { html: convo(), rows: rows.length, states: [...rows].map((r) => r.getAttribute("data-state")), initErr: w.__initErr || w.__injErr || null };
  console.log(JSON.stringify(report));
  // The booted app leaves live timers (socket heartbeat interval, reconnect) — node would never exit and
  // spawnSync would hang. Force-exit now that the report is written.
  process.exit(0);
}, 1200);
`,
  );
  try {
    const proc = Bun.spawnSync(["node", harness], { cwd: anvildRoot, stderr: "pipe", stdout: "pipe" });
    const out = proc.stdout.toString() || proc.stderr.toString();
    const line = out.split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "{}";
    return JSON.parse(line) as Report;
  } finally {
    rmSync(harness, { force: true });
  }
}

test("fan-out: two sub-agents render as labelled running rows, then settle done/error (§6 states)", () => {
  const r = runBoot([
    status(1, "thinking"),
    taskLaunch(2, "task_1", "Explore", "Audit mutating mappings"),
    taskLaunch(3, "task_2", "general-purpose", "Build contract test"),
    // live heartbeats: both running, ticking steps + current tool
    activity([
      view("task_1", "Audit mutating mappings", "Explore", "running", { steps: 3, currentTool: "Grep", elapsedSeconds: 12 }),
      view("task_2", "Build contract test", "general-purpose", "running", { steps: 1, currentTool: "Read" }),
    ]),
    // one finishes, one errors (live snapshot)
    activity([
      view("task_1", "Audit mutating mappings", "Explore", "done", { steps: 6 }),
      view("task_2", "Build contract test", "general-purpose", "error", { steps: 2, error: "boom" }),
    ]),
    // durable completions (what survives reload)
    subResult(4, "task_1", { id: "task_1", label: "Audit mutating mappings", type: "Explore", state: "done", steps: 6 }),
    subResult(5, "task_2", { id: "task_2", label: "Build contract test", type: "general-purpose", state: "error", steps: 2, error: "boom" }),
    result(6),
  ]);
  expect(r.initErr).toBeNull();
  expect(r.rows).toBe(2);
  expect(r.states.sort()).toEqual(["done", "error"]);
  expect(r.html).toContain("Audit mutating mappings");
  expect(r.html).toContain("Build contract test");
  expect(r.html).toContain("Explore");
  expect(r.html).toContain("2 sub-agents"); // headline reflects the fan-out (D13)
  expect(r.html).toContain("6 steps"); // final step count from the durable summary
  expect(r.html).toContain("boom"); // the error reason stays visible (D7)
}, 30_000);

test("reconnect mid-fan-out: a bare live snapshot (no prior Task block) still renders running rows (D9)", () => {
  // Simulates a client that attached MID fan-out: it never saw the assistant.message Task launches,
  // only the daemon's re-surfaced subagent.activity snapshot. Rows must appear from the live event alone.
  const r = runBoot([
    status(1, "thinking"),
    activity([
      view("task_1", "Audit mutating mappings", "Explore", "running", { steps: 4, currentTool: "Read" }),
      view("task_2", "Build contract test", "general-purpose", "running", { steps: 2 }),
    ]),
  ]);
  expect(r.initErr).toBeNull();
  expect(r.rows).toBe(2);
  expect(r.states).toEqual(["running", "running"]);
  expect(r.html).toContain("Audit mutating mappings");
  expect(r.html).toContain("4 steps");
}, 30_000);

test("canceled state renders (daemon-side cancel snapshot, D7)", () => {
  const r = runBoot([
    status(1, "thinking"),
    taskLaunch(2, "task_1", "Explore", "Audit"),
    activity([view("task_1", "Audit", "Explore", "running", { steps: 3 })]),
    // the daemon cancels the still-running sub-agent (turn error / stopped elsewhere)
    activity([view("task_1", "Audit", "Explore", "canceled", { steps: 3 })]),
  ]);
  expect(r.initErr).toBeNull();
  expect(r.rows).toBe(1);
  expect(r.states).toEqual(["canceled"]);
  expect(r.html).toContain("canceled");
}, 30_000);

test("a late heartbeat cannot un-finish a settled row (merge guard)", () => {
  const r = runBoot([
    status(1, "thinking"),
    taskLaunch(2, "task_1", "Explore", "Audit"),
    subResult(3, "task_1", { id: "task_1", label: "Audit", type: "Explore", state: "done", steps: 6 }),
    // a stray live heartbeat arrives AFTER completion claiming "running" — must NOT regress
    activity([view("task_1", "Audit", "Explore", "running", { steps: 6, currentTool: "Grep" })]),
    result(4),
  ]);
  expect(r.initErr).toBeNull();
  expect(r.rows).toBe(1);
  expect(r.states).toEqual(["done"]);
}, 30_000);

test("reload: a conversation.snapshot with a durable Task tool.result renders the settled row (D10)", () => {
  // No live socket churn — just a cold snapshot replay (the reopen-from-history path). The sub-agent
  // row must render from the persisted assistant.message Task block + tool.result.subagent alone.
  const snapshot = env({
    type: "conversation.snapshot",
    seq: 9,
    lastSeq: 9,
    epoch: "ep1",
    events: [
      { kind: "user", ts: "t", rendered: { html: "<p>audit</p>", source: "audit" }, attachments: [] },
      { kind: "assistant", ts: "t", blocks: [{ kind: "tool_use", toolUseId: "task_1", name: "Agent", input: { subagent_type: "Explore", description: "Audit mutating mappings" } }] },
      { kind: "tool_result", ts: "t", toolUseId: "task_1", content: "", isError: false, subagent: { id: "task_1", label: "Audit mutating mappings", type: "Explore", state: "done", steps: 6 } },
      { kind: "result", ts: "t", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, turns: 1 } },
    ],
  });
  const r = runBoot([snapshot]);
  expect(r.initErr).toBeNull();
  expect(r.rows).toBe(1);
  expect(r.states).toEqual(["done"]);
  expect(r.html).toContain("Audit mutating mappings");
  expect(r.html).toContain("6 steps");
}, 30_000);

test("regression: an ordinary turn with NO sub-agents renders no sub-agent rows", () => {
  const r = runBoot([
    status(1, "thinking"),
    bashLaunch(2, "b1"),
    toolResult(3, "b1", "total 0"),
    result(4),
  ]);
  expect(r.initErr).toBeNull();
  expect(r.rows).toBe(0);
  expect(r.html).not.toContain("subagent-row");
  expect(r.html).toContain("total 0"); // the normal tool result still renders
}, 30_000);
