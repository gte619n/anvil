import MarkdownIt from "markdown-it";
import Sortable from "sortablejs";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AnvilSocket } from "./ws";
import { apiFetch, daemonBase } from "./api";

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
import type {
  AttachmentRef,
  AutopilotPlanInfo,
  AutopilotSchedule,
  AutonomyPolicy,
  Budget,
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
  Question,
  QuestionAnswer,
  ServerEvent,
  Session,
  TodoistProjectInfo,
} from "../../protocol";
import { PALETTE, envOrdinal, sessionBg, stripeColor } from "./sessionColor";

// App version, replaced at build time (native: the APK versionName; PWA: package.json version).
declare const __APP_VERSION__: string;

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const icon = (name: string): string => `<span class="msym">${name}</span>`;

// Show the build version next to the brand so it's obvious which app/bundle is running.
$("#brand-version").textContent = `v${__APP_VERSION__}`;
const sessIcon = (s: Session): string =>
  s.isDefault ? "robot_2" : s.pending ? "schedule" : s.icon ?? (s.source === "fresh-worktree" ? "account_tree" : "folder");
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
const sessions = new Map<string, Session>();
const environments = new Map<string, Environment>();
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
  budget?: Budget; // last budget snapshot (aggregate gauge, §7)
}
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
/** Resolve a daemon-relative path against a specific server (session-scoped REST routing). */
const serverApiUrl = (base: string, path: string): string =>
  /^https?:\/\//i.test(path) ? path : base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
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
  for (const [pid, u] of [...planServer]) if (u === url) planServer.delete(pid);
  updateAutopilotBadge();
  saveExtraServers([...servers.keys()].filter((u) => u !== HUB_URL));
  persistSessions();
  persistEnvironments();
  persistRouting();
  renderSessions();
  if (document.getElementById("server-cards")) renderServerCards(); // drop the card from an open Settings view
}
const hub = (): Server => servers.get(HUB_URL)!;
function serverOf(sessionId: string | null | undefined): Server | undefined {
  if (!sessionId) return undefined;
  const u = sessionServer.get(sessionId);
  return u ? servers.get(u) : undefined;
}
function activeServer(): Server {
  return serverOf(activeId) ?? hub();
}
/** The server an environment lives on (its repos are local to that daemon). */
function serverOfEnv(envId: string | null | undefined): Server {
  const u = envId ? envServer.get(envId) : undefined;
  return (u ? servers.get(u) : undefined) ?? hub();
}
/** Route a session-scoped command to the daemon that owns the session (falls back to the hub). */
function sendTo(sessionId: string | null | undefined, cmd: Record<string, unknown> & { type: string }): boolean {
  return (serverOf(sessionId) ?? hub()).sock.send(cmd);
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
// URL routing: the active session lives in the hash (#s/<id>) so Back/Forward works and a
// session is deep-linkable / openable in its own tab. A ?session= query (old push links) still works.
const sessionFromHash = (): string | null => {
  const m = location.hash.match(/^#s\/(.+)$/);
  return m ? decodeURIComponent(m[1]!) : null;
};

// ── Back-stack: device/browser Back dismisses the top UI layer before leaving ─────────
// Modals/dialogs, the settings view, the side panel and the (mobile) expanded sidebar are
// all "soft" layers. Each pushes a history entry when it opens, so Back has somewhere to go
// instead of exiting the app: Android routes the device button through web.goBack(), macOS
// uses the swipe gesture, the PWA/browser uses its own Back — all surface as `popstate`,
// which closes the topmost layer. Each entry records how many layers were open (`anvilDepth`)
// so a single popstate can unwind to exactly the right place.
type OverlayName = "modal" | "settings" | "autopilot" | "panel" | "sidebar";
interface Overlay {
  name: OverlayName;
  close: () => void; // pure DOM/state teardown — must NOT touch history itself
}
const overlays: Overlay[] = [];
let suppressPop = 0; // popstates from our own dismissOverlay() unwind — teardown already done
const overlayOpen = (name: OverlayName): boolean => overlays.some((o) => o.name === name);
function openOverlay(name: OverlayName, close: () => void, hash?: string): void {
  if (overlayOpen(name)) return; // already open (e.g. swapping a modal's contents in place)
  overlays.push({ name, close });
  // `hash` (e.g. "#autopilot") gives the overlay its own URL so it's a real history entry — Back
  // reverts the URL and pops the layer. Omit it to keep the current URL (the session hash).
  const url = hash ? `${location.pathname}${hash}` : undefined;
  history.pushState({ anvilDepth: overlays.length }, "", url);
}
/** Programmatically dismiss `name` and anything stacked above it (Cancel / X / backdrop). Tears
 *  down synchronously, then unwinds our own history entries (the resulting popstate is swallowed
 *  by the guard). Closing layers via the device/browser Back goes through popstate directly. */
function dismissOverlay(name: OverlayName): void {
  const idx = overlays.map((o) => o.name).lastIndexOf(name);
  if (idx < 0) return; // already gone — keeps redundant/double closes harmless
  const n = overlays.length - idx;
  for (let i = 0; i < n; i++) overlays.pop()!.close();
  suppressPop++;
  history.go(-n); // drop our history entries; the one popstate this fires is suppressed below
}
/** Dismiss just the topmost soft layer (used by the Escape key) — same teardown as a single Back. */
function dismissTopOverlay(): boolean {
  const top = overlays[overlays.length - 1];
  if (!top) return false;
  dismissOverlay(top.name);
  return true;
}

const sessionHref = (id: string): string => `${location.pathname}#s/${encodeURIComponent(id)}`;
function setSessionHash(id: string | null, push: boolean): void {
  const url = id ? sessionHref(id) : location.pathname;
  const state = { anvilDepth: overlays.length };
  if (push) history.pushState(state, "", url);
  else history.replaceState(state, "", url);
}
// A session in the URL (#s/… or ?session=) means we were opened via a deep link or a notification
// tap — as opposed to just restoring the last-active session from storage. On a phone we then jump
// straight into that conversation with the sidebar hidden (see the collapse below). (UI refinement §4)
const deepLinkedSession = sessionFromHash() || new URLSearchParams(location.search).get("session");
let activeId: string | null = deepLinkedSession || localStorage.getItem("anvil.active");
setSessionHash(activeId, false); // canonicalize the URL (also strips any ?session=)
window.addEventListener("popstate", () => {
  if (suppressPop > 0) {
    suppressPop--; // our own dismissOverlay() unwind — the layer is already torn down
    return;
  }
  // Device/browser Back: close every layer stacked above the depth we landed on (dialogs/menus/
  // panels dismiss before we navigate sessions or leave the app).
  const depth = typeof (history.state as { anvilDepth?: number } | null)?.anvilDepth === "number" ? (history.state as { anvilDepth: number }).anvilDepth : 0;
  while (overlays.length > depth) overlays.pop()!.close();
  // Then reflect the session hash (Back/Forward between sessions, then out of the app).
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
(function initTheme() {
  const stored = localStorage.getItem("anvil.theme");
  const theme = stored ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
})();

// instant restore: paint the hydrated sidebar + cached conversation immediately on load (works
// fully offline; the daemon refreshes everything once the WS connects).
renderSessions();
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

// ── Theme (system default + persisted toggle) ────────────────────────────────
function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
function applyThemeIcon(): void {
  $("#theme-toggle").innerHTML = icon(currentTheme() === "dark" ? "light_mode" : "dark_mode");
}
applyThemeIcon(); // data-theme is resolved earlier, before the first render
$("#theme-toggle").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("anvil.theme", next);
  applyThemeIcon();
  renderSessions(); // re-clamp session tints for the new theme
  applyActiveTint();
});
// Follow the OS theme live when the user hasn't pinned a preference.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (localStorage.getItem("anvil.theme")) return; // a manual choice wins
  document.documentElement.dataset.theme = e.matches ? "dark" : "light";
  applyThemeIcon();
  renderSessions();
  applyActiveTint();
});

