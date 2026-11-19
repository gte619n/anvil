// ── Settings → CAD: the SolidCraft fleet pin card (agent-cad-and-browser spec §4.10) ─────────────
// Shows, per machine, which SolidCraft build it runs (version + where it came from), whether it is
// on the fleet pin, and the pin itself; and offers the two manual controls of Phase B1: "Set pin to
// version…" and "Pin back" (with its warning list).
//
// Split in two so it can be tested without the rest of Settings:
//   - `cadCardHtml(view)` is a pure string builder;
//   - `mountCadCard(host, api)` fetches, renders and wires the controls through an injected `api`.
//
// Phase B2 adds the replay gate: the "Last replay gate result" row and a block under the machines
// table with the last evaluation (candidate, when, result, per-machine status, per-part differences,
// advisory list) and two more controls, "Check now" and "Advance anyway" (which shows the
// differences and asks before it pins). They appear when the `api` has the gate methods and the hub
// answers; against an older hub the row stays a labelled placeholder.
//
// PLACEHOLDER FOR A LATER PHASE — one row is rendered now and filled in later, by passing the
// value in `CadCardExtras` (nothing else in this file needs to change):
//   - `liveProcesses`  "Live CAD processes"       → Track A (the CAD process manager)
// (`replayGate` in `CadCardExtras` still overrides the replay-gate row's one line, if given.)
import { esc, icon } from "./dom";
import type { rest, SolidcraftEvaluation, SolidcraftGateMachine, SolidcraftReplayDifference, SolidcraftReplayPart } from "../../protocol";

/** Values supplied by later phases. Plain text; absent ⇒ the labelled placeholder is shown. */
export interface CadCardExtras {
  /** Phase B2: one line describing the last replay gate run (candidate, pass/held, when). */
  replayGate?: string;
  /** Track A: one line describing the SolidCraft processes running now (count per machine). */
  liveProcesses?: string;
}

export interface CadCardView {
  /** null ⇒ not loaded yet. */
  status: rest.solidcraft.FleetStatusResponse | null;
  /** The "Pin back" warning, shown inline once the owner asks to pin back. */
  pinBack?: rest.solidcraft.PinBackPreviewResponse | null;
  /** The last failed action, shown until the next one. */
  error?: string;
  extras?: CadCardExtras;
  /** The replay gate's state (Phase B2). undefined/null ⇒ the hub did not supply it. */
  gate?: rest.solidcraft.CandidateStatusResponse | null;
  /** "Advance anyway" was asked for: the differences are shown with a confirm button. */
  advanceAsk?: boolean;
  /** A "Check now" is running. */
  checking?: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  managed: "managed install",
  app: "SolidCraft.app",
  env: "ANVIL_SOLIDCRAFT_CLI override",
};

const STATE_LABEL: Record<rest.solidcraft.MemberState, string> = {
  pending: "Waiting",
  "pending-offline": "Offline",
  unsupported: "Not switched on",
  installing: "Installing…",
  ready: "Ready",
  unpinned: "No pin",
  error: "Error",
};

const shortSha = (sha: string): string => sha.slice(0, 12);

function memberRow(m: rest.solidcraft.Member): string {
  const cls = m.state === "ready" ? "connected" : m.state === "error" ? "disconnected" : m.state === "installing" ? "connecting" : "";
  const version = m.version ? `<code class="small">${esc(m.version)}</code>` : `<span class="small muted">—</span>`;
  const source = m.source ? `<span class="small muted">(${esc(SOURCE_LABEL[m.source] ?? m.source)})</span>` : "";
  const detail = m.detail && m.state !== "ready" ? `<div class="small ${m.state === "error" ? "warn" : "muted"} cad-detail">${esc(m.detail)}</div>` : "";
  return `<tr class="cad-machine" data-server-id="${esc(m.serverId)}" data-state="${esc(m.state)}">
        <td><b>${esc(m.serverName)}</b>${m.isHub ? ` <span class="small muted">(hub)</span>` : ""}</td>
        <td>${version} ${source}</td>
        <td><span class="conn-dot ${cls}" style="display:inline-block"></span> <span class="cad-state">${esc(STATE_LABEL[m.state] ?? m.state)}</span>${detail}</td>
      </tr>`;
}

