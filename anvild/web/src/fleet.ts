// ── Fleet: the multi-server connection layer + fleet administration UI ───────────────────────────
// Extracted verbatim from main.ts (P7 god-file decomposition). Two seams live here:
//   1. The multi-server connection layer (anvil-multi-server.md §4): the Server registry, one
//      AnvilSocket per server, and the outbound routing maps (sessionServer/envServer/…).
//   2. Fleet administration (anvil-server-app.md §6) + the pinned fleet update rollout — the
//      Settings → Fleet card actions (add/remove a machine, sync accounts, update fleet).
//
// This module evaluates BEFORE main.ts's body (main imports it), which preserves the old
// declare-up-top guarantee: the instant-restore render in main's module init calls orderedServers()
// → reads `servers`/`HUB_URL`, and both are initialized here first (see memory:
// web-early-init-decl-order-crash). Sockets do NOT connect at module eval — main.ts calls
// ensureServer(HUB_URL) (+ the registry) after its outbox state is initialized, exactly where the
// connects always happened.
//
// main.ts ↔ fleet.ts wiring: fleet.ts never imports from main.ts. Everything fleet code needs from
// main (event/status handlers, renderers, persistence) is injected once via
// initFleet(deps) — mirroring the daemon-side P7 services — before any socket is created.
import { AnvilSocket } from "./ws";
import { apiFetch, daemonBase, sameServerUrl } from "./api";
import { $, enhanceSelect, esc, icon, refreshSelect } from "./dom";
// dialogs.ts is a leaf (it only type-imports this module), so the modal/toast helpers are direct
// imports — they used to arrive via initFleet(deps).
import { closeModal, confirmDialog, showModal, toast } from "./dialogs";
import { armJoinWindow } from "./setup";
import { ui } from "./state";
import type { AutopilotPlanInfo, Budget, Environment, Loop, LoopRun, LoopSummary, ServerEvent, Session, TeamInfo, TeamPlan, rest } from "../../protocol";

// ── Injected dependencies (initFleet) ────────────────────────────────────────────────────────────
// What fleet code calls back into main.ts for. Each field documents the main.ts state it reaches.
export interface FleetDeps {
  /** WS event fan-in — main's big `onEvent(url, e)` router. */
  onEvent(url: string, e: ServerEvent): void;
  /** Connection-status plumbing — main's `onStatus` (conn dots, outbox flush, restart-reload). */
  onStatus(url: string, status: "connecting" | "connected" | "disconnected"): void;
  /** The merged session list (main owns it; removeServer drops a gone server's rows). */
  sessions: Map<string, Session>;
  /** The merged environment list (main owns it; removeServer drops a gone server's rows). */
  environments: Map<string, Environment>;
  /** Autopilot stale-run backstop for a server (autopilot.ts's `clearStaleRunTimer`, passed through
   *  by main — fleet.ts can't import autopilot.ts, which imports this module). */
  clearStaleRunTimer(url: string): void;
  /** Drop a removed server's autopilot schedule entry (autopilot.ts's `serverSchedule.delete`,
   *  passed through by main as a call for the same no-cycle reason). */
  deleteServerSchedule(url: string): void;
  reflectAutopilotRunning(): void;
  updateAutopilotBadge(): void;
  persistSessions(): void;
  persistEnvironments(): void;
  renderSessions(): void;
  /** The Settings → Fleet card list (stays in main next to the roster/ADB card helpers). */
  renderServerCards(): void;
  /** Write into the hub card's update-output pane (the restart-reload flow). */
  setUpdateStatus(text: string): void;
}
// Module-local mirrors of the injected deps, named exactly as in main.ts so the moved code below
// stays verbatim. Assigned once by initFleet — which main.ts calls during its module init, before
// any socket exists — so no fleet entry point can observe them unset.
let onEvent: FleetDeps["onEvent"];
let onStatus: FleetDeps["onStatus"];
let sessions: FleetDeps["sessions"];
let environments: FleetDeps["environments"];
let clearStaleRunTimer: FleetDeps["clearStaleRunTimer"];
let deleteServerSchedule: FleetDeps["deleteServerSchedule"];
let reflectAutopilotRunning: FleetDeps["reflectAutopilotRunning"];
let updateAutopilotBadge: FleetDeps["updateAutopilotBadge"];
let persistSessions: FleetDeps["persistSessions"];
let persistEnvironments: FleetDeps["persistEnvironments"];
let renderSessions: FleetDeps["renderSessions"];
let renderServerCards: FleetDeps["renderServerCards"];
let setUpdateStatus: FleetDeps["setUpdateStatus"];
export function initFleet(deps: FleetDeps): void {
  ({
    onEvent,
    onStatus,
    sessions,
    environments,
    clearStaleRunTimer,
    deleteServerSchedule,
    reflectAutopilotRunning,
    updateAutopilotBadge,
    persistSessions,
    persistEnvironments,
    renderSessions,
    renderServerCards,
    setUpdateStatus,
  } = deps);
}

// ── Multi-server connection layer (fleet — anvil-multi-server.md §4) ──────────────────────
// One AnvilSocket per server, keyed by base URL. The hub (the daemon that served this page, or the
// native-injected ANVIL_DAEMON_URL) is always server #0; extra servers come from the localStorage
// registry. With a single server this behaves exactly as before. Sessions/environments are tagged
// with the server they arrived from (sessionServer/envServer) so commands and session-scoped REST
// route back to the right daemon. Session ids are globally unique, so inbound event matching by
// `activeId` needs no server disambiguation — only outbound routing does. Sockets connect from
// main.ts, after its outbox state is initialized.
export interface Server {
  url: string; // base, no trailing slash — the stable registry key
  id: string; // serverId once known (server.hello / health); "" until then
  name: string; // display name; the host until hello/health says otherwise
  sock: AnvilSocket;
  status: "connecting" | "connected" | "disconnected";
  version?: string; // anvild version (from server.hello)
  capabilities?: string[]; // feature flags from server.hello; undefined on pre-capability builds
  budget?: Budget; // last budget snapshot (aggregate gauge, §7)
  /** This daemon's fleet position (multi-account §7.2). Undefined on a pre-role build. */
  role?: "hub" | "member" | "standalone";
  /** Set when role === "member": the serverId of the hub that owns this machine's account roster. */
  hubServerId?: string;
}
/** Whether a server advertised support for a capability (e.g. "autopilot"). A pre-capability build
 *  omits the list → treated as unsupported, so we never send it a command it can't handle. */
