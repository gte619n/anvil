// ── Settings: the management overlay (servers / environments / integrations / models) ────────────
// Extracted verbatim from main.ts (P7 god-file decomposition). The seams here:
//   1. Settings & servers (first-class management area): the overlay + tabs, the Settings → Servers
//      fleet cards (per-Mac account-sync line + the "this phone" ADB card) and the environment
//      cards (README toggle).
//   2. The Lapo integration (OAuth2 information-entry reports): status card + connect/disconnect.
//   3. The Todoist integration: token connect, the project table, the env↔project link helpers the
//      environment modal also uses, and the autopilot maintenance card (reset tags / clear).
//   4. Model providers (Settings → Models): the Claude account roster (add / rename / replace /
//      set-default / remove, plus the legacy single-token card), the OpenRouter key, and the
//      adversary calibration card (§6.3).
//
// This module evaluates BEFORE main.ts's body (main imports it), so the settings-owned scalars
// (settingsTab, the lapo*/todoist* status snapshots, the provider auth snapshots) initialize at
// module eval, before any main entry point can reach them. Nothing here runs at import time: every
// entry point is a function main calls (the event router, openSettings, the initFleet/initAutopilot
// dep wiring).
//
// main.ts ↔ settings.ts wiring: settings.ts never imports from main.ts. Everything settings code
// needs from main (the merged session/environment maps, sendAwait, the theme setter, the prompt
// modal openers, the header account chip) is injected once via
// initSettings(deps) — mirroring fleet/sidebar/conversation/autopilot — during main's module init.
// Cross-module REASSIGNED scalars main still reads (`claudeAccounts` for the header chip + account
// pickers; `todoistConnected`/`todoistProjectsLoaded` for the environment modal and the member
// token-propagation check) live on `ui` in state.ts; in-place containers (`todoistProjects`,
// `readmeLoaded`) stay `const` here.
import { apiFetch } from "./api";
import { $, busy, byEnvName, envIcon, esc, icon } from "./dom";
// dialogs.ts is a leaf, so the modal/toast helpers and the environment modals are direct imports —
// they used to arrive via initSettings(deps).
import { closeModal, confirmDialog, showAddEnvironment, showEditEnvironment, showModal, toast } from "./dialogs";
import { currentTheme, updateThemeControls } from "./theme";
import type { ThemePref } from "./theme";
import { ui } from "./state";
import { dismissOverlay, openOverlay } from "./overlays";
import { nativeBridge } from "./push";
import { refreshSetupState } from "./setup";
import { stripeColor } from "./sessionColor";
import { newCid } from "./outbox";
import { runMermaid } from "./conversation";
import { openScheduleModal, scheduleSettingsCardHtml } from "./autopilot";
import {
  HUB_URL,
  confirmRemoveServer,
  cssId,
  envServer,
  fleetMemberAccountsRev,
  fleetMemberIdByHost,
  hostOf,
  hostnameOf,
  hub,
  loadFleetMembers,
  maybeRenderAdoptHubCard,
  maybeRenderRepairCard,
  orderedServers,
  rehydrateFleetRollout,
  rosterServer,
  rotateFleetToken,
  serverFetch,
  serverOfEnv,
  serverSupports,
  servers,
  showAddMac,
  startFleetUpdate,
  wireDaemonUpdate,
  type Server,
} from "./fleet";
import type { AccountInfo, AuthAccountsEvent, AuthStatusEvent, Environment, PipelineAdversaryStat, ServerEvent, Session, TodoistProjectInfo } from "../../protocol";

