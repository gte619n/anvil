// ── Loops home (#loops) — the first-class autonomy surface ──────────────────────────────────────────
// Every loop drawn as the same circuit: Trigger → Act ⇄ Check → 🔒 gate → Ship. Phase 2 renders the
// real, persisted Loop entities (loops.list / loop.updated / loop.run) with full detail — lap history,
// gate verbs (Open the gate / Send back a lap), Run now · Pause/Arm · Edit-when-paused · Delete, and the
// autonomy ladder — alongside the Phase-0 projection rows (schedule/goals/pipelines/proposals/drafts),
// which still show until Phase 4 retires them. Deps injected via initLoops(...) (mirrors autopilot.ts).
import { $, esc, icon } from "./dom";
import { confirmDialog, confirmDialogWithOption, closeModal, promptDialog, showModal, toast } from "./dialogs";
import { dismissOverlay, loopFromHash, openOverlay, overlayOpen } from "./overlays";
import { newCid } from "./outbox";
import { HUB_URL, envServer, loopEntityServer, loopRuns, orderedServers, serverByUrl, serverLoopEntities, serverLoops, serverSupports, servers, type Server } from "./fleet";
import { openPlanDeepLink } from "./autopilot";
import { actLabel, checkLabelShort, circuitSvg, entityStatus, loopEntityToCircuit, loopToCircuit, miniSvg, promotionSuggestion, RUNGS, rung, shipUnlocked, triggerLabel } from "./circuit";
import { stripeColor } from "./sessionColor";
import { currentTheme } from "./theme";
import { initIntake, openIntake } from "./loops-intake";
import type { Environment, Loop, LoopInput, LoopRun, LoopSummary, ServerEvent } from "../../protocol";

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
  // The Claude-led intake conversation renders into the loops overlay root; on arm it opens the new
  // loop's detail, on cancel it returns to the home.
  initIntake({
    environments: deps.environments,
    sendAwait: deps.sendAwait,
    rootId: "lc-root",
    onArmed: (loopId) => openDetail(loopId, true),
    onCancel: () => renderHome(),
  });
  setLoopIntake((prompt, fromDraft) => void openIntake(prompt, fromDraft ? { workUnitId: fromDraft } : undefined));
}

// Claude-led intake (Phase 3) registers its opener here; until then the prompt box opens the dialog.
let intakeStart: ((prompt: string, fromDraft?: string) => void) | null = null;
export function setLoopIntake(fn: (prompt: string, fromDraft?: string) => void): void {
  intakeStart = fn;
}

// Home ↔ detail navigation. `detail` holds the open row's id + whether it's a real entity or projection.
let detail: { id: string; entity: boolean } | null = null;
const projServer = new Map<string, string>(); // projected loopId → server url (approve/convert routing)