// ── Sidebar collapse ─────────────────────────────────────────────────────────────
// 700px keeps the phone-only layout off the iPad Mini (744px) and the unfolded Galaxy Z Fold
// (~755px) while still catching every real phone. Must stay in sync with the @media query in app.css.
const isNarrow = (): boolean => matchMedia("(max-width: 700px)").matches;
let sidebarCollapsed =
  localStorage.getItem("anvil.sidebar") === "collapsed" ||
  (localStorage.getItem("anvil.sidebar") === null && isNarrow());
// Opened via a deep link / notification on a phone: jump straight into the conversation with the
// session menu hidden, even if the sidebar was last left open. (UI refinement §4)
if (deepLinkedSession && activeId && isNarrow()) sidebarCollapsed = true;
function applySidebar(): void {
  $("#sidebar").classList.toggle("collapsed", sidebarCollapsed);
}
applySidebar();
function toggleSidebar(): void {
  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem("anvil.sidebar", sidebarCollapsed ? "collapsed" : "open");
  applySidebar();
  // On a phone the open sidebar overlays the conversation — make Back close it.
  if (isNarrow()) {
    if (!sidebarCollapsed) openOverlay("sidebar", () => { sidebarCollapsed = true; applySidebar(); });
    else dismissOverlay("sidebar");
  }
}
// both the header ☰ and an in-sidebar button toggle it — the in-sidebar one stays reachable
// when the open sidebar overlays the header (e.g. unfolding a foldable).
$("#btn-sidebar").addEventListener("click", toggleSidebar);
$("#sidebar-collapse").addEventListener("click", toggleSidebar);

