import { sameServerUrl } from "./api";
import {
  HUB_URL,
  anyOpen,
  cssId,
  ensureOwningServer,
  ensureServer,
  envServer,
  hub,
  initFleet,
  loadExtraServers,
  loadFleetMembers,
  orderedServers,
  pendingTeamPlans,
  persistRouting,
  rosterServer,
  sendTo,
  serverOf,
  serverOfEnv,
  serverSupports,
  serverTeams,
  servers,
  sessionServer,
  type Server,
} from "./fleet";
import { $, esc, icon, sessIcon } from "./dom";
import { currentTheme, resolveTheme, themePref, updateThemeControls } from "./theme";
import type { ThemePref } from "./theme";
import { ui } from "./state";
import {
  dismissOverlay,
  dismissTopOverlay,
  autopilotFromHash,
  loopsFromHash,
  openOverlay,
  overlayOpen,
  overlays,
  planFromHash,
  sessionFromHash,
  sessionHref,
  setSessionHash,
} from "./overlays";
import { initPush } from "./push";
import { initSetupTakeover } from "./setup";
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
  appendToolResult,
  appendUser,
  armAttachDiagnostic,
  clearAttachDiagnostic,
  clearConversation,
  commitAnswerRefs,
  commitAssistant,
  conversation,
  dropSessionHero,
  finalizeActivity,
  hideThinking,
  initConversation,
  maybeShowSessionHero,
  renderEmptyState,
  scrollDown,
  serializeTranscript,
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
  onLoopsSnapshot,
  onAutopilotProgress,
  onAutopilotRunSnapshot,
  onAutopilotSchedule,
  openAutopilot,
  openPlanDeepLink,
  reflectAutopilotRunning,
  serverSchedule,
  updateAutopilotBadge,
} from "./autopilot";
// The settings seam (the Settings overlay + tabs, server/environment cards, the Lapo/Todoist
// integrations, and the Settings → Models providers) lives in settings.ts (P7 decomposition).
// Importing it here makes its module body — including the settings-owned scalars — evaluate before
// this one. Its deps are injected via initSettings(...) next to initFleet(...).
// The Loops home (#loops) — the first-class autonomy surface (loops-circuit spec). Projection-first in
// Phase 1: renders the shared `serverLoops` cache as circuit rows. Deps injected via initLoops(...).
import { initLoops, onLoopRun, onLoopRuns, onLoopsHome, onLoopsList, onLoopUpdated, openLoops, openLoopsDeepLink } from "./loops";
import {
  closeSettings,
  initSettings,
  loadTodoistProjects,
  onAuthAccounts,
  onAuthStatus,
  onLapoStatus,
  onPipelineMetrics,
  onTodoistStatus,
  openSettings,
  renderEnvCards,
  renderServerCards,
  renderTodoistPanel,
  todoistProjectLinks,
  todoistProjectName,
  todoistProjectOptions,
} from "./settings";
// The composer seam (the input box + send path, per-session drafts, sent-prompt history, the `/`
// slash-command autocomplete, attachment staging, select-to-quote, and the copied-markdown anchor
// strip) lives in composer.ts (P7 decomposition). Importing it here makes its module body — the
// #input element ref + the composer-owned state — evaluate before this one. Its DOM wiring runs via
// initComposer(...), called below at the original composer wiring point; this module keeps using
// `input`/`saveDraft`/`restoreDraft`/`autoGrow`/`updateSendState` for the session-switch draft
// stash, the prompt-library insert, and the Escape blur.
import { autoGrow, initComposer, input, restoreDraft, saveDraft, updateSendState } from "./composer";
// The side-panel seam (panel chrome, file browser + reader, the XTerm terminal, the Git panel, and
// the links-panel chrome renderLinks) lives in panel.ts (P7 decomposition). Importing it here makes
// its module body — including the panel-owned early-init scalars (`panelView`/`readerPath`/`xterm`,
// exported live bindings this module only reads) — evaluate before this one, preserving the
// declare-up-top guarantee for the instant-restore render below (clearReferences() reads panelView
// at load). Its deps are injected via initPanel(...), called below at the original side-panel
// wiring point; session lifecycle (killSession/purgeSessionLocally) stays HERE and is handed in.
import {
  closePanel,
  initPanel,
  activeTermId,
  closePanelForDeselect,
  flushPinnedBoot,
  noteTerminalData,
  noteTerminalExit,
  openPanel,
  panel,
  resyncTerminal,
  panelView,
  readerPath,
  renderFiles,
  renderLinks,
  renderReader,
  renderTermStrip,
  reopenPanelForSession,
  requestGitStatus,
  resetPanelForSession,
  showGitResult,
  updateGitPanelMeta,
  wirePanelOutsideDismiss,
  xterm,
} from "./panel";
// The dialogs seam (header dropdown-menu machinery, the modal layer + the new-session/one-off/
// environment dialogs and their pickers, the themed confirm/pick dialogs, the inline permission +
// question cards, and toast) lives in dialogs.ts (P7 decomposition). It's a low-level LEAF: fleet /
// settings / autopilot / conversation / composer / panel import showModal/closeModal/confirmDialog/
// toast/… from it directly (no injected copies), and everything dialog code needs from those
// higher modules is injected via initDialogs(...), called below at the original header-menu/modal
// wiring point in module init. The menu wirings that read THIS module's state (#btn-prompts,
// #btn-more, the model pill, the account chip) stay here and call the imported toggleHeaderMenu.
import {
  clearPermissionCards,
  clearQuestionCards,
  closeModal,
  confirmDialog,
  handleDirsResult,
  iconPickerMarkup,
  initDialogs,
  resolvePermissionUI,
  resolveQuestionUI,
  selectedIcon,
  showModal,
  showNewSession,
  showPermission,
  showQuestion,
  toast,
  toggleHeaderMenu,
  wireIconPicker,
} from "./dialogs";

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
};
import { GOAL_MAX_ITERATIONS, MODELS, modelLabel, type Model } from "../../protocol";
import type {
  ContentBlock,
  ConversationEvent,
  Environment,
  FileOffer,
  Prompt,
  ServerEvent,
  Session,
  rest,
} from "../../protocol";
import { envOrdinal, sessionBg } from "./sessionColor";
import { OutboxQueue, newCid, type OutboxItem } from "./outbox";
import { telemetry } from "./telemetry";
import { canDeltaResume } from "./resume";
import { convoCache, migrateLegacyConvoCache } from "./convoCache";

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
// (`dragging`/`justDragged` live in sidebar.ts, the conversation-owned scalars —
// `thinkingEl`/`activity*`/`references`/`pendingAnswerRefs` — live in conversation.ts, and the
// panel-owned `panelView`/`readerPath` live in panel.ts, each with the code that owns them; all
// three modules are imported above, so they still initialize before this module's body runs.)

