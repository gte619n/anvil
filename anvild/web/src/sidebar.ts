// ── Sidebar: session list + team board + drag-to-reorder + favicon ───────────────────────────────
// Extracted verbatim from main.ts (P7 god-file decomposition). Four seams live here:
//   1. The session sidebar (renderSessions / renderSessionItem): the concierge row, the flat
//      cross-server active list, the Finished group, and nested team-member rows (teams §5).
//   2. The lead's team board + plan-gate card, rendered above its conversation.
//   3. Drag-to-reorder (SortableJS) across the active/Finished lists → session.arrange.
//   4. The favicon mirror of the active session's Material Symbol.
//
// This module evaluates BEFORE main.ts's body (main imports it), which preserves the declare-up-top
// guarantee for the sidebar-owned early-init scalars (`dragging`/`justDragged`/`removingSessions`):
// they initialize at module eval here, so main's instant-restore renderSessions() call — which runs
// during ITS module init — never sees them in a temporal dead zone (see memory:
// web-early-init-decl-order-crash). No sidebar code has top-level DOM side effects: everything runs
// via main's calls (renderSessions at instant-restore, initSortables at its original wiring point).
//
// main.ts ↔ sidebar.ts wiring: sidebar.ts never imports from main.ts. Everything sidebar code needs
// from main (the merged session/environment maps, the active-session id, navigation, persistence) is
// injected once via initSidebar(deps) — mirroring fleet.ts's initFleet — before main's instant
// restore calls renderSessions().
// [WEB2-3] SortableJS is only needed once drag-to-reorder is wired (initSortables, called from main
// after the instant restore) — it loads as a lazy chunk there, keeping it out of the boot bundle.
// Only its TYPES are imported here.
import type Sortable from "sortablejs";
import { $, esc, icon, sessIcon } from "./dom";
import { currentTheme } from "./theme";
import { sessionBg, stripeColor } from "./sessionColor";
import { sessionHref } from "./overlays";
import { newCid } from "./outbox";
import { isNamespacedDefaultId, orderedServers, pendingTeamPlans, sendTo, serverOf, servers, sessionServer } from "./fleet";
import type { Environment, Session } from "../../protocol";

// ── Injected dependencies (initSidebar) ──────────────────────────────────────────────────────────
// What sidebar code calls back into main.ts for. Each field documents the main.ts state it reaches.
export interface SidebarDeps {
  /** The merged session list (main owns it — fleet fan-in populates it). */
  sessions: Map<string, Session>;
  /** The merged environment list (row tint + env-name meta). */
  environments: Map<string, Environment>;
  /** The currently-open session's id (main's `activeId` — a reassigned scalar, so it's injected as a
   *  lazy read, not a value; the row highlight and team-board gate read it at render time). */
  activeId(): string | null;
  /** Navigate to a session (main's `selectSession` — row/board clicks). */
  selectSession(id: string): void;
  /** Keep the offline session cache in step after a reorder (main's debounced `persistSessions`). */
  persistSessions(): void;
}
// Module-local mirrors of the injected deps, named exactly as in main.ts so the moved code below
// stays verbatim (`activeId` becomes the call `activeId()`). Assigned once by initSidebar — which
// main.ts calls during its module init, before the instant-restore render — so no sidebar entry
// point can observe them unset.
let sessions: SidebarDeps["sessions"];
let environments: SidebarDeps["environments"];
let activeId: SidebarDeps["activeId"];
let selectSession: SidebarDeps["selectSession"];
let persistSessions: SidebarDeps["persistSessions"];
export function initSidebar(deps: SidebarDeps): void {
  ({ sessions, environments, activeId, selectSession, persistSessions } = deps);
}

