import { apiFetch } from "./api";
import { esc, icon } from "./dom";

/**
 * The setup takeover (anvil-headless-join.md §5.1 · HJ-21).
 *
 * A daemon with no usable Claude login is UP but can't run turns. Rather than let the session list
 * render and fail opaquely on the first prompt, the whole app is replaced by this screen until the
 * machine has a credential. Two ways out, both of which end in the daemon writing a token:
 *
 *   "Join a fleet"           — arm a window here, read the 6-digit code off THIS screen (HJ-13: the
 *                              code lives in exactly one place), and have the hub push credentials.
 *   "Enter a token directly" — paste one, for a standalone machine with no fleet.
 *
 * **Browser-only in this release (HJ-36).** The Android/Apple shells bundle their own `web/dist` at
 * *their* build time, so a daemon update never reaches an installed app's UI — an app built before this
 * feature will still render its session list against a degraded daemon and fail on the first command.
 * The joiner is reachable at `https://<machine>.<tailnet>.ts.net:7701` from any browser, which is all
 * the pairing flow needs; shipping the takeover into the apps is a separate re-ship.
 */

let root: HTMLElement | null = null;
let shown = false;
let celebrating = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
/** Injected from main.ts — the "paste a token" path goes over the existing WS auth.set command. */
let setTokenFn: (token: string) => Promise<void> = async () => {};

interface ArmState {
  armed: boolean;
  code?: string;
  expiresAt?: string;
  host?: string;
  hasToken: boolean;
  hubServerId?: string;
  serverId: string;
  serverName: string;
}

export function initSetupTakeover(opts: { setToken: (token: string) => Promise<void> }): void {
  setTokenFn = opts.setToken;
  void refreshSetupState();
}

/**
 * Re-read this daemon's auth state and show/hide the takeover. Called on boot, on every `auth.status`
 * broadcast (so a pair or a paste clears the screen live on every open device), and on a poll while the
 * takeover is up — a pair completes on the DAEMON, with no client involvement, so polling is the only
 * signal a browser sitting on this screen would otherwise get.
 */
export async function refreshSetupState(): Promise<void> {
  let authed = true;
  try {
    const h = (await (await apiFetch("/api/health")).json()) as { subscriptionAuthOk?: boolean };
    authed = h.subscriptionAuthOk !== false;
  } catch {
    return; // daemon unreachable — that's the offline banner's job, not a reason to claim "needs setup"
  }
  if (authed) {
    // Authed WHILE the takeover is up means a credential just landed — a hub pushed one (a pair
    // completes on the daemon with no client round trip), or a token was pasted here. Show a positive
    // "you're in" confirmation before revealing the app, instead of the screen silently vanishing.
    // A first-boot call (authed and the takeover was never shown) just falls through to a no-op hide.
    if (shown && !celebrating) void celebratePaired();
    else if (!shown) hideTakeover();
  } else void showTakeover();
}

/**
 * The transition out of setup, made visible. The joiner otherwise got no signal that pairing worked —
 * the takeover just disappeared. Confirm it for a beat, then reveal the app underneath (which booted
 * normally under the overlay). Fleet-join vs standalone-paste is told apart by whether the daemon now
 * reports a hubServerId — a pair adopts the hub's; a bare token paste does not.
 */
async function celebratePaired(): Promise<void> {
  if (!root) { hideTakeover(); return; }
  celebrating = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; } // no re-entry while we confirm
  let fleet = false;
  try { fleet = !!(await armState())?.hubServerId; } catch { /* identity probe failed — show the generic message */ }
  if (!root) { celebrating = false; hideTakeover(); return; } // overlay pulled while we awaited
  root.innerHTML = `<div class="setup-box">
    <div class="setup-brand"><img src="/anvil.svg" class="brand-logo" alt="" /> Anvil</div>
    <h2>${icon("check_circle")} ${fleet ? "Paired — you're in" : "Claude login active"}</h2>
    <p class="setup-lede">${
      fleet
        ? "This machine now shares the fleet's Claude login and can run turns. Opening your sessions…"
        : "This machine has a Claude login and can run turns. Opening your sessions…"
    }</p>
  </div>`;
  setTimeout(() => { celebrating = false; hideTakeover(); }, 2200);
}

