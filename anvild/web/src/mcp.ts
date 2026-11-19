// ── MCP integrations: Settings card + the session "Tools" control (mcp-integrations spec §4.7) ────
// Third-party MCP servers installed on ONE machine that an ordinary session can switch on. Everything
// here is hidden unless the server advertises the "mcp-integrations" capability.
//
// Three surfaces:
//   1. Settings → Integrations → "Agent tools": one row per integration (health dot + reason, "in use
//      by", an enabled switch, remove) per server that supports it, plus Add → Custom.
//   2. The session header's Tools chip (#header-tools): shows which integrations are on for the open
//      session; tapping it lists this machine's integrations with a switch each.
//   3. `mcpToolLabel`: the integration's label for a raw `mcp__<key>__<tool>` name, shown on
//      permission cards.
//
// Like settings.ts this module never imports main.ts; what it needs from there arrives once through
// initMcp(deps). The pure helpers (labels, rows, the form parser) take their data as arguments so
// they are tested without a DOM.
import { $, esc, icon } from "./dom";
import { closeModal, confirmDialog, showModal, toast, toggleHeaderMenu, type HeaderMenuItem } from "./dialogs";
import { newCid } from "./outbox";
import { orderedServers, sendTo, serverOf, serverSupports, type Server } from "./fleet";
import type { McpIntegration, McpIntegrationKind, McpIntegrationStatus, ServerEvent, Session } from "../../protocol";

export const MCP_CAPABILITY = "mcp-integrations";
/** Mirrors the daemon's key grammar (src/mcp/validate.ts) so the form can say what is wrong at once. */
export const MCP_KEY_RE = /^[a-z][a-z0-9]{1,23}$/;

export interface McpDeps {
  /** The merged session list (main owns it). */
  sessions: Map<string, Session>;
  /** The currently-open session's id. */
  activeId(): string | null;
  /** cid-tracked request/response over a server's socket (main's `sendAwait`). */
  sendAwait(server: Server, cmd: Record<string, unknown> & { type: string; cid: string }, timeoutMs?: number): Promise<ServerEvent>;
}
let sessions: McpDeps["sessions"];
let activeId: McpDeps["activeId"];
let sendAwait: McpDeps["sendAwait"];
export function initMcp(deps: McpDeps): void {
  ({ sessions, activeId, sendAwait } = deps);
}

/** Each server's integrations, keyed by server url (they are per machine, never merged). */
export const serverMcp = new Map<string, McpIntegrationStatus[]>();

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────

/** `mcp__echo__ping` → "Echo · ping" when `echo` is one of `list`'s keys; undefined otherwise (the
 *  daemon's own tools and anything unknown keep their raw name). */
export function mcpToolLabel(tool: string, list: readonly McpIntegration[] | undefined): string | undefined {
  const m = /^mcp__([^_]+)__(.+)$/s.exec(tool);
  if (!m) return undefined;
  const i = list?.find((x) => x.key === m[1]);
  return i ? `${i.label} · ${m[2]}` : undefined;
}

/** Only ordinary sessions get integrations (not the concierge, a team lead/member, or autopilot). */
export function isOrdinarySession(s: Session | undefined): boolean {
  return !!s && !s.isDefault && !s.teamRole && !s.workUnitRole && !s.workUnitId;
}

export function healthView(i: McpIntegrationStatus): { cls: "connected" | "disconnected" | ""; text: string } {
  if (i.health.state === "ready") return { cls: "connected", text: "Ready" };
  if (i.health.state === "disabled") return { cls: "", text: "Switched off" };
  return { cls: "disconnected", text: `Unavailable: ${i.health.reason}` };
}

/** What the transport looks like on a row: the command line, or the URL. */
export function transportText(i: McpIntegration): string {
  return i.transport.type === "http" ? i.transport.url : [i.transport.command, ...i.transport.args].join(" ");
}