function pinBackWarningHtml(p: rest.solidcraft.PinBackPreviewResponse): string {
  if (!p.ok || !p.previous) return `<div id="cad-pinback-warning" class="card"><p class="small warn">${esc(p.error ?? "There is no previous pin to go back to.")}</p></div>`;
  const list = p.listUnavailable
    ? `<p id="cad-pinback-unavailable" class="small warn">${icon("warning")} The list of designs already rewritten by SolidCraft ${esc(p.current?.version ?? "the newer build")} is not available yet, so it is not known which designs may fail to open after pinning back. Nothing is rewritten automatically.</p>`
    : p.rewritten.length
    ? `<p class="small warn">${icon("warning")} These designs were already rewritten by SolidCraft ${esc(p.current?.version ?? "the newer build")} and may not open after pinning back. Nothing is rewritten automatically.</p>
        <ul id="cad-pinback-list" class="small">${p.rewritten
          .map((d) => `<li>${esc(d.part)}${d.environment ? ` <span class="muted">· ${esc(d.environment)}</span>` : ""}${d.serverName ? ` <span class="muted">· ${esc(d.serverName)}</span>` : ""}</li>`)
          .join("")}</ul>`
    : `<p id="cad-pinback-none" class="small muted">No designs are recorded as rewritten by SolidCraft ${esc(p.current?.version ?? "the newer build")}.</p>`;
  const incomplete = p.listError ? `<p class="small warn">The list could not be completed (${esc(p.listError)}). Treat it as incomplete.</p>` : "";
  return `<div id="cad-pinback-warning" class="card">
        <b>Pin back to SolidCraft ${esc(p.previous.version)}?</b>
        ${list}${incomplete}
        <div class="card-main" style="margin-top:8px;gap:8px">
          <button id="cad-pinback-confirm" class="danger">${icon("undo")} Pin back to ${esc(p.previous.version)}</button>
          <button id="cad-pinback-cancel" class="mini">Cancel</button>
        </div></div>`;
}

// ── Replay gate (Phase B2) ──────────────────────────────────────────────────────────────────────

const RESULT_LABEL: Record<SolidcraftEvaluation["result"], string> = {
  advanced: "passed — pin advanced",
  rejected: "rejected — pin held",
  held: "held — not decided",
  error: "could not be evaluated",
};
const GATE_STATE_LABEL: Record<SolidcraftGateMachine["state"], string> = {
  pass: "Same on every design",
  fail: "Differs",
  held: "Could not be decided",
  "no-designs": "Hosts no designs",
  unreachable: "Unreachable",
  unsupported: "Not switched on",
  error: "Error",
};
const FIELD_LABEL: Record<SolidcraftReplayDifference["field"], string> = {
  body_count: "body count",
  faces: "face count",
  volume_mm3: "volume (mm³)",
  bbox: "bounding box (mm, sorted)",
  center_of_mass: "centre of mass (mm)",
};
const fmtNum = (v: number | number[]): string => (Array.isArray(v) ? `[${v.map((x) => String(+x.toPrecision(9))).join(", ")}]` : String(+v.toPrecision(12)));

/** Can the owner advance this evaluation's candidate by hand? */
function canAdvanceAnyway(ev: SolidcraftEvaluation | undefined, pinVersion: string | undefined): ev is SolidcraftEvaluation {
  return !!ev && ev.result !== "advanced" && !ev.advancedAnyway && ev.candidate.version !== pinVersion;
}

/** One line for the "Last replay gate result" row. */
export function gateSummary(g: rest.solidcraft.CandidateStatusResponse): string {
  if (g.evaluating) return `Evaluating SolidCraft ${g.evaluating.version}… the pinned build keeps serving.`;
  const ev = g.lastEvaluation;
  if (!ev) return g.lastCheck ? `No candidate evaluated yet. Last check ${new Date(g.lastCheck.at).toLocaleString()}: ${g.lastCheck.detail}` : "No candidate has been evaluated yet.";
  return `${ev.candidate.version} ${RESULT_LABEL[ev.result]}${ev.advancedAnyway ? " — advanced anyway by the owner" : ""} · ${new Date(ev.finishedAt).toLocaleString()}`;
}

