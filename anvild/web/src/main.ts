import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { apiFetch, sameServerUrl } from "./api";
import {
  HUB_URL,
  anyOpen,
  confirmRemoveServer,
  cssId,
  ensureOwningServer,
  ensureServer,
  envServer,
  fleetMemberAccountsRev,
  fleetMemberIdByHost,
  hostOf,
  hostnameOf,
  hub,
  initFleet,
  loadExtraServers,
  loadFleetMembers,
  maybeRenderAdoptHubCard,
  maybeRenderRepairCard,
  orderedServers,
  pendingTeamPlans,
  persistRouting,
  rehydrateFleetRollout,
  rosterServer,
  rotateFleetToken,
  sendTo,
  serverApiUrl,
  serverFetch,
  serverOf,
  serverOfEnv,
  serverSupports,
  serverTeams,
  servers,
  sessionServer,
  showAddMac,
  startFleetUpdate,
  wireDaemonUpdate,
  type Server,
} from "./fleet";
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
import { initSetupTakeover, refreshSetupState } from "./setup";
import { applySidebar, collapseSidebarForChat, initResizers, isNarrow, toggleSidebar } from "./layout";
// The sidebar seam (session list + team board + drag-to-reorder + favicon) lives in sidebar.ts (P7
// decomposition). Importing it here makes its module body — including the sidebar-owned early-init
// scalars — evaluate before this one, preserving the declare-up-top guarantee for the instant-restore
// render below. Its deps are injected via initSidebar(...) next to initFleet(...).
import { flushRenderSessions, initSidebar, initSortables, removingSessions, renderSessions, renderTeamBoard, setFavicon } from "./sidebar";
// The conversation seam (pane rendering, turn activity, links model, stop, copy/download
// actions, mermaid) lives in conversation.ts (P7 decomposition). Importing it here makes its
// module body — including the conversation-owned early-init scalars — evaluate before this one,
// preserving the declare-up-top guarantee for the instant-restore render below. Its deps are
// injected via initConversation(...) just before the instant restore.
import {
  appendDelta,
  appendFileOffer,
  appendOptimisticUser,
  appendToolResult,
  appendUser,
  armAttachDiagnostic,
  clearAttachDiagnostic,
  clearConversation,
  commitAnswerRefs,
  commitAssistant,
  conversation,
  copyText,
  dropSessionHero,
  finalizeActivity,
  hideThinking,
  humanSize,
  initConversation,
  maybeShowSessionHero,
  references,
  relTime,
  renderEmptyState,
  runMermaid,
  scrollDown,
  showThinking,
  streamMd,
  updateComposerMode,
} from "./conversation";
// The autopilot seam (plan grid/reader, run log + status, badge, schedule controls) lives in
// autopilot.ts (P7 decomposition). Importing it here makes its module body — including the
// run-log/schedule scalars a cold plan deep link reaches (`serverSchedule`/`autopilotLog`/`runState`,
// the historical [WEB2-1] TDZ set) — evaluate before this one, so those entry points can never hit a
// temporal dead zone again. Its deps are injected via initAutopilot(...) next to initFleet(...).
import {
  clearStaleRunTimer,
  initAutopilot,
  onAutopilotPlans,
  onAutopilotProgress,
  onAutopilotRunSnapshot,
  onAutopilotSchedule,
  openAutopilot,
  openPlanDeepLink,
  openScheduleModal,
  reflectAutopilotRunning,
  scheduleSettingsCardHtml,
  serverSchedule,
  updateAutopilotBadge,
} from "./autopilot";

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
import { GOAL_MAX_ITERATIONS, MODELS, modelLabel, type Model } from "../../protocol";
import type {
  AccountInfo,
  AttachmentRef,
  AuthAccountsEvent,
  AuthStatusEvent,
  PipelineAdversaryStat,
  AutonomyPolicy,
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
  TodoistProjectInfo,
  rest,
} from "../../protocol";
import { PALETTE, envOrdinal, sessionBg, stripeColor } from "./sessionColor";
import { OutboxQueue, newCid, type OutboxItem } from "./outbox";
import { telemetry } from "./telemetry";
import { canDeltaResume } from "./resume";
import { convoCache, migrateLegacyConvoCache } from "./convoCache";
import { isDaemonHandledCommand } from "./sendReconcile";

// App version, replaced at build time (native: the APK versionName; PWA: package.json version).
declare const __APP_VERSION__: string;

// Show the build version next to the brand so it's obvious which app/bundle is running.
$("#brand-version").textContent = `v${__APP_VERSION__}`;

// The conversation pane element, the scroll lock (`ui.stickToBottom` + scrollDown), and all
// conversation rendering live in conversation.ts (P7 decomposition) — imported above.

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
// Live model-tier labels the hub resolves from the Models API (e.g. "Opus 5"). Seeded from a
// localStorage cache so the picker paints the latest labels instantly, then overwritten by the hub's
// `model.labels` broadcast. A partial map — tiers absent here fall back to the static MODELS label.
const MODEL_LABELS_CACHE_KEY = "anvil.model-labels.cache";
let modelLabelOverrides: Partial<Record<Model, string>> = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(MODEL_LABELS_CACHE_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Partial<Record<Model, string>>) : {};
  } catch {
    return {};
  }
})();
/** The label to show for a model tier: the hub's live label if it has one, else the static fallback. */
const modelLabelOf = (m: Model): string => modelLabelOverrides[m] ?? modelLabel(m);
// Sessions being cleaned up (`removingSessions`) now lives in sidebar.ts (it's sidebar row state);
// the cleanup flow below mutates the imported Set in place.

// The sidebar order and "Finished" group live on the session itself (server-synced fields
// `order`/`finished`), so the arrangement follows you across every client — web, desktop, Android.

// ── Early-init module state (declare-up-top rule) ────────────────────────────────────────────────
// Everything reachable from the top-level "instant restore" init chain below (renderSessions /
// applyActiveTint / renderEmptyState) MUST be declared HERE, above that block. A `let`/`const`
// placed next to its functions further down the file is still in its temporal dead zone when init
// runs at module load, so touching it throws and aborts the rest of module init → a totally dead
// app (no list, no buttons). Bites worst on the no-activeId path (fresh device / reinstalled
// Android, empty localStorage). See memory: web-early-init-decl-order-crash.
// (`dragging`/`justDragged` live in sidebar.ts, and the conversation-owned scalars —
// `thinkingEl`/`activity*`/`references`/`pendingAnswerRefs` — live in conversation.ts, each with
// the code that owns them; both modules are imported above, so they still initialize before this
// module's body runs.)
let panelView: "files" | "reader" | "git" | "terminal" | "links" | null = null; // open side panel, if any

// ── Multi-server connection layer (fleet — anvil-multi-server.md §4) ──────────────────────
// The whole layer now lives in fleet.ts (P7 decomposition) — the Server registry, the per-server
// AnvilSocket management, and the outbound routing maps, plus the Settings → Fleet admin UI. Because
// fleet.ts is imported above, its module body evaluates BEFORE this one, which preserves the old
// declare-up-top guarantee: the instant-restore render below calls orderedServers() → reads
// `servers`/`HUB_URL` and both are already initialized (see memory: web-early-init-decl-order-crash).
// Sockets still connect below, after the outbox state onStatus reads is initialized. Everything fleet
// code needs from this module is injected here, before any socket exists; the function references are
// hoisted declarations or autopilot.ts imports (initialized at its module eval, above), and the
// late-declared `closeModal` const is wrapped in an arrow so it's only read at call time (never
// during module init → no TDZ).
initFleet({
  onEvent,
  onStatus,
  sessions,
  environments,
  clearStaleRunTimer,
  deleteServerSchedule: (url) => serverSchedule.delete(url),
  reflectAutopilotRunning,
  updateAutopilotBadge,
  persistSessions,
  persistEnvironments,
  renderSessions,
  renderServerCards,
  toast,
  showModal,
  closeModal: () => closeModal(),
  confirmDialog,
  sendAwait,
  setUpdateStatus,
});
// Sidebar deps (P7 — see sidebar.ts). Same timing contract as initFleet above: this runs during
// module init, BEFORE the instant-restore renderSessions() call below, so every sidebar entry point
// sees its deps assigned. `activeId` is a reassigned scalar declared further down (module init
// reaches its declaration before the first render call), so it's injected as a lazy read — the
// arrow only dereferences it at render time, never during this call (no TDZ).
initSidebar({
  sessions,
  environments,
  activeId: () => activeId,
  selectSession,
  persistSessions,
});
// Autopilot deps (P7 — see autopilot.ts). Same timing contract as initFleet/initSidebar above: this
// runs during module init, BEFORE any socket connects, the hash routing fires, or the deep-link
// microtask below runs — so every autopilot entry point sees its deps assigned. The function
// references are hoisted declarations; the late-declared `closeModal` const is wrapped in an arrow
// so it's only read at call time (never during module init → no TDZ).
initAutopilot({
  sessions,
  environments,
  sendAwait,
  toast,
  showModal,
  closeModal: () => closeModal(),
  confirmDialog,
  confirmDialogWithOption,
  pickListDialog,
  selectSession,
  renderTodoistPanel,
});
/** The server that owns the currently-open session (stays here: `activeId` is main's own state). */
function activeServer(): Server {
  return serverOf(activeId) ?? hub();
}