// ── Resizable panes (left sidebar + right side panel) ────────────────────────────
// Each pane's width is a CSS variable on :root, persisted per device. A thin handle straddling the
// pane's border drives it via pointer events (touch-safe, capture so the drag survives leaving the
// strip). Disabled on narrow screens, where the sidebar overlays and the panel is near full-bleed.
const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
function initResizers(): void {
  const root = document.documentElement;
  const stored = (k: string): number => Number(localStorage.getItem(k)) || 0;
  const sw = stored("anvil.sidebarW");
  if (sw) root.style.setProperty("--sidebar-w", `${sw}px`);
  const pw = stored("anvil.panelW");
  if (pw) root.style.setProperty("--panel-w", `${pw}px`);

  const wire = (
    handle: HTMLElement | null,
    cfg: { cssVar: string; key: string; min: number; maxFn: () => number; width: (clientX: number) => number },
  ): void => {
    if (!handle) return;
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (isNarrow()) return; // resizing is desktop-only
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      let latest = 0;
      const move = (ev: PointerEvent): void => {
        latest = clampN(cfg.width(ev.clientX), cfg.min, cfg.maxFn());
        root.style.setProperty(cfg.cssVar, `${latest}px`);
      };
      const up = (): void => {
        handle.releasePointerCapture(e.pointerId);
        handle.classList.remove("dragging");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (latest) localStorage.setItem(cfg.key, String(Math.round(latest)));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  };

  const sidebar = document.getElementById("sidebar");
  wire(document.getElementById("sidebar-resizer"), {
    cssVar: "--sidebar-w",
    key: "anvil.sidebarW",
    min: 200,
    maxFn: () => Math.min(620, window.innerWidth - 360), // always leave the conversation room
    width: (x) => x - (sidebar?.getBoundingClientRect().left ?? 0), // pointer X minus the sidebar's left edge
  });
  const sidePanel = document.getElementById("side-panel");
  wire(document.getElementById("panel-resizer"), {
    cssVar: "--panel-w",
    key: "anvil.panelW",
    min: 320,
    maxFn: () => Math.min(window.innerWidth * 0.92, 1000),
    width: (x) => (sidePanel?.getBoundingClientRect().right ?? window.innerWidth) - x, // panel is pinned right, grows leftward
  });
}
initResizers();

// On a phone there isn't room for both panes, so when focus moves to the chat (a tap or the
// composer gaining focus) we collapse the overlaid session list — never a half-covered chat.
function collapseSidebarForChat(): void {
  if (!isNarrow() || sidebarCollapsed) return;
  if (overlayOpen("sidebar")) dismissOverlay("sidebar"); // also unwinds the Back-stack entry
  else { sidebarCollapsed = true; applySidebar(); } // open without an overlay entry (e.g. after a resize)
}
$("#convo-col").addEventListener("pointerdown", collapseSidebarForChat);
$("#convo-col").addEventListener("focusin", collapseSidebarForChat);

// (multi-server connection layer is declared up top with the other early-init state; the sockets
// connect at the bottom, once the outbox state onStatus reads is initialized.)

// ── Outbox: writes made offline are queued and flushed, in order, on reconnect (arch §8) ──────
interface OutboxItem {
  cid: string;
  cmd: Record<string, unknown> & { type: string };
  tempId?: string; // for session.create: the optimistic local session id to reconcile
  serverUrl?: string; // target server for commands with no sessionId yet (session.create)
}
const newCid = (): string => (crypto.randomUUID ? crypto.randomUUID() : `c_${Date.now()}_${Math.floor(Math.random() * 1e9)}`);
let outbox: OutboxItem[] = (() => {
  try {
    return JSON.parse(localStorage.getItem("anvil.outbox") ?? "[]") as OutboxItem[];
  } catch {
    return [];
  }
})();
const saveOutbox = (): void => {
  try {
    localStorage.setItem("anvil.outbox", JSON.stringify(outbox));
  } catch {
    /* quota */
  }
};
function enqueue(item: OutboxItem): void {
  outbox.push(item);
  saveOutbox();
  updateOutboxBadge();
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
    for (const item of outbox) {
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
    outbox = remaining;
    saveOutbox();
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
  outbox = outbox.filter((i) => i.cmd.sessionId !== tempId && i.tempId !== tempId);
  saveOutbox();
  persistSessions();
  if (activeId === tempId) deselectSession();
  else renderSessions();
}
function updateOutboxBadge(): void {
  const el = document.getElementById("offline-banner");
  if (!el) return;
  const queued = outbox.length;
  const online = anyOpen();
  el.hidden = online && queued === 0;
  el.innerHTML = online
    ? `${icon("sync")} Syncing ${queued} queued change${queued === 1 ? "" : "s"}…`
    : `${icon("cloud_off")} Offline${queued ? ` · ${queued} change${queued === 1 ? "" : "s"} queued` : ""} <button id="offline-retry" class="mini">${icon("refresh")} Retry</button>`;
  const retry = document.getElementById("offline-retry");
  if (retry) retry.onclick = () => { for (const s of servers.values()) s.sock.connectNow(); };
}
// Start connecting now that the outbox state onStatus reads is initialized: the hub always, plus
// every server in the registry (fleet — they merge into one view).
ensureServer(HUB_URL);
for (const u of loadExtraServers()) ensureServer(u);

// Native Android/Apple shell bridge (present only inside the app): ADB-wifi connect, native push.
const nativeBridge: { postMessage(s: string): void; onmessage?: (e: MessageEvent) => void } | undefined = (window as unknown as { AnvilNative?: typeof nativeBridge }).AnvilNative;
if (nativeBridge) {
  nativeBridge.onmessage = (e) => {
    try {
      const r = JSON.parse(e.data) as { ok?: boolean; message?: string };
      const out = document.getElementById("adb-output");
      if (out) out.textContent = `${r.ok ? "✓ " : "⚠ "}${r.message ?? ""}`;
      else toast(r.message ?? "done");
    } catch {
      /* ignore */
    }
  };
}

// ── Web Push (arch §6.7) ──────────────────────────────────────────────────────────
let swReg: ServiceWorkerRegistration | null = null;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function urlB64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
async function initPush(): Promise<void> {
  if (nativeBridge) return; // native shells use platform push (FCM/APNs), not web push / service worker
  if (!pushSupported) return; // unsupported (e.g. iOS Safari until installed as a PWA)
  const bell = $("#btn-notify");
  bell.hidden = false;
  try {
    swReg = await navigator.serviceWorker.register("/sw.js");
  } catch {
    bell.hidden = true;
    return;
  }
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open-session" && e.data.sessionId && sessions.has(e.data.sessionId)) selectSession(e.data.sessionId);
  });
  bell.addEventListener("click", () => void toggleNotify());
  void refreshBell();
}
async function refreshBell(): Promise<void> {
  const sub = await swReg?.pushManager.getSubscription();
  const on = Notification.permission === "granted" && !!sub;
  const bell = $("#btn-notify");
  bell.innerHTML = icon(on ? "notifications_active" : "notifications_off");
  bell.classList.toggle("active", on);
}
async function toggleNotify(): Promise<void> {
  if (!swReg) return;
  const existing = await swReg.pushManager.getSubscription();
  if (existing) {
    await apiFetch("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: existing.endpoint }) });
    await existing.unsubscribe();
    toast("Notifications off");
  } else {
    if ((await Notification.requestPermission()) !== "granted") {
      toast("Notifications blocked in browser settings");
      return;
    }
    const { publicKey } = (await (await apiFetch("/api/push/key")).json()) as { publicKey: string };
    const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(publicKey) });
    await apiFetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
    toast("Notifications on");
  }
  void refreshBell();
}
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
    srv?.sock.send({ type: "autopilot.plans.list" }); // keep the sidebar badge + grid live for this server
    srv?.sock.send({ type: "autopilot.schedule.get" }); // current schedule for the Autopilot view
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
  if (cid && cidWaiters.has(cid)) {
    cidWaiters.get(cid)!(e); // resolve an outbox flush awaiting this command's response
    cidWaiters.delete(cid);
  }

  switch (e.type) {
    case "session.list": {
      // This server is the source of truth for ITS OWN sessions only — drop the ones it used to
      // own and no longer lists (not other servers' sessions, not optimistic pending locals).
      for (const id of [...sessions.keys()]) {
        if (sessionServer.get(id) === url && !sessions.get(id)?.pending) {
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
      if (!activeId) selectSession(e.session.id);
      return;
    case "session.updated":
      sessions.set(e.session.id, e.session);
      sessionServer.set(e.session.id, url);
      persistSessions();
      renderSessions();
      if (e.session.id === activeId) {
        updateGitPanelMeta();
        updateHeaderBranch(e.session); // keep the header branch chip fresh as git state changes
      }
      return;
    case "session.deleted":
      sessions.delete(e.sessionId);
      sessionServer.delete(e.sessionId);
      removingSessions.delete(e.sessionId); // cleanup finished — the row goes for good now
      localStorage.removeItem(`anvil.convo.${e.sessionId}`);
      localStorage.removeItem(`anvil.draft.${e.sessionId}`); // its unsent draft has nowhere to go now
      persistSessions();
      persistRouting();
      if (activeId === e.sessionId) deselectSession();
      else renderSessions();
      return;
    case "server.hello": {
      // identify the server on this socket as soon as it opens (fleet §3/§6).
      const srv = servers.get(url);
      if (srv) {
        srv.id = e.serverId;
        srv.name = e.serverName || srv.name;
        srv.version = e.version;
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
    case "todoist.status":
      // Todoist is hub-scoped (the token lives on the hub daemon; the link UI routes to hub()).
      // Fleet members each push their own status on connect — ignore them so a tokenless member
      // can't clobber the hub's "connected" with its "not connected".
      if (url === HUB_URL) onTodoistStatus(e.connected, e.account);
      return;
    case "todoist.projects.result":
      return; // resolved via cidWaiter (loadTodoistProjects)
    case "autopilot.plans":
      onAutopilotPlans(url, e.plans);
      return;
    case "autopilot.plan":
      return; // resolved via cidWaiter (refinePlan); the matching autopilot.plans broadcast refreshes state
    case "autopilot.started":
      return; // resolved via cidWaiter (startPlan)
    case "autopilot.run.result":
      return; // resolved via cidWaiter (runAutopilot)
    case "autopilot.run.progress":
      onAutopilotProgress(e.line);
      return;
    case "autopilot.schedule":
      onAutopilotSchedule(url, e.schedule, e.nextRunAt);
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
      toast(e.message);
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
      clearConversation();
      replayingSnapshot = true;
      e.events.forEach(renderConversationEvent);
      replayingSnapshot = false;
      // A replayed history has no `result` event, so the last turn's activity block was rebuilt
      // "live" — finalize it so it shows "Worked" instead of an eternally spinning "Working". If the
      // session is actually mid-turn, the live status/message events that follow re-light it.
      finalizeActivity();
      snapshotLoaded.add(e.sessionId);
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

// ── Conversation rendering ─────────────────────────────────────────────────────
function bubble(role: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  conversation.appendChild(el);
  scrollDown();
  return el;
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

  // One flat list across every server — no per-machine grouping. Sessions interleave by their
  // server-synced order; which machine a session lives on is shown subtly in its row meta when
  // there's more than one server. (fleet — anvil-multi-server.md §4)
  for (const s of rest.sort(sortFn)) (s.finished ? finishedUl : activeUl).appendChild(renderSessionItem(s));
  $("#finished-section").hidden = !anyFinished; // hide the group when nothing is finished
}

function renderSessionItem(s: Session): HTMLLIElement {
  const removing = removingSessions.has(s.id);
  const awaiting = !removing && !s.pending && !s.archived && (s.status === "awaiting_permission" || s.status === "awaiting_question");
  const li = document.createElement("li");
  li.className = `session${s.id === activeId ? " active" : ""}${s.archived ? " archived" : ""}${s.pending ? " pending" : ""}${awaiting ? " awaiting" : ""}${removing ? " removing" : ""}`;
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
  a.innerHTML = `<div class="title">${icon(removing ? "cleaning_services" : sessIcon(s))}<span class="t">${esc(s.title)}</span>${merged}</div><div class="meta">${esc(where)} · ${tag} · ${esc(s.model)}${machine}</div>`;
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a new tab
    e.preventDefault();
    if (justDragged) return; // a drag just ended on this row — don't also navigate
    if (!removing) selectSession(s.id); // a session being cleaned up isn't selectable
  });
  li.append(a);
  if (s.isDefault) {
    // The concierge is pinned; its row carries the "+" that opens the new-session flow.
    const add = document.createElement("button");
    add.className = "row-btn new-session";
    add.title = "New session";
    add.innerHTML = icon("add");
    add.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showNewSession();
    });
    li.append(add);
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
    [...$(sel).querySelectorAll<HTMLElement>(".session")].map((el) => el.dataset.id).filter((x): x is string => !!x);
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

// ── Settings & servers (first-class management area) ──────────────────────────────
type SettingsTab = "servers" | "environments" | "todoist";
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
      <button class="stab" data-tab="todoist">${icon("checklist")} Todoist</button>
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
      <section class="settings-panel" data-tab="todoist">
        <div class="section-head"><h3>Todoist</h3><button id="todoist-refresh" class="mini">${icon("refresh")} Refresh</button></div>
        <p class="small muted">Link a Todoist project to an environment, then the nightly autopilot plans &amp; builds its tasks. Set the token with <code>bun run scripts/todoist.ts set</code>.</p>
        <div id="todoist-panel"><p class="small muted">Loading…</p></div>
      </section>
    </div>
  </div>`;
  $("#settings-close").addEventListener("click", () => dismissOverlay("settings"));
  $("#set-add-env").addEventListener("click", () => showAddEnvironment());
  $("#todoist-refresh").addEventListener("click", () => loadTodoistProjects(true));
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
  if (tab === "todoist") {
    renderTodoistPanel();
    hub().sock.send({ type: "autopilot.schedule.get" }); // refresh the schedule card (once per tab open)
  }
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
  const rows = [...todoistProjects.values()]
    .sort((a, b) => (b.taskCount ?? 0) - (a.taskCount ?? 0))
    .map((p) => {
      const link = linkedBy.get(p.id);
      return `<tr>
        <td>${esc(p.name)}${p.parentId ? ` <span class="small muted">(sub)</span>` : ""}</td>
        <td class="small muted">${p.taskCount ?? 0}</td>
        <td>${link ? `<span class="small">${icon("link")} ${esc(link)}</span>` : `<span class="small muted">—</span>`}</td>
      </tr>`;
    })
    .join("");
  host.innerHTML = `<div class="card"><div class="card-main"><span class="conn-dot connected"></span><span>Connected${todoistAccount ? ` as <b>${esc(todoistAccount)}</b>` : ""} · ${todoistProjects.size} projects</span>
      <button id="todoist-disconnect" class="mini" style="margin-left:auto">Disconnect</button></div></div>
    ${scheduleSettingsCardHtml()}
    <table class="todoist-projects"><thead><tr><th>Project</th><th>Tasks</th><th>Linked environment</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="small muted">Link a project to an environment from <b>Environments → Edit</b>.</p>`;
  $("#todoist-disconnect").addEventListener("click", () => {
    hub().sock.send({ type: "todoist.disconnect", cid: newCid() });
    todoistProjectsLoaded = false;
    todoistProjects.clear();
  });
  $("#set-sched-edit").addEventListener("click", openScheduleModal);
}
/** Tear down the settings view (DOM only). Reached via Back (popstate) or dismissOverlay. */
function closeSettings(): void {
  $("#settings-root").innerHTML = "";
}
// ── Autopilot (plan review & launch; anvil-autopilot-ui.md) ────────────────────────
const autopilotLog: string[] = []; // streamed progress lines for the current/last run
let openPlanId: string | null = null; // the plan open in the reader, if any (else the grid is shown)
const SIZE_LABEL: Record<string, string> = { xs: "XS", s: "S", m: "M", l: "L", xl: "XL" };
const DAY_LABEL = ["S", "M", "T", "W", "T", "F", "S"]; // Sun..Sat, for the schedule day toggles
// Each server's autopilot schedule (the UI control targets the hub; the daemon supports per-server).
const serverSchedule = new Map<string, { schedule: AutopilotSchedule; nextRunAt?: string }>();

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
/** A server delivered its pending plans: re-tag routing, refresh the badge and (if open) the view. */
function onAutopilotPlans(url: string, plans: AutopilotPlanInfo[]): void {
  serverPlans.set(url, plans);
  for (const [pid, u] of [...planServer]) if (u === url) planServer.delete(pid);
  for (const p of plans) planServer.set(p.id, url);
  updateAutopilotBadge();
  if (!document.querySelector(".autopilot-view")) return;
  // A reader open on a plan that just vanished (dismissed/started elsewhere) falls back to the grid;
  // otherwise leave an open reader untouched (refine updates it in place) and only re-flow the grid.
  if (openPlanId) {
    if (!findPlan(openPlanId)) renderAutopilotGrid();
  } else {
    renderAutopilotGrid();
  }
}
function onAutopilotProgress(line: string): void {
  autopilotLog.push(line);
  runState.lastLine = line;
  const log = document.getElementById("autopilot-log");
  if (log) {
    log.hidden = false;
    log.textContent = autopilotLog.join("\n");
    log.scrollTop = log.scrollHeight;
  }
  renderRunStatus();
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
  if (!runState.running && runState.results.length === 0) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  const createdTotal = runState.results.reduce((n, r) => n + r.created, 0);
  const head = runState.running
    ? `<span class="ap-status-head"><span class="msym spin">progress_activity</span> Evaluating ${runState.serversTotal} project source${runState.serversTotal === 1 ? "" : "s"}…</span>`
    : `<span class="ap-status-head">${icon("check_circle")} ${createdTotal ? `${createdTotal} new plan${createdTotal === 1 ? "" : "s"}` : "No new plans"}</span>`;
  const live = runState.running && runState.lastLine
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
        <button id="autopilot-run" class="primary">${icon("play_arrow")} Run autopilot</button>
        <button id="autopilot-close" class="icon-btn" title="Close">${icon("close")}</button>
      </span>
    </div>
    <div class="ap-run-status" id="autopilot-status" hidden></div>
    <pre class="git-output ap-log" id="autopilot-log" hidden></pre>
    <div class="settings-body"><div id="autopilot-grid"></div></div>
  </div>`;
  $("#autopilot-close").addEventListener("click", () => dismissOverlay("autopilot"));
  $("#autopilot-run").addEventListener("click", () => void runAutopilot());
  renderScheduleBar();
  renderRunStatus();
  if (autopilotLog.length) {
    const log = $("#autopilot-log");
    log.hidden = false;
    log.textContent = autopilotLog.join("\n");
  }
  openOverlay("autopilot", closeAutopilot, "#autopilot"); // own URL; Back reverts it & closes the view
  renderAutopilotGrid();
  for (const s of orderedServers())
    if (s.sock.isOpen()) {
      s.sock.send({ type: "autopilot.plans.list" }); // fresh pull
      s.sock.send({ type: "autopilot.schedule.get" });
    }
}
/** Tear down the autopilot view (DOM only). Reached via Back (popstate) or dismissOverlay. */
function closeAutopilot(): void {
  openPlanId = null;
  $("#autopilot-root").innerHTML = "";
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
  return `<button class="plan-card" data-id="${esc(p.id)}" style="--plan-stripe:${stripe}">
    <span class="plan-title">${esc(p.title)}</span>
    ${summary ? `<span class="plan-summary">${esc(summary)}</span>` : ""}
    <span class="plan-meta">
      <span class="ap-chip">${icon("checklist")}${p.taskCount}</span>
      ${eff}
      <span class="ap-chip status-${esc(p.status)}">${esc(p.status)}</span>
    </span>
  </button>`;
}
/** A plan's environment display name (local env → broadcast name → fallback). */
function planEnvName(p: AutopilotPlanInfo): string {
  return p.environmentName ?? (p.environmentId ? environments.get(p.environmentId)?.name : undefined) ?? "Unlinked";
}
/** Group a server's plans by environment, ordered by environment name then title, so a repo's plans
 *  sit together under one separator. */
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
  for (const g of out) g.plans.sort((a, b) => a.title.localeCompare(b.title));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
/** The flowing card grid, grouped by server when the fleet has more than one. */
function renderAutopilotGrid(): void {
  openPlanId = null;
  const host = document.getElementById("autopilot-grid");
  if (!host) return;
  const multi = orderedServers().length > 1;
  if (pendingPlanCount() === 0) {
    host.innerHTML = `<div class="ap-empty">${icon("inbox")}
      <p>No pending plans.</p>
      <p class="small muted">Link a Todoist project to an environment in Settings, then <b>Run autopilot</b> to generate plans.</p></div>`;
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
}

/** The full-plan reader + refine chat + Dismiss/Go, rendered in place of the grid (same overlay). */
function openPlan(id: string): void {
  const p = findPlan(id);
  const host = document.getElementById("autopilot-grid");
  if (!p || !host) return;
  openPlanId = id;
  const env = p.environmentName ?? (p.environmentId ? environments.get(p.environmentId)?.name : undefined);
  host.innerHTML = `<div class="plan-reader" data-id="${esc(id)}">
    <div class="plan-reader-head">
      <button class="mini" id="plan-back">${icon("arrow_back")} All plans</button>
      <span class="plan-reader-title">${esc(p.title)}${env ? ` <span class="small muted">· ${esc(env)}</span>` : ""}</span>
      <span class="plan-reader-actions">
        <button class="mini danger" id="plan-dismiss">${icon("close")} Dismiss</button>
        <button class="primary" id="plan-start">${icon("rocket_launch")} Create session &amp; start</button>
      </span>
    </div>
    <div class="plan-reader-body">
      <article class="md plan-doc" id="plan-doc">${p.plan?.html ?? "<p class='muted'>No plan content.</p>"}</article>
      <aside class="plan-refine">
        <h4>${icon("auto_awesome")} Refine with Claude</h4>
        <p class="small muted">Suggest a change; Claude rewrites the plan and saves it back to Todoist.</p>
        <div id="plan-refine-log" class="plan-refine-log"></div>
        <form id="plan-refine-form" class="plan-refine-form">
          <textarea id="plan-refine-input" rows="2" placeholder="e.g. also cover the offline case, and keep the existing API"></textarea>
          <button type="submit" class="primary" id="plan-refine-send" title="Send">${icon("send")}</button>
        </form>
      </aside>
    </div>
  </div>`;
  $("#plan-back").addEventListener("click", () => renderAutopilotGrid());
  $("#plan-dismiss").addEventListener("click", () => void dismissPlan(id));
  $("#plan-start").addEventListener("click", () => void startPlan(id));
  $("#plan-refine-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void refinePlan(id);
  });
}

/** The server that owns a plan (refine/dismiss/start route there), or undefined if offline/unknown. */
function planSock(id: string): Server | undefined {
  const url = planServer.get(id);
  return url ? servers.get(url) : undefined;
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
    renderAutopilotGrid(); // the broadcast also refreshes, but don't wait on it
  } catch (err) {
    toast(`Dismiss failed: ${err instanceof Error ? err.message : String(err)}`);
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

/** Re-plan linked Todoist projects on every connected server; stream progress into the log. */
async function runAutopilot(): Promise<void> {
  const targets = orderedServers().filter((s) => s.sock.isOpen());
  if (!targets.length) {
    toast("No connected servers");
    return;
  }
  autopilotLog.length = 0;
  runState.running = true;
  runState.serversTotal = targets.length;
  runState.lastLine = "";
  runState.results = [];
  renderRunStatus();
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
    renderRunStatus();
    btn.disabled = false;
    btn.innerHTML = `${icon("play_arrow")} Run autopilot`;
  }
}

// ── Scheduled run (in-daemon timer; the control targets the hub) ────────────────────
// Surfaced in two places — the Autopilot view's bar and a card in Settings → Todoist — so changes
// made in either (or pushed from another device) refresh both.
function onAutopilotSchedule(url: string, schedule: AutopilotSchedule, nextRunAt?: string): void {
  serverSchedule.set(url, { schedule, nextRunAt });
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
  const auto = s.autoStart ? `auto-start ${s.maxAutoStart ?? 3}` : "plan only";
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
    <p class="small muted">An in-daemon timer re-plans the linked projects and (when auto-start is on) launches the new work. Review &amp; launch plans in the <b>Autopilot</b> section.</p>
  </div>`;
}

function openScheduleModal(): void {
  const cur = serverSchedule.get(HUB_URL)?.schedule;
  const s: AutopilotSchedule = cur ?? { enabled: false, timeOfDay: "02:00", autoStart: true, maxAutoStart: 3 };
  const days = s.days && s.days.length ? new Set(s.days) : new Set([0, 1, 2, 3, 4, 5, 6]);
  const dayBtns = DAY_LABEL.map(
    (d, i) => `<button type="button" class="ap-day${days.has(i) ? " on" : ""}" data-day="${i}">${d}</button>`,
  ).join("");
  const m = document.createElement("div");
  m.className = "modal";
  const toggle = (id: string, on: boolean, label: string): string =>
    `<button type="button" class="ap-toggle${on ? " on" : ""}" id="${id}" aria-pressed="${on}"><span class="ap-toggle-box">${icon("check")}</span><span>${label}</span></button>`;
  m.innerHTML = `<div class="modal-box ap-sched-modal" id="ap-sched-modal"><h3>${icon("schedule")} Scheduled autopilot run</h3>
    <p class="small muted">An in-daemon timer re-plans linked Todoist projects on the hub and (when auto-start is on) launches the new work. Times are the server's local time.</p>
    ${toggle("ap-enabled", s.enabled, "Enable scheduled run")}
    <div class="ap-sched-body" id="ap-sched-body">
      <label class="ap-field-row"><span>Time of day</span><input type="time" id="ap-time" value="${esc(s.timeOfDay)}" /></label>
      <div class="ap-field"><span>Days</span><div class="ap-days" id="ap-days">${dayBtns}</div></div>
      ${toggle("ap-autostart", s.autoStart, "Auto-start sessions for new plans")}
      <label class="ap-field-row"><span>Auto-start at most</span><input type="number" id="ap-cap" min="0" max="20" value="${s.maxAutoStart ?? 3}" /><span class="small muted">per run (the rest wait for manual launch; skipped while the budget is in its warn zone)</span></label>
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
  const maxAutoStart = Math.max(0, Number($<HTMLInputElement>("#ap-cap").value) || 0);
  const on = [...document.querySelectorAll<HTMLElement>("#ap-days .ap-day.on")].map((b) => Number(b.dataset.day));
  // all 7 selected → send [] (every day); none selected → keep it simple and treat as every day too
  const days = on.length === 0 || on.length === 7 ? [] : on.sort((a, b) => a - b);
  try {
    const res = await sendAwait(hub(), { type: "autopilot.schedule.set", enabled, timeOfDay, days, autoStart, maxAutoStart, cid: newCid() }, 20_000);
    if (res.type === "command.error") {
      toast(res.message);
      return;
    }
    closeModal();
    toast(enabled ? "Schedule saved" : "Scheduled run off");
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
      nativeBridge.postMessage(JSON.stringify({ type: "adb.connect" }));
    });
    $("#adb-pair").addEventListener("click", () => {
      const code = $<HTMLInputElement>("#adb-pair-code").value.trim();
      if (!/^\d{6}$/.test(code)) {
        setOut("Enter the 6-digit pairing code shown on the phone.");
        return;
      }
      setOut("Pairing… (keep the pairing dialog open on the phone)");
      nativeBridge.postMessage(JSON.stringify({ type: "adb.pair", code }));
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
      if (url && url !== HUB_URL && !servers.has(url)) {
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
      sel.innerHTML = `<option value="">Choose a Mac…</option>` + candidates.map((p) => `<option value="${esc(p.host)}">${esc(p.name)}</option>`).join("");
    }
  } catch {
    sel.innerHTML = `<option value="">Couldn't scan the tailnet</option>`;
  }
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
          <b><span class="env-dot" style="background:${stripeColor(e, 0, currentTheme())}"></span>${esc(e.name)}</b>
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
      const group = all.filter((e) => (envServer.get(e.id) ?? HUB_URL) === srv.url);
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
function selectSession(id: string, push = true): void {
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
  }
  renderSessions();
  const s = sessions.get(id);
  setHeaderTitle(s);
  applyActiveTint();
  snapshotLoaded.delete(id);
  // Opening a session is acting on it — clear its push reminder on this device immediately (the
  // daemon also clears it everywhere when we attach below). (UI refinement §1)
  navigator.serviceWorker?.controller?.postMessage({ type: "close-notifications", sessionId: id });
  sendTo(id, { type: "session.attach", sessionId: id }); // full snapshot (always show history)
  if (isNarrow() && !sidebarCollapsed) {
    sidebarCollapsed = true;
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
/** Put `id`'s saved draft into the composer (or clear it), and resize/enable Send to match. */
function restoreDraft(id: string | null): void {
  input.value = loadDraft(id);
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
  input.value = "";
  pendingAttachments.length = 0;
  renderAttachRow();
  autoGrow();
  updateSendState();
}
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $<HTMLFormElement>("#composer").requestSubmit();
  }
});
input.addEventListener("input", () => {
  autoGrow();
  updateSendState();
});
function autoGrow(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}
function updateSendState(): void {
  $<HTMLButtonElement>("#send").disabled = !input.value.trim() && pendingAttachments.length === 0;
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
  const ul = document.createElement("ul");
  ul.className = "file-list";
  if (filesPath) {
    const up = document.createElement("li");
    up.className = "dir";
    up.innerHTML = "📁 ..";
    up.onclick = () => requestFiles(filesPath.split("/").slice(0, -1).join("/"));
    ul.appendChild(up);
  }
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = e.isDir ? "dir" : "";
    li.innerHTML = `${e.isDir ? "📁" : "📄"} ${esc(e.name)}`;
    li.onclick = () => (e.isDir ? requestFiles(e.path) : openFile(e.path));
    ul.appendChild(li);
  }
  panelContent.innerHTML = "";
  panelContent.appendChild(ul);
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
  const popoutBtn = content.choices // a picker has nothing to pop out yet
    ? ""
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
      head + (content.mime.startsWith("image/") ? `<img src="${burl}" style="max-width:100%" />` : `<a href="${burl}" target="_blank">Open ${esc(content.path)}</a>`);
  }
  const back = document.getElementById("reader-back");
  if (back) back.onclick = (e) => { e.preventDefault(); openPanel("files"); };
  const popout = document.getElementById("reader-popout");
  if (popout) popout.onclick = () => popOutReader(content.path);
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
      `<style>body{margin:0;background:var(--bg);color:var(--text)}` +
      `.popout-wrap{max-width:880px;margin:0 auto;padding:28px clamp(16px,4vw,40px)}` +
      `.popout-head{font:600 12px/1.4 ui-monospace,Menlo,monospace;color:var(--muted);margin-bottom:16px;word-break:break-all}</style>` +
      `</head><body><div class="popout-wrap"><div class="popout-head">${esc(path)}</div>${clone.innerHTML}</div></body></html>`,
  );
  win.document.close();
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
/** Kill a session: disable it immediately and drop its conversation, while the daemon tears the
 *  worktree/branch down in the background. The row stays (greyed, "cleaning up…") until the
 *  daemon's session.deleted broadcast removes it for good — so cleanup never looks like it hung,
 *  and a failed/slow teardown can't leave a half-removed session behind. (UI refinement §8) */