function partRow(p: SolidcraftReplayPart, serverName: string): string {
  const where = `${esc(p.environment)}${p.worktree ? ` · worktree ${esc(p.worktree)}` : p.ref ? ` · ${esc(p.ref)}` : ""} · ${esc(serverName)}`;
  const body =
    p.outcome === "differs"
      ? (p.differences ?? [])
          .map((d) => `<div class="cad-diff" data-field="${esc(d.field)}">${esc(FIELD_LABEL[d.field])}${d.body ? ` of ${esc(d.body)}` : ""}: <code>${esc(fmtNum(d.old))}</code> → <code>${esc(fmtNum(d.new))}</code></div>`)
          .join("")
      : p.outcome === "candidate-error"
        ? `<div class="cad-diff">replays under the pinned build, fails under the candidate: ${esc(p.error ?? "no detail")}</div>`
        : p.outcome === "baseline-broken"
          ? `<div class="cad-diff muted">already fails under the pinned build (ignored for the decision): ${esc(p.error ?? "no detail")}</div>`
          : p.outcome === "refused"
            ? `<div class="cad-diff">refused, not replayed: ${esc(p.error ?? "no detail")}</div>`
            : p.outcome === "inconclusive"
              ? `<div class="cad-diff">could not be replayed (tried again on the next check): ${esc(p.error ?? "no detail")}</div>`
              : "";
  return `<li class="cad-part" data-part="${esc(p.part)}" data-outcome="${esc(p.outcome)}"><b>${esc(p.part)}</b> <span class="muted">· ${where}</span>${body}</li>`;
}

