// ── Loops home (#loops) — the first-class autonomy surface ──────────────────────────────────────────
// Every loop drawn as the same circuit: Trigger → Act ⇄ Check → 🔒 gate → Ship. Phase 1 is
// projection-first: it renders the same `loops.snapshot` rows the Autopilot Loops panel shows (schedule,
// goals, pipelines, proposals, work-unit drafts) as circuit rows + detail pages, over the shared
// `serverLoops` cache. The two surfaces deliberately coexist through Phases 1–3 (concept §6.3 "coexist");
// Phase 4 retires the Autopilot grid and flips the sidebar to Loops.
//
// Wiring mirrors autopilot.ts: loops.ts never imports from main.ts — everything it needs (the merged
// environment map, sendAwait, selectSession) is injected once via initLoops(deps) during main's init.
import { $, esc, icon } from "./dom";
import { confirmDialog, toast } from "./dialogs";
import { dismissOverlay, loopFromHash, openOverlay, overlayOpen } from "./overlays";
import { newCid } from "./outbox";
import { orderedServers, serverByUrl, serverLoops, type Server } from "./fleet";
import { openPlanDeepLink } from "./autopilot";
import { circuitSvg, loopToCircuit, miniSvg, RUNGS, rung } from "./circuit";
import { stripeColor } from "./sessionColor";
import { currentTheme } from "./theme";
import type { Environment, LoopSummary, ServerEvent } from "../../protocol";

// ── Injected dependencies (initLoops) ──────────────────────────────────────────────────────────────
export interface LoopsDeps {
  environments: Map<string, Environment>;
  sendAwait(server: Server, cmd: Record<string, unknown> & { type: string; cid: string }, timeoutMs?: number): Promise<ServerEvent>;
  selectSession(id: string, push?: boolean): void;
}
let environments: LoopsDeps["environments"];
let sendAwait: LoopsDeps["sendAwait"];
let selectSession: LoopsDeps["selectSession"];
export function initLoops(deps: LoopsDeps): void {
  ({ environments, sendAwait, selectSession } = deps);
}

// Claude-led intake (Phase 3) registers its opener here; until then the prompt box explains it's coming.
let intakeStart: ((prompt: string, fromDraft?: string) => void) | null = null;
export function setLoopIntake(fn: (prompt: string, fromDraft?: string) => void): void {
  intakeStart = fn;
}

// Home ↔ detail navigation state, and the loop→server map built each render (routes gate/approve sends).
let detailId: string | null = null;
const loopServer = new Map<string, string>(); // loopId → server url

/** Every loop across the connected fleet, in server order, tagged with its owning server url. */
function allLoops(): { loop: LoopSummary; url: string }[] {
  const out: { loop: LoopSummary; url: string }[] = [];
  loopServer.clear();
  for (const s of orderedServers())
    for (const loop of serverLoops.get(s.url) ?? []) {
      out.push({ loop, url: s.url });
      loopServer.set(loop.id, s.url);
    }
  return out;
}
function findLoop(id: string): { loop: LoopSummary; url: string } | undefined {
  return allLoops().find((x) => x.loop.id === id);
}
function loopSock(id: string): Server | undefined {
  return serverByUrl(loopServer.get(id));
}

/** Drafts + gated loops (things waiting on a human) drive the sidebar badge. */
function gateCount(): number {
  let n = 0;
  for (const list of serverLoops.values()) for (const l of list) if (l.status === "gated") n++;
  return n;
}
export function updateLoopsBadge(): void {
  const badge = document.getElementById("loops-badge");
  if (!badge) return;
  const n = gateCount();
  badge.textContent = n ? String(n) : "";
  badge.hidden = n === 0;
}

// ── Home ─────────────────────────────────────────────────────────────────────────────────────────
export function openLoops(): void {
  const root = $("#loops-root");
  root.innerHTML = `<div class="autopilot-view loops-view"><div class="lc-app" id="lc-root"></div></div>`;
  openOverlay("loops", closeLoops, "#loops"); // own URL; Back reverts it & closes the view
  detailId = null;
  renderHome();
  // Fresh pull of every loops-capable server's active loops.
  for (const s of orderedServers()) if (s.sock.isOpen()) s.sock.send({ type: "loops.get" });
}
function closeLoops(): void {
  detailId = null;
  $("#loops-root").innerHTML = "";
}