export const serverSupports = (srv: Server | undefined, cap: string): boolean => !!srv?.capabilities?.includes(cap);
export const cssId = (s: string): string => s.replace(/[^a-z0-9]/gi, "_"); // safe element-id suffix from a URL
export const HUB_URL = daemonBase();
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
// Port-stripped hostname. Fleet members are stored under a bare host ("beelink.ts.net"), but a card's
// url carries the :7701 port — matching the two (e.g. to eject a member on Remove) has to compare the
// hostname alone, or the lookup silently misses and the eject never fires.
export const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/:\d+$/, "");
  }
};
export const servers = new Map<string, Server>(); // keyed by url
export const sessionServer = new Map<string, string>(); // sessionId → server url (outbound routing)
export const envServer = new Map<string, string>(); // environmentId → server url (grouping/routing)
// Autopilot pending plans, tagged by the server they arrived from (anvil-autopilot-ui.md).
export const serverPlans = new Map<string, AutopilotPlanInfo[]>(); // server url → its pending plans
export const serverLoops = new Map<string, LoopSummary[]>(); // server url → its active loops (Loops panel)
// First-class Loop entities + their runs, tagged by the server they live on (loops-circuit spec §4).
export const serverLoopEntities = new Map<string, Loop[]>(); // server url → its persisted loops (loops.list)
export const loopRuns = new Map<string, LoopRun[]>(); // loopId → its run history (loop.runs / loop.run)
export const loopEntityServer = new Map<string, string>(); // loopId → server url (route loop.* sends)
export const planServer = new Map<string, string>(); // workUnitId → server url (route plan.session/dismiss/start)
// Team trees, derived on the daemon and tagged by server (anvil-team-support.md §5). Cached like
// serverPlans so the sidebar rollup + the lead's member board stay live off `team.info`.
export const serverTeams = new Map<string, TeamInfo[]>(); // server url → its teams
export const pendingTeamPlans = new Map<string, TeamPlan>(); // lead sessionId → a plan awaiting approval

// ── Default-chat id namespacing (#158) ───────────────────────────────────────────────────────────
// Every daemon's concierge chat has the SAME hard-coded id (DEFAULT_SESSION_ID in
// src/session/supervisor.ts) — the one session id that is NOT globally unique. The client keys
// sessions/routing by id alone, so in a fleet the hub's and each member's default chats collided
// into one sidebar row whose routing flipped to whichever `session.list` landed last, and a prompt
// could be delivered to the wrong daemon. Rather than re-keying every map by (server, id), the id is
// namespaced AT THIS BOUNDARY: inbound frames from a NON-origin server rewrite "sess_default" →
// "sess_default@<serverId>" (namespaceInbound, applied before main's onEvent ever sees the frame),
// and outbound frames strip it back to the wire id on exactly the socket that owns the session
// (wireOutbound, the AnvilSocket mapOut hook). The origin's own frames pass through untouched, so
// single-server behaviour — including all pre-existing per-session state keyed by the plain id
// (drafts, seq/epoch, cached transcript, deep links) — is bit-for-bit unchanged.
export const DEFAULT_SESSION_ID = "sess_default"; // mirrors the daemon literal; the client never receives it from a non-origin server past this seam
const DEFAULT_NS = `${DEFAULT_SESSION_ID}@`;
export const isNamespacedDefaultId = (id: string): boolean => id.startsWith(DEFAULT_NS);
/** The id a session is known by ON ITS DAEMON — what session-scoped REST paths must embed. */
export const wireSessionId = (id: string): string => (isNamespacedDefaultId(id) ? DEFAULT_SESSION_ID : id);
/** Stable per-server namespace key: the serverId once `server.hello` has identified it (survives a
 *  member's http→https url drift, so the row keeps its identity across reloads), else the url.
 *  hello is the first frame on every connection, so by the time any session frame arrives the
 *  serverId is known. */
const serverKeyOf = (url: string): string => servers.get(url)?.id || url;
const nsId = (url: string, id: string): string => (id === DEFAULT_SESSION_ID ? DEFAULT_NS + serverKeyOf(url) : id);
function nsSession(url: string, s: Session): void {
  s.id = nsId(url, s.id);
  if (s.parentId) s.parentId = nsId(url, s.parentId);
}
/** Rewrite a non-origin server's inbound frame so its default chat carries the namespaced id —
 *  covering every field a session id arrives in: `sessionId` (all session-scoped events),
 *  `session`/`sessions` (created/updated/list), resume `watermarks`, and `teams`. Mutates the
 *  freshly-parsed frame in place (this client owns it). Origin frames return untouched. */
export function namespaceInbound(url: string, e: ServerEvent): ServerEvent {
  if (sameServerUrl(url, HUB_URL)) return e;
  const f = e as ServerEvent & {
    sessionId?: string;
    session?: Session;
    sessions?: Session[];
    watermarks?: { sessionId: string }[];
    teams?: TeamInfo[];
  };
  if (typeof f.sessionId === "string") f.sessionId = nsId(url, f.sessionId);
  if (f.session) nsSession(url, f.session);
  if (Array.isArray(f.sessions)) for (const s of f.sessions) nsSession(url, s);
  if (Array.isArray(f.watermarks)) for (const w of f.watermarks) w.sessionId = nsId(url, w.sessionId);
  if (Array.isArray(f.teams))
    for (const t of f.teams) {
      t.leadId = nsId(url, t.leadId);
      for (const m of t.members) m.sessionId = nsId(url, m.sessionId);
    }
  return e;
}
/** Outbound half: strip the namespace back to the wire id — but ONLY when the id actually routes to
 *  this socket's server. A namespaced id that reached a socket it doesn't route to (e.g. sendTo's
 *  hub fallback after lost routing) stays namespaced, so that daemon answers "no such session"
 *  instead of acting on its OWN default chat — the exact wrong-daemon delivery this seam prevents. */
export function wireOutbound(url: string, cmd: Record<string, unknown> & { type: string }): Record<string, unknown> & { type: string } {
  const sid = cmd.sessionId;
  if (typeof sid === "string" && isNamespacedDefaultId(sid) && sameServerUrl(sessionServer.get(sid), url)) return { ...cmd, sessionId: DEFAULT_SESSION_ID };
  return cmd;
}