// Offline cache (arch §8): persist the session + environment lists so they're browsable with no
// connection. Hydrated synchronously below, kept in sync on every change.
// [WEB2-14] Persisting the whole session list stringified every session on every session.updated/status
// churn (several times per turn). Debounced 1s-trailing; flushed on tab-hide/pagehide so a close never
// loses the latest state. persistSessionsNow is the immediate writer (used by the flush + any caller
// that needs a synchronous write).
function persistSessionsNow(): void {
  safeLocalSet("anvil.sessions", JSON.stringify([...sessions.values()]));
}
let persistSessionsTimer = 0;
function persistSessions(): void {
  if (persistSessionsTimer || typeof window === "undefined") {
    if (typeof window === "undefined") persistSessionsNow();
    return;
  }
  persistSessionsTimer = window.setTimeout(() => {
    persistSessionsTimer = 0;
    persistSessionsNow();
  }, 1000);
}
function flushPersistSessions(): void {
  if (persistSessionsTimer) {
    clearTimeout(persistSessionsTimer);
    persistSessionsTimer = 0;
  }
  persistSessionsNow();
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersistSessions();
  });
  window.addEventListener("pagehide", flushPersistSessions);
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
// [WEB2-11] Boot sweep: reclaim per-session state (seq/epoch/history + cached transcripts) orphaned by
// sessions deleted while we were away — the accumulation that eventually hits the storage quota. Only
// the re-derivable keys are swept (never anvil.draft.*, which holds unsent text); and only when the
// hydrated session list is non-empty, so a corrupt/empty cache can't trigger a wholesale wipe.
(function sweepOrphanedConvoState() {
  if (typeof localStorage === "undefined" || sessions.size === 0) return;
  try {
    const known = new Set(sessions.keys());
    const prefixes = ["anvil.seq.", "anvil.epoch.", "anvil.history."];
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      const p = prefixes.find((px) => k.startsWith(px));
      if (p && !known.has(k.slice(p.length))) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
    for (const id of convoCache.keys()) if (!known.has(id)) void convoCache.delete(id);
  } catch {
    /* best-effort — quota reclamation must never block boot */
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
// `ui.streaming` / `ui.turnCanceled` (state.ts): reassigned by both this module and
// conversation.ts, so they live on the shared `ui` object (imported bindings are read-only).
const snapshotLoaded = new Set<string>(); // sessions with a full snapshot loaded this page-load

// [WEB2-10] localStorage.setItem can throw synchronously (QuotaExceededError on a full device — the
// 3.0.33 freeze class). Route EVERY persistence call through this so one throw can never escape the WS
// event path and freeze all further processing. Losing a persisted key is harmless: seq/epoch/history
// are re-derivable from the server on the next resume.
function safeLocalSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn(`[storage] setItem(${key}) failed (ignored):`, e);
  }
}
// Seq is persisted per `assistant.delta` (many times per turn), so it's throttled off the hot path: the
// latest value is held in memory and flushed at most once/second (and on tab-hide). `get` reads the
// pending value first so an attach/resume still sends the freshest lastSeq.
const pendingSeq = new Map<string, number>();
let seqFlushTimer = 0;
function flushSeq(): void {
  seqFlushTimer = 0;
  for (const [id, seq] of pendingSeq) safeLocalSet(`anvil.seq.${id}`, String(seq));
  pendingSeq.clear();
}
const seqStore = {
  get: (id: string): number => pendingSeq.get(id) ?? Number(localStorage.getItem(`anvil.seq.${id}`) ?? 0),
  set: (id: string, seq: number): void => {
    pendingSeq.set(id, seq);
    if (!seqFlushTimer && typeof window !== "undefined") seqFlushTimer = window.setTimeout(flushSeq, 1000);
  },
};
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSeq();
  });
  // Also flush on pagehide (bfcache/teardown may fire it without a reliable visibilitychange:hidden),
  // mirroring flushPersistSessions — so the last throttled seq isn't lost on a hard close.
  if (typeof window !== "undefined") window.addEventListener("pagehide", flushSeq);
}
// v4 resume (incremental-offline-resilience.md §5): the client caches each session's `epoch` alongside
// its `seq`. On (re)connect the daemon sends `resume.watermarks` (per-session {epoch,lastSeq}); if the
// cached epoch still matches, the cached transcript is current and we pull ONLY deltas (seq>lastSeq)
// instead of a full snapshot — the cross-reload win that makes flaky links feel instant (spec A1/A3).
const epochStore = {
  get: (id: string): string => localStorage.getItem(`anvil.epoch.${id}`) ?? "",
  set: (id: string, epoch: string): void => safeLocalSet(`anvil.epoch.${id}`, epoch), // [WEB2-10] quota-safe
};
const serverWatermarks = new Map<string, { epoch: string; lastSeq: number }>();
/** Whether the cached transcript for `id` can be delta-resumed: the server's epoch still matches ours
 *  and it has at least as many events as we've cached. Because the log is append-only and never pruned,
 *  an epoch match guarantees `since(lastSeq)` returns every event we're missing (spec A3). */
function canResumeIncrementally(id: string): boolean {
  return canDeltaResume(serverWatermarks.get(id), epochStore.get(id), seqStore.get(id));
}

// Skeleton-first paint (spec D3/D4/A7): on a cold open we show a structural skeleton and defer the
// cached transcript (now durable in IndexedDB, spec D8) until the watermark confirms it's current — so
// we never flash a stale frame online. Offline, availability of the last-viewed conversation is the
// whole point (D1), so we paint the cache immediately once it loads.
let pendingCache: { id: string; html: string } | null = null;
let pendingLoadId: string | null = null; // a fresh load whose async cache read is still resolving
/** Paint the deferred cached transcript for `id` (validated online, or shown offline). */
function fillCache(id: string): void {
  if (!pendingCache || pendingCache.id !== id || id !== activeId) return;
  conversation.innerHTML = pendingCache.html;
  scrollDown(true);
  snapshotLoaded.add(id); // we have content on screen — suppress the "no history" diagnostic
  pendingCache = null;
}
/** Forget everything cached for a session that's gone (killed/purged): transcript + resume watermark.
 *  Prevents a recreated id from ever delta-resuming against stale state. */
function forgetConvoState(id: string): void {
  void convoCache.delete(id);
  serverWatermarks.delete(id);
  snapshotLoaded.delete(id);
  pendingSeq.delete(id); // [WEB2-11] the throttled in-memory seq (WEB2-10) must go too
  localStorage.removeItem(`anvil.epoch.${id}`);
  localStorage.removeItem(`anvil.seq.${id}`);
  // [WEB2-11] anvil.history.<id> had NO removal path anywhere — a permanent per-session leak (the 3.0.33
  // quota class). Drop it (and the draft) here so a single call fully forgets a gone session.
  localStorage.removeItem(`anvil.history.${id}`);
  localStorage.removeItem(`anvil.draft.${id}`);
}
/** Fill the cache the moment the watermark validates it (called from the resume.watermarks handler). */
function maybeFillValidatedCache(id: string | null): void {
  if (!id || id !== activeId) return;
  if (pendingCache?.id === id && canResumeIncrementally(id)) fillCache(id);
}
/** A lightweight shimmer skeleton shown while we verify the cache (never persisted). */
function renderSkeleton(): void {
  conversation.innerHTML =
    `<div class="convo-skeleton" aria-hidden="true">` +
    `<div class="skel-bubble user"></div><div class="skel-bubble asst"></div>` +
    `<div class="skel-bubble asst wide"></div><div class="skel-bubble user"></div>` +
    `</div>`;
}
/**
 * Full fresh load of a conversation (cold boot / session switch): skeleton → async cache read → decide
 * paint + attach. IDB is async, so the attach decision waits for the cache to be in hand — that ordering
 * guarantees a validated cache paints BEFORE the deltas that append on top of it (no lost events).
 */
async function loadConversation(id: string): Promise<void> {
  pendingLoadId = id; // a load is in flight for `id` — session.list must not start a competing one
  clearConversation();
  snapshotLoaded.delete(id); // a fresh load — re-derive "content shown" below
  pendingCache = null;
  if (convoCache.has(id)) renderSkeleton();
  else maybeShowSessionHero(); // no cache → straight to the title card (no skeleton flash)
  const html = await convoCache.get(id).catch(() => null);
  if (id !== activeId) {
    if (pendingLoadId === id) pendingLoadId = null;
    return; // switched away mid-load
  }
  pendingCache = html ? { id, html } : null;
  attachConversation(id);
  if (pendingLoadId === id) pendingLoadId = null;
}
/** Decide paint + attach once the cache is known. Delta-resume when the cache is current, else snapshot;
 *  offline, show the last-known cache and let the reconnect re-attach re-sync. */