/** One integration's row in the Settings card. `heldByTitle` names the session using it, if any. */
export function mcpRowHtml(i: McpIntegrationStatus, heldByTitle?: string): string {
  const h = healthView(i);
  return `<div class="card mcp-row" data-mcp-id="${esc(i.id)}">
    <div class="card-main">
      <span class="conn-dot ${h.cls}" title="${esc(h.text)}"></span>
      <b>${esc(i.label)}</b>
      <code class="small muted">mcp__${esc(i.key)}__</code>
      <span class="mcp-row-actions">
        <button type="button" class="mini mcp-toggle" role="switch" aria-checked="${i.enabled}" title="${i.enabled ? "Switch off for this machine" : "Switch on for this machine"}">${icon(i.enabled ? "toggle_on" : "toggle_off")} ${i.enabled ? "On" : "Off"}</button>
        <button type="button" class="mini mcp-remove" title="Remove this integration">${icon("delete")} Remove</button>
      </span>
    </div>
    <div class="small muted mcp-health">${esc(h.text)}${i.exclusive ? " · one session at a time" : ""}</div>
    ${i.heldBy ? `<div class="small mcp-held">${icon("lock")} In use by ${esc(heldByTitle ?? "another session")}</div>` : ""}
    <div class="small muted mcp-transport"><code>${esc(transportText(i))}</code></div>
  </div>`;
}

/** The card body for one server. */
export function mcpServerSectionHtml(serverName: string, serverUrl: string, list: readonly McpIntegrationStatus[], titleOf: (sessionId: string) => string | undefined, showServerName: boolean): string {
  const rows = list.length
    ? list.map((i) => mcpRowHtml(i, i.heldBy ? titleOf(i.heldBy) : undefined)).join("")
    : `<div class="card"><span class="small muted">No integrations on this machine yet.</span></div>`;
  return `<div class="mcp-server" data-mcp-server="${esc(serverUrl)}">
    <div class="card-main mcp-server-head">
      ${showServerName ? `<b>${icon("dns")} ${esc(serverName)}</b>` : ""}
      <span class="mcp-row-actions">
        <button type="button" class="mini mcp-check" title="Check every integration now">${icon("refresh")} Check</button>
        <button type="button" class="mini mcp-add">${icon("add")} Add</button>
      </span>
    </div>
    ${rows}
  </div>`;
}

/** Split a typed command line into words. Double or single quotes group; a backslash escapes the next
 *  character outside single quotes. No variable or glob expansion: the daemon runs it without a shell. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

export interface CustomFormValues {
  label: string;
  key: string;
  transport: "stdio" | "http";
  commandLine: string;
  url: string;
  exclusive: boolean;
}

/** Turn the Add → Custom form into the `mcp.integration.add` payload, or say what is wrong. The
 *  daemon validates again (and is the authority); this only saves a round trip for obvious slips. */
export function parseCustomForm(v: CustomFormValues, kind: McpIntegrationKind = "custom"): { ok: true; integration: Omit<McpIntegration, "id"> } | { ok: false; error: string } {
  const label = v.label.trim();
  const key = v.key.trim();
  if (!label) return { ok: false, error: "Enter a name." };
  if (!MCP_KEY_RE.test(key)) return { ok: false, error: "The key is 2-24 characters: a lowercase letter, then lowercase letters or digits." };
  const base = { key, kind, label, exclusive: v.exclusive, enabled: true };
  if (v.transport === "http") {
    let u: URL;
    try {
      u = new URL(v.url.trim());
    } catch {
      return { ok: false, error: "Enter a valid URL." };
    }
    if (u.protocol !== "http:" || u.username || u.password || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
      return { ok: false, error: "The URL must be http:// on this machine (127.0.0.1, localhost or [::1])." };
    }
    return { ok: true, integration: { ...base, transport: { type: "http", url: v.url.trim() } } };
  }
  const words = splitCommandLine(v.commandLine);
  if (!words.length) return { ok: false, error: "Enter the command that starts the server." };
  return { ok: true, integration: { ...base, transport: { type: "stdio", command: words[0]!, args: words.slice(1) } } };
}