(function hydrateRouting() {
  try {
    for (const [k, v] of JSON.parse(localStorage.getItem("anvil.sessionServer") ?? "[]") as [string, string][]) sessionServer.set(k, v);
    for (const [k, v] of JSON.parse(localStorage.getItem("anvil.envServer") ?? "[]") as [string, string][]) envServer.set(k, v);
    // [#158] One-time fixup for pre-namespacing state: the shared plain id could be left routed at
    // whichever fleet server's session.list landed last. Post-fix the plain id ALWAYS means the
    // origin's own default chat — and a stale non-origin route would let that member's next
    // session.list prune the row and wipe the origin concierge's cached transcript/seq/draft.
    // Re-point it; each member's default now arrives under its namespaced id.
    const du = sessionServer.get(DEFAULT_SESSION_ID);
    if (du !== undefined && !sameServerUrl(du, HUB_URL)) sessionServer.set(DEFAULT_SESSION_ID, HUB_URL);
  } catch {
    /* corrupt — repopulated on connect */
  }
})();
export const persistRouting = (): void => {
  try {
    localStorage.setItem("anvil.sessionServer", JSON.stringify([...sessionServer]));
    localStorage.setItem("anvil.envServer", JSON.stringify([...envServer]));
  } catch {
    /* quota */
  }
};
export function loadExtraServers(): string[] {
  try {
    return (JSON.parse(localStorage.getItem("anvil.servers") ?? "[]") as string[]).map((u) => u.replace(/\/+$/, "")).filter((u) => u && u !== HUB_URL);
  } catch {
    return [];
  }
}
function saveExtraServers(urls: string[]): void {
  try {
    localStorage.setItem("anvil.servers", JSON.stringify([...new Set(urls.map((u) => u.replace(/\/+$/, "")).filter((u) => u && u !== HUB_URL))]));
  } catch {
    /* quota */
  }
}
const serverWsUrl = (base: string): string => {
  const ws = base.replace(/^http/i, "ws") + "/ws";
  // An https page CANNOT open a ws:// socket (mixed content → synchronous SecurityError). A fleet
  // member stored with a plain http:// base would derive ws:// and crash; force wss:// to match the
  // page's security context. If that peer doesn't actually serve wss it just fails to connect — which
  // the socket now handles gracefully — instead of taking the whole app down.
  return typeof location !== "undefined" && location.protocol === "https:" ? ws.replace(/^ws:\/\//i, "wss://") : ws;
};
/** When the page is served over https, a plain-http fetch/subresource to a fleet member is blocked by the
 *  browser as active mixed content (silently — uploads/downloads to non-hub sessions just fail). The WS
 *  path already force-upgrades ws→wss for this exact reason (serverWsUrl/wsUrl); mirror it here so a member
 *  stored with an http:// base (tailnet-IP bind, behind `tailscale serve`) is reached over https to match
 *  the page's security context. If that peer doesn't actually serve https it fails to connect — same
 *  tradeoff as the WS upgrade — instead of being silently blocked. http pages are left untouched. */
const securePageUrl = (url: string): string =>
  typeof location !== "undefined" && location.protocol === "https:" ? url.replace(/^http:\/\//i, "https://") : url;
/** Resolve a daemon-relative path against a specific server (session-scoped REST routing). */
export const serverApiUrl = (base: string, path: string): string =>
  securePageUrl(/^https?:\/\//i.test(path) ? path : base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`));
export const serverFetch = (base: string, path: string, init?: RequestInit): Promise<Response> => fetch(serverApiUrl(base, path), init);
export function ensureServer(url: string): Server {
  const clean = url.replace(/\/+$/, "");
  const existing = servers.get(clean);
  if (existing) return existing;
  const sock = new AnvilSocket(
    serverWsUrl(clean),
    (e) => onEvent(clean, namespaceInbound(clean, e)), // [#158] a member's "sess_default" never reaches app state un-namespaced
    (st) => onStatus(clean, st),
    (cmd) => wireOutbound(clean, cmd), // [#158] …and the namespaced id never reaches the wire
  );
  const s: Server = { url: clean, id: "", name: hostOf(clean), sock, status: "disconnected" };
  servers.set(clean, s);
  sock.connect();
  return s;
}
/** Forget a server: close its socket and drop its sessions/environments from the merged view. */
function removeServer(url: string): void {
  if (url === HUB_URL) return; // the hub is implicit and can't be removed
  const s = servers.get(url);
  if (!s) return;
  s.sock.close();
  servers.delete(url);
  for (const [sid, u] of [...sessionServer]) if (u === url) { sessionServer.delete(sid); sessions.delete(sid); }
  for (const [eid, u] of [...envServer]) if (u === url) { envServer.delete(eid); environments.delete(eid); }
  serverPlans.delete(url);
  serverLoops.delete(url);
  for (const l of serverLoopEntities.get(url) ?? []) {
    loopRuns.delete(l.id);
    loopEntityServer.delete(l.id);
  }
  serverLoopEntities.delete(url);
  serverTeams.delete(url);
  for (const [pid, u] of [...planServer]) if (u === url) planServer.delete(pid);
  // Drop the removed server's autopilot state too, else a lingering `running: true` keeps the fleet-wide
  // spinner spinning for a server that no longer exists (and the user's "remove it" never clears it).
  clearStaleRunTimer(url);
  deleteServerSchedule(url);
  reflectAutopilotRunning();
  updateAutopilotBadge();
  saveExtraServers([...servers.keys()].filter((u) => u !== HUB_URL));
  persistSessions();
  persistEnvironments();
  persistRouting();
  renderSessions();
  if (document.getElementById("server-cards")) renderServerCards(); // drop the card from an open Settings view
}
export const hub = (): Server => servers.get(HUB_URL)!;
/**
 * The server that OWNS the Claude account roster — where every `auth.account*` write must go
 * (multi-account §7.2). Deliberately a NEW notion rather than a redefinition of `hub()`/`HUB_URL`,
 * which keep meaning "the origin this page was served from", so nothing that legitimately means
 * "the origin" changes behaviour.
 *
 * Resolution order: the connected server whose `serverId` matches this machine's paired hub (the
 * origin is a member and we've also adopted its hub) → the connected server that reports
 * `role: "hub"` → the origin. The last case covers a standalone daemon AND a member whose hub isn't
 * adopted yet: writes go to the origin and its own replica refuses them with "change accounts on the
 * hub", which is the honest answer until Task 27's adopt-your-hub card is taken up.
 */
export function rosterServer(): Server {
  const origin = hub();
  const pairedHubId = origin?.hubServerId;
  if (pairedHubId) {
    for (const s of servers.values()) if (s.id === pairedHubId) return s;
  }
  for (const s of servers.values()) if (s.role === "hub") return s;
  return origin;
}
/** Resolve a routing url to its live socket. The `servers` map is keyed by the url a server was
 *  adopted under, but a session/env's stored routing url can DRIFT from it (a member reconnects under
 *  a force-upgraded https:// while its rows were tagged http://, or a trailing-slash difference) — see
 *  {@link sameServerUrl}. An exact miss then silently routed to the hub, which doesn't own the session
 *  and answers "no such session": the conversation stays blank on the client that didn't create it.
 *  Fall back to a scheme-insensitive match so a drifted url still finds the connected owner. */
export function serverByUrl(u: string | undefined): Server | undefined {
  if (!u) return undefined;
  const exact = servers.get(u);
  if (exact) return exact;
  for (const s of servers.values()) if (sameServerUrl(u, s.url)) return s;
  return undefined;
}
export function serverOf(sessionId: string | null | undefined): Server | undefined {
  if (!sessionId) return undefined;
  return serverByUrl(sessionServer.get(sessionId));
}
/** The server an environment lives on (its repos are local to that daemon). */
export function serverOfEnv(envId: string | null | undefined): Server {
  return serverByUrl(envId ? envServer.get(envId) : undefined) ?? hub();
}
/** Route a session-scoped command to the daemon that owns the session (falls back to the hub). */
export function sendTo(sessionId: string | null | undefined, cmd: Record<string, unknown> & { type: string }): boolean {
  return (serverOf(sessionId) ?? hub()).sock.send(cmd);
}
/**
 * Make sure the daemon that owns `sessionId` is in the registry AND has a live socket, so opening
 * one of its sessions actually delivers history. A member session can be tagged to a server the
 * client knows from routing (persisted `sessionServer`) but never adopted this page-load — e.g. the
 * fleet-member fetch hadn't landed yet, or its socket dropped. Without this, `sendTo` falls back to
 * the hub, which doesn't own the session and answers "no such session" → a silently blank chat that
 * only self-heals if that member happens to reconnect on its own. Adopt + force-reconnect so the
 * `session.list` re-attach (in the `session.list` handler) can fire. No-op for hub sessions. */
export function ensureOwningServer(sessionId: string): void {
  const url = sessionServer.get(sessionId);
  if (!url) return; // owner unknown (optimistic local / not yet listed) — nothing to reconnect
  const srv = serverByUrl(url) ?? ensureServer(url);
  if (!srv.sock.isOpen()) srv.sock.connectNow();
}
export const anyOpen = (): boolean => {
  for (const s of servers.values()) if (s.sock.isOpen()) return true;
  return false;
};
/** Hub first, then extra servers in registry order — the sidebar/grouping order. */
export function orderedServers(): Server[] {
  const h = servers.get(HUB_URL);
  const out: Server[] = h ? [h] : []; // empty only during early-init before the hub socket is created
  for (const u of loadExtraServers()) {
    const s = servers.get(u);
    if (s) out.push(s);
  }
  return out;
}

// ── Fleet administration (manage from any client — anvil-server-app.md §6) ──────────────────────
// All calls hit the HUB daemon (apiFetch); it distributes its own OAuth token and never returns it.
interface FleetMember { serverId: string; serverName: string; host: string; url: string; accountsRev?: number }
// host → serverId for every Mac the hub knows as a fleet member. Lets a server card's "Remove" also
// eject that Mac from the fleet (the old separate "Forget" action), so there's one button, not two.
export const fleetMemberIdByHost = new Map<string, string>();
/** Each member's last-confirmed account-roster `rev`, by serverId (multi-account §7.3). Absent ⇒ the
 *  hub has never confirmed a roster push to it — either it predates the "accounts" capability, or
 *  every push so far failed. Populated by {@link loadFleetMembers} from the hub's /api/fleet/members. */
export const fleetMemberAccountsRev = new Map<string, number | undefined>();

/**
 * [BE2-15] Await an async fleet job (rotate/invite). The POST answers immediately with a jobId — the
 * fan-out runs as a daemon-side job (an offline member used to pin the request open for ~14s of
 * pairing timeouts) — and completion is read by polling GET /api/fleet/jobs/<id>. Resolves with the
 * job's result: the exact body the old synchronous POST returned. A transient poll failure is retried
 * until the deadline; an unknown id (the daemon restarted mid-job) or a timeout rejects.
 */
async function awaitFleetJob<R>(jobId: string, timeoutMs = 120_000): Promise<R> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1_000));
    let st: rest.FleetJobStatusResponse | null = null;
    try {
      st = (await (await apiFetch(`/api/fleet/jobs/${encodeURIComponent(jobId)}`)).json()) as rest.FleetJobStatusResponse;
    } catch {
      /* network blip — keep polling until the deadline */
    }
    if (st && !st.ok) throw new Error(st.error ?? "the daemon no longer knows this job");
    if (st?.state === "done") return st.result as R;
    if (Date.now() >= deadline) throw new Error("timed out waiting for the fleet operation");
  }
}