// ── Multi-server connection layer (fleet — anvil-multi-server.md §4) ──────────────────────
// The whole layer now lives in fleet.ts (P7 decomposition) — the Server registry, the per-server
// AnvilSocket management, and the outbound routing maps, plus the Settings → Fleet admin UI. Because
// fleet.ts is imported above, its module body evaluates BEFORE this one, which preserves the old
// declare-up-top guarantee: the instant-restore render below calls orderedServers() → reads
// `servers`/`HUB_URL` and both are already initialized (see memory: web-early-init-decl-order-crash).
// Sockets still connect below, after the outbox state onStatus reads is initialized. Everything fleet
// code needs from this module is injected here, before any socket exists; the function references are
// hoisted declarations or autopilot.ts imports (initialized at its module eval, above). The modal/
// toast helpers are no longer injected anywhere — fleet (like every other module) imports them from
// dialogs.ts directly.
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
// references are hoisted declarations; the dialog helpers it used to receive here are imported from
// dialogs.ts directly now.
initAutopilot({
  sessions,
  environments,
  sendAwait,
  selectSession,
  renderTodoistPanel,
});
// Loops home deps (same timing contract as initAutopilot — runs during module init before any socket
// connects or the #loops deep link fires).
initLoops({
  environments,
  sendAwait,
  selectSession,
});
// Settings deps (P7 — see settings.ts). Same timing contract as initFleet/initSidebar/initAutopilot
// above: this runs during module init, BEFORE any socket connects or the settings overlay can open —
// so every settings entry point sees its deps assigned. The function references are hoisted
// declarations; `activeId` is a reassigned scalar declared further down, so it's injected as a lazy
// read. The dialog helpers + environment modals it used to receive here are imported from
// dialogs.ts directly now.
initSettings({
  sessions,
  environments,
  activeId: () => activeId,
  sendAwait,
  setThemePref,
  showEditPrompt,
  renderPromptsPanel,
  updateHeaderAccount,
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
// A `#loops` (or `#loops/<id>`) deep link opens the Loops home on boot (notification tap / shared link).
const deepLinkedLoops = loopsFromHash();
let activeId: string | null = deepLinkedSession || localStorage.getItem("anvil.active");
setSessionHash(activeId, false); // canonicalize the URL (also strips any ?session=)
// The cid of a session.create we kicked off from the new-session dialog now lives on
// `ui.pendingCreateCid` (state.ts): the dialog (dialogs.ts) writes it, the event router below
// reads/clears it — a reassigned cross-module scalar.
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
  if (loopsFromHash()) {
    openLoopsDeepLink(); // external #loops (or #loops/<id>) deep link → open the Loops home
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
//
// [WEB2-6] The cache is bounded: cloning + serializing the ENTIRE transcript on every turn cost
// 30–150ms on long sessions (per debounced save, on the main thread). The cache exists for one
// thing — an instant paint on reload — so serializeTranscript (conversation.ts) only clones the
// last CONVO_CACHE_MAX_NODES top-level blocks, keeping the per-save DOM work constant. Restore is
// unchanged for the common case (sessions under the cap serialize in full, byte-identical to the
// old whole-pane clone); a very long session restores its most recent blocks instantly and resume
// replays the live tail on top — older scrollback comes back with the next full snapshot rather
// than living in the cache.
const CONVO_CACHE_MAX_NODES = 200;
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
      // Persist to IndexedDB (spec D8) — no 1.5MB cliff, so a long transcript stays cached and
      // delta-resumable instead of silently dropping to a full snapshot on the next reload.
      // serializeTranscript strips transient UI (thinking / empty state) and freezes any live
      // activity block to "Worked" — the cache is a snapshot, not a running turn.
      void convoCache.set(id, serializeTranscript(CONVO_CACHE_MAX_NODES));
    } catch {
      /* best-effort — the snapshot still loads from the daemon */
    }
  }, 600);
}

