import MarkdownIt from "markdown-it";
import Sortable from "sortablejs";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AnvilSocket } from "./ws";
import { apiFetch, daemonBase, sameServerUrl } from "./api";
import { $, byEnvName, destroyModalSelects, enhanceSelect, envIcon, esc, icon, linkifyUrls, refreshSelect, sessIcon, slugify } from "./dom";
import { currentTheme, resolveTheme, themePref, updateThemeControls } from "./theme";
import type { ThemePref } from "./theme";
import { ui } from "./state";
import {
  dismissOverlay,
  dismissTopOverlay,
  autopilotFromHash,
  openOverlay,
  overlayOpen,
  overlays,
  planFromHash,
  sessionFromHash,
  sessionHref,
  setSessionHash,
} from "./overlays";
import { initPush, isAndroidApp, nativeBridge } from "./push";
import { applySidebar, collapseSidebarForChat, initResizers, isNarrow, toggleSidebar } from "./layout";

const strToB64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
};
import { MODELS, modelLabel } from "../../protocol";
import type {
  AttachmentRef,
  AuthStatusEvent,
  AutopilotPlanInfo,
  PipelineTraceInfo,
  PipelineAdversaryStat,
  AutopilotSchedule,
  AutonomyPolicy,
  Budget,
  CommandInfo,
  ContentBlock,
  ConversationEvent,
  DirEntry,
  DirsListResultEvent,
  Environment,
  FileContent,
  FileOffer,
  GitResultEvent,
  GitStatus,
  PermissionSuggestion,
  Prompt,
  Question,
  QuestionAnswer,
  ServerEvent,
  Session,
  TeamInfo,
  TeamPlan,
  TodoistProjectInfo,
} from "../../protocol";
import { PALETTE, envOrdinal, sessionBg, stripeColor } from "./sessionColor";
import { OutboxQueue, newCid, type OutboxItem } from "./outbox";

// App version, replaced at build time (native: the APK versionName; PWA: package.json version).
declare const __APP_VERSION__: string;

// Show the build version next to the brand so it's obvious which app/bundle is running.
$("#brand-version").textContent = `v${__APP_VERSION__}`;

const conversation = $("#conversation");
// Scroll lock: only auto-follow new content when the user is already at the bottom.
let stickToBottom = true;
const scrollDown = (force = false): void => {
  if (force) stickToBottom = true;
  if (stickToBottom) conversation.scrollTop = conversation.scrollHeight;
};
conversation.addEventListener("scroll", () => {
  const dist = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
  stickToBottom = dist < 60; // within 60px of the bottom counts as "following"
  const btn = document.getElementById("scroll-bottom");
  if (btn) (btn as HTMLElement).hidden = stickToBottom;
});

// ── State ────────────────────────────────────────────────────────────────────
export const sessions = new Map<string, Session>();
const environments = new Map<string, Environment>();
// The user's saved prompt library (hub-authoritative; see the Prompt library section below). Seeded
// from a localStorage cache so the header paints instantly on load, then overwritten by the hub's
// `prompts` broadcast. Declared HERE — before the instant-restore refreshPromptsButton() call — so it's
// out of the temporal dead zone by then (web-early-init-decl-order-crash).
const PROMPTS_CACHE_KEY = "anvil.prompts.cache";
let prompts: Prompt[] = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(PROMPTS_CACHE_KEY) ?? "[]") as Prompt[];
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.id === "string") : [];
  } catch {
    return [];
  }
})();
// Sessions being cleaned up: shown disabled in the sidebar until the daemon confirms deletion
// (session.deleted). Transient — not persisted. (UI refinement §8)
const removingSessions = new Set<string>();

// The sidebar order and "Finished" group live on the session itself (server-synced fields
// `order`/`finished`), so the arrangement follows you across every client — web, desktop, Android.

// ── Early-init module state (declare-up-top rule) ────────────────────────────────────────────────
// Everything reachable from the top-level "instant restore" init chain below (renderSessions /
// applyActiveTint / renderEmptyState → resetActivity / clearReferences) MUST be declared HERE, above
// that block. A `let`/`const` placed next to its functions further down the file is still in its
// temporal dead zone when init runs at module load, so touching it throws and aborts the rest of
// module init → a totally dead app (no list, no buttons). Bites worst on the no-activeId path
// (fresh device / reinstalled Android, empty localStorage). See memory: web-early-init-decl-order-crash.
let dragging = false; // true while a SortableJS drag is in progress (suppresses re-renders)
let justDragged = false; // set briefly after a drop so the row's click doesn't also navigate
let thinkingEl: HTMLElement | null = null; // animated "thinking" indicator, pinned to the bottom while a turn runs
let activityEl: HTMLDetailsElement | null = null; // consolidated per-turn tool/thinking activity block (§5)
let activityCount = 0;
let activityLive = false;
const activityTail: string[] = [];
const references = new Map<string, string>(); // url → display label, insertion-ordered (Links panel)
let pendingAnswerRefs: string[] = []; // links seen in the latest assistant prose, promoted on `result`
let panelView: "files" | "reader" | "git" | "terminal" | "links" | null = null; // open side panel, if any

// ── Multi-server connection layer (fleet — anvil-multi-server.md §4) ──────────────────────
// Declared HERE (early-init state) because the instant-restore render below calls orderedServers()
// → reads `servers`/`HUB_URL`; a lower declaration would be in its TDZ at module load → dead app
// (see memory: web-early-init-decl-order-crash). One AnvilSocket per server, keyed by base URL.
// The hub (the daemon that served this page, or the native-injected ANVIL_DAEMON_URL) is always
// server #0; extra servers come from the localStorage registry. With a single server this behaves
// exactly as before. Sessions/environments are tagged with the server they arrived from
// (sessionServer/envServer) so commands and session-scoped REST route back to the right daemon.
// Session ids are globally unique, so inbound event matching by `activeId` needs no server
// disambiguation — only outbound routing does. Sockets connect at the bottom (after `outbox`).
interface Server {
  url: string; // base, no trailing slash — the stable registry key
  id: string; // serverId once known (server.hello / health); "" until then
  name: string; // display name; the host until hello/health says otherwise
  sock: AnvilSocket;
  status: "connecting" | "connected" | "disconnected";
  version?: string; // anvild version (from server.hello)
  capabilities?: string[]; // feature flags from server.hello; undefined on pre-capability builds
  budget?: Budget; // last budget snapshot (aggregate gauge, §7)
}
/** Whether a server advertised support for a capability (e.g. "autopilot"). A pre-capability build
 *  omits the list → treated as unsupported, so we never send it a command it can't handle. */
const serverSupports = (srv: Server | undefined, cap: string): boolean => !!srv?.capabilities?.includes(cap);
const cssId = (s: string): string => s.replace(/[^a-z0-9]/gi, "_"); // safe element-id suffix from a URL
const HUB_URL = daemonBase();
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const servers = new Map<string, Server>(); // keyed by url
const sessionServer = new Map<string, string>(); // sessionId → server url (outbound routing)
const envServer = new Map<string, string>(); // environmentId → server url (grouping/routing)
// Autopilot pending plans, tagged by the server they arrived from (anvil-autopilot-ui.md). Declared
// up here with the other early-init routing state so a lower declaration can't TDZ-crash module init.
const serverPlans = new Map<string, AutopilotPlanInfo[]>(); // server url → its pending plans
const planServer = new Map<string, string>(); // workUnitId → server url (route refine/dismiss/start)
// Team trees, derived on the daemon and tagged by server (anvil-team-support.md §5). Cached like
// serverPlans so the sidebar rollup + the lead's member board stay live off `team.info`.
const serverTeams = new Map<string, TeamInfo[]>(); // server url → its teams
const pendingTeamPlans = new Map<string, TeamPlan>(); // lead sessionId → a plan awaiting approval
(function hydrateRouting() {
  try {
    for (const [k, v] of JSON.parse(localStorage.getItem("anvil.sessionServer") ?? "[]") as [string, string][]) sessionServer.set(k, v);
    for (const [k, v] of JSON.parse(localStorage.getItem("anvil.envServer") ?? "[]") as [string, string][]) envServer.set(k, v);
  } catch {
    /* corrupt — repopulated on connect */
  }
})();
const persistRouting = (): void => {
  try {
    localStorage.setItem("anvil.sessionServer", JSON.stringify([...sessionServer]));
    localStorage.setItem("anvil.envServer", JSON.stringify([...envServer]));
  } catch {
    /* quota */
  }
};
function loadExtraServers(): string[] {
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
const serverApiUrl = (base: string, path: string): string =>
  securePageUrl(/^https?:\/\//i.test(path) ? path : base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`));
const serverFetch = (base: string, path: string, init?: RequestInit): Promise<Response> => fetch(serverApiUrl(base, path), init);
function ensureServer(url: string): Server {
  const clean = url.replace(/\/+$/, "");
  const existing = servers.get(clean);
  if (existing) return existing;
  const sock = new AnvilSocket(
    serverWsUrl(clean),
    (e) => onEvent(clean, e),
    (st) => onStatus(clean, st),
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
  serverTeams.delete(url);
  for (const [pid, u] of [...planServer]) if (u === url) planServer.delete(pid);
  // Drop the removed server's autopilot state too, else a lingering `running: true` keeps the fleet-wide
  // spinner spinning for a server that no longer exists (and the user's "remove it" never clears it).
  clearStaleRunTimer(url);
  serverSchedule.delete(url);
  reflectAutopilotRunning();
  updateAutopilotBadge();
  saveExtraServers([...servers.keys()].filter((u) => u !== HUB_URL));
  persistSessions();
  persistEnvironments();
  persistRouting();
  renderSessions();
  if (document.getElementById("server-cards")) renderServerCards(); // drop the card from an open Settings view
}
const hub = (): Server => servers.get(HUB_URL)!;
/** Resolve a routing url to its live socket. The `servers` map is keyed by the url a server was
 *  adopted under, but a session/env's stored routing url can DRIFT from it (a member reconnects under
 *  a force-upgraded https:// while its rows were tagged http://, or a trailing-slash difference) — see
 *  {@link sameServerUrl}. An exact miss then silently routed to the hub, which doesn't own the session
 *  and answers "no such session": the conversation stays blank on the client that didn't create it.
 *  Fall back to a scheme-insensitive match so a drifted url still finds the connected owner. */
function serverByUrl(u: string | undefined): Server | undefined {
  if (!u) return undefined;
  const exact = servers.get(u);
  if (exact) return exact;
  for (const s of servers.values()) if (sameServerUrl(u, s.url)) return s;
  return undefined;
}
function serverOf(sessionId: string | null | undefined): Server | undefined {
  if (!sessionId) return undefined;
  return serverByUrl(sessionServer.get(sessionId));
}
function activeServer(): Server {
  return serverOf(activeId) ?? hub();
}
/** The server an environment lives on (its repos are local to that daemon). */
function serverOfEnv(envId: string | null | undefined): Server {
  return serverByUrl(envId ? envServer.get(envId) : undefined) ?? hub();
}
/** Route a session-scoped command to the daemon that owns the session (falls back to the hub). */
function sendTo(sessionId: string | null | undefined, cmd: Record<string, unknown> & { type: string }): boolean {
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
function ensureOwningServer(sessionId: string): void {
  const url = sessionServer.get(sessionId);
  if (!url) return; // owner unknown (optimistic local / not yet listed) — nothing to reconnect
  const srv = serverByUrl(url) ?? ensureServer(url);
  if (!srv.sock.isOpen()) srv.sock.connectNow();
}
const anyOpen = (): boolean => {
  for (const s of servers.values()) if (s.sock.isOpen()) return true;
  return false;
};
/** Hub first, then extra servers in registry order — the sidebar/grouping order. */
function orderedServers(): Server[] {
  const h = servers.get(HUB_URL);
  const out: Server[] = h ? [h] : []; // empty only during early-init before the hub socket is created
  for (const u of loadExtraServers()) {
    const s = servers.get(u);
    if (s) out.push(s);
  }
  return out;
}

// Offline cache (arch §8): persist the session + environment lists so they're browsable with no
// connection. Hydrated synchronously below, kept in sync on every change.
function persistSessions(): void {
  try {
    localStorage.setItem("anvil.sessions", JSON.stringify([...sessions.values()]));
  } catch {
    /* quota */
  }
}
function persistEnvironments(): void {
  try {
    localStorage.setItem("anvil.environments", JSON.stringify([...environments.values()]));
  } catch {
    /* quota */
  }
}
(function hydrateOffline() {
  try {
    for (const s of JSON.parse(localStorage.getItem("anvil.sessions") ?? "[]") as Session[]) sessions.set(s.id, s);
    for (const e of JSON.parse(localStorage.getItem("anvil.environments") ?? "[]") as Environment[]) environments.set(e.id, e);
  } catch {
    /* corrupt cache — start empty, the daemon repopulates on connect */
  }
})();
// URL routing + the soft-layer back-stack (overlays, openOverlay/dismissOverlay, hash helpers) live
// in overlays.ts; the popstate handler and session navigation that consume them stay here.
// A session in the URL (#s/… or ?session=) means we were opened via a deep link or a notification
// tap — as opposed to just restoring the last-active session from storage. On a phone we then jump
// straight into that conversation with the sidebar hidden (see the collapse below). (UI refinement §4)
const deepLinkedSession = sessionFromHash() || new URLSearchParams(location.search).get("session");
// Captured before setSessionHash() below rewrites the URL and discards a #p/<id> fragment. Acted on
// once the app has booted (the plan may not have synced yet — openPlanDeepLink waits for it).
const deepLinkedPlan = planFromHash();
// Likewise captured before canonicalization: a bare `#autopilot` deep link opens the grid on boot.
const deepLinkedAutopilot = autopilotFromHash();
let activeId: string | null = deepLinkedSession || localStorage.getItem("anvil.active");
setSessionHash(activeId, false); // canonicalize the URL (also strips any ?session=)
// The cid of a session.create we kicked off from the new-session dialog. The matching
// session.created echoes this cid back to *us* only (other devices get it cid-less), so we can
// jump straight into the session we just made without also hijacking sessions created elsewhere.
let pendingCreateCid: string | null = null;
window.addEventListener("popstate", () => {
  if (ui.suppressPop > 0) {
    ui.suppressPop--; // our own dismissOverlay() unwind — the layer is already torn down
    return;
  }
  // Device/browser Back: close every layer stacked above the depth we landed on (dialogs/menus/
  // panels dismiss before we navigate sessions or leave the app).
  const depth = typeof (history.state as { anvilDepth?: number } | null)?.anvilDepth === "number" ? (history.state as { anvilDepth: number }).anvilDepth : 0;
  while (overlays.length > depth) overlays.pop()!.close();
  // Then reflect the session hash (Back/Forward between sessions, then out of the app) — but only once
  // every soft layer is closed. While an overlay is still open (e.g. Back from a plan reader landing on
  // the hash-less autopilot URL), the session underneath must stay selected, not get deselected.
  if (overlays.length > 0) return;
  const id = sessionFromHash();
  if (id && sessions.has(id)) {
    if (id !== activeId) selectSession(id, false);
  } else if (activeId) {
    deselectSession();
  }
});
// External hash navigations only fire `hashchange`, never `popstate`: the Android shell deep-links a
// notification tap via web.loadUrl("…#s/<id>") (a warm app is already loaded, so it's a same-document
// fragment change, not a reload), and manual URL edits / a restored PWA do the same. Our own in-app
// navigation uses push/replaceState, which fire neither — so this listener only ever sees genuinely
// external changes. Without it, a notification tapped while the app is already open didn't switch
// sessions ("not deep linking every time"). (UI refinement §deep-link)
window.addEventListener("hashchange", () => {
  const planId = planFromHash();
  if (planId) {
    openPlanDeepLink(planId); // notification tap / shared link into a specific plan
    return;
  }
  if (autopilotFromHash()) {
    if (!overlayOpen("autopilot")) openAutopilot(); // external #autopilot deep link → open the grid
    return;
  }
  const id = sessionFromHash();
  if (!id) {
    if (activeId) deselectSession();
    return;
  }
  if (id === activeId) return;
  if (sessions.has(id)) {
    selectSession(id, false);
  } else {
    // Target not synced to this client yet (e.g. a session on a server still connecting). Remember it
    // so the next session.list attaches it, and canonicalize the URL without a new history entry.
    activeId = id;
    localStorage.setItem("anvil.active", id);
    setSessionHash(id, false);
  }
});

// ── Keyboard shortcuts ───────────────────────────────────────────────────────────
// Escape dismisses the topmost soft layer (dialog → settings → side panel → expanded sidebar) — the
// same teardown as a single Back; with nothing layered, it drops focus out of the composer (closing
// the on-screen keyboard on mobile). Enter-to-send / Shift+Enter-newline live on the composer itself,
// and dialogs focus their default button so Enter confirms and Escape cancels (see confirmDialog).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  // The embedded terminal owns Escape (it sends ESC to the shell) — don't steal it to close the panel.
  if ((document.activeElement as HTMLElement | null)?.closest(".xterm")) return;
  if (dismissTopOverlay()) {
    e.preventDefault();
  } else if (document.activeElement === input) {
    input.blur();
  }
});
let streaming: HTMLElement | null = null;
// Set when the user hits Stop: the daemon keeps draining the interrupted turn for a moment, so we
// suppress that trailing churn (see the guard in handleSessionEvent). Cleared on the next turn.
let turnCanceled = false;
const snapshotLoaded = new Set<string>(); // sessions with a full snapshot loaded this page-load

const seqStore = {
  get: (id: string): number => Number(localStorage.getItem(`anvil.seq.${id}`) ?? 0),
  set: (id: string, seq: number): void => localStorage.setItem(`anvil.seq.${id}`, String(seq)),
};

// Cache the rendered conversation per session so it shows instantly on reload, before the WS
// even connects. Best-effort (skipped if it exceeds the localStorage quota).
let cacheTimer = 0;
function saveConvoCache(): void {
  const id = activeId;
  if (!id) return;
  clearTimeout(cacheTimer);
  cacheTimer = window.setTimeout(() => {
    try {
      // Don't persist transient UI (the thinking indicator / empty state) — it would
      // re-paint as a frozen "stuck" status on return.
      const clone = conversation.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".thinking, .empty-state").forEach((e) => e.remove());
      // Freeze any still-"live" activity block: the cache is a snapshot, not a running turn, so it
      // must restore as "Worked" — never an animated "Working" that can't stop (no WS yet on reload).
      clone.querySelectorAll(".activity.live").forEach((a) => {
        a.classList.remove("live");
        const ind = a.querySelector(".activity-ind");
        if (ind) ind.innerHTML = `<span class="msym">check</span>`;
        const title = a.querySelector(".activity-title");
        if (title) title.textContent = "Worked";
      });
      const html = clone.innerHTML;
      if (html.length < 1_500_000) localStorage.setItem(`anvil.convo.${id}`, html);
      else localStorage.removeItem(`anvil.convo.${id}`);
    } catch {
      /* quota exceeded — the snapshot still loads from the daemon */
    }
  }, 600);
}

// Resolve the theme before the first render so JS-computed session tints use the right band.
// (themePref/resolveTheme are hoisted function declarations, defined in the Theme section below.)
document.documentElement.dataset.theme = resolveTheme(themePref());

// instant restore: paint the hydrated sidebar + cached conversation immediately on load (works
// fully offline; the daemon refreshes everything once the WS connects).
renderSessions();
refreshPromptsButton();
applyActiveTint();
if (activeId) {
  if (sessions.has(activeId)) setHeaderTitle(sessions.get(activeId));
  const cached = localStorage.getItem(`anvil.convo.${activeId}`);
  if (cached) {
    conversation.innerHTML = cached;
    conversation.scrollTop = conversation.scrollHeight;
  }
} else {
  renderEmptyState();
}

// ── Theme (light / dark / system, chosen in Settings → Appearance) ────────────
// Pure theme resolution lives in theme.ts; the repaint side stays here because it re-renders the
// session list.
/** Paint the resolved theme and re-clamp session tints to the new band. */
function applyTheme(): void {
  document.documentElement.dataset.theme = resolveTheme(themePref());
  renderSessions();
  applyActiveTint();
}
/** Persist a new preference ("system" clears the key), repaint, and reflect it in any open Settings UI. */
function setThemePref(pref: ThemePref): void {
  if (pref === "system") localStorage.removeItem("anvil.theme");
  else localStorage.setItem("anvil.theme", pref);
  applyTheme();
  updateThemeControls();
}
// Follow the OS theme live while the preference is "system".
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (themePref() === "system") applyTheme();
});

// ── Sidebar collapse + resizable panes ───────────────────────────────────────────
// The sidebar/resizer mechanics live in layout.ts; the boot-time seed of ui.sidebarCollapsed and
// the listener wiring stay here (they read deepLinkedSession/activeId and own page bootstrap).
ui.sidebarCollapsed =
  localStorage.getItem("anvil.sidebar") === "collapsed" ||
  (localStorage.getItem("anvil.sidebar") === null && isNarrow());
// Opened via a deep link / notification on a phone: jump straight into the conversation with the
// session menu hidden, even if the sidebar was last left open. (UI refinement §4)
if (deepLinkedSession && activeId && isNarrow()) ui.sidebarCollapsed = true;
applySidebar();
// both the header ☰ and an in-sidebar button toggle it — the in-sidebar one stays reachable
// when the open sidebar overlays the header (e.g. unfolding a foldable).
$("#btn-sidebar").addEventListener("click", toggleSidebar);
$("#sidebar-collapse").addEventListener("click", toggleSidebar);
initResizers();
$("#convo-col").addEventListener("pointerdown", collapseSidebarForChat);
$("#convo-col").addEventListener("focusin", collapseSidebarForChat);

// (multi-server connection layer is declared up top with the other early-init state; the sockets
// connect at the bottom, once the outbox state onStatus reads is initialized.)

// ── Outbox: writes made offline are queued and flushed, in order, on reconnect (arch §8) ──────
// The queue + persistence live in ./outbox (unit-tested); flush/reconcile orchestration stays here.
const outboxQueue = new OutboxQueue();
function enqueue(item: OutboxItem): void {
  outboxQueue.enqueue(item);
  updateOutboxBadge();
  // A write can be queued while a socket is already open — e.g. the active session is `pending`, or
  // its owning server is offline while the hub is up. `flushOutbox` otherwise only runs on a
  // disconnected→connected transition, so without this kick the item sits forever behind a
  // "Syncing…" banner that never drains. Try now if we're online (no-op if nothing can route yet).
  if (anyOpen()) void flushOutbox();
}
const cidWaiters = new Map<string, (e: ServerEvent) => void>();
function sendAwait(server: Server, cmd: Record<string, unknown> & { type: string; cid: string }, timeoutMs = 20_000): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      cidWaiters.delete(cmd.cid);
      reject(new Error("timeout"));
    }, timeoutMs);
    cidWaiters.set(cmd.cid, (e) => {
      clearTimeout(t);
      resolve(e);
    });
    if (!server.sock.send(cmd)) {
      clearTimeout(t);
      cidWaiters.delete(cmd.cid);
      reject(new Error("offline"));
    }
  });
}
const tempMap = new Map<string, string>(); // optimistic id → real id
let flushing = false;
async function flushOutbox(): Promise<void> {
  if (flushing || !anyOpen()) return;
  flushing = true;
  let touchedActive = false;
  const remaining: OutboxItem[] = []; // items whose server is offline / that error stay queued
  const failedTemps = new Set<string>();
  try {
    for (const item of outboxQueue.list()) {
      // a create that was just rejected → drop its dependent queued prompts
      if ((item.tempId && failedTemps.has(item.tempId)) || (typeof item.cmd.sessionId === "string" && failedTemps.has(item.cmd.sessionId))) continue;
      const sid = item.cmd.sessionId as string | undefined;
      if (sid && tempMap.has(sid)) item.cmd.sessionId = tempMap.get(sid); // rewrite temp → real
      // route: explicit target (session.create) → the session's server → the hub
      const srv = (item.serverUrl ? servers.get(item.serverUrl) : undefined) ?? serverOf(item.cmd.sessionId as string | undefined) ?? hub();
      if (!srv.sock.isOpen()) {
        remaining.push(item); // its server is offline — leave queued, try on its next connect
        continue;
      }
      if (item.cmd.sessionId === activeId) touchedActive = true;
      try {
        const res = await sendAwait(srv, { ...item.cmd, cid: item.cid });
        if (res.type === "command.error") {
          toast(`Queued ${item.cmd.type} failed: ${res.message}`);
          if (item.tempId) {
            failedTemps.add(item.tempId);
            failTemp(item.tempId);
          }
        } else if (item.tempId && res.type === "session.created") {
          tempMap.set(item.tempId, res.session.id);
          sessionServer.set(res.session.id, srv.url);
          persistRouting();
          reconcileTemp(item.tempId, res.session.id);
          if (activeId === res.session.id) touchedActive = true;
        }
      } catch {
        remaining.push(item); // disconnected/timeout — retry on next connect
      }
    }
  } finally {
    outboxQueue.replace(remaining);
    flushing = false;
    updateOutboxBadge();
    // re-pull authoritative history for the active session so optimistic bubbles are replaced
    if (touchedActive && activeId && serverOf(activeId)?.sock.isOpen()) {
      snapshotLoaded.delete(activeId);
      sendTo(activeId, { type: "session.attach", sessionId: activeId });
    }
  }
}
/** A created-offline session was realized on the daemon: migrate its cache + active selection. */
function reconcileTemp(tempId: string, realId: string): void {
  const conv = localStorage.getItem(`anvil.convo.${tempId}`);
  if (conv) localStorage.setItem(`anvil.convo.${realId}`, conv);
  localStorage.removeItem(`anvil.convo.${tempId}`);
  sessions.delete(tempId);
  if (activeId === tempId) {
    activeId = realId;
    localStorage.setItem("anvil.active", realId);
    setSessionHash(realId, false);
    setHeaderTitle(sessions.get(realId));
  }
  persistSessions();
  renderSessions();
}
/** A queued create was rejected: drop the pending session + its queued prompts. */
function failTemp(tempId: string): void {
  sessions.delete(tempId);
  localStorage.removeItem(`anvil.convo.${tempId}`);
  outboxQueue.removeWhere((i) => i.cmd.sessionId === tempId || i.tempId === tempId);
  persistSessions();
  if (activeId === tempId) deselectSession();
  else renderSessions();
}
function updateOutboxBadge(): void {
  const el = document.getElementById("offline-banner");
  if (!el) return;
  const queued = outboxQueue.size;
  const online = anyOpen();
  el.hidden = online && queued === 0;
  // A "Syncing…" banner needs a Retry too: a queued write whose owning server is unreachable (while
  // another server is up) can't drain on its own and would otherwise hang here with no way out.
  el.innerHTML = online
    ? `${icon("sync")} Syncing ${queued} queued change${queued === 1 ? "" : "s"}… <button id="offline-retry" class="mini">${icon("refresh")} Retry</button>`
    : `${icon("cloud_off")} Offline${queued ? ` · ${queued} change${queued === 1 ? "" : "s"} queued` : ""} <button id="offline-retry" class="mini">${icon("refresh")} Retry</button>`;
  const retry = document.getElementById("offline-retry");
  // Reconnect only the sockets that are actually down (connectNow no-ops on an open one), then drain
  // the outbox directly — otherwise Retry does nothing when the queue is stuck behind a socket that's
  // already open (the item's owning server is unreachable but another server, e.g. the hub, is up).
  if (retry) retry.onclick = () => {
    for (const s of servers.values()) if (!s.sock.isOpen()) s.sock.connectNow();
    void flushOutbox();
  };
}
// Start connecting now that the outbox state onStatus reads is initialized: the hub always, plus
// every server in the registry (fleet — they merge into one view).
ensureServer(HUB_URL);
for (const u of loadExtraServers()) ensureServer(u);
// Adopt the rest of the fleet up front (not just on first Settings open) so fleet sessions AND
// environments merge into the view immediately — otherwise the new-session picker shows hub-only
// environments until the user happens to visit Settings → Servers.
void loadFleetMembers();
// Cold deep link into a plan (Todoist "Review in Anvil" link): open the Autopilot view now; the
// reader follows as soon as the plan syncs in (each server pulls its plans on connect → onAutopilotPlans).
if (deepLinkedPlan) openPlanDeepLink(deepLinkedPlan);
else if (deepLinkedAutopilot) openAutopilot(); // bare #autopilot deep link → open the grid

// The native shell bridge (nativeBridge/isAndroidApp) and Web Push live in push.ts.
void initPush();
updateOutboxBadge(); // reflect any queued-offline writes on load

$("#scroll-bottom").addEventListener("click", () => {
  stickToBottom = true;
  conversation.scrollTop = conversation.scrollHeight;
  $("#scroll-bottom").hidden = true;
});

// ── Connection status ────────────────────────────────────────────────────────
// Set while a daemon self-update restart is in flight: the WS drops then reconnects, and that
// reconnect is our signal the new build is live — reload to pick up the rebuilt web bundle.
let pendingRestartReload = false;
function setUpdateStatus(text: string): void {
  // The hub's card owns the page-reload-on-restart flow; its output element is keyed by the hub URL.
  const out = document.getElementById(`daemon-update-output-${cssId(HUB_URL)}`);
  if (out) {
    out.hidden = false;
    out.textContent = text;
  }
}
function onStatus(url: string, status: "connecting" | "connected" | "disconnected"): void {
  const srv = servers.get(url);
  if (srv) srv.status = status;
  // The header dot reflects the ACTIVE session's server; per-server dots live in the sidebar groups.
  refreshConnDot();
  updateOutboxBadge();
  renderSessions(); // per-server status dots in the group headers
  if (document.querySelector(".settings-view")) renderServerCards(); // live status in Settings
  if (status === "connected") {
    void flushOutbox(); // push anything queued while offline (routed per server)
    // The autopilot probes are sent from the server.hello handler instead — hello is the first frame
    // after open and carries the server's capabilities, so we only probe servers that support autopilot.
  }
  if (status === "disconnected") {
    // A disconnected server can't be mid-run from our point of view, so clear any stale `running` it
    // left behind. Without this the autopilot spinner latches on forever when a daemon drops mid-run
    // before its `running: false` broadcast lands — e.g. a forced exit skips the run's finally. The
    // schedule itself is kept for display; on reconnect the server re-asserts its true running state.
    clearStaleRunTimer(url); // a gone server can't go stale-running; tidy its backstop
    const entry = serverSchedule.get(url);
    if (entry?.running) {
      serverSchedule.set(url, { ...entry, running: false });
      reflectAutopilotRunning();
    }
  }
  if (pendingRestartReload && url === HUB_URL) {
    if (status === "disconnected") setUpdateStatus("Daemon is restarting…");
    else if (status === "connected") {
      pendingRestartReload = false;
      setUpdateStatus("Back online — reloading to load the new version…");
      setTimeout(() => location.reload(), 500); // fresh page → new web bundle
    }
  }
  // (re)attach happens in the session.list handler, which the daemon sends on every connect.
}
/** The header connection dot tracks the server that owns the currently-open session. */
function refreshConnDot(): void {
  const dot = document.getElementById("conn-dot");
  if (!dot) return;
  const status = activeServer()?.status ?? "disconnected";
  dot.className = `conn-dot ${status}`;
  dot.title = status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Disconnected";
}

// ── Event routing ──────────────────────────────────────────────────────────────
// `url` is the server the frame arrived from — used to tag sessions/environments for routing.
function onEvent(url: string, e: ServerEvent): void {
  if ("seq" in e && "sessionId" in e && typeof e.seq === "number") seqStore.set(e.sessionId, e.seq);
  const cid = (e as { cid?: string }).cid;
  let awaited = false;
  if (cid && cidWaiters.has(cid)) {
    cidWaiters.get(cid)!(e); // hand the frame to the sendAwait promise tracking this cid
    cidWaiters.delete(cid);
    awaited = true;
  }

  switch (e.type) {
    case "session.list": {
      // This server is the source of truth for ITS OWN sessions only — drop the ones it used to
      // own and no longer lists (not other servers' sessions, not optimistic pending locals).
      for (const id of [...sessions.keys()]) {
        if (sameServerUrl(sessionServer.get(id), url) && !sessions.get(id)?.pending) {
          sessions.delete(id);
          sessionServer.delete(id);
        }
      }
      e.sessions.forEach((s) => {
        sessions.set(s.id, s);
        sessionServer.set(s.id, url);
      });
      for (const id of [...removingSessions]) if (!sessions.has(id)) removingSessions.delete(id);
      persistSessions();
      persistRouting();
      renderSessions();
      // (re)attach the active session only if it lives on THIS server.
      if (activeId && sessions.has(activeId) && sessionServer.get(activeId) === url) {
        setHeaderTitle(sessions.get(activeId));
        if (snapshotLoaded.has(activeId)) {
          sendTo(activeId, { type: "session.attach", sessionId: activeId, lastSeq: seqStore.get(activeId) });
        } else {
          sendTo(activeId, { type: "session.attach", sessionId: activeId });
        }
      } else if (activeId && !sessions.has(activeId) && sessionServer.get(activeId) === url) {
        activeId = null; // the remembered session was on this server and is gone
        localStorage.removeItem("anvil.active");
        clearConversation();
      }
      return;
    }
    case "session.created":
      sessions.set(e.session.id, e.session);
      sessionServer.set(e.session.id, url);
      persistSessions();
      persistRouting();
      renderSessions();
      // Jump straight into a session we just created from the dialog (cid echoes back to the
      // creator only). Otherwise only auto-open when nothing's active yet.
      if (cid && cid === pendingCreateCid) {
        pendingCreateCid = null;
        selectSession(e.session.id);
      } else if (!activeId) selectSession(e.session.id);
      return;
    case "session.updated":
      sessions.set(e.session.id, e.session);
      sessionServer.set(e.session.id, url);
      persistSessions();
      renderSessions();
      if (e.session.id === activeId) {
        updateGitPanelMeta();
        updateHeaderBranch(e.session); // keep the header branch chip fresh as git state changes
        updateHeaderModel(e.session); // reflect a model switch (incl. one made on another device)
        updateContextMeter(e.session); // refresh the context-window gauge as turns/compaction change it
      }
      // Teams: a member's status/git change refreshes the active lead's board (and the lead's own row).
      if (activeId && (e.session.id === activeId || e.session.parentId === activeId)) {
        const lead = sessions.get(activeId);
        if (lead?.teamRole === "lead") renderTeamBoard(lead);
      }
      return;
    case "session.deleted":
      purgeSessionLocally(e.sessionId);
      return;
    case "team.info":
      // Derived team tree for this server (grouped by parentId on the daemon). Drives the sidebar
      // rollup chip and the lead's member board; both also read live status off the session objects.
      serverTeams.set(url, e.teams);
      renderSessions();
      if (activeId && sessions.get(activeId)?.teamRole === "lead") renderTeamBoard(sessions.get(activeId)!);
      return;
    case "team.plan":
      // A lead proposed a decomposition that needs approval (non-bypass autonomy). Park it as a card.
      pendingTeamPlans.set(e.sessionId, e.plan);
      renderSessions();
      if (e.sessionId === activeId) renderTeamBoard(sessions.get(activeId)!);
      return;
    case "team.plan.resolved":
      pendingTeamPlans.delete(e.sessionId);
      renderSessions();
      if (e.sessionId === activeId) renderTeamBoard(sessions.get(activeId)!);
      return;
    case "server.hello": {
      // identify the server on this socket as soon as it opens (fleet §3/§6).
      const srv = servers.get(url);
      if (srv) {
        srv.id = e.serverId;
        srv.name = e.serverName || srv.name;
        srv.version = e.version;
        srv.capabilities = e.capabilities;
      }
      // Now that we know this server's capabilities, pull its autopilot state — but only if it's new
      // enough to handle these commands. An older member (no "autopilot" capability) is skipped, so it
      // never gets `unknown command type` and just sits out the federated plan view until it's updated.
      if (serverSupports(srv, "autopilot")) {
        srv!.sock.send({ type: "autopilot.plans.list" }); // keep the sidebar badge + grid live for this server
        srv!.sock.send({ type: "autopilot.schedule.get" }); // current schedule for the Autopilot view
      }
      // Pull the hub's model-provider auth state so the Settings → Models card is live (hub-scoped) —
      // one request per provider (Claude + OpenRouter).
      if (url === HUB_URL && serverSupports(srv, "auth")) {
        srv!.sock.send({ type: "auth.status" }); // claude (default)
        srv!.sock.send({ type: "auth.status", provider: "openrouter" });
      }
      renderSessions(); // group headers now know this server's name
      if (document.getElementById("env-cards")) renderEnvCards();
      if (document.querySelector(".settings-view")) renderServerCards();
      // A member just (re)joined the fleet — if the hub holds a Todoist token, have the hub replicate
      // it to this member so its linked environments can run autopilot. Self-heals every reconnect.
      if (url !== HUB_URL && todoistConnected && e.serverId) {
        hub().sock.send({ type: "todoist.propagate", targets: [e.serverId], cid: newCid() });
      }
      return;
    }
    case "budget": {
      const srv = servers.get(url);
      if (srv) srv.budget = e.budget; // stored for any future use; no longer surfaced in the UI
      return;
    }
    case "environments":
      onEnvironments(url, e.environments);
      return;
    case "prompts":
      // Prompts are hub-authoritative (the store lives on the hub daemon). Ignore a fleet member's
      // own prompts event so it can't clobber the hub's synced library.
      if (url === HUB_URL) onPrompts(e.prompts);
      return;
    case "todoist.status":
      // Todoist is hub-scoped (the token lives on the hub daemon; the link UI routes to hub()).
      // Fleet members each push their own status on connect — ignore them so a tokenless member
      // can't clobber the hub's "connected" with its "not connected".
      if (url === HUB_URL) onTodoistStatus(e.connected, e.account);
      return;
    case "todoist.projects.result":
      return; // resolved via cidWaiter (loadTodoistProjects)
    case "lapo.status":
      // Lapo is hub-scoped (tokens live on the hub daemon; the card routes to hub()). Ignore a fleet
      // member's own status so a member that isn't configured can't clobber the hub's "connected".
      if (url === HUB_URL) onLapoStatus(e.connected, e.configured, e.account, e.callbackUrl);
      return;
    case "lapo.authorize":
      return; // resolved via cidWaiter (connectLapo)
    case "auth.status":
      // Model-provider auth is hub-scoped (the token lives on the hub daemon; the Models card routes
      // to hub()). Ignore a fleet member's own status so it can't clobber the hub's.
      if (url === HUB_URL) onAuthStatus(e);
      return;
    case "autopilot.maintenance.result":
      return; // resolved via cidWaiter (resetAnvilTags / clearAutopilot)
    case "autopilot.plans":
      onAutopilotPlans(url, e.plans);
      return;
    case "autopilot.plan":
      return; // resolved via cidWaiter (refinePlan); the matching autopilot.plans broadcast refreshes state
    case "autopilot.started":
      return; // resolved via cidWaiter (startPlan)
    case "autopilot.run.result":
      return; // resolved via cidWaiter (runAutopilot)
    case "autopilot.pipeline.result":
      toast(e.ok ? `Pipeline ${e.status ?? "finished"}${e.phaseReached ? ` at ${e.phaseReached}` : ""}` : `Pipeline failed: ${e.output}`);
      if (url === HUB_URL) hub().sock.send({ type: "autopilot.pipeline.metrics" }); // refresh calibration after a run
      return;
    case "autopilot.pipeline.metrics":
      if (url === HUB_URL) onPipelineMetrics(e.adversaries);
      return;
    case "autopilot.run.progress":
      onAutopilotProgress(e.line);
      return;
    case "autopilot.run.snapshot":
      onAutopilotRunSnapshot(e.log);
      return;
    case "autopilot.schedule":
      onAutopilotSchedule(url, e.schedule, e.nextRunAt, e.running);
      return;
    case "dirs.list.result":
      onDirs?.(e);
      return;
    case "fs.list.result":
      if (panel.classList.contains("open") && e.sessionId === activeId) renderFiles(e.entries);
      return;
    case "fs.read.result":
      renderReader(e.content);
      return;
    case "git.result":
      if (e.sessionId === activeId) showGitResult(e);
      return;
    case "command.error":
      // Only surface errors for a command we issued and are still tracking. Skip it when a sendAwait
      // already took it (the caller decides how to show it — avoids a double toast) and when it has no
      // cid: a cid-less command.error is an unsolicited reply to a fire-and-forget command — e.g. the
      // connect-time autopilot.plans.list / schedule.get probe reaching a fleet member on an older
      // build that doesn't recognise it. That's benign cross-version noise, so don't toast it.
      if (cid && !awaited) toast(e.message);
      return;
    case "ack":
      return;
    default:
      if ("sessionId" in e && e.sessionId !== activeId) return; // not the open pane
      handleSessionEvent(e);
  }
}