function hideTakeover(): void {
  if (!shown) return;
  shown = false;
  celebrating = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  root?.remove();
  root = null;
  // The app under the takeover booted normally (sockets, session list) — it was only covered. A reload
  // is still the cleanest way to land on a fully-populated view after a pair, so offer it rather than
  // forcing it, since a mid-flight reload would drop anything the user typed here.
  document.getElementById("app")?.removeAttribute("aria-hidden");
}

async function showTakeover(): Promise<void> {
  if (shown) return;
  shown = true;
  root = document.createElement("div");
  root.className = "setup-takeover";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  document.body.appendChild(root);
  // The app underneath is inert while the takeover is up — hide it from assistive tech too.
  document.getElementById("app")?.setAttribute("aria-hidden", "true");
  await renderTakeover();
  // A pair lands on the daemon with no client round trip, so poll for the transition out.
  pollTimer = setInterval(() => void refreshSetupState(), 4000);
}

async function armState(): Promise<ArmState | null> {
  try {
    return (await (await apiFetch("/api/fleet/arm")).json()) as ArmState;
  } catch {
    return null;
  }
}

async function renderTakeover(): Promise<void> {
  if (!root) return;
  const st = await armState();
  if (!root) return; // hidden while we were awaiting
  const machine = st?.host || st?.serverName || "this machine";
  root.innerHTML = `<div class="setup-box">
    <div class="setup-brand"><img src="/anvil.svg" class="brand-logo" alt="" /> Anvil</div>
    <h2>${icon("key_off")} This machine needs a Claude login</h2>
    <p class="setup-lede">
      <b>${esc(machine)}</b> is running and reachable — it just has no Claude login yet, so it can't run
      any turns. Everything else (terminal, files, git) still works.
    </p>
    <div class="setup-actions">
      <button type="button" id="setup-join" class="setup-primary">${icon("hub")}
        <span><b>Join a fleet</b><small>Get a code to enter on another Anvil machine. It shares that machine's login.</small></span>
      </button>
      <button type="button" id="setup-token" class="setup-secondary">${icon("key")}
        <span><b>Enter a token directly</b><small>Paste a <code>claude setup-token</code> value for a standalone machine.</small></span>
      </button>
    </div>
    <div id="setup-panel"></div>
    <p class="setup-foot small muted">${esc(st?.serverName ?? "")}${st?.host ? ` · ${esc(st.host)}` : ""}</p>
  </div>`;
  document.getElementById("setup-join")?.addEventListener("click", () => void startJoin(st));
  document.getElementById("setup-token")?.addEventListener("click", () => renderTokenForm());
}

function panel(): HTMLElement | null {
  return document.getElementById("setup-panel");
}

// ── "Join a fleet" ──────────────────────────────────────────────────────────────────────────────

/**
 * Arm a join window and display its code. The two consent warnings (HJ-10 / HJ-14) are shown BEFORE
 * arming, because the hub operator can't see what they'd be clobbering — arming here is the consent.
 */
async function startJoin(st: ArmState | null): Promise<void> {
  const p = panel();
  if (!p) return;

  const warnings: string[] = [];
  if (st?.hasToken) {
    warnings.push("This machine already has a Claude login. Pairing will <b>replace</b> it.");
  }
  if (st?.hubServerId) {
    warnings.push("This machine is already paired to a fleet. Joining a different one will <b>detach</b> it from the current fleet, and it will stop receiving that fleet's token updates.");
  }
  if (warnings.length) {
    p.innerHTML = `<div class="setup-panel-box setup-warn">
      ${warnings.map((w) => `<p>${icon("warning")} ${w}</p>`).join("")}
      <div class="btns"><button type="button" id="setup-arm-cancel">Cancel</button><button type="button" id="setup-arm-go" class="primary">Continue</button></div>
    </div>`;
    document.getElementById("setup-arm-cancel")?.addEventListener("click", () => void renderTakeover());
    document.getElementById("setup-arm-go")?.addEventListener("click", () => void arm());
    return;
  }
  await arm();
}

async function arm(): Promise<void> {
  const p = panel();
  if (p) await armJoinWindow(p, { onCancel: () => void renderTakeover() });
}

/**
 * Arm THIS machine's pairing window and render its code (with a live countdown) into `container`.
 * Shared by the tokenless setup takeover AND the standard-UI "re-pair" entry (main.ts's Fleet
 * settings), so the arm call, the code display, the countdown, and the cancel-disarms-the-window
 * behaviour live in exactly one place. `onCancel` runs AFTER the window is disarmed — the takeover
 * re-renders its menu, the Settings modal closes. `apiFetch` always targets the daemon serving this
 * page, so this always arms the *local* machine (which is the one whose code the hub must enter).
 */