// Sessions being cleaned up: shown disabled in the sidebar until the daemon confirms deletion
// (session.deleted). Transient — not persisted. (UI refinement §8) Mutated in place by main's
// cleanup flow, read by renderSessionItem — a Set, so it's an exported `const`, not `ui` state.
export const removingSessions = new Set<string>();
// Early-init scalars (declare-up-top rule — see main.ts §Early-init): these initialize at module
// eval, which happens before main's body runs, so the instant-restore render can't hit their TDZ.
let dragging = false; // true while a SortableJS drag is in progress (suppresses re-renders)
let justDragged = false; // set briefly after a drop so the row's click doesn't also navigate

// ── Sidebar ────────────────────────────────────────────────────────────────────
// [WEB2-2] The sidebar used to rebuild all three lists' innerHTML on EVERY event (several times per
// turn), with a per-row envOrdinal() re-sorting the whole session map (O(N² log N) across a pass)
// and a localStorage read per row (orderedServers). Now: renderSessions() is a rAF-coalesced
// request — any synchronous burst of events collapses into ONE DOM pass at the next frame — and the
// pass itself is a keyed diff by li.dataset.id: a row whose render inputs (rowSig) are unchanged is
// left entirely alone (same <li>, same children, same listeners), a changed row is morphed in place
// (node identity preserved), and rows are only created/removed when sessions appear/disappear.
// envOrdinal is hoisted to one precomputed Map per pass; orderedServers()/currentTheme() are read
// once per pass instead of once per row.
let renderPending = false; // the rAF-coalescing dirty flag: many requests per frame → one DOM pass
export function renderSessions(): void {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    renderSessionsNow(); // no frame scheduler (non-browser) — render synchronously, as before
    return;
  }
  if (renderPending) return;
  renderPending = true;
  window.requestAnimationFrame(() => {
    if (!renderPending) return; // flushed synchronously in the meantime (flushRenderSessions)
    renderPending = false;
    renderSessionsNow();
  });
}
/** Run a pending render NOW. For callers that read the freshly rendered sidebar DOM synchronously
 *  (selectSession scrolls the newly-active row into view). No-op when nothing is pending. */
export function flushRenderSessions(): void {
  if (!renderPending) return;
  renderPending = false;
  renderSessionsNow();
}

// Everything the row renderer needs precomputed once per pass (WEB2-2): the env ordinals (was an
// O(N log N) sort per row), the resolved theme, and whether more than one server is in play (was a
// localStorage read + parse per row via orderedServers()).
interface RenderCtx {
  ordinals: Map<string, number>; // sessionId → its ordinal within its environment
  theme: "light" | "dark";
  multiServer: boolean;
}
function renderCtx(): RenderCtx {
  return { ordinals: computeEnvOrdinals(), theme: currentTheme(), multiServer: orderedServers().length > 1 };
}
/** One-pass equivalent of sessionColor's per-row envOrdinal(): group by environment, sort each group
 *  by (createdAt, id) exactly as envOrdinal does, and record every session's index. Sessions without
 *  an environment aren't entered — the map's miss default (0) matches envOrdinal's return for them. */
function computeEnvOrdinals(): Map<string, number> {
  const byEnv = new Map<string, Session[]>();
  for (const s of sessions.values()) {
    if (!s.environmentId) continue;
    const g = byEnv.get(s.environmentId);
    if (g) g.push(s);
    else byEnv.set(s.environmentId, [s]);
  }
  const ordinals = new Map<string, number>();
  for (const peers of byEnv.values()) {
    peers.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    peers.forEach((s, i) => ordinals.set(s.id, i));
  }
  return ordinals;
}

const ordKey = (s: Session): number => s.order ?? -1; // server sort key; unset (new) sessions sort to the top
const sortFn = (a: Session, b: Session): number =>
  Number(!!b.isDefault) - Number(!!a.isDefault) ||
  Number(!!a.archived) - Number(!!b.archived) ||
  ordKey(a) - ordKey(b);

/** Everything renderSessionItem bakes into a row's DOM, as one comparable string. A row is
 *  re-rendered (morphed in place) only when this changes — an unrelated event leaves it untouched. */
