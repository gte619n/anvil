// ── Autopilot: plan review & launch + the scheduled-run controls ─────────────────────────────────
// Extracted verbatim from main.ts (P7 god-file decomposition). The seams here:
//   1. The Autopilot view (anvil-autopilot-ui.md): the plan card grid (grouped by server/environment),
//      the full-plan reader + its actions (Start / Plan with Claude / Pipeline / Dismiss / Resolve /
//      Reassign / Link), the pipeline trace card, the run log + live run-status banner, the sidebar
//      badge/spinner, and the run-progress/snapshot handlers main's event router fans into.
//   2. The scheduled run (in-daemon timer; the control targets the hub): the schedule bar in the
//      Autopilot view, the Settings → Todoist schedule card, and the schedule modal.
//
// This module evaluates BEFORE main.ts's body (main imports it), which structurally retires the
// historical [WEB2-1] TDZ class for this seam: `serverSchedule` / `autopilotLog` / `runState` — the
// scalars a cold #p/<id> deep link used to reach ~3000 lines before their declarations — now
// initialize at module eval here, before main's init chain can call openAutopilot/openPlanDeepLink
// (see memory: web-early-init-decl-order-crash). Nothing here runs at import time: every entry point
// is a function main calls (event router, hash routing, the #open-autopilot button, fleet deps).
//
// main.ts ↔ autopilot.ts wiring: autopilot.ts never imports from main.ts. Everything autopilot code
// needs from main (the merged session/environment maps, sendAwait, selectSession, the Todoist
// panel refresh) is injected once via initAutopilot(deps) — mirroring
// fleet/sidebar/conversation — during main's module init, before any socket connects or deep link
// fires. Cross-module state that main still reaches (`serverSchedule` in onStatus; the plan routing
// maps live in fleet.ts) is an in-place container, so it stays an exported `const` here.
import { $, esc, icon } from "./dom";
// dialogs.ts is a leaf, so the modal/dialog/toast helpers are direct imports — they used to arrive
// via initAutopilot(deps).
import { closeModal, confirmDialog, confirmDialogWithOption, pickListDialog, showModal, toast } from "./dialogs";
import { currentTheme } from "./theme";
import { stripeColor } from "./sessionColor";
import { dismissOverlay, openOverlay, overlayOpen } from "./overlays";
import { newCid } from "./outbox";
import { relTime } from "./conversation";
import { HUB_URL, envServer, orderedServers, planServer, serverByUrl, serverPlans, serverSupports, sessionServer, type Server } from "./fleet";
import type { AutopilotPlanInfo, AutopilotSchedule, Environment, PipelineTraceInfo, ServerEvent, Session } from "../../protocol";

// ── Injected dependencies (initAutopilot) ────────────────────────────────────────────────────────
// What autopilot code calls back into main.ts for. Each field documents the main.ts state it reaches.
export interface AutopilotDeps {
  /** The merged session list (main owns it — linkPlanToSession offers the plan-env's sessions). */
  sessions: Map<string, Session>;
  /** The merged environment list (card tints, env grouping, reassign/schedule env pickers). */
  environments: Map<string, Environment>;
  /** cid-tracked request/response over a server's socket (main's `sendAwait`). */
  sendAwait(server: Server, cmd: Record<string, unknown> & { type: string; cid: string }, timeoutMs?: number): Promise<ServerEvent>;
  /** Jump into a session (Go / Plan with Claude / Link land in the session they created/attached). */
  selectSession(id: string, push?: boolean): void;
  /** The Settings → Todoist panel embeds the schedule card — refresh it when the hub's schedule changes. */
  renderTodoistPanel(): void;
}
// Module-local mirrors of the injected deps, named exactly as in main.ts so the moved code below
// stays verbatim. Assigned once by initAutopilot — which main.ts calls during its module init,
// before any socket exists or deep link fires — so no autopilot entry point can observe them unset.
let sessions: AutopilotDeps["sessions"];
let environments: AutopilotDeps["environments"];
let sendAwait: AutopilotDeps["sendAwait"];
let selectSession: AutopilotDeps["selectSession"];
let renderTodoistPanel: AutopilotDeps["renderTodoistPanel"];
export function initAutopilot(deps: AutopilotDeps): void {
  ({ sessions, environments, sendAwait, selectSession, renderTodoistPanel } = deps);
}

// ── Autopilot (plan review & launch; anvil-autopilot-ui.md) ────────────────────────
const autopilotLog: string[] = []; // streamed progress lines for the current/last run
let openPlanId: string | null = null; // the plan open in the reader, if any (else the grid is shown)
const SIZE_LABEL: Record<string, string> = { xs: "XS", s: "S", m: "M", l: "L", xl: "XL" };
const DAY_LABEL = ["S", "M", "T", "W", "T", "F", "S"]; // Sun..Sat, for the schedule day toggles
// Each server's autopilot schedule (the UI control targets the hub; the daemon supports per-server).
// `running` is the server-authoritative live run state, broadcast on start/finish + sent on connect.
export const serverSchedule = new Map<string, { schedule: AutopilotSchedule; nextRunAt?: string; running: boolean }>();