/** The block under the machines table: last evaluation, differences, advisory, and the controls. */
export function gateHtml(view: CadCardView): string {
  const g = view.gate;
  if (!g) return "";
  const pinVersion = view.status?.pin?.version;
  const ev = g.lastEvaluation;
  const busy = !!g.evaluating || !!view.checking || !!view.status?.active;
  const parts = (pick: (m: SolidcraftGateMachine) => SolidcraftReplayPart[], keep: (p: SolidcraftReplayPart) => boolean): string =>
    (ev?.machines ?? []).flatMap((m) => pick(m).filter(keep).map((p) => partRow(p, m.serverName))).join("");
  const failing = parts((m) => m.report?.parts ?? [], (p) => p.outcome === "differs" || p.outcome === "candidate-error");
  const undecided = parts((m) => m.report?.parts ?? [], (p) => p.outcome === "refused" || p.outcome === "inconclusive");
  const broken = parts((m) => m.report?.parts ?? [], (p) => p.outcome === "baseline-broken");
  const advisory = parts((m) => m.report?.advisory ?? [], (p) => p.outcome !== "same");
  const advisoryCount = (ev?.machines ?? []).reduce((n, m) => n + (m.report?.advisory.length ?? 0), 0);
  const machines = (ev?.machines ?? [])
    .map(
      (m) => `<tr class="cad-gate-machine" data-server-id="${esc(m.serverId)}" data-state="${esc(m.state)}"${m.holds ? ` data-holds="1"` : ""}>
          <td><b>${esc(m.serverName)}</b>${m.isHub ? ` <span class="small muted">(hub)</span>` : ""}</td>
          <td>${esc(GATE_STATE_LABEL[m.state] ?? m.state)}${m.holds ? ` <span class="warn">— holds the pin</span>` : ""}${m.report ? ` <span class="muted">· ${m.report.parts.length} design${m.report.parts.length === 1 ? "" : "s"}</span>` : ""}</td>
          <td class="small ${m.holds ? "warn" : "muted"}">${esc(m.detail ?? "")}</td>
        </tr>`,
    )
    .join("");
  const evaluation = ev
    ? `<p id="cad-gate-result" class="small" data-result="${esc(ev.result)}"><b>SolidCraft ${esc(ev.candidate.version)}</b>${ev.baseline ? ` against the pinned ${esc(ev.baseline)}` : ""} · ${esc(new Date(ev.finishedAt).toLocaleString())} · <b>${esc(RESULT_LABEL[ev.result])}</b>${ev.advancedAnyway ? " · advanced anyway by the owner" : ""}</p>
        <p id="cad-gate-detail" class="small ${ev.result === "advanced" ? "muted" : "warn"}">${esc(ev.detail)}</p>
        <table class="pt-table small" id="cad-gate-machines"><thead><tr><th>Machine</th><th>Replay</th><th></th></tr></thead><tbody>${machines}</tbody></table>
        ${failing ? `<p class="small warn" style="margin-top:8px">${icon("warning")} Designs that differ under ${esc(ev.candidate.version)}:</p><ul id="cad-gate-differences" class="small">${failing}</ul>` : ""}
        ${undecided ? `<p class="small warn" style="margin-top:8px">${icon("warning")} Designs that hold the pin without a verdict (refused as unsafe to replay, or could not be replayed):</p><ul id="cad-gate-undecided" class="small">${undecided}</ul>` : ""}
        ${broken ? `<p class="small muted" style="margin-top:8px">Designs that already fail under the pinned build:</p><ul id="cad-gate-broken" class="small">${broken}</ul>` : ""}
        ${advisoryCount ? `<p class="small muted" style="margin-top:8px">Advisory — designs in open session worktrees (${advisoryCount} replayed; these never hold the pin):</p>${advisory ? `<ul id="cad-gate-advisory" class="small">${advisory}</ul>` : `<p id="cad-gate-advisory" class="small muted">All the same under both builds.</p>`}` : ""}`
    : `<p id="cad-gate-result" class="small muted">No candidate has been evaluated yet.</p>`;
  const lastCheck = g.lastCheck ? `<p id="cad-gate-check" class="small muted" data-outcome="${esc(g.lastCheck.outcome)}">Last check ${esc(new Date(g.lastCheck.at).toLocaleString())}: ${esc(g.lastCheck.detail)}</p>` : "";
  const rejected = g.rejected.length
    ? `<p id="cad-gate-rejected" class="small muted">Rejected, never tried again: ${g.rejected.map((r) => `<code title="${esc(r.reason)}">${esc(r.version)}</code>`).join(", ")}</p>`
    : "";
  const ask =
    view.advanceAsk && canAdvanceAnyway(ev, pinVersion)
      ? `<div id="cad-advance-warning" class="card">
          <b>Advance to SolidCraft ${esc(ev.candidate.version)} anyway?</b>
          <p class="small warn">${icon("warning")} The replay gate did not pass this build: ${esc(ev.detail)}</p>
          ${failing ? `<ul id="cad-advance-differences" class="small">${failing}</ul>` : `<p id="cad-advance-differences" class="small muted">No per-design difference was recorded; the gate could not finish (see the machines above).</p>`}
          <p class="small muted">Every machine will switch to ${esc(ev.candidate.version)}. Designs are rewritten by it on their next refresh.</p>
          <div class="card-main" style="margin-top:8px;gap:8px">
            <button id="cad-advance-confirm" class="danger">${icon("skip_next")} Advance to ${esc(ev.candidate.version)} anyway</button>
            <button id="cad-advance-cancel" class="mini">Cancel</button>
          </div></div>`
      : "";
  return `<div id="cad-gate" style="margin-top:12px">
      <b>Replay gate</b>
      <p class="small muted">Every 4 hours the hub looks for a newer full SolidCraft release that is at least 48 hours old, replays every design under the pinned build and under the candidate on each machine, and advances the pin only if they all match.</p>
      ${g.evaluating ? `<p id="cad-gate-evaluating" class="small">Evaluating SolidCraft ${esc(g.evaluating.version)}… the pinned build keeps serving sessions.</p>` : ""}
      ${g.interrupted ? `<p id="cad-gate-interrupted" class="small warn">${esc(g.interrupted)}</p>` : ""}
      ${evaluation}${lastCheck}${rejected}
      ${g.retry ? `<p id="cad-gate-retry" class="small warn">SolidCraft ${esc(g.retry.version)} could not be installed on the hub (${esc(g.retry.reason)}). ${g.retry.attempts} attempt${g.retry.attempts === 1 ? "" : "s"} so far; the next is after ${esc(new Date(g.retry.nextAt).toLocaleString())}.</p>` : ""}
      ${g.nextAdvanceAllowedAt ? `<p id="cad-gate-limit" class="small muted">The pin moves at most once in 24 hours: the next automatic advance is possible after ${esc(new Date(g.nextAdvanceAllowedAt).toLocaleString())}.</p>` : ""}
      <div class="card-main" style="margin-top:8px;gap:8px;flex-wrap:wrap">
        <button id="cad-check-now" class="mini"${busy ? " disabled" : ""}>${icon("search")} ${view.checking ? "Checking…" : "Check now"}</button>
        <button id="cad-advance-anyway" class="mini"${canAdvanceAnyway(ev, pinVersion) && !busy ? "" : " disabled"}>${icon("skip_next")} Advance anyway${canAdvanceAnyway(ev, pinVersion) ? ` to ${esc(ev.candidate.version)}` : ""}</button>
      </div>
      ${ask}</div>`;
}