function rowSig(s: Session, isMember: boolean, ctx: RenderCtx): string {
  const env = s.environmentId ? environments.get(s.environmentId) : undefined;
  const srv = serverOf(s.id);
  return JSON.stringify([
    s.id, s.title, s.status, s.model, s.source, !!s.archived, !!s.pending, !!s.isDefault,
    s.icon, // sessIcon: the row glyph Sonnet picks from the title, delivered by a later session.updated
    s.environmentId, env?.name, env?.color, ctx.ordinals.get(s.id) ?? 0, ctx.theme, // name/color/ordinal/theme feed the tint hue
    s.git?.branch, s.git?.prState,
    s.teamRole, s.memberTask, isMember,
    s.id === activeId(),
    removingSessions.has(s.id),
    ctx.multiServer && srv ? srv.name : "",
    s.teamRole === "lead" ? leadRollup(s.id) : 0,
  ]);
}
const rowSigs = new WeakMap<HTMLLIElement, string>(); // li → the signature it was last rendered from

/** Swap a row's rendered content for a freshly built one while KEEPING the <li> node itself (and any
 *  nested team-member list, which syncMembers diffs separately) — so other code holding the node, its
 *  scroll anchoring, and CSS transitions on the row all survive a re-render. */
function morphRow(li: HTMLLIElement, fresh: HTMLLIElement): void {
  const members = li.querySelector<HTMLUListElement>(":scope > ul.team-members");
  li.className = fresh.className;
  li.style.cssText = fresh.style.cssText;
  li.replaceChildren(...fresh.childNodes);
  if (members) li.append(members);
}

/** Keyed diff of one list's rows against the desired session order: reuse a row by data-id (moving
 *  it from wherever it currently lives — including another list, for active ⇄ finished), morph it
 *  only when its signature changed, and drop rows whose sessions are gone. */
function syncList(ul: HTMLElement, desired: Session[], isMember: boolean, ctx: RenderCtx, keyed: Map<string, HTMLLIElement>): void {
  for (let i = 0; i < desired.length; i++) {
    const s = desired[i]!;
    const sig = rowSig(s, isMember, ctx);
    let li = keyed.get(s.id);
    if (!li) {
      li = renderSessionItem(s, isMember, ctx);
      keyed.set(s.id, li);
    } else if (rowSigs.get(li) !== sig) {
      morphRow(li, renderSessionItem(s, isMember, ctx));
    }
    rowSigs.set(li, sig);
    if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] ?? null);
  }
  // Everything the loop above didn't claim has been pushed past the desired rows — drop it. (A row
  // that merely moved lists was already re-parented by the other list's insertBefore, not dropped.)
  while (ul.children.length > desired.length) ul.lastElementChild!.remove();
}

/** Keep a lead row's nested member list (teams §5) in step: create/remove the <ul.team-members>
 *  and keyed-diff its rows like any other list. */
function syncMembers(li: HTMLLIElement, s: Session, ctx: RenderCtx, keyed: Map<string, HTMLLIElement>): void {
  const members = s.teamRole === "lead" ? membersOfLead(s.id).sort(sortFn) : [];
  let mul = li.querySelector<HTMLUListElement>(":scope > ul.team-members");
  if (members.length === 0) {
    mul?.remove();
    li.classList.remove("has-members");
    return;
  }
  li.classList.add("has-members"); // stack the member list BELOW the lead row (not beside it)
  if (!mul) {
    mul = document.createElement("ul");
    mul.className = "team-members";
    li.appendChild(mul);
  }
  syncList(mul, members, true, ctx, keyed);
}