function attachConversation(id: string): void {
  const online = serverOf(id)?.sock.isOpen() ?? false;
  if (canResumeIncrementally(id) && pendingCache?.id === id) {
    fillCache(id); // paint the validated cache FIRST, then request only what we're missing
    telemetry.mark("resumeDelta");
    sendTo(id, { type: "session.attach", sessionId: id, lastSeq: seqStore.get(id) });
  } else if (!online && pendingCache?.id === id) {
    telemetry.mark("offlineReloads");
    fillCache(id); // offline: last-known content now; session.list on reconnect re-runs the attach
  } else {
    telemetry.mark("resumeSnapshot");
    sendTo(id, { type: "session.attach", sessionId: id }); // cold → the snapshot repaints the skeleton
  }
}
/** Re-attach a session that already has content on screen (reconnect mid-session): delta-resume without
 *  wiping the pane. If the epoch changed under us (rare), fall back to a full reload. */
function attachReconnect(id: string): void {
  if (canResumeIncrementally(id)) {
    telemetry.mark("resumeDelta");
    sendTo(id, { type: "session.attach", sessionId: id, lastSeq: seqStore.get(id) });
  } else {
    void loadConversation(id); // lineage reset → re-skeleton + snapshot
  }
}

// Reclaim quota FIRST: an app upgraded from a pre-Phase-3 build can have localStorage near full of old
// `anvil.convo.*` HTML blobs (up to 1.5MB each). Clearing them before any new write below prevents a
// QuotaExceededError from aborting init on a returning user's device.
migrateLegacyConvoCache();