// Client-side backstop against a server that reports `running: true` and never takes it back — an old
// daemon with a latched flag, or one that died without a clean `running: false`. A healthy current
// daemon caps its own run (30 min) and broadcasts false well before this fires, so this only bites a
// stuck/old server: if no clearing event arrives within the budget, we drop that server's run locally
// so the fleet-wide spinner can't be pinned on forever by one misbehaving member.
const STALE_RUN_MS = 35 * 60_000;
const staleRunTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function clearStaleRunTimer(url: string): void {
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
export function reflectAutopilotRunning(): void {
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
export function updateAutopilotBadge(): void {
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
export function openPlanDeepLink(id: string): void {
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
export function onAutopilotPlans(url: string, plans: AutopilotPlanInfo[]): void {
  serverPlans.set(url, plans);
  for (const [pid, u] of [...planServer]) if (u === url) planServer.delete(pid);
  for (const p of plans) planServer.set(p.id, url);
  updateAutopilotBadge();
  tryOpenPendingPlan(); // a deep-linked plan may have just arrived
  if (!document.querySelector(".autopilot-view")) return;
  // A reader open on a plan that just vanished (dismissed/started elsewhere) falls back to the grid;
  // otherwise leave an open reader untouched and only re-flow the grid.
  if (openPlanId) {
    if (!findPlan(openPlanId)) backToGrid(); // the open plan vanished (dismissed/started) → unwind to the grid
  } else {
    renderAutopilotGrid();
  }
}
/** Restore the in-flight run's log on (re)connect. The schedule event already set `running`; this
 *  refills the log panel + banner so refreshing mid-run no longer blanks the live view. Only sent by
 *  the server while a run is actually in flight. */
export function onAutopilotRunSnapshot(log: string[]): void {
  autopilotLog.length = 0;
  autopilotLog.push(...log);
  runState.lastLine = log[log.length - 1] ?? "";
  const el = document.getElementById("autopilot-log");
  if (el) {
    el.textContent = autopilotLog.join("\n"); // one full rebuild per reconnect is fine (O(n), not per-line)
    applyAutopilotLogVisibility();
    scrollAutopilotLogSoon(el);
  }
  reflectAutopilotRunning();
}
let autopilotLogScrollRaf = 0;
function scrollAutopilotLogSoon(el: HTMLElement): void {
  if (autopilotLogScrollRaf || typeof requestAnimationFrame === "undefined") {
    if (typeof requestAnimationFrame === "undefined" && !el.hidden) el.scrollTop = el.scrollHeight;
    return;
  }
  autopilotLogScrollRaf = requestAnimationFrame(() => {
    autopilotLogScrollRaf = 0;
    if (!el.hidden) el.scrollTop = el.scrollHeight;
  });
}
export function onAutopilotProgress(line: string): void {
  autopilotLog.push(line);
  runState.lastLine = line;
  const log = document.getElementById("autopilot-log");
  if (log) {
    // [WEB2-15] Append only. The old code re-joined the WHOLE array and replaced textContent per line —
    // O(n²) over a run — and forced a synchronous scroll (layout) each time. Append a text node (leaves
    // existing content untouched) and coalesce the scroll to one per frame.
    log.append(document.createTextNode((log.childNodes.length ? "\n" : "") + line));
    applyAutopilotLogVisibility();
    scrollAutopilotLogSoon(log);
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

export function openAutopilot(): void {
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

/** The full-plan reader + actions (Plan with Claude / Start / Pipeline / Dismiss …), rendered in place of the grid (same overlay). */
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
  // the open questions. Disable Start / hide Pipeline and steer the reviewer to "Plan with Claude".
  const held = p.status === "needs-clarification";
  // A unit with a live "Plan with Claude" session is owned by that session — Start/Plan/Pipeline would all
  // just error ("already has a live session"). Swap the whole action set for a jump-into-the-session button.
  const planning = p.status === "planning";
  const actions = planning
    ? `<button class="mini" id="plan-complete">${icon("check_circle")} Complete</button>
        <button class="mini" id="plan-expire">${icon("schedule")} Expired</button>
        <button class="mini danger" id="plan-dismiss">${icon("close")} Dismiss</button>
        <button class="primary" id="plan-open-session"${p.sessionId ? "" : " disabled title=\"Its planning session is no longer available\""}>${icon("open_in_new")} Open session</button>`
    : `<button class="mini" id="plan-complete">${icon("check_circle")} Complete</button>
        <button class="mini" id="plan-expire">${icon("schedule")} Expired</button>
        <button class="mini danger" id="plan-dismiss">${icon("close")} Dismiss</button>
        <button class="mini" id="plan-reassign">${icon("swap_horiz")} Reassign</button>
        <button class="mini" id="plan-link">${icon("link")} Link</button>
        <button class="mini" id="plan-pipeline" title="Run the autonomous multi-model pipeline (Claude + GLM) end to end"${held ? " hidden" : ""}>${icon("hub")} Pipeline</button>
        <button class="${held ? "primary" : "mini"}" id="plan-plan" title="Open an interactive session seeded with the request, the design so far, and any open questions — work the plan out with Claude, then build">${icon("auto_awesome")} Plan with Claude</button>
        <button class="${held ? "mini" : "primary"}" id="plan-start"${held ? ` disabled title="Answer the open questions first — use Plan with Claude"` : ""}>${held ? `${icon("lock")} Needs answers` : `${icon("rocket_launch")} Start`}</button>`;
  host.innerHTML = `<div class="plan-reader" data-id="${esc(id)}">
    <div class="plan-reader-head">
      <button class="mini" id="plan-back">${icon("arrow_back")} All plans</button>
      <span class="plan-reader-title">${esc(p.title)}${env ? ` <span class="small muted">· ${esc(env)}</span>` : ""}</span>
      <span class="plan-reader-actions">${actions}</span>
    </div>
    <div class="plan-reader-body">
      ${planning ? `<p class="small muted">${icon("auto_awesome")} This plan is being worked out in a live planning session. Open it to continue, answer questions, and build.</p>` : ""}
      ${p.pipeline ? renderPipelineTrace(p.pipeline) : ""}
      <article class="md plan-doc" id="plan-doc">${p.plan?.html ?? "<p class='muted'>No plan content.</p>"}</article>
    </div>
  </div>`;
  // The reader is its own back-stack layer (no hash of its own — it lives inside the autopilot
  // overlay's #autopilot URL): device/browser Back pops just this layer back to the grid instead of
  // unwinding the whole Autopilot view to the conversation. Closing it in-app goes through backToGrid.
  openOverlay("plan", () => renderAutopilotGrid());
  $("#plan-back").addEventListener("click", () => backToGrid());
  $("#plan-complete").addEventListener("click", () => void resolvePlan(id, "completed"));
  $("#plan-expire").addEventListener("click", () => void resolvePlan(id, "expired"));
  $("#plan-dismiss").addEventListener("click", () => void dismissPlan(id));
  if (planning) {
    $("#plan-open-session").addEventListener("click", () => {
      if (!p.sessionId) return;
      dismissOverlay("autopilot");
      selectSession(p.sessionId);
    });
  } else {
    $("#plan-reassign").addEventListener("click", () => void reassignPlan(id));
    $("#plan-link").addEventListener("click", () => void linkPlanToSession(id));
    $("#plan-start").addEventListener("click", () => void startPlan(id));
    $("#plan-pipeline").addEventListener("click", () => void startDevPipeline(id));
    $("#plan-plan").addEventListener("click", () => void openPlanningSession(id));
  }
  // A fresh plan reads from the top, not wherever the grid (or a prior plan) was scrolled to.
  if (body) body.scrollTop = 0;
  document.querySelector(".plan-reader-body")?.scrollTo(0, 0);
}

/** The server that owns a plan (plan.session/dismiss/start route there), or undefined if offline/unknown.
 *  Uses {@link serverByUrl} (not a raw `servers.get`) so a plan tagged to a member whose url has drifted
 *  scheme/slash still routes to the connected owner instead of falsely reporting "server offline". */
function planSock(id: string): Server | undefined {
  return serverByUrl(planServer.get(id));
}

/** "Plan with Claude": open an interactive session seeded with the Todoist prompt, the design so far,
 *  and any open questions — the replacement for the old refine chat. Claude works the plan out with the
 *  user (and can build or hand off to the pipeline from there). Jumps into the new session, like Go. */
async function openPlanningSession(id: string): Promise<void> {
  const srv = planSock(id);
  if (!srv?.sock.isOpen()) {
    toast("That plan's server is offline");
    return;
  }
  const btn = document.getElementById("plan-plan") as HTMLButtonElement | null;
  const reset = (): void => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `${icon("auto_awesome")} Plan with Claude`;
    }
  };
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${icon("hourglass_empty")} Opening…`;
  }
  try {
    const res = await sendAwait(srv, { type: "autopilot.plan.session", workUnitId: id, cid: newCid() }, 60_000);
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
    toast(`Couldn't open a planning session: ${err instanceof Error ? err.message : String(err)}`);
    reset();
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
    // A reassign re-plans the unit against the new repo (read-only Opus) — allow a generous budget
    // (a full planning pass over the repo) rather than the default short cap.
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
export function onAutopilotSchedule(url: string, schedule: AutopilotSchedule, nextRunAt?: string, running = false): void {
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
export function scheduleSettingsCardHtml(): string {
  return `<div class="card schedule-card" id="todoist-schedule">
    <div class="card-main">${scheduleSummaryHtml()}<button class="mini" id="set-sched-edit" style="margin-left:auto">${icon("tune")} Edit</button></div>
    <p class="small muted">An in-daemon timer on every fleet server re-plans its linked projects and (when auto-start is on) launches the new work. Review &amp; launch plans in the <b>Autopilot</b> section.</p>
  </div>`;
}

export function openScheduleModal(): void {
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
