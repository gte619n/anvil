// ── Part sources: Settings → Models → "Part sources" (agent-cad-and-browser Phase C5) ────────────────
// The vendor APIs behind the agent's `parts_search` / `parts_fetch` tools: DigiKey, Mouser and
// TraceParts. Keys are entered here the way the OpenRouter key is — sent to the HUB daemon, stored in
// its env file, pushed to the members with the fleet's credentials — and are only ever shown masked.
// Hidden unless the hub advertises the "part-sources" capability. Like mcp.ts this module never imports
// main.ts; what it needs arrives through initParts(deps).
import { esc, icon } from "./dom";
import { confirmDialog, toast } from "./dialogs";
import { newCid } from "./outbox";
import { HUB_URL, serverSupports, servers, type Server } from "./fleet";
import type { PartSourceId, PartSourceStatus, ServerEvent } from "../../protocol";

export const PARTS_CAPABILITY = "part-sources";

export interface PartsDeps {
  sendAwait(server: Server, cmd: Record<string, unknown> & { type: string; cid: string }, timeoutMs?: number): Promise<ServerEvent>;
}
let sendAwait: PartsDeps["sendAwait"];
export function initParts(deps: PartsDeps): void {
  ({ sendAwait } = deps);
}

/** Each server's part sources (`parts.sources`), keyed by server url. Settings shows the hub's. */
export const serverParts = new Map<string, PartSourceStatus[]>();
/** The last Test result per source, shown under its card. */
const lastTest = new Map<PartSourceId, { ok: boolean; message: string }>();

const hubServer = (): Server | undefined => {
  const srv = servers.get(HUB_URL);
  return serverSupports(srv, PARTS_CAPABILITY) ? srv : undefined;
};

export function onPartSources(url: string, sources: PartSourceStatus[]): void {
  serverParts.set(url, sources);
  if (document.getElementById("parts-panel")) renderPartsPanel();
}

/** Static shell for the Models tab. Hidden until the hub advertises the capability. */
export function partsSectionShellHtml(): string {
  return `<div id="parts-section" hidden>
    <div class="section-head" style="margin-top:1.75rem"><h3>Part sources</h3></div>
    <p class="small muted">Vendor APIs the agent searches for part data, datasheets and CAD models (<code>parts_search</code>, <code>parts_fetch</code>) before it reaches for the browser. Keys are stored on the hub daemon (mode 0600) and pushed to the fleet's machines. A source without a key is skipped.</p>
    <div id="parts-panel"></div>
  </div>`;
}

/** One source's card. Pure (tests read the markup). */
export function partSourceCardHtml(s: PartSourceStatus, test?: { ok: boolean; message: string }): string {
  const fields = s.fields
    .map(
      (f) => `<label class="parts-field">${esc(f.label)} ${f.set ? `<code class="parts-masked">${esc(f.masked ?? "set")}</code>` : `<span class="small muted">not set</span>`}
        <input type="${f.name.endsWith("_EMAIL") ? "email" : "password"}" autocomplete="off" spellcheck="false" data-field="${esc(f.name)}" placeholder="${f.set ? "Replace…" : esc(f.label)}" /></label>`,
    )
    .join("");
  return `<div class="card parts-source" data-source="${esc(s.id)}">
    <div class="card-main"><span class="conn-dot ${s.configured ? "connected" : ""}"></span> <b>${esc(s.label)}</b>
      <span class="small ${s.configured ? "" : "muted"} parts-state">${s.configured ? "Configured" : "Not configured"}</span>
      <span class="mcp-row-actions">
        <button type="button" class="mini parts-test" ${s.configured ? "" : "disabled"} title="Make one cheap authenticated call to ${esc(s.label)}">${icon("network_check")} Test</button>
        ${s.fields.some((f) => f.set) ? `<button type="button" class="mini danger parts-clear">${icon("key_off")} Clear</button>` : ""}
      </span></div>
    ${s.note ? `<p class="small muted">${esc(s.note)}</p>` : ""}
    <div class="parts-fields">${fields}</div>
    <div class="card-main"><button type="button" class="primary mini parts-save">Save</button></div>
    ${test ? `<p class="small parts-test-result ${test.ok ? "" : "warn"}">${icon(test.ok ? "check_circle" : "error")} ${esc(test.message)}</p>` : ""}
  </div>`;
}

async function send(srv: Server, cmd: Record<string, unknown> & { type: string }): Promise<ServerEvent | undefined> {
  try {
    const res = await sendAwait(srv, { ...cmd, cid: newCid() }, 30_000);
    if (res.type === "command.error") {
      toast(res.message);
      return undefined;
    }
    return res;
  } catch (err) {
    toast(`Couldn't reach ${srv.name}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

export function renderPartsPanel(): void {
  const section = document.getElementById("parts-section");
  const host = document.getElementById("parts-panel");
  if (!section || !host) return;
  const srv = hubServer();
  section.hidden = !srv;
  if (!srv) {
    host.innerHTML = "";
    return;
  }
  const sources = serverParts.get(srv.url);
  if (!sources) {
    host.innerHTML = `<p class="small muted">Loading…</p>`;
    return;
  }
  host.innerHTML = sources.map((s) => partSourceCardHtml(s, lastTest.get(s.id))).join("");
  host.querySelectorAll<HTMLElement>(".parts-source").forEach((card) => {
    const id = card.dataset.source as PartSourceId;
    const label = sources.find((s) => s.id === id)?.label ?? id;
    card.querySelector<HTMLButtonElement>(".parts-save")?.addEventListener("click", async () => {
      const values: Record<string, string> = {};
      card.querySelectorAll<HTMLInputElement>("input[data-field]").forEach((i) => {
        if (i.value.trim()) values[i.dataset.field!] = i.value.trim();
      });
      if (!Object.keys(values).length) return toast(`Enter a ${label} key first.`);
      if (await send(srv, { type: "parts.keys.set", source: id, values })) toast(`${label} key saved on the hub.`);
    });
    card.querySelector<HTMLButtonElement>(".parts-test")?.addEventListener("click", async () => {
      const res = await send(srv, { type: "parts.test", source: id });
      if (res?.type !== "parts.test.result") return;
      lastTest.set(id, { ok: res.ok, message: res.message });
      renderPartsPanel();
    });
    card.querySelector<HTMLButtonElement>(".parts-clear")?.addEventListener("click", async () => {
      const ok = await confirmDialog({ title: `Clear the ${label} keys?`, body: `parts_search skips ${label} until a key is entered again. The keys are removed from the hub's env file.`, confirmLabel: "Clear", danger: true, icon: "key_off" });
      if (!ok) return;
      lastTest.delete(id);
      if (await send(srv, { type: "parts.keys.clear", source: id })) toast(`${label} keys cleared.`);
    });
  });
}

/** What the Models tab sends when it opens: a fresh list from the hub. */
export function refreshParts(): void {
  const srv = hubServer();
  if (srv) srv.sock.send({ type: "parts.sources.get", cid: newCid() });
  renderPartsPanel();
}