function statusChipHtml(l: LoopSummary): string {
  if (l.status === "gated") return `<span class="lc-chip gated">${icon("lock")} at your gate</span>`;
  if (l.status === "running")
    return `<span class="lc-chip running">${l.iteration ? `lap ${l.iteration.current}/${l.iteration.max}` : "running"}</span>`;
  if (l.status === "paused") return `<span class="lc-chip paused">paused</span>`;
  const next = l.nextFireAt ? new Date(l.nextFireAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "armed";
  return `<span class="lc-chip armed">${esc(next)}</span>`;
}
function envName(l: LoopSummary): string {
  return l.environmentName ?? (l.environmentId ? environments.get(l.environmentId)?.name : undefined) ?? "Fleet";
}
function rowHtml(l: LoopSummary): string {
  return `<div class="lc-row" data-id="${esc(l.id)}" role="button" tabindex="0">
    ${miniSvg(loopToCircuit(l))}
    <span class="m"><span class="t">${esc(l.title)}</span><span class="s">${esc(l.trigger)} → ${esc(l.act ?? l.stopCondition)}</span></span>
    ${statusChipHtml(l)}
    <span class="msym lc-chev">chevron_right</span>
  </div>`;
}

function renderHome(): void {
  detailId = null;
  updateLoopsBadge();
  const app = document.getElementById("lc-root");
  if (!app) return;
  const rows = allLoops().map((x) => x.loop);
  const active = rows.filter((l) => l.kind !== "draft");
  const drafts = rows.filter((l) => l.kind === "draft");
  // Group active loops by environment (name), Fleet-level (schedule) first.
  const groups = new Map<string, LoopSummary[]>();
  for (const l of active) {
    const key = envName(l);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(l);
  }
  const orderedGroupNames = [...groups.keys()].sort((a, b) => (a === "Fleet" ? -1 : b === "Fleet" ? 1 : a.localeCompare(b)));
  const groupHtml = orderedGroupNames
    .map((name) => {
      const env = [...environments.values()].find((e) => e.name === name);
      const dot = env ? stripeColor(env, 0, currentTheme()) : "var(--muted)";
      return `<div class="lc-envsep"><span class="env-dot" style="background:${dot}"></span>${esc(name)}</div>
        <div class="lc-rows">${groups.get(name)!.map(rowHtml).join("")}</div>`;
    })
    .join("");
  const draftsHtml = drafts.length
    ? `<div class="lc-envsep">${icon("lock")} Drafts at your gate <span class="lc-envsep-count">${drafts.length}</span></div>
       <div class="lc-rows">${drafts.map(rowHtml).join("")}</div>`
    : "";
  const empty = !active.length && !drafts.length ? `<div class="ap-empty">${icon("all_inclusive")}<p>No loops yet.</p><p class="small muted">Describe an outcome above and Claude will build the loop with you.</p></div>` : "";
  app.innerHTML = `
    <div class="lc-top"><h1>${icon("all_inclusive")} Loops</h1>
      <button class="icon-btn" id="lc-close" title="Close">${icon("close")}</button></div>
    <p class="lc-sub">One idea, drawn once: <b>Trigger → Act ⇄ Check → Ship</b>, and the lock is where <i>you</i> sit.</p>
    <div class="lc-intake">
      <div class="lc-intake-row">
        <input id="lc-prompt" placeholder="What should get done? e.g. Fix the flaky upload test" />
        <button class="primary" id="lc-go">${icon("auto_awesome")} Build my loop</button>
      </div>
    </div>
    ${groupHtml}${draftsHtml}${empty}`;
  $("#lc-close").addEventListener("click", () => dismissOverlay("loops"));
  const go = (): void => {
    const v = (document.getElementById("lc-prompt") as HTMLInputElement | null)?.value.trim();
    if (!v) return;
    if (intakeStart) intakeStart(v);
    else toast("Claude-led loop intake arrives in a later phase — for now, create work via Autopilot.");
  };
  $("#lc-go").addEventListener("click", go);
  document.getElementById("lc-prompt")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") go();
  });
  app.querySelectorAll<HTMLElement>(".lc-row").forEach((r) => {
    const open = (): void => openDetail(r.dataset.id!);
    r.addEventListener("click", open);
    r.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") open();
    });
  });
}