function handleSessionEvent(e: ServerEvent): void {
  // A turn the user cancelled (Stop): drop the in-flight churn the daemon is still draining
  // (deltas, tool results, a partial assistant message, "working" statuses) so the conversation
  // stays at the cancel point. The guard lifts when the turn truly ends or a new one begins.
  if (turnCanceled) {
    if (e.type === "result" || (e.type === "status" && e.status === "idle") || e.type === "message.user") {
      turnCanceled = false; // fall through and handle normally
    } else if (
      e.type === "assistant.delta" ||
      e.type === "assistant.message" ||
      e.type === "tool.result" ||
      e.type === "file.offer" ||
      e.type === "status"
    ) {
      return;
    }
  }
  switch (e.type) {
    case "conversation.snapshot":
      if (e.sessionId === activeId) clearAttachDiagnostic(); // history arrived — retire the blank-pane note
      clearConversation();
      replayingSnapshot = true;
      renderSnapshotEvents(e.events);
      replayingSnapshot = false;
      // A replayed history has no `result` event, so the last turn's activity block was rebuilt
      // "live" — finalize it so it shows "Worked" instead of an eternally spinning "Working". If the
      // session is actually mid-turn, the live status/message events that follow re-light it.
      finalizeActivity();
      snapshotLoaded.add(e.sessionId);
      if (e.sessionId === activeId) maybeShowSessionHero(); // no messages yet → show the session title card
      saveConvoCache();
      return;
    case "message.user":
      appendUser(e.rendered.html, e.attachments, e.ts);
      return;
    case "assistant.delta":
      appendDelta(e.text);
      return;
    case "assistant.message":
      commitAssistant(e.blocks, e.ts);
      return;
    case "tool.result":
      appendToolResult(e.content, e.isError);
      return;
    case "file.offer":
      appendFileOffer(e.file);
      return;
    case "status":
      setStatus(e.status);
      return;
    case "result":
      setStatus("idle");
      streaming = null;
      finalizeActivity(); // stop the activity spinner now the turn is done
      commitAnswerRefs(); // promote the final answer's links into the Links panel
      saveConvoCache();
      if (panelView === "git" && e.sessionId === activeId) requestGitStatus(); // refresh the SCM buttons
      return;
    case "permission.request":
      showPermission(e.requestId, e.tool, e.input, e.suggestions);
      return;
    case "permission.resolved":
      // Retire EXACTLY this card (answered here, on another device, or superseded). Per-request so a
      // sibling prompt still parked during sub-agent fan-out is never collaterally cleared.
      resolvePermissionUI(e.requestId);
      return;
    case "question.request":
      showQuestion(e.requestId, e.questions);
      return;
    case "question.resolved":
      // Retire EXACTLY this card (answered here, on another device, or superseded) — per-request so
      // a sibling question still parked during sub-agent fan-out is never collaterally cleared.
      resolveQuestionUI(e.requestId);
      return;
    case "fs.changed":
      if (panel.classList.contains("open") && e.content.path === readerPath) renderReader(e.content);
      return;
    case "terminal.data":
      xterm?.write(b64ToBytes(e.data));
      return;
    case "terminal.exit":
      xterm?.write(`\r\n\x1b[90m[process exited: ${e.code}]\x1b[0m\r\n`);
      return;
    case "error":
      toast(e.message);
      return;
  }
}

// file links in the conversation (Read/Edit/… tool calls) open the reader
conversation.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest(".file-link") as HTMLElement | null;
  if (!link) return;
  e.preventDefault();
  const path = link.dataset.path;
  if (path && activeId) openFile(path);
});

// replay/snapshot events fold into the same renderers
function renderConversationEvent(ev: ConversationEvent): void {
  if (ev.kind === "user") appendUser(ev.rendered.html, ev.attachments, ev.ts);
  else if (ev.kind === "assistant") commitAssistant(ev.blocks, ev.ts);
  else if (ev.kind === "tool_result") appendToolResult(ev.content, ev.isError);
  else if (ev.kind === "file_offer") appendFileOffer(ev.file);
}

/**
 * Replay a full-history snapshot with per-event isolation. Previously a single un-renderable event
 * (an unexpected block shape, a stricter WebView engine choking where desktop Chrome tolerates it)
 * threw out of the forEach — and because the whole frame is handled inside `ws.onmessage`'s
 * swallow-all try/catch, the ENTIRE conversation silently blanked. Isolating each event means one
 * bad turn drops to a small placeholder instead of erasing all history; if every event fails we
 * surface the reason rather than a mysterious void. (This was the phone "no threads" failure: fine
 * in desktop Chrome, blank in the Android WebView.)
 */
function renderSnapshotEvents(events: ConversationEvent[]): void {
  let failed = 0;
  let lastErr: unknown;
  for (const ev of events) {
    try {
      renderConversationEvent(ev);
    } catch (err) {
      failed++;
      lastErr = err;
      console.error("[snapshot] failed to render an event", ev?.kind, err);
    }
  }
  if (failed) {
    const note = document.createElement("div");
    note.className = "attach-diag empty-state";
    const detail = failed === events.length ? `history couldn't be rendered` : `${failed} of ${events.length} messages couldn't be shown`;
    note.innerHTML = `<p class="small muted">${icon("warning")} ${esc(detail)}${lastErr ? ` — ${esc(String((lastErr as Error)?.message ?? lastErr))}` : ""}</p>`;
    conversation.appendChild(note);
  }
}

// ── Conversation rendering ─────────────────────────────────────────────────────
function bubble(role: string): HTMLElement {
  dropSessionHero(); // real content arriving — retire the blank-session title card
  removeTailSpacer(); // fresh content fills the pane; drop any "new topic" blank space below
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  conversation.appendChild(el);
  scrollDown();
  return el;
}

// A "new topic" divider (§0.6) acts like a header: it scrolls to the top of the pane with a viewport
// of blank space below, so the earlier conversation slides up out of view (it stays — scroll up).
// The spacer is temporary; the next message removes it via bubble().
let tailSpacer: HTMLElement | null = null;
function removeTailSpacer(): void {
  tailSpacer?.remove();
  tailSpacer = null;
}
function appendTopicDivider(label: string, note?: string): void {
  dropSessionHero();
  const el = document.createElement("div");
  el.className = "topic-divider";
  el.innerHTML = `<div class="topic-rule"><span class="topic-chip">${icon("restart_alt")}<span>${esc(label)}</span></span></div>`;
  if (note) {
    const n = document.createElement("div");
    n.className = "topic-note";
    n.textContent = note;
    el.appendChild(n);
  }
  conversation.appendChild(el);
  if (!replayingSnapshot) pushDividerToTop(el); // a fresh clear pushes to top; replay keeps normal flow
}
function pushDividerToTop(el: HTMLElement): void {
  removeTailSpacer();
  const spacer = document.createElement("div");
  spacer.className = "convo-tail-spacer";
  spacer.style.height = `${conversation.clientHeight}px`; // a full viewport so the divider can reach the top
  conversation.appendChild(spacer);
  tailSpacer = spacer;
  stickToBottom = false; // we're deliberately parked at the divider, not following the bottom
  requestAnimationFrame(() => {
    const top = el.getBoundingClientRect().top - conversation.getBoundingClientRect().top + conversation.scrollTop;
    conversation.scrollTop = Math.max(0, top - 16);
  });
}
// ── Timestamps ─────────────────────────────────────────────────────────────────
/** A small, muted time label for a message (short text; full date/time on hover). */
function timeEl(ts?: string): HTMLElement | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const el = document.createElement("div");
  el.className = "msg-time";
  el.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.title = d.toLocaleString();
  return el;
}

function appendUser(html: string, attachments: AttachmentRef[] = [], ts?: string): void {
  resetActivity(); // a new user turn closes off the previous turn's activity block
  turnCanceled = false; // a fresh user turn starts clean
  pendingAnswerRefs = []; // don't carry a prior turn's un-committed links across
  const b = bubble("user");
  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = html; // daemon-sanitized (arch §8.3)
  b.appendChild(md);
  for (const att of attachments) {
    if (!activeId) continue;
    const href = serverApiUrl(activeServer().url, `/api/sessions/${activeId}/attachments/${att.id}`);
    if (att.kind === "image") {
      const img = document.createElement("img");
      img.className = "att-img";
      img.src = href;
      b.appendChild(img);
    } else {
      // a non-image attachment → a downloadable file chip
      const a = document.createElement("a");
      a.className = "att-file";
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.innerHTML = `${icon("description")}<span class="att-name">${esc(att.name)}</span>`;
      b.appendChild(a);
    }
  }
  const t = timeEl(ts);
  if (t) b.appendChild(t);
  // Note: we deliberately do NOT collect links from the user's own prompt — only from Claude's answers.
  scrollDown();
  saveConvoCache();
}
/** Optimistically render a queued (offline) user message; the authoritative copy replaces it
 *  when the outbox flushes and the session re-snapshots. */
function appendOptimisticUser(text: string): void {
  resetActivity();
  turnCanceled = false;
  pendingAnswerRefs = [];
  const b = bubble("user");
  b.classList.add("queued");
  const md = document.createElement("div");
  md.className = "md";
  md.textContent = text; // plain text is safe; full markdown render comes from the daemon on flush
  b.appendChild(md);
  const badge = document.createElement("span");
  badge.className = "queued-badge";
  badge.innerHTML = `${icon("schedule")} queued`;
  b.appendChild(badge);
  const t = timeEl(new Date().toISOString());
  if (t) b.appendChild(t);
  scrollDown();
  saveConvoCache();
}
// Lightweight client renderer for the in-flight turn (the daemon ships authoritative,
// Shiki-highlighted HTML on assistant.message; this just makes streaming readable).
const streamMd = new MarkdownIt({ html: false, linkify: true, typographer: true });
let streamText = "";
let streamRaf = 0;

function appendDelta(text: string): void {
  if (!streaming) {
    hideThinking(); // the streaming text itself is now the activity
    streaming = bubble("assistant");
    streaming.innerHTML = '<div class="md"></div>';
    streamText = "";
  }
  streamText += text;
  if (!streamRaf) streamRaf = requestAnimationFrame(renderStream);
}
const STREAM_TAIL_LINES = 10;
function renderStream(): void {
  streamRaf = 0;
  const md = streaming?.querySelector(".md");
  if (md) {
    // While streaming, show only the trailing lines so an in-flight turn stays compact;
    // the full, authoritative message replaces this on commit (assistant.message).
    const lines = streamText.split("\n");
    const tail = lines.length > STREAM_TAIL_LINES ? "…\n" + lines.slice(-STREAM_TAIL_LINES).join("\n") : streamText;
    md.innerHTML = streamMd.render(tail);
  }
  scrollDown();
}
// Animated "thinking" indicator (like Claude's), pinned to the bottom while a turn runs.
// `thinkingEl` is declared in the early-init cluster up top (reached by renderEmptyState at load).
const THINK_LABEL: Record<string, string> = { thinking: "Thinking", running_tool: "Working", running: "Working" };
function showThinking(status: string): void {
  if (activityLive) return; // the live activity block already shows running state
  dropSessionHero(); // a turn is starting — retire the blank-session title card
  if (!thinkingEl) {
    thinkingEl = document.createElement("div");
    thinkingEl.className = "thinking";
    thinkingEl.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span class="think-label"></span>`;
  }
  const label = thinkingEl.querySelector(".think-label");
  if (label) label.textContent = THINK_LABEL[status] ?? "Thinking";
  conversation.appendChild(thinkingEl); // move to the bottom
  scrollDown();
}
function hideThinking(): void {
  thinkingEl?.remove();
  thinkingEl = null;
}
function commitAssistant(blocks: ContentBlock[], ts?: string): void {
  if (streamRaf) {
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
  }
  const mdBlocks = blocks.filter((b): b is Extract<ContentBlock, { kind: "markdown" }> => b.kind === "markdown");
  const toolBlocks = blocks.filter((b): b is Extract<ContentBlock, { kind: "tool_use" }> => b.kind === "tool_use");
  const dividerBlocks = blocks.filter((b): b is Extract<ContentBlock, { kind: "divider" }> => b.kind === "divider");

  // Topic dividers are full-width boundaries, not prose bubbles — render (and push-to-top) first.
  for (const d of dividerBlocks) appendTopicDivider(d.label, d.note);

  if (mdBlocks.length) {
    // The model's prose answer is its own clean bubble (separate from the tool churn below).
    const b = streaming ?? bubble("assistant");
    b.innerHTML = "";
    const md = document.createElement("div");
    md.className = "md";
    md.innerHTML = mdBlocks.map((blk) => blk.rendered.html).join("");
    b.appendChild(md);
    const t = timeEl(ts);
    if (t) b.appendChild(t);
    addCopyButtons(md);
    linkifyFilePaths(md); // make plain-text mentions of .md files clickable → open in the reader
    noteAnswerRefs(md.innerHTML); // buffered; only the final answer's links reach the panel (on result)
    void runMermaid(md);
  } else if (streaming) {
    // A tool-only turn: drop the empty streaming draft bubble so it isn't left blank.
    streaming.remove();
  }
  streaming = null;
  streamText = "";
  // Tool calls fold into the consolidated activity block, not inline in the prose.
  for (const b of toolBlocks) appendActivityStep(toolHtml(b));
  scrollDown();
}
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
function toolPath(input: unknown): string | undefined {
  const i = input as Record<string, unknown> | undefined;
  for (const k of ["file_path", "path", "notebook_path"]) {
    if (typeof i?.[k] === "string") return i[k] as string;
  }
  return undefined;
}
function toolHtml(b: Extract<ContentBlock, { kind: "tool_use" }>): string {
  const path = toolPath(b.input);
  if (FILE_TOOLS.has(b.name) && path) {
    const base = path.split("/").pop() || path;
    return `<div class="tool">${icon("description")} <b>${esc(b.name)}</b> <a href="#" class="file-link" data-path="${esc(path)}" title="${esc(path)}">${esc(base)}</a></div>`;
  }
  const i = b.input as Record<string, unknown> | undefined;
  if (b.name === "Bash" && typeof i?.command === "string") {
    return `<div class="tool">${icon("terminal")} <code>${esc(i.command.slice(0, 240))}</code></div>`;
  }
  return `<div class="tool">${icon("build")} <b>${esc(b.name)}</b> <code>${esc(JSON.stringify(b.input)).slice(0, 160)}</code></div>`;
}

// Markdown files Claude names in prose (e.g. "see docs/plans/design.md") are usually design docs you
// want to open — turn those mentions into the same `.file-link` the tool rows use, so one tap opens
// them in the reader. Limited to .md/.markdown to avoid over-linkifying ordinary words; skips text
// already inside a link or a fenced code block (but inline `path.md` in backticks is fair game).
const MD_PATH_RE = /(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown)(?![\w/-])/gi;
function linkifyFilePaths(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node): number {
      const v = n.nodeValue;
      MD_PATH_RE.lastIndex = 0;
      if (!v || !MD_PATH_RE.test(v)) return NodeFilter.FILTER_REJECT;
      for (let p = n.parentElement; p && p !== root; p = p.parentElement) {
        if (p.tagName === "A" || p.tagName === "PRE") return NodeFilter.FILTER_REJECT; // already a link / code block
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  while (walker.nextNode()) targets.push(walker.currentNode as Text);
  for (const node of targets) {
    const text = node.nodeValue ?? "";
    MD_PATH_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = MD_PATH_RE.exec(text)) !== null) {
      const raw = m[0];
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement("a");
      a.href = "#";
      a.className = "file-link md-file-link";
      a.dataset.path = raw.replace(/^\.\//, ""); // fs.read is worktree-relative
      a.title = `Open ${raw}`;
      a.textContent = raw;
      frag.appendChild(a);
      last = m.index + raw.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
}

// ── Consolidated activity block (§5) ─────────────────────────────────────────────
// All the tool/thinking churn for one turn collapses into a single block that previews the
// last few lines and expands on click — so the conversation reads as "what I said" / "what the
// model said" without every Read/Bash/result on its own line. Reset at each new user turn.
// activityEl / activityCount / activityLive / activityTail are declared in the early-init cluster up
// top — resetActivity() touches them at load.
const ACTIVITY_TAIL = 5;

function resetActivity(): void {
  finalizeActivity(); // a prior turn that never saw a clean end (no `result`) left a block spinning — stop it
  activityEl = null;
  activityCount = 0;
  activityLive = false;
  activityTail.length = 0;
}
function ensureActivity(): HTMLDetailsElement {
  if (activityEl && activityEl.isConnected) return activityEl;
  dropSessionHero(); // a turn's activity block is appearing — retire the blank-session title card
  const d = document.createElement("details");
  d.className = "activity live";
  d.innerHTML =
    `<summary><span class="activity-row"><span class="activity-ind"><i></i><i></i><i></i></span>` +
    `<span class="activity-title">Working</span><span class="activity-count"></span>` +
    `<span class="msym activity-chevron">expand_more</span></span>` +
    `<div class="activity-tail"></div></summary><div class="activity-full"></div>`;
  conversation.appendChild(d);
  activityEl = d;
  activityLive = true;
  activityTail.length = 0;
  activityCount = 0;
  hideThinking(); // the activity block's spinner is now the running indicator
  return d;
}
function updateActivityHead(): void {
  if (!activityEl) return;
  const title = activityEl.querySelector(".activity-title");
  if (title) title.textContent = activityLive ? "Working" : "Worked";
  const count = activityEl.querySelector(".activity-count");
  if (count) count.textContent = activityCount ? `· ${activityCount} step${activityCount === 1 ? "" : "s"}` : "";
}
/** Append one step to the current activity block. `preview` is a single-line form shown in the
 *  collapsed tail; `full` (defaults to preview) is the rich form shown when expanded. */
function appendActivityStep(preview: string, full = preview): void {
  const d = ensureActivity();
  activityCount++;
  activityTail.push(preview);
  if (activityTail.length > ACTIVITY_TAIL) activityTail.shift();
  const tail = d.querySelector(".activity-tail");
  if (tail) tail.innerHTML = activityTail.join("");
  const body = d.querySelector<HTMLElement>(".activity-full");
  if (body) {
    body.insertAdjacentHTML("beforeend", full);
    const last = body.lastElementChild as HTMLElement | null;
    if (last) addCopyButtons(last);
  }
  updateActivityHead();
  scrollDown();
}
/** Mark the current activity block finished (turn ended): stop the spinner, relabel. */
function finalizeActivity(): void {
  if (!activityEl) return;
  activityLive = false;
  activityEl.classList.remove("live");
  const ind = activityEl.querySelector(".activity-ind");
  if (ind) ind.innerHTML = icon("check");
  updateActivityHead();
}
function appendToolResult(content: string, isError: boolean): void {
  const text = content.trim();
  const lineCount = text ? text.split("\n").length : 0;
  const first = text.split("\n").find((l) => l.trim()) ?? "(no output)";
  const summary = `${icon(isError ? "error" : "check")} ${isError ? "error" : "result"} · ${lineCount} line${lineCount === 1 ? "" : "s"} · ${esc(first.slice(0, 80))}`;
  const preview = `<div class="tool ${isError ? "result-error" : ""}">${summary}</div>`;
  const full =
    `<details class="tool-result ${isError ? "error" : ""}">` +
    `<summary>${summary}</summary>` +
    `<pre>${esc(text.slice(0, 8000))}${text.length > 8000 ? "\n… (truncated)" : ""}</pre></details>`;
  appendActivityStep(preview, full);
}

// ── Links panel (§links) ────────────────────────────────────────────────────────
// Surface only the links/addresses that appear in Claude's ANSWERS — the URLs and server
// addresses it hands you — not the noise from your pasted prompts or the transitional tool/
// thinking churn mid-turn. References are buffered from each assistant message (`pendingAnswerRefs`)
// and only committed to the panel when the turn ends. The header Links button shows a subtle dot
// (no count) while the panel is closed.
// `references` / `pendingAnswerRefs` are declared in the early-init cluster up top — clearReferences()
// reads them at load.
const REF_LIMIT = 50;

/** Pull http(s) URLs and bare host:port addresses out of a chunk of (rendered) text/HTML. */
function extractRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi)) {
    out.push(m[0].replace(/[.,;:!?)\]}'"]+$/, ""));
  }
  for (const m of text.matchAll(/\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3}):\d{2,5}\b/gi)) {
    out.push(`http://${m[0]}`); // bare address → make it openable
  }
  return out;
}
/** True while a full-history snapshot is replaying: assistant links are added straight away (all of
 *  Claude's past answers are relevant), rather than buffered for a turn-end `result` that won't come. */
let replayingSnapshot = false;
/** Note the links in one assistant message. Live: buffer them as "this turn's answer" so an earlier
 *  message's links are superseded by the final answer's (only it reaches the panel, on `result`).
 *  Replay: add immediately, since each is a finished historical answer. */
function noteAnswerRefs(text: string): void {
  if (replayingSnapshot) addRefs(extractRefs(text));
  else pendingAnswerRefs = extractRefs(text);
}
/** Turn ended: promote the final answer's buffered links into the panel. */
function commitAnswerRefs(): void {
  const urls = pendingAnswerRefs;
  pendingAnswerRefs = [];
  addRefs(urls);
}
/** Add `urls` to the reference set (deduped, capped) and refresh the panel/badge if anything's new. */
function addRefs(urls: string[]): void {
  let added = false;
  for (const url of urls) {
    if (references.has(url)) continue;
    references.set(url, url.replace(/^https?:\/\//, ""));
    added = true;
    if (references.size > REF_LIMIT) references.delete(references.keys().next().value as string);
  }
  if (added) {
    updateLinksBadge();
    if (panelView === "links") renderLinks();
  }
}
function clearReferences(): void {
  references.clear();
  pendingAnswerRefs = [];
  updateLinksBadge();
  if (panelView === "links") renderLinks();
}
/** Reflect on the header Links button whether there are any links (a subtle dot, no count). */
function updateLinksBadge(): void {
  const btn = document.getElementById("btn-links");
  if (!btn) return;
  const n = references.size;
  btn.classList.toggle("has-links", n > 0);
  btn.title = n > 0 ? `Links (${n})` : "Links";
}
function renderLinks(): void {
  panelView = "links";
  setPanelTabs();
  if (references.size === 0) {
    panelContent.innerHTML =
      `<p class="muted small links-empty">No links yet. URLs and server addresses (e.g. <code>http://localhost:3000</code>) Claude mentions show up here.</p>`;
    return;
  }
  const rows = [...references.entries()]
    .reverse() // most-recent first
    .map(
      ([url, label]) =>
        `<li class="link-row"><a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(url)}">${icon("open_in_new")}<span class="link-label">${esc(label)}</span></a>` +
        `<button type="button" class="ref-copy" data-url="${esc(url)}" title="Copy">${icon("content_copy")}</button></li>`,
    )
    .join("");
  panelContent.innerHTML = `<ul class="link-list">${rows}</ul>`;
  panelContent.querySelectorAll<HTMLElement>(".ref-copy").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault();
      const url = b.dataset.url ?? "";
      void copyText(url).then((ok) => {
        b.innerHTML = icon(ok ? "check" : "error");
        setTimeout(() => (b.innerHTML = icon("content_copy")), 1400);
      });
    }),
  );
}