// ── Telemetry sync + debug surface (incremental-offline-resilience.md §5.7 / Phase 6, spec D11) ────
// A stable per-device id so the daemon keys this client's latest counter report.
const clientId = (() => {
  try {
    let id = localStorage.getItem("anvil.clientId");
    if (!id) {
      id = newCid();
      localStorage.setItem("anvil.clientId", id); // guarded: a full quota must never abort init
    }
    return id;
  } catch {
    return newCid(); // ephemeral id for this session — telemetry keying degrades, the app still boots
  }
})();
let connectStartedAt = 0; // set when a socket starts connecting — TTI/verify are measured from here
let serverTelemetry: { server: Record<string, number>; clients: Record<string, Record<string, number>> } = { server: {}, clients: {} };
let telemetryReportTimer = 0;
/** The full client counter bag we ship to the daemon (counters + the timing gauges). */
function clientTelemetryBag(): Record<string, number> {
  return { ...telemetry.snapshot(), timeToInteractiveMs: telemetry.timeToInteractiveMs, verifyMs: telemetry.verifyMs };
}
/** Post this client's counters to the daemon (throttled) so it can aggregate + rebroadcast (D11). */
function scheduleTelemetryReport(): void {
  clearTimeout(telemetryReportTimer);
  telemetryReportTimer = window.setTimeout(() => {
    const h = hub();
    if (h.sock.isOpen()) h.sock.send({ type: "telemetry.report", clientId, counters: clientTelemetryBag() });
  }, 4000);
}
telemetry.onReport(() => scheduleTelemetryReport()); // any counter change queues a coalesced report
// Flush a final report when the tab is backgrounded/closed so short sessions aren't lost.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      const h = hub();
      if (h.sock.isOpen()) h.sock.send({ type: "telemetry.report", clientId, counters: clientTelemetryBag() });
    }
  });
}
/** Render the diagnostics panel (toggled with #diag or Ctrl/Cmd+Shift+D) — client + daemon counters. */
function renderDiagnostics(): void {
  const el = document.getElementById("diag-panel");
  if (!el) return;
  const c = clientTelemetryBag();
  const row = (k: string, v: unknown) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`;
  const clientRows = Object.entries(c).map(([k, v]) => row(k, v)).join("");
  const serverRows = Object.entries(serverTelemetry.server).map(([k, v]) => row(k, v)).join("");
  el.innerHTML =
    `<div class="diag-head">Resilience diagnostics <button id="diag-close" class="mini">${icon("close")}</button></div>` +
    `<div class="diag-cols"><div><h4>This client</h4><table>${clientRows}</table></div>` +
    `<div><h4>Daemon</h4><table>${serverRows || "<tr><td>—</td></tr>"}</table></div></div>`;
  document.getElementById("diag-close")?.addEventListener("click", () => toggleDiagnostics(false));
}
let diagUnsubscribe: (() => void) | null = null;
function toggleDiagnostics(show?: boolean): void {
  let el = document.getElementById("diag-panel");
  const wantShow = show ?? !el;
  if (wantShow && !el) {
    el = document.createElement("div");
    el.id = "diag-panel";
    document.body.appendChild(el);
    // [WEB2-13] Keep the unsubscribe and call it on close — each open used to add a NEW telemetry
    // listener that was never removed, so repeatedly opening the panel leaked a listener each time.
    diagUnsubscribe?.();
    diagUnsubscribe = telemetry.subscribe(() => {
      if (document.getElementById("diag-panel")) renderDiagnostics();
    });
    renderDiagnostics();
  } else if (!wantShow && el) {
    el.remove();
    diagUnsubscribe?.();
    diagUnsubscribe = null;
  }
}
if (typeof window !== "undefined") {
  (window as unknown as { __anvilDiag?: () => void }).__anvilDiag = () => toggleDiagnostics(true);
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "D" || e.key === "d")) {
      e.preventDefault();
      toggleDiagnostics();
    }
  });
  if (location.hash === "#diag") toggleDiagnostics(true);
}

// Cache the rendered conversation per session so it shows instantly on reload, before the WS
// even connects. Best-effort (skipped if it exceeds the localStorage quota).
let cacheTimer = 0;
function saveConvoCache(): void {
  const id = activeId;
  if (!id) return;
  clearTimeout(cacheTimer);
  cacheTimer = window.setTimeout(() => {
    try {
      // The pane is shared: if we've since switched sessions (or are mid-load showing a skeleton), the
      // DOM no longer belongs to `id` — writing it would clobber `id`'s cache with the wrong content
      // (or a skeleton that would repaint as a frozen shimmer). Bail in both cases.
      if (activeId !== id || conversation.querySelector(".convo-skeleton")) return;
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
      // Persist to IndexedDB (spec D8) — no 1.5MB cliff, so a long transcript stays cached and
      // delta-resumable instead of silently dropping to a full snapshot on the next reload.
      void convoCache.set(id, clone.innerHTML);
    } catch {
      /* best-effort — the snapshot still loads from the daemon */
    }
  }, 600);
}

// Conversation deps (P7 — see conversation.ts). Same timing contract as initFleet/initSidebar:
// this runs during module init, BEFORE the instant-restore renderEmptyState()/loadConversation()
// calls below, so every conversation entry point sees its deps assigned. Reassigned scalars
// (`activeId`, `panelView`) are injected as lazy reads; `permCards`/`questionCards` are declared
// far below, so clearCardMaps only dereferences them at call time (never during this call → no TDZ).
initConversation({
  activeId: () => activeId,
  activeServer,
  sessions,
  environments,
  snapshotLoaded,
  saveConvoCache,
  setStatus,
  toast,
  clearCardMaps: () => {
    permCards.clear();
    questionCards.clear();
  },
  panelView: () => panelView,
  renderLinks,
});

// Resolve the theme before the first render so JS-computed session tints use the right band.
// (themePref/resolveTheme are hoisted function declarations, defined in the Theme section below.)
document.documentElement.dataset.theme = resolveTheme(themePref());

// instant restore: paint the hydrated sidebar immediately on load. The conversation is skeleton-first
// (spec D3/A7): we defer painting the cached transcript until the resume watermark verifies it's
// current, or — if no server is reachable within the budget — paint it as the offline fallback.
renderSessions();
refreshPromptsButton();
applyActiveTint();
if (activeId) {
  if (sessions.has(activeId)) setHeaderTitle(sessions.get(activeId));
  // DEFER the conversation load by a microtask (declare-up-top rule, see §Early-init above):
  // loadConversation → clearConversation touches `permCards`/`questionCards`, which are declared far
  // below and are still in their temporal dead zone during synchronous module init. Running it after
  // init completes guarantees every const it reaches is initialized. Bit every returning user (activeId
  // set) in 3.0.33; fresh installs (no activeId) took the renderEmptyState branch and never hit it.
  queueMicrotask(() => void loadConversation(activeId!));
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

// (multi-server connection layer lives in fleet.ts, wired up top with the other early-init state; the sockets
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
        telemetry.mark(res.type === "command.error" ? "flushFail" : "flushOk");
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
    // Reconcile the active session with a DELTA re-attach, not a full snapshot (spec A6): the daemon
    // already broadcast the authoritative message.user (carrying each item's cid) as we flushed, which
    // retired the optimistic bubbles in appendUser — so we only need to re-sync any tail we missed.
    if (touchedActive && activeId && serverOf(activeId)?.sock.isOpen()) {
      attachReconnect(activeId);
    }
  }
}
/** A created-offline session was realized on the daemon: migrate its cache + active selection. */
function reconcileTemp(tempId: string, realId: string): void {
  void convoCache.move(tempId, realId); // carry the optimistic transcript over to the real session id
  // Carry the resume watermark/seq too, so the reconciled session stays delta-resumable.
  const ep = epochStore.get(tempId);
  if (ep) epochStore.set(realId, ep);
  const sq = seqStore.get(tempId);
  if (sq) seqStore.set(realId, sq);
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
  void convoCache.delete(tempId);
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
// [WEB2-1] Deferred to a microtask: openAutopilot → renderScheduleBar → scheduleSummaryHtml reads
// serverSchedule/autopilotLog/runState. Historically those were `let`/`const` declared ~3000 lines
// below — in their temporal dead zone during module init, so a synchronous call here aborted the
// whole module init (dead app) for any cold deep-link boot, the exact class 3.0.33 shipped for
// `loadConversation`. P7 fixed that structurally: the scalars now initialize at autopilot.ts's
// module eval, BEFORE this body runs. The microtask stays as the original timing (the view opens
// after the rest of module init — e.g. the settings/menu wiring below — has finished).
if (deepLinkedPlan) queueMicrotask(() => openPlanDeepLink(deepLinkedPlan));
else if (deepLinkedAutopilot) queueMicrotask(() => openAutopilot()); // bare #autopilot deep link → open the grid

// A daemon with no Claude login can't run a single turn, so the session list would be a lie — take the
// screen over with the pairing/setup flow instead (headless-join §5.1). No-op on a healthy daemon.
initSetupTakeover({
  setToken: async (token) => {
    const res = await sendAwait(hub(), { type: "auth.set", token, cid: newCid() }, 20_000);
    if (res.type === "command.error") throw new Error(res.message); // e.g. the metered-key rejection
  },
});

// The native shell bridge (nativeBridge/isAndroidApp) and Web Push live in push.ts.
void initPush();
updateOutboxBadge(); // reflect any queued-offline writes on load

// ── Connection status ────────────────────────────────────────────────────────
// The restart-in-flight flag (`ui.pendingRestartReload`) lives in state.ts: it's set by fleet.ts's
// wireDaemonUpdate and read/cleared by onStatus below, and a reassigned scalar can't cross an
// ES-module boundary as a plain `let` (imported bindings are read-only).
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
  const prev = srv?.status;
  if (srv) srv.status = status;
  // Start the TTI/verify stopwatch when the hub begins (re)connecting (§5.7 timing gauges).
  if (status === "connecting" && url === HUB_URL) connectStartedAt = Date.now();
  // The header dot reflects the ACTIVE session's server; per-server dots live in the sidebar groups.
  refreshConnDot();
  updateOutboxBadge();
  renderSessions(); // per-server status dots in the group headers
  if (document.querySelector(".settings-view")) renderServerCards(); // live status in Settings
  if (status === "connected") {
    if (prev === "disconnected") telemetry.mark("reconnects"); // recovered from a real drop (spec §5.7)
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
  if (ui.pendingRestartReload && url === HUB_URL) {
    if (status === "disconnected") setUpdateStatus("Daemon is restarting…");
    else if (status === "connected") {
      ui.pendingRestartReload = false;
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
          // [WEB2-11] A session this server owned and no longer lists was deleted (possibly while we were
          // disconnected). Forget its cached transcript + seq/epoch/history/draft here — otherwise those
          // keys are orphaned forever, directly the 3.0.33 quota-exhaustion class.
          forgetConvoState(id);
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
      // (re)attach the active session only if it lives on THIS server. If it's already on screen this
      // page-load, delta-resume without wiping the pane; otherwise run a full skeleton→cache→attach load.
      if (activeId && sessions.has(activeId) && sessionServer.get(activeId) === url) {
        setHeaderTitle(sessions.get(activeId));
        if (snapshotLoaded.has(activeId)) attachReconnect(activeId);
        else if (pendingLoadId === activeId) { /* a fresh load is already resolving; it will attach itself */ }
        else void loadConversation(activeId);
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
        updateHeaderAccount(e.session); // reflect an account switch + the idle/mid-turn tooltip
        updateHeaderModel(e.session); // reflect a model switch (incl. one made on another device)
        updateContextMeter(e.session); // refresh the context-window gauge as turns/compaction change it
        updateGoalChip(e.session); // the goal's iteration count climbs on every unmet stop attempt
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
      // First frame after open: time-to-interactive proxy (§5.7).
      if (url === HUB_URL && connectStartedAt) telemetry.timeToInteractiveMs = Date.now() - connectStartedAt;
      // identify the server on this socket as soon as it opens (fleet §3/§6).
      const srv = servers.get(url);
      if (srv) {
        srv.id = e.serverId;
        srv.name = e.serverName || srv.name;
        srv.version = e.version;
        srv.capabilities = e.capabilities;
        srv.role = e.role;
        srv.hubServerId = e.hubServerId;
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
    case "model.labels":
      // Model labels are hub-authoritative (the hub resolves them from the Models API). Ignore a
      // fleet member's own copy so it can't clobber the hub's labels.
      if (url === HUB_URL) onModelLabels(e.labels);
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
    case "auth.accounts":
      // Roster-scoped, NOT origin-scoped (§7.2): the authoritative roster lives on whichever server
      // owns it, which is the origin for a standalone/hub but the adopted hub for a member. Accepting
      // a member's own replica broadcast here would let a stale copy clobber the hub's.
      if (sameServerUrl(url, rosterServer()?.url ?? HUB_URL)) onAuthAccounts(e);
      return;
    case "autopilot.maintenance.result":
      return; // resolved via cidWaiter (resetAnvilTags / clearAutopilot)
    case "autopilot.plans":
      onAutopilotPlans(url, e.plans);
      return;
    case "autopilot.plan":
      return; // resolved via cidWaiter (reassignPlan); the matching autopilot.plans broadcast refreshes state
    case "autopilot.started":
      return; // resolved via cidWaiter (startPlan / openPlanningSession)
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
  if (ui.turnCanceled) {
    if (e.type === "result" || (e.type === "status" && e.status === "idle") || e.type === "message.user") {
      ui.turnCanceled = false; // fall through and handle normally
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
    case "resume.watermarks":
      // v4 (§6.4): cache the per-session {epoch,lastSeq} this connection reports, then — if we were
      // holding a skeleton waiting to verify the active session's cache — paint it now that it's valid.
      if (connectStartedAt) telemetry.verifyMs = Date.now() - connectStartedAt; // §5.7 verify latency
      for (const w of e.watermarks) serverWatermarks.set(w.sessionId, { epoch: w.epoch, lastSeq: w.lastSeq });
      maybeFillValidatedCache(activeId);
      return;
    case "telemetry.snapshot":
      serverTelemetry = { server: e.server, clients: e.clients }; // §5.7: daemon's aggregate view
      if (document.getElementById("diag-panel")) renderDiagnostics();
      return;
    case "conversation.snapshot":
      if (e.sessionId === activeId) clearAttachDiagnostic(); // history arrived — retire the blank-pane note
      // A snapshot supersedes any deferred cache for this session — we're repainting authoritative state.
      if (pendingCache?.id === e.sessionId) pendingCache = null;
      clearConversation();
      ui.replayingSnapshot = true;
      renderSnapshotEvents(e.events);
      ui.replayingSnapshot = false;
      // A replayed history has no `result` event, so the last turn's activity block was rebuilt
      // "live" — finalize it so it shows "Worked" instead of an eternally spinning "Working". If the
      // session is actually mid-turn, the live status/message events that follow re-light it.
      finalizeActivity();
      snapshotLoaded.add(e.sessionId);
      // Cache the resume lineage token + watermark so the NEXT reload can delta-resume instead of
      // re-snapshotting (spec A1/A3) — this is the cross-reload win.
      epochStore.set(e.sessionId, e.epoch);
      serverWatermarks.set(e.sessionId, { epoch: e.epoch, lastSeq: e.lastSeq });
      if (e.sessionId === activeId) maybeShowSessionHero(); // no messages yet → show the session title card
      saveConvoCache();
      return;
    case "message.user":
      appendUser(e.rendered.html, e.attachments, e.ts, e.cid); // cid retires the matching optimistic bubble
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
      ui.streaming = null;
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

// ── Conversation pane (P7) ──────────────────────────────────────────────────────
// The conversation-rendering seam — bubbles/timestamps/the streaming draft, the consolidated
// activity block (§5), the links MODEL (§links), file-offer cards (§download), the session hero,
// the attach diagnostic, Stop (§stop), copy-to-clipboard, the link/attachment copy-download
// actions, and lazy Mermaid — lives in conversation.ts. Its deps are injected via
// initConversation(...) above. The links side-PANEL chrome below stays here with the rest of the
// side panel: it writes panelView/panelContent/setPanelTabs (side-panel state) and is handed back
// to conversation.ts as the `renderLinks` dep so a reference-set change refreshes an open panel.
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
  else if (!ui.streaming) showThinking(status); // while text streams, the text is the activity
  updateComposerMode(status); // swap Send ↔ Stop while a turn runs
  const s = activeId ? sessions.get(activeId) : undefined;
  if (s) {
    s.status = status as Session["status"];
    renderSessions();
    updateHeaderAccount(s); // the account chip's switch tooltip depends on idle vs mid-turn
  }
}

function setHeaderTitle(s: Session | undefined): void {
  $("#header-title").innerHTML = s ? `${icon(sessIcon(s))}<span class="ht">${esc(s.title)}</span>` : `<span class="ht">Anvil</span>`;
  document.title = s ? `Anvil: ${s.title}` : "Anvil";
  $("#btn-new-topic").hidden = !s?.isDefault; // "New topic" only applies to the persistent concierge chat
  updateHeaderBranch(s);
  updateHeaderAccount(s);
  updateHeaderModel(s);
  updateContextMeter(s);
  updateGoalChip(s);
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

/** Show the active session's Claude account as a chip in the header (multi-account §5). Omitted
 *  entirely when the roster has ≤1 account — there's nothing to distinguish. When the session's bound
 *  account no longer resolves (removed), the chip badges the fallback with the old label. */
function updateHeaderAccount(s: Session | undefined): void {
  const el = document.getElementById("header-account");
  if (!el) return;
  const list = claudeAccounts?.accounts ?? [];
  // C4: the <=1 guard used to run BEFORE the accountMissing branch, so removing the second-to-last
  // account rebound every session bound to it and then hid the only evidence that had happened. A
  // session flagged as fallen-back must always be able to say so, however small the roster.
  if (!s || s.isDefault || (list.length <= 1 && !s.accountMissing)) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  if (s.accountMissing) {
    // `s.accountLabel` deliberately still names the REMOVED account (see the protocol's comment); the
    // current fallback's label comes from the roster snapshot the client already has.
    const oldLabel = s.accountLabel ?? "a removed account";
    const defaultId = claudeAccounts?.defaultId;
    const nowLabel = claudeAccounts?.accounts.find((a) => a.id === defaultId)?.label ?? "the default";
    el.innerHTML = `${icon("warning")}<span class="hb-name">${esc(nowLabel)} ⚠ was ${esc(oldLabel)}</span>`;
    el.title = `“${oldLabel}” was removed — this session fell back to “${nowLabel}”`;
    el.hidden = false;
    return;
  }
  const label = s.accountLabel ?? claudeAccounts?.accounts.find((a) => a.id === s.accountId)?.label;
  if (!label) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  el.innerHTML = `<span class="hb-name">● ${esc(label)}</span>`;
  // The daemon refuses a mid-turn switch (setSessionAccount), so say why before the click.
  el.title = s.status === "idle" ? `Claude account: ${label} — tap to switch` : "finish or interrupt the current turn first";
  el.hidden = false;
}

/** Show the active session's model as a pill in the composer (next to Attach); tap it to switch. */
function updateHeaderModel(s: Session | undefined): void {
  const el = document.getElementById("btn-model");
  if (!el) return;
  if (s) {
    el.innerHTML = `${icon("smart_toy")}<span class="cm-name">${esc(modelLabelOf(s.model))}</span>`;
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
/**
 * Goal chip (design 2026-07-25): a slim, display-only bar above the composer showing the session's
 * active goal and how many attempts it has made. Cleared with `/goal clear` — deliberately no button.
 */
function updateGoalChip(s: Session | undefined): void {
  const el = document.getElementById("goal-chip");
  if (!el) return;
  const g = s?.goal;
  if (!g) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  el.hidden = false;
  el.className = "goal-chip" + (g.paused ? " paused" : "");
  const count = g.paused ? "paused" : `${g.iterations}/${GOAL_MAX_ITERATIONS}`;
  el.innerHTML = `${icon("target")}<span class="goal-cond">${esc(g.condition)}</span><span class="goal-count">${count}</span>`;
  el.title = g.lastReason ? `Last blocker: ${g.lastReason}` : "Send /goal clear to stop early";
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
      label: modelLabelOf(m.id),
      title: m.id === s.model ? `${modelLabelOf(m.id)} (current)` : `Switch to ${modelLabelOf(m.id)}`,
      run: () => {
        if (m.id === s.model) return;
        sendTo(activeId, { type: "session.set_model", sessionId: activeId, model: m.id });
      },
    })),
  );
});

// Tapping the account chip switches this session's Claude account (multi-account §10). Only offered
// while the session is IDLE: the daemon refuses mid-turn anyway (setSessionAccount), so the menu
// explains why up front rather than letting the click fail. A ✓ marks the current account.
$("#header-account").addEventListener("click", () => {
  const s = activeId ? sessions.get(activeId) : undefined;
  const list = claudeAccounts?.accounts ?? [];
  if (!s || list.length <= 1) return;
  if (s.status !== "idle") {
    toast("Finish or interrupt the current turn first — the new login applies from the next one.");
    return;
  }
  toggleHeaderMenu(
    $("#header-account"),
    list.map((a) => ({
      icon: a.id === s.accountId ? "check" : "key",
      label: a.label,
      title: a.id === s.accountId ? `${a.label} (current)` : `Switch this session to ${a.label}`,
      run: () => {
        if (a.id === s.accountId) return;
        sendTo(activeId, { type: "session.account.set", sessionId: activeId, accountId: a.id });
      },
    })),
  );
});

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
/** Apply a `model.labels` broadcast from the hub: replace the overrides, cache them, repaint the model
 *  surfaces (header pill + any open picker rebuilds on next open). */
function onModelLabels(labels: Partial<Record<Model, string>>): void {
  modelLabelOverrides = labels ?? {};
  try {
    localStorage.setItem(MODEL_LABELS_CACHE_KEY, JSON.stringify(modelLabelOverrides));
  } catch {
    /* quota — the daemon is still the source of truth */
  }
  updateHeaderModel(activeId ? sessions.get(activeId) : undefined);
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
    // Refresh the roster from whichever server owns it (§7.2), once per tab open.
    const rs = rosterServer();
    if (serverSupports(rs, "accounts")) rs.sock.send({ type: "auth.accounts.get" });
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
  // A Claude-token change is exactly the transition the setup takeover exists for — a pair, a paste, or
  // an auto-degrade. Re-read health so the screen appears/clears live on every open device, rather than
  // only on the next reload (anvil-headless-join.md §5.1).
  if (e.provider !== "openrouter") void refreshSetupState();
}

// The Claude account roster (Settings → Models; multi-account §9). Absent until the connect burst or
// an explicit auth.accounts.get lands. A pre-roster daemon (no "accounts" capability) never sends
// this, so renderModelsPanel falls back to the single-token card in that case.
let claudeAccounts: AuthAccountsEvent | undefined;
function onAuthAccounts(e: AuthAccountsEvent): void {
  claudeAccounts = e;
  if (document.getElementById("models-panel")) renderModelsPanel();
  // The header chip appears/disappears at the 1↔2-account boundary and shows a label the roster owns,
  // so a roster change has to repaint it even when no session.updated follows.
  updateHeaderAccount(activeId ? sessions.get(activeId) : undefined);
  // F2: the Servers tab's per-Mac sync lines are derived from this same roster, so without this they
  // kept rendering a stale snapshot until a reload — including the actionable "out of date" warning,
  // which is worse than a stale count because it prompts an action based on old state.
  if (document.getElementById("server-cards")) renderServerCards();
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
  // ── Claude (drives the Agent SDK) — the roster list when the hub supports it, else the single-token
  //    card an older daemon still understands. ──
  const claudeSection =
    serverSupports(rosterServer(), "accounts") && claudeAccounts ? accountsSection(claudeAccounts, persistWarn) : legacyClaudeSection(tokenForm, persistWarn);
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

  // Wire Claude controls: the roster's own row/menu/dialog handlers, or the legacy single-token form.
  if (serverSupports(rosterServer(), "accounts") && claudeAccounts) {
    wireAccountsSection(claudeAccounts);
  } else {
    if (claudeAuth.connected) $("#claude-clear").addEventListener("click", () => void clearClaudeTokenUi());
    const cInput = $<HTMLInputElement>("#claude-token");
    const cBtn = $<HTMLButtonElement>("#claude-save");
    cBtn.addEventListener("click", () => void saveClaudeToken(cInput.value, cBtn));
    cInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void saveClaudeToken(cInput.value, cBtn);
    });
  }
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

/** The pre-roster single-token card (an older daemon that doesn't advertise "accounts"). */
function legacyClaudeSection(tokenForm: (saveLabel: string) => string, persistWarn: (persisted: boolean) => string): string {
  if (!claudeAuth) return "";
  return !claudeAuth.connected
    ? `<div class="card"><b>No Claude token set.</b>
        <p class="small muted">On the daemon host run <code>claude setup-token</code>, paste the token below, then save. Stored on the hub daemon (mode 0600) and applied to the next agent run.</p>
        ${tokenForm("Save")}</div>`
    : `<div class="card"><div class="card-main"><span class="conn-dot connected"></span>
          <span>Claude — connected${claudeAuth.masked ? ` · <code>${esc(claudeAuth.masked)}</code>` : ""}</span>
          <button id="claude-clear" class="mini danger" style="margin-left:auto">${icon("key_off")} Reset / clear</button></div>${persistWarn(claudeAuth.persisted)}</div>
        <div class="card"><b>Replace token</b>
          <p class="small muted">Rotated or expired? Paste a fresh token to replace the current one.</p>
          ${tokenForm("Replace")}</div>`;
}

/** This server's display name, given its serverId — for the "managed on <hub>" replica note.
 *  Falls back to the bare id when the hub isn't among the connected servers (Task 26/27 make this a
 *  real lookup via rosterServer(); until then this is best-effort). */
function serverNameById(id: string | undefined): string {
  if (!id) return "the hub";
  for (const s of servers.values()) if (s.id === id) return s.name;
  return id;
}

/** The Claude account roster card (multi-account §9.1): a labelled list with a default marker, an
 *  Add-account action on the hub, and — on a replica — a note pointing at the hub that manages it. */
function accountsSection(acc: AuthAccountsEvent, persistWarn: (persisted: boolean) => string): string {
  const isHub = acc.role === "hub";
  const rows = acc.accounts
    .map((a: AccountInfo) => {
      const isDefault = a.id === acc.defaultId;
      const defaultBtn = isHub
        ? `<button class="mini acct-default" data-id="${esc(a.id)}" title="${isDefault ? "Default account" : "Make default"}" ${isDefault ? "disabled" : ""}>${icon(isDefault ? "radio_button_checked" : "radio_button_unchecked")}</button>`
        : `<span class="mini" style="opacity:.6" title="${isDefault ? "Default account" : ""}">${icon(isDefault ? "radio_button_checked" : "radio_button_unchecked")}</span>`;
      const menu = isHub
        ? `<button class="mini acct-menu" data-id="${esc(a.id)}" data-label="${esc(a.label)}" title="More">${icon("more_vert")}</button>`
        : "";
      return `<div class="acct-row" id="acct-row-${cssId(a.id)}">
          <div class="card-main">${defaultBtn}<span class="acct-label">${esc(a.label)}</span><code class="small muted">${esc(a.masked)}</code><span style="margin-left:auto"></span>${menu}</div>
          <div class="acct-actions" id="acct-actions-${cssId(a.id)}" hidden></div>
        </div>`;
    })
    .join("");
  const replicaNote = isHub
    ? ""
    : `<p class="small muted" style="margin-top:8px">${icon("hub")} Managed on <b>${esc(serverNameById(acc.hubServerId))}</b> (the hub). Changes sync to every Mac.</p>`;
  const addBtn = isHub ? `<div class="git-row" style="margin-top:10px"><button class="mini" id="acct-add">${icon("add")} Add account</button></div>` : "";
  return `<div class="card"><b>Claude accounts</b>
      <div class="acct-list" style="margin-top:8px">${rows}</div>
      ${replicaNote}${persistWarn(acc.persisted)}${addBtn}
    </div>`;
}

/** Toggle a roster row's inline action strip (Rename / Replace token / Set default / Remove) — the
 *  "⋯" menu, implemented as an expand/collapse row rather than a floating popover (no popover
 *  infrastructure exists elsewhere in this codebase, and this keeps focus/keyboard behaviour simple). */
function toggleAccountActions(id: string, label: string): void {
  const el = document.getElementById(`acct-actions-${cssId(id)}`);
  if (!el) return;
  const wasHidden = el.hidden;
  // Only one row's actions open at a time.
  document.querySelectorAll(".acct-actions").forEach((n) => ((n as HTMLElement).hidden = true));
  if (!wasHidden) return;
  el.hidden = false;
  el.innerHTML = `<div class="git-row">
      <button class="mini" data-act="rename">${icon("edit")} Rename</button>
      <button class="mini" data-act="replace">${icon("key")} Replace token</button>
      <button class="mini" data-act="default">${icon("radio_button_checked")} Set default</button>
      <button class="mini danger" data-act="remove">${icon("delete")} Remove</button>
    </div>`;
  el.querySelector('[data-act="rename"]')?.addEventListener("click", () => showAccountDialog({ mode: "rename", id, label }));
  el.querySelector('[data-act="replace"]')?.addEventListener("click", () => showAccountDialog({ mode: "replace", id, label }));
  el.querySelector('[data-act="default"]')?.addEventListener("click", () => void setDefaultAccount(id));
  el.querySelector('[data-act="remove"]')?.addEventListener("click", () => void removeAccountUi(id, label));
}

function wireAccountsSection(acc: AuthAccountsEvent): void {
  document.getElementById("acct-add")?.addEventListener("click", () => showAccountDialog({ mode: "add" }));
  document.querySelectorAll<HTMLButtonElement>(".acct-default").forEach((btn) => {
    btn.addEventListener("click", () => void setDefaultAccount(btn.dataset.id!));
  });
  document.querySelectorAll<HTMLButtonElement>(".acct-menu").forEach((btn) => {
    btn.addEventListener("click", () => toggleAccountActions(btn.dataset.id!, btn.dataset.label ?? ""));
  });
  void acc; // acc is read via the DOM data- attributes above; kept as a param for symmetry with the render call
}

/** Send one `auth.account.*` command to the ROSTER-OWNING server (§7.2 — not necessarily the origin)
 *  and await its `auth.accounts` reply (or a `command.error`, surfaced as a toast). True on success. */
async function sendAccountCmd(cmd: Record<string, unknown> & { type: string }): Promise<boolean> {
  try {
    const res = await sendAwait(rosterServer(), { ...cmd, cid: newCid() }, 20_000);
    if (res.type === "command.error") {
      toast(res.message);
      return false;
    }
    return true;
  } catch (err) {
    toast(`Couldn't reach the hub: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function setDefaultAccount(accountId: string): Promise<void> {
  await sendAccountCmd({ type: "auth.account.default", accountId });
}