// ── Data gathering ──────────────────────────────────────────────────────────────────────────────────
// The daemon-managed Todoist-intake singleton (`loop_autopilot`) and the autopilot `schedule` projection
// are the conveyor that *fills* the gate — a nightly scan that plans linked Todoist projects into drafts.
// They have no lock the user operates (the schedule row has zero detail actions; the intake loop only
// exposes arm/pause + run-now, which live in Autopilot/Settings). Loops is "where you sit at the gate",
// so we don't render them here — their actionable output is the "Drafts at your gate" band. The daemon
// keeps running the job; this is purely a presentation choice.
const INTAKE_LOOP_ID = "loop_autopilot";
function entities(): Loop[] {
  const out: Loop[] = [];
  loopEntityServer.clear();
  for (const s of orderedServers())
    for (const l of serverLoopEntities.get(s.url) ?? []) {
      if (l.id === INTAKE_LOOP_ID) continue; // the nightly intake runner — not a loop you gate
      out.push(l);
      loopEntityServer.set(l.id, s.url);
    }
  return out;
}
function projected(): LoopSummary[] {
  const out: LoopSummary[] = [];
  projServer.clear();
  for (const s of orderedServers())
    for (const l of serverLoops.get(s.url) ?? []) {
      if (l.kind === "schedule") continue; // the autopilot heartbeat — surfaced in Autopilot/Settings, not here
      out.push(l);
      projServer.set(l.id, s.url);
    }
  return out;
}
function runsFor(loopId: string): LoopRun[] {
  return (loopRuns.get(loopId) ?? []).slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
const latestRun = (loopId: string): LoopRun | undefined => runsFor(loopId)[0];
const findEntity = (id: string): Loop | undefined => entities().find((l) => l.id === id);
const findProjected = (id: string): LoopSummary | undefined => projected().find((l) => l.id === id);
const entitySock = (id: string): Server | undefined => serverByUrl(loopEntityServer.get(id));
const projSock = (id: string): Server | undefined => serverByUrl(projServer.get(id));

function gateCount(): number {
  let n = 0;
  for (const list of serverLoops.values()) for (const l of list) if (l.status === "gated") n++;
  // Real entities: count any whose latest run is at the gate (compute directly, independent of render).
  for (const list of serverLoopEntities.values()) for (const l of list) if (latestRun(l.id)?.status === "at-gate") n++;
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
  openOverlay("loops", closeLoops, "#loops");
  detail = null;
  renderHome();
  for (const s of orderedServers())
    if (s.sock.isOpen()) {
      s.sock.send({ type: "loops.get" });
      if (serverSupports(s, "loops")) s.sock.send({ type: "loops.list" }); // real entities
    }
}
function closeLoops(): void {
  detail = null;
  $("#loops-root").innerHTML = "";
}

// A loop with no environment has no project to name it by. When the fleet has >1 connected member we
// group those rows under the owning member's name (this is what separates the otherwise-identical
// per-member rows — e.g. three "Todoist intake" singletons); a single-machine fleet keeps "Fleet".
function fallbackGroup(serverUrl: string | undefined): string {
  const multi = orderedServers().filter((s) => s.sock.isOpen()).length > 1;
  return (multi && serverUrl ? serverByUrl(serverUrl)?.name : undefined) ?? "Fleet";
}
function envNameOfEntity(l: Loop): string {
  return (l.environmentId ? environments.get(l.environmentId)?.name : undefined) ?? fallbackGroup(loopEntityServer.get(l.id));
}
function envNameOfProjected(l: LoopSummary): string {
  return l.environmentName ?? (l.environmentId ? environments.get(l.environmentId)?.name : undefined) ?? fallbackGroup(projServer.get(l.id));
}

function entityChip(l: Loop): string {
  if (l.status === "completed") return `<span class="lc-chip completed">${icon("check_circle")} completed</span>`;
  if (l.status === "archived") return `<span class="lc-chip archived">${icon("inventory_2")} archived</span>`;
  const run = latestRun(l.id);
  const st = entityStatus(l, run);
  if (st === "gated") return `<span class="lc-chip gated">${icon("lock")} at your gate</span>`;
  if (st === "running") return `<span class="lc-chip running">lap ${run?.laps.length ?? 0}/${l.hardStops.maxLaps}</span>`;
  if (st === "paused") return `<span class="lc-chip paused">${esc(l.status)}</span>`;
  if (st === "armed") return `<span class="lc-chip armed">armed</span>`;
  return `<span class="lc-chip">draft</span>`;
}
function entityRowHtml(l: Loop): string {
  const run = latestRun(l.id);
  return `<div class="lc-row" data-id="${esc(l.id)}" data-entity="1" role="button" tabindex="0">
    ${miniSvg(loopEntityToCircuit(l, run))}
    <span class="m"><span class="t">${esc(l.name)}</span><span class="s">${esc(triggerLabel(l.trigger))} → ${esc(actLabel(l.act))}</span></span>
    ${entityChip(l)}
    <span class="msym lc-chev">chevron_right</span>
  </div>`;
}
function projStatusChip(l: LoopSummary): string {
  if (l.status === "gated") return `<span class="lc-chip gated">${icon("lock")} at your gate</span>`;
  if (l.status === "running") return `<span class="lc-chip running">${l.iteration ? `lap ${l.iteration.current}/${l.iteration.max}` : "running"}</span>`;
  if (l.status === "paused") return `<span class="lc-chip paused">paused</span>`;
  const next = l.nextFireAt ? new Date(l.nextFireAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "armed";
  return `<span class="lc-chip armed">${esc(next)}</span>`;
}
function projRowHtml(l: LoopSummary): string {
  return `<div class="lc-row" data-id="${esc(l.id)}" role="button" tabindex="0">
    ${miniSvg(loopToCircuit(l))}
    <span class="m"><span class="t">${esc(l.title)}</span><span class="s">${esc(l.trigger)} → ${esc(l.act ?? l.stopCondition)}</span></span>
    ${projStatusChip(l)}
    <span class="msym lc-chev">chevron_right</span>
  </div>`;
}
function groupByEnv<T>(items: T[], nameOf: (t: T) => string): { name: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const it of items) (groups.get(nameOf(it)) ?? groups.set(nameOf(it), []).get(nameOf(it))!).push(it);
  return [...groups.keys()]
    .sort((a, b) => (a === "Fleet" ? -1 : b === "Fleet" ? 1 : a.localeCompare(b)))
    .map((name) => ({ name, items: groups.get(name)! }));
}
function envSep(name: string, note = ""): string {
  const env = [...environments.values()].find((e) => e.name === name);
  const dot = env ? stripeColor(env, 0, currentTheme()) : "var(--muted)";
  return `<div class="lc-envsep"><span class="env-dot" style="background:${dot}"></span>${esc(name)}${note}</div>`;
}

// Status priority within a project — smaller sorts higher, so what needs YOU rides to the top and the
// terminal loops sink: at-your-gate → running → armed → paused/draft → completed → archived. Real loops
// and projected rows (goals/pipelines/proposals/drafts) share one ranking so they interleave sensibly.
function entityRank(l: Loop): number {
  if (l.status === "completed") return 4;
  if (l.status === "archived") return 5;
  const st = entityStatus(l, latestRun(l.id)); // gated | running | armed | paused | idle
  return st === "gated" ? 0 : st === "running" ? 1 : st === "armed" ? 2 : 3;
}
function projRank(l: LoopSummary): number {
  // Projected rows are never completed/archived (that's an entity lifecycle); drafts/proposals are "gated".
  return l.status === "gated" ? 0 : l.status === "running" ? 1 : l.status === "armed" ? 2 : 3;
}

function renderHome(): void {
  detail = null;
  updateLoopsBadge();
  const app = document.getElementById("lc-root");
  if (!app) return;
  // Project-first: every loop — real entities and projected goals/pipelines/proposals/drafts — folds into
  // its owning project (env; member/"Fleet" fallback), then sorts by status so the gate-blockers lead and
  // the done/retired ones trail. One project's whole footprint lives in one section.
  type Card = { env: string; rank: number; html: string };
  const cards: Card[] = [
    ...entities().map((l) => ({ env: envNameOfEntity(l), rank: entityRank(l), html: entityRowHtml(l) })),
    ...projected().map((l) => ({ env: envNameOfProjected(l), rank: projRank(l), html: projRowHtml(l) })),
  ];
  const sectionsHtml = groupByEnv(cards, (c) => c.env)
    .map((g) => {
      const items = g.items.slice().sort((a, b) => a.rank - b.rank); // stable → equal ranks keep server order
      const gated = items.filter((c) => c.rank === 0).length; // preserves the old "at your gate" signal per project
      const note = gated ? ` <span class="lc-envsep-count">${gated} ${icon("lock")}</span>` : "";
      return `${envSep(g.name, note)}<div class="lc-rows">${items.map((c) => c.html).join("")}</div>`;
    })
    .join("");
  const empty = !cards.length
    ? `<div class="ap-empty">${icon("all_inclusive")}<p>No loops yet.</p><p class="small muted">Describe an outcome above — Claude builds the loop with you.</p></div>`
    : "";

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
    ${sectionsHtml}${empty}`;
  $("#lc-close").addEventListener("click", () => dismissOverlay("loops"));
  const go = (): void => {
    const v = (document.getElementById("lc-prompt") as HTMLInputElement | null)?.value.trim();
    if (intakeStart) intakeStart(v ?? "");
    else openNewLoopDialog(v ?? "");
  };
  $("#lc-go").addEventListener("click", go);
  document.getElementById("lc-prompt")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") go();
  });
  app.querySelectorAll<HTMLElement>(".lc-row").forEach((r) => {
    const open = (): void => openDetail(r.dataset.id!, r.dataset.entity === "1");
    r.addEventListener("click", open);
    r.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") open();
    });
  });
}

// ── Detail ─────────────────────────────────────────────────────────────────────────────────────────
function openDetail(id: string, entity: boolean): void {
  detail = { id, entity };
  if (entity) renderEntityDetail();
  else renderProjectedDetail();
}
function backHome(): void {
  detail = null;
  renderHome();
}

function renderEntityDetail(): void {
  if (!detail) return;
  const app = document.getElementById("lc-root");
  const loop = findEntity(detail.id);
  if (!app || !loop) return backHome();
  const run = latestRun(loop.id);
  const view = loopEntityToCircuit(loop, run);
  const r = rung(loop.rung);
  const terminal = loop.status === "completed" || loop.status === "archived";
  const atGate = !terminal && run?.status === "at-gate";
  const running = run?.status === "running" || run?.status === "sent-back";
  const hs = loop.hardStops;
  const tokensUsed = run ? run.laps.reduce((n, l) => n + (l.tokens ?? 0), 0) : 0;
  const budPct = Math.min(100, Math.round((tokensUsed / Math.max(1, hs.tokenBudget)) * 100));
  const lapPct = run ? Math.min(100, Math.round((run.laps.length / Math.max(1, hs.maxLaps)) * 100)) : 0;

  const gateVerbs = atGate
    ? `<button class="primary" id="lc-open">${icon("lock_open")} Open the gate ${loop.rung === "draft" ? "(push branch)" : loop.rung === "pr" ? "(open PR)" : loop.rung === "ship" ? "(merge)" : "(publish)"}</button>
       <button class="mini danger" id="lc-sendback">${icon("replay")} Send back a lap</button>`
    : "";
  // A terminal loop (completed/archived) offers only Restore + Delete; an active one adds Complete/Archive.
  const controls = terminal
    ? `<button class="mini" id="lc-restore">${icon("undo")} Restore</button>
       <button class="mini danger" id="lc-delete">${icon("delete")} Delete</button>`
    : `<button class="mini" id="lc-run"${running ? " disabled" : ""}>${icon("play_arrow")} Run now</button>
       <button class="mini" id="lc-toggle">${icon(loop.status === "armed" ? "pause" : "bolt")} ${loop.status === "armed" ? "Pause" : "Arm"}</button>
       ${loop.status !== "armed" ? `<button class="mini" id="lc-edit">${icon("edit")} Edit</button>` : ""}
       <button class="mini" id="lc-complete">${icon("check_circle")} Complete</button>
       <button class="mini" id="lc-archive">${icon("inventory_2")} Archive</button>
       <button class="mini danger" id="lc-delete">${icon("delete")} Delete</button>`;

  const runsHtml = runsFor(loop.id)
    .slice(0, 5)
    .flatMap((rn) => rn.laps.slice().reverse().map((lap) => lapRowHtml(lap, rn)))
    .join("");
  const reasonNote = run?.reason ? `<p class="lc-sub" style="margin-top:-6px">${icon("info")} ${esc(run.status)}: ${esc(run.reason)}</p>` : "";
  const assumptions = loop.assumptions.length
    ? `<div class="lc-card"><h3>Assumptions — logged at intake</h3><ul class="lc-assume">${loop.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>`
    : "";

  app.innerHTML = `
    <div class="lc-head">
      <button class="mini" id="lc-back">${icon("arrow_back")} Loops</button>
      <h2>${esc(loop.name)}</h2>
      <span class="lc-chip ${terminal ? esc(loop.status) : esc(entityStatus(loop, run))}">${esc(terminal ? loop.status : (run?.status ?? loop.status))}</span>
    </div>
    <div class="lc-circuit-card">${circuitSvg(view)}</div>
    ${reasonNote}
    <div class="lc-actions">${gateVerbs}${controls}</div>
    <div class="lc-card"><h3>Hard stops <span style="text-transform:none">(every loop has all three)</span></h3>
      <div class="lc-caps">
        <div class="cap"><b>Laps ${run?.laps.length ?? 0} / ${hs.maxLaps}</b><div class="lc-bar"><i style="width:${lapPct}%"></i></div><span>hard ceiling</span></div>
        <div class="cap"><b>Budget ${Math.round(tokensUsed / 1000)}k / ${Math.round(hs.tokenBudget / 1000)}k</b><div class="lc-bar"><i class="${budPct > 70 ? "warn" : ""}" style="width:${budPct}%"></i></div><span>tokens this run</span></div>
        <div class="cap"><b>No progress → stop</b><div class="lc-bar"><i style="width:0%"></i></div><span>${hs.noProgressLaps} identical laps halts it</span></div>
      </div></div>
    <div class="lc-card"><h3>Autonomy — where your gate sits</h3>
      <div class="lc-ladder">${RUNGS.map((x) => {
        const shipLocked = x.k === "ship" && !shipUnlocked(loop);
        const disabled = shipLocked || loop.status === "armed";
        const title = shipLocked ? "Ship unlocks after 3 clean gated laps" : loop.status === "armed" ? "Pause to change the gate" : "";
        return `<button data-rung="${x.k}" class="${loop.rung === x.k ? "on" : ""}"${disabled ? ` disabled title="${esc(title)}"` : ""}><b>${x.name}</b>${esc(x.desc.split(".")[0]!)}</button>`;
      }).join("")}</div>
      ${promoteBannerHtml(loop)}
      <p class="lc-ladder-note">${icon("trending_up")} Loops <b>earn</b> autonomy: after 3 clean gated laps, Claude suggests moving the gate right. ${loop.cleanGatedLaps ? `(${loop.cleanGatedLaps} clean so far)` : ""}</p>
      ${mergeConfigHtml(loop)}</div>
    ${assumptions}
    <div class="lc-card"><h3>Lap history</h3><div class="lc-laps">${runsHtml || `<p class="small muted">No laps yet — Run now to start.</p>`}</div></div>`;

  $("#lc-back").addEventListener("click", backHome);
  document.getElementById("lc-run")?.addEventListener("click", () => void runLoop(loop.id));
  document.getElementById("lc-toggle")?.addEventListener("click", () => void toggleArm(loop));
  document.getElementById("lc-edit")?.addEventListener("click", () => openNewLoopDialog("", loop));
  document.getElementById("lc-complete")?.addEventListener("click", () => void completeLoopEntity(loop));
  document.getElementById("lc-archive")?.addEventListener("click", () => void archiveLoop(loop));
  document.getElementById("lc-restore")?.addEventListener("click", () => void restoreLoop(loop));
  document.getElementById("lc-delete")?.addEventListener("click", () => void deleteLoop(loop));
  document.getElementById("lc-open")?.addEventListener("click", () => void openGate(loop.id, run!.id));
  document.getElementById("lc-sendback")?.addEventListener("click", () => void sendBack(loop.id, run!.id));
  app.querySelectorAll<HTMLElement>(".lc-ladder [data-rung]").forEach((b) =>
    b.addEventListener("click", () => {
      if ((b as HTMLButtonElement).disabled) return;
      void setRung(loop, b.dataset.rung as Loop["rung"]);
    }),
  );
  document.getElementById("lc-promote-accept")?.addEventListener("click", () => void promoteRung(loop, (document.getElementById("lc-promote-accept") as HTMLElement).dataset.rung as Loop["rung"]));
  const mergeMethodEl = document.getElementById("lc-merge-method") as HTMLSelectElement | null;
  const mergeGreenEl = document.getElementById("lc-merge-green") as HTMLInputElement | null;
  const applyMerge = (): void => void setMerge(loop, (mergeMethodEl?.value as MergeMethod) ?? "squash", mergeGreenEl?.checked ?? false);
  mergeMethodEl?.addEventListener("change", applyMerge);
  mergeGreenEl?.addEventListener("change", applyMerge);
}

type MergeMethod = "squash" | "merge" | "rebase";
/** Ship-rung merge config (FU-3): how the loop auto-merges + whether it waits for green CI. Shown only
 *  on the Ship rung; editing needs a paused loop (like every other edit). */
function mergeConfigHtml(loop: Loop): string {
  if (loop.rung !== "ship") return "";
  const method = loop.merge?.method ?? "squash";
  const green = loop.merge?.requireGreen === true;
  const disabled = loop.status === "armed";
  const opt = (v: MergeMethod, label: string): string => `<option value="${v}"${v === method ? " selected" : ""}>${label}</option>`;
  return `<div class="lc-merge-cfg"${disabled ? ' title="Pause to change how Ship merges"' : ""}>
    <label class="ap-field-row"><span>${icon("merge")} Ship merges by</span>
      <select id="lc-merge-method"${disabled ? " disabled" : ""}>${opt("squash", "Squash")}${opt("merge", "Merge commit")}${opt("rebase", "Rebase")}</select></label>
    <label class="lc-merge-green"><input type="checkbox" id="lc-merge-green"${green ? " checked" : ""}${disabled ? " disabled" : ""}/> Wait for green CI before merging (<code>gh pr checks</code>)</label></div>`;
}
/** Persist a merge-config change (pause→save→re-arm, like promoteRung — an explicit user edit). */
async function setMerge(loop: Loop, method: MergeMethod, requireGreen: boolean): Promise<void> {
  const wasArmed = loop.status === "armed";
  if (wasArmed && !(await loopSend(loop.id, { type: "loop.pause", loopId: loop.id }))) return;
  const input = loopToInput(loop);
  input.merge = { method, ...(requireGreen ? { requireGreen: true } : {}) };
  if (!(await loopSend(loop.id, { type: "loop.save", loop: input }))) return;
  if (wasArmed) await loopSend(loop.id, { type: "loop.arm", loopId: loop.id });
  toast(`Ship merges by ${method}${requireGreen ? " on green CI" : ""}`);
}

/** Accept a promotion suggestion: pause if armed, move the gate one rung, re-arm — an explicit user tap. */
async function promoteRung(loop: Loop, next: Loop["rung"]): Promise<void> {
  const wasArmed = loop.status === "armed";
  if (wasArmed && !(await loopSend(loop.id, { type: "loop.pause", loopId: loop.id }))) return;
  const input = loopToInput(loop);
  input.rung = next;
  if (!(await loopSend(loop.id, { type: "loop.save", loop: input }))) return;
  if (wasArmed) await loopSend(loop.id, { type: "loop.arm", loopId: loop.id });
  toast(`Gate moved to ${rung(next).name}`);
}

/** The earned-autonomy promotion suggestion banner (never silent; only an explicit tap changes the rung). */
function promoteBannerHtml(loop: Loop): string {
  const next = promotionSuggestion(loop);
  if (!next) return "";
  return `<div class="lc-promote" id="lc-promote">${icon("trending_up")}
    <span><b>Earned it.</b> ${loop.cleanGatedLaps} clean gated laps — move the gate to <b>${esc(rung(next).name)}</b>?</span>
    <button class="mini" id="lc-promote-accept" data-rung="${next}">${icon("check")} Move gate</button></div>`;
}

function lapRowHtml(lap: LoopRun["laps"][number], run: LoopRun): string {
  const worst = lap.verdicts.find((v) => v.v !== "pass") ?? lap.verdicts[0];
  const cls = !worst ? "live" : worst.v === "pass" ? "pass" : "fail";
  const word = !worst ? "…" : worst.v === "pass" ? "pass" : worst.v;
  const detailTxt = worst?.detail ? ` — ${worst.detail}` : "";
  return `<div class="lc-lap-row"><span class="lc-lap-n">Lap ${lap.n}</span><span class="what">${esc(lap.summary)}${esc(detailTxt)}</span><span class="verdict ${cls}">${esc(word)}</span></div>`;
}

// The Phase-1 projected detail (schedule/goal/pipeline/proposal/draft) — verbs map to autopilot commands.
function renderProjectedDetail(): void {
  if (!detail) return;
  const app = document.getElementById("lc-root");
  const l = findProjected(detail.id);
  if (!app || !l) return backHome();
  const r = rung(loopToCircuit(l).rung);
  let actions = "";
  if (l.kind === "trigger" && l.status === "gated")
    actions = `<button class="primary" id="lc-approve">${icon("check")} Approve — plan &amp; build</button>
      <button class="mini danger" id="lc-reject">${icon("close")} Reject</button>`;
  else if (l.kind === "draft")
    actions = `<button class="primary" id="lc-convert">${icon("all_inclusive")} Convert to a loop</button>
      <button class="mini" id="lc-open-draft">${icon("open_in_new")} Open the draft</button>`;
  else if (l.sessionId) actions = `<button class="mini" id="lc-jump">${icon("open_in_new")} Open its session</button>`;
  const iterCard = l.iteration
    ? `<div class="lc-card"><h3>Laps</h3><div class="lc-caps"><div class="cap"><b>Lap ${l.iteration.current} / ${l.iteration.max}</b>
        <div class="lc-bar"><i style="width:${Math.round((l.iteration.current / Math.max(1, l.iteration.max)) * 100)}%"></i></div><span>live lap count · hard ceiling</span></div></div></div>`
    : "";
  app.innerHTML = `
    <div class="lc-head"><button class="mini" id="lc-back">${icon("arrow_back")} Loops</button><h2>${esc(l.title)}</h2>
      <span class="lc-chip ${esc(l.status)}">${esc(l.status === "gated" ? "at your gate" : l.status)}</span></div>
    <div class="lc-circuit-card">${circuitSvg(loopToCircuit(l))}</div>
    ${l.detail ? `<p class="lc-sub" style="margin-top:-6px">${icon("info")} ${esc(l.detail)}</p>` : ""}
    ${actions ? `<div class="lc-actions">${actions}</div>` : ""}
    ${iterCard}
    <div class="lc-card"><h3>Autonomy — where your gate sits</h3>
      <div class="lc-ladder">${RUNGS.map((x) => `<button class="${r.k === x.k ? "on" : ""}" disabled><b>${x.name}</b>${esc(x.desc.split(".")[0]!)}</button>`).join("")}</div>
      <p class="lc-ladder-note">${icon("trending_up")} This is a projected loop — convert a draft to unlock the full controls.</p></div>`;
  $("#lc-back").addEventListener("click", backHome);
  document.getElementById("lc-jump")?.addEventListener("click", () => {
    if (!l.sessionId) return;
    dismissOverlay("loops");
    selectSession(l.sessionId);
  });
  document.getElementById("lc-open-draft")?.addEventListener("click", () => {
    dismissOverlay("loops");
    openPlanDeepLink(l.id);
  });
  document.getElementById("lc-convert")?.addEventListener("click", () =>
    void openIntake(l.title, { workUnitId: l.id, ...(l.environmentId ? { environmentId: l.environmentId } : {}) }),
  );
  document.getElementById("lc-approve")?.addEventListener("click", () => void approveProposal(l.id));
  document.getElementById("lc-reject")?.addEventListener("click", () => void rejectProposal(l.id, l.title));
}

// ── Real-loop verbs ──────────────────────────────────────────────────────────────────────────────
async function loopSend(id: string, cmd: Record<string, unknown> & { type: string }, timeout = 60_000): Promise<ServerEvent | null> {
  const srv = entitySock(id) ?? serverByUrl(HUB_URL);
  if (!srv?.sock.isOpen()) {
    toast("That loop's server is offline");
    return null;
  }
  try {
    const res = await sendAwait(srv, { ...cmd, cid: newCid() }, timeout);
    if (res.type === "command.error") {
      toast(res.message);
      return null;
    }
    return res;
  } catch (err) {
    toast(`${cmd.type} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
async function runLoop(id: string): Promise<void> {
  if (await loopSend(id, { type: "loop.run", loopId: id })) toast("Run started");
}
async function toggleArm(loop: Loop): Promise<void> {
  const arm = loop.status !== "armed";
  if (await loopSend(loop.id, { type: arm ? "loop.arm" : "loop.pause", loopId: loop.id })) toast(arm ? "Armed" : "Paused");
}
async function setRung(loop: Loop, rungK: Loop["rung"]): Promise<void> {
  if (loop.status === "armed") {
    toast("Pause the loop to change the gate");
    return;
  }
  const input = loopToInput(loop);
  input.rung = rungK;
  if (await loopSend(loop.id, { type: "loop.save", loop: input })) toast(`Gate moved: ${rung(rungK).name}`);
}
async function deleteLoop(loop: Loop): Promise<void> {
  const ok = await confirmDialog({ title: "Delete this loop?", body: `“${loop.name}” and its run history will be removed.`, confirmLabel: "Delete", danger: true, icon: "delete" });
  if (!ok) return;
  if (await loopSend(loop.id, { type: "loop.remove", loopId: loop.id })) {
    toast("Loop deleted");
    backHome();
  }
}
async function completeLoopEntity(loop: Loop): Promise<void> {
  const body = "Marks the loop done and moves it to Completed. Reversible.";
  let closeTodoist = false;
  if (loop.workUnitId) {
    // Converted-from-a-draft loops carry a Todoist source task — offer to close it out too.
    const r = await confirmDialogWithOption({ title: `Complete “${loop.name}”?`, body, confirmLabel: "Complete", icon: "check_circle", optionLabel: "Also complete the linked Todoist task", optionChecked: true });
    if (!r.ok) return;
    closeTodoist = r.checked;
  } else if (!(await confirmDialog({ title: `Complete “${loop.name}”?`, body, confirmLabel: "Complete", icon: "check_circle" }))) {
    return;
  }
  if (await loopSend(loop.id, { type: "loop.complete", loopId: loop.id, closeTodoist })) {
    toast("Loop completed");
    backHome();
  }
}
async function archiveLoop(loop: Loop): Promise<void> {
  const ok = await confirmDialog({ title: `Archive “${loop.name}”?`, body: "Retires the loop out of the active view. Restore it anytime.", confirmLabel: "Archive", icon: "inventory_2" });
  if (!ok) return;
  if (await loopSend(loop.id, { type: "loop.archive", loopId: loop.id })) {
    toast("Loop archived");
    backHome();
  }
}
async function restoreLoop(loop: Loop): Promise<void> {
  if (await loopSend(loop.id, { type: "loop.pause", loopId: loop.id })) {
    toast("Restored — paused; arm it when ready");
    backHome();
  }
}
async function openGate(loopId: string, runId: string): Promise<void> {
  if (await loopSend(loopId, { type: "loop.gate.open", runId })) toast("Gate opened");
}
async function sendBack(loopId: string, runId: string): Promise<void> {
  const note = await promptDialog({ title: "Send back a lap", placeholder: "What should change this lap?", confirmLabel: "Send back", icon: "replay", multiline: true });
  if (!note) return;
  if (await loopSend(loopId, { type: "loop.gate.sendback", runId, note })) toast("Sent back for another lap");
}
async function approveProposal(id: string): Promise<void> {
  const srv = projSock(id);
  if (!srv?.sock.isOpen()) return void toast("That loop's server is offline");
  try {
    const res = await sendAwait(srv, { type: "autopilot.approve", workUnitId: id, start: false, cid: newCid() }, 60_000);
    if (res.type === "command.error") return void toast(res.message);
    toast("Approved — ready to build");
    backHome();
  } catch (err) {
    toast(`Approve failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function rejectProposal(id: string, title: string): Promise<void> {
  const ok = await confirmDialog({ title: "Reject this proposal?", body: `“${title}” will be dismissed.`, confirmLabel: "Reject", danger: true, icon: "close" });
  if (!ok) return;
  const srv = projSock(id);
  if (!srv?.sock.isOpen()) return void toast("That loop's server is offline");
  try {
    const res = await sendAwait(srv, { type: "autopilot.dismiss", workUnitId: id, cid: newCid() }, 60_000);
    if (res.type === "command.error") return void toast(res.message);
    toast("Rejected");
    backHome();
  } catch (err) {
    toast(`Reject failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── New / Edit loop dialog (Phase 2 scaffolding; Phase 3 intake replaces the primary path) ───────────
function loopToInput(loop: Loop): LoopInput {
  return {
    id: loop.id,
    name: loop.name,
    ...(loop.environmentId ? { environmentId: loop.environmentId } : {}),
    trigger: loop.trigger,
    act: loop.act,
    checks: loop.checks,
    checksMode: loop.checksMode,
    ...(loop.scope ? { scope: loop.scope } : {}),
    rung: loop.rung,
    hardStops: loop.hardStops,
    ...(loop.merge ? { merge: loop.merge } : {}),
    assumptions: loop.assumptions,
    notify: loop.notify,
  };
}
export function openNewLoopDialog(seedPrompt = "", editing?: Loop): void {
  const envs = [...environments.values()];
  const curPrompt = editing?.act.kind === "session-prompt" ? editing.act.prompt : seedPrompt;
  const curCheck = editing?.checks.find((c) => c.kind === "command");
  const curCheckCmd = curCheck && curCheck.kind === "command" ? curCheck.command : "bun test";
  const curScope = editing?.scope?.allow.join(", ") ?? "";
  const curRung = editing?.rung ?? "pr";
  const curMax = editing?.hardStops.maxLaps ?? 10;
  const m = document.createElement("div");
  m.className = "modal";
  const envOptions = `<option value="">— none (hub) —</option>` + envs.map((e) => `<option value="${esc(e.id)}"${e.id === editing?.environmentId ? " selected" : ""}>${esc(e.name)}</option>`).join("");
  const rungOptions = RUNGS.filter((r) => r.k !== "ship").map((r) => `<option value="${r.k}"${r.k === curRung ? " selected" : ""}>${r.name} — ${r.gate}</option>`).join("");
  m.innerHTML = `<div class="modal-box lc-new-modal"><h3>${icon("all_inclusive")} ${editing ? "Edit loop" : "New loop"}</h3>
    <label class="ap-field-row"><span>Name</span><input type="text" id="lc-name" value="${esc(editing?.name ?? (seedPrompt ? seedPrompt.slice(0, 48) : ""))}" placeholder="Fix the flaky upload test" /></label>
    <label class="ap-field-row"><span>Environment</span><select id="lc-env">${envOptions}</select></label>
    <label class="ap-field"><span>What should the loop do? (prompt)</span><textarea id="lc-prompt-body" rows="3" placeholder="Find and fix the flakiness…">${esc(curPrompt)}</textarea></label>
    <label class="ap-field-row"><span>Check (command)</span><input type="text" id="lc-check" value="${esc(curCheckCmd)}" placeholder="bun test upload" /></label>
    <p class="small muted" style="margin:-4px 0 6px">Name the file(s) the check reads (e.g. <code>bun test test/upload.test.ts</code>) and the loop locks them — a lap that edits its own check inputs fails as check-tampering.</p>
    <label class="ap-field-row"><span>Scope (globs, comma-sep)</span><input type="text" id="lc-scope" value="${esc(curScope)}" placeholder="src/upload/" /></label>
    <label class="ap-field-row"><span>Gate</span><select id="lc-rung">${rungOptions}</select></label>
    <label class="ap-field-row"><span>Max laps</span><input type="number" id="lc-max" min="1" max="50" value="${curMax}" /></label>
    <div class="btns"><button type="button" id="lc-cancel">Cancel</button><button type="button" id="lc-save" class="primary">${editing ? "Save" : "Create & arm"}</button></div></div>`;
  showModal(m);
  $("#lc-cancel").addEventListener("click", closeModal);
  $("#lc-save").addEventListener("click", () => void saveNewLoop(editing));
}
async function saveNewLoop(editing?: Loop): Promise<void> {
  const name = $<HTMLInputElement>("#lc-name").value.trim();
  const environmentId = $<HTMLSelectElement>("#lc-env").value || undefined;
  const prompt = $<HTMLTextAreaElement>("#lc-prompt-body").value.trim();
  const checkCmd = $<HTMLInputElement>("#lc-check").value.trim();
  const scopeRaw = $<HTMLInputElement>("#lc-scope").value.trim();
  const rungK = $<HTMLSelectElement>("#lc-rung").value as Loop["rung"];
  const maxLaps = Math.max(1, Number($<HTMLInputElement>("#lc-max").value) || 10);
  if (!name) return void toast("A loop needs a name");
  if (!prompt) return void toast("A loop needs a prompt");
  const allow = scopeRaw ? scopeRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  // Lock the check's own inputs when they look like on-disk paths in the command (best-effort).
  const locks = checkCmd.split(/\s+/).filter((t) => /[./]/.test(t) && !t.startsWith("-"));
  const input: LoopInput = {
    ...(editing ? { id: editing.id } : {}),
    name,
    ...(environmentId ? { environmentId } : {}),
    trigger: { kind: "manual" },
    act: { kind: "session-prompt", prompt },
    checks: checkCmd ? [{ kind: "command", command: checkCmd, ...(locks.length ? { locks } : {}) }] : [],
    checksMode: "all",
    ...(allow.length ? { scope: { allow } } : {}),
    rung: rungK,
    hardStops: { maxLaps },
  };
  // Route to the env's server, else the hub.
  const url = environmentId ? envServer.get(environmentId) : HUB_URL;
  const srv = serverByUrl(url) ?? serverByUrl(HUB_URL) ?? servers.get(HUB_URL);
  if (!srv?.sock.isOpen()) return void toast("Server offline");
  if (!serverSupports(srv, "loops")) return void toast("This server doesn't support loops yet — update it");
  try {
    const res = await sendAwait(srv, { type: "loop.save", loop: input, cid: newCid() }, 30_000);
    if (res.type === "command.error") return void toast(res.message);
    if (res.type !== "loop.updated") return;
    const loop = res.loop;
    if (!editing) {
      // Arm the new loop straight away (dialog is the power-user path; intake dry-runs first in Phase 3).
      await sendAwait(srv, { type: "loop.arm", loopId: loop.id, cid: newCid() }, 20_000);
    }
    closeModal();
    toast(editing ? "Loop saved" : "Loop created & armed");
    openDetail(loop.id, true);
  } catch (err) {
    toast(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Event routing ────────────────────────────────────────────────────────────────────────────────
export function onLoopsHome(): void {
  updateLoopsBadge();
  if (!overlayOpen("loops")) return;
  tryOpenPendingLoop();
  reRender();
}
/** A server delivered its full loop catalog (loops.list). */
export function onLoopsList(url: string, loops: Loop[]): void {
  serverLoopEntities.set(url, loops);
  onLoopEntityUpdate();
}
/** A single loop changed (loop.updated) — upsert into its server's catalog. */
export function onLoopUpdated(url: string, loop: Loop): void {
  const list = serverLoopEntities.get(url) ?? [];
  const i = list.findIndex((l) => l.id === loop.id);
  if (i >= 0) list[i] = loop;
  else list.push(loop);
  serverLoopEntities.set(url, list);
  onLoopEntityUpdate();
}
/** A live run/lap update (loop.run) — cache it under its loop, newest snapshot wins. */
export function onLoopRun(run: LoopRun): void {
  const list = (loopRuns.get(run.loopId) ?? []).filter((r) => r.id !== run.id);
  list.push(run);
  loopRuns.set(run.loopId, list);
  onLoopEntityUpdate();
}
/** A loop's run history (loop.runs). */
export function onLoopRuns(loopId: string, runs: LoopRun[]): void {
  loopRuns.set(loopId, runs);
  onLoopEntityUpdate();
}
/** loop.updated / loops.list / loop.run / loop.runs updated the fleet caches → refresh the open view. */
export function onLoopEntityUpdate(): void {
  updateLoopsBadge();
  if (!overlayOpen("loops")) return;
  reRender();
}
function reRender(): void {
  if (detail?.entity) renderEntityDetail();
  else if (detail) renderProjectedDetail();
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
  const ent = findEntity(pendingLoopDeepLink);
  const proj = findProjected(pendingLoopDeepLink);
  if (!ent && !proj) return;
  const id = pendingLoopDeepLink;
  pendingLoopDeepLink = null;
  openDetail(id, !!ent);
}
