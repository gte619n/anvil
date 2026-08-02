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
import Sortable from "sortablejs";
import { $, esc, icon, sessIcon } from "./dom";
import { currentTheme } from "./theme";
import { envOrdinal, sessionBg, stripeColor } from "./sessionColor";
import { sessionHref } from "./overlays";
import { newCid } from "./outbox";
import { orderedServers, pendingTeamPlans, sendTo, serverOf, servers, sessionServer } from "./fleet";
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
export function renderSessions(): void {
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
        li.classList.add("has-members"); // stack the member list BELOW the lead row (not beside it)
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
export function renderTeamBoard(lead: Session | undefined): void {
  const el = document.getElementById("team-board");
  if (!el) return;
  if (!lead || lead.teamRole !== "lead" || lead.id !== activeId()) {
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

  // Observational board only — integration + teardown are driven by the lead agent (via its
  // integrate / dismiss_member tools), so there are no action buttons here. The user directs the
  // lead conversationally ("integrate now", "dismiss the docs member").
  // Collapsible so a big team (10+ members) doesn't take over the pane; the choice persists.
  const collapsed = localStorage.getItem("anvil.teamBoardCollapsed") === "1";
  el.innerHTML = `${planCard}
    <div class="team-board-head">
      <button class="tmb-collapse" title="${collapsed ? "Expand team" : "Collapse team"}">${icon(collapsed ? "chevron_right" : "expand_more")}</button>
      <span class="tmb-title">${icon("groups")} Team · ${members.length} member(s) · ${esc(policy)}</span>
    </div>
    ${collapsed ? "" : `<div class="tmb-rows">${rows || `<div class="tmb-empty">No members yet.</div>`}</div>`}`;

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

function renderSessionItem(s: Session, isMember = false): HTMLLIElement {
  const removing = removingSessions.has(s.id);
  const awaiting = !removing && !s.pending && !s.archived && (s.status === "awaiting_permission" || s.status === "awaiting_question");
  const li = document.createElement("li");
  li.className = `session${s.id === activeId() ? " active" : ""}${s.archived ? " archived" : ""}${s.pending ? " pending" : ""}${awaiting ? " awaiting" : ""}${removing ? " removing" : ""}${isMember ? " member" : ""}`;
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
export function initSortables(): void {
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