// ── File-offer card (§download) ────────────────────────────────────────────────────
// A deliverable file the model produced, shown as an attachment-style card "from the model",
// with a one-tap download (served by the daemon) and a note when it was also pushed via Taildrop.
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
/** Compact "modified N ago" for the file browser detail column. */
function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.round(d)}d ago`;
  return new Date(ms).toLocaleDateString();
}
function fileOfferIcon(mime: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "movie";
  if (mime.startsWith("audio/")) return "audio_file";
  if (mime === "application/pdf") return "picture_as_pdf";
  if (/zip|tar|gzip|compressed|x-7z|rar/.test(mime)) return "folder_zip";
  if (/spreadsheet|csv|excel/.test(mime)) return "table_chart";
  return "description";
}
function appendFileOffer(file: FileOffer): void {
  const b = bubble("assistant");
  b.className = "bubble assistant file-offer";
  const href = serverApiUrl(activeServer().url, file.downloadUrl);
  const taildrop = file.taildropped ? `<span class="fo-taildrop">${icon("send_to_mobile")} Sent to your device</span>` : "";
  b.innerHTML =
    `<div class="fo-card">` +
    `<span class="fo-icon">${icon(fileOfferIcon(file.mime))}</span>` +
    `<span class="fo-meta"><span class="fo-name" title="${esc(file.name)}">${esc(file.name)}</span>` +
    `<span class="fo-sub">${esc(humanSize(file.size))}${taildrop}</span></span>` +
    `<a class="fo-dl" href="${esc(href)}" download="${esc(file.name)}" title="Download">${icon("download")}</a>` +
    `</div>`;
  scrollDown();
  saveConvoCache();
}
function clearConversation(): void {
  conversation.innerHTML = "";
  streaming = null;
  tailSpacer = null; // detached by the innerHTML reset
  thinkingEl = null; // detached by the innerHTML reset
  turnCanceled = false;
  resetActivity(); // detached by the reset
  clearReferences();
  permCards.clear(); // cards are detached by the reset; the re-surfaced request re-adds them
  questionCards.clear();
  updateComposerMode("idle"); // a freshly cleared pane shows Send, not a stale Stop
}
function renderEmptyState(): void {
  streaming = null;
  thinkingEl = null;
  resetActivity();
  clearReferences();
  // inlined (not a top-level const) so it's safe to call during early module init
  conversation.innerHTML =
    `<div class="empty-state"><img src="/anvil.svg" class="empty-art" alt="Anvil" width="132" height="132" /><p>Select a session, or create a new one.</p></div>`;
}

// ── Session hero (blank-conversation placeholder) ────────────────────────────────
// A freshly created session has no messages yet. Rather than a void, fill the conversation with a
// big, colour-coded title card — the session's icon, name, environment and branch — so it's always
// unmistakable which session (and project) you're about to talk to. Removed the instant any real
// content lands (see dropSessionHero in the content-append paths).
function dropSessionHero(): void {
  conversation.querySelector(".session-hero")?.remove();
  clearAttachDiagnostic(); // real content landed — retire any "couldn't load history" note
}
/** Show the hero iff `activeId` is set and the conversation holds nothing but (optionally) the hero. */
function maybeShowSessionHero(): void {
  if (!activeId) return;
  const s = sessions.get(activeId);
  if (!s) return;
  // Any non-hero child means there's real content (a bubble, activity, card, thinking dots) — no hero.
  if ([...conversation.children].some((c) => !c.classList.contains("session-hero"))) return;
  dropSessionHero(); // avoid stacking duplicates on repeated calls
  const env = s.environmentId ? environments.get(s.environmentId) : undefined;
  const theme = currentTheme();
  const ord = envOrdinal(s, sessions.values());
  const accent = env ? stripeColor(env, ord, theme) : "var(--accent)";
  const bg = env ? sessionBg(env, ord, theme) : "var(--panel)";
  const branch = !s.isDefault ? s.git?.branch : undefined;
  const srv = serverOf(s.id);
  const multi = orderedServers().length > 1;
  const chip = (ic: string, text: string): string => `<span class="hero-chip">${icon(ic)}<span>${esc(text)}</span></span>`;
  const chips = [
    env ? chip("dashboard", env.name) : "",
    branch ? chip("account_tree", branch) : "",
    chip("smart_toy", s.model),
    multi && srv ? chip("dns", srv.name) : "",
  ].join("");
  const hero = document.createElement("div");
  hero.className = "session-hero empty-state"; // empty-state → margin:auto centers it; also stripped from the cache
  hero.style.setProperty("--hero-accent", accent);
  hero.style.setProperty("--hero-bg", bg);
  hero.innerHTML = `<div class="hero-emblem">${icon(sessIcon(s))}</div>
    <h1 class="hero-title">${esc(s.title)}</h1>
    <div class="hero-meta">${chips}</div>
    <p class="hero-hint">${s.pending ? "Queued — will start when you're back online." : "Send a message to get started."}</p>`;
  conversation.appendChild(hero);
}

// ── Attach diagnostic ────────────────────────────────────────────────────────────
// A session can appear in the sidebar (from cache or a peer's list) while the daemon that OWNS it
// isn't reachable/attached from THIS client — most often a fleet member on a phone. The attach then
// goes nowhere and the pane stays blank ("as if it has no chat"). Rather than a silent void, after a
// grace period with no history we surface WHICH server owns it and its live socket state, so the
// failure is legible instead of mysterious. Cleared the moment a snapshot (or any content) lands.
let attachDiagTimer = 0;
function armAttachDiagnostic(id: string): void {
  clearTimeout(attachDiagTimer);
  attachDiagTimer = window.setTimeout(() => maybeShowAttachDiagnostic(id), 6000);
}
function clearAttachDiagnostic(): void {
  clearTimeout(attachDiagTimer);
  conversation.querySelector(".attach-diag")?.remove();
}
function maybeShowAttachDiagnostic(id: string): void {
  if (id !== activeId || snapshotLoaded.has(id)) return; // switched away, or history already arrived
  // Any real content (a bubble/activity/card) means it's working — only the hero/empty may remain.
  if ([...conversation.children].some((c) => !c.classList.contains("session-hero") && !c.classList.contains("empty-state") && !c.classList.contains("attach-diag"))) return;
  const url = sessionServer.get(id);
  const srv = url ? serverByUrl(url) : undefined;
  const status = srv ? srv.status : url ? "unreachable" : "unknown";
  const name = srv?.name ?? (url ? hostOf(url) : "its server");
  const line =
    status === "connected"
      ? `Attached to ${esc(name)} but no history has arrived yet…`
      : `This session lives on ${esc(name)} (${status}). Reconnecting…`;
  conversation.querySelector(".attach-diag")?.remove();
  const el = document.createElement("div");
  el.className = "attach-diag empty-state";
  el.innerHTML = `<p class="small muted">${icon("cloud_off")} ${line}</p><button class="mini" id="attach-diag-retry">${icon("refresh")} Retry</button>`;
  el.querySelector("#attach-diag-retry")?.addEventListener("click", () => {
    ensureOwningServer(id);
    for (const s of servers.values()) s.sock.connectNow();
    clearAttachDiagnostic();
    snapshotLoaded.delete(id);
    sendTo(id, { type: "session.attach", sessionId: id });
    armAttachDiagnostic(id);
  });
  conversation.appendChild(el);
}
/** No session selected: reset the title, show the empty state, drop the persisted active id. */
function deselectSession(): void {
  saveDraft(activeId, input.value); // keep the unsent draft with the session we're leaving
  activeId = null;
  localStorage.removeItem("anvil.active");
  setSessionHash(null, false);
  setHeaderTitle(undefined);
  renderEmptyState();
  renderSessions();
  applyActiveTint();
  restoreDraft(null); // empty the composer (no session selected)
}
// Tint the conversation area to the active session's derived background (cleared when none).
function applyActiveTint(): void {
  const s = activeId ? sessions.get(activeId) : undefined;
  const main = document.getElementById("main");
  if (!main) return;
  if (s?.environmentId) {
    const env = environments.get(s.environmentId);
    main.style.setProperty("--session-active-bg", sessionBg(env, envOrdinal(s, sessions.values()), currentTheme()));
  } else {
    main.style.removeProperty("--session-active-bg");
  }
}
function setStatus(status: string): void {
  // Permission AND question cards are retired individually by their `*.resolved` events (a session
  // can hold several at once during sub-agent fan-out, so a status flip to running_tool/thinking
  // must NOT clear a still-parked sibling). Only a terminal status sweeps any straggler that somehow
  // lost its resolve event.
  if (status === "idle" || status === "error") {
    clearPermissionCards();
    clearQuestionCards();
  }
  const awaiting = status === "awaiting_permission" || status === "awaiting_question";
  if (status === "idle") finalizeActivity(); // turn ended (even if `result` never arrived) — stop the spinner
  if (status === "idle" || awaiting) hideThinking(); // the card is the indicator while parked
  else if (!streaming) showThinking(status); // while text streams, the text is the activity
  updateComposerMode(status); // swap Send ↔ Stop while a turn runs
  const s = activeId ? sessions.get(activeId) : undefined;
  if (s) {
    s.status = status as Session["status"];
    renderSessions();
  }
}

// ── Stop the running turn (§stop) ────────────────────────────────────────────────
const stopBtn = $<HTMLButtonElement>("#stop");
/** While a turn is actively running, a subtle Stop appears to the left of Send. Send itself stays
 *  enabled-when-there's-input (it was getting stuck disabled) — you can queue a follow-up either way. */
function updateComposerMode(status: string): void {
  const busy = status === "thinking" || status === "running_tool";
  stopBtn.hidden = !busy; // Stop shows only while actively thinking/running a tool
}
/** Stop button: interrupt the turn, drop the in-flight thinking/activity, and mark it cancelled —
 *  jumping back to the last prompt with a "Thinking canceled" notice (UI refinement §stop). */
function cancelThinking(): void {
  if (!activeId) return;
  sendTo(activeId, { type: "interrupt", sessionId: activeId });
  turnCanceled = true; // suppress the trailing churn the daemon is still draining
  if (streamRaf) {
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
  }
  streaming?.remove(); // drop the partial streaming answer
  streaming = null;
  streamText = "";
  if (activityEl && activityLive) activityEl.remove(); // remove the in-flight activity block
  resetActivity();
  hideThinking();
  pendingAnswerRefs = [];
  const note = document.createElement("div");
  note.className = "turn-canceled";
  note.innerHTML = `${icon("cancel")} Thinking canceled`;
  conversation.appendChild(note);
  setStatus("idle"); // also hides the spinner and restores the Send button
  scrollDown(true);
  saveConvoCache();
}
stopBtn.addEventListener("click", cancelThinking);

// ── Copy-to-clipboard ─────────────────────────────────────────────────────────────
/** Copy `text` to the clipboard (with a legacy fallback for non-secure contexts). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
/** Add a one-click copy button to every code block under `root` (commands, snippets, output). */
function addCopyButtons(root: HTMLElement): void {
  for (const pre of root.querySelectorAll<HTMLElement>("pre")) {
    if (pre.parentElement?.classList.contains("code-wrap") || pre.classList.contains("mermaid")) continue;
    const code = pre.textContent ?? "";
    if (!code.trim()) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.title = "Copy";
    btn.innerHTML = icon("content_copy");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void copyText(code).then((ok) => {
        btn.innerHTML = icon(ok ? "check" : "error");
        btn.classList.toggle("copied", ok);
        setTimeout(() => {
          btn.innerHTML = icon("content_copy");
          btn.classList.remove("copied");
        }, 1400);
      });
    });
    // Pin the button to a non-scrolling wrapper, not the <pre> itself: an absolutely-positioned
    // child of the horizontally-scrolling <pre> would drift left as the code scrolls.
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    pre.before(wrap);
    wrap.appendChild(pre);
    wrap.appendChild(btn);
  }
}

// ── Link & attachment actions (copy / download) ───────────────────────────────────
// Every URL link and file attachment in a message gets copy + download affordances.
//   • Desktop / web: a small icon-only bar floats over the target's top-right on hover.
//   • Android: a long-press opens a menu with the same actions (native callout suppressed).
// "Copy" adapts to the target — an image copies its bits, everything else copies the URL.
type ActionTarget = { host: HTMLElement; url: string; name: string; isImage: boolean };

/** Best-effort filename from a URL path (falls back to a generic name). */
function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last && /\.[a-z0-9]{1,8}$/i.test(last)) return decodeURIComponent(last);
  } catch {
    /* not a parseable URL — use the fallback */
  }
  return fallback;
}

/** Resolve the copy/download target for an event target, walking up to a link or attachment. */
function actionTargetFor(el: EventTarget | null): ActionTarget | null {
  const start = el instanceof HTMLElement ? el : null;
  if (!start) return null;
  const img = start.closest<HTMLImageElement>("#conversation .att-img");
  if (img) return { host: img, url: img.src, name: fileNameFromUrl(img.src, "image.png"), isImage: true };
  const chip = start.closest<HTMLAnchorElement>("#conversation a.att-file");
  if (chip) {
    const name = chip.querySelector(".att-name")?.textContent?.trim() || fileNameFromUrl(chip.href, "file");
    return { host: chip, url: chip.href, name, isImage: false };
  }
  // A plain URL link in message prose (skip in-app file links, which open the reader, not a URL).
  const a = start.closest<HTMLAnchorElement>("#conversation .md a[href]");
  if (a && !a.classList.contains("file-link") && /^https?:/i.test(a.href)) {
    return { host: a, url: a.href, name: fileNameFromUrl(a.href, "download"), isImage: false };
  }
  return null;
}

/** Re-encode any image blob to PNG (the format the async clipboard reliably accepts) via a canvas. */
function blobToPng(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const obj = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas");
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return (URL.revokeObjectURL(obj), reject(new Error("no 2d context")));
      ctx.drawImage(im, 0, 0);
      c.toBlob((b) => {
        URL.revokeObjectURL(obj);
        b ? resolve(b) : reject(new Error("toBlob failed"));
      }, "image/png");
    };
    im.onerror = () => (URL.revokeObjectURL(obj), reject(new Error("image decode failed")));
    im.src = obj;
  });
}

/** Copy an image's actual bits to the clipboard (PNG). Returns false if the platform can't. */
async function copyImageFromUrl(url: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
    const blob = await (await fetch(url)).blob();
    const png = blob.type === "image/png" ? blob : await blobToPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

/** The "copy" action: image → its bits (falling back to the URL); anything else → the URL. */
async function copyTarget(t: ActionTarget): Promise<boolean> {
  if (t.isImage && (await copyImageFromUrl(t.url))) return true;
  return copyText(t.url);
}

/** Save a URL to a file. Fetch→blob keeps same-origin attachments as true downloads; on a
 *  cross-origin failure, fall back to opening it (the browser may still offer to save). */
async function downloadTarget(t: ActionTarget): Promise<boolean> {
  try {
    const res = await fetch(t.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const obj = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = obj;
    a.download = t.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(obj), 4000);
    return true;
  } catch {
    window.open(t.url, "_blank", "noopener");
    return false;
  }
}

// Flag the platform on <html> so CSS can suppress the native long-press callout on links/attachments.
document.documentElement.classList.toggle("is-android", isAndroidApp);

// ── Desktop / web: floating icon bar on hover ──
const linkActions = document.createElement("div");
linkActions.id = "link-actions";
linkActions.hidden = true;
linkActions.innerHTML =
  `<button type="button" class="la-btn" data-act="copy">${icon("content_copy")}</button>` +
  `<button type="button" class="la-btn" data-act="download" title="Download">${icon("download")}</button>`;
document.body.appendChild(linkActions);
let laTarget: ActionTarget | null = null;
let laHideTimer = 0;

function positionLinkActions(t: ActionTarget): void {
  const r = t.host.getBoundingClientRect();
  linkActions.hidden = false;
  const w = linkActions.offsetWidth;
  linkActions.style.top = `${Math.max(4, r.top + 4)}px`;
  linkActions.style.left = `${Math.min(window.innerWidth - w - 4, Math.max(4, r.right - w - 4))}px`;
  (linkActions.querySelector('.la-btn[data-act="copy"]') as HTMLElement).title = t.isImage ? "Copy image" : "Copy link";
}
function showLinkActions(t: ActionTarget): void {
  clearTimeout(laHideTimer);
  if (laTarget?.host === t.host && !linkActions.hidden) return; // already up for this target
  laTarget = t;
  positionLinkActions(t);
}
function hideLinkActions(): void {
  linkActions.hidden = true;
  laTarget = null;
}
function scheduleHideLinkActions(): void {
  clearTimeout(laHideTimer);
  laHideTimer = window.setTimeout(hideLinkActions, 160);
}

function flashActionBtn(btn: HTMLElement, done: Promise<boolean>, restore: string): void {
  void done.then((ok) => {
    btn.innerHTML = icon(ok ? "check" : "error");
    btn.classList.toggle("done", ok);
    setTimeout(() => {
      btn.innerHTML = icon(restore);
      btn.classList.remove("done");
    }, 1400);
  });
}

conversation.addEventListener("mouseover", (e) => {
  if (isAndroidApp) return; // Android uses long-press, not hover
  const t = actionTargetFor(e.target);
  if (t) showLinkActions(t);
});
conversation.addEventListener("mouseout", (e) => {
  if (isAndroidApp) return;
  const to = e.relatedTarget;
  if (to instanceof HTMLElement && (to.closest("#link-actions") || actionTargetFor(to)?.host === laTarget?.host)) return;
  scheduleHideLinkActions();
});
linkActions.addEventListener("mouseenter", () => clearTimeout(laHideTimer));
linkActions.addEventListener("mouseleave", scheduleHideLinkActions);
linkActions.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>(".la-btn");
  if (!btn || !laTarget) return;
  e.preventDefault();
  e.stopPropagation();
  const t = laTarget;
  if (btn.dataset.act === "download") flashActionBtn(btn, downloadTarget(t), "download");
  else flashActionBtn(btn, copyTarget(t), "content_copy");
});

// ── Android: long-press action menu ──
const linkMenu = document.createElement("div");
linkMenu.id = "link-menu";
linkMenu.hidden = true;
document.body.appendChild(linkMenu);
let menuTarget: ActionTarget | null = null;

function hideLinkMenu(): void {
  linkMenu.hidden = true;
  menuTarget = null;
}
function openLinkMenu(t: ActionTarget, x: number, y: number): void {
  menuTarget = t;
  linkMenu.innerHTML =
    `<button type="button" class="lm-item" data-act="copy">${icon("content_copy")}<span>${t.isImage ? "Copy image" : "Copy link"}</span></button>` +
    `<button type="button" class="lm-item" data-act="download">${icon("download")}<span>Download</span></button>`;
  linkMenu.hidden = false;
  const w = linkMenu.offsetWidth;
  const h = linkMenu.offsetHeight;
  linkMenu.style.left = `${Math.min(Math.max(8, x), window.innerWidth - w - 8)}px`;
  linkMenu.style.top = `${Math.min(Math.max(8, y), window.innerHeight - h - 8)}px`;
}
linkMenu.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>(".lm-item");
  if (!item || !menuTarget) return;
  const t = menuTarget;
  const act = item.dataset.act;
  hideLinkMenu();
  if (act === "download") void downloadTarget(t).then((ok) => toast(ok ? "Downloading…" : "Opened in a new tab"));
  else void copyTarget(t).then((ok) => toast(ok ? (t.isImage ? "Image copied" : "Link copied") : "Couldn't copy"));
});

let pressTimer = 0;
let pressTarget: ActionTarget | null = null;
let pressX = 0;
let pressY = 0;
conversation.addEventListener(
  "touchstart",
  (e) => {
    const touch = e.touches[0];
    if (!isAndroidApp || e.touches.length !== 1 || !touch) return;
    const t = actionTargetFor(e.target);
    if (!t) return;
    pressTarget = t;
    pressX = touch.clientX;
    pressY = touch.clientY;
    clearTimeout(pressTimer);
    pressTimer = window.setTimeout(() => {
      if (pressTarget) openLinkMenu(pressTarget, pressX, pressY);
    }, 500);
  },
  { passive: true },
);
conversation.addEventListener(
  "touchmove",
  (e) => {
    const touch = e.touches[0];
    if (!pressTarget || !touch) return;
    if (Math.abs(touch.clientX - pressX) > 10 || Math.abs(touch.clientY - pressY) > 10) {
      clearTimeout(pressTimer);
      pressTarget = null;
    }
  },
  { passive: true },
);
conversation.addEventListener("touchend", () => {
  clearTimeout(pressTimer);
  pressTarget = null;
});
// A long-press we've claimed shouldn't also raise the WebView's native link/image menu.
conversation.addEventListener("contextmenu", (e) => {
  if (isAndroidApp && actionTargetFor(e.target)) e.preventDefault();
});
// Tap elsewhere dismisses the menu; scrolling dismisses both floating layers.
document.addEventListener(
  "touchstart",
  (e) => {
    if (!linkMenu.hidden && !(e.target as HTMLElement).closest("#link-menu")) hideLinkMenu();
  },
  { capture: true },
);
conversation.addEventListener("scroll", () => {
  hideLinkActions();
  hideLinkMenu();
});

// ── Mermaid (lazy) ──────────────────────────────────────────────────────────────
let mermaidReady: Promise<any> | null = null;
async function runMermaid(container: HTMLElement): Promise<void> {
  const nodes = [...container.querySelectorAll<HTMLElement>("pre.mermaid")];
  if (nodes.length === 0) return;
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: currentTheme() === "dark" ? "dark" : "default" });
      return m.default;
    });
  }
  const mermaid = await mermaidReady;
  for (const node of nodes) {
    try {
      const id = "m" + Math.random().toString(36).slice(2);
      const { svg } = await mermaid.render(id, node.textContent ?? "");
      node.innerHTML = svg;
    } catch {
      /* leave the source text in place */
    }
  }
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
function renderSessions(): void {
  if (dragging) return; // don't yank a row out from under an in-progress drag
  const conciergeUl = $("#concierge-list");
  const activeUl = $("#session-list");
  const finishedUl = $("#finished-list");
  conciergeUl.innerHTML = "";
  activeUl.innerHTML = "";
  finishedUl.innerHTML = "";
  const ord = (s: Session): number => s.order ?? -1; // server sort key; unset (new) sessions sort to the top
  const sortFn = (a: Session, b: Session): number =>
    Number(!!b.isDefault) - Number(!!a.isDefault) ||
    Number(!!a.archived) - Number(!!b.archived) ||
    ord(a) - ord(b);
  const all = [...sessions.values()];
  // The concierge (isDefault) is pinned at the top, OUTSIDE the sortable/grouped lists (#26).
  for (const s of all.filter((s) => s.isDefault)) conciergeUl.appendChild(renderSessionItem(s));
  const rest = all.filter((s) => !s.isDefault);
  const anyFinished = rest.some((s) => s.finished);

  // Teams: a member (parentId → a lead we know) is NOT rendered at the top level — it appears nested
  // under its lead's row instead (anvil-team-support.md §5).
  const isNestedMember = (s: Session): boolean => !!s.parentId && sessions.has(s.parentId);

  // One flat list across every server — no per-machine grouping. Sessions interleave by their
  // server-synced order; which machine a session lives on is shown subtly in its row meta when
  // there's more than one server. (fleet — anvil-multi-server.md §4)
  for (const s of rest.filter((s) => !isNestedMember(s)).sort(sortFn)) {
    const li = renderSessionItem(s);
    (s.finished ? finishedUl : activeUl).appendChild(li);
    if (s.teamRole === "lead") {
      const members = membersOfLead(s.id).sort(sortFn);
      if (members.length) {
        const mul = document.createElement("ul");
        mul.className = "team-members";
        for (const m of members) mul.appendChild(renderSessionItem(m, true));
        li.appendChild(mul);
      }
    }
  }
  $("#finished-section").hidden = !anyFinished; // hide the group when nothing is finished
}

/** A lead's member sessions (nested under it in the sidebar), across all servers. */
function membersOfLead(leadId: string): Session[] {
  return [...sessions.values()].filter((s) => s.parentId === leadId);
}

/** Roll a lead's members up to counts for its sidebar chip — derived live from the member sessions
 *  (kept in sync by session.updated), so it's correct even before the first `team.info`. */
function leadRollup(leadId: string): { total: number; running: number; awaiting: number; done: number; error: number } {
  const r = { total: 0, running: 0, awaiting: 0, done: 0, error: 0 };
  for (const m of membersOfLead(leadId)) {
    r.total++;
    if (m.status === "thinking" || m.status === "running_tool") r.running++;
    else if (m.status === "awaiting_permission" || m.status === "awaiting_question") r.awaiting++;
    else if (m.status === "error") r.error++;
    else if (m.status === "idle" || m.status === "exited") r.done++;
  }
  return r;
}

/** A compact "3 · 2▶ · 1⏳ · 1⚠" chip for a lead row; empty when the lead has no members yet. */
function teamRollupChip(r: { total: number; running: number; awaiting: number; done: number; error: number }): string {
  if (r.total === 0) return "";
  const parts = [`${r.total}`];
  if (r.running) parts.push(`${r.running}▶`);
  if (r.awaiting) parts.push(`${r.awaiting}⏳`);
  if (r.done) parts.push(`${r.done}✓`);
  if (r.error) parts.push(`${r.error}⚠`);
  const title = `${r.total} member(s): ${r.running} running, ${r.awaiting} need approval, ${r.done} done, ${r.error} error`;
  return `<span class="team-rollup" title="${esc(title)}">${parts.join(" · ")}</span>`;
}

/** The lead's member board + plan-gate card, rendered above its conversation (anvil-team-support.md
 *  §5). A member row deep-links to that member (selecting it makes its cards routable). Hidden unless
 *  the active session is a lead. */
function renderTeamBoard(lead: Session | undefined): void {
  const el = document.getElementById("team-board");
  if (!el) return;
  if (!lead || lead.teamRole !== "lead" || lead.id !== activeId) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  const members = membersOfLead(lead.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const pending = pendingTeamPlans.get(lead.id);
  const policy = lead.team?.integration ?? "combined-pr";

  const planCard = pending
    ? `<div class="team-plan-card">
         <div class="tpc-head">${icon("groups")}<span>Proposed team plan · ${esc(pending.integration)}</span></div>
         <ol class="tpc-members">${pending.members
           .map((m) => `<li><b>${esc(m.title)}</b> — ${esc(m.task)}${m.dependsOn?.length ? ` <span class="tpc-dep">after ${esc(m.dependsOn.join(", "))}</span>` : ""}</li>`)
           .join("")}</ol>
         <div class="tpc-actions">
           <button class="tpc-approve" data-lead="${esc(lead.id)}">Approve &amp; spawn</button>
           <button class="tpc-reject" data-lead="${esc(lead.id)}">Reject</button>
         </div>
       </div>`
    : "";

  const rows = members
    .map((m) => {
      const dot = statusDotClass(m.status);
      const git = m.git ? `${m.git.dirtyFileCount ? `${m.git.dirtyFileCount}●` : ""}${m.git.ahead ? ` ↑${m.git.ahead}` : ""}`.trim() : "";
      const pr = m.git?.prState ? `<span class="tmb-pr ${esc(m.git.prState)}">${esc(m.git.prState)}</span>` : "";
      return `<div class="tmb-row" data-id="${esc(m.id)}" role="button" tabindex="0">
        <span class="tmb-dot ${dot}"></span>
        <span class="tmb-task">${esc(m.memberTask ?? m.title)}</span>
        <span class="tmb-meta">${esc(m.status)}${git ? ` · ${esc(git)}` : ""}</span>
        ${pr}
      </div>`;
    })
    .join("");

  const canIntegrate = members.length > 0 && !pending;
  el.innerHTML = `${planCard}
    <div class="team-board-head">
      <span>${icon("groups")} Team · ${members.length} member(s) · ${esc(policy)}</span>
      ${canIntegrate ? `<button class="tmb-integrate" data-lead="${esc(lead.id)}">Integrate</button>` : ""}
    </div>
    <div class="tmb-rows">${rows || `<div class="tmb-empty">No members yet.</div>`}</div>`;

  el.querySelectorAll<HTMLElement>(".tmb-row").forEach((row) =>
    row.addEventListener("click", () => { const id = row.dataset.id; if (id) selectSession(id); }),
  );
  el.querySelector(".tpc-approve")?.addEventListener("click", () => {
    if (pending) sendTo(lead.id, { type: "team.plan.approve", sessionId: lead.id, plan: pending, cid: newCid() });
  });
  el.querySelector(".tpc-reject")?.addEventListener("click", () =>
    sendTo(lead.id, { type: "team.plan.reject", sessionId: lead.id, cid: newCid() }),
  );
  el.querySelector(".tmb-integrate")?.addEventListener("click", () =>
    sendTo(lead.id, { type: "team.integrate", sessionId: lead.id, cid: newCid() }),
  );
}

/** Map a session status to a colored status-dot class for the member board. */
function statusDotClass(status: Session["status"]): string {
  if (status === "thinking" || status === "running_tool") return "running";
  if (status === "awaiting_permission" || status === "awaiting_question") return "awaiting";
  if (status === "error") return "error";
  return "idle";
}

function renderSessionItem(s: Session, isMember = false): HTMLLIElement {
  const removing = removingSessions.has(s.id);
  const awaiting = !removing && !s.pending && !s.archived && (s.status === "awaiting_permission" || s.status === "awaiting_question");
  const li = document.createElement("li");
  li.className = `session${s.id === activeId ? " active" : ""}${s.archived ? " archived" : ""}${s.pending ? " pending" : ""}${awaiting ? " awaiting" : ""}${removing ? " removing" : ""}${isMember ? " member" : ""}`;
  li.dataset.id = s.id;
  if (s.environmentId && !removing) {
    const env = environments.get(s.environmentId);
    const ord = envOrdinal(s, sessions.values());
    const theme = currentTheme();
    li.classList.add("tinted");
    li.style.setProperty("--session-bg", sessionBg(env, ord, theme));
    li.style.setProperty("--session-stripe", stripeColor(env, ord, theme));
  }
  const envName = s.environmentId ? environments.get(s.environmentId)?.name : undefined;
  const where = envName ?? s.git?.branch ?? s.source;
  const tag = removing ? "cleaning up…" : s.pending ? "pending sync" : s.archived ? "archived" : awaiting ? "needs approval" : esc(s.status);
  // With a fleet, the list is flat (no per-machine sections), so name the owning server inline.
  const srv = serverOf(s.id);
  const machine = orderedServers().length > 1 && srv ? ` · ${icon("dns")}${esc(srv.name)}` : "";
  const a = document.createElement("a");
  a.className = "srow";
  a.href = sessionHref(s.id);
  const merged = s.git?.prState === "merged" ? `<span class="merged-badge" title="PR merged">${icon("merge")}</span>` : "";
  const rollup = s.teamRole === "lead" ? teamRollupChip(leadRollup(s.id)) : "";
  // A member row leads its meta with the task the lead assigned it (anvil-team-support.md §5).
  const memberMeta = isMember && s.memberTask ? `${esc(s.memberTask)} · ` : "";
  a.innerHTML = `<div class="title">${icon(removing ? "cleaning_services" : sessIcon(s))}<span class="t">${esc(s.title)}</span>${merged}${rollup}</div><div class="meta">${memberMeta}${esc(where)} · ${tag} · ${esc(s.model)}${machine}</div>`;
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a new tab
    e.preventDefault();
    if (justDragged) return; // a drag just ended on this row — don't also navigate
    if (!removing) selectSession(s.id); // a session being cleaned up isn't selectable
  });
  li.append(a);
  if (s.isDefault) {
    // The concierge is pinned; the new-session "+" lives in the sidebar header (see #new-session-top).
  } else if (!removing) {
    const open = document.createElement("button");
    open.className = "row-btn open-tab";
    open.title = "Open in new tab";
    open.innerHTML = icon("open_in_new");
    open.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(sessionHref(s.id), "_blank");
    });
    li.append(open);
  }
  return li;
}

// ── Drag-to-reorder (SortableJS) ────────────────────────────────────────────────────────────────
// The active-session list and the Finished group are two linked sortables sharing one group, so a
// row can be dragged from either into the other (and back out of Finished). forceFallback uses
// SortableJS's own cloned-element drag rather than native HTML5 DnD — which never fires on touch —
// so it behaves identically on desktop and in the Android WebView. delayOnTouchOnly + a touch
// threshold give the familiar press-and-hold-then-drag feel on touch while keeping an immediate grab
// with the mouse. The pinned concierge row lives in its own list (not a sortable), so it can't be
// reordered or dropped into Finished. `dragging`/`justDragged` are declared in the early-init cluster.
let sortablesReady = false;
function initSortables(): void {
  if (sortablesReady) return;
  sortablesReady = true;
  const opts: Sortable.Options = {
    group: "sessions",
    draggable: ".session",
    filter: ".row-btn", // taps on the open-tab / + buttons must not begin a drag
    preventOnFilter: false, // …and must still fire their own click
    animation: 150,
    delay: 250, // press-and-hold before a touch drag engages
    delayOnTouchOnly: true, // mouse drags start immediately
    touchStartThreshold: 9, // a small finger move within the delay = scroll, so abandon the drag
    forceFallback: true, // cloned-element fallback everywhere: touch-safe and consistent
    fallbackClass: "session-fallback",
    fallbackOnBody: true,
    ghostClass: "session-ghost",
    chosenClass: "session-chosen",
    scroll: true, // auto-scroll a list when dragging near its edges
    scrollSensitivity: 48,
    onStart: () => {
      dragging = true;
      $("#finished-section").hidden = false; // reveal the (possibly empty) drop target
      navigator.vibrate?.(12); // "picked up" haptic where supported
    },
    onEnd: () => {
      dragging = false;
      justDragged = true;
      setTimeout(() => (justDragged = false), 350); // swallow the click the drop synthesizes
      commitOrderFromDom(); // read the settled DOM order, sync to the daemon, and re-render
    },
  };
  Sortable.create($("#session-list"), opts);
  Sortable.create($("#finished-list"), opts);
}
/** Read both lists' DOM order → order + Finished membership, apply optimistically, sync to the daemon. */
function commitOrderFromDom(): void {
  const ids = (sel: string): string[] =>
    // `:scope > .session` = only the list's OWN rows, never a lead's nested member rows (teams §5).
    [...$(sel).querySelectorAll<HTMLElement>(":scope > .session")].map((el) => el.dataset.id).filter((x): x is string => !!x);
  const active = ids("#session-list");
  const finished = ids("#finished-list");
  const order = [...active, ...finished];
  const fin = new Set(finished);
  order.forEach((id, i) => {
    const s = sessions.get(id);
    if (s) {
      s.order = i;
      s.finished = fin.has(id);
    }
  });
  persistSessions(); // keep the offline cache in step
  // order/finished live on each session's own daemon, so send every server only its own subset
  // (cross-server interleaving is visual; within a server the relative order is preserved).
  for (const srv of servers.values()) {
    const subset = order.filter((id) => sessionServer.get(id) === srv.url);
    if (subset.length) srv.sock.send({ type: "session.arrange", order: subset, finished: subset.filter((id) => fin.has(id)) });
  }
  renderSessions();
}
function setHeaderTitle(s: Session | undefined): void {
  $("#header-title").innerHTML = s ? `${icon(sessIcon(s))}<span class="ht">${esc(s.title)}</span>` : `<span class="ht">Anvil</span>`;
  document.title = s ? `Anvil: ${s.title}` : "Anvil";
  $("#btn-new-topic").hidden = !s?.isDefault; // "New topic" only applies to the persistent concierge chat
  updateHeaderBranch(s);
  updateHeaderModel(s);
  updateContextMeter(s);
  renderTeamBoard(s); // show the member board when a lead is active; hide it otherwise
  void setFavicon(s);
}
/** Show the active session's git branch as a chip in the header; tap it to open the Git panel. */
function updateHeaderBranch(s: Session | undefined): void {
  const el = document.getElementById("header-branch");
  if (!el) return;
  const branch = s && !s.isDefault ? s.git?.branch : undefined;
  if (branch) {
    el.innerHTML = `${icon("account_tree")}<span class="hb-name">${esc(branch)}</span>`;
    el.title = `On branch ${branch} — open Git`;
    el.hidden = false;
  } else {
    el.innerHTML = "";
    el.hidden = true;
  }
}
$("#header-branch").addEventListener("click", () => (panelView === "git" ? closePanel() : openPanel("git")));

/** Show the active session's model as a pill in the composer (next to Attach); tap it to switch. */
function updateHeaderModel(s: Session | undefined): void {
  const el = document.getElementById("btn-model");
  if (!el) return;
  if (s) {
    el.innerHTML = `${icon("smart_toy")}<span class="cm-name">${esc(modelLabel(s.model))}</span>`;
    el.title = "Switch model";
    el.hidden = false;
  } else {
    el.innerHTML = "";
    el.hidden = true;
  }
}
/** Compact a token count for the meter tooltip: 187000 → "187k", 940 → "940". */
function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
/**
 * Context-window meter (§context): a small pill next to the model showing how full the current topic's
 * context is. Hidden until the first turn reports; goes amber past 75% and red past 90% to cue a
 * `/compact`. Fed by `session.context` (the daemon's read of the SDK's own context bar).
 */
function updateContextMeter(s: Session | undefined): void {
  const el = document.getElementById("ctx-meter");
  if (!el) return;
  const ctx = s?.context;
  if (!ctx || !ctx.max) {
    el.hidden = true;
    el.className = "ctx-meter";
    el.replaceChildren();
    return;
  }
  const pct = Math.min(100, Math.round((ctx.used / ctx.max) * 100));
  el.hidden = false;
  el.className = "ctx-meter" + (pct >= 90 ? " hot" : pct >= 75 ? " warm" : "");
  el.innerHTML = `${icon("data_usage")}<span class="ctx-pct">${pct}%</span>`;
  el.title = `Context window: ${fmtK(ctx.used)} / ${fmtK(ctx.max)} tokens (${pct}%). Send /compact to free space, or /clear to start fresh.`;
}
// Tapping the model pill opens a menu of the available models; picking one switches this session
// live (session.set_model takes effect on the next message — no restart). A ✓ marks the current one.
$("#btn-model").addEventListener("click", () => {
  const s = activeId ? sessions.get(activeId) : undefined;
  if (!s) return;
  toggleHeaderMenu(
    $("#btn-model"),
    MODELS.map((m) => ({
      icon: m.id === s.model ? "check" : "smart_toy",
      label: m.label,
      title: m.id === s.model ? `${m.label} (current)` : `Switch to ${m.label}`,
      run: () => {
        if (m.id === s.model) return;
        sendTo(activeId, { type: "session.set_model", sessionId: activeId, model: m.id });
      },
    })),
  );
});

// ── Favicon: mirror the active session's Material Symbol; fall back to the brand mark ────────────
const DEFAULT_FAVICON = "/anvil.svg";
let faviconToken = 0; // guards against a slow render landing after a faster session switch
/** Paint a Material Symbols glyph (drawn via the font's ligatures) onto a canvas → PNG data URI. */
async function glyphFaviconUrl(name: string): Promise<string> {
  const size = 64;
  const font = `${Math.round(size * 0.82)}px "Material Symbols Rounded"`;
  await document.fonts.load(font, name); // ensure the icon font is ready before we paint
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3b6ef5";
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, size / 2, size / 2 + size * 0.04); // tiny nudge so the glyph sits optically centered
  return canvas.toDataURL("image/png");
}
async function setFavicon(s: Session | undefined): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  const token = ++faviconToken;
  if (!s) {
    link.type = "image/svg+xml";
    link.href = DEFAULT_FAVICON;
    return;
  }
  try {
    const url = await glyphFaviconUrl(sessIcon(s));
    if (token === faviconToken) {
      link.type = "image/png";
      link.href = url;
    }
  } catch {
    if (token === faviconToken) {
      link.type = "image/svg+xml";
      link.href = DEFAULT_FAVICON; // canvas/font unavailable → keep the brand mark
    }
  }
}
function onEnvironments(url: string, list: Environment[]): void {
  // Replace only THIS server's environments (others stay), and tag each with its server.
  for (const [eid, u] of [...envServer]) if (u === url) { envServer.delete(eid); environments.delete(eid); }
  for (const e of list) {
    environments.set(e.id, e);
    envServer.set(e.id, url);
  }
  persistEnvironments();
  persistRouting();
  renderSessions();
  applyActiveTint();
  if (document.getElementById("ns-modal")) showNewSession(); // refresh an open new-session modal
  if (document.getElementById("env-cards")) renderEnvCards(); // refresh an open settings view
}

// ── Prompt library ────────────────────────────────────────────────────────────
// Reusable prompt snippets the user authors in Settings → Prompts and fires into the composer with
// one click from the header's Prompts dropdown. Stored on the daemon and broadcast to every connected
// client so the library syncs across all of a user's devices. Hub-authoritative (like the Todoist
// link / model auth): the store lives on the hub daemon and every prompt.* command routes there — a
// fleet member's own prompts event is ignored so it can't clobber the hub's.
//
// The list + its localStorage cache (so the header button paints instantly on load / offline) are
// declared up in the State section — before the instant-restore render — to stay out of the TDZ. The
// hub's `prompts` event is the source of truth and overwrites the cache on connect.

/** Prompts sorted by short title (the button label), case-insensitive — the display + sidebar order. */
function sortedPrompts(): Prompt[] {
  return [...prompts].sort((a, b) => (a.shortTitle || a.title).localeCompare(b.shortTitle || b.title, undefined, { sensitivity: "base" }));
}
/** Apply a `prompts` broadcast from the hub: replace the list, cache it, repaint. */
function onPrompts(list: Prompt[]): void {
  prompts = list;
  try {
    localStorage.setItem(PROMPTS_CACHE_KEY, JSON.stringify(list));
  } catch {
    /* quota — the daemon is still the source of truth */
  }
  refreshPromptsButton();
  if (document.getElementById("prompt-cards")) renderPromptsPanel();
}
/** True once the hub is connected AND new enough to hold the prompt store. */
function promptsSupported(): boolean {
  return hub().sock.isOpen() && serverSupports(hub(), "prompts");
}

/** Append a prompt body to the composer; if there's already text, drop it onto a new line. */
function insertPrompt(body: string): void {
  const cur = input.value;
  input.value = cur ? `${cur}\n${body}` : body;
  saveDraft(activeId, input.value);
  autoGrow();
  updateSendState();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.scrollTop = input.scrollHeight;
}

/** Show/hide the header's Prompts button by whether the library holds any prompts. The dropdown of
 *  prompts is built on demand when the button is clicked (see the #btn-prompts handler). */
function refreshPromptsButton(): void {
  const btn = document.getElementById("btn-prompts");
  if (btn) btn.hidden = sortedPrompts().length === 0;
}

/** Settings → Prompts: the editable list of saved prompts. */
function renderPromptsPanel(): void {
  const host = document.getElementById("prompt-cards");
  if (!host) return;
  const prompts = sortedPrompts();
  if (!prompts.length) {
    host.innerHTML = `<p class="small muted">No prompts yet. Add one and it appears in the Prompts menu in the header.</p>`;
    return;
  }
  host.innerHTML = prompts
    .map(
      (p) => `<div class="card prompt-card" data-id="${esc(p.id)}">
        <div class="prompt-card-main">
          <span class="env-glyph msym">${esc(p.icon || "bookmark")}</span>
          <div class="prompt-card-meta">
            <b>${esc(p.title || p.shortTitle)}</b>
            <div class="small muted">Button: ${icon(p.icon || "bookmark")} ${esc(p.shortTitle || p.title)}</div>
          </div>
          <div class="prompt-card-actions">
            <button class="mini prompt-edit" data-id="${esc(p.id)}">${icon("edit")} Edit</button>
            <button class="mini prompt-del" data-id="${esc(p.id)}">${icon("delete")} Delete</button>
          </div>
        </div>
      </div>`,
    )
    .join("");
  host.querySelectorAll<HTMLElement>(".prompt-edit").forEach((b) => b.addEventListener("click", () => showEditPrompt(b.dataset.id)));
  host.querySelectorAll<HTMLElement>(".prompt-del").forEach((b) =>
    b.addEventListener("click", async () => {
      const p = prompts.find((x) => x.id === b.dataset.id);
      if (!p) return;
      const ok = await confirmDialog({ title: "Delete prompt?", body: `"${p.title || p.shortTitle}" will be removed from every device.`, confirmLabel: "Delete", danger: true, icon: "delete" });
      if (ok) hub().sock.send({ type: "prompt.remove", id: p.id, cid: newCid() });
    }),
  );
}

/** Add (no id) or edit an existing prompt in a modal: title, short title, icon, and markdown body. */
function showEditPrompt(id?: string): void {
  if (!promptsSupported()) {
    toast(hub().sock.isOpen() ? "This server is too old for synced prompts — update it." : "Connect to your server to edit prompts.");
    return;
  }
  const existing = id ? prompts.find((p) => p.id === id) : undefined;
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>${existing ? "Edit prompt" : "New prompt"}</h3>
    <label>Title<input id="pe-title" placeholder="e.g. Write unit tests" value="${esc(existing?.title ?? "")}" /></label>
    <label>Short title (button label)<input id="pe-short" placeholder="e.g. Tests" value="${esc(existing?.shortTitle ?? "")}" /></label>
    ${iconPickerMarkup(existing?.icon)}
    <label>Prompt (markdown)<textarea id="pe-body" class="prompt-body-input" rows="8" placeholder="The text inserted into the chat box…">${esc(existing?.body ?? "")}</textarea></label>
    <div class="prompt-preview-head small muted">Preview</div>
    <div id="pe-preview" class="md prompt-preview"></div>
    <div class="btns"><button type="button" id="pe-cancel">Cancel</button><button type="button" id="pe-save" class="primary">${existing ? "Save" : "Add"}</button></div></div>`;
  showModal(m);
  wireIconPicker();
  const bodyEl = $<HTMLTextAreaElement>("#pe-body");
  const preview = $("#pe-preview");
  const renderPreview = (): void => {
    preview.innerHTML = bodyEl.value.trim() ? streamMd.render(bodyEl.value) : `<p class="small muted">Nothing to preview yet.</p>`;
  };
  bodyEl.addEventListener("input", renderPreview);
  renderPreview();
  $<HTMLButtonElement>("#pe-cancel").onclick = closeModal;
  $<HTMLButtonElement>("#pe-save").onclick = () => {
    const title = $<HTMLInputElement>("#pe-title").value.trim();
    const shortTitle = $<HTMLInputElement>("#pe-short").value.trim();
    const body = bodyEl.value.trim();
    if (!body) {
      toast("Add some prompt text first.");
      return;
    }
    if (!title && !shortTitle) {
      toast("Give the prompt a title.");
      return;
    }
    hub().sock.send({
      type: "prompt.save",
      ...(existing ? { id: existing.id } : {}),
      title: title || shortTitle,
      shortTitle: shortTitle || title,
      icon: selectedIcon() || "bookmark",
      body,
      cid: newCid(),
    });
    // The hub's `prompts` broadcast re-renders the list + sidebar; close optimistically.
    closeModal();
  };
}