async function removeAccountUi(accountId: string, label: string): Promise<void> {
  const inUse = claudeAccounts?.inUse?.[accountId] ?? [];
  const body =
    inUse.length === 0
      ? `Remove “${label}”? Any session bound to it falls back to the default account.`
      : `“${label}” is in use by ${inUse.length} session${inUse.length === 1 ? "" : "s"}: ${inUse.map((s) => s.title).join(", ")}. Removing it falls those sessions back to the default account.`;
  const ok = await confirmDialog({ icon: "delete", title: `Remove “${label}”?`, body, confirmLabel: "Remove", danger: true });
  if (!ok) return;
  if (await sendAccountCmd({ type: "auth.account.remove", accountId })) toast(`Removed “${label}”.`);
}

/** The Add/Rename/Replace-token dialog (multi-account §9.1) — one dialog, three modes, since Rename
 *  and Replace are each a single field of the same form Add uses. */
function showAccountDialog(opts: { mode: "add" } | { mode: "rename"; id: string; label: string } | { mode: "replace"; id: string; label: string }): void {
  const host = hub().name;
  const setupHint = `<p class="small muted">On <code>${esc(host)}</code> run <code>claude setup-token</code>, then paste it below.</p>`;
  const title = opts.mode === "add" ? "Add a Claude account" : opts.mode === "rename" ? `Rename “${opts.label}”` : `Replace “${opts.label}”'s token`;
  const showLabel = opts.mode !== "replace";
  const showToken = opts.mode !== "rename";
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>${icon(opts.mode === "add" ? "add" : opts.mode === "rename" ? "edit" : "key")} ${esc(title)}</h3>
    ${showLabel ? `<label>Label<input id="acct-dlg-label" type="text" maxlength="32" placeholder="e.g. work, personal" value="${opts.mode === "rename" ? esc(opts.label) : ""}" /></label>` : ""}
    ${showToken ? `${setupHint}<label>Token<input id="acct-dlg-token" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-oat…" /></label>` : ""}
    <div id="acct-dlg-status" class="small muted"></div>
    <div class="btns"><button type="button" id="acct-dlg-cancel">Cancel</button><button type="button" id="acct-dlg-ok" class="primary">${opts.mode === "add" ? "Add" : "Save"}</button></div>
  </div>`;
  showModal(m);
  const setStatus = (t: string): void => {
    const el = document.getElementById("acct-dlg-status");
    if (el) el.textContent = t;
  };
  $<HTMLButtonElement>("#acct-dlg-cancel").onclick = closeModal;
  const labelInput = document.getElementById("acct-dlg-label") as HTMLInputElement | null;
  const tokenInput = document.getElementById("acct-dlg-token") as HTMLInputElement | null;
  labelInput?.focus();
  tokenInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") $<HTMLButtonElement>("#acct-dlg-ok").click();
  });
  $<HTMLButtonElement>("#acct-dlg-ok").addEventListener("click", async () => {
    const label = labelInput?.value.trim() ?? "";
    const token = tokenInput?.value.trim() ?? "";
    if (showLabel && !label) {
      setStatus("Enter a label.");
      return;
    }
    if (showToken && !token) {
      setStatus("Paste the token.");
      return;
    }
    const btn = $<HTMLButtonElement>("#acct-dlg-ok");
    btn.disabled = true;
    setStatus("Saving…");
    let cmd: Record<string, unknown> & { type: string };
    if (opts.mode === "add") cmd = { type: "auth.account.add", label, token };
    else if (opts.mode === "rename") cmd = { type: "auth.account.rename", accountId: opts.id, label };
    else cmd = { type: "auth.account.replace", accountId: opts.id, token };
    try {
      const res = await sendAwait(rosterServer(), { ...cmd, cid: newCid() }, 20_000);
      if (res.type === "command.error") {
        // Rendered INLINE (dup label, metered key, …) rather than a toast, and the dialog stays open
        // with the input intact so the user can fix it without retyping everything (§9.1).
        setStatus(res.message);
        btn.disabled = false;
        return;
      }
      closeModal();
      toast(opts.mode === "add" ? "Account added." : opts.mode === "rename" ? "Renamed." : "Token replaced.");
    } catch (err) {
      setStatus(`Couldn't reach the hub: ${err instanceof Error ? err.message : err}`);
      btn.disabled = false;
    }
  });
}