export async function armJoinWindow(container: HTMLElement, opts: { onCancel?: () => void } = {}): Promise<void> {
  container.innerHTML = `<div class="setup-panel-box"><p class="small muted">${icon("progress_activity")} Opening a join window…</p></div>`;
  let res: { ok?: boolean; code?: string; expiresAt?: string; host?: string; error?: string };
  try {
    res = await (await apiFetch("/api/fleet/arm", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  } catch {
    container.innerHTML = `<div class="setup-panel-box setup-warn"><p>Couldn't reach this machine's daemon to open a join window.</p></div>`;
    return;
  }
  if (!res.ok || !res.code) {
    container.innerHTML = `<div class="setup-panel-box setup-warn"><p>${esc(res.error ?? "Couldn't open a join window.")}</p></div>`;
    return;
  }
  renderCode(container, res.code, res.expiresAt, res.host, opts);
}

function renderCode(container: HTMLElement, code: string, expiresAt: string | undefined, host: string | undefined, opts: { onCancel?: () => void }): void {
  container.innerHTML = `<div class="setup-panel-box setup-code-box">
    <p class="small muted">On another Anvil machine, open <b>Settings → Servers → Add a machine</b>, pick
      <b>${esc(host ?? "this machine")}</b>, and enter this code:</p>
    <div class="setup-code">${esc(code.replace(/(\d{3})(\d{3})/, "$1 $2"))}</div>
    <p class="small muted" id="setup-countdown"></p>
    <p class="small muted">This window is open only while this screen shows a code. Nothing can be pushed
      to this machine before you opened it, or after it expires.</p>
    <div class="btns"><button type="button" id="setup-cancel-arm">Cancel</button></div>
  </div>`;
  document.getElementById("setup-cancel-arm")?.addEventListener("click", () => {
    void apiFetch("/api/fleet/arm", { method: "DELETE" }).catch(() => {});
    opts.onCancel?.();
  });

  const end = expiresAt ? new Date(expiresAt).getTime() : 0;
  const tick = (): void => {
    const el = document.getElementById("setup-countdown");
    if (!el) return; // panel re-rendered — the interval clears itself below
    const left = Math.max(0, end - Date.now());
    if (!end) {
      el.textContent = "";
      return;
    }
    if (left === 0) {
      el.textContent = "This code has expired — cancel and start again.";
      return;
    }
    const m = Math.floor(left / 60_000);
    const s = Math.floor((left % 60_000) / 1000);
    el.textContent = `Expires in ${m}:${String(s).padStart(2, "0")}`;
  };
  tick();
  const iv = setInterval(() => {
    if (!document.getElementById("setup-countdown")) {
      clearInterval(iv);
      return;
    }
    tick();
  }, 1000);
}

// ── "Enter a token directly" ────────────────────────────────────────────────────────────────────

function renderTokenForm(): void {
  const p = panel();
  if (!p) return;
  p.innerHTML = `<div class="setup-panel-box">
    <label>Claude OAuth token
      <input id="setup-token-input" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-oat…" />
    </label>
    <p class="small muted">Run <code>claude setup-token</code> on a machine where you're signed in, and paste
      the value here. A metered <code>sk-ant-api…</code> API key is rejected — it would bill per token.</p>
    <div id="setup-token-status" class="small muted"></div>
    <div class="btns"><button type="button" id="setup-token-cancel">Cancel</button><button type="button" id="setup-token-save" class="primary">Save</button></div>
  </div>`;
  document.getElementById("setup-token-cancel")?.addEventListener("click", () => void renderTakeover());
  const status = (t: string): void => {
    const el = document.getElementById("setup-token-status");
    if (el) el.textContent = t;
  };
  document.getElementById("setup-token-save")?.addEventListener("click", async () => {
    const value = (document.getElementById("setup-token-input") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!value) return status("Paste a token first.");
    status("Saving…");
    try {
      await setTokenFn(value);
      status("Saved — checking…");
      await refreshSetupState(); // the daemon's auth.status broadcast usually beats this; both are safe
    } catch (e) {
      status(e instanceof Error ? e.message : String(e));
    }
  });
}