// ── Settings & servers (first-class management area) ──────────────────────────────
type SettingsTab = "servers" | "environments" | "integrations" | "models" | "appearance" | "prompts";
let settingsTab: SettingsTab = "environments";
function openSettings(): void {
  const root = $("#settings-root");
  root.innerHTML = `<div class="settings-view">
    <div class="settings-head">
      <h2>${icon("tune")} Settings &amp; Servers</h2>
      <button id="settings-close" class="icon-btn" title="Close">${icon("close")}</button>
    </div>
    <div class="settings-tabs" role="tablist">
      <button class="stab" data-tab="environments">${icon("folder")} Environments</button>
      <button class="stab" data-tab="servers">${icon("dns")} Servers</button>
      <button class="stab" data-tab="integrations">${icon("extension")} Integrations</button>
      <button class="stab" data-tab="models">${icon("smart_toy")} Models</button>
      <button class="stab" data-tab="prompts">${icon("bookmark")} Prompts</button>
      <button class="stab" data-tab="appearance">${icon("palette")} Appearance</button>
    </div>
    <div class="settings-body">
      <section class="settings-panel" data-tab="environments">
        <div class="section-head"><h3>Environments</h3><button id="set-add-env" class="primary">${icon("add")} Add repo</button></div>
        <p class="small muted">Environments are git repositories, each living on a specific server. A new session branches a fresh worktree off one.</p>
        <div id="env-cards"></div>
      </section>
      <section class="settings-panel" data-tab="servers">
        <div id="server-cards"><p class="small muted">Loading…</p></div>
      </section>
      <section class="settings-panel" data-tab="integrations">
        <div class="section-head"><h3>Lapo</h3></div>
        <p class="small muted">Authorize Anvil against your Lapo instance. When an autopilot run finishes, Anvil posts a markdown report — what was done, what's held for clarification, and what was skipped — as a Lapo information entry.</p>
        <div id="lapo-panel"><p class="small muted">Loading…</p></div>
        <div class="section-head" style="margin-top:1.75rem"><h3>Todoist</h3><button id="todoist-refresh" class="mini">${icon("refresh")} Refresh</button></div>
        <p class="small muted">Link a Todoist project to an environment, then the nightly autopilot plans &amp; builds its tasks. Set the token with <code>bun run scripts/todoist.ts set</code>.</p>
        <div id="todoist-panel"><p class="small muted">Loading…</p></div>
      </section>
      <section class="settings-panel" data-tab="models">
        <div class="section-head"><h3>Models</h3></div>
        <p class="small muted">The model providers Anvil drives. Set or reset the Claude subscription token and OpenRouter key here instead of editing the daemon's service file.</p>
        <div id="models-panel"><p class="small muted">Loading…</p></div>
      </section>
      <section class="settings-panel" data-tab="prompts">
        <div class="section-head"><h3>Prompts</h3><button id="set-add-prompt" class="primary">${icon("add")} Add prompt</button></div>
        <p class="small muted">Reusable prompt snippets. Each shows up as a button in the sidebar — click it to drop the prompt into the chat box.</p>
        <div id="prompt-cards"></div>
      </section>
      <section class="settings-panel" data-tab="appearance">
        <div class="section-head"><h3>Appearance</h3></div>
        <p class="small muted">Choose how Anvil looks. <b>System</b> follows your device's light or dark setting.</p>
        <div class="theme-options">
          <button type="button" class="theme-opt" data-theme-pref="light">${icon("light_mode")} Light</button>
          <button type="button" class="theme-opt" data-theme-pref="dark">${icon("dark_mode")} Dark</button>
          <button type="button" class="theme-opt" data-theme-pref="system">${icon("brightness_auto")} System</button>
        </div>
      </section>
    </div>
  </div>`;
  $("#settings-close").addEventListener("click", () => dismissOverlay("settings"));
  $("#set-add-env").addEventListener("click", () => showAddEnvironment());
  $("#set-add-prompt").addEventListener("click", () => showEditPrompt());
  $("#todoist-refresh").addEventListener("click", () => loadTodoistProjects(true));
  root.querySelectorAll<HTMLElement>(".theme-opt").forEach((b) =>
    b.addEventListener("click", () => setThemePref(b.dataset.themePref as ThemePref)),
  );
  updateThemeControls();
  root.querySelectorAll<HTMLElement>(".stab").forEach((t) =>
    t.addEventListener("click", () => selectSettingsTab(t.dataset.tab as SettingsTab)),
  );
  selectSettingsTab(settingsTab);
  openOverlay("settings", closeSettings); // Back closes Settings (no-op if it's already a layer)
  renderServerCards();
  renderEnvCards();
}
function selectSettingsTab(tab: SettingsTab): void {
  settingsTab = tab;
  document.querySelectorAll<HTMLElement>(".settings-view .stab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>(".settings-view .settings-panel").forEach((p) => (p.hidden = p.dataset.tab !== tab));
  if (tab === "integrations") {
    // Lapo (top) then Todoist (below) share the one Integrations tab.
    hub().sock.send({ type: "lapo.status", cid: newCid() }); // pull fresh connected/configured state
    renderLapoPanel();
    renderTodoistPanel();
    hub().sock.send({ type: "autopilot.schedule.get" }); // refresh the schedule card (once per tab open)
  }
  if (tab === "prompts") renderPromptsPanel();
  if (tab === "models") {
    renderModelsPanel();
    if (serverSupports(hub(), "auth")) {
      hub().sock.send({ type: "auth.status" }); // claude — refresh once per tab open
      hub().sock.send({ type: "auth.status", provider: "openrouter" });
      hub().sock.send({ type: "autopilot.pipeline.metrics" }); // §6.3 calibration card
    }
  }
}

// ── Lapo integration (OAuth2 information-entry reports) ────────────────────────────
let lapoConnected = false;
let lapoConfigured = false;
let lapoStatusKnown = false; // avoid a flash before the first status arrives
let lapoAccount: string | undefined;
let lapoCallbackUrl: string | undefined; // the daemon's own OAuth redirect (shown for transparency)

function onLapoStatus(connected: boolean, configured: boolean, account?: string, callbackUrl?: string): void {
  lapoConnected = connected;
  lapoConfigured = configured;
  lapoAccount = account;
  lapoCallbackUrl = callbackUrl;
  lapoStatusKnown = true;
  if (document.getElementById("lapo-panel")) renderLapoPanel();
}

/** Kick off the OAuth handshake. Opens a popup synchronously (so the click gesture isn't lost to the
 *  async round-trip and blocked), asks the daemon for the authorize URL, then points the popup at it.
 *  The daemon's callback finishes the exchange and broadcasts lapo.status, which updates this card. */
async function connectLapo(btn?: HTMLButtonElement): Promise<void> {
  // In the native shells the UI is served from a local origin (anvil-app:// / appassets.androidplatform.net);
  // a popup WKWebView/WebView is janky, so navigate instead — the shell routes the off-origin authorize
  // URL to the system browser, keeping the app intact to receive the result over its WebSocket. In a real
  // browser, use a popup so the app page stays put.
  const nativeShell = location.protocol === "anvil-app:" || location.hostname === "appassets.androidplatform.net";
  const popup = nativeShell ? null : window.open("about:blank", "lapo-oauth", "width=560,height=720");
  const label = btn?.textContent ?? "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Connecting…";
  }
  try {
    const res = await sendAwait(hub(), { type: "lapo.connect", redirectBase: window.location.origin, cid: newCid() }, 20_000);
    if (res.type === "command.error") {
      popup?.close();
      toast(res.message);
      return;
    }
    if (res.type !== "lapo.authorize") {
      popup?.close();
      return;
    }
    if (popup) popup.location.href = res.url;
    else window.location.href = res.url; // popup blocked → fall back to a full-page redirect
  } catch (err) {
    popup?.close();
    toast(`Couldn't start Lapo authorization: ${err instanceof Error ? err.message : err}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

function renderLapoPanel(): void {
  const host = document.getElementById("lapo-panel");
  if (!host) return;
  if (!serverSupports(hub(), "lapo")) {
    host.innerHTML = `<div class="card"><p class="small muted">This server is too old to support the Lapo integration — update the daemon to use it.</p></div>`;
    return;
  }
  if (!lapoStatusKnown) {
    host.innerHTML = `<p class="small muted">Loading…</p>`;
    return;
  }
  if (!lapoConfigured) {
    host.innerHTML = `<div class="card"><b>Disabled.</b>
      <p class="small muted">The Lapo integration is turned off on the hub daemon (<code>ANVIL_LAPO_DISABLE=1</code>).</p></div>`;
    return;
  }
  if (!lapoConnected) {
    host.innerHTML = `<div class="card"><b>Not connected.</b>
      <p class="small muted">Authorize Anvil to post autopilot reports to your Lapo account. No setup needed — Anvil registers itself with Lapo and you approve the sign-in. It authorizes against <b>your</b> Lapo user; the token is stored on the hub daemon (mode 0600).</p>
      <div class="lapo-connect"><button id="lapo-connect" class="primary">Connect Lapo</button></div>
      ${lapoCallbackUrl ? `<p class="small muted" style="margin-top:8px">OAuth redirect: <code>${esc(lapoCallbackUrl)}</code></p>` : ""}</div>`;
    $<HTMLButtonElement>("#lapo-connect").addEventListener("click", (ev) => void connectLapo(ev.currentTarget as HTMLButtonElement));
    return;
  }
  host.innerHTML = `<div class="card"><div class="card-main"><span class="conn-dot connected"></span><span>Connected${lapoAccount ? ` as <b>${esc(lapoAccount)}</b>` : ""}.</span>
      <button id="lapo-disconnect" class="mini" style="margin-left:auto">Disconnect</button></div></div>
    <p class="small muted">A report is posted to Lapo after each autopilot run that produced results.</p>`;
  $<HTMLButtonElement>("#lapo-disconnect").addEventListener("click", () => {
    hub().sock.send({ type: "lapo.disconnect", cid: newCid() });
  });
}

// ── Todoist integration ──────────────────────────────────────────────────────────
let todoistConnected = false;
let todoistAccount: string | undefined;
const todoistProjects = new Map<string, TodoistProjectInfo>();
let todoistProjectsLoaded = false;

const todoistProjectName = (id?: string): string | undefined => (id ? todoistProjects.get(id)?.name : undefined);

/** <option> list for the env link select; keeps the current link selectable even if not yet cached. */
/** Where each Todoist project is already linked (env on ANY fleet server), excluding `exceptEnvId`.
 *  A project maps to exactly ONE environment — otherwise two daemons would plan the same tasks. */
function todoistProjectLinks(exceptEnvId?: string): Map<string, { envName: string; serverName: string }> {
  const links = new Map<string, { envName: string; serverName: string }>();
  for (const e of environments.values()) {
    if (!e.todoistProjectId || e.id === exceptEnvId) continue;
    const srvUrl = envServer.get(e.id);
    const srv = srvUrl ? servers.get(srvUrl) : undefined;
    links.set(e.todoistProjectId, { envName: e.name, serverName: srv?.name ?? hostOf(srvUrl ?? "") });
  }
  return links;
}

function todoistProjectOptions(selectedId?: string, exceptEnvId?: string): string {
  const links = todoistProjectLinks(exceptEnvId);
  const opts = [`<option value="">— none —</option>`];
  const seen = new Set<string>();
  for (const p of [...todoistProjects.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    seen.add(p.id);
    const linked = links.get(p.id);
    const isSelected = p.id === selectedId;
    const disabled = !!linked && !isSelected; // already owned by another env → can't double-link
    const base = `${esc(p.name)}${p.parentId ? " (sub)" : ""}${p.taskCount != null ? ` · ${p.taskCount}` : ""}`;
    const label = disabled ? `${base} — linked to ${esc(linked!.envName)} @ ${esc(linked!.serverName)}` : base;
    opts.push(`<option value="${esc(p.id)}"${isSelected ? " selected" : ""}${disabled ? " disabled" : ""}>${label}</option>`);
  }
  if (selectedId && !seen.has(selectedId)) {
    opts.push(`<option value="${esc(selectedId)}" selected>${esc(todoistProjectName(selectedId) ?? selectedId)}</option>`);
  }
  return opts.join("");
}

function onTodoistStatus(connected: boolean, account?: string): void {
  todoistConnected = connected;
  todoistAccount = account;
  if (document.getElementById("todoist-panel")) renderTodoistPanel();
}

/** Fetch the account's projects (live) and cache them; `force` re-fetches even if already loaded. */
async function loadTodoistProjects(force = false): Promise<void> {
  if (!todoistConnected) return;
  if (todoistProjectsLoaded && !force) return;
  const host = document.getElementById("todoist-panel");
  if (host && force) host.innerHTML = `<p class="small muted">Loading projects…</p>`;
  try {
    const res = await sendAwait(hub(), { type: "todoist.projects.list", cid: newCid() }, 20_000);
    if (res.type === "command.error") {
      toast(res.message);
      return;
    }
    if (res.type !== "todoist.projects.result") return;
    todoistProjects.clear();
    for (const p of res.projects) todoistProjects.set(p.id, p);
    todoistProjectsLoaded = true;
    renderTodoistPanel();
    if (document.getElementById("env-cards")) renderEnvCards(); // refresh link labels
  } catch (err) {
    toast(`Couldn't load Todoist projects: ${err instanceof Error ? err.message : err}`);
  }
}

async function connectTodoistToken(token: string, btn?: HTMLButtonElement): Promise<void> {
  const t = token.trim();
  if (!t) {
    toast("Paste your Todoist API token first.");
    return;
  }
  const label = btn?.textContent ?? "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Connecting…";
  }
  try {
    const res = await sendAwait(hub(), { type: "todoist.connect", token: t, cid: newCid() }, 20_000);
    if (res.type === "command.error") {
      toast(res.message);
      return; // onTodoistStatus only fires on success → stay on the entry form
    }
    todoistProjectsLoaded = false; // a (possibly new) account → refetch projects
    // The connected `todoist.status` arrives via onTodoistStatus and re-renders the panel.
    // Replicate the token to every fleet member (hub-side, server→server) so autopilot can run
    // wherever a linked environment lives. Fire-and-forget; members also self-heal on reconnect.
    if (orderedServers().some((s) => s.url !== HUB_URL)) {
      hub().sock.send({ type: "todoist.propagate", cid: newCid() });
      toast("Sharing the Todoist token across your fleet…");
    }
  } catch (err) {
    toast(`Couldn't connect Todoist: ${err instanceof Error ? err.message : err}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

function renderTodoistPanel(): void {
  const host = document.getElementById("todoist-panel");
  if (!host) return;
  if (!todoistConnected) {
    host.innerHTML = `<div class="card"><b>Not connected.</b>
      <p class="small muted">Generate a personal API token in Todoist (Settings → Integrations → Developer), paste it below, then connect.</p>
      <div class="todoist-connect">
        <input id="todoist-token" type="password" autocomplete="off" spellcheck="false" placeholder="Todoist API token" />
        <button id="todoist-connect" class="primary">Connect</button>
      </div>
      <p class="small muted" style="margin-top:8px">Stored on the hub daemon (mode 0600) and replicated across your fleet, so autopilot can run wherever a linked environment lives.</p></div>`;
    const input = $<HTMLInputElement>("#todoist-token");
    const btn = $<HTMLButtonElement>("#todoist-connect");
    btn.addEventListener("click", () => void connectTodoistToken(input.value, btn));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void connectTodoistToken(input.value, btn);
    });
    return;
  }
  if (!todoistProjectsLoaded) {
    host.innerHTML = `<div class="card"><span class="conn-dot connected"></span> Connected${todoistAccount ? ` as <b>${esc(todoistAccount)}</b>` : ""}.</div>
      <p class="small muted" style="margin-top:10px">Loading projects…</p>`;
    void loadTodoistProjects();
    return;
  }
  // Which env (if any) each project is linked to.
  const linkedBy = new Map<string, string>();
  for (const e of environments.values()) if (e.todoistProjectId) linkedBy.set(e.todoistProjectId, e.name);
  // Order projects by their Todoist hierarchy: each parent immediately followed
  // by its sub-projects, depth-first. Within a level, sort by task count desc.
  const all = [...todoistProjects.values()];
  const ids = new Set(all.map((p) => p.id));
  const childrenOf = new Map<string, TodoistProjectInfo[]>();
  const roots: TodoistProjectInfo[] = [];
  for (const p of all) {
    // Treat a project whose parent isn't in the set as a root (orphan-safe).
    if (p.parentId && ids.has(p.parentId)) {
      const arr = childrenOf.get(p.parentId) ?? [];
      arr.push(p);
      childrenOf.set(p.parentId, arr);
    } else roots.push(p);
  }
  const byTasks = (a: TodoistProjectInfo, b: TodoistProjectInfo) => (b.taskCount ?? 0) - (a.taskCount ?? 0);
  const ordered: Array<{ p: TodoistProjectInfo; depth: number }> = [];
  const walk = (p: TodoistProjectInfo, depth: number) => {
    ordered.push({ p, depth });
    for (const c of (childrenOf.get(p.id) ?? []).sort(byTasks)) walk(c, depth + 1);
  };
  for (const r of roots.sort(byTasks)) walk(r, 0);
  const rows = ordered
    .map(({ p, depth }) => {
      const link = linkedBy.get(p.id);
      const indent = depth ? `<span class="td-indent">${"&nbsp;".repeat(depth * 4)}↳ </span>` : "";
      return `<tr>
        <td>${indent}${esc(p.name)}</td>
        <td class="small muted">${p.taskCount ?? 0}</td>
        <td>${link ? `<span class="small">${icon("link")} ${esc(link)}</span>` : `<span class="small muted">—</span>`}</td>
      </tr>`;
    })
    .join("");
  host.innerHTML = `<div class="card"><div class="card-main"><span class="conn-dot connected"></span><span>Connected${todoistAccount ? ` as <b>${esc(todoistAccount)}</b>` : ""} · ${todoistProjects.size} projects</span>
      <button id="todoist-disconnect" class="mini" style="margin-left:auto">Disconnect</button></div></div>
    ${scheduleSettingsCardHtml()}
    <table class="todoist-projects"><thead><tr><th>Project</th><th>Tasks</th><th>Linked environment</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="small muted">Link a project to an environment from <b>Environments → Edit</b>.</p>
    ${autopilotMaintenanceCardHtml()}`;
  $("#todoist-disconnect").addEventListener("click", () => {
    hub().sock.send({ type: "todoist.disconnect", cid: newCid() });
    todoistProjectsLoaded = false;
    todoistProjects.clear();
  });
  $("#set-sched-edit").addEventListener("click", openScheduleModal);
  document.getElementById("ap-tags-reset")?.addEventListener("click", () => void resetAnvilTags());
  document.getElementById("ap-clear")?.addEventListener("click", () => void clearAutopilotUi());
}

/** Maintenance card (Todoist tab): reset anvil:* tags so tasks re-plan, or clear the pipeline. Hidden
 *  on a daemon too old to handle the commands. */
function autopilotMaintenanceCardHtml(): string {
  if (!serverSupports(hub(), "autopilot-maintenance")) return "";
  return `<div class="card ap-maint"><b>${icon("build")} Autopilot maintenance</b>
    <p class="small muted">Reset clears every <code>anvil:*</code> status label from your tasks (your <b>Autopilot</b> sourcing label is kept) and drops pending plans that aren't building, so the next run re-plans them. Clear wipes the whole pipeline.</p>
    <div class="ap-maint-actions">
      <button id="ap-tags-reset" class="mini">${icon("restart_alt")} Reset anvil tags</button>
      <button id="ap-clear" class="mini danger">${icon("delete_sweep")} Clear autopilot</button>
    </div></div>`;
}

async function resetAnvilTags(): Promise<void> {
  const ok = await confirmDialog({
    title: "Reset Autopilot tags?",
    body: "Removes every anvil:* status label from your Todoist tasks (your Autopilot sourcing label and other labels stay) and drops pending plans that aren't being built, so the next run re-plans them from scratch.",
    confirmLabel: "Reset tags",
    icon: "restart_alt",
  });
  if (!ok) return;
  try {
    const res = await sendAwait(hub(), { type: "autopilot.tags.reset", cid: newCid() }, 120_000);
    if (res.type === "command.error") {
      toast(res.message);
      return;
    }
    if (res.type === "autopilot.maintenance.result") {
      toast(`Reset ${res.tasksCleared} task${res.tasksCleared === 1 ? "" : "s"} · ${res.unitsRemoved} plan${res.unitsRemoved === 1 ? "" : "s"} cleared`);
    }
  } catch (err) {
    toast(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function clearAutopilotUi(): Promise<void> {
  const ok = await confirmDialog({
    title: "Clear the autopilot entirely?",
    body: "Wipes every pending plan and removes all anvil:* labels from their Todoist tasks. Running build sessions aren't stopped, but their plans are forgotten. This can't be undone.",
    confirmLabel: "Clear everything",
    danger: true,
    icon: "delete_sweep",
  });
  if (!ok) return;
  try {
    const res = await sendAwait(hub(), { type: "autopilot.clear", cid: newCid() }, 120_000);
    if (res.type === "command.error") {
      toast(res.message);
      return;
    }
    if (res.type === "autopilot.maintenance.result") {
      toast(`Cleared ${res.unitsRemoved} plan${res.unitsRemoved === 1 ? "" : "s"} · ${res.tasksCleared} task${res.tasksCleared === 1 ? "" : "s"} relabelled`);
    }
  } catch (err) {
    toast(`Clear failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
/** Tear down the settings view (DOM only). Reached via Back (popstate) or dismissOverlay. */
function closeSettings(): void {
  $("#settings-root").innerHTML = "";
}

// ── Model providers (Settings → Models) ───────────────────────────────────────────
// The daemon drives Claude (Agent SDK); the token is set/reset here so it doesn't require SSHing in to
// edit the launcher env. OpenRouter powers the adversarial planning panel (a separate metered key). Both
// are hub-scoped, like Todoist.
type ProviderAuth = { connected: boolean; persisted: boolean; masked?: string };
let claudeAuth: ProviderAuth | null = null;
let openRouterAuth: ProviderAuth | null = null;
function onAuthStatus(e: AuthStatusEvent): void {
  const state: ProviderAuth = { connected: e.connected, persisted: e.persisted, ...(e.masked ? { masked: e.masked } : {}) };
  if (e.provider === "openrouter") openRouterAuth = state;
  else claudeAuth = state;
  if (document.getElementById("models-panel")) renderModelsPanel();
}

/** Persist a new/replacement Claude OAuth token on the hub daemon. */
async function saveClaudeToken(token: string, btn?: HTMLButtonElement): Promise<void> {
  const t = token.trim();
  if (!t) {
    toast("Paste your Claude OAuth token first.");
    return;
  }
  const label = btn?.textContent ?? "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
  try {
    const res = await sendAwait(hub(), { type: "auth.set", token: t, cid: newCid() }, 20_000);
    if (res.type === "command.error") {
      toast(res.message); // e.g. "that looks like a metered API key…"
      return;
    }
    toast("Claude token saved — it applies to the next run."); // the auth.status reply/broadcast re-renders
  } catch (err) {
    toast(`Couldn't save the token: ${err instanceof Error ? err.message : err}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

async function clearClaudeTokenUi(): Promise<void> {
  const ok = await confirmDialog({
    title: "Clear the Claude token?",
    body: "The daemon will have no model credential until you set a new one — autopilot and chat can't run without it. The token is removed from the daemon and its env file.",
    confirmLabel: "Clear token",
    danger: true,
    icon: "key_off",
  });
  if (!ok) return;
  hub().sock.send({ type: "auth.clear", cid: newCid() }); // the auth.status broadcast re-renders the card
  toast("Claude token cleared");
}

/** Persist a new/replacement OpenRouter API key on the hub daemon (powers the adversarial panel). */
async function saveOpenRouterKey(key: string, btn?: HTMLButtonElement): Promise<void> {
  const k = key.trim();
  if (!k) {
    toast("Paste your OpenRouter API key first.");
    return;
  }
  const label = btn?.textContent ?? "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
  try {
    const res = await sendAwait(hub(), { type: "auth.set", provider: "openrouter", token: k, cid: newCid() }, 20_000);
    if (res.type === "command.error") {
      toast(res.message);
      return;
    }
    toast("OpenRouter key saved — the adversarial panel applies it on the next autopilot run.");
  } catch (err) {
    toast(`Couldn't save the key: ${err instanceof Error ? err.message : err}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

async function clearOpenRouterKeyUi(): Promise<void> {
  const ok = await confirmDialog({
    title: "Clear the OpenRouter key?",
    body: "The adversarial multi-model review will be skipped on future autopilot runs until a new key is set. Planning itself is unaffected. The key is removed from the daemon and its env file.",
    confirmLabel: "Clear key",
    danger: true,
    icon: "key_off",
  });
  if (!ok) return;
  hub().sock.send({ type: "auth.clear", provider: "openrouter", cid: newCid() });
  toast("OpenRouter key cleared");
}

// §6.3 adversary calibration metrics, shown under the Models tab. Refreshed on tab open / connect.
let pipelineMetrics: PipelineAdversaryStat[] | null = null;
function onPipelineMetrics(stats: PipelineAdversaryStat[]): void {
  pipelineMetrics = stats;
  if (document.getElementById("models-panel")) renderModelsPanel();
}
/** The adversary calibration card (§6.3): first-pass rejection rate per gate — is the review real? */
function pipelineMetricsCard(): string {
  if (!pipelineMetrics || pipelineMetrics.length === 0) {
    return `<div class="card"><b>Adversary calibration <span class="small muted">(pipeline §6.3)</span></b>
      <p class="small muted">Once the autonomous pipeline runs, each adversary's first-pass rejection rate per gate appears here. A rate near zero over a real sample means the cross-model review is rubber-stamping — and should be recalibrated.</p></div>`;
  }
  const rows = pipelineMetrics
    .map(
      (s) => `<tr>
        <td>${esc(s.gate)}</td><td>${esc(s.adversary)}</td>
        <td>${Math.round(s.rejectionRate * 100)}%</td>
        <td class="small muted">${s.firstPassRejections}/${s.firstSubmissions}</td>
        <td>${s.decorative ? `<span class="warn small">${icon("warning")} decorative</span>` : ""}</td>
      </tr>`,
    )
    .join("");
  return `<div class="card"><b>Adversary calibration <span class="small muted">(pipeline §6.3)</span></b>
    <p class="small muted">First-pass rejection rate per gate. "Decorative" flags an adversary that almost never rejects over a real sample.</p>
    <table class="pt-table small"><thead><tr><th>Gate</th><th>Adversary</th><th>Reject rate</th><th>n</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderModelsPanel(): void {
  const host = document.getElementById("models-panel");
  if (!host) return;
  if (!serverSupports(hub(), "auth")) {
    host.innerHTML = `<div class="card"><b>Update required.</b><p class="small muted">This daemon is too old to manage the model token from the app. Update Anvil, or set <code>CLAUDE_CODE_OAUTH_TOKEN</code> in <code>~/.config/anvil/env</code>.</p></div>`;
    return;
  }
  if (!claudeAuth) {
    host.innerHTML = `<p class="small muted">Loading…</p>`;
    return;
  }
  const tokenForm = (saveLabel: string): string => `<div class="todoist-connect">
      <input id="claude-token" type="password" autocomplete="off" spellcheck="false" placeholder="Claude OAuth token (sk-ant-oat…)" />
      <button id="claude-save" class="primary">${saveLabel}</button>
    </div>`;
  const persistWarn = (persisted: boolean): string =>
    persisted
      ? ""
      : `<p class="small muted" style="margin-top:8px">${icon("warning")} Not written to the launcher env file — it will revert on the next service restart.</p>`;
  // ── Claude (drives the Agent SDK) ──
  const claudeSection = !claudeAuth.connected
    ? `<div class="card"><b>No Claude token set.</b>
        <p class="small muted">On the daemon host run <code>claude setup-token</code>, paste the token below, then save. Stored on the hub daemon (mode 0600) and applied to the next agent run.</p>
        ${tokenForm("Save")}</div>`
    : `<div class="card"><div class="card-main"><span class="conn-dot connected"></span>
          <span>Claude — connected${claudeAuth.masked ? ` · <code>${esc(claudeAuth.masked)}</code>` : ""}</span>
          <button id="claude-clear" class="mini danger" style="margin-left:auto">${icon("key_off")} Reset / clear</button></div>${persistWarn(claudeAuth.persisted)}</div>
        <div class="card"><b>Replace token</b>
          <p class="small muted">Rotated or expired? Paste a fresh token to replace the current one.</p>
          ${tokenForm("Replace")}</div>`;
  // ── OpenRouter (drives the adversarial multi-model planning panel) ──
  const orForm = (saveLabel: string): string => `<div class="todoist-connect">
      <input id="or-key" type="password" autocomplete="off" spellcheck="false" placeholder="OpenRouter API key (sk-or-…)" />
      <button id="or-save" class="primary">${saveLabel}</button>
    </div>`;
  let openRouterSection: string;
  if (!openRouterAuth) {
    openRouterSection = `<div class="card"><b>OpenRouter</b><p class="small muted">Loading…</p></div>`;
  } else if (!openRouterAuth.connected) {
    openRouterSection = `<div class="card"><b>OpenRouter — not set <span class="small muted">(optional)</span></b>
        <p class="small muted">Powers the <b>adversarial review</b>: after Claude plans, competing models (e.g. GLM) read the repo and critique the plan. Create a key at <code>openrouter.ai/keys</code>, paste it below, then save. Stored on the hub daemon (mode 0600). Leave unset to skip the panel.</p>
        ${orForm("Save")}</div>`;
  } else {
    openRouterSection = `<div class="card"><div class="card-main"><span class="conn-dot connected"></span>
          <span>OpenRouter — connected${openRouterAuth.masked ? ` · <code>${esc(openRouterAuth.masked)}</code>` : ""}</span>
          <button id="or-clear" class="mini danger" style="margin-left:auto">${icon("key_off")} Reset / clear</button></div>${persistWarn(openRouterAuth.persisted)}</div>
        <div class="card"><b>Replace key</b>
          <p class="small muted">Paste a fresh key to replace the current one.</p>
          ${orForm("Replace")}</div>`;
  }
  host.innerHTML = `${claudeSection}${openRouterSection}${pipelineMetricsCard()}`;

  // Wire Claude controls.
  if (claudeAuth.connected) $("#claude-clear").addEventListener("click", () => void clearClaudeTokenUi());
  const cInput = $<HTMLInputElement>("#claude-token");
  const cBtn = $<HTMLButtonElement>("#claude-save");
  cBtn.addEventListener("click", () => void saveClaudeToken(cInput.value, cBtn));
  cInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void saveClaudeToken(cInput.value, cBtn);
  });
  // Wire OpenRouter controls (present unless its status is still loading).
  if (openRouterAuth) {
    if (openRouterAuth.connected) $("#or-clear").addEventListener("click", () => void clearOpenRouterKeyUi());
    const oInput = $<HTMLInputElement>("#or-key");
    const oBtn = $<HTMLButtonElement>("#or-save");
    oBtn.addEventListener("click", () => void saveOpenRouterKey(oInput.value, oBtn));
    oInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void saveOpenRouterKey(oInput.value, oBtn);
    });
  }
}
// ── Autopilot (plan review & launch; anvil-autopilot-ui.md) ────────────────────────
const autopilotLog: string[] = []; // streamed progress lines for the current/last run
let openPlanId: string | null = null; // the plan open in the reader, if any (else the grid is shown)
const SIZE_LABEL: Record<string, string> = { xs: "XS", s: "S", m: "M", l: "L", xl: "XL" };
const DAY_LABEL = ["S", "M", "T", "W", "T", "F", "S"]; // Sun..Sat, for the schedule day toggles
// Each server's autopilot schedule (the UI control targets the hub; the daemon supports per-server).
// `running` is the server-authoritative live run state, broadcast on start/finish + sent on connect.
const serverSchedule = new Map<string, { schedule: AutopilotSchedule; nextRunAt?: string; running: boolean }>();

// Client-side backstop against a server that reports `running: true` and never takes it back — an old
// daemon with a latched flag, or one that died without a clean `running: false`. A healthy current
// daemon caps its own run (30 min) and broadcasts false well before this fires, so this only bites a
// stuck/old server: if no clearing event arrives within the budget, we drop that server's run locally
// so the fleet-wide spinner can't be pinned on forever by one misbehaving member.
const STALE_RUN_MS = 35 * 60_000;
const staleRunTimers = new Map<string, ReturnType<typeof setTimeout>>();
function clearStaleRunTimer(url: string): void {
  const t = staleRunTimers.get(url);
  if (t !== undefined) {
    clearTimeout(t);
    staleRunTimers.delete(url);
  }
}
/** Arm (or re-arm) the stale-run backstop for a server now reporting a live run. */
function armStaleRunTimer(url: string): void {
  clearStaleRunTimer(url);
  staleRunTimers.set(
    url,
    setTimeout(() => {
      staleRunTimers.delete(url);
      const entry = serverSchedule.get(url);
      if (entry?.running) {
        serverSchedule.set(url, { ...entry, running: false });
        reflectAutopilotRunning();
      }
    }, STALE_RUN_MS),
  );
}

/** Is an autopilot run in flight anywhere? True if any server reports it, OR this client started one. */
function anyServerRunning(): boolean {
  if (runState.running) return true;
  for (const s of serverSchedule.values()) if (s.running) return true;
  return false;
}

/** Reflect the live run state everywhere it shows: the always-present sidebar spinner (visible even
 *  with the Autopilot view closed) and, when the view is open, the in-view status banner. */
function reflectAutopilotRunning(): void {
  const spin = document.getElementById("autopilot-running");
  if (spin) (spin as HTMLElement).hidden = !anyServerRunning();
  renderRunStatus();
}

/** Every server's pending plans, hub first, in the sidebar/grouping order. */
function allPlans(): AutopilotPlanInfo[] {
  return orderedServers().flatMap((s) => serverPlans.get(s.url) ?? []);
}
function pendingPlanCount(): number {
  let n = 0;
  for (const list of serverPlans.values()) n += list.length;
  return n;
}
function findPlan(id: string): AutopilotPlanInfo | undefined {
  for (const list of serverPlans.values()) {
    const p = list.find((x) => x.id === id);
    if (p) return p;
  }
  return undefined;
}
function updateAutopilotBadge(): void {
  const badge = document.getElementById("autopilot-badge");
  if (!badge) return;
  const n = pendingPlanCount();
  badge.textContent = n ? String(n) : "";
  badge.hidden = n === 0;
}
// A plan deep link (#p/<id>) may arrive before that plan has synced from its server. Hold the id here
// and open the reader the moment the plan shows up (see onAutopilotPlans → tryOpenPendingPlan).
let pendingPlanDeepLink: string | null = null;
/** Open the Autopilot view at a specific plan (deep link). Opens the view if needed; if the plan
 *  isn't loaded yet, remembers it and opens once its server delivers it. */
function openPlanDeepLink(id: string): void {
  pendingPlanDeepLink = id;
  if (!overlayOpen("autopilot")) openAutopilot(); // renders the grid + pulls plans from every server
  tryOpenPendingPlan();
}
/** If a deep-linked plan is now present, open its reader and clear the pending id. No-op otherwise. */
function tryOpenPendingPlan(): void {
  if (!pendingPlanDeepLink || !overlayOpen("autopilot")) return;
  if (!findPlan(pendingPlanDeepLink)) return; // not synced yet — wait for the next autopilot.plans
  const id = pendingPlanDeepLink;
  pendingPlanDeepLink = null;
  openPlan(id);
}

/** A server delivered its pending plans: re-tag routing, refresh the badge and (if open) the view. */
function onAutopilotPlans(url: string, plans: AutopilotPlanInfo[]): void {
  serverPlans.set(url, plans);
  for (const [pid, u] of [...planServer]) if (u === url) planServer.delete(pid);
  for (const p of plans) planServer.set(p.id, url);
  updateAutopilotBadge();
  tryOpenPendingPlan(); // a deep-linked plan may have just arrived
  if (!document.querySelector(".autopilot-view")) return;
  // A reader open on a plan that just vanished (dismissed/started elsewhere) falls back to the grid;
  // otherwise leave an open reader untouched (refine updates it in place) and only re-flow the grid.
  if (openPlanId) {
    if (!findPlan(openPlanId)) backToGrid(); // the open plan vanished (dismissed/started) → unwind to the grid
  } else {
    renderAutopilotGrid();
  }
}
/** Restore the in-flight run's log on (re)connect. The schedule event already set `running`; this
 *  refills the log panel + banner so refreshing mid-run no longer blanks the live view. Only sent by
 *  the server while a run is actually in flight. */
function onAutopilotRunSnapshot(log: string[]): void {
  autopilotLog.length = 0;
  autopilotLog.push(...log);
  runState.lastLine = log[log.length - 1] ?? "";
  const el = document.getElementById("autopilot-log");
  if (el) {
    el.textContent = autopilotLog.join("\n");
    applyAutopilotLogVisibility();
    if (!el.hidden) el.scrollTop = el.scrollHeight;
  }
  reflectAutopilotRunning();
}
function onAutopilotProgress(line: string): void {
  autopilotLog.push(line);
  runState.lastLine = line;
  const log = document.getElementById("autopilot-log");
  if (log) {
    log.textContent = autopilotLog.join("\n");
    applyAutopilotLogVisibility();
    if (!log.hidden) log.scrollTop = log.scrollHeight;
  }
  reflectAutopilotRunning();
}

// Whether the user has collapsed the raw run-log panel. Module-level so the choice survives re-renders
// and live progress: a streamed line must never re-expand a log the user deliberately hid (that's what
// was burying the plans grid below it on a short/narrow viewport).
let autopilotLogCollapsed = false;
/** Sync the run-log panel + its show/hide toggle to `autopilotLogCollapsed`. The toggle only surfaces
 *  once there's log content; collapsing the log frees the screen for the plans grid underneath. */
function applyAutopilotLogVisibility(): void {
  const log = document.getElementById("autopilot-log");
  const toggle = document.getElementById("autopilot-log-toggle");
  const hasContent = autopilotLog.length > 0;
  if (toggle) {
    (toggle as HTMLElement).hidden = !hasContent;
    toggle.setAttribute("aria-pressed", String(!autopilotLogCollapsed));
  }
  if (log) log.hidden = !hasContent || autopilotLogCollapsed;
}

// Live status of the current/last "Run autopilot", surfaced as a banner above the log so the run is
// legible without reading the raw stream (how many tasks evaluated, what's new, per-server outcome).
interface RunState {
  running: boolean;
  serversTotal: number;
  lastLine: string;
  results: { name: string; ok: boolean; created: number; skipped: number; error?: string }[];
}
const runState: RunState = { running: false, serversTotal: 0, lastLine: "", results: [] };

function renderRunStatus(): void {
  const host = document.getElementById("autopilot-status");
  if (!host) return;
  const running = anyServerRunning();
  if (!running && runState.results.length === 0) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  const createdTotal = runState.results.reduce((n, r) => n + r.created, 0);
  // "Evaluating N sources" only when THIS client drove the run (it knows the target count); a run
  // observed from another device just shows a generic "running" head (its progress still streams in).
  const runningHead = runState.running && runState.serversTotal
    ? `Evaluating ${runState.serversTotal} project source${runState.serversTotal === 1 ? "" : "s"}…`
    : "Autopilot is running…";
  const head = running
    ? `<span class="ap-status-head"><span class="msym spin">progress_activity</span> ${runningHead}</span>`
    : `<span class="ap-status-head">${icon("check_circle")} ${createdTotal ? `${createdTotal} new plan${createdTotal === 1 ? "" : "s"}` : "No new plans"}</span>`;
  const live = running && runState.lastLine
    ? `<div class="ap-status-line">${esc(runState.lastLine)}</div>`
    : "";
  const rows = runState.results
    .map((r) =>
      r.ok
        ? `<div class="ap-status-row"><span class="ok">${icon("check")}</span> <b>${esc(r.name)}</b> — ${r.created} new · ${r.skipped} already in pipeline</div>`
        : `<div class="ap-status-row warn"><span>${icon("warning")}</span> <b>${esc(r.name)}</b> — ${esc(r.error ?? "failed")}</div>`,
    )
    .join("");
  host.innerHTML = `${head}${live}${rows}`;
}

function openAutopilot(): void {
  const root = $("#autopilot-root");
  root.innerHTML = `<div class="autopilot-view">
    <div class="settings-head ap-head">
      <div class="ap-head-titles">
        <h2>${icon("bolt")} Autopilot</h2>
        <span class="ap-sched-summary" id="autopilot-schedule"></span>
      </div>
      <span class="ap-head-actions">
        <button id="autopilot-log-toggle" class="mini" title="Show/hide run log" aria-pressed="true" hidden>${icon("terminal")}<span class="ap-log-toggle-label">Log</span></button>
        <button id="autopilot-run" class="primary ap-run-btn" title="Run autopilot">${icon("play_arrow")}<span class="ap-run-full">Run autopilot</span><span class="ap-run-mid">Run</span></button>
        <button id="autopilot-close" class="icon-btn" title="Close">${icon("close")}</button>
      </span>
    </div>
    <div class="ap-run-status" id="autopilot-status" hidden></div>
    <pre class="git-output ap-log" id="autopilot-log" hidden></pre>
    <div class="settings-body"><div id="autopilot-grid"></div></div>
  </div>`;
  $("#autopilot-close").addEventListener("click", () => dismissOverlay("autopilot"));
  $("#autopilot-run").addEventListener("click", () => void runAutopilot());
  $("#autopilot-log-toggle").addEventListener("click", () => {
    autopilotLogCollapsed = !autopilotLogCollapsed;
    applyAutopilotLogVisibility();
  });
  renderScheduleBar();
  renderRunStatus();
  if (autopilotLog.length) $("#autopilot-log").textContent = autopilotLog.join("\n");
  applyAutopilotLogVisibility();
  openOverlay("autopilot", closeAutopilot, "#autopilot"); // own URL; Back reverts it & closes the view
  renderAutopilotGrid();
  for (const s of orderedServers())
    if (s.sock.isOpen() && serverSupports(s, "autopilot")) {
      s.sock.send({ type: "autopilot.plans.list" }); // fresh pull (autopilot-capable servers only)
      s.sock.send({ type: "autopilot.schedule.get" });
    }
}
/** Tear down the autopilot view (DOM only). Reached via Back (popstate) or dismissOverlay. */
function closeAutopilot(): void {
  openPlanId = null;
  $("#autopilot-root").innerHTML = "";
}

/** Millis of a plan's last action (updatedAt, falling back to createdAt), for recency sort + label.
 *  Returns 0 when neither timestamp parses, so undated plans sort last / show no date. */
function planUpdatedMs(p: AutopilotPlanInfo): number {
  const t = Date.parse(p.updatedAt ?? p.createdAt ?? "");
  return Number.isFinite(t) ? t : 0;
}

function planCardHtml(p: AutopilotPlanInfo): string {
  const localEnv = p.environmentId ? environments.get(p.environmentId) : undefined;
  // Tint each card with its environment's colour (same hue the sidebar/session rows use), so a plan is
  // visually tied to the repo it belongs to. Falls back to the accent when the env isn't local.
  // The environment name itself is carried by the group separator above the grid, not repeated here.
  const stripe = localEnv ? stripeColor(localEnv, 0, currentTheme()) : "var(--accent)";
  const summary = p.summary ?? p.rationale ?? "";
  const eff = p.effort
    ? `<span class="ap-chip eff-${p.effort.size}">${SIZE_LABEL[p.effort.size] ?? p.effort.size}${p.effort.filesTouched != null ? ` · ${p.effort.filesTouched} file${p.effort.filesTouched === 1 ? "" : "s"}` : ""}</span>`
    : "";
  // When the plan's last action happened — the same recency the grid now sorts by. Relative for glance
  // value ("3d ago"), full date on hover.
  const ms = planUpdatedMs(p);
  const when = ms
    ? `<span class="ap-chip ap-chip-when" title="Last action ${esc(new Date(ms).toLocaleString())}">${icon("history")}${esc(relTime(ms))}</span>`
    : "";
  return `<button class="plan-card" data-id="${esc(p.id)}" style="--plan-stripe:${stripe}">
    <span class="plan-title">${esc(p.title)}</span>
    ${summary ? `<span class="plan-summary">${esc(summary)}</span>` : ""}
    <span class="plan-meta">
      <span class="ap-chip">${icon("checklist")}${p.taskCount}</span>
      ${eff}
      ${p.source === "label" ? `<span class="ap-chip ap-chip-label">${icon("label")}via label</span>` : ""}
      <span class="ap-chip status-${esc(p.status)}">${esc(p.status)}</span>
      ${when}
    </span>
  </button>`;
}
/** A plan's environment display name (local env → broadcast name → fallback). */
function planEnvName(p: AutopilotPlanInfo): string {
  return p.environmentName ?? (p.environmentId ? environments.get(p.environmentId)?.name : undefined) ?? "Unlinked";
}
/** Group a server's plans by environment, environments ordered by name and each env's plans ordered
 *  most-recent-first (by last action), so a repo's plans sit together with the freshest on top. */
function plansByEnvironment(list: AutopilotPlanInfo[]): { envId?: string; name: string; plans: AutopilotPlanInfo[] }[] {
  const groups = new Map<string, { envId?: string; name: string; plans: AutopilotPlanInfo[] }>();
  for (const p of list) {
    const name = planEnvName(p);
    const key = p.environmentId ?? `~${name}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { envId: p.environmentId, name, plans: [] }));
    g.plans.push(p);
  }
  const out = [...groups.values()];
  // Most recent action first; ties (or undated plans) fall back to title for a stable order.
  for (const g of out) g.plans.sort((a, b) => planUpdatedMs(b) - planUpdatedMs(a) || a.title.localeCompare(b.title));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
/** The flowing card grid, grouped by server when the fleet has more than one. */
// The grid and the plan reader render into the same scroll container (.settings-body), so without help
// every swap inherits the wrong offset: opening a plan kept the grid's scroll (plan opened mid-page),
// going Back rebuilt the grid at the top, and a live plans refresh snapped it to the top mid-scroll.
// Remember the grid's offset on the way into a plan and restore it on the way back; reset to the top
// when entering a plan; preserve the current offset across a same-view re-render.
const apScrollBody = (): HTMLElement | null => document.querySelector(".autopilot-view .settings-body");
let apGridScroll = 0;

function renderAutopilotGrid(): void {
  const body = apScrollBody();
  // Coming back from a plan reader (openPlanId still set) → restore where the grid was; a same-view
  // refresh (already null) → keep the current offset so a background plans update doesn't jump.
  const keepScroll = openPlanId !== null ? apGridScroll : (body?.scrollTop ?? 0);
  openPlanId = null;
  const host = document.getElementById("autopilot-grid");
  if (!host) return;
  const restoreScroll = (): void => { if (body) body.scrollTop = keepScroll; };
  const multi = orderedServers().length > 1;
  if (pendingPlanCount() === 0) {
    host.innerHTML = `<div class="ap-empty">${icon("inbox")}
      <p>No pending plans.</p>
      <p class="small muted">Link a Todoist project to an environment in Settings, then <b>Run autopilot</b> to generate plans.</p></div>`;
    restoreScroll();
    return;
  }
  let html = "";
  for (const srv of orderedServers()) {
    const list = serverPlans.get(srv.url) ?? [];
    if (multi) html += `<div class="ap-server-sep"><span class="conn-dot ${srv.status}"></span>${esc(srv.name)}</div>`;
    if (!list.length) {
      if (multi) html += `<p class="small muted ap-server-empty">No plans</p>`;
      continue;
    }
    // A labeled separator per environment (colour dot + name), then that env's card grid.
    for (const g of plansByEnvironment(list)) {
      const env = g.envId ? environments.get(g.envId) : undefined;
      const dot = env ? stripeColor(env, 0, currentTheme()) : "var(--muted)";
      html += `<div class="ap-env-sep"><span class="env-dot" style="background:${dot}"></span>${esc(g.name)}<span class="ap-env-count">${g.plans.length}</span></div>`;
      html += `<div class="plan-grid">${g.plans.map(planCardHtml).join("")}</div>`;
    }
  }
  host.innerHTML = html;
  host.querySelectorAll<HTMLElement>(".plan-card").forEach((c) =>
    c.addEventListener("click", () => openPlan(c.dataset.id!)),
  );
  restoreScroll();
}

/** Return from a plan reader to the grid. When the reader is an active back-stack layer, dismiss it
 *  (which unwinds its history entry and renders the grid); otherwise just render the grid. */
function backToGrid(): void {
  if (overlayOpen("plan")) dismissOverlay("plan");
  else renderAutopilotGrid();
}

// Keep the floating Refine window clear of the on-screen keyboard. interactive-widget=resizes-content
// handles this on Android (the layout viewport shrinks, so a bottom-anchored fixed element rides up),
// but iOS/PWA overlay the keyboard without resizing — there `window.innerHeight` stays full while
// `visualViewport.height` shrinks, and that gap is the keyboard's height. Lift the window by it so the
// input never ends up buried. No-op (inset 0) when the keyboard is closed or interactive-widget applies.
function positionRefineWindow(): void {
  const win = document.getElementById("plan-refine");
  const fab = document.getElementById("plan-refine-toggle");
  if (!win && !fab) return;
  const vv = window.visualViewport;
  const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  if (win?.classList.contains("open")) (win as HTMLElement).style.bottom = `${inset + 16}px`;
  if (fab) (fab as HTMLElement).style.bottom = `${inset + 16}px`;
}
window.visualViewport?.addEventListener("resize", positionRefineWindow);
window.visualViewport?.addEventListener("scroll", positionRefineWindow);

/** The full-plan reader + refine chat + Dismiss/Go, rendered in place of the grid (same overlay). */
/** Render the autonomous-dev-pipeline trace (§7) as a card above the plan doc in the reader. */
function renderPipelineTrace(t: PipelineTraceInfo): string {
  const cls = t.status === "shipped" ? "ok" : t.status === "operator_required" ? "warn" : "danger";
  const prLink = t.prRef
    ? /^https?:/.test(t.prRef)
      ? `<a href="${esc(t.prRef)}" target="_blank" rel="noopener">${esc(t.prRef)}</a>`
      : esc(t.prRef)
    : "";
  const check = (label: string, v?: string): string =>
    v ? `<span class="pt-check pt-${esc(v)}">${label}: ${esc(v)}</span>` : "";
  const loops = t.loopbacks.filter((l) => l.count > 0).map((l) => `${esc(l.phase)} ×${l.count}`).join(", ");
  const criteria = t.criteria
    .map((c) => `<li><code>${esc(c.id)}</code> <span class="small muted">[${esc(c.kind)}]</span> ${esc(c.text)}</li>`)
    .join("");
  const rows = t.assignments
    .map((a) => `<tr><td>${esc(a.phase)}</td><td>${esc(a.author)}</td><td>${a.adversary ? esc(a.adversary) : "—"}</td></tr>`)
    .join("");
  return `<section class="card pipeline-trace">
    <div class="pt-head">${icon("hub")} <b>Autonomous pipeline</b>
      <span class="pt-status ${cls}">${esc(t.status.replace(/_/g, " "))}</span>
      <span class="small muted">reached ${esc(t.phaseReached)}${t.riskTier ? ` · ${esc(t.riskTier)} tier` : ""}</span></div>
    ${t.reason ? `<p class="small">${esc(t.reason)}</p>` : ""}
    ${prLink ? `<p class="small">PR: ${prLink}</p>` : ""}
    <div class="pt-checks">${check("criteria", t.verification.criteriaTests)}${check("adversary tests", t.verification.adversaryTests)}${check("lint/types/build", t.verification.lintTypesBuild)}${t.verification.coverage ? `<span class="pt-check">coverage: ${esc(t.verification.coverage)}</span>` : ""}</div>
    ${loops ? `<p class="small muted">Loop-backs: ${esc(loops)}</p>` : ""}
    ${t.validationNote ? `<p class="small"><b>Built vs. asked:</b> ${esc(t.validationNote)}</p>` : ""}
    ${criteria ? `<details class="pt-details"><summary class="small">Acceptance criteria (${t.criteria.length})</summary><ul class="small">${criteria}</ul></details>` : ""}
    ${rows ? `<details class="pt-details"><summary class="small">Model assignment per phase</summary><table class="pt-table small"><thead><tr><th>Phase</th><th>Author</th><th>Adversary</th></tr></thead><tbody>${rows}</tbody></table></details>` : ""}
  </section>`;
}

function openPlan(id: string): void {
  const p = findPlan(id);
  const host = document.getElementById("autopilot-grid");
  if (!p || !host) return;
  const body = apScrollBody();
  if (body && openPlanId === null) apGridScroll = body.scrollTop; // remember where the grid was
  openPlanId = id;
  const env = p.environmentName ?? (p.environmentId ? environments.get(p.environmentId)?.name : undefined);
  // A held (needs-clarification) unit can't be built until its questions are answered: its "plan" is just
  // the open questions. Disable Start / hide Pipeline and point the reviewer at Refine instead.
  const held = p.status === "needs-clarification";
  host.innerHTML = `<div class="plan-reader" data-id="${esc(id)}">
    <div class="plan-reader-head">
      <button class="mini" id="plan-back">${icon("arrow_back")} All plans</button>
      <span class="plan-reader-title">${esc(p.title)}${env ? ` <span class="small muted">· ${esc(env)}</span>` : ""}</span>
      <span class="plan-reader-actions">
        <button class="mini" id="plan-complete">${icon("check_circle")} Complete</button>
        <button class="mini" id="plan-expire">${icon("schedule")} Expired</button>
        <button class="mini danger" id="plan-dismiss">${icon("close")} Dismiss</button>
        <button class="mini" id="plan-reassign">${icon("swap_horiz")} Reassign</button>
        <button class="mini" id="plan-link">${icon("link")} Link</button>
        <button class="mini" id="plan-pipeline" title="Run the autonomous multi-model pipeline (Claude + GLM) end to end"${held ? " hidden" : ""}>${icon("hub")} Pipeline</button>
        <button class="primary" id="plan-start"${held ? ` disabled title="Answer the open questions (Refine) to unblock"` : ""}>${held ? `${icon("lock")} Needs answers` : `${icon("rocket_launch")} Start`}</button>
      </span>
    </div>
    <div class="plan-reader-body">
      ${p.pipeline ? renderPipelineTrace(p.pipeline) : ""}
      <article class="md plan-doc" id="plan-doc">${p.plan?.html ?? "<p class='muted'>No plan content.</p>"}</article>
    </div>
    <div class="plan-refine-backdrop" id="plan-refine-backdrop" hidden></div>
    <aside class="plan-refine plan-refine-drawer" id="plan-refine" aria-hidden="true">
      <div class="plan-refine-head">
        <h4>${icon("auto_awesome")} Refine with Claude</h4>
        <button class="icon-btn" id="plan-refine-close" title="Close">${icon("close")}</button>
      </div>
      <p class="small muted">Suggest a change; Claude rewrites the plan and saves it back to Todoist.</p>
      <div id="plan-refine-log" class="plan-refine-log"></div>
      <form id="plan-refine-form" class="plan-refine-form">
        <textarea id="plan-refine-input" rows="2" placeholder="e.g. also cover the offline case, and keep the existing API"></textarea>
        <button type="submit" class="primary" id="plan-refine-send" title="Send">${icon("send")}</button>
      </form>
    </aside>
    <button class="plan-refine-fab" id="plan-refine-toggle" aria-pressed="false" title="Refine with Claude">${icon("auto_awesome")} Refine</button>
  </div>`;
  // The reader is its own back-stack layer (no hash of its own — it lives inside the autopilot
  // overlay's #autopilot URL): device/browser Back pops just this layer back to the grid instead of
  // unwinding the whole Autopilot view to the conversation. Closing it in-app goes through backToGrid.
  openOverlay("plan", () => renderAutopilotGrid());
  // The refine conversation is a dismissible side drawer (Option A): the plan reads full-width and the
  // chat slides in over the right edge on demand, so investigating a plan never squeezes the document.
  const refineDrawer = $("#plan-refine");
  const refineBackdrop = $("#plan-refine-backdrop");
  const refineToggle = $("#plan-refine-toggle");
  const setRefineOpen = (open: boolean): void => {
    refineDrawer.classList.toggle("open", open);
    refineDrawer.setAttribute("aria-hidden", open ? "false" : "true");
    refineToggle.setAttribute("aria-pressed", open ? "true" : "false");
    refineToggle.hidden = open; // the window takes over the corner — hide the FAB behind it
    refineBackdrop.hidden = !open;
    positionRefineWindow(); // sit the window (and FAB) above the keyboard before it animates in
    // preventScroll: focusing the textarea otherwise makes the browser scroll the plan body to reveal
    // it, snapping the document to the bottom every time the window opens.
    if (open) ($("#plan-refine-input") as HTMLTextAreaElement).focus({ preventScroll: true });
  };
  refineToggle.addEventListener("click", () => setRefineOpen(!refineDrawer.classList.contains("open")));
  $("#plan-refine-close").addEventListener("click", () => setRefineOpen(false));
  refineBackdrop.addEventListener("click", () => setRefineOpen(false));
  $("#plan-back").addEventListener("click", () => backToGrid());
  $("#plan-complete").addEventListener("click", () => void resolvePlan(id, "completed"));
  $("#plan-expire").addEventListener("click", () => void resolvePlan(id, "expired"));
  $("#plan-dismiss").addEventListener("click", () => void dismissPlan(id));
  $("#plan-reassign").addEventListener("click", () => void reassignPlan(id));
  $("#plan-link").addEventListener("click", () => void linkPlanToSession(id));
  $("#plan-start").addEventListener("click", () => void startPlan(id));
  $("#plan-pipeline").addEventListener("click", () => void startDevPipeline(id));
  $("#plan-refine-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void refinePlan(id);
  });
  // Enter sends, Shift+Enter newlines — same as the main composer, so the chat actually submits
  // (a bare textarea swallows Enter as a newline, which read as "refine does nothing").
  $<HTMLTextAreaElement>("#plan-refine-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $<HTMLFormElement>("#plan-refine-form").requestSubmit();
    }
  });
  // A fresh plan reads from the top, not wherever the grid (or a prior plan) was scrolled to.
  if (body) body.scrollTop = 0;
  document.querySelector(".plan-reader-body")?.scrollTo(0, 0);
}

/** The server that owns a plan (refine/dismiss/start route there), or undefined if offline/unknown.
 *  Uses {@link serverByUrl} (not a raw `servers.get`) so a plan tagged to a member whose url has drifted
 *  scheme/slash still routes to the connected owner instead of falsely reporting "server offline". */
function planSock(id: string): Server | undefined {
  return serverByUrl(planServer.get(id));
}

async function refinePlan(id: string): Promise<void> {
  const input = $<HTMLTextAreaElement>("#plan-refine-input");
  const feedback = input.value.trim();
  if (!feedback) return;
  const srv = planSock(id);
  if (!srv?.sock.isOpen()) {
    toast("That plan's server is offline");
    return;
  }
  const log = $("#plan-refine-log");
  log.insertAdjacentHTML("beforeend", `<div class="rf-msg rf-you">${esc(feedback)}</div>`);
  const pending = document.createElement("div");
  pending.className = "rf-msg rf-claude rf-pending";
  pending.innerHTML = `<span class="dots"><i></i><i></i><i></i></span> Refining…`;
  log.appendChild(pending);
  log.scrollTop = log.scrollHeight;
  input.value = "";
  const send = $<HTMLButtonElement>("#plan-refine-send");
  send.disabled = true;
  try {
    // Refine runs a fresh read-only Opus pass over the repo — that can take minutes, so allow the same
    // generous budget as a full autopilot run rather than the old 3-min cap (which timed out mid-think).
    const res = await sendAwait(srv, { type: "autopilot.refine", workUnitId: id, feedback, cid: newCid() }, 600_000);
    if (res.type === "command.error") {
      pending.className = "rf-msg rf-claude rf-err";
      pending.textContent = res.message;
      return;
    }
    if (res.type !== "autopilot.plan") return;
    pending.className = "rf-msg rf-claude";
    pending.textContent = "Updated the plan.";
    const doc = document.getElementById("plan-doc");
    if (doc && res.plan.plan) doc.innerHTML = res.plan.plan.html;
  } catch (err) {
    pending.className = "rf-msg rf-claude rf-err";
    pending.textContent = `Refine failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (document.getElementById("plan-refine-send")) send.disabled = false;
  }
}

async function dismissPlan(id: string): Promise<void> {
  const p = findPlan(id);
  const ok = await confirmDialog({
    title: "Dismiss this plan?",
    body: `“${p?.title ?? "This plan"}” will be removed and its Todoist tasks labelled anvil:dismissed, so the nightly run won't re-plan them.`,
    confirmLabel: "Dismiss",
    danger: true,
    icon: "close",
  });
  if (!ok) return;
  const srv = planSock(id);
  if (!srv?.sock.isOpen()) {
    toast("That plan's server is offline");
    return;
  }
  try {
    const res = await sendAwait(srv, { type: "autopilot.dismiss", workUnitId: id, cid: newCid() }, 60_000);
    if (res.type === "command.error") {
      toast(res.message);
      return;
    }
    toast("Plan dismissed");
    backToGrid(); // the broadcast also refreshes, but don't wait on it
  } catch (err) {
    toast(`Dismiss failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Mark a plan completed or expired and drop its card. Offers to also close the linked Todoist
 *  task(s) — defaulted on for "completed" (the work is done), off for "expired". */
async function resolvePlan(id: string, status: "completed" | "expired"): Promise<void> {
  const p = findPlan(id);
  const verb = status === "completed" ? "Complete" : "Expire";
  const res = await confirmDialogWithOption({
    title: `Mark this plan ${status}?`,
    body: `“${p?.title ?? "This plan"}” will be labelled anvil:${status} and removed from the pending grid.`,
    confirmLabel: verb,
    icon: status === "completed" ? "check_circle" : "schedule",
    optionLabel: "Also close the linked task(s) in Todoist",
    optionChecked: status === "completed",
  });
  if (!res.ok) return;
  const srv = planSock(id);
  if (!srv?.sock.isOpen()) {
    toast("That plan's server is offline");
    return;
  }
  try {
    const reply = await sendAwait(srv, { type: "autopilot.resolve", workUnitId: id, status, closeTodoist: res.checked, cid: newCid() }, 60_000);
    if (reply.type === "command.error") {
      toast(reply.message);
      return;
    }
    toast(res.checked ? `Plan ${status} · Todoist task closed` : `Plan ${status}`);
    backToGrid(); // the broadcast also refreshes, but don't wait on it
  } catch (err) {
    toast(`${verb} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function startPlan(id: string): Promise<void> {
  const srv = planSock(id);
  if (!srv?.sock.isOpen()) {
    toast("That plan's server is offline");
    return;
  }
  const btn = document.getElementById("plan-start") as HTMLButtonElement | null;
  const reset = (): void => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `${icon("rocket_launch")} Create session & start`;
    }
  };
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${icon("hourglass_empty")} Starting…`;
  }
  try {
    const res = await sendAwait(srv, { type: "autopilot.start", workUnitId: id, cid: newCid() }, 60_000);
    if (res.type === "command.error") {
      toast(res.message);
      reset();
      return;
    }
    if (res.type !== "autopilot.started") {
      reset();
      return;
    }
    // The session.created broadcast arrives before this reply, so the session is already registered.
    dismissOverlay("autopilot");
    selectSession(res.sessionId);
  } catch (err) {
    toast(`Couldn't start: ${err instanceof Error ? err.message : String(err)}`);
    reset();
  }
}