// ── Autopilot + scheduled run (moved to autopilot.ts — P7 decomposition) ────────────────────────
// The plan grid/reader, run log + status banner, badge, and the schedule controls all live in
// autopilot.ts; its deps are injected via initAutopilot(...) next to initFleet/initSidebar above.

/** One card per server in the fleet (hub first): live status, version, update & remove. */
/**
 * Per-Mac account-roster sync state (multi-account §7.3), shown under each server card. Compares the
 * rev the HUB last confirmed pushing to that member against the hub's current rev.
 *
 * Rendered only once the roster is actually multi-account and we're looking at a fleet: on a
 * standalone box, or with a single account, there's nothing to be out of sync about and the line is
 * pure noise. A member that doesn't advertise "accounts" is called out separately — "Sync now" can
 * never fix that one, only updating Anvil on that Mac can.
 */
function accountSyncLine(srv: Server, isOrigin: boolean): string {
  const roster = claudeAccounts;
  if (!roster || roster.accounts.length <= 1) return "";
  const n = roster.accounts.length;
  // `isOrigin` means "this card is the page's own daemon" — NOT "this daemon owns the roster". A
  // MEMBER viewing its own UI is the origin while holding a read-only replica, so conflating the two
  // made its card claim "managed here" directly above the card explaining the accounts are managed on
  // the hub and read-only here. The roster's own `role` is the authority.
  if (isOrigin) {
    if (roster.role !== "replica") return `<div class="small muted">${icon("key")} ${n} Claude accounts · managed here</div>`;
    const owner = roster.hubServerId ? serverNameById(roster.hubServerId) : "";
    const named = owner && owner !== roster.hubServerId ? ` · managed on ${esc(owner)}` : "";
    return `<div class="small muted">${icon("key")} ${n} Claude accounts · read-only replica${named}</div>`;
  }
  // Per-member sync state is only meaningful on the roster OWNER: the rev map is read from this
  // origin's own /api/fleet/members, which a replica doesn't have. Showing a badge from a member's
  // page would report "out of date" about servers it neither tracks nor pushes to.
  if (roster.role === "replica") return "";
  if (srv.capabilities && !serverSupports(srv, "accounts")) {
    return `<div class="small warn-text">${icon("warning")} Update Anvil to use multiple accounts</div>`;
  }
  // F7: this used to read `fleetMemberAccountsRev.get(srv.id)`, but `srv.id` comes from `server.hello`
  // — which an UNREACHABLE peer never sends, leaving it "". The lookup then missed for exactly the
  // members whose state matters most, and every offline Mac reported "out of date — press Sync now"
  // even when it held the current roster, pointing at a remedy that cannot work while it is down.
  // The hub already knows: fleet.json carries serverId AND accountsRev, keyed by host.
  const rev = memberAccountsRevFor(srv);
  if (rev === roster.rev) return `<div class="small muted">${icon("check")} in sync · ${n} accounts</div>`;
  if (rev === undefined && srv.status !== "connected") {
    // Never pushed, or we simply can't tell — don't accuse an offline peer of being stale.
    return `<div class="small muted">${icon("cloud_off")} offline — sync state unknown</div>`;
  }
  return `<div class="small warn-text">${icon("warning")} out of date — press Sync now</div>`;
}