/** Push the current login to every Mac in the fleet (hub fans it out). Header "Update token" button. */
export async function rotateFleetToken(): Promise<void> {
  // /api/fleet/rotate fans out from THIS daemon to ITS members. On a machine that has none — a member,
  // or a standalone box — it succeeds over an empty list and used to report "Updated 0/0 Macs.", which
  // reads as "done" when in fact nothing was even attempted (§7.2). Say what actually happened.
  const origin = hub();
  if (origin?.role === "member") {
    toast("This Mac isn't the hub — sync accounts from the hub instead.");
    return;
  }
  toast("Pushing the current login to every Mac…");
  // [BE2-15] ?async=1 → the POST answers immediately with a jobId and the fan-out runs daemon-side;
  // we poll for the same {ok,results} the synchronous route used to return. A pre-job daemon ignores
  // the query and answers the legacy shape directly (no jobId) — use it as-is.
  let started: rest.FleetJobStartResponse & rest.FleetRotateResponse;
  try {
    started = (await (await apiFetch("/api/fleet/rotate?async=1", { method: "POST" })).json()) as typeof started;
  } catch {
    // Reaching here means the HUB itself didn't answer — an unreachable MEMBER is a per-result
    // failure below, not an exception, so this message must not be used for that case.
    toast("Couldn't reach this machine's own daemon to start the sync.");
    return;
  }
  try {
    const r = started.jobId ? await awaitFleetJob<rest.FleetRotateResponse>(started.jobId) : started;
    if (r.results.length === 0) {
      toast(r.error ? `Couldn't sync: ${r.error}` : "No other Macs in this fleet yet.");
      return;
    }
    const okN = r.results.filter((x) => x.ok).length;
    // Name who failed. "Updated 0/1 Macs." is technically true but useless when the answer is always
    // "that one Mac is switched off" — and the old catch-all below blamed the HUB for it.
    if (okN < r.results.length) {
      const failed = r.results.filter((x) => !x.ok).map((x) => x.host);
      toast(`Updated ${okN}/${r.results.length} Macs — couldn't reach ${failed.join(", ")}. It'll sync when it's back.`);
    } else {
      toast(`Updated ${okN}/${r.results.length} Macs.`);
    }
    void loadFleetMembers(); // re-read each member's accountsRev so the per-card sync badges refresh
  } catch {
    // The job was started but its outcome couldn't be read (poll timeout / daemon restarted mid-job).
    toast("Lost track of the sync — check the Servers tab for each Mac's status and try again.");
  }
}

