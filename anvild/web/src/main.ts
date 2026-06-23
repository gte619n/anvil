import MarkdownIt from "markdown-it";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AnvilSocket } from "./ws";
import { apiFetch, apiUrl, wsUrl } from "./api";

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
  AutonomyPolicy,
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
type OverlayName = "modal" | "settings" | "panel" | "sidebar";
interface Overlay {
  name: OverlayName;
  close: () => void; // pure DOM/state teardown — must NOT touch history itself
}
const overlays: Overlay[] = [];
let suppressPop = 0; // popstates from our own dismissOverlay() unwind — teardown already done
const overlayOpen = (name: OverlayName): boolean => overlays.some((o) => o.name === name);
function openOverlay(name: OverlayName, close: () => void): void {
  if (overlayOpen(name)) return; // already open (e.g. swapping a modal's contents in place)
  overlays.push({ name, close });
  history.pushState({ anvilDepth: overlays.length }, ""); // keep the current URL (session hash)
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
let streaming: HTMLElement | null = null;
// State touched by the early "instant restore" init (renderEmptyState → resetActivity /
// clearReferences). It MUST be declared up here with the rest of the module state: the bundler
// keeps module-scope declarations in source order, so when this lived next to its functions further
// down it was still undefined when init ran, and `activityTail.length = 0` / `references.clear()`
// threw — killing the whole module load (blank, dead app whenever no session was restored, which is
// exactly the state of a fresh device / freshly reinstalled app). See renderEmptyState().
let activityEl: HTMLDetailsElement | null = null;
let activityCount = 0;
let activityLive = false;
const activityTail: string[] = [];
const ACTIVITY_TAIL = 5;
const references = new Map<string, string>(); // url → display label, insertion-ordered
const REF_LIMIT = 50;
let pendingAnswerRefs: string[] = []; // links in the latest assistant prose; promoted on `result`
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

// On a phone there isn't room for both panes, so when focus moves to the chat (a tap or the
// composer gaining focus) we collapse the overlaid session list — never a half-covered chat.
function collapseSidebarForChat(): void {
  if (!isNarrow() || sidebarCollapsed) return;
  if (overlayOpen("sidebar")) dismissOverlay("sidebar"); // also unwinds the Back-stack entry
  else { sidebarCollapsed = true; applySidebar(); } // open without an overlay entry (e.g. after a resize)
}
$("#convo-col").addEventListener("pointerdown", collapseSidebarForChat);
$("#convo-col").addEventListener("focusin", collapseSidebarForChat);

const sock = new AnvilSocket(wsUrl(), onEvent, onStatus);
// sock.connect() is called after the outbox state below is declared (onStatus reads it).

// ── Outbox: writes made offline are queued and flushed, in order, on reconnect (arch §8) ──────
interface OutboxItem {
  cid: string;
  cmd: Record<string, unknown> & { type: string };
  tempId?: string; // for session.create: the optimistic local session id to reconcile
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
function sendAwait(cmd: Record<string, unknown> & { type: string; cid: string }, timeoutMs = 20_000): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      cidWaiters.delete(cmd.cid);
      reject(new Error("timeout"));
    }, timeoutMs);
    cidWaiters.set(cmd.cid, (e) => {
      clearTimeout(t);
      resolve(e);
    });
    if (!sock.send(cmd)) {
      clearTimeout(t);
      cidWaiters.delete(cmd.cid);
      reject(new Error("offline"));
    }
  });
}
const tempMap = new Map<string, string>(); // optimistic id → real id
let flushing = false;
async function flushOutbox(): Promise<void> {
  if (flushing || !sock.isOpen()) return;
  flushing = true;
  let touchedActive = false;
  try {
    while (outbox.length && sock.isOpen()) {
      const item = outbox[0]!;
      const sid = item.cmd.sessionId as string | undefined;
      if (sid && tempMap.has(sid)) item.cmd.sessionId = tempMap.get(sid); // rewrite temp → real
      if (sid === activeId || item.cmd.sessionId === activeId) touchedActive = true;
      try {
        const res = await sendAwait({ ...item.cmd, cid: item.cid });
        if (res.type === "command.error") {
          toast(`Queued ${item.cmd.type} failed: ${res.message}`);
          if (item.tempId) failTemp(item.tempId);
        } else if (item.tempId && res.type === "session.created") {
          tempMap.set(item.tempId, res.session.id);
          reconcileTemp(item.tempId, res.session.id);
          if (activeId === res.session.id) touchedActive = true;
        }
      } catch {
        break; // disconnected/timeout mid-flush — retry on next connect
      }
      outbox.shift();
      saveOutbox();
    }
  } finally {
    flushing = false;
    updateOutboxBadge();
    // re-pull authoritative history for the active session so optimistic bubbles are replaced
    if (touchedActive && activeId && sock.isOpen()) {
      snapshotLoaded.delete(activeId);
      sock.send({ type: "session.attach", sessionId: activeId });
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
  const online = sock.isOpen();
  el.hidden = online && queued === 0;
  el.innerHTML = online
    ? `${icon("sync")} Syncing ${queued} queued change${queued === 1 ? "" : "s"}…`
    : `${icon("cloud_off")} Offline${queued ? ` · ${queued} change${queued === 1 ? "" : "s"} queued` : ""} <button id="offline-retry" class="mini">${icon("refresh")} Retry</button>`;
  const retry = document.getElementById("offline-retry");
  if (retry) retry.onclick = () => sock.connectNow();
}
sock.connect(); // start connecting now that the outbox state onStatus reads is initialized

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
  const out = document.getElementById("daemon-update-output");
  if (out) {
    out.hidden = false;
    out.textContent = text;
  }
}
function onStatus(status: "connecting" | "connected" | "disconnected"): void {
  const dot = $("#conn-dot");
  dot.className = `conn-dot ${status}`;
  dot.title = status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Disconnected";
  updateOutboxBadge();
  if (status === "connected") void flushOutbox(); // push anything queued while offline
  if (pendingRestartReload) {
    if (status === "disconnected") setUpdateStatus("Daemon is restarting…");
    else if (status === "connected") {
      pendingRestartReload = false;
      setUpdateStatus("Back online — reloading to load the new version…");
      setTimeout(() => location.reload(), 500); // fresh page → new web bundle
    }
  }
  // (re)attach happens in the session.list handler, which the daemon sends on every connect.
}

// ── Event routing ──────────────────────────────────────────────────────────────
function onEvent(e: ServerEvent): void {
  if ("seq" in e && "sessionId" in e && typeof e.seq === "number") seqStore.set(e.sessionId, e.seq);
  const cid = (e as { cid?: string }).cid;
  if (cid && cidWaiters.has(cid)) {
    cidWaiters.get(cid)!(e); // resolve an outbox flush awaiting this command's response
    cidWaiters.delete(cid);
  }

  switch (e.type) {
    case "session.list":
      // server is now the source of truth — drop optimistic/pending locals it doesn't know about
      for (const id of [...sessions.keys()]) if (!sessions.get(id)?.pending) sessions.delete(id);
      e.sessions.forEach((s) => sessions.set(s.id, s));
      // A removing session the server still lists is mid-teardown — keep it (shown disabled); one
      // it no longer lists is gone, so forget the removing flag.
      for (const id of [...removingSessions]) if (!sessions.has(id)) removingSessions.delete(id);
      persistSessions();
      renderSessions();
      if (activeId && sessions.has(activeId)) {
        setHeaderTitle(sessions.get(activeId));
        // first attach this page-load → full snapshot (DOM was reloaded); a later reconnect
        // (DOM intact) → resume only new events from the watermark.
        if (snapshotLoaded.has(activeId)) {
          sock.send({ type: "session.attach", sessionId: activeId, lastSeq: seqStore.get(activeId) });
        } else {
          sock.send({ type: "session.attach", sessionId: activeId });
        }
      } else if (activeId) {
        activeId = null; // the remembered session is gone
        localStorage.removeItem("anvil.active");
        clearConversation();
      }
      return;
    case "session.created":
      sessions.set(e.session.id, e.session);
      persistSessions();
      renderSessions();
      if (!activeId) selectSession(e.session.id);
      return;
    case "session.updated":
      sessions.set(e.session.id, e.session);
      persistSessions();
      renderSessions();
      if (e.session.id === activeId) updateGitPanelMeta();
      return;
    case "session.deleted":
      sessions.delete(e.sessionId);
      removingSessions.delete(e.sessionId); // cleanup finished — the row goes for good now
      localStorage.removeItem(`anvil.convo.${e.sessionId}`);
      persistSessions();
      if (activeId === e.sessionId) deselectSession();
      else renderSessions();
      return;
    case "budget":
      return; // rate-limit gauge is tracked server-side; the UI display is removed for now

    case "environments":
      onEnvironments(e.environments);
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
    case "question.request":
      showQuestion(e.requestId, e.questions);
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
    const href = apiUrl(`/api/sessions/${activeId}/attachments/${att.id}`);
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
let thinkingEl: HTMLElement | null = null;
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

// ── Consolidated activity block (§5) ─────────────────────────────────────────────
// All the tool/thinking churn for one turn collapses into a single block that previews the
// last few lines and expands on click — so the conversation reads as "what I said" / "what the
// model said" without every Read/Bash/result on its own line. Reset at each new user turn.
// (activityEl/activityCount/activityLive/activityTail/ACTIVITY_TAIL are declared with the module
// state near the top so they're initialized before early-init renderEmptyState() touches them.)

function resetActivity(): void {
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
// (references/REF_LIMIT/pendingAnswerRefs are declared with the module state near the top so
// they're initialized before early-init renderEmptyState() → clearReferences() touches them.)

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
  const href = apiUrl(file.downloadUrl);
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
  activeId = null;
  localStorage.removeItem("anvil.active");
  setSessionHash(null, false);
  setHeaderTitle(undefined);
  renderEmptyState();
  renderSessions();
  applyActiveTint();
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
  // Any non-awaiting status means a parked prompt was answered (here or elsewhere) or superseded —
  // retire any open permission/question cards so a stale one can't linger.
  if (status !== "awaiting_permission") clearPermissionCards();
  if (status !== "awaiting_question") clearQuestionCards();
  const awaiting = status === "awaiting_permission" || status === "awaiting_question";
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
  sock.send({ type: "interrupt", sessionId: activeId });
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
  if (press?.lifted) return; // don't yank a row out from under an in-progress drag
  const activeUl = $("#session-list");
  const finishedUl = $("#finished-list");
  activeUl.innerHTML = "";
  finishedUl.innerHTML = "";
  const ord = (s: Session): number => s.order ?? -1; // server sort key; unset (new) sessions sort to the top
  const items = [...sessions.values()].sort(
    (a, b) =>
      Number(!!b.isDefault) - Number(!!a.isDefault) || // the persistent concierge chat is always pinned first
      Number(!!a.archived) - Number(!!b.archived) ||
      ord(a) - ord(b),
  );
  let anyFinished = false;
  for (const s of items) {
    if (s.finished) anyFinished = true;
    (s.finished ? finishedUl : activeUl).appendChild(renderSessionItem(s));
  }
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
  const a = document.createElement("a");
  a.className = "srow";
  a.href = sessionHref(s.id);
  const merged = s.git?.prState === "merged" ? `<span class="merged-badge" title="PR merged">${icon("merge")}</span>` : "";
  a.innerHTML = `<div class="title">${icon(removing ? "cleaning_services" : sessIcon(s))}<span class="t">${esc(s.title)}</span>${merged}</div><div class="meta">${esc(where)} · ${tag} · ${esc(s.model)}</div>`;
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a new tab
    e.preventDefault();
    if (justDragged) return; // a drag just ended on this row — don't also navigate
    if (!removing) selectSession(s.id); // a session being cleaned up isn't selectable
  });
  li.append(a);
  if (!removing) {
    // The concierge is pinned and can't be reordered or moved to Finished, so it isn't draggable.
    if (!s.isDefault) li.addEventListener("pointerdown", (e) => startSessionPress(e, li)); // press-and-hold → reorder
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

// ── Long-press to reorder (touch + mouse) ───────────────────────────────────────────────────────
// Press-and-hold a session row to pick it up, drag it (into the Finished group or a new spot), and
// drop on release. No drag handle — Android read the handle's long-press as text selection — and
// rows disable user-select in CSS so the lift is clean. Server-synced via session.arrange.
const LONG_PRESS_MS = 420;
const PRESS_MOVE_CANCEL = 10; // px of movement before the hold completes ⇒ it's a scroll/tap, not a lift
let press: { el: HTMLElement; pointerId: number; x: number; y: number; timer: number; lifted: boolean } | null = null;
let justDragged = false; // set briefly after a drop so the row's click doesn't also navigate

function startSessionPress(e: PointerEvent, el: HTMLElement): void {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if ((e.target as HTMLElement).closest(".row-btn")) return; // let row buttons handle their own taps
  endPress(false); // clear any stale press
  press = { el, pointerId: e.pointerId, x: e.clientX, y: e.clientY, timer: 0, lifted: false };
  press.timer = window.setTimeout(liftPress, LONG_PRESS_MS);
  window.addEventListener("pointermove", onPressMove);
  window.addEventListener("pointerup", onPressUp);
  window.addEventListener("pointercancel", onPressUp);
}
function liftPress(): void {
  if (!press) return;
  press.lifted = true;
  press.el.classList.add("dragging");
  $("#finished-section").hidden = false; // reveal the (possibly empty) drop target
  try {
    press.el.setPointerCapture(press.pointerId); // keep events even when the finger leaves the row
  } catch {
    /* capture unsupported — still works via the window listeners */
  }
  navigator.vibrate?.(12); // a little "picked up" haptic where supported
}
function onPressMove(e: PointerEvent): void {
  if (!press || e.pointerId !== press.pointerId) return;
  if (!press.lifted) {
    // moved before the hold completed → it's a scroll or sloppy tap; abandon the pending lift
    if (Math.abs(e.clientY - press.y) > PRESS_MOVE_CANCEL || Math.abs(e.clientX - press.x) > PRESS_MOVE_CANCEL) endPress(false);
    return;
  }
  e.preventDefault(); // we own the gesture now
  const finishedUl = $("#finished-list");
  const overFinished = e.clientY >= $("#finished-section").getBoundingClientRect().top;
  finishedUl.classList.toggle("drag-over", overFinished);
  const list = overFinished ? finishedUl : $("#session-list");
  const after = dragAfter(list, e.clientY);
  if (after === null) list.appendChild(press.el);
  else if (after !== press.el) list.insertBefore(press.el, after);
}
function onPressUp(e: PointerEvent): void {
  if (!press || e.pointerId !== press.pointerId) return;
  endPress(press.lifted); // commit iff we actually lifted
}
/** Tear down the press; `commit` true → persist the dropped order, false → restore from state. */
function endPress(commit: boolean): void {
  if (!press) return;
  clearTimeout(press.timer);
  press.el.classList.remove("dragging");
  $("#finished-list").classList.remove("drag-over");
  window.removeEventListener("pointermove", onPressMove);
  window.removeEventListener("pointerup", onPressUp);
  window.removeEventListener("pointercancel", onPressUp);
  const lifted = press.lifted;
  press = null;
  if (lifted && commit) {
    commitOrderFromDom();
    justDragged = true;
    setTimeout(() => (justDragged = false), 0); // swallow the trailing click on the dropped row
  } else if (lifted) {
    renderSessions(); // cancelled mid-drag → restore positions from state
  }
}
/** The row to insert the dragged element before for pointer Y — or null to append. */
function dragAfter(container: HTMLElement, y: number): HTMLElement | null {
  let best: { off: number; el: HTMLElement | null } = { off: -Infinity, el: null };
  for (const el of container.querySelectorAll<HTMLElement>(".session:not(.dragging)")) {
    const box = el.getBoundingClientRect();
    const off = y - box.top - box.height / 2; // negative ⇒ pointer is above this row's middle
    if (off < 0 && off > best.off) best = { off, el };
  }
  return best.el;
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
  sock.send({ type: "session.arrange", order, finished }); // dropped if offline; server resyncs on reconnect
  renderSessions();
}
function setHeaderTitle(s: Session | undefined): void {
  $("#header-title").innerHTML = s ? `${icon(sessIcon(s))}<span class="ht">${esc(s.title)}</span>` : `<span class="ht">Anvil</span>`;
  document.title = s ? `Anvil: ${s.title}` : "Anvil";
  $("#btn-new-topic").hidden = !s?.isDefault; // "New topic" only applies to the persistent concierge chat
  void setFavicon(s);
}

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
function onEnvironments(list: Environment[]): void {
  environments.clear();
  for (const e of list) environments.set(e.id, e);
  persistEnvironments();
  renderSessions();
  applyActiveTint();
  if (document.getElementById("ns-modal")) showNewSession(); // refresh an open new-session modal
  if (document.getElementById("env-cards")) renderEnvCards(); // refresh an open settings view
}

// ── Settings & servers (first-class management area) ──────────────────────────────
let settingsTab: "servers" | "environments" = "servers";
function openSettings(): void {
  const root = $("#settings-root");
  root.innerHTML = `<div class="settings-view">
    <div class="settings-head">
      <h2>${icon("tune")} Settings &amp; servers</h2>
      <button id="settings-close" class="icon-btn" title="Close">${icon("close")}</button>
    </div>
    <div class="settings-tabs" role="tablist">
      <button class="stab" data-tab="servers">${icon("dns")} Servers</button>
      <button class="stab" data-tab="environments">${icon("folder")} Environments</button>
    </div>
    <div class="settings-body">
      <section class="settings-panel" data-tab="servers">
        <div id="server-cards"><p class="small muted">Loading…</p></div>
      </section>
      <section class="settings-panel" data-tab="environments">
        <div class="section-head"><h3>Environments</h3><button id="set-add-env" class="primary">${icon("add")} Add repo</button></div>
        <p class="small muted">Environments are git repositories. A new session branches a fresh worktree off one.</p>
        <div id="env-cards"></div>
      </section>
    </div>
  </div>`;
  $("#settings-close").addEventListener("click", () => dismissOverlay("settings"));
  $("#set-add-env").addEventListener("click", () => showAddEnvironment());
  root.querySelectorAll<HTMLElement>(".stab").forEach((t) =>
    t.addEventListener("click", () => selectSettingsTab(t.dataset.tab as "servers" | "environments")),
  );
  selectSettingsTab(settingsTab);
  openOverlay("settings", closeSettings); // Back closes Settings (no-op if it's already a layer)
  renderServerCards();
  renderEnvCards();
}
function selectSettingsTab(tab: "servers" | "environments"): void {
  settingsTab = tab;
  document.querySelectorAll<HTMLElement>(".settings-view .stab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>(".settings-view .settings-panel").forEach((p) => (p.hidden = p.dataset.tab !== tab));
}
/** Tear down the settings view (DOM only). Reached via Back (popstate) or dismissOverlay. */
function closeSettings(): void {
  $("#settings-root").innerHTML = "";
}
async function renderServerCards(): Promise<void> {
  const host = $("#server-cards");
  try {
    const h = (await (await apiFetch("/api/health")).json()) as { serverName?: string; version?: string };
    const daemonHost = new URL(apiUrl("/")).host;
    host.innerHTML = `<div class="card server-card">
      <div class="card-main"><span class="conn-dot connected"></span><b>${esc(h.serverName ?? daemonHost)}</b> <span class="small muted">(this server)</span></div>
      <div class="small muted"><code>${esc(daemonHost)}</code> · anvild ${esc(h.version ?? "?")}</div>
      <div class="git-row" style="margin-top:10px"><button id="daemon-update">${icon("refresh")} Update Anvil</button></div>
      <pre class="git-output" id="daemon-update-output" hidden></pre>
    </div>
    <p class="small muted">Multi-server (managing anvild on your other Macs from here) is on the roadmap — see the fleet design.</p>`;
    wireDaemonUpdate();
  } catch {
    host.innerHTML = `<p class="small muted">Couldn't reach the server.</p>`;
  }
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
        <input id="adb-pair-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" style="max-width:140px" />
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
/** Wire the "Update Anvil" button: pull the daemon's source, rebuild, and restart it. */
function wireDaemonUpdate(): void {
  const btn = document.getElementById("daemon-update") as HTMLButtonElement | null;
  const out = document.getElementById("daemon-update-output");
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
      const res = await sendAwait({ type: "daemon.update", cid: newCid() }, 180_000);
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
        toast(`Anvil is already up to date (v${res.currentVersion}).`);
        reset();
      } else if (res.phase === "error") {
        toast("Update failed — see Settings.");
        reset();
      } else if (res.willRestart) {
        // The daemon restarts momentarily; keep the button spinning and let onStatus reload the
        // app once the WS reconnects (that's the proof it's back). Safety net if it never returns.
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
      } else {
        // updated but this daemon isn't service-managed, so it won't self-restart
        toast("Anvil updated — restart the daemon to apply.");
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
  const envs = [...environments.values()];
  if (envs.length === 0) {
    host.innerHTML = `<p class="small muted">No environments yet. Add a git repo to get started.</p>`;
    return;
  }
  host.innerHTML = envs
    .map(
      (e) => `<div class="card env-card" data-env="${esc(e.id)}">
      <div class="env-head">
        <div class="env-meta">
          <b><span class="env-dot" style="background:${stripeColor(e, 0, currentTheme())}"></span>${esc(e.name)}</b>
          <div class="small muted"><code>${esc(e.repoRoot)}</code></div>
          <div class="small muted">${icon("account_tree")} off <code>${esc(e.defaultBase ?? "HEAD")}</code></div>
        </div>
        <div class="env-actions">
          <button class="mini env-readme" data-env="${esc(e.id)}">${icon("description")} README</button>
          <button class="mini env-edit" data-env="${esc(e.id)}">${icon("edit")} Edit</button>
        </div>
      </div>
      <div class="env-readme-body" id="readme-${esc(e.id)}" hidden></div>
    </div>`,
    )
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
    const r = (await (await apiFetch(`/api/environments/${encodeURIComponent(id)}/readme`)).json()) as { markdown?: { html: string }; text?: string; missing?: boolean };
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
  // On a phone, picking a session collapses the open sidebar. Consume its back-stack entry for
  // the session (replace, don't push) so Back stays balanced.
  let reuseSidebarEntry = false;
  if (push && isNarrow() && overlayOpen("sidebar")) {
    overlays.pop(); // drop the sidebar layer; the collapse happens below
    reuseSidebarEntry = true;
  }
  activeId = id;
  localStorage.setItem("anvil.active", id);
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
  sock.send({ type: "session.attach", sessionId: id }); // full snapshot (always show history)
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
  if (sock.isOpen() && !s?.pending) {
    sock.send({ type: "prompt.send", sessionId: activeId, text, attachmentIds: pendingAttachments.map((a) => a.id) });
  } else {
    // offline, or a session that itself hasn't been created yet → queue + show optimistically
    if (pendingAttachments.length) toast("Attachments need a connection — sent text only");
    enqueue({ cid: newCid(), cmd: { type: "prompt.send", sessionId: activeId, text } });
    appendOptimisticUser(text);
  }
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
    const res = await apiFetch(`/api/sessions/${activeId}/attachments`, {
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
let panelView: "files" | "reader" | "git" | "terminal" | "links" | null = null;
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
  if (readerWatch && activeId) sock.send({ type: "fs.unwatch", sessionId: activeId, path: readerWatch });
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
    if (activeId) sock.send({ type: "terminal.input", sessionId: activeId, data: strToB64(d) });
  });
  if (activeId) sock.send({ type: "terminal.open", sessionId: activeId, cols: xterm.cols, rows: xterm.rows });
  termObs = new ResizeObserver(() => {
    if (fit && xterm && activeId) {
      fit.fit();
      sock.send({ type: "terminal.resize", sessionId: activeId, cols: xterm.cols, rows: xterm.rows });
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
  sock.send({ type: "fs.list", sessionId: activeId, path });
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
  if (readerWatch && readerWatch !== path) sock.send({ type: "fs.unwatch", sessionId: activeId, path: readerWatch });
  sock.send({ type: "fs.read", sessionId: activeId, path });
  sock.send({ type: "fs.watch", sessionId: activeId, path });
  readerWatch = path;
  panelContent.innerHTML = `<p class="muted small">Loading ${esc(path)}…</p>`;
}
function renderReader(content: FileContent): void {
  if (content.path !== readerPath) return;
  panelView = "reader";
  setPanelTabs();
  const head = `<div class="reader-head"><b>${esc(content.path)}</b><a href="#" id="reader-back">← files</a></div>`;
  if (content.markdown) {
    panelContent.innerHTML = head + `<div class="md reader-md">${content.markdown.html}</div>`;
    void runMermaid(panelContent.querySelector(".reader-md") as HTMLElement);
  } else if (content.text !== undefined) {
    panelContent.innerHTML = head + `<pre class="reader-text">${esc(content.text)}</pre>` + (content.truncated ? '<p class="muted small">(truncated)</p>' : "");
  } else if (content.binaryUrl) {
    const burl = apiUrl(content.binaryUrl); // daemon-relative → absolute (bundled native shells)
    panelContent.innerHTML =
      head + (content.mime.startsWith("image/") ? `<img src="${burl}" style="max-width:100%" />` : `<a href="${burl}" target="_blank">Open ${esc(content.path)}</a>`);
  }
  const back = document.getElementById("reader-back");
  if (back) back.onclick = (e) => { e.preventDefault(); openPanel("files"); };
}
// ── Git panel ──────────────────────────────────────────────────────────────────
function askClaude(instruction: string): void {
  if (!activeId) return;
  sock.send({ type: "prompt.send", sessionId: activeId, text: instruction });
  toast("Asked Claude →");
  closePanel(); // jump to the conversation to watch it work
}
type Stage = "commit" | "push" | "pr" | "merge";
// Each stage tells Claude to do EVERYTHING up to and including that stage.
const STAGE_PROMPT: Record<Stage, string> = {
  commit: "In this worktree, stage and commit all current changes with a clear, conventional commit message based on what changed. If there's nothing to commit, say so.",
  push: "In this worktree: commit all current changes with a clear conventional message (if any are uncommitted), then push the branch to its origin remote (set the upstream with -u if needed).",
  pr: "In this worktree, take the branch to an open PR: commit any uncommitted changes (good conventional message), push to origin, then create a GitHub pull request with the gh CLI (concise title + summary) if one doesn't already exist. Give me the PR URL.",
  merge: "In this worktree, take the branch all the way to merged: commit any uncommitted changes (good message), push to origin, create a GitHub PR with gh if none exists, then merge it into the repo's default branch with `gh pr merge --squash --delete-branch`. Report each step and confirm when it's merged.",
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
  if (activeId) sock.send({ type: "git", sessionId: activeId, op: "status" });
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
    sock.send({ type: "git", sessionId: activeId, op: "diff" });
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
  sock.send({ type: "prompt.send", sessionId: activeId, text: STAGE_PROMPT[key] });
  toast(`${label} →`);
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
    sock.send({ type: "session.reset", sessionId: id });
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
  sock.send({ type: "session.kill", sessionId: id });
  localStorage.removeItem(`anvil.convo.${id}`);
  if (panelView) closePanel();
  if (activeId === id) {
    // Drop the conversation now, but keep the (disabled) sidebar entry until it's actually gone.
    activeId = null;
    localStorage.removeItem("anvil.active");
    setSessionHash(null, false);
    setHeaderTitle(undefined);
    renderEmptyState();
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

$("#btn-new-topic").addEventListener("click", () => {
  if (!activeId) return;
  if (!confirm("Start a new topic? Claude forgets the earlier context but the visible history stays.")) return;
  sock.send({ type: "session.new_topic", sessionId: activeId, cid: newCid() });
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
  if (overlayOpen("modal") || overlayOpen("settings")) return; // a dialog/settings is on top — leave the panel be
  const t = e.target as HTMLElement;
  if (t.closest("#side-panel") || t.closest("#header") || t.closest(".file-link") || t.closest("#quote-btn") || t.closest("#modal-root") || t.closest("#settings-root")) return;
  closePanel();
});

// ── Modals ─────────────────────────────────────────────────────────────────────
let onDirs: ((e: DirsListResultEvent) => void) | null = null;
const browse = { path: "", parent: undefined as string | undefined };

$("#new-session").addEventListener("click", showNewSession);
$("#open-settings").addEventListener("click", openSettings);

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
      li.onclick = () => sock.send({ type: "dirs.list", path: d.path });
      ul.appendChild(li);
    }
  };
  $<HTMLButtonElement>("#ns-up").onclick = () => {
    if (browse.parent) sock.send({ type: "dirs.list", path: browse.parent });
  };
  sock.send({ type: "dirs.list" });
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
    const opts = envs.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join("");
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
    if (sock.isOpen()) {
      sock.send(cmd);
    } else {
      createOfflineSession(cmd, env, name);
    }
    closeModal();
  });
}

/** Create a session while offline: show an optimistic "pending" session now, realize it on reconnect. */
function createOfflineSession(cmd: Record<string, unknown> & { type: string }, env: Environment, name: string): void {
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
  persistSessions();
  enqueue({ cid: newCid(), cmd, tempId });
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
    <label>Clone from URL<input id="ae-url" placeholder="e.g. git@github.com:owner/repo.git" /></label>
    <p class="small muted">Cloned into <code>~/Development/&lt;repo&gt;</code> using this machine's git/SSH credentials. Leave blank to use an existing local repo instead.</p>
    <label>Name (optional)<input id="ae-name" placeholder="defaults to the repo name" /></label>
    <label>Default branch (optional)<input id="ae-base" placeholder="e.g. main or dev — leave blank for HEAD" /></label>
    ${swatchPickerMarkup()}
    <p class="small muted">Or pick an existing local <b>git repository</b>:</p>
    ${browserMarkup()}
    <div class="btns"><button type="button" id="ae-back">Cancel</button><button type="button" id="ae-save" class="primary">Add</button></div></div>`;
  showModal(m);
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
    sock.send({
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
  m.innerHTML = `<div class="modal-box"><h3>Edit environment</h3>
    <label>Name<input id="ee-name" value="${esc(env.name)}" /></label>
    <label>Default branch<input id="ee-base" value="${esc(env.defaultBase ?? "")}" placeholder="e.g. main or dev — blank for HEAD" /></label>
    ${swatchPickerMarkup(env.color)}
    <p class="small muted">repo: <code>${esc(env.repoRoot)}</code>${env.isRepo ? "" : " (not a git repo)"}</p>
    <div class="btns"><button type="button" class="danger" id="ee-remove">Remove</button><span class="spacer" style="flex:1"></span><button type="button" id="ee-back">Back</button><button type="button" id="ee-save">Save</button></div></div>`;
  showModal(m);
  wireSwatchPicker();
  $<HTMLButtonElement>("#ee-back").onclick = closeModal;
  $<HTMLButtonElement>("#ee-save").onclick = () => {
    sock.send({ type: "env.update", id, name: $<HTMLInputElement>("#ee-name").value, defaultBase: $<HTMLInputElement>("#ee-base").value, color: selectedSwatch() });
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
      sock.send({ type: "env.remove", id });
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
    ${browserMarkup()}
    ${AUTONOMY_PICKER}
    <div class="btns"><button type="button" id="oo-back">Back</button><button type="button" id="oo-create">Open here</button></div></div>`;
  showModal(m);
  wireBrowser();
  $<HTMLButtonElement>("#oo-back").onclick = () => showNewSession();
  $<HTMLButtonElement>("#oo-create").onclick = () => {
    if (!browse.path) return;
    sock.send({
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
      sock.send({ type: "permission.respond", requestId, decision: s.decision });
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
    sock.send({ type: "question.respond", requestId, answers });
    resolveQuestionUI(requestId, summarizeAnswers(answers));
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
    sock.send({ type: "question.respond", requestId, answers: [], cancelled: true });
    resolveQuestionUI(requestId, "Skipped");
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

/** Mark a question card answered: lock its inputs, show the choice, then fade it out. */
function resolveQuestionUI(requestId: string, label?: string): void {
  const card = questionCards.get(requestId);
  if (!card) return;
  questionCards.delete(requestId);
  card.classList.add("resolved");
  card.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((el) => (el.disabled = true));
  const btns = card.querySelector(".q-btns");
  if (btns && label) btns.innerHTML = `<span class="q-done">${icon("check")} ${esc(label)}</span>`;
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
    const done = (v: boolean): void => {
      closeModal();
      resolve(v);
    };
    $<HTMLButtonElement>("#cd-ok").onclick = () => done(true);
    $<HTMLButtonElement>("#cd-cancel").onclick = () => done(false);
    m.addEventListener("click", (e) => {
      if (e.target === m) done(false); // click backdrop to cancel
    });
  });
}