function killSession(id: string): void {
  removingSessions.add(id);
  sendTo(id, { type: "session.kill", sessionId: id });
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
  el.innerHTML = esc(head + e.output).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
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
  if (overlayOpen("modal") || overlayOpen("settings") || overlayOpen("autopilot")) return; // a dialog/settings/autopilot is on top — leave the panel be
  const t = e.target as HTMLElement;
  if (t.closest("#side-panel") || t.closest("#header") || t.closest(".file-link") || t.closest("#quote-btn") || t.closest("#modal-root") || t.closest("#settings-root") || t.closest("#autopilot-root") || t.closest(".resizer")) return;
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
  $("#modal-root").innerHTML = "";
}
const closeModal = (): void => dismissOverlay("modal"); // programmatic close → unwind the back-stack
// Model is fixed to Opus (no picker). New sessions default to "bypass" (skip all permission
// prompts); the autonomy picker lets the user dial that back per session.
const DEFAULT_MODEL = "opus";
const DEFAULT_AUTONOMY: AutonomyPolicy = "bypass";
const AUTONOMY_PICKER = `<label>Autonomy<select id="ns-auto">
  <option value="bypass" selected>Bypass — skip all permission prompts ⚠️</option>
  <option value="mostly-autonomous">Mostly autonomous</option>
  <option value="allowlist">Allowlist</option>
  <option value="prompt-all">Prompt all</option>
</select></label>`;
/** The chosen autonomy from the open dialog's picker, or the default if it isn't present. */
const selectedAutonomy = (): AutonomyPolicy =>
  ((document.getElementById("ns-auto") as HTMLSelectElement | null)?.value as AutonomyPolicy) || DEFAULT_AUTONOMY;