// ── Fleet update (pinned rollout) ────────────────────────────────────────────
// One pinned build fans out to every member first, then this hub updates itself last. All calls hit
// the HUB daemon (apiFetch). Progress is polled from /api/fleet/update/status until the rollout ends.
let fleetRolloutPoll: ReturnType<typeof setInterval> | null = null;

/** Re-hydrate an in-flight rollout into a freshly rendered #fleet-rollout-status container (called by
 *  main's renderServerCards — the poller state is private to this module). No-op with no active poll. */
export function rehydrateFleetRollout(): void {
  if (fleetRolloutPoll !== null) void pollFleetRolloutOnce();
}

/** Human labels + presentation class for each member rollout state (protocol `rest.FleetRolloutMemberState`). */
function rolloutStateLabel(state: rest.FleetRolloutMemberState): string {
  switch (state) {
    case "pending":
      return "pending";
    case "pending-offline":
      return "offline — will reconcile";
    case "legacy":
      return "updating (legacy)";
    case "updating":
      return "updating…";
    case "healthy":
      return "healthy";
    case "rolled-back":
      return "rolled back";
    case "error":
      return "error";
    default:
      return String(state);
  }
}

/** Render one rollout status snapshot into #fleet-rollout-status. `rolled-back` is called out as a warning. */
function renderRolloutStatus(status: rest.FleetUpdateStatusResponse): void {
  const host = document.getElementById("fleet-rollout-status");
  if (!host) return;
  const shortSha = status.targetSha ? esc(status.targetSha.slice(0, 8)) : "(pending)";
  const rows = status.members
    .map((m) => {
      const rolledBack = m.state === "rolled-back";
      const healthy = m.state === "healthy";
      const failed = m.state === "error";
      const dotIcon = rolledBack || failed ? icon("warning") : healthy ? icon("check") : icon("sync");
      const rowClass = rolledBack || failed ? " warn-text" : "";
      const hubTag = m.isHub ? ` <span class="small muted">(this hub — last)</span>` : "";
      const detail = m.detail ? ` <span class="small muted">— ${esc(m.detail)}</span>` : "";
      return `<div class="git-row${rowClass}" style="gap:6px;align-items:center">${dotIcon}<b>${esc(m.serverName)}</b>${hubTag} <span class="small">${esc(rolloutStateLabel(m.state))}</span>${detail}</div>`;
    })
    .join("");
  let footer = "";
  if (!status.active) {
    const healthyN = status.members.filter((m) => m.state === "healthy").length;
    const rolledN = status.members.filter((m) => m.state === "rolled-back").length;
    footer = `<div class="small muted" style="margin-top:6px">Fleet update complete — ${healthyN} healthy, ${rolledN} rolled back.</div>`;
  }
  host.innerHTML = `<div class="card" style="margin-bottom:10px">
    <div class="card-main">${icon("system_update_alt")} <b>Fleet update</b> <span class="small muted">→ <code>${shortSha}</code></span></div>
    ${rows}
    ${footer}
  </div>`;
}

/** One poll tick: read the rollout status, render it, and stop the poller once the rollout is no longer active. */
async function pollFleetRolloutOnce(): Promise<void> {
  try {
    const status = (await (await apiFetch("/api/fleet/update/status")).json()) as rest.FleetUpdateStatusResponse;
    renderRolloutStatus(status);
    if (!status.active && fleetRolloutPoll !== null) {
      clearInterval(fleetRolloutPoll);
      fleetRolloutPoll = null;
    }
  } catch {
    // Transient hub hiccup — keep the interval alive; the next tick retries.
  }
}