// ── Injected dependencies (initSettings) ─────────────────────────────────────────────────────────
// What settings code calls back into main.ts for. Each field documents the main.ts state it reaches.
export interface SettingsDeps {
  /** The merged session list (main owns it — a roster change repaints the header account chip). */
  sessions: Map<string, Session>;
  /** The merged environment list (env cards, the Todoist project↔env link lookups). */
  environments: Map<string, Environment>;
  /** The currently-open session's id (main's `activeId` — a reassigned scalar, so it's injected as
   *  a getter; the moved code only dereferences it at call time). */
  activeId(): string | null;
  /** cid-tracked request/response over a server's socket (main's `sendAwait`). */
  sendAwait(server: Server, cmd: Record<string, unknown> & { type: string; cid: string }, timeoutMs?: number): Promise<ServerEvent>;
  /** Theme choice (Settings → Appearance) — the pref scalar stays in main next to the boot apply. */
  setThemePref(pref: ThemePref): void;
  /** The prompt-library editor + panel (stay in main with the composer they feed). */
  showEditPrompt(id?: string): void;
  renderPromptsPanel(): void;
  /** The header account chip (multi-account §5) — a roster change repaints it live. */
  updateHeaderAccount(s: Session | undefined): void;
}
// Module-local mirrors of the injected deps, named exactly as in main.ts so the moved code below
// stays verbatim (main's reassigned `activeId` scalar becomes the call `activeId()`). Assigned once
// by initSettings — which main.ts calls during its module init, before any socket exists or the
// settings overlay can open — so no settings entry point can observe them unset.
let sessions: SettingsDeps["sessions"];
let environments: SettingsDeps["environments"];
let activeId: SettingsDeps["activeId"];
let sendAwait: SettingsDeps["sendAwait"];
let setThemePref: SettingsDeps["setThemePref"];
let showEditPrompt: SettingsDeps["showEditPrompt"];
let renderPromptsPanel: SettingsDeps["renderPromptsPanel"];
let updateHeaderAccount: SettingsDeps["updateHeaderAccount"];
export function initSettings(deps: SettingsDeps): void {
  ({
    sessions,
    environments,
    activeId,
    sendAwait,
    setThemePref,
    showEditPrompt,
    renderPromptsPanel,
    updateHeaderAccount,
  } = deps);
}

// ── Settings & servers (first-class management area) ──────────────────────────────
type SettingsTab = "servers" | "environments" | "integrations" | "models" | "appearance" | "prompts";
let settingsTab: SettingsTab = "environments";
export function openSettings(): void {
  const root = $("#settings-root");
  root.innerHTML = `<div class="settings-view">
    <div class="settings-head">
      <h2>${icon("tune")} Settings &amp; Servers</h2>
      <button id="settings-close" class="icon-btn" title="Close">${icon("close")}</button>
    </div>
    <div class="settings-tabs" role="tablist">
      <button class="stab" role="tab" data-tab="environments">${icon("folder")} Environments</button>
      <button class="stab" role="tab" data-tab="servers">${icon("dns")} Servers</button>
      <button class="stab" role="tab" data-tab="integrations">${icon("extension")} Integrations</button>
      <button class="stab" role="tab" data-tab="models">${icon("smart_toy")} Models</button>
      <button class="stab" role="tab" data-tab="prompts">${icon("bookmark")} Prompts</button>
      <button class="stab" role="tab" data-tab="appearance">${icon("palette")} Appearance</button>
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
  document.querySelectorAll<HTMLElement>(".settings-view .stab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
    t.setAttribute("aria-selected", String(t.dataset.tab === tab)); // [WEB2-8] the tablist's buttons are real tabs
  });
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

export function onLapoStatus(connected: boolean, configured: boolean, account?: string, callbackUrl?: string): void {
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
  // [WEB2-19] busy() owns the disable → "Connecting…" → restore lifecycle around the request.
  await busy(btn, "Connecting…", async () => {
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
    }
  });
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
// `ui.todoistConnected` / `ui.todoistProjectsLoaded` live in state.ts: settings reassigns them, and
// main still reads them (the environment modal + the member token-propagation check).
let todoistAccount: string | undefined;
const todoistProjects = new Map<string, TodoistProjectInfo>();

export const todoistProjectName = (id?: string): string | undefined => (id ? todoistProjects.get(id)?.name : undefined);

/** <option> list for the env link select; keeps the current link selectable even if not yet cached. */
/** Where each Todoist project is already linked (env on ANY fleet server), excluding `exceptEnvId`.
 *  A project maps to exactly ONE environment — otherwise two daemons would plan the same tasks. */
export function todoistProjectLinks(exceptEnvId?: string): Map<string, { envName: string; serverName: string }> {
  const links = new Map<string, { envName: string; serverName: string }>();
  for (const e of environments.values()) {
    if (!e.todoistProjectId || e.id === exceptEnvId) continue;
    const srvUrl = envServer.get(e.id);
    const srv = srvUrl ? servers.get(srvUrl) : undefined;
    links.set(e.todoistProjectId, { envName: e.name, serverName: srv?.name ?? hostOf(srvUrl ?? "") });
  }
  return links;
}

export function todoistProjectOptions(selectedId?: string, exceptEnvId?: string): string {
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

export function onTodoistStatus(connected: boolean, account?: string): void {
  ui.todoistConnected = connected;
  todoistAccount = account;
  if (document.getElementById("todoist-panel")) renderTodoistPanel();
}

/** Fetch the account's projects (live) and cache them; `force` re-fetches even if already loaded. */
export async function loadTodoistProjects(force = false): Promise<void> {
  if (!ui.todoistConnected) return;
  if (ui.todoistProjectsLoaded && !force) return;
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
    ui.todoistProjectsLoaded = true;
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
  // [WEB2-19] busy() owns the disable → "Connecting…" → restore lifecycle around the request.
  await busy(btn, "Connecting…", async () => {
    try {
      const res = await sendAwait(hub(), { type: "todoist.connect", token: t, cid: newCid() }, 20_000);
      if (res.type === "command.error") {
        toast(res.message);
        return; // onTodoistStatus only fires on success → stay on the entry form
      }
      ui.todoistProjectsLoaded = false; // a (possibly new) account → refetch projects
      // The connected `todoist.status` arrives via onTodoistStatus and re-renders the panel.
      // Replicate the token to every fleet member (hub-side, server→server) so autopilot can run
      // wherever a linked environment lives. Fire-and-forget; members also self-heal on reconnect.
      if (orderedServers().some((s) => s.url !== HUB_URL)) {
        hub().sock.send({ type: "todoist.propagate", cid: newCid() });
        toast("Sharing the Todoist token across your fleet…");
      }
    } catch (err) {
      toast(`Couldn't connect Todoist: ${err instanceof Error ? err.message : err}`);
    }
  });
}

