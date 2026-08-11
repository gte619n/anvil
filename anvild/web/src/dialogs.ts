// ── Dialogs: header menus + modals + pickers + permission/question cards + toast ─────────────────
// Extracted verbatim from main.ts (P7 god-file decomposition). The seams here:
//   1. Header dropdown menus: the anchored dropdown machinery (toggleHeaderMenu) and its
//      click-outside dismiss. The concrete menu wirings (#btn-prompts, #btn-more, the model pill,
//      the account chip) stay in main.ts — they read main's prompt library / model / account state.
//   2. Modals: the modal layer (showModal/closeModal), the new-session / one-off / add-environment /
//      edit-environment dialogs and their shared picker fragments (autonomy, adversarial, account,
//      server, directory browser), plus the themed confirm/pick dialogs
//      (confirmDialog / confirmDialogWithOption / pickListDialog).
//   3. The color-swatch + icon pickers (environment color/icon; the icon picker is also used by
//      main's prompt editor, which imports it from here).
//   4. The inline permission cards and AskUserQuestion cards (§6.6) that live IN the conversation.
//   5. Toast.
//
// This module is a low-level LEAF: it imports only the other leaves (dom / overlays / state / theme /
// sessionColor / outbox) plus protocol + fleet TYPES (erased at compile time), so every other module
// (fleet, settings, autopilot, conversation, composer, panel) can import showModal/closeModal/
// confirmDialog/toast/… from here directly without forming an import cycle. Everything dialog code
// needs from those higher modules (the fleet registry/routing, the Todoist link helpers, the
// conversation pane hooks, main's session state) is injected once via initDialogs(deps) — mirroring
// fleet/sidebar/conversation/autopilot/settings/panel — during main's module init, before any
// socket connects.
//
// The moved top-level side effect (the menu-dismiss pointerdown) runs via initDialogs(...), which
// main calls at the original header-menu wiring point — BEFORE wirePanelOutsideDismiss(), the
// relative order that lets one outside click unwind a menu stacked over an open panel (see the note
// in panel.ts). Cross-module REASSIGNED scalars (`pendingCreateCid`, written here on create and
// read/cleared by main's event router) live on `ui` in state.ts; in-place containers
// (`permCards`/`questionCards`/`browse`) stay `const` here, the module that owns them.
import { $, busy, byEnvName, destroyModalSelects, enhanceSelect, envIcon, esc, icon, refreshSelect, slugify } from "./dom";
import { currentTheme } from "./theme";
import { ui } from "./state";
import { dismissOverlay, openOverlay, overlayOpen, overlays } from "./overlays";
import { PALETTE, stripeColor } from "./sessionColor";
import { newCid, type OutboxItem } from "./outbox";
import type { Server } from "./fleet";
import type {
  AutonomyPolicy,
  DirsListResultEvent,
  Environment,
  PermissionSuggestion,
  Question,
  QuestionAnswer,
  ServerEvent,
  Session,
} from "../../protocol";