/** Kick off a pinned fleet rollout (members first, this hub last), then poll progress until it ends. */
export async function startFleetUpdate(): Promise<void> {
  const origin = hub();
  if (origin?.role === "member") {
    toast("This Mac isn't the hub — start a fleet update from the hub instead.");
    return;
  }
  if (!confirm("Update every machine in the fleet to one pinned build? Members update first, then this hub last.")) return;
  toast("Starting fleet update…");
  try {
    const r = (await (await apiFetch("/api/fleet/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })).json()) as rest.FleetUpdateResponse;
    if (!r.ok) {
      toast(`Couldn't start the fleet update${r.error ? ` — ${r.error}` : ""}.`);
      return;
    }
    // Paint the initial snapshot immediately, then poll for progress. Guard against overlapping pollers.
    renderRolloutStatus({ ok: true, active: true, targetSha: r.targetSha, members: r.members });
    if (fleetRolloutPoll !== null) clearInterval(fleetRolloutPoll);
    fleetRolloutPoll = setInterval(() => void pollFleetRolloutOnce(), 2000);
  } catch {
    toast("Couldn't reach this machine's own daemon to start the fleet update.");
  }
}

/** The "+ Add a machine" dialog: invite by join code (primary), or adopt a server that's already
 *  running. Not "Add a Mac" any more — a Linux/headless daemon receives the credential on its own
 *  :7701 API, so the joiner no longer has to be a Mac (anvil-headless-join.md). */
export function showAddMac(): void {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>${icon("add")} Add a machine</h3>
    <p class="small muted">On the machine you're adding, open its Anvil web UI (a Mac can also use <b>Anvil Server → Join a fleet</b>) and choose <b>Join a fleet</b> for a 6-digit code. Pick it here and enter the code — no IP to track down. It'll share this server's Claude login.</p>
    <label>Machine<div class="env-row"><select id="fleet-host"><option value="">Scanning your tailnet…</option></select></div></label>
    <label>Join code<input id="fleet-code" type="tel" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="6-digit code" /></label>
    <div id="fleet-status" class="small muted"></div>
    <div class="btns"><button type="button" id="am-close">Done</button><button type="button" id="fleet-invite" class="primary">${icon("add")} Add</button></div>
  </div>`;
  showModal(m);
  enhanceSelect(document.getElementById("fleet-host") as HTMLSelectElement | null);
  void loadFleetPeers();
  const setStatus = (t: string): void => { const el = document.getElementById("fleet-status"); if (el) el.textContent = t; };
  // The joiner shows the code grouped as "123 456" for readability, so a copy-paste arrives with a
  // space (and pasting into a maxlength=6 field used to truncate it to "123 45"). Strip everything but
  // digits on every input and cap at 6, so a pasted grouped code Just Works.
  const codeInput = document.getElementById("fleet-code") as HTMLInputElement | null;
  codeInput?.addEventListener("input", () => { codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6); });
  $<HTMLButtonElement>("#am-close").onclick = () => closeModal(); // returns to Settings underneath
  document.getElementById("fleet-invite")?.addEventListener("click", async () => {
    const host = ($<HTMLSelectElement>("#fleet-host").value || "").trim();
    const code = ($<HTMLInputElement>("#fleet-code").value || "").replace(/\D/g, "");
    if (!host) { setStatus("Pick the machine you're adding."); return; }
    if (!/^\d{6}$/.test(code)) { setStatus("Enter the 6-digit code that machine is showing."); return; }
    setStatus(`Sending the login to ${host} over the tailnet…`);
    // [BE2-15] ?async=1 → the POST answers immediately with a jobId (the pairing push runs as a
    // daemon-side job); poll for the same {ok,member,error} the synchronous route used to return.
    // A pre-job daemon ignores the query and answers the legacy shape directly (no jobId).
    let started: rest.FleetJobStartResponse & rest.FleetInviteResponse;
    try {
      started = (await (await apiFetch("/api/fleet/invite?async=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host, code }) })).json()) as typeof started;
    } catch {
      setStatus("Couldn't reach the hub daemon.");
      return;
    }
    try {
      const r = started.jobId ? await awaitFleetJob<rest.FleetInviteResponse>(started.jobId) : started;
      if (r.ok) {
        // Onboarded → also connect this client to it so its sessions show up (one step, not two).
        if (r.member?.url) { saveExtraServers([...loadExtraServers(), r.member.url]); ensureServer(r.member.url); }
        $<HTMLInputElement>("#fleet-code").value = "";
        setStatus(`✅ ${host} joined the fleet.`);
        void loadFleetPeers();
        renderServerCards();
      } else {
        setStatus(`Rejected: ${r.error ?? "unknown"}. Make sure that machine's “Join a fleet” screen is still open and showing a code.`);
      }
    } catch { setStatus("Couldn't reach the hub daemon."); }
  });
}

/**
 * Append a "this machine" card offering a fresh join code — but ONLY when this machine is already in a
 * fleet. The tokenless setup takeover (setup.ts) is the usual place to get a code, but it renders only
 * while a machine has NO login; once it's joined (has a login) the takeover never shows, leaving no
 * in-UI way to re-open a pairing window if the hub later loses the member. This is that missing entry
 * point. Gated on the LOCAL daemon's arm-state carrying `hubServerId` — present only for a machine
 * paired to a hub, so it never appears on the hub itself or on an unpaired standalone box.
 */
export async function maybeRenderRepairCard(host: HTMLElement): Promise<void> {
  let st: { hubServerId?: string };
  try {
    st = (await (await apiFetch("/api/fleet/arm")).json()) as { hubServerId?: string };
  } catch {
    return; // daemon unreachable — nothing to offer
  }
  if (!st.hubServerId) return; // not joined to a hub → no re-pair to offer (the hub, or a standalone box)
  // Idempotent append: renderServerCards can be in flight several times at once (adoption, server.hello),
  // and this runs AFTER its own await — so without removing a prior copy each in-flight render stacks
  // another card. Drop any existing one before inserting so there's exactly one, no matter the render count.
  document.getElementById("fleet-repair-card")?.remove();
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="card" id="fleet-repair-card"><div class="card-main">${icon("hub")} <b>This machine</b></div>
      <div class="small muted">Already in a fleet. If the hub lost track of it, open a join window here and re-enter the code on the hub's <b>Add a machine</b>.</div>
      <div class="git-row" style="margin-top:10px"><button class="mini" id="fleet-repair">${icon("vpn_key")} Get a join code</button></div>
    </div>`,
  );
  document.getElementById("fleet-repair")?.addEventListener("click", () => showRepairDialog());
}

/**
 * When the ORIGIN is a fleet member whose hub this client hasn't adopted, the account roster is
 * read-only here and every write bounces with "change accounts on the hub" (§7.2). That's correct but
 * unhelpful on its own, so offer the fix: connect this client to the hub as well, and the Models tab
 * starts routing writes there (see {@link rosterServer}).
 *
 * Synchronous and idempotent — `renderServerCards` can run several times concurrently, so drop any
 * prior copy first, exactly as `maybeRenderRepairCard` does.
 */
export function maybeRenderAdoptHubCard(host: HTMLElement): void {
  document.getElementById("fleet-adopt-hub-card")?.remove();
  const origin = hub();
  const hubId = origin?.hubServerId;
  if (!hubId) return; // the origin is a hub or standalone — nothing to adopt
  for (const s of servers.values()) if (s.id === hubId) return; // already connected to it
  // We only have the hub's serverId: a member is told which hub owns it (PairedHubStore), but nothing
  // a MEMBER serves carries that hub's display name or address — only the hub knows its members, not
  // the reverse. So the card names the fleet by id and the dialog asks for the URL.
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="card" id="fleet-adopt-hub-card"><div class="card-main">${icon("hub")} <b>This Mac is part of another Mac's fleet</b></div>
      <div class="small muted">Its Claude accounts are managed on the hub (<code>${esc(hubId)}</code>), so they're read-only here. Add the hub to manage them from this device.</div>
      <div class="git-row" style="margin-top:10px"><button class="mini" id="fleet-adopt-hub">${icon("add")} Add the hub</button></div>
    </div>`,
  );
  document.getElementById("fleet-adopt-hub")?.addEventListener("click", () => showAdoptHubDialog());
}

/** Prompt for the hub's URL and adopt it as another server, exactly as `showAddMac` does for a peer.
 *  We can't discover it automatically: the hub's address isn't in anything a MEMBER serves — only the
 *  hub knows its own members, not the other way round. */