function renderSessionsNow(): void {
  if (dragging) return; // don't yank a row out from under an in-progress drag
  const conciergeUl = $("#concierge-list");
  const activeUl = $("#session-list");
  const finishedUl = $("#finished-list");
  const ctx = renderCtx();
  // Existing rows by data-id, across all lists (incl. nested member rows) — rebuilt from the live DOM
  // each pass, so the diff is stateless and survives anything else having reset the lists.
  const keyed = new Map<string, HTMLLIElement>();
  for (const ul of [conciergeUl, activeUl, finishedUl])
    for (const li of ul.querySelectorAll<HTMLLIElement>("li.session")) if (li.dataset.id) keyed.set(li.dataset.id, li);
  const all = [...sessions.values()];
  const rest = all.filter((s) => !s.isDefault);
  const anyFinished = rest.some((s) => s.finished);
  // Teams: a member (parentId → a lead we know) is NOT rendered at the top level — it appears nested
  // under its lead's row instead (anvil-team-support.md §5).
  const isNestedMember = (s: Session): boolean => !!s.parentId && sessions.has(s.parentId);
  // The concierge (isDefault) is pinned at the top, OUTSIDE the sortable/grouped lists (#26). Only the
  // HUB's Claude chat belongs here: every daemon mints its own default session, but a member's arrives
  // with a namespaced id (sess_default@<serverId>, fleet §Default-chat id namespacing). Rendering those
  // too gave one "Claude" row per server; the origin/hub default keeps the plain id, so filter to it.
  syncList(conciergeUl, all.filter((s) => s.isDefault && !isNamespacedDefaultId(s.id)), false, ctx, keyed);
  // One flat list across every server — no per-machine grouping. Sessions interleave by their
  // server-synced order; which machine a session lives on is shown subtly in its row meta when
  // there's more than one server. (fleet — anvil-multi-server.md §4)
  const top = rest.filter((s) => !isNestedMember(s)).sort(sortFn);
  syncList(activeUl, top.filter((s) => !s.finished), false, ctx, keyed);
  syncList(finishedUl, top.filter((s) => s.finished), false, ctx, keyed);
  for (const s of top) {
    const li = keyed.get(s.id);
    if (li) syncMembers(li, s, ctx, keyed);
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
// [WEB2-16] The board used to rebuild its innerHTML and re-wire every listener on each member
// session.updated (several per turn across a team). Now requests are rAF-coalesced (the latest lead
// argument wins, sharing a frame with the sidebar's own pass), and the pass skips the rebuild
// entirely when the rendered markup is unchanged — unrelated churn leaves the board's DOM, node
// identities, and wired listeners alone.
let teamBoardPending = false;
let teamBoardLead: Session | undefined; // latest requested lead — coalesced requests keep the last
let teamBoardHtml: string | null = null; // markup of the last applied rebuild; null = hidden/cleared
export function renderTeamBoard(lead: Session | undefined): void {
  teamBoardLead = lead;
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    renderTeamBoardNow();
    return;
  }
  if (teamBoardPending) return;
  teamBoardPending = true;
  window.requestAnimationFrame(() => {
    teamBoardPending = false;
    renderTeamBoardNow();
  });
}
function renderTeamBoardNow(): void {
  const lead = teamBoardLead;
  const el = document.getElementById("team-board");
  if (!el) return;
  if (!lead || lead.teamRole !== "lead" || lead.id !== activeId()) {
    el.hidden = true;
    el.innerHTML = "";
    teamBoardHtml = null;
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

  // Observational board only — integration + teardown are driven by the lead agent (via its
  // integrate / dismiss_member tools), so there are no action buttons here. The user directs the
  // lead conversationally ("integrate now", "dismiss the docs member").
  // Collapsible so a big team (10+ members) doesn't take over the pane; the choice persists.
  const collapsed = localStorage.getItem("anvil.teamBoardCollapsed") === "1";
  const html = `${planCard}
    <div class="team-board-head">
      <button class="tmb-collapse" title="${collapsed ? "Expand team" : "Collapse team"}">${icon(collapsed ? "chevron_right" : "expand_more")}</button>
      <span class="tmb-title">${icon("groups")} Team · ${members.length} member(s) · ${esc(policy)}</span>
    </div>
    ${collapsed ? "" : `<div class="tmb-rows">${rows || `<div class="tmb-empty">No members yet.</div>`}</div>`}`;
  if (html === teamBoardHtml) return; // [WEB2-16] unchanged — keep the DOM and its listeners as-is
  el.innerHTML = html;
  teamBoardHtml = html;

  // Collapse/expand the member list (persisted). Clicking anywhere on the header toggles it.
  el.querySelector(".team-board-head")?.addEventListener("click", () => {
    const now = localStorage.getItem("anvil.teamBoardCollapsed") === "1";
    localStorage.setItem("anvil.teamBoardCollapsed", now ? "0" : "1");
    renderTeamBoard(lead);
  });
  // Member rows deep-link to that member (its cards then route correctly as the active session).
  el.querySelectorAll<HTMLElement>(".tmb-row").forEach((row) =>
    row.addEventListener("click", () => { const id = row.dataset.id; if (id) selectSession(id); }),
  );
  // The plan-approval card keeps its Approve/Reject (that's the gate, not a team action).
  el.querySelector(".tpc-approve")?.addEventListener("click", () => {
    if (pending) sendTo(lead.id, { type: "team.plan.approve", sessionId: lead.id, plan: pending, cid: newCid() });
  });
  el.querySelector(".tpc-reject")?.addEventListener("click", () =>
    sendTo(lead.id, { type: "team.plan.reject", sessionId: lead.id, cid: newCid() }),
  );
}

/** Map a session status to a colored status-dot class for the member board. */
function statusDotClass(status: Session["status"]): string {
  if (status === "thinking" || status === "running_tool") return "running";
  if (status === "awaiting_permission" || status === "awaiting_question") return "awaiting";
  if (status === "error") return "error";
  return "idle";
}

function renderSessionItem(s: Session, isMember: boolean, ctx: RenderCtx): HTMLLIElement {
  const removing = removingSessions.has(s.id);
  const awaiting = !removing && !s.pending && !s.archived && (s.status === "awaiting_permission" || s.status === "awaiting_question");
  const li = document.createElement("li");
  li.className = `session${s.id === activeId() ? " active" : ""}${s.archived ? " archived" : ""}${s.pending ? " pending" : ""}${awaiting ? " awaiting" : ""}${removing ? " removing" : ""}${isMember ? " member" : ""}`;
  li.dataset.id = s.id;
  if (s.environmentId && !removing) {
    const env = environments.get(s.environmentId);
    const ord = ctx.ordinals.get(s.id) ?? 0; // [WEB2-2] hoisted: one Map pass, not an O(N log N) sort per row
    const theme = ctx.theme;
    li.classList.add("tinted");
    li.style.setProperty("--session-bg", sessionBg(env, ord, theme));
    li.style.setProperty("--session-stripe", stripeColor(env, ord, theme));
  }
  const envName = s.environmentId ? environments.get(s.environmentId)?.name : undefined;
  const where = envName ?? s.git?.branch ?? s.source;
  const tag = removing ? "cleaning up…" : s.pending ? "pending sync" : s.archived ? "archived" : awaiting ? "needs approval" : esc(s.status);
  // With a fleet, the list is flat (no per-machine sections), so name the owning server inline.
  const srv = serverOf(s.id);
  const machine = ctx.multiServer && srv ? ` · ${icon("dns")}${esc(srv.name)}` : ""; // [WEB2-2] hoisted per pass
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
export function initSortables(): void {
  if (sortablesReady) return; // also guards the double-import race: the flag flips before the await
  sortablesReady = true;
  // Lazy chunk: the drag wiring is enhancement-only (the list renders and navigates fine without
  // it), so a fire-and-forget import keeps SortableJS out of the boot bundle; drags simply become
  // possible the moment the chunk lands.
  void (async () => {
    const { default: SortableJs } = await import("sortablejs");
    wireSortables(SortableJs);
  })();
}
function wireSortables(SortableJs: typeof Sortable): void {
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
  SortableJs.create($("#session-list"), opts);
  SortableJs.create($("#finished-list"), opts);
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
export async function setFavicon(s: Session | undefined): Promise<void> {
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