// ── Injected dependencies (initDialogs) ──────────────────────────────────────────────────────────
// What dialog code calls back into main.ts (and, routed through main, fleet/settings/conversation —
// those modules import THIS one, so this one can't import them back). Each field documents the
// state it reaches.
export interface DialogsDeps {
  /** The currently-open session's id (main's `activeId` — a reassigned scalar, read at call time). */
  activeId(): string | null;
  /** The merged session list (main owns it — duplicate-name validation, offline creates). */
  sessions: Map<string, Session>;
  /** The merged environment list (main owns it — the new-session/env dialogs render it). */
  environments: Map<string, Environment>;
  /** Jump into a session (the offline-create path selects its optimistic session). */
  selectSession(id: string, push?: boolean): void;
  persistSessions(): void;
  /** Queue a write into main's outbox (offline session create, offline question answer). */
  enqueue(item: OutboxItem): void;
  /** cid-tracked request/response over a server's socket (main's `sendAwait` — env.clone). */
  sendAwait(server: Server, cmd: Record<string, unknown> & { type: string; cid: string }, timeoutMs?: number): Promise<ServerEvent>;
  // fleet.ts state/helpers (fleet imports this module, so they're injected, not imported):
  HUB_URL: string;
  servers: Map<string, Server>;
  hub(): Server;
  orderedServers(): Server[];
  envServer: Map<string, string>;
  serverOfEnv(envId: string | null | undefined): Server;
  sessionServer: Map<string, string>;
  persistRouting(): void;
  sendTo(sessionId: string | null | undefined, cmd: Record<string, unknown> & { type: string }): boolean;
  // settings.ts helpers (settings imports this module, so they're injected, not imported):
  openSettings(): void;
  closeSettings(): void;
  loadTodoistProjects(force?: boolean): Promise<void>;
  todoistProjectOptions(selectedId?: string, exceptEnvId?: string): string;
  todoistProjectLinks(exceptEnvId?: string): Map<string, { envName: string; serverName: string }>;
  todoistProjectName(id?: string): string | undefined;
  // conversation.ts hooks (conversation imports this module, so they're injected, not imported):
  /** The conversation pane element (permission/question cards append into it). */
  conversation: HTMLElement;
  dropSessionHero(): void;
  hideThinking(): void;
  showThinking(status: string): void;
  scrollDown(force?: boolean): void;
}
// Module-local mirrors of the injected deps, named exactly as in main.ts so the moved code below
// stays verbatim (main's reassigned `activeId` scalar becomes the call `activeId()`). Assigned once
// by initDialogs — which main.ts calls during its module init, before any socket exists — so no
// dialog entry point can observe them unset.
let activeId: DialogsDeps["activeId"];
let sessions: DialogsDeps["sessions"];
let environments: DialogsDeps["environments"];
let selectSession: DialogsDeps["selectSession"];
let persistSessions: DialogsDeps["persistSessions"];
let enqueue: DialogsDeps["enqueue"];
let sendAwait: DialogsDeps["sendAwait"];
let HUB_URL: DialogsDeps["HUB_URL"];
let servers: DialogsDeps["servers"];
let hub: DialogsDeps["hub"];
let orderedServers: DialogsDeps["orderedServers"];
let envServer: DialogsDeps["envServer"];
let serverOfEnv: DialogsDeps["serverOfEnv"];
let sessionServer: DialogsDeps["sessionServer"];
let persistRouting: DialogsDeps["persistRouting"];
let sendTo: DialogsDeps["sendTo"];
let openSettings: DialogsDeps["openSettings"];
let closeSettings: DialogsDeps["closeSettings"];
let loadTodoistProjects: DialogsDeps["loadTodoistProjects"];
let todoistProjectOptions: DialogsDeps["todoistProjectOptions"];
let todoistProjectLinks: DialogsDeps["todoistProjectLinks"];
let todoistProjectName: DialogsDeps["todoistProjectName"];
let conversation: DialogsDeps["conversation"];
let dropSessionHero: DialogsDeps["dropSessionHero"];
let hideThinking: DialogsDeps["hideThinking"];
let showThinking: DialogsDeps["showThinking"];
let scrollDown: DialogsDeps["scrollDown"];
export function initDialogs(deps: DialogsDeps): void {
  ({
    activeId,
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
  } = deps);
  browse.serverUrl = HUB_URL; // the browse-based modals default to the hub's filesystem

  // ── Moved top-level DOM wiring (runs at main's original header-menu wiring point) ──
  // Click outside an open menu closes it. The anchor buttons toggle themselves, so they're excluded.
  document.addEventListener("pointerdown", (e) => {
    if (!overlayOpen("menu")) return;
    const t = e.target as HTMLElement;
    if (t.closest(".header-menu") || t.closest("#btn-prompts") || t.closest("#btn-more")) return;
    closeHeaderMenu();
  });
}