/** The whole card. Pure: the same view always gives the same HTML. */
export function cadCardHtml(view: CadCardView): string {
  const head = `<b>SolidCraft <span class="small muted">(fleet pin)</span></b>
      <p class="small muted">Every machine runs the one pinned SolidCraft build, so a design written on one machine opens on the others. A machine that is not on the pin cannot do CAD until it is.</p>`;
  if (!view.status) return `<div class="card" id="cad-card">${head}<p class="small muted">Loading…</p></div>`;
  const { pin, members, active } = view.status;
  const extras = view.extras ?? {};
  const pinRow = pin
    ? `<code class="small" id="cad-pin-version">${esc(pin.version)}</code> <span class="small muted">sha256 ${esc(shortSha(pin.sha256))}… · pinned ${esc(new Date(pin.pinnedAt).toLocaleString())}</span>`
    : `<span class="small muted" id="cad-pin-version">No pin set — each machine uses whatever SolidCraft it has.</span>`;
  const prevRow = pin?.previous ? `<code class="small" id="cad-pin-previous">${esc(pin.previous.version)}</code>` : `<span class="small muted">—</span>`;
  // The two rows later phases fill in (see the header of this file).
  const replay = extras.replayGate
    ? `<span id="cad-replay-gate">${esc(extras.replayGate)}</span>`
    : view.gate
      ? `<span id="cad-replay-gate">${esc(gateSummary(view.gate))}</span>`
      : `<span id="cad-replay-gate" class="small muted" data-placeholder="B2">Not available yet — arrives with the replay gate (Phase B2).</span>`;
  const live = extras.liveProcesses
    ? `<span id="cad-live-processes">${esc(extras.liveProcesses)}</span>`
    : `<span id="cad-live-processes" class="small muted" data-placeholder="track-a">Not available yet — arrives with the CAD process manager (Track A).</span>`;
  const machines = members.length
    ? members.map(memberRow).join("")
    : `<tr><td colspan="3" class="small muted">No machines reported yet.</td></tr>`;
  return `<div class="card" id="cad-card">${head}
      <table class="pt-table small"><tbody>
        <tr><td><b>Pin</b></td><td>${pinRow}</td></tr>
        <tr><td><b>Previous</b></td><td>${prevRow}</td></tr>
        <tr><td><b>Last replay gate result</b></td><td>${replay}</td></tr>
        <tr><td><b>Live CAD processes</b></td><td>${live}</td></tr>
      </tbody></table>
      <table class="pt-table small" id="cad-machines" style="margin-top:8px">
        <thead><tr><th>Machine</th><th>SolidCraft</th><th>Status</th></tr></thead>
        <tbody>${machines}</tbody>
      </table>
      ${view.error ? `<p id="cad-error" class="small warn">${icon("error")} ${esc(view.error)}</p>` : ""}
      <div class="card-main" style="margin-top:8px;gap:8px;flex-wrap:wrap">
        <input id="cad-pin-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Version, e.g. 0.44.1" style="max-width:11rem" />
        <input id="cad-sha-input" type="text" autocomplete="off" spellcheck="false" placeholder="sha256 (optional — looked up on GitHub)" style="flex:1;min-width:12rem" />
        <button id="cad-pin-set" class="primary"${active ? " disabled" : ""}>${icon("push_pin")} Set pin to version…</button>
        <button id="cad-pin-back" class="mini"${pin?.previous && !active ? "" : " disabled"}>${icon("undo")} Pin back</button>
        <button id="cad-refresh" class="mini" style="margin-left:auto">${icon("refresh")} Refresh</button>
      </div>
      ${view.pinBack ? pinBackWarningHtml(view.pinBack) : ""}
      ${gateHtml(view)}
      ${active ? `<p id="cad-active" class="small muted">Applying the pin across the fleet…</p>` : ""}</div>`;
}