function showAdoptHubDialog(): void {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>${icon("hub")} Add this fleet's hub</h3>
    <p class="small muted">Enter the hub's Anvil address on your tailnet (e.g. <code>https://mac-mini.tailnet.ts.net:7701</code>). Once it's connected, its Claude accounts become manageable from this device.</p>
    <label>Hub URL<input id="adopt-hub-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://host:7701" /></label>
    <div id="adopt-hub-status" class="small muted"></div>
    <div class="btns"><button type="button" id="adopt-hub-cancel">Cancel</button><button type="button" id="adopt-hub-ok" class="primary">Add</button></div>
  </div>`;
  showModal(m);
  $<HTMLButtonElement>("#adopt-hub-cancel").onclick = () => closeModal();
  const input = document.getElementById("adopt-hub-url") as HTMLInputElement | null;
  input?.focus();
  $<HTMLButtonElement>("#adopt-hub-ok").addEventListener("click", () => {
    const raw = (input?.value ?? "").trim().replace(/\/+$/, "");
    const status = document.getElementById("adopt-hub-status");
    if (!raw) {
      if (status) status.textContent = "Enter the hub's URL.";
      return;
    }
    try {
      new URL(raw);
    } catch {
      if (status) status.textContent = "That doesn't look like a URL.";
      return;
    }
    saveExtraServers([...loadExtraServers(), raw]);
    ensureServer(raw);
    closeModal();
    renderServerCards();
    toast("Connecting to the hub…");
  });
}

/** The "Get a join code" modal for THIS machine (Settings → Fleet). Arms the local daemon — apiFetch
 *  targets the page's own daemon — and shows a code to enter on the hub's "Add a machine". The
 *  standard-UI counterpart to the tokenless takeover's "Join a fleet", for an already-set-up machine. */
function showRepairDialog(): void {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>${icon("hub")} Re-pair this machine</h3>
    <p class="small muted">Opens a join window on <b>this</b> machine. On the hub, open <b>Settings → Fleet → Add a machine</b>, pick this machine, and enter the code below — it re-shares the hub's Claude login with this machine.</p>
    <div id="repair-panel"></div>
  </div>`;
  showModal(m);
  const p = document.getElementById("repair-panel");
  if (p) void armJoinWindow(p, { onCancel: () => closeModal() });
}

/** Click handler for a server card's "Remove": dim the card, eject it from the fleet (if it's a member),
 *  then drop it locally and re-render. "Remove" now does what "Forget" used to — one action, not two. */