/** What the header chip shows for a session: the labels of the integrations that are on. */
export function toolsChipLabel(s: Session, list: readonly McpIntegrationStatus[]): string {
  const on = list.filter((i) => s.mcpIntegrations?.includes(i.id)).map((i) => i.label);
  return on.length ? on.join(", ") : "Tools";
}

/** The Tools menu for a session: one entry per integration on its machine, with the action a tap
 *  takes. `next` is the id list to send; absent when the tap cannot change anything (an unavailable
 *  integration cannot be switched ON — it can always be switched off). */
export function toolsMenuModel(s: Session, list: readonly McpIntegrationStatus[]): { id: string; label: string; on: boolean; blocked?: string; icon: string; title: string; next?: string[] }[] {
  const current = (s.mcpIntegrations ?? []).filter((id) => list.some((i) => i.id === id));
  return list.map((i) => {
    const on = current.includes(i.id);
    const reason = i.health.state === "ready" ? undefined : i.health.state === "disabled" ? "switched off in Settings" : i.health.reason;
    if (on) return { id: i.id, label: i.label, on, icon: "toggle_on", title: reason ? `On, but unavailable: ${reason}. Tap to switch off.` : `On for this session. Tap to switch off.`, next: current.filter((x) => x !== i.id) };
    if (reason) return { id: i.id, label: i.label, on, blocked: reason, icon: "block", title: `Unavailable: ${reason}` };
    return { id: i.id, label: i.label, on, icon: "toggle_off", title: `Switch ${i.label} on for this session`, next: [...current, i.id] };
  });
}

// ── Event intake ─────────────────────────────────────────────────────────────────────────────────

/** `mcp.integrations` from one server: replace that server's list, repaint what shows it. */
export function onMcpIntegrations(url: string, list: McpIntegrationStatus[]): void {
  serverMcp.set(url, list);
  if (document.getElementById("mcp-panel")) renderMcpPanel();
  const id = activeId?.();
  updateHeaderTools(id ? sessions.get(id) : undefined);
}

/** The integrations on the machine that owns `sessionId` (empty when it does not support them). */
export function sessionIntegrations(sessionId: string | null | undefined): McpIntegrationStatus[] {
  const srv = serverOf(sessionId);
  return srv && serverSupports(srv, MCP_CAPABILITY) ? (serverMcp.get(srv.url) ?? []) : [];
}

/** The name to show on a permission card for `tool` in `sessionId` (the integration's label), or the
 *  raw tool name when it is not an integration tool. */
export function permissionToolName(tool: string, sessionId: string | null | undefined): string {
  return mcpToolLabel(tool, sessionIntegrations(sessionId)) ?? tool;
}

// ── Settings → Integrations card ─────────────────────────────────────────────────────────────────

const mcpServers = (): Server[] => orderedServers().filter((s) => serverSupports(s, MCP_CAPABILITY));

/** Static shell for the Integrations tab. Hidden until a server advertises the capability. */
export function mcpSectionShellHtml(): string {
  return `<div id="mcp-section" hidden>
    <div class="section-head" style="margin-top:1.75rem"><h3>Agent tools</h3></div>
    <p class="small muted">Local tool servers (MCP) a session can switch on from its Tools menu. Each call asks first, until you allow that integration for the session.</p>
    <div id="mcp-panel"></div>
    <p class="small muted mcp-warning">${icon("warning")} Third-party servers run as the daemon's user.</p>
  </div>`;
}