// Conversation deps (P7 — see conversation.ts). Same timing contract as initFleet/initSidebar:
// this runs during module init, BEFORE the instant-restore renderEmptyState()/loadConversation()
// calls below, so every conversation entry point sees its deps assigned. The reassigned scalar
// `activeId` is injected as a lazy read; `panelView`/`renderLinks` are panel.ts exports (its module
// evaluated above, so the live binding/function are initialized). `toast`/`clearCardMaps` are no
// longer injected — conversation.ts imports both from dialogs.ts (the card maps live there now).
initConversation({
  activeId: () => activeId,
  activeServer,
  sessions,
  environments,
  snapshotLoaded,
  saveConvoCache,
  setStatus,
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
else if (deepLinkedLoops) queueMicrotask(() => openLoopsDeepLink()); // #loops / #loops/<id> deep link → open the Loops home

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
        flushPinnedBoot(); // restore a pinned panel now that this socket is provably live (one-shot)
        resyncTerminal(); // daemon restart / dropped open: heal a mounted terminal (no-op when healthy)
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
      if (cid && cid === ui.pendingCreateCid) {
        ui.pendingCreateCid = null;
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
        renderTermStrip(); // roster changes (open/exit/kill on any device) refresh the chip strip
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
        srv!.sock.send({ type: "loops.get" }); // active loops for the Loops panel
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
      if (url !== HUB_URL && ui.todoistConnected && e.serverId) {
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
    case "loops.snapshot":
      onLoopsSnapshot(url, e.loops); // Autopilot Loops panel (writes the shared serverLoops cache)
      onLoopsHome(); // Loops home re-renders from that cache (coexists through Phases 1–3)
      return;
    case "loops.list":
      onLoopsList(url, e.loops); // the real Loop-entity catalog
      return;
    case "loop.updated":
      onLoopUpdated(url, e.loop);
      return;
    case "loop.run":
      onLoopRun(e.run); // live run/lap update
      return;
    case "loop.runs":
      onLoopRuns(e.loopId, e.runs);
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
      handleDirsResult(e);
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
      // [WEB2-9] Replay is batched: scrollDown is a no-op while `replayingSnapshot` is set (each call
      // forces a layout — O(n²) on large transcripts), so issue the ONE scroll for the whole snapshot
      // here. Unforced: it follows the bottom exactly as the per-message calls used to.
      scrollDown();
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
      if ((e.termId ?? "1") === activeTermId) {
        noteTerminalData(); // feeds the lost-replay watchdog + reconnect resync in panel.ts
        xterm?.write(b64ToBytes(e.data));
      }
      return;
    case "terminal.exit":
      if ((e.termId ?? "1") === activeTermId) {
        noteTerminalExit(); // an on-screen exit means "restart is the chip's job" — resync must not respawn
        xterm?.write(`\r\n\x1b[90m[process exited: ${e.code}] — click the terminal's chip to restart\x1b[0m\r\n`);
      }
      return;
    case "error":
      toast(e.message);
      return;
  }
}

// (The in-conversation file-link click listener that opens the reader moved to panel.ts — wired
// via initPanel below.)

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
// initConversation(...) above. The links side-PANEL chrome (renderLinks) lives in panel.ts with
// the rest of the side panel — it writes panelView/panelContent/setPanelTabs (side-panel state) —
// and is handed to conversation.ts as the `renderLinks` dep so a reference-set change refreshes an
// open panel.

/** No session selected: reset the title, show the empty state, drop the persisted active id. */
function deselectSession(): void {
  saveDraft(activeId, input.value); // keep the unsent draft with the session we're leaving
  closePanelForDeselect(); // don't leave a (pinned) panel showing the dead session's terminal (BUG-3)
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
  const list = ui.claudeAccounts?.accounts ?? [];
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
    const defaultId = ui.claudeAccounts?.defaultId;
    const nowLabel = ui.claudeAccounts?.accounts.find((a) => a.id === defaultId)?.label ?? "the default";
    el.innerHTML = `${icon("warning")}<span class="hb-name">${esc(nowLabel)} ⚠ was ${esc(oldLabel)}</span>`;
    el.title = `“${oldLabel}” was removed — this session fell back to “${nowLabel}”`;
    el.hidden = false;
    return;
  }
  const label = s.accountLabel ?? ui.claudeAccounts?.accounts.find((a) => a.id === s.accountId)?.label;
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
  const list = ui.claudeAccounts?.accounts ?? [];
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

// ── Settings & servers + integrations + model providers (moved to settings.ts — P7 decomposition) ──
// The Settings overlay + tabs, the server/environment cards, the Lapo + Todoist integration panels
// (incl. the autopilot maintenance card), and the Settings → Models providers (Claude account
// roster + OpenRouter key) all live in settings.ts; its deps are injected via initSettings(...)
// next to initFleet/initSidebar/initAutopilot above.

// ── Autopilot + scheduled run (moved to autopilot.ts — P7 decomposition) ────────────────────────
// The plan grid/reader, run log + status banner, badge, and the schedule controls all live in
// autopilot.ts; its deps are injected via initAutopilot(...) next to initFleet/initSidebar above.

// (Server cards, environment cards + the README toggle moved to settings.ts — P7 decomposition.)
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
  resetPanelForSession();
  reopenPanelForSession(); // pinned → same tab, new session; unpinned open panel → files (as before)
}

// ── Composer (moved to composer.ts — P7 decomposition) ───────────────────────────────────────────
// The input box + send path (online prompt.send vs the offline outbox enqueue + optimistic bubble),
// per-session drafts, sent-prompt history, the `/` slash-command autocomplete, attachment staging,
// select-to-quote, and the copied-markdown anchor strip all live in composer.ts. Its deps are
// injected HERE — at the original composer wiring point in module init — so the DOM listeners and
// the boot-time restoreDraft(activeId) run exactly when they always did. `activeId`/`readerPath`
// are reassigned scalars, injected as lazy reads (`readerPath` is panel.ts's exported live
// binding — the arrow only dereferences it at call time).
// The outbox flush/reconcile machinery stays above with the sockets; the composer's offline send
// path calls back into it via the injected `enqueue`.
initComposer({
  sessions,
  activeId: () => activeId,
  activeServer,
  enqueue,
  readerPath: () => readerPath,
});

// ── Side panel: files + reader + terminal + git + links (moved to panel.ts — P7 decomposition) ──
// The panel chrome (open/close/tabs), the file browser + drag-drop upload, the reader (pop-out +
// Android full-screen), the embedded XTerm terminal, the Git panel, and the links-panel chrome all
// live in panel.ts. Its deps are injected HERE — at the original side-panel wiring point in module
// init — so the moved DOM listeners (panel/tab buttons, the in-conversation file-link opener) run
// exactly when they always did; the click-outside-closes-panel pointerdown is wired separately
// below (wirePanelOutsideDismiss, after the menu-dismiss listener — that order is load-bearing).
// `killSession` is a hoisted declaration; the modal/toast helpers panel code uses come straight
// from dialogs.ts now. Session lifecycle (killSession + purgeSessionLocally below) stays here: it
// reassigns `activeId` and owns the persistence/caches.
initPanel({
  activeId: () => activeId,
  activeServer,
  sessions,
  killSession,
});

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


// ── Header menus + modals + dialogs + permission/question cards + toast (moved to dialogs.ts — P7) ──
// The dropdown machinery, the modal layer, the new-session/one-off/add-env/edit-env dialogs and
// their pickers, confirmDialog/confirmDialogWithOption/pickListDialog, the inline permission and
// question cards, and toast all live in dialogs.ts (a leaf module the other seams import directly).
// Its cross-module deps are injected HERE — at the original header-menu/modal wiring point in
// module init — so the moved menu-dismiss pointerdown registers exactly when it always did:
// BEFORE wirePanelOutsideDismiss() below (that relative order is load-bearing — see panel.ts).
initDialogs({
  activeId: () => activeId,
  sessions,
  environments,
  selectSession,
  persistSessions,
  enqueue,
  sendAwait,
  HUB_URL,
  servers,
  hub,
  orderedServers,
  envServer,
  serverOfEnv,
  sessionServer,
  persistRouting,
  sendTo,
  openSettings,
  closeSettings,
  loadTodoistProjects,
  todoistProjectOptions,
  todoistProjectLinks,
  todoistProjectName,
  conversation,
  dropSessionHero,
  hideThinking,
  showThinking,
  scrollDown,
});
// The header-menu ANCHORS stay here — they read this module's prompt library / panel imports.
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

// Click anywhere off the open side panel to dismiss it (panel.ts). Wired HERE, after the
// menu-dismiss pointerdown registered in initDialogs above: dismissOverlay pops the overlay stack
// synchronously, so with a menu open above an open panel the menu listener must run first — the
// panel listener then sees the menu gone and closes the panel too, one outside click unwinding
// both (as it always has).
wirePanelOutsideDismiss();

initSortables(); // wire up drag-to-reorder on the (always-present) session + finished lists
$("#open-settings").addEventListener("click", openSettings);
$("#open-autopilot").addEventListener("click", openAutopilot);
$("#open-loops").addEventListener("click", openLoops);
$("#new-session-top").addEventListener("click", () => showNewSession());