// ── Header dropdown menus ─────────────────────────────────────────────────────
// Anchored dropdowns for header actions: the Prompts list, and (on phone) the ⋮ "More" overflow
// holding the Files/Links actions that are inline text buttons on wider screens. Each registers as a
// "menu" overlay so Back/Escape dismiss it like every other soft layer; only one is open at a time.
export interface HeaderMenuItem {
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
export const closeHeaderMenu = (): void => dismissOverlay("menu"); // programmatic close → unwind the back-stack
/** Open a dropdown of `items` under `anchor`; a second click on the same button just closes it. */
export function toggleHeaderMenu(anchor: HTMLElement, items: HeaderMenuItem[]): void {
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

// ── Modals ─────────────────────────────────────────────────────────────────────
let onDirs: ((e: DirsListResultEvent) => void) | null = null;
/** Fan a dirs.list_result event into the open browser-based modal (main's event router calls this). */
export function handleDirsResult(e: DirsListResultEvent): void {
  onDirs?.(e);
}
// `serverUrl` is the daemon whose filesystem we're browsing (add-env / one-off pick a server).
// (Seeded to the hub in initDialogs — HUB_URL is injected, so it isn't known at module eval.)
const browse = { path: "", parent: undefined as string | undefined, serverUrl: "" };
const browseServer = (): Server => servers.get(browse.serverUrl) ?? hub();

// [WEB2-8] Modal focus management: remember the element that opened the dialog, move focus into it,
// trap Tab inside it (wrap last → first, Shift+Tab first → last), and restore focus on close.
let modalRestoreFocus: HTMLElement | null = null;
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
function trapModalFocus(el: HTMLElement, box: HTMLElement): void {
  box.tabIndex = -1; // focusable fallback so a dialog with no interactive elements still takes focus
  const focusables = (): HTMLElement[] => [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((f) => !f.hasAttribute("disabled"));
  (focusables()[0] ?? box).focus();
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === box)) {
      e.preventDefault();
      last.focus(); // Shift+Tab off the first focusable wraps to the last
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus(); // Tab off the last focusable wraps back to the first
    }
  });
}

/** Mount a modal (replaces any current one in #modal-root) and register it on the back-stack so
 *  Back/Cancel dismisses it. Swapping one modal's contents for another reuses the same layer. */
export function showModal(el: HTMLElement): void {
  // [WEB2-8] Remember the opener only for a genuinely new modal layer — an in-place content swap
  // keeps the ORIGINAL opener, so closing the swapped dialog still restores where the user was.
  if (!overlayOpen("modal")) modalRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const root = $("#modal-root");
  root.innerHTML = "";
  root.appendChild(el);
  // [WEB2-8] The dialog surface (the .modal-box, or the mounted element itself) announces itself to
  // assistive tech and traps keyboard focus while it's open.
  const box = el.querySelector<HTMLElement>(".modal-box") ?? el;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  trapModalFocus(el, box);
  openOverlay("modal", closeModalDom); // no-op if a modal layer is already open (content swap)
}
/** Tear down the modal (DOM/state only). Reached via Back (popstate) or closeModal(). */
function closeModalDom(): void {
  onDirs = null;
  destroyModalSelects(); // drop Tom Select instances (and their document listeners) before the DOM goes
  $("#modal-root").innerHTML = "";
  modalRestoreFocus?.focus(); // [WEB2-8] hand focus back to the dialog's opener (no-op if it's gone)
  modalRestoreFocus = null;
}
export const closeModal = (): void => dismissOverlay("modal"); // programmatic close → unwind the back-stack
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
  const list = ui.claudeAccounts?.accounts ?? [];
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
  const list = ui.claudeAccounts?.accounts ?? [];
  if (list.length <= 1) return "";
  const opts = list.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join("");
  return `<label>Account<div class="env-row"><select id="ns-account">${opts}</select></div></label>`;
}
/** Pre-select the picker to `envId`'s default account, else the roster default. No-op if the picker
 *  isn't rendered (≤1 account). Called once on open and again on every environment change. */
