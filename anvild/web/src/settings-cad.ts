// ── Settings → CAD: the SolidCraft fleet pin card (agent-cad-and-browser spec §4.10) ─────────────
// Shows, per machine, which SolidCraft build it runs (version + where it came from), whether it is
// on the fleet pin, and the pin itself; and offers the two manual controls of Phase B1: "Set pin to
// version…" and "Pin back" (with its warning list).
//
// Split in two so it can be tested without the rest of Settings:
//   - `cadCardHtml(view)` is a pure string builder;
//   - `mountCadCard(host, api)` fetches, renders and wires the controls through an injected `api`.
//
// PLACEHOLDERS FOR LATER PHASES — two rows are rendered now and filled in later, by passing the
// value in `CadCardExtras` (nothing else in this file needs to change):
//   - `replayGate`     "Last replay gate result"  → Phase B2 (replay gate and auto-advance)
//   - `liveProcesses`  "Live CAD processes"       → Track A (the CAD process manager)
import { esc, icon } from "./dom";
import type { rest } from "../../protocol";

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
  const list = p.rewritten.length
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
  };

  const schedulePoll = (): void => {
    clearTimeout(pollTimer);
    const every = api.pollMs ?? 2_000;
    if (!view.status?.active || every <= 0 || !host.isConnected) return;
    pollTimer = setTimeout(() => void reload(false), every);
  };

  async function reload(refresh = false): Promise<void> {
    const st = await api.fleetStatus(refresh).catch(() => null);
    if (st) view.status = st;
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