// ── Detail ─────────────────────────────────────────────────────────────────────────────────────────
function openDetail(id: string): void {
  const found = findLoop(id);
  if (!found) {
    renderHome();
    return;
  }
  detailId = id;
  renderDetail();
}
function renderDetail(): void {
  if (!detailId) return;
  const app = document.getElementById("lc-root");
  const found = findLoop(detailId);
  if (!app || !found) {
    detailId = null;
    renderHome();
    return;
  }
  const l = found.loop;
  const r = rung(loopToCircuit(l).rung);
  const statusLabel = l.status === "gated" ? "at your gate" : l.status;
  // Kind-specific action row. Projected loops aren't real Loop entities yet (Phase 2), so the verbs map
  // to the existing autopilot commands (approve/reject a proposal, open a draft's plan reader) or jump
  // into the goal's session.
  let actions = "";
  if (l.kind === "trigger" && l.status === "gated")
    actions = `<button class="primary" id="lc-approve">${icon("check")} Approve — plan &amp; build</button>
      <button class="mini danger" id="lc-reject">${icon("close")} Reject</button>`;
  else if (l.kind === "draft") actions = `<button class="primary" id="lc-open-draft">${icon("open_in_new")} Open the draft</button>`;
  else if (l.sessionId) actions = `<button class="mini" id="lc-jump">${icon("open_in_new")} Open its session</button>`;
  const iterCard = l.iteration
    ? `<div class="lc-card"><h3>Laps</h3>
        <div class="lc-caps"><div class="cap"><b>Lap ${l.iteration.current} / ${l.iteration.max}</b>
        <div class="lc-bar"><i style="width:${Math.round((l.iteration.current / Math.max(1, l.iteration.max)) * 100)}%"></i></div>
        <span>live lap count · hard ceiling</span></div></div></div>`
    : "";
  const detailNote = l.detail ? `<p class="lc-sub" style="margin-top:-6px">${icon("info")} ${esc(l.detail)}</p>` : "";
  app.innerHTML = `
    <div class="lc-head">
      <button class="mini" id="lc-back">${icon("arrow_back")} Loops</button>
      <h2>${esc(l.title)}</h2>
      <span class="lc-chip ${esc(l.status)}">${esc(statusLabel)}</span>
    </div>
    <div class="lc-circuit-card">${circuitSvg(loopToCircuit(l))}</div>
    ${detailNote}
    ${actions ? `<div class="lc-actions">${actions}</div>` : ""}
    ${iterCard}
    <div class="lc-card"><h3>Autonomy — where your gate sits</h3>
      <div class="lc-ladder">${RUNGS.map((x) => `<button class="${r.k === x.k ? "on" : ""}" disabled><b>${x.name}</b>${esc(x.desc.split(".")[0]!)}</button>`).join("")}</div>
      <p class="lc-ladder-note">${icon("trending_up")} Loops <b>earn</b> autonomy — the ladder unlocks once this is a real loop (Phase 2).</p></div>`;
  $("#lc-back").addEventListener("click", () => {
    detailId = null;
    renderHome();
  });
  document.getElementById("lc-jump")?.addEventListener("click", () => {
    if (!l.sessionId) return;
    dismissOverlay("loops");
    selectSession(l.sessionId);
  });
  document.getElementById("lc-open-draft")?.addEventListener("click", () => {
    dismissOverlay("loops");
    openPlanDeepLink(l.id);
  });
  document.getElementById("lc-approve")?.addEventListener("click", () => void approveProposal(l.id));
  document.getElementById("lc-reject")?.addEventListener("click", () => void rejectProposal(l.id, l.title));
}

async function approveProposal(id: string): Promise<void> {
  const srv = loopSock(id);
  if (!srv?.sock.isOpen()) {
    toast("That loop's server is offline");
    return;
  }
  const btn = document.getElementById("lc-approve") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${icon("hourglass_empty")} Approving…`;
  }
  try {
    const res = await sendAwait(srv, { type: "autopilot.approve", workUnitId: id, start: false, cid: newCid() }, 60_000);
    if (res.type === "command.error") {
      toast(res.message);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `${icon("check")} Approve — plan & build`;
      }
      return;
    }
    toast("Approved — ready to build");
    // The loops.snapshot broadcast drops the row; fall back to the home immediately.
    detailId = null;
    renderHome();
  } catch (err) {
    toast(`Approve failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function rejectProposal(id: string, title: string): Promise<void> {
  const ok = await confirmDialog({
    title: "Reject this proposal?",
    body: `“${title}” will be dismissed and won't be re-proposed.`,
    confirmLabel: "Reject",
    danger: true,
    icon: "close",
  });
  if (!ok) return;
  const srv = loopSock(id);
  if (!srv?.sock.isOpen()) {
    toast("That loop's server is offline");
    return;
  }
  try {
    const res = await sendAwait(srv, { type: "autopilot.dismiss", workUnitId: id, cid: newCid() }, 60_000);
    if (res.type === "command.error") {
      toast(res.message);
      return;
    }
    toast("Rejected");
    detailId = null;
    renderHome();
  } catch (err) {
    toast(`Reject failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Event routing ────────────────────────────────────────────────────────────────────────────────
/** A server delivered its active loops: refresh the badge and, if the home/detail is open, re-render.
 *  The shared `serverLoops` cache is written by autopilot.ts's onLoopsSnapshot; we only re-render here. */
export function onLoopsHome(): void {
  updateLoopsBadge();
  if (!overlayOpen("loops")) return;
  tryOpenPendingLoop(); // a deep-linked loop may have just synced
  if (detailId) renderDetail();
  else renderHome();
}

// ── Deep link (#loops / #loops/<id>) ───────────────────────────────────────────────────────────────
let pendingLoopDeepLink: string | null = null;
export function openLoopsDeepLink(): void {
  if (!overlayOpen("loops")) openLoops();
  const id = loopFromHash();
  if (id) {
    pendingLoopDeepLink = id;
    tryOpenPendingLoop();
  }
}
function tryOpenPendingLoop(): void {
  if (!pendingLoopDeepLink || !overlayOpen("loops")) return;
  if (!findLoop(pendingLoopDeepLink)) return; // not synced yet — the next loops.snapshot retries
  const id = pendingLoopDeepLink;
  pendingLoopDeepLink = null;
  openDetail(id);
}