/** Kick off the autonomous multi-model dev pipeline for a plan (opt-in). Long-running (many model
 *  calls across both models); progress streams to the autopilot run log and the card status updates on
 *  completion, so we fire-and-forget rather than blocking on the result. */
async function startDevPipeline(id: string): Promise<void> {
  const srv = planSock(id);
  if (!srv?.sock.isOpen()) {
    toast("That plan's server is offline");
    return;
  }
  const ok = await confirmDialog({
    title: "Run the autonomous pipeline?",
    body: "Claude and GLM run the full gated pipeline — requirements → design → build → verify → validate → PR — on this unit in a fresh worktree. This makes many model calls and can take a while; progress shows in the run log and the card updates when it finishes.",
    confirmLabel: "Run pipeline",
    icon: "hub",
  });
  if (!ok) return;
  srv.sock.send({ type: "autopilot.pipeline.start", workUnitId: id, cid: newCid() });
  toast("Pipeline started — watch the run log for progress.");
  dismissOverlay("plan");
}

/** Attach a plan to an existing session that's already doing the work instead of spawning a new one.
 *  Offers the active sessions in the plan's environment; on pick, links and jumps to that session
 *  (the card then leaves the grid, exactly like Go). */
async function linkPlanToSession(id: string): Promise<void> {
  const p = findPlan(id);
  if (!p) return;
  const srv = planSock(id);
  if (!srv?.sock.isOpen()) {
    toast("That plan's server is offline");
    return;
  }
  // Active sessions on the plan's server, in the same environment (concierge/archived excluded).
  const candidates = [...sessions.values()].filter(
    (s) => !s.isDefault && !s.archived && s.environmentId === p.environmentId && sessionServer.get(s.id) === srv.url,
  );
  if (!candidates.length) {
    toast("No active session in this plan's environment to link to");
    return;
  }
  const sid = await pickListDialog(
    `Link “${p.title}” to…`,
    candidates.map((s) => ({ id: s.id, label: s.title || s.id, icon: s.icon ?? "terminal" })),
  );
  if (!sid) return;
  try {
    const res = await sendAwait(srv, { type: "autopilot.link", workUnitId: id, sessionId: sid, cid: newCid() }, 60_000);
    if (res.type === "command.error") {
      toast(res.message);
      return;
    }
    if (res.type !== "autopilot.started") return;
    dismissOverlay("autopilot");
    selectSession(res.sessionId);
  } catch (err) {
    toast(`Link failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Reassign a (possibly mis-routed, e.g. label-sourced) plan to a different environment and re-evaluate
 *  it against that repo. Picks from the environments on the plan's server; updates the open reader in
 *  place when the replan returns (the slow part — a fresh read-only Opus pass). */
async function reassignPlan(id: string): Promise<void> {
  const p = findPlan(id);
  if (!p) return;
  const srv = planSock(id);
  if (!srv?.sock.isOpen()) {
    toast("That plan's server is offline");
    return;
  }
  const candidates = [...environments.values()].filter((e) => envServer.get(e.id) === srv.url && e.id !== p.environmentId);
  if (!candidates.length) {
    toast("No other environment on this server to reassign to");
    return;
  }
  const envId = await pickListDialog(
    `Re-evaluate “${p.title}” against…`,
    candidates.map((e) => ({ id: e.id, label: e.name, icon: "folder" })),
    "swap_horiz",
  );
  if (!envId) return;
  const doc = document.getElementById("plan-doc");
  const btn = document.getElementById("plan-reassign") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${icon("hourglass_empty")} Re-evaluating…`;
  }
  doc?.classList.add("dim");
  try {
    // A reassign re-plans the unit against the new repo (read-only Opus) — allow the same generous
    // budget as refine rather than the default short cap.
    const res = await sendAwait(srv, { type: "autopilot.reassign", workUnitId: id, environmentId: envId, cid: newCid() }, 600_000);
    if (res.type === "command.error") {
      toast(res.message);
      return;
    }
    if (res.type !== "autopilot.plan") return;
    toast("Plan re-evaluated");
    if (doc && res.plan.plan) doc.innerHTML = res.plan.plan.html; // refresh the reader in place (grid re-flows via broadcast)
  } catch (err) {
    toast(`Reassign failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    doc?.classList.remove("dim");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `${icon("swap_horiz")} Reassign env`;
    }
  }
}

/** Re-plan linked Todoist projects on every connected server; stream progress into the log. */
async function runAutopilot(): Promise<void> {
  // Only servers new enough to run the autopilot pipeline — an older member would just reject it.
  const targets = orderedServers().filter((s) => s.sock.isOpen() && serverSupports(s, "autopilot"));
  if (!targets.length) {
    toast("No autopilot-capable servers connected");
    return;
  }
  autopilotLog.length = 0;
  runState.running = true;
  runState.serversTotal = targets.length;
  runState.lastLine = "";
  runState.results = [];
  reflectAutopilotRunning();
  onAutopilotProgress("Running autopilot…");
  const btn = $<HTMLButtonElement>("#autopilot-run");
  btn.disabled = true;
  btn.innerHTML = `${icon("hourglass_empty")} Running…`;
  let created = 0;
  try {
    for (const srv of targets) {
      try {
        const res = await sendAwait(srv, { type: "autopilot.run", cid: newCid() }, 600_000);
        if (res.type === "autopilot.run.result") {
          created += res.created;
          runState.results.push({ name: srv.name, ok: res.ok, created: res.created, skipped: res.skipped, error: res.ok ? undefined : res.output });
          onAutopilotProgress(res.ok ? `✓ ${srv.name}: ${res.created} new · ${res.skipped} already in pipeline` : `⚠ ${srv.name}: ${res.output}`);
        } else if (res.type === "command.error") {
          // e.g. "an autopilot run is already in progress" — record it per-server (the global
          // command.error toast no longer fires for awaited commands).
          runState.results.push({ name: srv.name, ok: false, created: 0, skipped: 0, error: res.message });
          onAutopilotProgress(`⚠ ${srv.name}: ${res.message}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runState.results.push({ name: srv.name, ok: false, created: 0, skipped: 0, error: msg });
        onAutopilotProgress(`⚠ ${srv.name}: ${msg}`);
      }
    }
    toast(created ? `${created} new plan${created === 1 ? "" : "s"}` : "No new plans");
  } finally {
    runState.running = false;
    reflectAutopilotRunning();
    btn.disabled = false;
    btn.innerHTML = `${icon("play_arrow")} Run autopilot`;
  }
}

// ── Scheduled run (in-daemon timer; the control targets the hub) ────────────────────
// Surfaced in two places — the Autopilot view's bar and a card in Settings → Todoist — so changes
// made in either (or pushed from another device) refresh both.
function onAutopilotSchedule(url: string, schedule: AutopilotSchedule, nextRunAt?: string, running = false): void {
  serverSchedule.set(url, { schedule, nextRunAt, running });
  // Arm the backstop while this server says it's running; disarm the moment it reports done, so a normal
  // run never trips it and only a server that never sends `false` ages out.
  if (running) armStaleRunTimer(url);
  else clearStaleRunTimer(url);
  reflectAutopilotRunning(); // a run on ANY server (incl. one started from another device) shows here
  if (url !== HUB_URL) return;
  if (document.getElementById("autopilot-schedule")) renderScheduleBar();
  if (document.getElementById("todoist-panel")) renderTodoistPanel();
}
const fmtTime = (hhmm: string): string => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
};
const fmtNextRun = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
};
/** The hub's schedule as a one-line summary (shared by the Autopilot bar and the Settings card). */
function scheduleSummaryHtml(): string {
  const entry = serverSchedule.get(HUB_URL);
  const s = entry?.schedule;
  if (!s || !s.enabled) return `<span class="muted">${icon("schedule")} Scheduled run off</span>`;
  const auto = s.autoStart ? `${s.usePipeline ? "pipeline" : "auto-start"} ${s.maxAutoStart ?? 3}` : "plan only";
  const next = entry?.nextRunAt ? ` · next ${esc(fmtNextRun(entry.nextRunAt))}` : "";
  return `<span>${icon("schedule")} Daily ${esc(fmtTime(s.timeOfDay))} · ${esc(auto)}${next}</span>`;
}
function renderScheduleBar(): void {
  const host = document.getElementById("autopilot-schedule");
  if (!host) return;
  host.innerHTML = `${scheduleSummaryHtml()}<button class="mini ap-sched-edit-btn" id="ap-sched-edit">${icon("tune")} Schedule</button>`;
  $("#ap-sched-edit").addEventListener("click", openScheduleModal);
}
/** A Settings → Todoist card mirroring the schedule, so it can be configured without opening Autopilot. */
function scheduleSettingsCardHtml(): string {
  return `<div class="card schedule-card" id="todoist-schedule">
    <div class="card-main">${scheduleSummaryHtml()}<button class="mini" id="set-sched-edit" style="margin-left:auto">${icon("tune")} Edit</button></div>
    <p class="small muted">An in-daemon timer on every fleet server re-plans its linked projects and (when auto-start is on) launches the new work. Review &amp; launch plans in the <b>Autopilot</b> section.</p>
  </div>`;
}

