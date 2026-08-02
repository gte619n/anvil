import { test, expect, beforeAll } from "bun:test";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildBootBundle } from "./boot-bundle";

// Guard for issue #158: every daemon's concierge chat shares the hard-coded id `sess_default`, and
// the client keys sessions/routing by id alone — so in a fleet the hub's and a member's default
// chats collided into ONE sidebar row whose server attribution flipped with delivery order, and a
// prompt could be routed to the wrong daemon. The fix namespaces the id at the client boundary
// (fleet.ts): inbound frames from a non-origin server rewrite it to `sess_default@<serverId>`, and
// the owning socket strips it back to the wire id on the way out.
//
// Like boot-init.test.ts this boots the REAL bundle (node+jsdom — bun's jsdom can't run page
// scripts), but with a scripted WebSocket so the test can deliver `server.hello` + `session.list`
// frames per server and inspect every frame the client sends back.

// One bundle per test process, shared with boot-init.test.ts (see boot-bundle.ts for why a second
// in-process Bun.build must be avoided).
let bundle = "";
beforeAll(async () => {
  bundle = await buildBootBundle();
});

const BASE = "https://appassets.androidplatform.net/";
const HUB_ORIGIN = "https://appassets.androidplatform.net";
const MEMBER_URL = "https://member.test:7701";

interface HarnessResult {
  initErr: string | null;
  conciergeIds: string[]; // data-ids of the pinned concierge rows, in DOM order
  routing: [string, string][]; // persisted anvil.sessionServer
  hubSent: { type: string; sessionId?: string }[];
  memberSent: { type: string; sessionId?: string }[];
}