/** The capability a hub must advertise for Settings → CAD to exist. */
export const CAD_PIN_CAPABILITY = "solidcraft-pin";

/** The Settings tab button: nothing at all unless the hub runs the SolidCraft pin. */
export function cadTabHtml(supported: boolean): string {
  return supported ? `<button class="stab" role="tab" data-tab="cad">${icon("deployed_code")} CAD</button>` : "";
}

/** What the card needs from the app. Injected, so the card is testable with a fake. */
export interface CadCardApi {
  fleetStatus(refresh: boolean): Promise<rest.solidcraft.FleetStatusResponse | null>;
  setPin(version: string, sha256?: string): Promise<rest.solidcraft.SetPinResponse>;
  pinBackPreview(): Promise<rest.solidcraft.PinBackPreviewResponse>;
  pinBack(): Promise<rest.solidcraft.PinBackResponse>;
  /** Phase B2. Optional so the card still works against a hub without the replay gate. */
  gate?(): Promise<rest.solidcraft.CandidateStatusResponse | null>;
  checkNow?(): Promise<rest.solidcraft.CandidateCheckResponse>;
  advanceAnyway?(version: string): Promise<rest.solidcraft.AdvanceAnywayResponse>;
  toast(msg: string): void;
  /** Poll interval while a fan-out is active (tests pass 0 to disable polling). */
  pollMs?: number;
}

export interface CadCardHandle {
  /** Settles once the first load has painted. */
  ready: Promise<void>;
  /** Re-read the fleet status and repaint (called when a `solidcraft.status` event arrives). */
  reload(refresh?: boolean): Promise<void>;
  /** Supply the values later phases own; repaints. */
  setExtras(extras: CadCardExtras): void;
  view(): CadCardView;
}