/** The roster rev the hub last confirmed for this server, by live serverId when we have one and by
 *  host otherwise — so an offline member (no `server.hello`, hence no `srv.id`) still resolves. */
function memberAccountsRevFor(srv: Server): number | undefined {
  if (srv.id && fleetMemberAccountsRev.has(srv.id)) return fleetMemberAccountsRev.get(srv.id);
  const id = fleetMemberIdByHost.get(hostnameOf(srv.url));
  return id ? fleetMemberAccountsRev.get(id) : undefined;
}

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
    ${accountSyncLine(srv, isHub)}
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
  // Whether the ORIGIN owns the credentials it would be fanning out. A member holds a replica and has
  // an empty member list, so "Sync now" there can only ever fail (it iterates nothing) and the blurb's
  // "this server's Claude login" is simply false — the login is the hub's. Both are the positional
  // `isHub === the origin` assumption the multi-account design §7.2 called out.
  const originOwnsRoster = hub()?.role !== "member";
  host.innerHTML =
    `<div class="section-head"><h3>${icon("hub")} Fleet</h3><div class="git-row">` +
    (originOwnsRoster
      ? `<button id="fleet-rotate" class="mini" title="Push the current login and Claude accounts to every machine in the fleet">${icon("autorenew")} Sync now</button>` +
        `<button id="fleet-update" class="mini" title="Update every machine in the fleet to one pinned build (members first, this hub last)">${icon("system_update_alt")} Update fleet</button>`
      : "") +
    `<button id="fleet-add" class="mini primary">${icon("add")} Add a machine</button>` +
    `</div></div>` +
    `<p class="small muted">${
      originOwnsRoster
        ? "Every machine here shares this server's Claude login."
        : "This machine is part of another Mac's fleet and shares <b>its</b> Claude login."
    } Update each one's Anvil on its own card; remove one to stop using it from this device.</p>` +
    `<div id="fleet-rollout-status"></div>` +
    list.map(serverCardHtml).join("");
  for (const srv of list) {
    wireDaemonUpdate(srv); // each card's "Update Anvil" targets that server's own daemon
    if (srv.url !== HUB_URL) {
      document.getElementById(`srv-remove-${cssId(srv.url)}`)?.addEventListener("click", () => void confirmRemoveServer(srv));
    }
  }
  document.getElementById("fleet-add")?.addEventListener("click", () => showAddMac());
  document.getElementById("fleet-rotate")?.addEventListener("click", () => void rotateFleetToken());
  document.getElementById("fleet-update")?.addEventListener("click", () => void startFleetUpdate());
  rehydrateFleetRollout(); // re-hydrate an in-flight rollout into the freshly rendered container
  void loadFleetMembers(); // cache host→serverId (so Remove also ejects from the fleet) + adopt any member this device hasn't connected to
  void maybeRenderRepairCard(host); // this-machine "get a join code" — only when it's already in a fleet
  maybeRenderAdoptHubCard(host); // "this Mac is part of <hub>'s fleet" — offers to connect to the roster owner
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
// (Fleet administration + pinned fleet-update rollout moved to fleet.ts — P7 decomposition.)
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
  ui.stickToBottom = true; // a freshly opened session starts pinned to the latest
  renderSessions();
  flushRenderSessions(); // [WEB2-2] renders are rAF-coalesced — the scroll below reads the DOM now
  // Bring the freshly-selected row into view in the sidebar so starting a project
  // from Autopilot (or any cross-view jump) lands you on its row, not just its
  // conversation. `block: "nearest"` is a no-op when the row is already visible,
  // so manual clicks on on-screen rows don't scroll the list.
  const activeRow = document.querySelector<HTMLElement>("#sidebar li.session.active");
  activeRow?.scrollIntoView({ block: "nearest" });
  const s = sessions.get(id);
  setHeaderTitle(s);
  applyActiveTint();
  // Opening a session is acting on it — clear its push reminder on this device immediately (the
  // daemon also clears it everywhere when we attach below). (UI refinement §1)
  navigator.serviceWorker?.controller?.postMessage({ type: "close-notifications", sessionId: id });
  ensureOwningServer(id); // wake/adopt the owning daemon so a member session's history actually loads
  // Skeleton-first load: skeleton → async cache → delta-resume when current, else a full snapshot.
  void loadConversation(id);
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
  // Every send carries a stable cid (v4 exactly-once, spec A5/A6): online it lets the daemon dedupe a
  // retry and lets us match the authoritative echo to any optimistic bubble; offline it's the outbox
  // idempotency key the server dedupes on flush.
  const cid = newCid();
  if (serverOf(activeId)?.sock.isOpen() && !s?.pending) {
    sendTo(activeId, { type: "prompt.send", sessionId: activeId, text, attachmentIds: pendingAttachments.map((a) => a.id), cid });
  } else {
    // offline, or a session that itself hasn't been created yet → queue it.
    if (pendingAttachments.length) toast("Attachments need a connection — sent text only");
    enqueue({ cid, cmd: { type: "prompt.send", sessionId: activeId, text } });
    // Only show an optimistic bubble for an ORDINARY prompt. Daemon-handled commands (/clear, /compact,
    // /goal) emit no message.user, so an optimistic bubble would never be retired — an eternal orphan.
    // They also produce no user bubble online, so skipping it is the consistent behaviour.
    if (!isDaemonHandledCommand(text)) appendOptimisticUser(text, cid);
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
// [WEB2-5] selectionchange fires rapidly during a drag; each handler did a layout read
// (getBoundingClientRect) immediately followed by a style write — a forced synchronous reflow per event.
// Coalesce to one read+write per animation frame.
let selectionRaf = 0;
function positionQuoteButton(): void {
  selectionRaf = 0;
  const el = selectionEl();
  if (!el) {
    quoteBtn.style.display = "none";
    return;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    quoteBtn.style.display = "none";
    return;
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  quoteBtn.style.display = "block";
  quoteBtn.style.top = `${window.scrollY + rect.top - 36}px`;
  quoteBtn.style.left = `${window.scrollX + rect.left}px`;
}
document.addEventListener("selectionchange", () => {
  if (selectionRaf || typeof requestAnimationFrame === "undefined") {
    if (typeof requestAnimationFrame === "undefined") positionQuoteButton();
    return;
  }
  selectionRaf = requestAnimationFrame(positionQuoteButton);
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
  // [WEB2-4] The ResizeObserver fired a fit() + a terminal.resize WS frame on every tick (many per drag).
  // Debounce ~100ms, and only send terminal.resize when the grid (cols/rows) actually changed — a repaint
  // that doesn't alter the character grid shouldn't spam the daemon (which re-sizes the real PTY).
  let lastCols = xterm.cols;
  let lastRows = xterm.rows;
  termObs = new ResizeObserver(() => {
    if (termFitTimer) return;
    termFitTimer = window.setTimeout(() => {
      termFitTimer = 0;
      if (!fit || !xterm || !activeId) return;
      fit.fit();
      if (xterm.cols !== lastCols || xterm.rows !== lastRows) {
        lastCols = xterm.cols;
        lastRows = xterm.rows;
        sendTo(activeId, { type: "terminal.resize", sessionId: activeId, cols: xterm.cols, rows: xterm.rows });
      }
    }, 100);
  });
  termObs.observe(panelContent);
}
let termFitTimer = 0;
function disposeTerminal(): void {
  termObs?.disconnect();
  termObs = null;
  if (termFitTimer) {
    clearTimeout(termFitTimer);
    termFitTimer = 0;
  }
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
  forgetConvoState(id); // drop the cached transcript + resume watermark for a session that's gone
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
  forgetConvoState(id); // drop the cached transcript + resume watermark for the abandoned session
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
  <span><strong>Adversarial plan review</strong> <span class="small muted">— competing models critique each plan (needs an OpenRouter key)</span></span></label>`;
/** Whether the open dialog's adversarial-review checkbox is ticked (false if it isn't present). */
const selectedAdversarial = (): boolean =>
  (document.getElementById("ns-adv") as HTMLInputElement | null)?.checked ?? false;

/** The Claude account picker for the ENVIRONMENT edit dialog (multi-account §6). Like the
 *  new-session one, hidden entirely at ≤1 account. Offers an explicit "use the default" entry, since
 *  an environment's account is genuinely optional — unset means "follow the roster default", which
 *  keeps tracking it if the default later moves. */
function envAccountPickerMarkup(selected?: string): string {
  const list = claudeAccounts?.accounts ?? [];
  if (list.length <= 1) return "";
  const opts = [
    `<option value=""${selected ? "" : " selected"}>Use the default account</option>`,
    ...list.map((a) => `<option value="${esc(a.id)}"${a.id === selected ? " selected" : ""}>${esc(a.label)}</option>`),
  ].join("");
  return `<label>Claude account<div class="env-row"><select id="ee-account">${opts}</select></div>
    <span class="small muted">Used for scheduled autopilot runs, and pre-selected for new sessions here.</span></label>`;
}

/** The Claude account picker for the new-session dialog (multi-account §5). Hidden entirely when the
 *  roster has ≤1 account — there's nothing to choose. */
function accountPickerMarkup(): string {
  const list = claudeAccounts?.accounts ?? [];
  if (list.length <= 1) return "";
  const opts = list.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join("");
  return `<label>Account<div class="env-row"><select id="ns-account">${opts}</select></div></label>`;
}
/** Pre-select the picker to `envId`'s default account, else the roster default. No-op if the picker
 *  isn't rendered (≤1 account). Called once on open and again on every environment change. */
function reselectAccountFor(envId: string | undefined): void {
  const sel = document.getElementById("ns-account") as HTMLSelectElement | null;
  if (!sel) return;
  const pick = (envId ? environments.get(envId)?.accountId : undefined) ?? claudeAccounts?.defaultId;
  if (pick) sel.value = pick;
  refreshSelect(sel);
}
/** The chosen account id from the open dialog's picker, or undefined if it isn't present (≤1 account —
 *  the server resolves the roster default). */
const selectedAccountId = (): string | undefined => (document.getElementById("ns-account") as HTMLSelectElement | null)?.value || undefined;

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
      ${accountPickerMarkup()}
      <label>Session name<input id="ns-name" placeholder="e.g. fix-login-bug" /></label>
      <p class="small muted" id="ns-note"></p>
      <p class="small warn-text" id="ns-warn"></p>
      ${AUTONOMY_PICKER}
      ${ADVERSARIAL_PICKER}
      <label class="cd-option" id="ns-lead-row"><input type="checkbox" id="ns-lead" />
        <span><strong>Team lead</strong> <span class="small muted">— fans the goal out to member sessions and integrates their branches</span></span></label>
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
  envSel?.addEventListener("change", () => reselectAccountFor(envSel.value));
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
  enhanceSelect(document.getElementById("ns-account") as HTMLSelectElement | null);
  reselectAccountFor(envSel?.value);
  nameInp?.focus();
  validate();

  createBtn?.addEventListener("click", () => {
    if (!envSel || !nameInp) return;
    const env = environments.get(envSel.value);
    const name = nameInp.value.trim();
    if (!env || !name) return;
    const accountId = selectedAccountId();
    const common = {
      title: name,
      environmentId: env.id,
      model: DEFAULT_MODEL,
      autonomy: selectedAutonomy(),
      adversarialReview: selectedAdversarial(),
      ...(accountId ? { accountId } : {}),
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
    ${envAccountPickerMarkup(env.accountId)}
    <p class="small muted">repo: <code>${esc(env.repoRoot)}</code>${env.isRepo ? "" : " (not a git repo)"}</p>
    <div class="btns"><button type="button" class="danger" id="ee-remove">Remove</button><span class="spacer" style="flex:1"></span><button type="button" id="ee-back">Back</button><button type="button" id="ee-save">Save</button></div></div>`;
  showModal(m);
  wireSwatchPicker();
  wireIconPicker();
  enhanceSelect(document.getElementById("ee-todoist") as HTMLSelectElement | null, true);
  enhanceSelect(document.getElementById("ee-account") as HTMLSelectElement | null);
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
      // Omitted entirely when the picker isn't rendered (<=1 account), so a single-account fleet can
      // never accidentally clear a stored accountId. "" clears it back to the roster default.
      ...(document.getElementById("ee-account") ? { accountId: $<HTMLSelectElement>("#ee-account").value } : {}),
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
