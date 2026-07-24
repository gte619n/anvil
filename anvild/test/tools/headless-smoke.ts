/**
 * Headless smoke test for the built web client (web/dist). Loads the bundle in headless Chrome
 * with NO daemon (so the WS just fails to connect — the offline path) and asserts that module
 * init does NOT throw and the shell renders. Guards the "dead app on load" failure mode
 * (TDZ / early-init decl-order — see memory: web-early-init-decl-order-crash).
 *
 *   bun test/tools/headless-smoke.ts
 *
 * Exit 0 = clean load; non-zero = an uncaught exception fired or the shell didn't render.
 */
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "..", "web", "dist");
const ROOT = join(import.meta.dir, "..", "..", "web");
// macOS default; override with CHROME_BIN for Linux/CI (e.g. /usr/bin/google-chrome).
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

// Serve web/dist, falling back to web/ (index.html lives there) — same files the daemon serves.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    for (const base of [DIST, ROOT]) {
      const f = Bun.file(join(base, rel));
      if (await f.exists()) {
        const ext = rel.slice(rel.lastIndexOf("."));
        return new Response(f, { headers: { "content-type": TYPES[ext] ?? "application/octet-stream" } });
      }
    }
    return new Response("not found", { status: 404 });
  },
});
const pageUrl = `http://localhost:${server.port}/`;

// Launch headless Chrome with the remote debugger.
const userDir = join(import.meta.dir, ".chrome-smoke");
const chrome = Bun.spawn(
  [CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", pageUrl],
  { stdout: "pipe", stderr: "pipe" },
);

// Chrome prints "DevTools listening on ws://..." to stderr — read it to find the CDP endpoint.
async function devtoolsWs(): Promise<string> {
  const reader = chrome.stderr.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (let i = 0; i < 200; i++) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value);
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      reader.releaseLock();
      return m[1]!;
    }
    if (done) break;
  }
  throw new Error("Chrome did not announce a DevTools endpoint");
}

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  try {
    chrome.kill();
  } catch {}
  server.stop(true);
  process.exit(1);
}

const browserWs = await devtoolsWs().catch((e) => fail(String(e)));
// browserWs is the BROWSER target (no DOM). Find the PAGE target's debugger URL via /json/list.
const cdpHost = new URL(browserWs).host; // 127.0.0.1:<port>
async function pageWs(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list = (await (await fetch(`http://${cdpHost}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[];
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no page target found");
}
const wsUrl = await pageWs().catch((e) => fail(String(e)));
const ws = new WebSocket(wsUrl);
const exceptions: string[] = [];
let id = 0;
const send = (method: string, params: unknown = {}): void => ws.send(JSON.stringify({ id: ++id, method, params }));

// Seed a team (one lead + two nested members) into the offline session cache so the reload exercises
// the sidebar tree-render path with nested members (anvil-team-support.md §5) — the "render must not
// throw with a team present" guard. The client hydrates `anvil.sessions` from localStorage offline.
const teamSeed = [
  { id: "lead1", title: "Ship feature X", cwd: "/w/lead", source: "fresh-worktree", model: "opus", autonomy: "mostly-autonomous", status: "idle", createdAt: "", lastActivityAt: "", usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, teamRole: "lead", team: { integration: "combined-pr", maxConcurrentMembers: 3 } },
  { id: "m1", title: "Auth", cwd: "/w/m1", source: "fresh-worktree", model: "opus", autonomy: "mostly-autonomous", status: "running_tool", createdAt: "", lastActivityAt: "", usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, parentId: "lead1", teamRole: "member", memberTask: "wire up oauth" },
  { id: "m2", title: "Tests", cwd: "/w/m2", source: "fresh-worktree", model: "opus", autonomy: "mostly-autonomous", status: "awaiting_permission", createdAt: "", lastActivityAt: "", usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, parentId: "lead1", teamRole: "member", memberTask: "add coverage" },
];

const allConsole: string[] = [];
ws.onopen = () => {
  send("Runtime.enable");
  send("Log.enable");
  send("Page.enable");
  // Seed the team into localStorage BEFORE the bundle runs on the reloaded document (its
  // `hydrateOffline` IIFE reads `anvil.sessions` at import), so the reload renders the tree.
  send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem('anvil.sessions', ${JSON.stringify(JSON.stringify(teamSeed))});localStorage.setItem('anvil.active','lead1');}catch(e){}` });
  send("Page.reload", { ignoreCache: true }); // reload now that the seed-on-new-document is armed
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data)) as { method?: string; params?: any };
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    exceptions.push(d?.exception?.description ?? d?.text ?? "unknown exception");
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    allConsole.push(`console.error: ${(msg.params.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ")}`);
  }
  if (msg.method === "Log.entryAdded") {
    const t = msg.params.entry.text ?? "";
    allConsole.push(`log[${msg.params.entry.level}]: ${t}`);
    // Ignore expected offline-path noise: the WS to /ws fails (no daemon in this harness), and CDN/
    // optional assets 404. A real dead-app bug shows as a Runtime.exceptionThrown or a JS error here.
    if (msg.params.entry.level === "error" && !/favicon|fonts\.g|katex|xterm\.css|manifest|net::ERR|Failed to load resource|WebSocket connection to '[^']*\/ws'/i.test(t)) exceptions.push(`console.error: ${t}`);
  }
};

// Give module init + the instant-restore render time to run, then assert the shell exists.
await new Promise((r) => setTimeout(r, 2500));
const check = await new Promise<{ result?: { result?: { value?: string } } }>((resolve) => {
  const probeId = ++id;
  const onMsg = (ev: MessageEvent): void => {
    const m = JSON.parse(String(ev.data));
    if (m.id === probeId) {
      ws.removeEventListener("message", onMsg);
      resolve(m);
    }
  };
  ws.addEventListener("message", onMsg);
  ws.send(
    JSON.stringify({
      id: probeId,
      method: "Runtime.evaluate",
      // shell rendered AND init ran past the connection layer (new-session button + a populated brand
      // version) AND the seeded team rendered its nested member rows + lead rollup chip (teams §5).
      params: { expression: `JSON.stringify({ newSession: !!document.querySelector('#open-settings'), brand: document.querySelector('#brand-version')?.textContent || '', url: location.href, bodyLen: document.body?.innerHTML.length || 0, members: document.querySelectorAll('.team-members > .session.member').length, rollup: !!document.querySelector('.team-rollup') })`, returnByValue: true },
    }),
  );
});

try {
  ws.close();
} catch {}
chrome.kill();
server.stop(true);

const diag = JSON.parse(check.result?.result?.value || "{}") as { newSession?: boolean; brand?: string; url?: string; bodyLen?: number; members?: number; rollup?: boolean };
if (exceptions.length) fail(`uncaught exception(s) during load:\n  ${exceptions.join("\n  ")}`);
if (!diag.newSession || !(diag.brand && diag.brand.length > 0)) {
  console.error("diag: " + JSON.stringify(diag));
  console.error("--- console output ---\n" + (allConsole.join("\n") || "(none)"));
  fail("shell did not render (#new-session missing or init aborted before brand version set)");
}
if (diag.members !== 2 || !diag.rollup) {
  console.error("diag: " + JSON.stringify(diag));
  fail(`team tree did not render (expected 2 nested members + a rollup chip, got members=${diag.members} rollup=${diag.rollup})`);
}
console.log(`SMOKE OK: bundle loaded cleanly, shell + team tree rendered (brand ${diag.brand}, ${diag.members} members), no uncaught exceptions`);
process.exit(0);