export function renderTodoistPanel(): void {
  const host = document.getElementById("todoist-panel");
  if (!host) return;
  if (!ui.todoistConnected) {
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
  if (!ui.todoistProjectsLoaded) {
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
    ui.todoistProjectsLoaded = false;
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
export function closeSettings(): void {
  $("#settings-root").innerHTML = "";
}

// ── Model providers (Settings → Models) ───────────────────────────────────────────
// The daemon drives Claude (Agent SDK); the token is set/reset here so it doesn't require SSHing in to
// edit the launcher env. OpenRouter powers the adversarial planning panel (a separate metered key). Both
// are hub-scoped, like Todoist.
type ProviderAuth = { connected: boolean; persisted: boolean; masked?: string };
let claudeAuth: ProviderAuth | null = null;
let openRouterAuth: ProviderAuth | null = null;
export function onAuthStatus(e: AuthStatusEvent): void {
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
// this, so renderModelsPanel falls back to the single-token card in that case. The snapshot lives on
// `ui.claudeAccounts` (state.ts): settings reassigns it, and main still reads it (the header account
// chip + switch menu, and the new-session/environment account pickers).
export function onAuthAccounts(e: AuthAccountsEvent): void {
  ui.claudeAccounts = e;
  if (document.getElementById("models-panel")) renderModelsPanel();
  // The header chip appears/disappears at the 1↔2-account boundary and shows a label the roster owns,
  // so a roster change has to repaint it even when no session.updated follows.
  updateHeaderAccount(activeId() ? sessions.get(activeId()!) : undefined);
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
  // [WEB2-19] busy() owns the disable → "Saving…" → restore lifecycle around the request.
  await busy(btn, "Saving…", async () => {
    try {
      const res = await sendAwait(hub(), { type: "auth.set", token: t, cid: newCid() }, 20_000);
      if (res.type === "command.error") {
        toast(res.message); // e.g. "that looks like a metered API key…"
        return;
      }
      toast("Claude token saved — it applies to the next run."); // the auth.status reply/broadcast re-renders
    } catch (err) {
      toast(`Couldn't save the token: ${err instanceof Error ? err.message : err}`);
    }
  });
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
  // [WEB2-19] busy() owns the disable → "Saving…" → restore lifecycle around the request.
  await busy(btn, "Saving…", async () => {
    try {
      const res = await sendAwait(hub(), { type: "auth.set", provider: "openrouter", token: k, cid: newCid() }, 20_000);
      if (res.type === "command.error") {
        toast(res.message);
        return;
      }
      toast("OpenRouter key saved — the adversarial panel applies it on the next autopilot run.");
    } catch (err) {
      toast(`Couldn't save the key: ${err instanceof Error ? err.message : err}`);
    }
  });
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
export function onPipelineMetrics(stats: PipelineAdversaryStat[]): void {
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
    serverSupports(rosterServer(), "accounts") && ui.claudeAccounts ? accountsSection(ui.claudeAccounts, persistWarn) : legacyClaudeSection(tokenForm, persistWarn);
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
  if (serverSupports(rosterServer(), "accounts") && ui.claudeAccounts) {
    wireAccountsSection(ui.claudeAccounts);
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
  const inUse = ui.claudeAccounts?.inUse?.[accountId] ?? [];
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
  const roster = ui.claudeAccounts;
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
export function renderServerCards(): void {
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
export function renderEnvCards(): void {
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