function openScheduleModal(): void {
  const cur = serverSchedule.get(HUB_URL)?.schedule;
  const s: AutopilotSchedule = cur ?? { enabled: false, timeOfDay: "02:00", autoStart: true, maxAutoStart: 3 };
  const days = s.days && s.days.length ? new Set(s.days) : new Set([0, 1, 2, 3, 4, 5, 6]);
  const dayBtns = DAY_LABEL.map(
    (d, i) => `<button type="button" class="ap-day${days.has(i) ? " on" : ""}" data-day="${i}">${d}</button>`,
  ).join("");
  // The label-sourcing catch-all targets one of the hub's environments (the schedule modal is hub-scoped).
  const hubEnvs = [...environments.values()].filter((e) => envServer.get(e.id) === HUB_URL);
  const envOptions =
    `<option value="">— none —</option>` +
    hubEnvs.map((e) => `<option value="${esc(e.id)}"${e.id === s.defaultEnvironmentId ? " selected" : ""}>${esc(e.name)}</option>`).join("");
  const m = document.createElement("div");
  m.className = "modal";
  const toggle = (id: string, on: boolean, label: string): string =>
    `<button type="button" class="ap-toggle${on ? " on" : ""}" id="${id}" aria-pressed="${on}"><span class="ap-toggle-box">${icon("check")}</span><span>${label}</span></button>`;
  m.innerHTML = `<div class="modal-box ap-sched-modal" id="ap-sched-modal"><h3>${icon("schedule")} Scheduled autopilot run</h3>
    <p class="small muted">An in-daemon timer on every server in the fleet re-plans its own linked Todoist projects and (when auto-start is on) launches the new work. Times are each server's local time.</p>
    ${toggle("ap-enabled", s.enabled, "Enable scheduled run")}
    <div class="ap-sched-body" id="ap-sched-body">
      <label class="ap-field-row"><span>Time of day</span><input type="time" id="ap-time" value="${esc(s.timeOfDay)}" /></label>
      <div class="ap-field"><span>Days</span><div class="ap-days" id="ap-days">${dayBtns}</div></div>
      ${toggle("ap-autostart", s.autoStart, "Auto-start sessions for new plans")}
      ${toggle("ap-pipeline", s.usePipeline ?? false, "Use the autonomous pipeline (Claude + GLM → PR)")}
      <p class="small muted" style="margin:-2px 0 6px">When on, auto-started units run the full multi-model gauntlet (requirements → build → verify → validate → PR) unattended instead of opening a chat session. Needs an OpenRouter key and, for a real test gate, per-environment validation commands.</p>
      <label class="ap-field-row"><span>Auto-start at most</span><input type="number" id="ap-cap" min="0" max="20" value="${s.maxAutoStart ?? 3}" /><span class="small muted">per run (the rest wait for manual launch; skipped while the budget is in its warn zone)</span></label>
      <label class="ap-field-row"><span>Autopilot label</span><input type="text" id="ap-label" value="${esc(s.label ?? "")}" placeholder="Autopilot" /><span class="small muted">tasks with this Todoist label are pulled in from <b>any</b> project (blank = off)</span></label>
      <label class="ap-field-row"><span>Default environment</span><select id="ap-defenv">${envOptions}</select><span class="small muted">where label-sourced tasks are planned &amp; built — always review-only</span></label>
    </div>
    <div class="btns"><button type="button" id="ap-sched-cancel">Cancel</button><button type="button" id="ap-sched-save" class="primary">Save</button></div></div>`;
  showModal(m);
  const syncEnabled = (): void => {
    $("#ap-sched-body").classList.toggle("dim", $("#ap-enabled").getAttribute("aria-pressed") !== "true");
  };
  m.querySelectorAll<HTMLElement>(".ap-toggle").forEach((b) =>
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      b.classList.toggle("on", on);
      if (b.id === "ap-enabled") syncEnabled();
    }),
  );
  m.querySelectorAll<HTMLElement>(".ap-day").forEach((b) =>
    b.addEventListener("click", () => b.classList.toggle("on")),
  );
  syncEnabled();
  $("#ap-sched-cancel").addEventListener("click", closeModal);
  $("#ap-sched-save").addEventListener("click", () => void saveSchedule());
}
async function saveSchedule(): Promise<void> {
  const isOn = (id: string): boolean => document.getElementById(id)?.getAttribute("aria-pressed") === "true";
  const enabled = isOn("ap-enabled");
  const timeOfDay = $<HTMLInputElement>("#ap-time").value || "02:00";
  const autoStart = isOn("ap-autostart");
  const usePipeline = isOn("ap-pipeline");
  const maxAutoStart = Math.max(0, Number($<HTMLInputElement>("#ap-cap").value) || 0);
  const on = [...document.querySelectorAll<HTMLElement>("#ap-days .ap-day.on")].map((b) => Number(b.dataset.day));
  // all 7 selected → send [] (every day); none selected → keep it simple and treat as every day too
  const days = on.length === 0 || on.length === 7 ? [] : on.sort((a, b) => a - b);
  const label = $<HTMLInputElement>("#ap-label").value.trim();
  const defaultEnvironmentId = $<HTMLSelectElement>("#ap-defenv").value;
  // Push the same schedule to EVERY connected autopilot-capable server, not just the hub. Autopilot
  // runs per-daemon ("autopilot runs where the repo lives"), so a member-hosted project (e.g. lapo on
  // the M1) only gets nightly cards once ITS daemon's timer is enabled. The catch-all
  // (defaultEnvironmentId) is a hub env id, so the account-wide label pass still fires on the hub
  // only — on a member that id won't resolve, so it skips the label pass and just re-plans its own
  // linked projects. (lastRunAt stays server-owned and per-daemon.)
  const targets = orderedServers().filter((s) => s.sock.isOpen() && serverSupports(s, "autopilot"));
  const patch = { type: "autopilot.schedule.set" as const, enabled, timeOfDay, days, autoStart, usePipeline, maxAutoStart, label, defaultEnvironmentId };
  try {
    const hubIdx = targets.findIndex((s) => s.url === HUB_URL);
    const results = await Promise.allSettled(targets.map((s) => sendAwait(s, { ...patch, cid: newCid() }, 20_000)));
    const hubRes = hubIdx >= 0 ? results[hubIdx] : undefined;
    if (hubRes?.status === "fulfilled" && hubRes.value.type === "command.error") {
      toast(hubRes.value.message); // surface the hub's validation error (it owns the catch-all config)
      return;
    }
    const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && r.value.type === "command.error")).length;
    closeModal();
    if (!enabled) toast("Scheduled run off");
    else if (failed) toast(`Schedule saved on ${targets.length - failed}/${targets.length} servers`);
    else toast(targets.length > 1 ? `Schedule saved on all ${targets.length} servers` : "Schedule saved");
  } catch (err) {
    toast(`Couldn't save schedule: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One card per server in the fleet (hub first): live status, version, update & remove. */
function serverCardHtml(srv: Server): string {
  const isHub = srv.url === HUB_URL;
  const id = cssId(srv.url);
  const ver = srv.version ? ` · anvild ${esc(srv.version)}` : "";
  const state = srv.status === "connected" ? "" : ` · <span class="warn-text">${esc(srv.status)}</span>`;
  // Every Mac runs its own daemon, so "Update Anvil" is per-server (the hub no longer has a monopoly).
  // Remove is an X in the card's top-right corner (a confirm dialog sits behind it); the hub can't be removed.
  const tail = isHub ? '<span class="small muted">(this server)</span>' : "";
  const removeX = isHub ? "" : `<button class="card-x danger" id="srv-remove-${id}" title="Remove this Mac">${icon("close")}</button>`;
  return `<div class="card server-card" id="srv-card-${id}">
    ${removeX}
    <div class="card-main"><span class="conn-dot ${srv.status}"></span><b>${esc(srv.name)}</b> ${tail}</div>
    <div class="small muted"><code>${esc(hostOf(srv.url))}</code>${ver}${state}</div>
    <div class="git-row" style="margin-top:10px"><button class="mini" id="daemon-update-${id}">${icon("refresh")} Update Anvil</button></div>
    <pre class="git-output" id="daemon-update-output-${id}" hidden></pre>
  </div>`;
}
function renderServerCards(): void {
  const host = document.getElementById("server-cards");
  if (!host) return;
  const list = orderedServers();
  // One unified list: each card IS a Mac in the fleet (sharing this login). No separate members list —
  // it duplicated the cards. "Add a Mac" is a dialog behind the + button, not an always-on form.
  host.innerHTML =
    `<div class="section-head"><h3>${icon("hub")} Fleet</h3><div class="git-row">` +
    `<button id="fleet-rotate" class="mini" title="Push the current login to every Mac in the fleet">${icon("autorenew")} Update token</button>` +
    `<button id="fleet-add" class="mini primary">${icon("add")} Add a Mac</button>` +
    `</div></div>` +
    `<p class="small muted">Every Mac here shares this server's Claude login. Update each one's Anvil on its own card; remove one to stop using it from this device.</p>` +
    list.map(serverCardHtml).join("");
  for (const srv of list) {
    wireDaemonUpdate(srv); // each card's "Update Anvil" targets that server's own daemon
    if (srv.url !== HUB_URL) {
      document.getElementById(`srv-remove-${cssId(srv.url)}`)?.addEventListener("click", () => void confirmRemoveServer(srv));
    }
  }
  document.getElementById("fleet-add")?.addEventListener("click", () => showAddMac());
  document.getElementById("fleet-rotate")?.addEventListener("click", () => void rotateFleetToken());
  void loadFleetMembers(); // cache host→serverId (so Remove also ejects from the fleet) + adopt any member this device hasn't connected to
  if (nativeBridge) {
    const bridge = nativeBridge; // local const so the non-undefined narrowing flows into the closures below
    const setOut = (t: string): void => {
      const el = document.getElementById("adb-output");
      if (el) el.textContent = t;
    };
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="card"><div class="card-main">${icon("smartphone")} <b>This phone (ADB over wifi)</b></div>
      <div class="small muted" id="adb-info">Loading device info…</div>
      <div class="git-row" style="margin-top:10px"><button class="primary" id="adb-connect">${icon("wifi")} Connect</button></div>
      <hr />
      <div class="small muted">First time on this Mac? On the phone open <b>Settings → Developer options → Wireless debugging → Pair device with pairing code</b>, then enter the 6-digit code here:</div>
      <div class="git-row" style="margin-top:8px">
        <input id="adb-pair-code" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="6-digit code" style="max-width:140px" />
        <button id="adb-pair">${icon("link")} Pair this Mac</button>
      </div>
      <pre class="git-output" id="adb-output"></pre></div>`,
    );
    $("#adb-connect").addEventListener("click", () => {
      setOut("Discovering phone…");
      bridge.postMessage(JSON.stringify({ type: "adb.connect" }));
    });
    $("#adb-pair").addEventListener("click", () => {
      const code = $<HTMLInputElement>("#adb-pair-code").value.trim();
      if (!/^\d{6}$/.test(code)) {
        setOut("Enter the 6-digit pairing code shown on the phone.");
        return;
      }
      setOut("Pairing… (keep the pairing dialog open on the phone)");
      bridge.postMessage(JSON.stringify({ type: "adb.pair", code }));
    });
    void apiFetch("/api/adb/info")
      .then((r) => r.json())
      .then((d: { serverIps?: string[]; devices?: string }) => {
        const el = document.getElementById("adb-info");
        if (!el) return;
        const devs = (d.devices ?? "").split("\n").filter((l) => l.trim() && !/list of devices/i.test(l));
        el.innerHTML = `Mac IP: <code>${esc((d.serverIps ?? []).join(", ") || "?")}</code> — uses Tailscale when both are on your tailnet (works across networks); else same LAN.<br/>adb devices: <code>${esc(devs.length ? devs.join("; ") : "none connected")}</code>`;
      })
      .catch(() => {});
  }
}
// ── Fleet administration (manage from any client — anvil-server-app.md §6) ──────────────────────
// All calls hit the HUB daemon (apiFetch); it distributes its own OAuth token and never returns it.
interface FleetMember { serverId: string; serverName: string; host: string; url: string }
// host → serverId for every Mac the hub knows as a fleet member. Lets a server card's "Remove" also
// eject that Mac from the fleet (the old separate "Forget" action), so there's one button, not two.
const fleetMemberIdByHost = new Map<string, string>();

/** Push the current login to every Mac in the fleet (hub fans it out). Header "Update token" button. */
async function rotateFleetToken(): Promise<void> {
  toast("Pushing the current login to every Mac…");
  try {
    const r = (await (await apiFetch("/api/fleet/rotate", { method: "POST" })).json()) as { ok: boolean; results: { host: string; ok: boolean }[] };
    const okN = r.results.filter((x) => x.ok).length;
    toast(`Updated ${okN}/${r.results.length} Macs.`);
  } catch { toast("Couldn't push the login — is the hub reachable?"); }
}

/** The "+ Add a Mac" dialog: invite by join code (primary), or adopt a server that's already running. */
function showAddMac(): void {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>${icon("add")} Add a Mac</h3>
    <p class="small muted">On the new Mac open <b>Anvil Server → Join a fleet</b> for a 6-digit code. Pick it here and enter the code — no IP to track down. It'll share this server's Claude login.</p>
    <label>Mac<div class="env-row"><select id="fleet-host"><option value="">Scanning your tailnet…</option></select></div></label>
    <label>Join code<input id="fleet-code" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="6-digit code" /></label>
    <div id="fleet-status" class="small muted"></div>
    <div class="btns"><button type="button" id="am-close">Done</button><button type="button" id="fleet-invite" class="primary">${icon("add")} Add</button></div>
  </div>`;
  showModal(m);
  enhanceSelect(document.getElementById("fleet-host") as HTMLSelectElement | null);
  void loadFleetPeers();
  const setStatus = (t: string): void => { const el = document.getElementById("fleet-status"); if (el) el.textContent = t; };
  $<HTMLButtonElement>("#am-close").onclick = closeModal; // returns to Settings underneath
  document.getElementById("fleet-invite")?.addEventListener("click", async () => {
    const host = ($<HTMLSelectElement>("#fleet-host").value || "").trim();
    const code = ($<HTMLInputElement>("#fleet-code").value || "").trim();
    if (!host) { setStatus("Pick the Mac you're adding."); return; }
    if (!/^\d{6}$/.test(code)) { setStatus("Enter the 6-digit code that Mac is showing."); return; }
    setStatus(`Sending the login to ${host} over the tailnet…`);
    try {
      const r = (await (await apiFetch("/api/fleet/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host, code }) })).json()) as { ok: boolean; member?: { url: string }; error?: string };
      if (r.ok) {
        // Onboarded → also connect this client to it so its sessions show up (one step, not two).
        if (r.member?.url) { saveExtraServers([...loadExtraServers(), r.member.url]); ensureServer(r.member.url); }
        $<HTMLInputElement>("#fleet-code").value = "";
        setStatus(`✅ ${host} joined the fleet.`);
        void loadFleetPeers();
        renderServerCards();
      } else {
        setStatus(`Rejected: ${r.error ?? "unknown"}. Make sure that Mac's “Join a fleet” screen is still open.`);
      }
    } catch { setStatus("Couldn't reach the hub daemon."); }
  });
}

/** Click handler for a server card's "Remove": dim the card, eject it from the fleet (if it's a member),
 *  then drop it locally and re-render. "Remove" now does what "Forget" used to — one action, not two. */
async function confirmRemoveServer(srv: Server): Promise<void> {
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
  // If the hub tracks this Mac as a fleet member, ejecting it there stops it sharing the login.
  const memberId = fleetMemberIdByHost.get(hostOf(srv.url));
  if (memberId) {
    try {
      await apiFetch(`/api/fleet/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
      fleetMemberIdByHost.delete(hostOf(srv.url));
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
async function loadFleetMembers(): Promise<void> {
  try {
    const { members } = (await (await apiFetch("/api/fleet/members")).json()) as { members: FleetMember[] };
    fleetMemberIdByHost.clear();
    let adopted = false;
    for (const m of members) {
      fleetMemberIdByHost.set(m.host, m.serverId);
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
    if (adopted && document.getElementById("server-cards")) renderServerCards();
  } catch {
    /* hub unreachable — cards still render from the locally-known servers */
  }
}
/** Fill the "Add a Mac" dropdown from the hub's tailnet peers — so you pick a name, not an IP. */
async function loadFleetPeers(): Promise<void> {
  const sel = document.getElementById("fleet-host") as HTMLSelectElement | null;
  if (!sel) return;
  try {
    const r = (await (await apiFetch("/api/fleet/peers")).json()) as { ok: boolean; peers: { name: string; host: string; online: boolean }[]; warning?: string };
    const knownHosts = new Set([...servers.values()].map((s) => hostOf(s.url)));
    const candidates = (r.peers ?? []).filter((p) => p.online && !knownHosts.has(p.host));
    if (!r.ok) {
      sel.innerHTML = `<option value="">${esc(r.warning ?? "Tailscale unavailable")}</option>`;
    } else if (!candidates.length) {
      sel.innerHTML = `<option value="">No other Macs found on your tailnet</option>`;
    } else {
      sel.innerHTML = `<option value="">Choose a Mac…</option>` + candidates.map((p) => `<option value="${esc(p.host)}" data-icon="computer">${esc(p.name)}</option>`).join("");
    }
  } catch {
    sel.innerHTML = `<option value="">Couldn't scan the tailnet</option>`;
  }
  refreshSelect(sel); // re-read the freshly-populated options into the Tom Select instance
}
/** Wire one server card's "Update Anvil" button: pull that daemon's source, rebuild, and restart it.
 *  Each Mac self-updates independently — the hub no longer has a monopoly on updates. Only a hub
 *  restart reloads this page (it's serving the bundle); a remote restart just reconnects in the list. */
function wireDaemonUpdate(srv: Server): void {
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
      const res = await sendAwait(srv, { type: "daemon.update", cid: newCid() }, 180_000);
      if (res.type === "command.error") {
        out.textContent = `Update failed: ${res.message}`;
        toast("Update failed — see Settings.");
        reset();
        return;
      }
      if (res.type !== "daemon.update.result") {
        reset();
        return;
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
        pendingRestartReload = true;
        spin("Restarting…");
        setUpdateStatus(`${res.output}\n\nUpdate applied. Restarting the daemon — the app will reload automatically when it's back.`);
        setTimeout(() => {
          if (!pendingRestartReload) return;
          pendingRestartReload = false;
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
function renderEnvCards(): void {
  const host = document.getElementById("env-cards");
  if (!host) return;
  const all = [...environments.values()];
  const envCard = (e: Environment): string => `<div class="card env-card" data-env="${esc(e.id)}">
      <div class="env-head">
        <div class="env-meta">
          <b><span class="env-glyph msym" style="color:${stripeColor(e, 0, currentTheme())}">${envIcon(e)}</span>${esc(e.name)}</b>
          <div class="small muted"><code>${esc(e.repoRoot)}</code></div>
          <div class="small muted">${icon("account_tree")} off <code>${esc(e.defaultBase ?? "HEAD")}</code></div>
          ${e.todoistProjectId ? `<div class="small muted">${icon("checklist")} ${esc(todoistProjectName(e.todoistProjectId) ?? "Todoist project")}</div>` : ""}
        </div>
        <div class="env-actions">
          <button class="mini env-readme" data-env="${esc(e.id)}">${icon("description")} README</button>
          <button class="mini env-edit" data-env="${esc(e.id)}">${icon("edit")} Edit</button>
        </div>
      </div>
      <div class="env-readme-body" id="readme-${esc(e.id)}" hidden></div>
    </div>`;
  // One section per server (each repo is local to its daemon). Single-server → one section.
  const srvHead = (srv: Server): string =>
    `<div class="env-server-head"><span class="conn-dot ${srv.status}"></span><b>${esc(srv.name)}</b> <span class="small muted"><code>${esc(hostOf(srv.url))}</code></span></div>`;
  host.innerHTML = orderedServers()
    .map((srv) => {
      const group = all.filter((e) => (envServer.get(e.id) ?? HUB_URL) === srv.url).sort(byEnvName);
      const body = group.length ? group.map(envCard).join("") : `<p class="small muted">No environments on this server yet.</p>`;
      return srvHead(srv) + body;
    })
    .join("");
  host.querySelectorAll<HTMLElement>(".env-edit").forEach((b) => b.addEventListener("click", () => showEditEnvironment(b.dataset.env!)));
  host.querySelectorAll<HTMLElement>(".env-readme").forEach((b) => b.addEventListener("click", () => toggleReadme(b.dataset.env!)));
}
const readmeLoaded = new Set<string>();
async function toggleReadme(id: string): Promise<void> {
  const body = document.getElementById(`readme-${id}`);
  if (!body) return;
  body.hidden = !body.hidden;
  if (body.hidden || readmeLoaded.has(id)) return;
  body.innerHTML = `<p class="small muted">Loading README…</p>`;
  try {
    const r = (await (await serverFetch(serverOfEnv(id).url, `/api/environments/${encodeURIComponent(id)}/readme`)).json()) as { markdown?: { html: string }; text?: string; missing?: boolean };
    if (r.missing) body.innerHTML = `<p class="small muted">No README found in this repo.</p>`;
    else if (r.markdown) {
      body.innerHTML = `<div class="md reader-md">${r.markdown.html}</div>`;
      void runMermaid(body.querySelector(".reader-md") as HTMLElement);
    } else body.innerHTML = `<pre class="reader-text">${esc(r.text ?? "")}</pre>`;
    readmeLoaded.add(id);
  } catch {
    body.innerHTML = `<p class="small muted">Couldn't load the README.</p>`;
  }
}
export function selectSession(id: string, push = true): void {
  if (id !== activeId) saveDraft(activeId, input.value); // stash the outgoing session's unsent draft before we switch
  // On a phone, picking a session collapses the open sidebar. Consume its back-stack entry for
  // the session (replace, don't push) so Back stays balanced.
  let reuseSidebarEntry = false;
  if (push && isNarrow() && overlayOpen("sidebar")) {
    overlays.pop(); // drop the sidebar layer; the collapse happens below
    reuseSidebarEntry = true;
  }
  activeId = id;
  localStorage.setItem("anvil.active", id);
  restoreDraft(id); // bring in the incoming session's own draft (usually blank)
  setSessionHash(id, push && !reuseSidebarEntry); // reflect in the URL (history entry unless restoring via Back/Forward)
  stickToBottom = true; // a freshly opened session starts pinned to the latest
  clearConversation();
  const cached = localStorage.getItem(`anvil.convo.${id}`);
  if (cached) {
    conversation.innerHTML = cached; // instant, replaced by the snapshot below
    scrollDown();
  } else {
    maybeShowSessionHero(); // fresh/empty session: show its title card now (no flash before the snapshot)
  }
  renderSessions();
  // Bring the freshly-selected row into view in the sidebar so starting a project
  // from Autopilot (or any cross-view jump) lands you on its row, not just its
  // conversation. `block: "nearest"` is a no-op when the row is already visible,
  // so manual clicks on on-screen rows don't scroll the list.
  const activeRow = document.querySelector<HTMLElement>("#sidebar li.session.active");
  activeRow?.scrollIntoView({ block: "nearest" });
  const s = sessions.get(id);
  setHeaderTitle(s);
  applyActiveTint();
  snapshotLoaded.delete(id);
  // Opening a session is acting on it — clear its push reminder on this device immediately (the
  // daemon also clears it everywhere when we attach below). (UI refinement §1)
  navigator.serviceWorker?.controller?.postMessage({ type: "close-notifications", sessionId: id });
  ensureOwningServer(id); // wake/adopt the owning daemon so a member session's history actually loads
  sendTo(id, { type: "session.attach", sessionId: id }); // full snapshot (always show history)
  armAttachDiagnostic(id); // if no history arrives, replace the blank pane with a legible reason
  if (isNarrow() && !ui.sidebarCollapsed) {
    ui.sidebarCollapsed = true;
    applySidebar(); // on a phone, get out of the way once you've picked a session
  }
  // reset the side panel for the new session's worktree
  filesPath = "";
  readerPath = "";
  readerWatch = "";
  if (panelView) openPanel("files");
}

// ── Composer ───────────────────────────────────────────────────────────────────
const input = $<HTMLTextAreaElement>("#input");
// `dataUrl` is set only for images (the chip thumbnail); other files show an icon + name chip.
const pendingAttachments: { id: string; name: string; kind: "image" | "file"; dataUrl?: string }[] = [];
const attachRow = $("#attach-row");

// `/` autocomplete state — declared here (before the first `restoreDraft` runs) so the hoisted menu
// functions below have their backing element/state initialized. Logic lives further down.
const slashMenu = document.createElement("div");
slashMenu.id = "slash-menu";
slashMenu.hidden = true;
$("#input-box").appendChild(slashMenu);
let slashItems: CommandInfo[] = [];
let slashIdx = 0;

// ── Per-session composer drafts ──────────────────────────────────────────────────
// Unsent text belongs to the session it was typed in, not the box. Switching sessions stashes the
// current draft under the outgoing session and restores the incoming one's (usually blank), so a
// half-written message for one session never bleeds into another. Persisted per session so a draft
// also survives a reload / app restart.
const draftKey = (id: string): string => `anvil.draft.${id}`;
function saveDraft(id: string | null, text: string): void {
  if (!id) return;
  try {
    if (text.trim()) localStorage.setItem(draftKey(id), text);
    else localStorage.removeItem(draftKey(id));
  } catch {
    /* quota */
  }
}
function loadDraft(id: string | null): string {
  if (!id) return "";
  try {
    return localStorage.getItem(draftKey(id)) ?? "";
  } catch {
    return "";
  }
}
// ── Sent-prompt history (ArrowUp / ArrowDown recall in a blank composer) ──────────
// Keep the last few sent prompts per session so ArrowUp cycles back through them (ArrowDown
// forward) — handy after stopping a run to re-edit and resend. Persisted like drafts so it
// survives a reload. Newest first; capped so the list can't grow unbounded.
const HISTORY_LIMIT = 10;
const historyKey = (id: string): string => `anvil.history.${id}`;
function loadHistory(id: string | null): string[] {
  if (!id) return [];
  try {
    const arr: unknown = JSON.parse(localStorage.getItem(historyKey(id)) ?? "[]");
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function pushHistory(id: string | null, text: string): void {
  if (!id || !text.trim()) return;
  // Drop any prior identical entry so repeats don't stack up, then prepend as newest.
  const hist = [text, ...loadHistory(id).filter((t) => t !== text)].slice(0, HISTORY_LIMIT);
  try {
    localStorage.setItem(historyKey(id), JSON.stringify(hist));
  } catch {
    /* quota */
  }
}
// Cursor into the recall list: -1 means "composing fresh text, not navigating history".
// `historyStash` holds that fresh text so ArrowUp-then-back-down-past-newest restores it.
let historyIdx = -1;
let historyStash = "";

/** Put `id`'s saved draft into the composer (or clear it), and resize/enable Send to match. */
function restoreDraft(id: string | null): void {
  input.value = loadDraft(id);
  historyIdx = -1; // a fresh composer context — start recall from the top again
  closeSlashMenu(); // don't carry one session's open `/` menu into another
  autoGrow();
  updateSendState();
}
restoreDraft(activeId); // on load, bring back the active session's own unsent draft (if any)

// Uploads are async (read file → POST → push to pendingAttachments). If the user sends text
// before an upload lands, the attachment id wouldn't be in pendingAttachments yet and the
// file would be silently dropped. Track in-flight uploads so send() can wait for them.
let uploadsInFlight = 0;
const uploadWaiters: Array<() => void> = [];
function uploadsSettled(): Promise<void> {
  return uploadsInFlight === 0 ? Promise.resolve() : new Promise((resolve) => uploadWaiters.push(resolve));
}

$<HTMLFormElement>("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  void sendComposer();
});
async function sendComposer(): Promise<void> {
  // Never send ahead of a file that's still uploading — wait for it to land first.
  if (uploadsInFlight > 0) {
    toast("Finishing upload…");
    await uploadsSettled();
  }
  const text = input.value;
  if (!activeId || (!text.trim() && pendingAttachments.length === 0)) return;
  const s = sessions.get(activeId);
  if (serverOf(activeId)?.sock.isOpen() && !s?.pending) {
    sendTo(activeId, { type: "prompt.send", sessionId: activeId, text, attachmentIds: pendingAttachments.map((a) => a.id) });
  } else {
    // offline, or a session that itself hasn't been created yet → queue + show optimistically
    if (pendingAttachments.length) toast("Attachments need a connection — sent text only");
    enqueue({ cid: newCid(), cmd: { type: "prompt.send", sessionId: activeId, text } });
    appendOptimisticUser(text);
  }
  saveDraft(activeId, ""); // the draft was just sent — drop the stored copy
  pushHistory(activeId, text); // remember it for ArrowUp/ArrowDown recall
  historyIdx = -1; // back to composing fresh text
  input.value = "";
  pendingAttachments.length = 0;
  renderAttachRow();
  autoGrow();
  updateSendState();
}
/** Drop `text` into the composer as a recalled history entry, caret at the end. */
function applyRecall(text: string): void {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  autoGrow();
  updateSendState();
}
input.addEventListener("keydown", (e) => {
  // While the `/` menu is open it owns the navigation keys — intercept before send/history below.
  if (slashOpen()) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSlash(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSlash(-1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      acceptSlash(slashIdx);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSlashMenu();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $<HTMLFormElement>("#composer").requestSubmit();
    return;
  }
  // ArrowUp/ArrowDown cycle through recently sent prompts so one can be re-edited and resent.
  // We only start recall from a blank box, so it never steals cursor navigation from a draft;
  // once navigating, the arrows keep stepping through history until you edit or reach the bottom.
  if (e.key === "ArrowUp" && (historyIdx >= 0 || !input.value)) {
    const hist = loadHistory(activeId);
    if (!hist.length) return;
    if (historyIdx < 0) historyStash = input.value; // stash the fresh (blank) text to return to
    if (historyIdx >= hist.length - 1) return; // already at the oldest — nothing older to show
    e.preventDefault();
    historyIdx += 1;
    applyRecall(hist[historyIdx]!);
    return;
  }
  if (e.key === "ArrowDown" && historyIdx >= 0) {
    const hist = loadHistory(activeId);
    e.preventDefault();
    historyIdx -= 1;
    applyRecall(historyIdx < 0 ? historyStash : (hist[historyIdx] ?? ""));
    return;
  }
});
input.addEventListener("input", () => {
  historyIdx = -1; // a manual edit leaves history navigation — next ArrowUp starts fresh
  autoGrow();
  updateSendState();
  updateSlashMenu();
});
// Close the menu when focus leaves the box (deferred so a row's mousedown still lands first).
input.addEventListener("blur", () => setTimeout(closeSlashMenu, 100));
function autoGrow(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}
function updateSendState(): void {
  $<HTMLButtonElement>("#send").disabled = !input.value.trim() && pendingAttachments.length === 0;
}

// ── `/` slash-command autocomplete ────────────────────────────────────────────────
// Typing "/" at the very start of the composer pops a menu of the active session's skills/commands
// (built-in + the user's & project's `.claude/skills`, reported by the daemon on `session.commands`).
// Picking one drops the invocable "/name " into the box; sending it triggers the skill. The menu only
// arms while the text is a single "/token" (no space yet) — once you type an argument it gets out of
// the way, and Enter/Arrows fall back to their normal send/history behaviour.
// (The menu element + `slashItems`/`slashIdx` state are declared up in the composer setup so the
// first `restoreDraft` at load already has them ready.)
const slashOpen = (): boolean => !slashMenu.hidden;

/** The commands published for the active session, or [] before its first turn. */
function activeCommands(): CommandInfo[] {
  return (activeId && sessions.get(activeId)?.commands) || [];
}

/** The "/token" the user is typing, or null when the menu shouldn't be armed (no leading "/", or a
 *  space has been typed so we're now into arguments). */
function slashToken(): string | null {
  const v = input.value;
  if (!v.startsWith("/")) return null;
  const rest = v.slice(1);
  return /\s/.test(rest) ? null : rest;
}

function closeSlashMenu(): void {
  slashMenu.hidden = true;
  slashMenu.replaceChildren();
}

/** Recompute the menu from the current composer text (called on every input). */
function updateSlashMenu(): void {
  const token = slashToken();
  if (token === null) {
    closeSlashMenu();
    return;
  }
  const q = token.toLowerCase();
  const all = activeCommands();
  // Prefix matches first (what you'd expect while typing), then any substring hit.
  slashItems = [
    ...all.filter((c) => c.name.toLowerCase().startsWith(q)),
    ...all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)),
  ].slice(0, 50);
  if (!slashItems.length) {
    closeSlashMenu();
    return;
  }
  slashIdx = Math.min(slashIdx, slashItems.length - 1);
  renderSlashMenu();
}

function renderSlashMenu(): void {
  slashMenu.replaceChildren();
  slashItems.forEach((c, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "slash-item" + (i === slashIdx ? " sel" : "");
    row.innerHTML =
      `<span class="slash-name">/${esc(c.name)}</span>` +
      (c.source !== "builtin" ? `<span class="slash-src">${esc(c.source)}</span>` : "") +
      (c.description ? `<span class="slash-desc">${esc(c.description)}</span>` : "");
    // mousedown (not click) so the textarea never loses focus / selection before we act.
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptSlash(i);
    });
    slashMenu.appendChild(row);
  });
  slashMenu.hidden = false;
  slashMenu.querySelector(".slash-item.sel")?.scrollIntoView({ block: "nearest" });
}

function moveSlash(delta: number): void {
  slashIdx = (slashIdx + delta + slashItems.length) % slashItems.length;
  renderSlashMenu();
}

/** Insert the chosen command as "/name " and close the menu. */
function acceptSlash(i: number): void {
  const c = slashItems[i];
  if (!c) return;
  input.value = `/${c.name} `;
  closeSlashMenu();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  saveDraft(activeId, input.value);
  autoGrow();
  updateSendState();
}

// attach button → file picker
const fileInput = $<HTMLInputElement>("#file-input");
$("#btn-attach").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  attachFiles(Array.from(fileInput.files ?? []));
  fileInput.value = "";
});

/** Upload every selected file (images, PDFs, code, logs, …); the daemon decides how to feed each
 *  to the model. We don't gate on MIME type here — Android's picker frequently hands back an empty
 *  `File.type` even for images, which is exactly what used to silently drop attachments. */
function attachFiles(files: File[]): void {
  for (const f of files) void uploadAttachment(f);
}

function renderAttachRow(): void {
  attachRow.innerHTML = "";
  pendingAttachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = a.kind === "image" ? "attach-chip" : "attach-chip file";
    const inner =
      a.kind === "image" && a.dataUrl
        ? `<img src="${a.dataUrl}" alt="${esc(a.name)}" />`
        : `<span class="msym">description</span><span class="att-name" title="${esc(a.name)}">${esc(a.name)}</span>`;
    chip.innerHTML = `${inner}<button type="button" class="rm" title="Remove">×</button>`;
    chip.querySelector(".rm")!.addEventListener("click", () => {
      pendingAttachments.splice(i, 1);
      renderAttachRow();
    });
    attachRow.appendChild(chip);
  });
  updateSendState();
}
async function uploadAttachment(file: File): Promise<void> {
  if (!activeId) {
    toast("Open a session first");
    return;
  }
  uploadsInFlight++;
  updateSendState();
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const base64 = dataUrl.split(",")[1] ?? "";
    const res = await serverFetch(activeServer().url, `/api/sessions/${activeId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // mediaType may be empty (Android picker) — the daemon infers it from the filename.
      body: JSON.stringify({ name: file.name || "attachment", mediaType: file.type || "", dataBase64: base64 }),
    });
    if (!res.ok) {
      toast("Upload failed");
      return;
    }
    const { attachment } = (await res.json()) as { attachment: AttachmentRef };
    pendingAttachments.push({
      id: attachment.id,
      name: attachment.name,
      kind: attachment.kind,
      dataUrl: attachment.kind === "image" ? dataUrl : undefined,
    });
    renderAttachRow();
  } catch {
    toast("Upload failed");
  } finally {
    uploadsInFlight--;
    if (uploadsInFlight === 0) for (const resolve of uploadWaiters.splice(0)) resolve();
    updateSendState();
  }
}
input.addEventListener("paste", (e) => {
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    // Only file items (a pasted image or file) — `kind === "string"` is the normal text paste.
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) {
        e.preventDefault();
        void uploadAttachment(f);
      }
    }
  }
});
const composerEl = $("#composer");
composerEl.addEventListener("dragover", (e) => e.preventDefault());
composerEl.addEventListener("drop", (e) => {
  e.preventDefault();
  attachFiles(Array.from((e as DragEvent).dataTransfer?.files ?? []));
});

// ── Select-to-quote (highlight any message text → quote into the composer) ─────────
const quoteBtn = document.createElement("button");
quoteBtn.id = "quote-btn";
quoteBtn.textContent = "❝ Quote";
quoteBtn.style.display = "none";
document.body.appendChild(quoteBtn);
function selectionEl(): Element | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) return null;
  const node = sel.anchorNode;
  const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
  return el?.closest("#conversation, #panel-content") ?? null;
}
document.addEventListener("selectionchange", () => {
  const el = selectionEl();
  if (!el) {
    quoteBtn.style.display = "none";
    return;
  }
  const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
  quoteBtn.style.display = "block";
  quoteBtn.style.top = `${window.scrollY + rect.top - 36}px`;
  quoteBtn.style.left = `${window.scrollX + rect.left}px`;
});
quoteBtn.addEventListener("mousedown", (e) => {
  e.preventDefault(); // keep the selection alive through the click
  const el = selectionEl();
  const text = window.getSelection()?.toString().trim() ?? "";
  if (!el || !text) return;
  const fromReader = el.closest("#panel-content") && readerPath;
  const prefix = fromReader ? `> from \`${readerPath}\`:\n` : "";
  const quoted = prefix + text.split("\n").map((l) => `> ${l}`).join("\n");
  input.value = input.value ? `${quoted}\n\n${input.value}` : `${quoted}\n\n`;
  input.focus();
  quoteBtn.style.display = "none";
  window.getSelection()?.removeAllRanges();
});