function reselectAccountFor(envId: string | undefined): void {
  const sel = document.getElementById("ns-account") as HTMLSelectElement | null;
  if (!sel) return;
  const pick = (envId ? environments.get(envId)?.accountId : undefined) ?? ui.claudeAccounts?.defaultId;
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
export function showNewSession(): void {
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
      ui.pendingCreateCid = cid; // jump into this session when its session.created lands (see onEvent)
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
/** A grid of icon buttons plus an "auto" option; `selected` pre-selects one. (Also used by main's
 *  prompt editor.) */
export function iconPickerMarkup(selected?: string): string {
  const norm = (selected ?? "").trim();
  const auto = `<button type="button" class="iconpick iconpick-auto${norm ? "" : " selected"}" data-icon="" title="Auto — default by repo kind">${icon("hide_source")}</button>`;
  const cells = ENV_ICONS.map(
    (n) => `<button type="button" class="iconpick${n === norm ? " selected" : ""}" data-icon="${esc(n)}" title="${esc(n)}">${icon(n)}</button>`,
  ).join("");
  return `<label>Icon<div class="icon-row" id="icon-row">${auto}${cells}</div></label>`;
}
export function wireIconPicker(): void {
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
export function selectedIcon(): string {
  return document.querySelector<HTMLElement>("#icon-row .iconpick.selected")?.dataset.icon ?? "";
}

/** Register a project repo as an environment — clone from a git URL, or pick a local repo. */
export function showAddEnvironment(): void {
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
      // [WEB2-19] busy() owns the disable → "Cloning…" → restore lifecycle around the request.
      await busy($<HTMLButtonElement>("#ae-save"), "Cloning…", async () => {
        try {
          const res = await sendAwait(
            browseServer(),
            { type: "env.clone", url, ...(name ? { name } : {}), ...(defaultBase ? { defaultBase } : {}), ...(color ? { color } : {}), ...(iconName ? { icon: iconName } : {}), cid: newCid() },
            120_000,
          );
          if (res.type === "command.error") {
            toast(`Clone failed: ${res.message}`);
            return;
          }
          closeModal(); // the environments broadcast refreshes Settings / the new-session list
        } catch (e) {
          toast(`Clone failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
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
export function showEditEnvironment(id: string): void {
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
    ${ui.todoistConnected ? "" : `<p class="small muted">Connect Todoist (Settings → Todoist) to link a project.</p>`}
    ${envAccountPickerMarkup(env.accountId)}
    <p class="small muted">repo: <code>${esc(env.repoRoot)}</code>${env.isRepo ? "" : " (not a git repo)"}</p>
    <div class="btns"><button type="button" class="danger" id="ee-remove">Remove</button><span class="spacer" style="flex:1"></span><button type="button" id="ee-back">Back</button><button type="button" id="ee-save">Save</button></div></div>`;
  showModal(m);
  wireSwatchPicker();
  wireIconPicker();
  enhanceSelect(document.getElementById("ee-todoist") as HTMLSelectElement | null, true);
  enhanceSelect(document.getElementById("ee-account") as HTMLSelectElement | null);
  if (ui.todoistConnected && !ui.todoistProjectsLoaded) void loadTodoistProjects(); // names fill in on reopen
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

export function showPermission(requestId: string, tool: string, inputObj: unknown, suggestions: PermissionSuggestion[]): void {
  if (permCards.has(requestId)) return; // already shown (re-attach replay)
  dropSessionHero(); // a request landed in a blank session — retire the title card
  hideThinking(); // the turn is parked on this decision, not working
  const card = document.createElement("div");
  card.className = "bubble permission";
  card.setAttribute("role", "alert"); // [WEB2-8] announce the pending decision to assistive tech
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
      sendTo(activeId(), { type: "permission.respond", requestId, decision: s.decision });
      resolvePermissionUI(requestId, s.label);
    };
    btns.appendChild(b);
  }
  permCards.set(requestId, card);
  conversation.appendChild(card);
  scrollDown();
}

/** Mark a permission card answered: lock its buttons, show the choice, then fade it out. */
export function resolvePermissionUI(requestId: string, label?: string): void {
  const card = permCards.get(requestId);
  if (!card) return;
  permCards.delete(requestId);
  card.classList.add("resolved");
  card.querySelectorAll<HTMLButtonElement>(".perm-btn").forEach((b) => (b.disabled = true));
  const btns = card.querySelector(".perm-btns");
  if (btns && label) btns.innerHTML = `<span class="perm-done">${icon("check")} ${esc(label)}</span>`;
}

/** A session left awaiting_permission (answered here, on another device, or superseded). */
export function clearPermissionCards(): void {
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

/** Forget the per-request permission/question card maps (the cards themselves are detached when the
 *  conversation pane is cleared — conversation.ts calls this from clearConversation). */
export function clearCardMaps(): void {
  permCards.clear();
  questionCards.clear();
}

export function showQuestion(requestId: string, questions: Question[]): void {
  if (questionCards.has(requestId)) return; // already shown (re-attach replay)
  dropSessionHero(); // a question landed in a blank session — retire the title card
  hideThinking(); // the turn is parked on the answer, not working
  const card = document.createElement("div");
  card.className = "bubble question";
  card.setAttribute("role", "alert"); // [WEB2-8] announce the pending question to assistive tech
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
  if (!sendTo(activeId(), cmd)) enqueue({ cid: newCid(), cmd }); // route to the active session's server
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
export function resolveQuestionUI(requestId: string, label?: string): void {
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
export function clearQuestionCards(): void {
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

// [WEB2-18] The one modal-promise primitive. confirmDialog / confirmDialogWithOption /
// pickListDialog used to hand-roll this whole skeleton three times over: build the backdrop +
// mount it, guard a one-shot `done` that resolves BEFORE teardown (so an explicit choice wins over
// the cancel-on-close below), augment the modal layer's teardown so any other dismissal (Escape,
// device Back, backdrop tap) still resolves with the cancel value (the awaiting caller must never
// hang), and wire the backdrop-click cancel. Now they're thin wrappers: `wire` attaches the
// dialog-specific buttons/focus onto the mounted markup and calls `done(value)`.
function modalPromise<T>(boxHtml: string, cancelValue: T, wire: (m: HTMLElement, done: (v: T) => void) => void): Promise<T> {
  return new Promise((resolve) => {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = boxHtml;
    showModal(m);
    let settled = false;
    const done = (v: T): void => {
      if (settled) return;
      settled = true;
      resolve(v); // resolve BEFORE teardown so the explicit choice wins over the cancel-on-close below
      closeModal();
    };
    // Dismissing the dialog any other way (Escape, device Back, backdrop tap) counts as Cancel — and,
    // crucially, must resolve the promise so the awaiting caller doesn't hang. Augment this modal
    // layer's teardown to resolve the cancel value; whichever resolve runs first wins (one-shot).
    const top = overlays[overlays.length - 1];
    if (top && top.name === "modal") {
      const origClose = top.close;
      top.close = () => {
        origClose();
        if (!settled) {
          settled = true;
          resolve(cancelValue);
        }
      };
    }
    m.addEventListener("click", (e) => {
      if (e.target === m) done(cancelValue); // click backdrop to cancel
    });
    wire(m, done);
  });
}

/** Themed replacement for window.confirm — resolves true if confirmed. */
export function confirmDialog(opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean; icon?: string }): Promise<boolean> {
  return modalPromise(
    `<div class="modal-box">
      <h3>${opts.icon ? icon(opts.icon) + " " : ""}${esc(opts.title)}</h3>
      ${opts.body ? `<p class="small muted">${esc(opts.body)}</p>` : ""}
      <div class="btns"><button type="button" id="cd-cancel">Cancel</button><button type="button" id="cd-ok" class="${opts.danger ? "danger" : "primary"}">${esc(opts.confirmLabel ?? "OK")}</button></div>
    </div>`,
    false,
    (_m, done) => {
      $<HTMLButtonElement>("#cd-ok").onclick = () => done(true);
      $<HTMLButtonElement>("#cd-cancel").onclick = () => done(false);
      // Focus a default button so Enter confirms; a destructive dialog defaults to the safe Cancel.
      (opts.danger ? $<HTMLButtonElement>("#cd-cancel") : $<HTMLButtonElement>("#cd-ok")).focus();
    },
  );
}

/** A single-line text prompt dialog (replaces window.prompt, which the WebView shells don't support and
 *  jsdom can't run). Resolves the trimmed text, or null if cancelled / left blank. */
export function promptDialog(opts: { title: string; placeholder?: string; confirmLabel?: string; icon?: string; multiline?: boolean }): Promise<string | null> {
  const field = opts.multiline
    ? `<textarea id="pd-input" rows="3" placeholder="${esc(opts.placeholder ?? "")}"></textarea>`
    : `<input type="text" id="pd-input" placeholder="${esc(opts.placeholder ?? "")}" />`;
  return modalPromise<string | null>(
    `<div class="modal-box">
      <h3>${opts.icon ? icon(opts.icon) + " " : ""}${esc(opts.title)}</h3>
      <label class="ap-field">${field}</label>
      <div class="btns"><button type="button" id="pd-cancel">Cancel</button><button type="button" id="pd-ok" class="primary">${esc(opts.confirmLabel ?? "OK")}</button></div>
    </div>`,
    null,
    (_m, done) => {
      const input = $<HTMLInputElement | HTMLTextAreaElement>("#pd-input");
      const submit = (): void => {
        const v = input.value.trim();
        done(v ? v : null);
      };
      $<HTMLButtonElement>("#pd-ok").onclick = submit;
      $<HTMLButtonElement>("#pd-cancel").onclick = () => done(null);
      if (!opts.multiline) input.onkeydown = (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); };
      input.focus();
    },
  );
}

/** Like confirmDialog, but with one extra checkbox toggle. Resolves { ok, checked }; cancelling
 *  (button, Escape, Back, backdrop) resolves { ok:false } and the checkbox state is irrelevant. */
export function confirmDialogWithOption(opts: {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  icon?: string;
  optionLabel: string;
  optionChecked?: boolean;
}): Promise<{ ok: boolean; checked: boolean }> {
  return modalPromise<{ ok: boolean; checked: boolean }>(
    `<div class="modal-box">
      <h3>${opts.icon ? icon(opts.icon) + " " : ""}${esc(opts.title)}</h3>
      ${opts.body ? `<p class="small muted">${esc(opts.body)}</p>` : ""}
      <label class="cd-option"><input type="checkbox" id="cd-option"${opts.optionChecked ? " checked" : ""}> ${esc(opts.optionLabel)}</label>
      <div class="btns"><button type="button" id="cd-cancel">Cancel</button><button type="button" id="cd-ok" class="${opts.danger ? "danger" : "primary"}">${esc(opts.confirmLabel ?? "OK")}</button></div>
    </div>`,
    { ok: false, checked: false },
    (_m, done) => {
      const checked = (): boolean => $<HTMLInputElement>("#cd-option").checked;
      $<HTMLButtonElement>("#cd-ok").onclick = () => done({ ok: true, checked: checked() }); // checkbox read at confirm time
      $<HTMLButtonElement>("#cd-cancel").onclick = () => done({ ok: false, checked: false });
      (opts.danger ? $<HTMLButtonElement>("#cd-cancel") : $<HTMLButtonElement>("#cd-ok")).focus();
    },
  );
}

/** Pick one item from a list (link a plan to a session, reassign a plan's environment, …). Resolves the
 *  chosen id, or null if cancelled (button, Escape, Back, backdrop). */
export function pickListDialog(title: string, items: { id: string; label: string; icon?: string }[], headIcon = "link"): Promise<string | null> {
  return modalPromise<string | null>(
    `<div class="modal-box">
      <h3>${icon(headIcon)} ${esc(title)}</h3>
      <div class="pick-list">${items
        .map((it) => `<button type="button" class="pick-item" data-id="${esc(it.id)}">${icon(it.icon ?? "terminal")} ${esc(it.label || it.id)}</button>`)
        .join("")}</div>
      <div class="btns"><button type="button" id="cd-cancel">Cancel</button></div>
    </div>`,
    null,
    (m, done) => {
      m.querySelectorAll<HTMLElement>(".pick-item").forEach((b) => (b.onclick = () => done(b.dataset.id!)));
      $<HTMLButtonElement>("#cd-cancel").onclick = () => done(null);
    },
  );
}