/** Boot the bundle, run `scenario` ("hub-first" | "member-first" | "outbound"), report the state. */
function runFleet(scenario: string, seeds: Record<string, string>): HarnessResult {
  const anvildRoot = join(import.meta.dir, "../..");
  const distHtml = join(anvildRoot, "web/dist/index.html");
  const htmlPath = existsSync(distHtml) ? distHtml : join(anvildRoot, "web/index.html");
  const seedJs = Object.entries(seeds)
    .map(([k, v]) => `w.localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n");
  const harness = join(anvildRoot, `.fleet158-harness-${process.pid}-${scenario}.mjs`);
  writeFileSync(
    harness,
    `import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
const html = readFileSync(${JSON.stringify(htmlPath)}, "utf8");
const dom = new JSDOM(html, { url: ${JSON.stringify(BASE)}, runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
const sockets = [];
w.WebSocket = class {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); w.setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0); }
  send(data) { this.sent.push(String(data)); }
  close() { this.readyState = 3; }
};
w.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
w.fetch = () => Promise.reject(new Error("no network in harness"));
w.HTMLElement.prototype.scrollIntoView = () => {};
${seedJs}
const code = readFileSync(${JSON.stringify(bundle)}, "utf8");
const s = w.document.createElement("script");
s.textContent = 'var __APP_VERSION__="test";\\ntry{' + code + '\\n}catch(e){window.__initErr=(e&&(e.name+": "+e.message))||String(e);}';
w.document.body.appendChild(s);

const iso = new Date().toISOString();
const hostOf = (u) => new w.URL(u.replace(/^ws/i, "http")).host;
const sockFor = (host) => sockets.find((x) => hostOf(x.url) === host);
const deliver = (sock, e) => sock.onmessage({ data: JSON.stringify({ v: 4, ts: iso, ...e }) });
const hello = (serverId, serverName) => ({ type: "server.hello", serverId, serverName, version: "0.0.0-test", capabilities: [] });
const defaultSession = (title) => ({
  id: "sess_default", title, cwd: "/tmp", source: "existing-dir", model: "sonnet",
  autonomy: "mostly-autonomous", status: "idle", isDefault: true,
  createdAt: iso, lastActivityAt: iso, usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
});
const scenario = ${JSON.stringify(scenario)};

setTimeout(() => {
  const hub = sockFor("appassets.androidplatform.net");
  const member = sockFor("member.test:7701");
  if (scenario === "hub-first") {
    deliver(hub, hello("srv_hub", "Hub"));
    deliver(hub, { type: "session.list", sessions: [defaultSession("Hub Claude")] });
    deliver(member, hello("srv_member", "Member"));
    deliver(member, { type: "session.list", sessions: [defaultSession("Member Claude")] });
  } else if (scenario === "member-first") {
    deliver(member, hello("srv_member", "Member"));
    deliver(member, { type: "session.list", sessions: [defaultSession("Member Claude")] });
    deliver(hub, hello("srv_hub", "Hub"));
    deliver(hub, { type: "session.list", sessions: [defaultSession("Hub Claude")] });
  } else if (scenario === "outbound") {
    deliver(member, hello("srv_member", "Member"));
    deliver(member, { type: "session.list", sessions: [defaultSession("Member Claude")] });
  }
}, 100);

setTimeout(() => {
  const hub = sockFor("appassets.androidplatform.net");
  const member = sockFor("member.test:7701");
  const parseSent = (sock) => (sock ? sock.sent : [])
    .map((f) => { try { return JSON.parse(f); } catch { return {}; } })
    .filter((f) => f.type && f.type !== "ping")
    .map((f) => ({ type: f.type, ...(typeof f.sessionId === "string" ? { sessionId: f.sessionId } : {}) }));
  console.log(JSON.stringify({
    initErr: w.__initErr || null,
    conciergeIds: [...w.document.querySelectorAll("#concierge-list li.session")].map((li) => li.dataset.id),
    routing: JSON.parse(w.localStorage.getItem("anvil.sessionServer") || "[]"),
    hubSent: parseSent(hub),
    memberSent: parseSent(member),
  }));
  process.exit(0); // the fake sockets' heartbeat intervals would otherwise keep node alive forever
}, 700);
`,
  );
  try {
    const proc = Bun.spawnSync(["node", harness], { cwd: anvildRoot, stderr: "pipe", stdout: "pipe" });
    const out = proc.stdout.toString() || proc.stderr.toString();
    const line = out.split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "{}";
    return JSON.parse(line) as HarnessResult;
  } finally {
    rmSync(harness, { force: true });
  }
}

const SERVERS_SEED = { "anvil.servers": JSON.stringify([MEMBER_URL]) };

test("[#158] two servers' default chats render as two rows, each routed to its own server", () => {
  const r = runFleet("hub-first", SERVERS_SEED);
  expect(r.initErr).toBeNull();
  // Two distinct pinned concierge rows — not one collapsed row.
  expect([...r.conciergeIds].sort()).toEqual(["sess_default", "sess_default@srv_member"]);
  // Each routes to its own daemon: the plain id to the origin, the namespaced one to the member.
  const routing = new Map(r.routing);
  expect(routing.get("sess_default")).toBe(HUB_ORIGIN);
  expect(routing.get("sess_default@srv_member")).toBe(MEMBER_URL);
}, 30_000);

test("[#158] reload-equivalent opposite delivery order keeps attribution stable (+ pre-fix routing migrates)", () => {
  // Seed the exact pre-fix residue: the shared plain id left routed at the MEMBER because its
  // session.list happened to land last before the fix shipped. Boot must re-point it at the origin.
  const r = runFleet("member-first", {
    ...SERVERS_SEED,
    "anvil.sessionServer": JSON.stringify([["sess_default", MEMBER_URL]]),
  });
  expect(r.initErr).toBeNull();
  // Same two rows, same attribution — delivery order (a reload's connect race) doesn't flip anything.
  expect([...r.conciergeIds].sort()).toEqual(["sess_default", "sess_default@srv_member"]);
  const routing = new Map(r.routing);
  expect(routing.get("sess_default")).toBe(HUB_ORIGIN); // migrated off the stale member url
  expect(routing.get("sess_default@srv_member")).toBe(MEMBER_URL);
}, 30_000);

test("[#158] outbound commands for a member's default chat carry the wire id, on the member's socket only", () => {
  // Returning user with the member's concierge open: the session.list re-attach must go to the
  // MEMBER's socket as plain "sess_default" — the id its daemon actually knows.
  const memberDefault = {
    id: "sess_default@srv_member", title: "Member Claude", cwd: "/tmp", source: "existing-dir",
    model: "sonnet", autonomy: "mostly-autonomous", status: "idle", isDefault: true,
    createdAt: "2026-08-01T00:00:00.000Z", lastActivityAt: "2026-08-01T00:00:00.000Z",
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  };
  const r = runFleet("outbound", {
    ...SERVERS_SEED,
    "anvil.active": "sess_default@srv_member",
    "anvil.sessions": JSON.stringify([memberDefault]),
    "anvil.sessionServer": JSON.stringify([["sess_default@srv_member", MEMBER_URL]]),
  });
  expect(r.initErr).toBeNull();
  const attaches = r.memberSent.filter((f) => f.type === "session.attach");
  expect(attaches.length).toBeGreaterThan(0);
  for (const f of attaches) expect(f.sessionId).toBe("sess_default"); // namespace stripped at the socket
  // The namespaced client-side id never reaches any wire, and the hub is never asked to attach it.
  for (const f of [...r.hubSent, ...r.memberSent]) expect(f.sessionId ?? "").not.toContain("sess_default@");
  expect(r.hubSent.filter((f) => f.type === "session.attach")).toEqual([]);
}, 30_000);