// ── Strip select-to-cite anchors from copied markdown ──────────────────────────────
// Every rendered block carries a `data-line="start,end"` attribute — the select-to-cite hook,
// read from the *live* DOM by the native clients. It must never ride along on the clipboard:
// the browser's text/html flavor otherwise leaks a stray id on each block/line into paste
// targets. When a copy originates in a markdown surface, rewrite the clipboard from a cleaned
// clone (plain text is already anchor-free; we set it too so both flavors stay in sync).
document.addEventListener("copy", (e) => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !selectionEl()) return;
  const cd = (e as ClipboardEvent).clipboardData;
  if (!cd) return;
  const wrap = document.createElement("div");
  wrap.appendChild(sel.getRangeAt(0).cloneContents());
  wrap.querySelectorAll("[data-line]").forEach((n) => n.removeAttribute("data-line"));
  cd.setData("text/plain", sel.toString());
  cd.setData("text/html", wrap.innerHTML);
  e.preventDefault();
});

// ── Side panel: files + reader (terminal lands next) ──────────────────────────────
const panel = $("#side-panel");
const panelContent = $("#panel-content");
// `panelView` is declared in the early-init cluster up top — clearReferences() reads it at load.
let filesPath = "";
let readerPath = "";
let readerWatch = "";
let xterm: XTerm | null = null;
let fit: FitAddon | null = null;
let termObs: ResizeObserver | null = null;

function setPanelTabs(): void {
  document.querySelectorAll<HTMLElement>(".ptab").forEach((t) => t.classList.toggle("active", t.dataset.view === panelView));
  $("#btn-files").classList.toggle("active", panelView === "files" || panelView === "reader");
  $("#btn-git").classList.toggle("active", panelView === "git");
  $("#btn-terminal").classList.toggle("active", panelView === "terminal");
  $("#btn-links").classList.toggle("active", panelView === "links");
  // On phone the Files/Links buttons collapse into ⋮ More — light it up when either owns the panel.
  $("#btn-more").classList.toggle("active", panelView === "files" || panelView === "reader" || panelView === "links");
}
function openPanel(view: "files" | "reader" | "git" | "terminal" | "links"): void {
  if (!activeId) {
    toast("Open a session first");
    return;
  }
  if (view !== "terminal") disposeTerminal();
  panelView = view;
  panel.classList.add("open");
  openOverlay("panel", closePanelDom); // Back closes the panel (no-op if it's already a layer)
  setPanelTabs();
  if (view === "files") requestFiles(filesPath);
  else if (view === "reader" && !readerPath) requestFiles(filesPath);
  else if (view === "git") renderGit();
  else if (view === "terminal") mountTerminal();
  else if (view === "links") renderLinks();
}
/** Tear down the panel (DOM/state only). Reached via Back (popstate) or closePanel(). */
function closePanelDom(): void {
  if (readerWatch && activeId) sendTo(activeId, { type: "fs.unwatch", sessionId: activeId, path: readerWatch });
  readerWatch = "";
  disposeTerminal();
  panelView = null;
  panel.classList.remove("open");
  setPanelTabs();
}
const closePanel = (): void => dismissOverlay("panel"); // programmatic close → unwind the back-stack
function mountTerminal(): void {
  disposeTerminal();
  panelContent.innerHTML = '<div id="term-host" style="height:100%;width:100%"></div>';
  const dark = currentTheme() === "dark";
  xterm = new XTerm({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: dark ? { background: "#1a1b1e", foreground: "#e6e7e9" } : { background: "#ffffff", foreground: "#1c2024" },
  });
  fit = new FitAddon();
  xterm.loadAddon(fit);
  xterm.open($("#term-host"));
  fit.fit();
  xterm.onData((d) => {
    if (activeId) sendTo(activeId, { type: "terminal.input", sessionId: activeId, data: strToB64(d) });
  });
  if (activeId) sendTo(activeId, { type: "terminal.open", sessionId: activeId, cols: xterm.cols, rows: xterm.rows });
  termObs = new ResizeObserver(() => {
    if (fit && xterm && activeId) {
      fit.fit();
      sendTo(activeId, { type: "terminal.resize", sessionId: activeId, cols: xterm.cols, rows: xterm.rows });
    }
  });
  termObs.observe(panelContent);
}
function disposeTerminal(): void {
  termObs?.disconnect();
  termObs = null;
  xterm?.dispose();
  xterm = null;
  fit = null;
}
function requestFiles(path: string): void {
  if (!activeId) return;
  filesPath = path;
  sendTo(activeId, { type: "fs.list", sessionId: activeId, path });
}
function renderFiles(entries: DirEntry[]): void {
  panelView = "files";
  setPanelTabs();
  const wrap = document.createElement("div");
  wrap.className = "file-browser";
  const ul = document.createElement("ul");
  ul.className = "file-list";
  if (filesPath) {
    const up = document.createElement("li");
    up.className = "dir";
    up.innerHTML = `<span class="fb-name">📁 ..</span>`;
    up.onclick = () => requestFiles(filesPath.split("/").slice(0, -1).join("/"));
    ul.appendChild(up);
  }
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = e.isDir ? "dir" : "";
    const detail = [e.size !== undefined ? humanSize(e.size) : "", e.mtime !== undefined ? relTime(e.mtime) : ""].filter(Boolean).join(" · ");
    li.innerHTML =
      `<span class="fb-name">${e.isDir ? "📁" : "📄"} ${esc(e.name)}</span>` +
      `<span class="fb-detail">${esc(detail)}</span>` +
      (e.isDir ? "" : `<button type="button" class="fb-dl" title="Download">${icon("download")}</button>`);
    li.onclick = () => (e.isDir ? requestFiles(e.path) : openFile(e.path));
    const dl = li.querySelector<HTMLButtonElement>(".fb-dl");
    if (dl)
      dl.onclick = (ev) => {
        ev.stopPropagation(); // don't also open the file in the reader
        downloadFile(e.path, e.name);
      };
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  const hint = document.createElement("p");
  hint.className = "fb-drop-hint muted small";
  hint.textContent = "Drop files here to upload";
  wrap.appendChild(hint);
  wireBrowserDrop(wrap);
  panelContent.innerHTML = "";
  panelContent.appendChild(wrap);
}
/** Stream a worktree file to the client via the daemon's download endpoint (Content-Disposition
 *  forces a save-as). Routed to the active session's server so it works across a federated fleet. */
function downloadFile(path: string, name: string): void {
  if (!activeId) return;
  const url = serverApiUrl(activeServer().url, `/api/sessions/${activeId}/files?path=${encodeURIComponent(path)}&download=1`);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
/** Drag-and-drop upload into the currently-browsed worktree directory (`filesPath`). Uploads the
 *  raw bytes via PUT; the daemon refuses to overwrite an existing name (409 → "already exists"). */
function wireBrowserDrop(wrap: HTMLElement): void {
  wrap.addEventListener("dragover", (e) => {
    e.preventDefault();
    wrap.classList.add("drag-over");
  });
  wrap.addEventListener("dragleave", (e) => {
    if (e.target === wrap) wrap.classList.remove("drag-over");
  });
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    wrap.classList.remove("drag-over");
    void uploadToBrowser(Array.from((e as DragEvent).dataTransfer?.files ?? []), filesPath);
  });
}
async function uploadToBrowser(files: File[], dir: string): Promise<void> {
  if (!activeId || files.length === 0) return;
  let ok = 0;
  for (const file of files) {
    const rel = (dir ? `${dir}/` : "") + file.name;
    try {
      const res = await serverFetch(activeServer().url, `/api/sessions/${activeId}/files?path=${encodeURIComponent(rel)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: await file.arrayBuffer(),
      });
      if (res.status === 409) {
        toast(`"${file.name}" already exists — rename it or remove the old one first`);
        continue;
      }
      if (!res.ok) {
        toast(`Upload of "${file.name}" failed`);
        continue;
      }
      ok++;
    } catch {
      toast(`Upload of "${file.name}" failed`);
    }
  }
  if (ok > 0) {
    toast(ok === 1 ? "Uploaded 1 file" : `Uploaded ${ok} files`);
    if (panelView === "files" && filesPath === dir) requestFiles(dir); // refresh to show the new files
  }
}
function openFile(path: string): void {
  if (!activeId) return;
  disposeTerminal();
  panel.classList.add("open"); // a file link may open the reader while the panel is closed
  openOverlay("panel", closePanelDom); // Back closes it (no-op if the panel is already a layer)
  readerPath = path;
  panelView = "reader";
  setPanelTabs();
  if (readerWatch && readerWatch !== path) sendTo(activeId, { type: "fs.unwatch", sessionId: activeId, path: readerWatch });
  sendTo(activeId, { type: "fs.read", sessionId: activeId, path });
  sendTo(activeId, { type: "fs.watch", sessionId: activeId, path });
  readerWatch = path;
  panelContent.innerHTML = `<p class="muted small">Loading ${esc(path)}…</p>`;
}
function renderReader(content: FileContent): void {
  if (content.path !== readerPath) return;
  panelView = "reader";
  setPanelTabs();
  // A picker has nothing to pop out yet. Otherwise: on the Android shell (no real second window)
  // the button opens an in-app full-screen overlay; on Mac/web it pops out a standalone window.
  const popoutBtn = content.choices
    ? ""
    : isAndroidApp
      ? `<button type="button" id="reader-popout" class="reader-act" title="Full screen">${icon("fullscreen")}</button>`
      : `<button type="button" id="reader-popout" class="reader-act" title="Open in its own window">${icon("open_in_new")}</button>`;
  const head =
    `<div class="reader-head"><b>${esc(content.path)}</b>` +
    `<span class="reader-head-actions">${popoutBtn}` +
    `<a href="#" id="reader-back">← files</a></span></div>`;
  if (content.choices) {
    // A prose-named file (e.g. "design.md") matched several paths — let the user pick which to open.
    const items = content.choices
      .map((p) => `<li><a href="#" class="file-link reader-choice" data-path="${esc(p)}">${esc(p)}</a></li>`)
      .join("");
    panelContent.innerHTML = head + `<div class="reader-choices"><p class="muted small">${esc(content.path)} matches several files — pick one:</p><ul>${items}</ul></div>`;
    for (const a of panelContent.querySelectorAll<HTMLElement>(".reader-choice")) {
      a.onclick = (e) => {
        e.preventDefault();
        const p = a.dataset.path;
        if (p) openFile(p);
      };
    }
  } else if (content.markdown) {
    panelContent.innerHTML = head + `<div class="md reader-md">${content.markdown.html}</div>`;
    void runMermaid(panelContent.querySelector(".reader-md") as HTMLElement);
  } else if (content.text !== undefined) {
    panelContent.innerHTML = head + `<pre class="reader-text">${esc(content.text)}</pre>` + (content.truncated ? '<p class="muted small">(truncated)</p>' : "");
  } else if (content.binaryUrl) {
    const burl = serverApiUrl(activeServer().url, content.binaryUrl); // daemon-relative → absolute, routed to the session's server
    panelContent.innerHTML =
      head + (content.mime.startsWith("image/") ? `<img src="${burl}" style="max-width:100%" />` : `<a href="${burl}" target="_blank" rel="noopener noreferrer">Open ${esc(content.path)}</a>`);
  }
  const back = document.getElementById("reader-back");
  if (back) back.onclick = (e) => { e.preventDefault(); openPanel("files"); };
  const popout = document.getElementById("reader-popout");
  if (popout) popout.onclick = () => (isAndroidApp ? openFullScreenReader(content.path) : popOutReader(content.path));
}
/** Open the currently-rendered reader content in a standalone window (Mac + Web). Reuses the page's
 *  stylesheets + theme and the already-rendered DOM (Mermaid/KaTeX/code highlighting intact), minus
 *  the in-app chrome, so the file reads as its own clean document you can park beside the chat. */
function popOutReader(path: string): void {
  const clone = panelContent.cloneNode(true) as HTMLElement;
  clone.querySelector(".reader-head")?.remove(); // in-app header + back link don't belong in the window
  clone.querySelectorAll(".copy-btn").forEach((b) => b.remove()); // their click handlers don't survive the copy
  const styles = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    .map((l) => `<link rel="stylesheet" href="${esc(l.href)}" />`)
    .join("");
  const theme = document.documentElement.dataset.theme ?? "light";
  const title = path.split("/").pop() || path;
  // NB: no "noopener" here — with it, window.open() returns null (the opener link is severed), so we
  // could never write into the window and were left with a blank about:blank pop-up. We need the
  // handle to document.write our own content; it's same-origin self-authored markup, so this is safe.
  const win = window.open("", "_blank", "width=860,height=920");
  if (!win) {
    toast("Allow pop-ups to open the reader in its own window");
    return;
  }
  win.document.write(
    `<!doctype html><html lang="en" data-theme="${esc(theme)}"><head><meta charset="utf-8" />` +
      `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
      `<title>${esc(title)}</title>${styles}` +
      // The shared app stylesheets pin html/body to height:100%;overflow:hidden so the in-app
      // shell never scrolls — but in this standalone window that traps the content and kills the
      // scrollbar. Reset both back to a normal, scrollable document.
      `<style>html,body{margin:0;height:auto;overflow:auto;background:var(--bg);color:var(--text)}` +
      `.popout-wrap{max-width:880px;margin:0 auto;padding:28px clamp(16px,4vw,40px)}` +
      `.popout-head{font:600 12px/1.4 ui-monospace,Menlo,monospace;color:var(--muted);margin-bottom:16px;word-break:break-all}</style>` +
      `</head><body><div class="popout-wrap"><div class="popout-head">${esc(path)}</div>${clone.innerHTML}</div></body></html>`,
  );
  win.document.close();
}
/** Android in-app full-screen reader. The WebView shell can't make a real second window, so instead of
 *  popOutReader's standalone window we overlay the whole document with a clean, full-bleed, scrollable
 *  copy of the already-rendered file (Mermaid/KaTeX/highlighting intact), minus the in-app chrome. It's
 *  a back-stack layer, so the device Back button and the on-screen ✕ both close it. */
function openFullScreenReader(path: string): void {
  const clone = panelContent.cloneNode(true) as HTMLElement;
  clone.querySelector(".reader-head")?.remove(); // the panel's header + back link don't belong full-screen
  clone.querySelectorAll(".copy-btn").forEach((b) => b.remove()); // their click handlers don't survive the clone
  document.getElementById("reader-fs")?.remove(); // never stack two
  const title = path.split("/").pop() || path;
  const fs = document.createElement("div");
  fs.className = "reader-fs";
  fs.id = "reader-fs";
  fs.innerHTML =
    `<div class="reader-fs-head"><span class="reader-fs-title" title="${esc(path)}">${esc(title)}</span>` +
    `<button type="button" class="reader-fs-close" aria-label="Close" title="Close">${icon("close")}</button></div>` +
    `<div class="reader-fs-body">${clone.innerHTML}</div>`;
  document.body.appendChild(fs);
  fs.querySelector(".reader-fs-close")?.addEventListener("click", () => dismissOverlay("reader"));
  openOverlay("reader", () => document.getElementById("reader-fs")?.remove());
}
// ── Git panel ──────────────────────────────────────────────────────────────────
function askClaude(instruction: string): void {
  if (!activeId) return;
  sendTo(activeId, { type: "prompt.send", sessionId: activeId, text: instruction });
  toast("Asked Claude →");
  closePanel(); // jump to the conversation to watch it work
}
type Stage = "commit" | "push" | "pr" | "merge";
// Each stage tells Claude to do EVERYTHING up to and including that stage.
const STAGE_PROMPT: Record<Stage, string> = {
  commit: "In this worktree, stage and commit all current changes with a clear, conventional commit message based on what changed. If there's nothing to commit, say so.",
  push: "In this worktree: commit all current changes with a clear conventional message (if any are uncommitted), then push the branch to its origin remote (set the upstream with -u if needed).",
  pr: "In this worktree, take the branch to an open PR: commit any uncommitted changes (good conventional message), push to origin, then create a GitHub pull request with the gh CLI (concise title + summary) if one doesn't already exist. Give me the PR URL.",
  merge: "In this worktree, take the branch all the way to merged: commit any uncommitted changes (good message), push to origin, create a GitHub PR with gh if none exists, then merge it with `gh pr merge --squash` (NOT `--delete-branch`). IMPORTANT: this is a git worktree and the repo's default branch is checked out by another worktree, so do NOT try to switch this worktree to the default branch and do NOT use `--delete-branch` — it switches the checkout before deleting the remote branch, fails on the occupied default, and aborts, leaving the worktree stranded and the remote branch undeleted. After the merge succeeds, delete the remote branch yourself with `git push origin --delete <branch>` (a plain push that never touches the checkout), and leave this worktree on its current branch — staying on the merged branch is expected and correct. Report each step and confirm when it's merged.",
};
const STAGE_META: { key: Stage; icon: string; label: string }[] = [
  { key: "commit", icon: "commit", label: "Commit" },
  { key: "push", icon: "cloud_upload", label: "Push" },
  { key: "pr", icon: "call_merge", label: "PR" },
  { key: "merge", icon: "merge", label: "Merge" },
];
/** Which stages still have work to do, given the current source-control state. */
function gitStageEnabled(g: GitStatus | undefined): Record<Stage, boolean> {
  const dirty = g?.dirtyFileCount ?? 0;
  const ahead = g?.ahead ?? 0;
  const pr = g?.prState;
  return {
    commit: dirty > 0, // something uncommitted
    push: dirty > 0 || ahead > 0, // something not on the remote
    pr: pr !== "open" && pr !== "merged", // no PR yet
    merge: pr !== "merged", // not already merged
  };
}
function applyGitButtons(): void {
  const en = gitStageEnabled(activeId ? sessions.get(activeId)?.git : undefined);
  for (const { key } of STAGE_META) {
    const btn = document.getElementById(`ga-${key}`) as HTMLButtonElement | null;
    if (btn) btn.disabled = !en[key];
  }
}
function requestGitStatus(): void {
  if (activeId) sendTo(activeId, { type: "git", sessionId: activeId, op: "status" });
}
function renderGit(): void {
  panelView = "git";
  setPanelTabs();
  const s = activeId ? sessions.get(activeId) : undefined;
  const wt = s?.worktree;
  const stageBtns = STAGE_META.map((m) => `<button type="button" id="ga-${m.key}">${icon(m.icon)} ${m.label}</button>`).join("");
  panelContent.innerHTML = `<div class="git-panel">
    <div class="git-status"><span id="git-status-text">${gitStatusLine(s)}</span>
      <button type="button" class="mini" id="git-refresh" title="Refresh">${icon("refresh")}</button>
      <button type="button" class="mini" id="git-view-diff" title="View diff">${icon("difference")}</button></div>
    <div class="small muted git-worktree">${wt ? `worktree at <code>${esc(s!.cwd)}</code><br/>off <code>${esc(wt.base)}</code>` : esc(s?.cwd ?? "")}</div>
    <hr />
    <div class="git-row git-stages">${stageBtns}</div>
    <hr />
    <div class="git-row">
      <button type="button" id="ga-reset" title="Un-stick: recover the worktree, clear a parked permission, reset to idle">${icon("restart_alt")} Reset</button>
      <button type="button" id="ga-cleanup">${icon("cleaning_services")} Cleanup</button>
      <button type="button" class="danger" id="ga-abandon">${icon("delete_forever")} Abandon</button>
    </div>
    <pre class="git-output" id="git-output"></pre>
  </div>`;

  $("#git-refresh").onclick = () => {
    setGitOutput("refreshing…");
    requestGitStatus();
  };
  $("#git-view-diff").onclick = () => {
    if (!activeId) return;
    setGitOutput("loading diff…");
    sendTo(activeId, { type: "git", sessionId: activeId, op: "diff" });
  };
  for (const m of STAGE_META) {
    const btn = document.getElementById(`ga-${m.key}`) as HTMLButtonElement | null;
    if (btn) btn.onclick = () => runStage(m.key, m.label);
  }
  $("#ga-reset").onclick = resetSession;
  $("#ga-cleanup").onclick = cleanupSession;
  $("#ga-abandon").onclick = abandonSession;
  applyGitButtons();
  requestGitStatus(); // sync status + PR state on open
}
/** Run all stages up to `key`: lock the buttons immediately, refresh when the turn ends. */
function runStage(key: Stage, label: string): void {
  if (!activeId) return;
  for (const m of STAGE_META) {
    const b = document.getElementById(`ga-${m.key}`) as HTMLButtonElement | null;
    if (b) b.disabled = true; // immediate response; re-evaluated on the next status
  }
  setGitOutput(`Working… asked Claude to ${label.toLowerCase()}.`);
  sendTo(activeId, { type: "prompt.send", sessionId: activeId, text: STAGE_PROMPT[key] });
  toast(`${label} →`);
  closePanel(); // get out of the way and jump to the conversation to watch it work
}
function gitStatusLine(s: Session | undefined): string {
  const g = s?.git;
  if (!g) return "(no git info)";
  const pr = g.prState ? ` · PR ${g.prState}` : "";
  return `${esc(g.branch)} · ${g.dirtyFileCount} changed · ${g.ahead}↑ ${g.behind}↓${pr}`;
}
function updateGitPanelMeta(): void {
  if (panelView !== "git") return;
  const s = activeId ? sessions.get(activeId) : undefined;
  const txt = document.getElementById("git-status-text");
  if (txt) txt.innerHTML = gitStatusLine(s);
  applyGitButtons();
}
/** Outstanding work that removing the session would lose. */
function outstandingWork(s: Session | undefined): string[] {
  const g = s?.git;
  const out: string[] = [];
  if (!g) return out;
  if (g.dirtyFileCount > 0) out.push(`${g.dirtyFileCount} uncommitted change${g.dirtyFileCount === 1 ? "" : "s"}`);
  if (g.ahead > 0) out.push(`${g.ahead} unpushed commit${g.ahead === 1 ? "" : "s"}`);
  if (g.prState === "open") out.push("an open PR (not merged)");
  return out;
}
/** Un-stick a session: recover a missing worktree, clear a parked permission, reset to idle. */
async function resetSession(): Promise<void> {
  if (!activeId) return;
  const id = activeId;
  const ok = await confirmDialog({
    icon: "restart_alt",
    title: "Reset this session?",
    body: "Recovers the worktree if it's missing, clears any pending permission, drops the current turn, and returns the session to idle. Your committed work is untouched.",
    confirmLabel: "Reset",
  });
  if (ok) {
    sendTo(id, { type: "session.reset", sessionId: id });
    setGitOutput("resetting…");
  }
}
async function cleanupSession(): Promise<void> {
  if (!activeId) return;
  const id = activeId;
  const outstanding = outstandingWork(sessions.get(id));
  if (outstanding.length === 0) {
    const ok = await confirmDialog({
      icon: "cleaning_services",
      title: "Clean up this session?",
      body: "Removes the local + remote branch and the worktree. The work is committed, pushed, and/or merged.",
      confirmLabel: "Clean up",
      danger: true,
    });
    if (ok) killSession(id);
    return;
  }
  showOutstandingDialog(outstanding);
}
async function abandonSession(): Promise<void> {
  if (!activeId) return;
  const id = activeId;
  const s = sessions.get(id);
  const ok = await confirmDialog({
    icon: "delete_forever",
    title: `Abandon “${s?.title ?? "this session"}”?`,
    body: "Force-deletes the local + remote branch and the worktree, discarding ALL uncommitted / unmerged work. This cannot be undone.",
    confirmLabel: "Abandon",
    danger: true,
  });
  if (ok) killSession(id);
}
/** Remove a session from the local view + caches — the client-side half of a deletion. Shared by the
 *  daemon's session.deleted broadcast and the kill path's "no such session" fallback, so a row the
 *  owning daemon has disowned (a stale-routed ghost) can always be evicted locally. */
function purgeSessionLocally(id: string): void {
  sessions.delete(id);
  sessionServer.delete(id);
  removingSessions.delete(id); // cleanup finished (or never existed) — the row goes for good now
  localStorage.removeItem(`anvil.convo.${id}`);
  localStorage.removeItem(`anvil.draft.${id}`); // its unsent draft has nowhere to go now
  persistSessions();
  persistRouting();
  if (activeId === id) deselectSession();
  else renderSessions();
}
/** Kill a session: disable it immediately and drop its conversation, while the daemon tears the
 *  worktree/branch down in the background. The row stays (greyed, "cleaning up…") until the
 *  daemon's session.deleted broadcast removes it for good — so cleanup never looks like it hung,
 *  and a failed/slow teardown can't leave a half-removed session behind. (UI refinement §8)
 *
 *  We watch the kill's reply on a cid: if the owning daemon — or the hub we fell back to when the
 *  routing was stale — answers "no such session", the row is a client-only ghost (its daemon
 *  disowned it while we were disconnected, or its server url drifted). Evict it locally so Abandon /
 *  Clean up always frees the row instead of leaving a zombie no daemon can delete for us. A plain
 *  offline/timeout is NOT treated as disowned — the server may just be unreachable, so the offline
 *  cache keeps the row. */
function killSession(id: string): void {
  removingSessions.add(id);
  const srv = serverOf(id) ?? hub();
  void sendAwait(srv, { type: "session.kill", sessionId: id, cid: newCid() })
    .then((res) => {
      if (res.type === "command.error" && /no such session/i.test(res.message)) purgeSessionLocally(id);
    })
    .catch(() => {
      /* offline / timeout — keep the row; a reachable daemon never confirmed it's gone */
    });
  localStorage.removeItem(`anvil.convo.${id}`);
  localStorage.removeItem(`anvil.draft.${id}`); // abandoning the session — its draft goes with it
  if (panelView) closePanel();
  if (activeId === id) {
    // Drop the conversation now, but keep the (disabled) sidebar entry until it's actually gone.
    activeId = null;
    localStorage.removeItem("anvil.active");
    setSessionHash(null, false);
    setHeaderTitle(undefined);
    renderEmptyState();
    restoreDraft(null); // clear the composer of the killed session's text
  }
  renderSessions();
}
/** Cleanup found outstanding work — offer to handle it first, or remove anyway. */
function showOutstandingDialog(outstanding: string[]): void {
  const s = activeId ? sessions.get(activeId) : undefined;
  const pr = s?.git?.prState;
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>${icon("warning")} Outstanding work</h3>
    <p class="small muted">This session still has work that cleanup would lose:</p>
    <ul>${outstanding.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
    <p class="small muted">Have Claude handle it first:</p>
    <div class="git-row">
      <button type="button" id="od-commit">${icon("commit")} Commit</button>
      <button type="button" id="od-push">${icon("cloud_upload")} Push</button>
      <button type="button" id="od-pr">${icon(pr === "open" ? "merge" : "rocket_launch")} ${pr === "open" ? "Merge PR" : "Create PR"}</button>
    </div>
    <div class="btns"><button type="button" class="danger" id="od-remove">${icon("delete_forever")} Remove anyway</button><span style="flex:1"></span><button type="button" id="od-cancel">Cancel</button></div>
  </div>`;
  showModal(m);
  const handle = (t: string) => {
    closeModal();
    askClaude(t);
  };
  $<HTMLButtonElement>("#od-commit").onclick = () => handle(STAGE_PROMPT.commit);
  $<HTMLButtonElement>("#od-push").onclick = () => handle(STAGE_PROMPT.push);
  $<HTMLButtonElement>("#od-pr").onclick = () => handle(pr === "open" ? STAGE_PROMPT.merge : STAGE_PROMPT.pr);
  $<HTMLButtonElement>("#od-cancel").onclick = () => closeModal();
  $<HTMLButtonElement>("#od-remove").onclick = () => {
    closeModal();
    if (activeId) killSession(activeId); // "Remove anyway" — the listed outstanding work IS the warning
  };
}
function setGitOutput(text: string): void {
  const el = document.getElementById("git-output");
  if (el) el.textContent = text;
}
function showGitResult(e: GitResultEvent): void {
  const el = document.getElementById("git-output");
  if (!el) return;
  const head = e.ok ? "" : "⚠ failed\n";
  el.innerHTML = linkifyUrls(head + e.output); // [SEC-L6] esc + safe new-tab links (rel=noopener)
}

$("#btn-new-topic").addEventListener("click", async () => {
  if (!activeId) return;
  const ok = await confirmDialog({
    icon: "restart_alt",
    title: "Start a new topic?",
    body: "Claude forgets the earlier context but the visible history stays.",
    confirmLabel: "Start new topic",
  });
  if (!ok) return;
  sendTo(activeId, { type: "session.new_topic", sessionId: activeId, cid: newCid() });
  toast("Started a new topic — fresh context.");
});
$("#btn-files").addEventListener("click", () => (panelView === "files" || panelView === "reader" ? closePanel() : openPanel("files")));
$("#btn-git").addEventListener("click", () => (panelView === "git" ? closePanel() : openPanel("git")));
$("#btn-terminal").addEventListener("click", () => (panelView === "terminal" ? closePanel() : openPanel("terminal")));
$("#btn-links").addEventListener("click", () => (panelView === "links" ? closePanel() : openPanel("links")));
$("#panel-close").addEventListener("click", closePanel);
document.querySelectorAll<HTMLElement>(".ptab").forEach((t) => t.addEventListener("click", () => openPanel(t.dataset.view as "files" | "reader" | "git" | "terminal" | "links")));

// ── Header dropdown menus ─────────────────────────────────────────────────────
// Anchored dropdowns for header actions: the Prompts list, and (on phone) the ⋮ "More" overflow
// holding the Files/Links actions that are inline text buttons on wider screens. Each registers as a
// "menu" overlay so Back/Escape dismiss it like every other soft layer; only one is open at a time.
interface HeaderMenuItem {
  icon?: string;
  label: string;
  title?: string;
  run: () => void;
}
let menuAnchor: HTMLElement | null = null;
/** Tear down the open menu (DOM only). Reached via Back (popstate), Escape, or closeHeaderMenu(). */
function closeHeaderMenuDom(): void {
  $("#menu-root").innerHTML = "";
  menuAnchor?.classList.remove("active");
  menuAnchor = null;
}
const closeHeaderMenu = (): void => dismissOverlay("menu"); // programmatic close → unwind the back-stack
/** Open a dropdown of `items` under `anchor`; a second click on the same button just closes it. */
function toggleHeaderMenu(anchor: HTMLElement, items: HeaderMenuItem[]): void {
  const wasThis = menuAnchor === anchor;
  if (overlayOpen("menu")) closeHeaderMenu(); // fold away any open menu first (also clears menuAnchor)
  if (wasThis || !items.length) return; // re-click closes; nothing to show → stay closed
  const menu = document.createElement("div");
  menu.className = "header-menu";
  for (const it of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "header-menu-item";
    if (it.title) row.title = it.title;
    row.innerHTML = `${icon(it.icon || "bookmark")}<span class="hm-lbl">${esc(it.label)}</span>`;
    row.addEventListener("click", () => {
      closeHeaderMenu();
      it.run();
    });
    menu.appendChild(row);
  }
  $("#menu-root").appendChild(menu);
  // Align right edges and clamp the offset into the viewport. Open downward from a header button,
  // but flip upward for a low anchor (e.g. the composer at the bottom) so the menu stays on-screen.
  const r = anchor.getBoundingClientRect();
  menu.style.right = `${Math.round(Math.max(8, window.innerWidth - r.right))}px`;
  const spaceBelow = window.innerHeight - r.bottom;
  if (spaceBelow < menu.offsetHeight + 12 && r.top > spaceBelow) {
    menu.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`; // open upward
  } else {
    menu.style.top = `${Math.round(r.bottom + 6)}px`; // open downward
  }
  anchor.classList.add("active");
  menuAnchor = anchor;
  openOverlay("menu", closeHeaderMenuDom); // Back/Escape close it
}
$("#btn-prompts").addEventListener("click", () =>
  toggleHeaderMenu(
    $("#btn-prompts"),
    sortedPrompts().map((p) => ({ icon: p.icon || "bookmark", label: p.shortTitle || p.title, title: p.title || p.shortTitle, run: () => insertPrompt(p.body) })),
  ),
);
// Phone-only ⋮ overflow: the Files/Links actions that render as inline text buttons on wider screens.
$("#btn-more").addEventListener("click", () =>
  toggleHeaderMenu($("#btn-more"), [
    { icon: "folder", label: "Files", run: () => openPanel("files") },
    { icon: "link", label: "Links", run: () => openPanel("links") },
  ]),
);
// Click outside an open menu closes it. The anchor buttons toggle themselves, so they're excluded.
document.addEventListener("pointerdown", (e) => {
  if (!overlayOpen("menu")) return;
  const t = e.target as HTMLElement;
  if (t.closest(".header-menu") || t.closest("#btn-prompts") || t.closest("#btn-more")) return;
  closeHeaderMenu();
});

// Click anywhere off the open side panel to dismiss it. The header toggles, in-conversation
// file links, and the floating quote button legitimately drive/feed the panel, so they're
// excluded (they manage their own open/close). Modals/dialogs and the settings view are layers
// ABOVE the panel — a pointerdown there must NOT close the panel, because closePanel()
// (dismissOverlay) unwinds every overlay above the panel too, which would tear down the open
// dialog mid-click and swallow its button press (this is what made Cleanup/Abandon/Reset, all of
// which confirm in a dialog over the git panel, silently do nothing). Pointerdown beats those
// handlers' click.
document.addEventListener("pointerdown", (e) => {
  if (!panelView) return; // panel already closed
  if (overlayOpen("modal") || overlayOpen("settings") || overlayOpen("autopilot") || overlayOpen("reader") || overlayOpen("menu")) return; // a dialog/settings/autopilot/reader/header-menu is on top — leave the panel be
  const t = e.target as HTMLElement;
  if (t.closest("#side-panel") || t.closest("#header") || t.closest(".file-link") || t.closest("#quote-btn") || t.closest("#modal-root") || t.closest("#menu-root") || t.closest("#settings-root") || t.closest("#autopilot-root") || t.closest(".resizer")) return;
  closePanel();
});

// ── Modals ─────────────────────────────────────────────────────────────────────
let onDirs: ((e: DirsListResultEvent) => void) | null = null;
// `serverUrl` is the daemon whose filesystem we're browsing (add-env / one-off pick a server).
const browse = { path: "", parent: undefined as string | undefined, serverUrl: HUB_URL };
const browseServer = (): Server => servers.get(browse.serverUrl) ?? hub();

initSortables(); // wire up drag-to-reorder on the (always-present) session + finished lists
$("#open-settings").addEventListener("click", openSettings);
$("#open-autopilot").addEventListener("click", openAutopilot);
$("#new-session-top").addEventListener("click", () => showNewSession());

/** Mount a modal (replaces any current one in #modal-root) and register it on the back-stack so
 *  Back/Cancel dismisses it. Swapping one modal's contents for another reuses the same layer. */
function showModal(el: HTMLElement): void {
  const root = $("#modal-root");
  root.innerHTML = "";
  root.appendChild(el);
  openOverlay("modal", closeModalDom); // no-op if a modal layer is already open (content swap)
}
/** Tear down the modal (DOM/state only). Reached via Back (popstate) or closeModal(). */
function closeModalDom(): void {
  onDirs = null;
  destroyModalSelects(); // drop Tom Select instances (and their document listeners) before the DOM goes
  $("#modal-root").innerHTML = "";
}
const closeModal = (): void => dismissOverlay("modal"); // programmatic close → unwind the back-stack
// New sessions start on Opus; the header model chip switches models mid-session (session.set_model).
// New sessions default to "bypass" (skip all permission prompts); the autonomy picker dials that back.
const DEFAULT_MODEL = "opus";
const DEFAULT_AUTONOMY: AutonomyPolicy = "bypass";
const AUTONOMY_PICKER = `<label>Autonomy<select id="ns-auto">
  <option value="bypass" data-icon="bolt" selected>Bypass — skip all permission prompts ⚠️</option>
  <option value="mostly-autonomous" data-icon="auto_mode">Mostly autonomous</option>
  <option value="allowlist" data-icon="playlist_add_check">Allowlist</option>
  <option value="prompt-all" data-icon="front_hand">Prompt all</option>
</select></label>`;
/** The chosen autonomy from the open dialog's picker, or the default if it isn't present. */
const selectedAutonomy = (): AutonomyPolicy =>
  ((document.getElementById("ns-auto") as HTMLSelectElement | null)?.value as AutonomyPolicy) || DEFAULT_AUTONOMY;

// Opt-in adversarial plan review: when the session plans, competing models critique the plan before
// it runs (the autopilot panel, in a session). Off by default; needs an OpenRouter key on the server.
const ADVERSARIAL_PICKER = `<label class="cd-option"><input type="checkbox" id="ns-adv" />
  <span>Adversarial plan review <span class="small muted">— competing models critique each plan (needs an OpenRouter key)</span></span></label>`;
/** Whether the open dialog's adversarial-review checkbox is ticked (false if it isn't present). */
const selectedAdversarial = (): boolean =>
  (document.getElementById("ns-adv") as HTMLInputElement | null)?.checked ?? false;

/** A server picker for the browse-based modals (add-env, one-off). Hidden when there's one server. */
function serverPickerMarkup(): string {
  const list = orderedServers();
  if (list.length <= 1) return "";
  const opts = list.map((s) => `<option value="${esc(s.url)}" data-icon="dns">${esc(s.name)}</option>`).join("");
  return `<label>Server<div class="env-row"><select id="ns-server">${opts}</select></div></label>`;
}
/** Initialise browse.serverUrl (→ hub) and, if the picker is shown, re-list on change. Call before wireBrowser(). */
function wireServerPicker(): void {
  browse.serverUrl = HUB_URL;
  const sel = document.getElementById("ns-server") as HTMLSelectElement | null;
  if (!sel) return;
  sel.value = HUB_URL;
  sel.addEventListener("change", () => {
    browse.serverUrl = sel.value;
    browse.path = "";
    browseServer().sock.send({ type: "dirs.list" }); // re-list from the newly-chosen server's root
  });
  enhanceSelect(sel);
}
/** A reusable directory browser (used by add-environment and one-off). */
function browserMarkup(): string {
  return `<div class="browser">
    <div class="browser-path"><button type="button" id="ns-up" title="Up">⬆</button><code id="ns-cur">…</code></div>
    <ul id="ns-dirs" class="browser-list"></ul>
  </div>`;
}
function wireBrowser(): void {
  onDirs = (e) => {
    browse.path = e.path;
    browse.parent = e.parent;
    $("#ns-cur").textContent = e.path;
    $<HTMLButtonElement>("#ns-up").disabled = !e.parent;
    const ul = $("#ns-dirs");
    ul.innerHTML = "";
    for (const d of e.entries) {
      const li = document.createElement("li");
      li.innerHTML = `<span>📁 ${esc(d.name)}</span>${d.isRepo ? '<span class="repo">git</span>' : ""}`;
      li.onclick = () => browseServer().sock.send({ type: "dirs.list", path: d.path });
      ul.appendChild(li);
    }
  };
  $<HTMLButtonElement>("#ns-up").onclick = () => {
    if (browse.parent) browseServer().sock.send({ type: "dirs.list", path: browse.parent });
  };
  browseServer().sock.send({ type: "dirs.list" });
}

/** Primary flow: pick an environment + name → fresh worktree. */
function showNewSession(): void {
  const envs = [...environments.values()];
  const m = document.createElement("div");
  m.className = "modal";
  if (envs.length === 0) {
    m.innerHTML = `<div class="modal-box" id="ns-modal"><h3>New session</h3>
      <p class="muted">No environments yet — add a project repo in Settings to get started.</p>
      <div class="btns"><button type="button" id="ns-cancel">Cancel</button><button type="button" id="ns-manage" class="primary">Settings &amp; servers</button></div>
      <p class="small muted"><a id="ns-oneoff" href="#">or work in a one-off folder…</a></p></div>`;
  } else {
    // Group the environments by the server they live on (the chosen env determines the server the
    // session is created on). With a single server, render a flat list — no optgroup noise.
    const multi = orderedServers().length > 1;
    const opt = (e: Environment): string =>
      `<option value="${esc(e.id)}" data-icon="${esc(envIcon(e))}" data-color="${esc(stripeColor(e, 0, currentTheme()))}">${esc(e.name)}</option>`;
    const opts = multi
      ? orderedServers()
          .map((srv) => {
            const group = envs.filter((e) => (envServer.get(e.id) ?? HUB_URL) === srv.url).sort(byEnvName);
            return group.length ? `<optgroup label="${esc(srv.name)}">${group.map(opt).join("")}</optgroup>` : "";
          })
          .join("")
      : [...envs].sort(byEnvName).map(opt).join("");
    m.innerHTML = `<div class="modal-box" id="ns-modal"><h3>New session</h3>
      <label>Environment<div class="env-row"><select id="ns-env">${opts}</select></div></label>
      <label>Session name<input id="ns-name" placeholder="e.g. fix-login-bug" /></label>
      <p class="small muted" id="ns-note"></p>
      <p class="small warn-text" id="ns-warn"></p>
      ${AUTONOMY_PICKER}
      ${ADVERSARIAL_PICKER}
      <label class="ns-lead-row" id="ns-lead-row"><input type="checkbox" id="ns-lead" /> <span>Team lead — fans the goal out to member sessions and integrates their branches</span></label>
      <div class="btns"><button type="button" id="ns-cancel">Cancel</button><button type="button" id="ns-create">Create</button></div>
      <p class="small muted"><a id="ns-manage" href="#">⚙ Manage environments…</a> · <a id="ns-oneoff" href="#">one-off folder…</a></p></div>`;
  }
  showModal(m);
  onDirs = null; // this modal has no browser

  document.getElementById("ns-cancel")?.addEventListener("click", closeModal);
  document.getElementById("ns-manage")?.addEventListener("click", (e) => {
    e.preventDefault();
    // Swap the modal for the Settings view in place, reusing this back-stack entry (so we don't
    // race an async history unwind against a fresh push).
    closeModalDom();
    if (overlays.length) overlays[overlays.length - 1] = { name: "settings", close: closeSettings };
    openSettings(); // builds the DOM; its openOverlay("settings") is now a no-op
  });
  document.getElementById("ns-oneoff")?.addEventListener("click", (e) => {
    e.preventDefault();
    showOneOff();
  });
  const envSel = document.getElementById("ns-env") as HTMLSelectElement | null;
  const nameInp = document.getElementById("ns-name") as HTMLInputElement | null;
  const createBtn = document.getElementById("ns-create") as HTMLButtonElement | null;
  const note = document.getElementById("ns-note");
  const warn = document.getElementById("ns-warn");

  const validate = (): void => {
    if (!envSel || !nameInp || !createBtn) return;
    const env = environments.get(envSel.value);
    const name = nameInp.value.trim();
    const slug = slugify(name);
    const dup = !!env && slug.length > 0 && [...sessions.values()].some((s) => s.environmentId === env.id && slugify(s.title) === slug);
    if (note) {
      const base = env?.defaultBase ?? "HEAD";
      note.textContent = !env
        ? ""
        : env.isRepo
          ? slug
            ? `→ fresh worktree on branch “${slug}” (off ${base})`
            : `Creates a fresh git worktree (off ${base}).`
          : `Works directly in ${env.repoRoot} (no worktree).`;
    }
    if (warn) warn.textContent = dup ? `A session named “${name}” already exists in this environment.` : "";
    const leadRow = document.getElementById("ns-lead-row");
    if (leadRow) leadRow.hidden = !env?.isRepo; // a lead needs a worktree; hide for existing-dir envs
    createBtn.disabled = !env || !name || dup;
  };
  envSel?.addEventListener("change", validate);
  nameInp?.addEventListener("input", validate);
  // Enter in the name field creates the session (unless the form's still invalid — e.g. blank/dup name).
  nameInp?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" && createBtn && !createBtn.disabled) {
      e.preventDefault();
      createBtn.click();
    }
  });
  enhanceSelect(envSel, true); // searchable — environment lists can grow long
  enhanceSelect(document.getElementById("ns-auto") as HTMLSelectElement | null);
  nameInp?.focus();
  validate();

  createBtn?.addEventListener("click", () => {
    if (!envSel || !nameInp) return;
    const env = environments.get(envSel.value);
    const name = nameInp.value.trim();
    if (!env || !name) return;
    const common = {
      title: name,
      environmentId: env.id,
      model: DEFAULT_MODEL,
      autonomy: selectedAutonomy(),
      adversarialReview: selectedAdversarial(),
    };
    const cid = newCid();
    // Teams: a lead needs its own worktree/branch to merge members into, so it's a fresh-worktree option.
    const asLead = env.isRepo && !!(document.getElementById("ns-lead") as HTMLInputElement | null)?.checked;
    const cmd = env.isRepo
      ? { type: "session.create" as const, source: "fresh-worktree", repoRoot: env.repoRoot, base: env.defaultBase ?? "HEAD", cid, ...(asLead ? { teamRole: "lead" as const } : {}), ...common }
      : { type: "session.create" as const, source: "existing-dir", cwd: env.repoRoot, cid, ...common };
    const srv = serverOfEnv(env.id); // the session is created on the env's server
    if (srv.sock.isOpen()) {
      pendingCreateCid = cid; // jump into this session when its session.created lands (see onEvent)
      srv.sock.send(cmd);
    } else {
      createOfflineSession(cmd, env, name, srv.url); // offline path selects the optimistic session itself
    }
    closeModal();
  });
}