/** Render the card into `host`, wire its controls, and load the fleet status. */
export function mountCadCard(host: HTMLElement, api: CadCardApi, extras: CadCardExtras = {}): CadCardHandle {
  const view: CadCardView = { status: null, extras };
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const paint = (): void => {
    if (!host.isConnected) return;
    // Keep what the owner has typed across a repaint.
    const typedVersion = host.querySelector<HTMLInputElement>("#cad-pin-input")?.value ?? "";
    const typedSha = host.querySelector<HTMLInputElement>("#cad-sha-input")?.value ?? "";
    host.innerHTML = cadCardHtml(view);
    const vIn = host.querySelector<HTMLInputElement>("#cad-pin-input");
    const sIn = host.querySelector<HTMLInputElement>("#cad-sha-input");
    if (vIn) vIn.value = typedVersion;
    if (sIn) sIn.value = typedSha;
    host.querySelector("#cad-pin-set")?.addEventListener("click", () => void setPin());
    host.querySelector("#cad-pin-back")?.addEventListener("click", () => void askPinBack());
    host.querySelector("#cad-refresh")?.addEventListener("click", () => void reload(true));
    host.querySelector("#cad-pinback-confirm")?.addEventListener("click", () => void confirmPinBack());
    host.querySelector("#cad-pinback-cancel")?.addEventListener("click", () => {
      view.pinBack = null;
      paint();
    });
    host.querySelector("#cad-check-now")?.addEventListener("click", () => void checkNow());
    host.querySelector("#cad-advance-anyway")?.addEventListener("click", () => {
      // Step 1 of "Advance anyway": show the differences. Nothing is sent yet.
      view.advanceAsk = true;
      view.error = undefined;
      paint();
    });
    host.querySelector("#cad-advance-confirm")?.addEventListener("click", () => void confirmAdvance());
    host.querySelector("#cad-advance-cancel")?.addEventListener("click", () => {
      view.advanceAsk = false;
      paint();
    });
  };

  const schedulePoll = (): void => {
    clearTimeout(pollTimer);
    const every = api.pollMs ?? 2_000;
    if (!(view.status?.active || view.gate?.evaluating) || every <= 0 || !host.isConnected) return;
    pollTimer = setTimeout(() => void reload(false), every);
  };

  async function reload(refresh = false): Promise<void> {
    const [st, gate] = await Promise.all([api.fleetStatus(refresh).catch(() => null), api.gate ? api.gate().catch(() => null) : Promise.resolve(undefined)]);
    if (st) view.status = st;
    if (gate && gate.ok) view.gate = gate;
    else if (!view.status) view.error = "Couldn't read the SolidCraft pin from the hub.";
    paint();
    schedulePoll();
  }

  async function setPin(): Promise<void> {
    const version = (host.querySelector<HTMLInputElement>("#cad-pin-input")?.value ?? "").trim().replace(/^v/, "");
    const sha256 = (host.querySelector<HTMLInputElement>("#cad-sha-input")?.value ?? "").trim().toLowerCase();
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      view.error = "Enter a SolidCraft version like 0.44.1.";
      return paint();
    }
    const btn = host.querySelector<HTMLButtonElement>("#cad-pin-set");
    if (btn) btn.disabled = true;
    view.error = undefined;
    view.pinBack = null;
    let r: rest.solidcraft.SetPinResponse;
    try {
      r = await api.setPin(version, sha256 || undefined);
    } catch (e) {
      r = { ok: false, members: [], error: `Couldn't reach the hub: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!r.ok) {
      view.error = r.error ?? "The pin was not changed.";
      paint();
      return;
    }
    const vIn = host.querySelector<HTMLInputElement>("#cad-pin-input");
    const sIn = host.querySelector<HTMLInputElement>("#cad-sha-input");
    if (vIn) vIn.value = "";
    if (sIn) sIn.value = "";
    api.toast(`SolidCraft pinned to ${r.pin?.version ?? version}. Installing across the fleet…`);
    await reload(false);
  }

  /** Step 1 of "Pin back": show what it does and which designs it puts at risk. */
  async function askPinBack(): Promise<void> {
    view.error = undefined;
    try {
      view.pinBack = await api.pinBackPreview();
    } catch (e) {
      view.error = `Couldn't read the pin-back warning: ${e instanceof Error ? e.message : String(e)}`;
    }
    paint();
  }

  /** Step 2: the owner has seen the list. */
  async function confirmPinBack(): Promise<void> {
    const btn = host.querySelector<HTMLButtonElement>("#cad-pinback-confirm");
    if (btn) btn.disabled = true;
    let r: rest.solidcraft.PinBackResponse;
    try {
      r = await api.pinBack();
    } catch (e) {
      r = { ok: false, members: [], rewritten: [], error: `Couldn't reach the hub: ${e instanceof Error ? e.message : String(e)}` };
    }
    view.pinBack = null;
    if (!r.ok) {
      view.error = r.error ?? "The pin was not changed.";
      paint();
      return;
    }
    api.toast(`SolidCraft pinned back to ${r.pin?.version ?? "the previous version"}.`);
    await reload(false);
  }

  /** "Check now": the hub lists releases, evaluates the newest that qualifies, and decides. */
  async function checkNow(): Promise<void> {
    if (!api.checkNow) return;
    view.error = undefined;
    view.advanceAsk = false;
    view.checking = true;
    paint();
    try {
      const r = await api.checkNow();
      if (r.ok) view.gate = r;
      if (r.error) view.error = r.error;
      else if (r.check) api.toast(r.check.detail);
    } catch (e) {
      view.error = `Couldn't reach the hub: ${e instanceof Error ? e.message : String(e)}`;
    }
    view.checking = false;
    await reload(false);
  }

  /** Step 2 of "Advance anyway": the owner has seen the differences. */
  async function confirmAdvance(): Promise<void> {
    const version = view.gate?.lastEvaluation?.candidate.version;
    if (!api.advanceAnyway || !version) return;
    const btn = host.querySelector<HTMLButtonElement>("#cad-advance-confirm");
    if (btn) btn.disabled = true;
    let r: rest.solidcraft.AdvanceAnywayResponse;
    try {
      r = await api.advanceAnyway(version);
    } catch (e) {
      r = { ok: false, rejected: [], error: `Couldn't reach the hub: ${e instanceof Error ? e.message : String(e)}` };
    }
    view.advanceAsk = false;
    if (!r.ok) {
      view.error = r.error ?? "The pin was not changed.";
      paint();
      return;
    }
    view.gate = r;
    api.toast(`SolidCraft advanced to ${r.pin?.version ?? version}. Installing across the fleet…`);
    await reload(false);
  }

  paint();
  const ready = reload(true);
  return {
    ready,
    reload,
    setExtras(next) {
      view.extras = { ...view.extras, ...next };
      paint();
    },
    view: () => view,
  };
}