export async function confirmRemoveServer(srv: Server): Promise<void> {
  if (srv.url === HUB_URL) return;
  const ok = await confirmDialog({
    icon: "close",
    title: `Remove “${srv.name}”?`,
    body: "Stops using this Mac from this device and ejects it from the fleet, so it no longer shares this server's Claude login. You can add it back later with a join code.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
  const card = document.getElementById(`srv-card-${cssId(srv.url)}`);
  const btn = document.getElementById(`srv-remove-${cssId(srv.url)}`) as HTMLButtonElement | null;
  card?.classList.add("removing"); // dim + ignore further clicks until this resolves
  if (btn) { btn.disabled = true; btn.innerHTML = `${icon("progress_activity")} Removing…`; btn.querySelector(".msym")?.classList.add("spin"); }
  // If the hub tracks this Mac as a fleet member, ejecting it there stops it sharing the login. Match
  // by port-stripped hostname; fall back to the card's own serverId when it's a known member (covers a
  // MagicDNS-off member whose card was adopted under a raw IP that doesn't equal its stored `host`).
  const memberId =
    fleetMemberIdByHost.get(hostnameOf(srv.url)) ??
    (srv.id && new Set(fleetMemberIdByHost.values()).has(srv.id) ? srv.id : undefined);
  if (memberId) {
    try {
      await apiFetch(`/api/fleet/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
      for (const [k, v] of [...fleetMemberIdByHost]) if (v === memberId) fleetMemberIdByHost.delete(k);
    } catch {
      card?.classList.remove("removing");
      if (btn) { btn.disabled = false; btn.innerHTML = `${icon("close")} Remove`; }
      toast("Couldn't remove that Mac from the fleet — is the hub reachable?");
      return;
    }
  }
  removeServer(srv.url); // local teardown — re-renders the (now shorter) card list
}
/** Fetch the hub's fleet members: cache host→serverId for Remove, and adopt any member this device
 *  isn't connected to yet so the one card list is the whole fleet, not just this device's history. */
export async function loadFleetMembers(): Promise<void> {
  try {
    const { members } = (await (await apiFetch("/api/fleet/members")).json()) as { members: FleetMember[] };
    fleetMemberIdByHost.clear();
    const revsBefore = JSON.stringify([...fleetMemberAccountsRev]);
    fleetMemberAccountsRev.clear();
    let adopted = false;
    for (const m of members) {
      fleetMemberAccountsRev.set(m.serverId, m.accountsRev);
      // Index under the bare host AND the url's hostname: with MagicDNS off the url can be healed to a
      // raw tailnet IP while `host` stays the (now-unresolvable) name, so a card adopted under either
      // form still maps back to the member for Remove.
      if (m.host) fleetMemberIdByHost.set(hostnameOf(m.host), m.serverId);
      fleetMemberIdByHost.set(hostnameOf(m.url), m.serverId);
      const url = m.url.replace(/\/+$/, "");
      if (!url || url === HUB_URL) continue;
      // The hub can heal a member's scheme (http→https once `tailscale serve` is up). If we'd adopted it
      // under the old scheme, drop that stale entry (same host, different url) so it doesn't linger as a
      // dead, perpetually-disconnected duplicate next to the healthy one.
      for (const existing of [...servers.keys()]) {
        if (existing !== url && existing !== HUB_URL && hostOf(existing) === hostOf(url)) removeServer(existing);
      }
      if (!servers.has(url)) {
        saveExtraServers([...loadExtraServers(), url]);
        ensureServer(url);
        adopted = true;
      }
    }
    // Re-render on a NEW member (adopted) or when any member's roster rev moved — the per-card sync
    // badge is derived from those revs, so without this it stays stale until the next unrelated render.
    const revsChanged = revsBefore !== JSON.stringify([...fleetMemberAccountsRev]);
    if ((adopted || revsChanged) && document.getElementById("server-cards")) renderServerCards();
  } catch {
    /* hub unreachable — cards still render from the locally-known servers */
  }
}
/**
 * Fill the "Add a machine" dropdown from the hub's tailnet peers — so you pick a name, not an IP.
 *
 * Peers come from `/api/fleet/peers` (every tailnet node), and discovery (`/api/fleet/discover`, which
 * probes each peer's `/api/health`) tells us which of them are Anvil daemons *without a Claude login* —
 * exactly the machines someone is here to add. Those are labelled **"needs setup"** (HJ-9). We use the
 * honest `subscriptionAuthOk` rather than a separate "pairable" advertisement, so there is only one
 * signal and it can't disagree with itself; arm-state is deliberately never on the wire.
 */
async function loadFleetPeers(): Promise<void> {
  const sel = document.getElementById("fleet-host") as HTMLSelectElement | null;
  if (!sel) return;
  try {
    const [peersRes, discovered] = await Promise.all([
      apiFetch("/api/fleet/peers").then((r) => r.json()) as Promise<{ ok: boolean; peers: { name: string; host: string; online: boolean }[]; warning?: string }>,
      // Discovery is best-effort garnish: without it every candidate simply shows unlabelled.
      apiFetch("/api/fleet/discover")
        .then((r) => r.json())
        .catch(() => ({ servers: [] })) as Promise<{ servers?: { url: string; subscriptionAuthOk?: boolean }[] }>,
    ]);
    // Compare on the bare hostname (no port). The peer list's `host` is a MagicDNS name with no port,
    // but hostOf()/URL.host carries the :7701 — so matching on hostOf here silently never fires, and
    // neither "needs setup" nor the already-added filter would work. Strip the port on both sides.
    const hostname = (u: string): string => { try { return new URL(u).hostname; } catch { return hostOf(u).replace(/:\d+$/, ""); } };
    const needsSetup = new Set(
      (discovered.servers ?? []).filter((s) => s.subscriptionAuthOk === false).map((s) => hostname(s.url)),
    );
    const knownHosts = new Set([...servers.values()].map((s) => hostname(s.url)));
    const candidates = (peersRes.peers ?? []).filter((p) => p.online && !knownHosts.has(p.host));
    if (!peersRes.ok) {
      sel.innerHTML = `<option value="">${esc(peersRes.warning ?? "Tailscale unavailable")}</option>`;
    } else if (!candidates.length) {
      sel.innerHTML = `<option value="">No other machines found on your tailnet</option>`;
    } else {
      // Machines waiting for a login sort first — that's who the operator came here for.
      candidates.sort((a, b) => Number(needsSetup.has(b.host)) - Number(needsSetup.has(a.host)));
      sel.innerHTML =
        `<option value="">Select a machine…</option>` +
        candidates
          .map((p) => `<option value="${esc(p.host)}" data-icon="computer">${esc(p.name)}${needsSetup.has(p.host) ? " — needs setup" : ""}</option>`)
          .join("");
    }
  } catch {
    sel.innerHTML = `<option value="">Couldn't scan the tailnet</option>`;
  }
  refreshSelect(sel); // re-read the freshly-populated options into the Tom Select instance
}
/** Wire one server card's "Update Anvil" button: pull that daemon's source, rebuild, and restart it.
 *  Each Mac self-updates independently — the hub no longer has a monopoly on updates. Only a hub
 *  restart reloads this page (it's serving the bundle); a remote restart just reconnects in the list. */
export function wireDaemonUpdate(srv: Server): void {
  const id = cssId(srv.url);
  const isHub = srv.url === HUB_URL;
  const btn = document.getElementById(`daemon-update-${id}`) as HTMLButtonElement | null;
  const out = document.getElementById(`daemon-update-output-${id}`);
  if (!btn || !out) return;
  const spin = (label: string): void => {
    btn.innerHTML = `${icon("progress_activity")} ${label}`;
    btn.querySelector(".msym")?.classList.add("spin");
  };
  const reset = (): void => {
    btn.disabled = false;
    btn.innerHTML = `${icon("refresh")} Update Anvil`;
  };
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    spin("Checking for updates…");
    out.hidden = false;
    out.textContent = "Fetching the latest source and rebuilding — this can take a minute…";
    try {
      // Issue #162: the update rides version-independent REST, NOT the versioned WS channel. A
      // version-skewed daemon rejects every WS command frame — including the very `daemon.update`
      // that would repair the skew (the bootstrap paradox). POST /api/daemon/update is identity-
      // gated but carries no protocol version, so this button works exactly when it's needed most.
      // Native clients keep the `daemon.update` WS command; only this button switched transport.
      const resp = await serverFetch(srv.url, "/api/daemon/update", {
        method: "POST",
        signal: AbortSignal.timeout(180_000),
      });
      let res: rest.DaemonUpdateResponse;
      try {
        res = (await resp.json()) as rest.DaemonUpdateResponse;
      } catch {
        throw new Error(`HTTP ${resp.status}`); // non-JSON body (proxy error page etc.)
      }
      out.textContent = res.output;
      if (res.phase === "up-to-date") {
        toast(`${esc(srv.name)} is already up to date (v${res.currentVersion}).`);
        reset();
      } else if (res.phase === "error") {
        toast("Update failed — see Settings.");
        reset();
      } else if (res.willRestart && isHub) {
        // The hub serves THIS page, so when it restarts we reload to pick up the new bundle. Keep the
        // button spinning and let onStatus reload once the WS reconnects. Safety net if it never returns.
        toast("Anvil updated — restarting…");
        ui.pendingRestartReload = true;
        spin("Restarting…");
        setUpdateStatus(`${res.output}\n\nUpdate applied. Restarting the daemon — the app will reload automatically when it's back.`);
        setTimeout(() => {
          if (!ui.pendingRestartReload) return;
          ui.pendingRestartReload = false;
          setUpdateStatus("Still restarting — reload the app manually in a moment to pick up the update.");
          reset();
        }, 90_000);
      } else if (res.willRestart) {
        // A remote Mac restarts on its own; nothing to reload here — it just reconnects in the list.
        toast(`${esc(srv.name)} updated — restarting it…`);
        out.textContent = `${res.output}\n\nUpdate applied. ${srv.name} is restarting — it'll reconnect in the list shortly.`;
        reset();
      } else {
        // updated but that daemon isn't service-managed, so it won't self-restart
        toast(`${esc(srv.name)} updated — restart it to apply.`);
        reset();
      }
    } catch (e) {
      out.textContent = `Update failed: ${e instanceof Error ? e.message : String(e)}`;
      reset();
    }
  });
}