/** Create a session while offline: show an optimistic "pending" session now, realize it on reconnect. */
function createOfflineSession(cmd: Record<string, unknown> & { type: string }, env: Environment, name: string, serverUrl: string): void {
  const tempId = `pending_${newCid()}`;
  const now = new Date().toISOString();
  const pending: Session = {
    id: tempId,
    title: name,
    pending: true,
    environmentId: env.id,
    cwd: env.repoRoot,
    source: env.isRepo ? "fresh-worktree" : "existing-dir",
    model: cmd.model as Session["model"],
    autonomy: cmd.autonomy as Session["autonomy"],
    status: "idle",
    createdAt: now,
    lastActivityAt: now,
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  };
  sessions.set(tempId, pending);
  sessionServer.set(tempId, serverUrl); // route the queued create + its prompts to this server
  persistSessions();
  persistRouting();
  enqueue({ cid: newCid(), cmd, tempId, serverUrl });
  selectSession(tempId);
  toast("Session queued — will be created when you're back online");
}

// ── Color swatch picker (environment color) ──────────────────────────────────
/** A row of the 16 palette swatches plus an "auto" (hashed) option; `selected` pre-selects one. */
function swatchPickerMarkup(selected?: string): string {
  const norm = (selected ?? "").toLowerCase();
  const auto = `<button type="button" class="swatch swatch-auto${norm ? "" : " selected"}" data-hex="" title="Auto — hue from the name">${icon("hide_source")}</button>`;
  const dots = PALETTE.map(
    (p) =>
      `<button type="button" class="swatch${p.hex.toLowerCase() === norm ? " selected" : ""}" data-hex="${p.hex}" title="${p.name}" style="background:${p.hex}"></button>`,
  ).join("");
  return `<label>Color<div class="swatch-row" id="swatch-row">${auto}${dots}</div></label>`;
}
function wireSwatchPicker(): void {
  const row = document.getElementById("swatch-row");
  if (!row) return;
  row.querySelectorAll<HTMLElement>(".swatch").forEach((b) =>
    b.addEventListener("click", () => {
      row.querySelectorAll(".swatch").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
    }),
  );
}
/** The picked hex, or "" for auto. */
function selectedSwatch(): string {
  const sel = document.querySelector<HTMLElement>("#swatch-row .swatch.selected");
  return sel?.dataset.hex ?? "";
}

// ── Icon picker (environment icon) ───────────────────────────────────────────
// A curated grid of Material Symbols so an environment can carry a glyph (shown in the env selector
// and cards). "Auto" falls back to folder/account_tree by repo kind. Mirrors the swatch picker.
const ENV_ICONS = [
  "account_tree", "folder", "rocket_launch", "code", "terminal", "bug_report", "science", "smartphone",
  "web", "dns", "cloud", "database", "api", "bolt", "build", "extension", "hub", "layers", "palette",
  "dashboard", "robot_2", "smart_toy", "widgets", "memory", "lightbulb", "favorite", "star", "flag",
  "bookmark", "work", "home", "school", "sports_esports", "music_note", "photo_camera", "savings", "public",
];
/** A grid of icon buttons plus an "auto" option; `selected` pre-selects one. */
function iconPickerMarkup(selected?: string): string {
  const norm = (selected ?? "").trim();
  const auto = `<button type="button" class="iconpick iconpick-auto${norm ? "" : " selected"}" data-icon="" title="Auto — default by repo kind">${icon("hide_source")}</button>`;
  const cells = ENV_ICONS.map(
    (n) => `<button type="button" class="iconpick${n === norm ? " selected" : ""}" data-icon="${esc(n)}" title="${esc(n)}">${icon(n)}</button>`,
  ).join("");
  return `<label>Icon<div class="icon-row" id="icon-row">${auto}${cells}</div></label>`;
}
function wireIconPicker(): void {
  const row = document.getElementById("icon-row");
  if (!row) return;
  row.querySelectorAll<HTMLElement>(".iconpick").forEach((b) =>
    b.addEventListener("click", () => {
      row.querySelectorAll(".iconpick").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
    }),
  );
}
/** The picked Material Symbol name, or "" for auto. */
function selectedIcon(): string {
  return document.querySelector<HTMLElement>("#icon-row .iconpick.selected")?.dataset.icon ?? "";
}

/** Register a project repo as an environment — clone from a git URL, or pick a local repo. */
function showAddEnvironment(): void {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>Add environment</h3>
    ${serverPickerMarkup()}
    <label>Clone from URL<input id="ae-url" placeholder="e.g. git@github.com:owner/repo.git" /></label>
    <p class="small muted">Cloned into <code>~/Development/&lt;repo&gt;</code> using this machine's git/SSH credentials. Leave blank to use an existing local repo instead.</p>
    <label>Name (optional)<input id="ae-name" placeholder="defaults to the repo name" /></label>
    <label>Default branch (optional)<input id="ae-base" placeholder="e.g. main or dev — leave blank for HEAD" /></label>
    ${swatchPickerMarkup()}
    ${iconPickerMarkup()}
    <p class="small muted">Or pick an existing local <b>git repository</b>:</p>
    ${browserMarkup()}
    <div class="btns"><button type="button" id="ae-back">Cancel</button><button type="button" id="ae-save" class="primary">Add</button></div></div>`;
  showModal(m);
  wireServerPicker();
  wireBrowser();
  wireSwatchPicker();
  wireIconPicker();
  $<HTMLButtonElement>("#ae-back").onclick = closeModal; // returns to Settings underneath
  $<HTMLButtonElement>("#ae-save").onclick = async () => {
    const url = $<HTMLInputElement>("#ae-url").value.trim();
    const name = $<HTMLInputElement>("#ae-name").value.trim();
    const defaultBase = $<HTMLInputElement>("#ae-base").value.trim();
    const color = selectedSwatch();
    const iconName = selectedIcon();
    if (url) {
      const btn = $<HTMLButtonElement>("#ae-save");
      btn.disabled = true;
      btn.textContent = "Cloning…";
      try {
        const res = await sendAwait(
          browseServer(),
          { type: "env.clone", url, ...(name ? { name } : {}), ...(defaultBase ? { defaultBase } : {}), ...(color ? { color } : {}), ...(iconName ? { icon: iconName } : {}), cid: newCid() },
          120_000,
        );
        if (res.type === "command.error") {
          toast(`Clone failed: ${res.message}`);
          btn.disabled = false;
          btn.textContent = "Add";
          return;
        }
        closeModal(); // the environments broadcast refreshes Settings / the new-session list
      } catch (e) {
        toast(`Clone failed: ${e instanceof Error ? e.message : String(e)}`);
        btn.disabled = false;
        btn.textContent = "Add";
      }
      return;
    }
    if (!browse.path) return;
    browseServer().sock.send({
      type: "env.add",
      name: name || (browse.path.split("/").pop() ?? browse.path),
      repoRoot: browse.path,
      ...(defaultBase ? { defaultBase } : {}),
      ...(color ? { color } : {}),
      ...(iconName ? { icon: iconName } : {}),
    });
    closeModal(); // the environments broadcast refreshes Settings / the new-session list
  };
}

/** Edit an environment's name / default branch, or remove it. */
function showEditEnvironment(id: string): void {
  const env = environments.get(id);
  if (!env) return;
  const m = document.createElement("div");
  m.className = "modal";
  const projectOptions = todoistProjectOptions(env.todoistProjectId, env.id);
  m.innerHTML = `<div class="modal-box"><h3>Edit environment</h3>
    <label>Name<input id="ee-name" value="${esc(env.name)}" /></label>
    <label>Default branch<input id="ee-base" value="${esc(env.defaultBase ?? "")}" placeholder="e.g. main or dev — blank for HEAD" /></label>
    ${swatchPickerMarkup(env.color)}
    ${iconPickerMarkup(env.icon)}
    <label>Todoist project
      <select id="ee-todoist">${projectOptions}</select>
    </label>
    ${todoistConnected ? "" : `<p class="small muted">Connect Todoist (Settings → Todoist) to link a project.</p>`}
    <p class="small muted">repo: <code>${esc(env.repoRoot)}</code>${env.isRepo ? "" : " (not a git repo)"}</p>
    <div class="btns"><button type="button" class="danger" id="ee-remove">Remove</button><span class="spacer" style="flex:1"></span><button type="button" id="ee-back">Back</button><button type="button" id="ee-save">Save</button></div></div>`;
  showModal(m);
  wireSwatchPicker();
  wireIconPicker();
  enhanceSelect(document.getElementById("ee-todoist") as HTMLSelectElement | null, true);
  if (todoistConnected && !todoistProjectsLoaded) void loadTodoistProjects(); // names fill in on reopen
  $<HTMLButtonElement>("#ee-back").onclick = closeModal;
  $<HTMLButtonElement>("#ee-save").onclick = () => {
    const chosenProject = $<HTMLSelectElement>("#ee-todoist").value;
    // Guard against a race: another client may have linked this project while the modal was open
    // (the dropdown already disables known clashes). One project ↔ one environment.
    if (chosenProject) {
      const clash = todoistProjectLinks(id).get(chosenProject);
      if (clash) {
        toast(`“${todoistProjectName(chosenProject) ?? "That project"}” is already linked to ${clash.envName} @ ${clash.serverName}. Unlink it there first.`);
        return;
      }
    }
    serverOfEnv(id).sock.send({
      type: "env.update",
      id,
      name: $<HTMLInputElement>("#ee-name").value,
      defaultBase: $<HTMLInputElement>("#ee-base").value,
      color: selectedSwatch(),
      icon: selectedIcon(), // "" resets to the default by repo kind
      todoistProjectId: $<HTMLSelectElement>("#ee-todoist").value, // "" unlinks
      // validation gate omitted: autopilot doesn't auto-build/PR yet. Omitting the field preserves
      // any stored value (env.update only writes validation when it's present).
    });
    closeModal();
  };
  $<HTMLButtonElement>("#ee-remove").onclick = async () => {
    const ok = await confirmDialog({
      icon: "delete",
      title: `Remove “${env.name}”?`,
      body: "Removes this environment from the list. Existing sessions are unaffected.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (ok) {
      serverOfEnv(id).sock.send({ type: "env.remove", id });
      closeModal();
    }
  };
}

/** One-off: work directly in a folder, no worktree. */
function showOneOff(): void {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>One-off session</h3>
    <p class="small muted">Work directly in a folder (no worktree):</p>
    ${serverPickerMarkup()}
    ${browserMarkup()}
    ${AUTONOMY_PICKER}
    ${ADVERSARIAL_PICKER}
    <div class="btns"><button type="button" id="oo-back">Back</button><button type="button" id="oo-create">Open here</button></div></div>`;
  showModal(m);
  wireServerPicker();
  wireBrowser();
  enhanceSelect(document.getElementById("ns-auto") as HTMLSelectElement | null);
  $<HTMLButtonElement>("#oo-back").onclick = () => showNewSession();
  $<HTMLButtonElement>("#oo-create").onclick = () => {
    if (!browse.path) return;
    browseServer().sock.send({
      type: "session.create",
      source: "existing-dir",
      cwd: browse.path,
      model: DEFAULT_MODEL,
      autonomy: selectedAutonomy(),
      adversarialReview: selectedAdversarial(),
    });
    closeModal();
  };
}
// Inline permission cards live IN the conversation (not a modal) so they survive app/session
// switches — a modal overlay gets dismissed or visually lost, stranding the request. Keyed by
// requestId so a replayed/re-surfaced request (cold attach) doesn't stack duplicate cards.
const permCards = new Map<string, HTMLElement>();

function showPermission(requestId: string, tool: string, inputObj: unknown, suggestions: PermissionSuggestion[]): void {
  if (permCards.has(requestId)) return; // already shown (re-attach replay)
  dropSessionHero(); // a request landed in a blank session — retire the title card
  hideThinking(); // the turn is parked on this decision, not working
  const card = document.createElement("div");
  card.className = "bubble permission";
  card.dataset.req = requestId;
  const json = esc(JSON.stringify(inputObj, null, 2)).slice(0, 800);
  card.innerHTML =
    `<div class="perm-head">${icon("encrypted")}<span>Permission needed · <b>${esc(tool)}</b></span></div>` +
    `<pre class="perm-input">${json}</pre>` +
    `<div class="perm-btns"></div>`;
  const btns = card.querySelector(".perm-btns")!;
  for (const s of suggestions) {
    const b = document.createElement("button");
    b.className = `perm-btn ${s.decision}`;
    b.textContent = s.label;
    b.onclick = () => {
      sendTo(activeId, { type: "permission.respond", requestId, decision: s.decision });
      resolvePermissionUI(requestId, s.label);
    };
    btns.appendChild(b);
  }
  permCards.set(requestId, card);
  conversation.appendChild(card);
  scrollDown();
}

/** Mark a permission card answered: lock its buttons, show the choice, then fade it out. */
function resolvePermissionUI(requestId: string, label?: string): void {
  const card = permCards.get(requestId);
  if (!card) return;
  permCards.delete(requestId);
  card.classList.add("resolved");
  card.querySelectorAll<HTMLButtonElement>(".perm-btn").forEach((b) => (b.disabled = true));
  const btns = card.querySelector(".perm-btns");
  if (btns && label) btns.innerHTML = `<span class="perm-done">${icon("check")} ${esc(label)}</span>`;
}

/** A session left awaiting_permission (answered here, on another device, or superseded). */
function clearPermissionCards(): void {
  for (const id of [...permCards.keys()]) resolvePermissionUI(id);
}

// ── Question cards (AskUserQuestion, §6.6) ───────────────────────────────────────
// Inline like permission cards (survive session/app switches; keyed by requestId so a
// re-surfaced request on cold attach doesn't stack duplicates). Options are CLICKABLE buttons,
// like Claude Code natively: for a lone single-select question, one tap on an option submits it
// outright (no separate Submit step). Multi-select questions toggle their buttons and a Submit
// answers them; multiple questions select per-block, then Submit answers all. Each block keeps an
// "Other" free-text field (the SDK always offers one).
const questionCards = new Map<string, HTMLElement>();

function showQuestion(requestId: string, questions: Question[]): void {
  if (questionCards.has(requestId)) return; // already shown (re-attach replay)
  dropSessionHero(); // a question landed in a blank session — retire the title card
  hideThinking(); // the turn is parked on the answer, not working
  const card = document.createElement("div");
  card.className = "bubble question";
  card.dataset.req = requestId;

  const head = document.createElement("div");
  head.className = "q-head";
  head.innerHTML = `${icon("help")}<span>Claude is asking…</span>`;
  card.appendChild(head);

  // One tap answers when there's a single single-select question (the common "interview me" case).
  const oneTap = questions.length === 1 && !questions[0]!.multiSelect;
  const chosen: string[][] = questions.map(() => []); // button selections, per question

  const send = (): void => {
    const answers = gatherAnswers(card, questions, chosen);
    if (!answers) {
      toast("Pick or type an answer for each question.");
      return;
    }
    // Resolve the card and surface "Working" up front so the tap feels instant — the turn
    // resumes on the daemon's next event. The send happens after (and is queued if we're offline).
    resolveQuestionUI(requestId, summarizeAnswers(answers));
    showThinking("running_tool");
    respondToQuestion({ type: "question.respond", requestId, answers });
  };

  for (const [qi, q] of questions.entries()) {
    const block = document.createElement("div");
    block.className = "q-block";
    block.innerHTML =
      `<div class="q-title">${q.header ? `<span class="q-chip">${esc(q.header)}</span>` : ""}<span>${esc(q.question)}</span></div>`;
    const opts = document.createElement("div");
    opts.className = "q-options";
    for (const o of q.options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "q-option clickable";
      btn.innerHTML = `<span class="q-opt-text"><b>${esc(o.label)}</b>${o.description ? `<span class="q-opt-desc">${esc(o.description)}</span>` : ""}</span>`;
      btn.onclick = () => {
        if (oneTap) {
          chosen[qi] = [o.label];
          send(); // one tap → answer immediately
        } else if (q.multiSelect) {
          const set = new Set(chosen[qi]);
          set.has(o.label) ? set.delete(o.label) : set.add(o.label);
          chosen[qi] = [...set];
          btn.classList.toggle("selected");
        } else {
          chosen[qi] = [o.label];
          opts.querySelectorAll(".q-option").forEach((el) => el.classList.remove("selected"));
          btn.classList.add("selected");
        }
      };
      opts.appendChild(btn);
    }
    // "Other" free-text affordance — wraps and grows with the text instead of scrolling sideways.
    const other = document.createElement("textarea");
    other.className = "q-other";
    other.rows = 1;
    other.placeholder = "Other… (type a custom answer)";
    const growOther = (): void => {
      other.style.height = "auto";
      other.style.height = `${Math.min(other.scrollHeight, 200)}px`;
    };
    other.addEventListener("input", growOther);
    if (oneTap) {
      // Enter submits the one-tap case; Shift+Enter inserts a newline.
      other.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (other.value.trim()) send();
        }
      });
    }
    block.appendChild(opts);
    block.appendChild(other);
    card.appendChild(block);
  }

  const btns = document.createElement("div");
  btns.className = "q-btns";
  const skip = document.createElement("button");
  skip.className = "q-btn skip";
  skip.textContent = "Skip";
  skip.onclick = () => {
    resolveQuestionUI(requestId, "Skipped");
    showThinking("running_tool");
    respondToQuestion({ type: "question.respond", requestId, answers: [], cancelled: true });
  };
  btns.appendChild(skip);
  if (!oneTap) {
    const submit = document.createElement("button");
    submit.className = "q-btn submit";
    submit.textContent = questions.length > 1 ? "Submit answers" : "Submit";
    submit.onclick = send;
    btns.appendChild(submit);
  }
  card.appendChild(btns);

  questionCards.set(requestId, card);
  conversation.appendChild(card);
  // Bring the *top* of the question block to the top of the view (not the bottom) so a tall
  // multi-question block starts at its first question instead of scrolling past the title.
  card.scrollIntoView({ block: "start" });
}

/** Fire a question answer; queue it for reconnect instead of dropping it if we're momentarily offline. */
function respondToQuestion(cmd: { type: "question.respond"; requestId: string; answers: QuestionAnswer[]; cancelled?: boolean }): void {
  if (!sendTo(activeId, cmd)) enqueue({ cid: newCid(), cmd }); // route to the active session's server
}

/** Gather one answer per question from the clicked options + any "Other" text; null if any is empty. */
function gatherAnswers(card: HTMLElement, questions: Question[], chosen: string[][]): QuestionAnswer[] | null {
  const answers: QuestionAnswer[] = [];
  const blocks = card.querySelectorAll<HTMLElement>(".q-block");
  for (const [qi, q] of questions.entries()) {
    const labels = [...(chosen[qi] ?? [])];
    const notes = blocks[qi]?.querySelector<HTMLTextAreaElement>(".q-other")?.value.trim() || undefined;
    if (notes) labels.push(notes); // a typed "Other" answer counts as a chosen label
    if (labels.length === 0) return null; // unanswered
    answers.push({ question: q.question, labels, ...(notes ? { notes } : {}) });
  }
  return answers;
}

function summarizeAnswers(answers: QuestionAnswer[]): string {
  return answers.map((a) => a.labels.join(", ")).join(" · ");
}

/** Mark a question card answered. With a known answer, collapse the whole prompt to a single compact
 *  "Claude asked → <answer>" line right away (no lingering, faded options list) so it feels instant
 *  and reads like a sent reply; otherwise (answered elsewhere/superseded) just lock + fade it. */
function resolveQuestionUI(requestId: string, label?: string): void {
  const card = questionCards.get(requestId);
  if (!card) return;
  questionCards.delete(requestId);
  card.classList.add("resolved");
  if (label) {
    card.innerHTML =
      `<div class="q-head">${icon("help")}<span>Claude asked…</span></div>` +
      `<div class="q-answered"><span class="q-done">${icon("check")} ${esc(label)}</span></div>`;
  } else {
    card.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((el) => (el.disabled = true));
  }
}

/** A session left awaiting_question (answered here, on another device, or superseded). */
function clearQuestionCards(): void {
  for (const id of [...questionCards.keys()]) resolveQuestionUI(id);
}

// ── Toast ──────────────────────────────────────────────────────────────────────
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string): void {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}

/** Themed replacement for window.confirm — resolves true if confirmed. */
function confirmDialog(opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean; icon?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="modal-box">
      <h3>${opts.icon ? icon(opts.icon) + " " : ""}${esc(opts.title)}</h3>
      ${opts.body ? `<p class="small muted">${esc(opts.body)}</p>` : ""}
      <div class="btns"><button type="button" id="cd-cancel">Cancel</button><button type="button" id="cd-ok" class="${opts.danger ? "danger" : "primary"}">${esc(opts.confirmLabel ?? "OK")}</button></div>
    </div>`;
    showModal(m);
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(v); // resolve BEFORE teardown so the explicit choice wins over the cancel-on-close below
      closeModal();
    };
    // Dismissing the dialog any other way (Escape, device Back, backdrop tap) counts as Cancel — and,
    // crucially, must resolve the promise so the awaiting caller doesn't hang. Augment this modal
    // layer's teardown to resolve(false); whichever resolve runs first wins (Promise is one-shot).
    const top = overlays[overlays.length - 1];
    if (top && top.name === "modal") {
      const origClose = top.close;
      top.close = () => {
        origClose();
        if (!settled) {
          settled = true;
          resolve(false);
        }
      };
    }
    $<HTMLButtonElement>("#cd-ok").onclick = () => done(true);
    $<HTMLButtonElement>("#cd-cancel").onclick = () => done(false);
    m.addEventListener("click", (e) => {
      if (e.target === m) done(false); // click backdrop to cancel
    });
    // Focus a default button so Enter confirms; a destructive dialog defaults to the safe Cancel.
    (opts.danger ? $<HTMLButtonElement>("#cd-cancel") : $<HTMLButtonElement>("#cd-ok")).focus();
  });
}

/** Like confirmDialog, but with one extra checkbox toggle. Resolves { ok, checked }; cancelling
 *  (button, Escape, Back, backdrop) resolves { ok:false } and the checkbox state is irrelevant. */
function confirmDialogWithOption(opts: {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  icon?: string;
  optionLabel: string;
  optionChecked?: boolean;
}): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="modal-box">
      <h3>${opts.icon ? icon(opts.icon) + " " : ""}${esc(opts.title)}</h3>
      ${opts.body ? `<p class="small muted">${esc(opts.body)}</p>` : ""}
      <label class="cd-option"><input type="checkbox" id="cd-option"${opts.optionChecked ? " checked" : ""}> ${esc(opts.optionLabel)}</label>
      <div class="btns"><button type="button" id="cd-cancel">Cancel</button><button type="button" id="cd-ok" class="${opts.danger ? "danger" : "primary"}">${esc(opts.confirmLabel ?? "OK")}</button></div>
    </div>`;
    showModal(m);
    const checked = (): boolean => $<HTMLInputElement>("#cd-option").checked;
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, checked: ok && checked() }); // resolve BEFORE teardown so the explicit choice wins
      closeModal();
    };
    // Any other dismissal (Escape, device Back, backdrop tap) counts as Cancel and must resolve so the
    // awaiting caller doesn't hang — mirror confirmDialog's overlay-close augmentation.
    const top = overlays[overlays.length - 1];
    if (top && top.name === "modal") {
      const origClose = top.close;
      top.close = () => {
        origClose();
        if (!settled) {
          settled = true;
          resolve({ ok: false, checked: false });
        }
      };
    }
    $<HTMLButtonElement>("#cd-ok").onclick = () => done(true);
    $<HTMLButtonElement>("#cd-cancel").onclick = () => done(false);
    m.addEventListener("click", (e) => {
      if (e.target === m) done(false); // click backdrop to cancel
    });
    (opts.danger ? $<HTMLButtonElement>("#cd-cancel") : $<HTMLButtonElement>("#cd-ok")).focus();
  });
}

/** Pick one item from a list (link a plan to a session, reassign a plan's environment, …). Resolves the
 *  chosen id, or null if cancelled (button, Escape, Back, backdrop). */
function pickListDialog(title: string, items: { id: string; label: string; icon?: string }[], headIcon = "link"): Promise<string | null> {
  return new Promise((resolve) => {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="modal-box">
      <h3>${icon(headIcon)} ${esc(title)}</h3>
      <div class="pick-list">${items
        .map((it) => `<button type="button" class="pick-item" data-id="${esc(it.id)}">${icon(it.icon ?? "terminal")} ${esc(it.label || it.id)}</button>`)
        .join("")}</div>
      <div class="btns"><button type="button" id="cd-cancel">Cancel</button></div>
    </div>`;
    showModal(m);
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v); // resolve BEFORE teardown so the explicit choice wins over cancel-on-close
      closeModal();
    };
    const top = overlays[overlays.length - 1];
    if (top && top.name === "modal") {
      const origClose = top.close;
      top.close = () => {
        origClose();
        if (!settled) {
          settled = true;
          resolve(null);
        }
      };
    }
    m.querySelectorAll<HTMLElement>(".pick-item").forEach((b) => (b.onclick = () => done(b.dataset.id!)));
    $<HTMLButtonElement>("#cd-cancel").onclick = () => done(null);
    m.addEventListener("click", (e) => {
      if (e.target === m) done(null); // click backdrop to cancel
    });
  });
}