/** A server picker for the browse-based modals (add-env, one-off). Hidden when there's one server. */
function serverPickerMarkup(): string {
  const list = orderedServers();
  if (list.length <= 1) return "";
  const opts = list.map((s) => `<option value="${esc(s.url)}">${esc(s.name)}</option>`).join("");
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
    const opt = (e: Environment): string => `<option value="${esc(e.id)}">${esc(e.name)}</option>`;
    const opts = multi
      ? orderedServers()
          .map((srv) => {
            const group = envs.filter((e) => (envServer.get(e.id) ?? HUB_URL) === srv.url);
            return group.length ? `<optgroup label="${esc(srv.name)}">${group.map(opt).join("")}</optgroup>` : "";
          })
          .join("")
      : envs.map(opt).join("");
    m.innerHTML = `<div class="modal-box" id="ns-modal"><h3>New session</h3>
      <label>Environment<div class="env-row"><select id="ns-env">${opts}</select></div></label>
      <label>Session name<input id="ns-name" placeholder="e.g. fix-login-bug" /></label>
      <p class="small muted" id="ns-note"></p>
      <p class="small warn-text" id="ns-warn"></p>
      ${AUTONOMY_PICKER}
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
    };
    const cmd = env.isRepo
      ? { type: "session.create" as const, source: "fresh-worktree", repoRoot: env.repoRoot, base: env.defaultBase ?? "HEAD", ...common }
      : { type: "session.create" as const, source: "existing-dir", cwd: env.repoRoot, ...common };
    const srv = serverOfEnv(env.id); // the session is created on the env's server
    if (srv.sock.isOpen()) {
      srv.sock.send(cmd);
    } else {
      createOfflineSession(cmd, env, name, srv.url);
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
    <p class="small muted">Or pick an existing local <b>git repository</b>:</p>
    ${browserMarkup()}
    <div class="btns"><button type="button" id="ae-back">Cancel</button><button type="button" id="ae-save" class="primary">Add</button></div></div>`;
  showModal(m);
  wireServerPicker();
  wireBrowser();
  wireSwatchPicker();
  $<HTMLButtonElement>("#ae-back").onclick = closeModal; // returns to Settings underneath
  $<HTMLButtonElement>("#ae-save").onclick = async () => {
    const url = $<HTMLInputElement>("#ae-url").value.trim();
    const name = $<HTMLInputElement>("#ae-name").value.trim();
    const defaultBase = $<HTMLInputElement>("#ae-base").value.trim();
    const color = selectedSwatch();
    if (url) {
      const btn = $<HTMLButtonElement>("#ae-save");
      btn.disabled = true;
      btn.textContent = "Cloning…";
      try {
        const res = await sendAwait(
          browseServer(),
          { type: "env.clone", url, ...(name ? { name } : {}), ...(defaultBase ? { defaultBase } : {}), ...(color ? { color } : {}), cid: newCid() },
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
    <label>Todoist project
      <select id="ee-todoist">${projectOptions}</select>
    </label>
    ${todoistConnected ? "" : `<p class="small muted">Connect Todoist (Settings → Todoist) to link a project.</p>`}
    <p class="small muted">repo: <code>${esc(env.repoRoot)}</code>${env.isRepo ? "" : " (not a git repo)"}</p>
    <div class="btns"><button type="button" class="danger" id="ee-remove">Remove</button><span class="spacer" style="flex:1"></span><button type="button" id="ee-back">Back</button><button type="button" id="ee-save">Save</button></div></div>`;
  showModal(m);
  wireSwatchPicker();
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
    <div class="btns"><button type="button" id="oo-back">Back</button><button type="button" id="oo-create">Open here</button></div></div>`;
  showModal(m);
  wireServerPicker();
  wireBrowser();
  $<HTMLButtonElement>("#oo-back").onclick = () => showNewSession();
  $<HTMLButtonElement>("#oo-create").onclick = () => {
    if (!browse.path) return;
    browseServer().sock.send({
      type: "session.create",
      source: "existing-dir",
      cwd: browse.path,
      model: DEFAULT_MODEL,
      autonomy: selectedAutonomy(),
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
    // "Other" free-text affordance — Enter submits it when this is the one-tap case.
    const other = document.createElement("input");
    other.type = "text";
    other.className = "q-other";
    other.placeholder = "Other… (type a custom answer)";
    if (oneTap) {
      other.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
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
  scrollDown();
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
    const notes = blocks[qi]?.querySelector<HTMLInputElement>(".q-other")?.value.trim() || undefined;
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
function toast(msg: string): void {
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