export function renderMcpPanel(): void {
  const section = document.getElementById("mcp-section");
  const host = document.getElementById("mcp-panel");
  if (!section || !host) return;
  const list = mcpServers();
  section.hidden = list.length === 0;
  if (!list.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = list
    .map((srv) => mcpServerSectionHtml(srv.name, srv.url, serverMcp.get(srv.url) ?? [], (sid) => sessions.get(sid)?.title, list.length > 1))
    .join("");
  host.querySelectorAll<HTMLElement>(".mcp-server").forEach((sec) => {
    const srv = list.find((s) => s.url === sec.dataset.mcpServer);
    if (!srv) return;
    sec.querySelector<HTMLButtonElement>(".mcp-check")?.addEventListener("click", () => void sendMcp(srv, { type: "mcp.integration.check" }));
    sec.querySelector<HTMLButtonElement>(".mcp-add")?.addEventListener("click", (ev) => {
      // One preset in this build; the menu is where later presets (the browser) appear.
      toggleHeaderMenu(ev.currentTarget as HTMLElement, [{ icon: "terminal", label: "Custom", title: "A stdio command or a local http server", run: () => showAddCustom(srv) }]);
    });
    sec.querySelectorAll<HTMLElement>(".mcp-row").forEach((row) => {
      const i = (serverMcp.get(srv.url) ?? []).find((x) => x.id === row.dataset.mcpId);
      if (!i) return;
      row.querySelector<HTMLButtonElement>(".mcp-toggle")?.addEventListener("click", () => void sendMcp(srv, { type: "mcp.integration.update", id: i.id, fields: { enabled: !i.enabled } }));
      row.querySelector<HTMLButtonElement>(".mcp-remove")?.addEventListener("click", async () => {
        const using = [...sessions.values()].filter((s) => s.mcpIntegrations?.includes(i.id)).length;
        const ok = await confirmDialog({
          icon: "delete",
          title: `Remove “${i.label}”?`,
          body: using ? `It is switched on in ${using} session${using === 1 ? "" : "s"}; it will be switched off there.` : undefined,
          confirmLabel: "Remove",
          danger: true,
        });
        if (ok && (await sendMcp(srv, { type: "mcp.integration.remove", id: i.id }))) toast(`Removed “${i.label}”.`);
      });
    });
  });
}

/** Send one `mcp.*` command and surface a refusal as a toast. Resolves true on success. */
async function sendMcp(srv: Server, cmd: Record<string, unknown> & { type: string }): Promise<boolean> {
  try {
    const res = await sendAwait(srv, { ...cmd, cid: newCid() }, 20_000);
    if (res.type === "command.error") {
      toast(res.message);
      return false;
    }
    return true;
  } catch (err) {
    toast(`Couldn't reach ${srv.name}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/** The Add → Custom dialog. Errors render inline and the dialog stays open with the input intact. */
export function showAddCustom(srv: Server): void {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>${icon("extension")} Add a custom integration</h3>
    <p class="small muted">Runs on <code>${esc(srv.name)}</code> as the daemon's user. Only add a server you trust.</p>
    <label>Name<input id="mcp-dlg-label" type="text" maxlength="60" placeholder="e.g. Echo" /></label>
    <label>Key<input id="mcp-dlg-key" type="text" maxlength="24" autocapitalize="off" spellcheck="false" placeholder="e.g. echo — tools appear as mcp__echo__…" /></label>
    <label>Type<select id="mcp-dlg-type"><option value="stdio">Command (stdio)</option><option value="http">Local URL (http)</option></select></label>
    <label id="mcp-dlg-cmd-row">Command<input id="mcp-dlg-cmd" type="text" autocapitalize="off" spellcheck="false" placeholder="my-mcp-server --root {cwd}" /></label>
    <label id="mcp-dlg-url-row" hidden>URL<input id="mcp-dlg-url" type="text" autocapitalize="off" spellcheck="false" placeholder="http://127.0.0.1:8123/mcp" /></label>
    <p class="small muted" id="mcp-dlg-hint"><code>{cwd}</code> becomes the session's worktree. The server starts with only PATH, HOME and TMPDIR.</p>
    <label class="cd-option"><input type="checkbox" id="mcp-dlg-exclusive"> One session at a time</label>
    <div id="mcp-dlg-status" class="small muted" role="status"></div>
    <div class="btns"><button type="button" id="mcp-dlg-cancel">Cancel</button><button type="button" id="mcp-dlg-ok" class="primary">Add</button></div>
  </div>`;
  showModal(m);
  const setStatus = (t: string): void => {
    const el = document.getElementById("mcp-dlg-status");
    if (el) el.textContent = t;
  };
  const type = $<HTMLSelectElement>("#mcp-dlg-type");
  type.addEventListener("change", () => {
    const http = type.value === "http";
    $("#mcp-dlg-cmd-row").hidden = http;
    $("#mcp-dlg-url-row").hidden = !http;
    $("#mcp-dlg-hint").hidden = http;
  });
  $<HTMLButtonElement>("#mcp-dlg-cancel").onclick = closeModal;
  $<HTMLInputElement>("#mcp-dlg-label").focus();
  $<HTMLButtonElement>("#mcp-dlg-ok").addEventListener("click", async () => {
    const parsed = parseCustomForm({
      label: $<HTMLInputElement>("#mcp-dlg-label").value,
      key: $<HTMLInputElement>("#mcp-dlg-key").value,
      transport: type.value === "http" ? "http" : "stdio",
      commandLine: $<HTMLInputElement>("#mcp-dlg-cmd").value,
      url: $<HTMLInputElement>("#mcp-dlg-url").value,
      exclusive: $<HTMLInputElement>("#mcp-dlg-exclusive").checked,
    });
    if (!parsed.ok) return setStatus(parsed.error);
    const btn = $<HTMLButtonElement>("#mcp-dlg-ok");
    btn.disabled = true;
    setStatus("Saving…");
    try {
      const res = await sendAwait(srv, { type: "mcp.integration.add", integration: parsed.integration, cid: newCid() }, 20_000);
      if (res.type === "command.error") {
        setStatus(res.message);
        btn.disabled = false;
        return;
      }
      closeModal();
      toast(`Added “${parsed.integration.label}”.`);
    } catch (err) {
      setStatus(`Couldn't reach ${srv.name}: ${err instanceof Error ? err.message : err}`);
      btn.disabled = false;
    }
  });
}

// ── Session header: the Tools chip + menu ────────────────────────────────────────────────────────

/** Paint #header-tools for the open session. Hidden unless its machine supports integrations, has at
 *  least one, and the session is an ordinary one. */
export function updateHeaderTools(s: Session | undefined): void {
  const el = document.getElementById("header-tools");
  if (!el) return;
  const list = s ? sessionIntegrations(s.id) : [];
  if (!s || !isOrdinarySession(s) || !list.length) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  const label = toolsChipLabel(s, list);
  const anyOn = label !== "Tools";
  el.innerHTML = `${icon("extension")}<span class="hb-name">${esc(label)}</span>`;
  el.classList.toggle("on", anyOn);
  el.title = anyOn ? `Tools on for this session: ${label}. Tap to change.` : "Tools: none on for this session. Tap to switch one on.";
  el.hidden = false;
}

/** Tapping the chip: list this machine's integrations with a switch each. */
export function openToolsMenu(anchor: HTMLElement): void {
  const id = activeId();
  const s = id ? sessions.get(id) : undefined;
  if (!s || !isOrdinarySession(s)) return;
  const items: HeaderMenuItem[] = toolsMenuModel(s, sessionIntegrations(s.id)).map((it) => ({
    icon: it.icon,
    label: it.blocked ? `${it.label} (unavailable)` : it.label,
    title: it.title,
    run: () => {
      if (!it.next) return void toast(`${it.label} is unavailable: ${it.blocked}`);
      sendTo(s.id, { type: "session.set_mcp_integrations", sessionId: s.id, ids: it.next, cid: newCid() });
      // The driver's server set is fixed for a running turn; the daemon rebuilds it when the turn ends.
      if (s.status !== "idle") toast(it.on ? `${it.label} is off now; its tools leave after this turn.` : `${it.label} applies after this turn.`);
    },
  }));
  toggleHeaderMenu(anchor, items);
}
