// ── Settings → Skills: the fleet skill library ───────────────────────────────────────────────────
// One library of Claude Code skills for the whole fleet (docs/plans/2026-11-19-fleet-skills.md). The
// hub owns it and replicates it to every member daemon, so a skill added here is invocable as
// `/fleet:<name>` in every session on every machine — no per-project copying. Hub-authoritative like
// prompts: every skill.* command routes to the hub and a member's own `skills` event is ignored.
//
// main.ts wiring: main routes the hub's `skills` event to onSkills() and calls initSkills({ sendAwait })
// during module init; settings.ts calls renderSkillsPanel() when the Skills tab opens. No import of main.
import { $, busy, esc, icon } from "./dom";
import { closeModal, confirmDialog, showModal, toast } from "./dialogs";
import { hub, serverFetch, serverSupports, type Server } from "./fleet";
import { newCid } from "./outbox";
import type { FleetSkill, FleetSkillMemberSync, ServerEvent, SkillsEvent } from "../../protocol";

export interface SkillsDeps {
  /** cid-tracked request/response over a server's socket (main's `sendAwait`). */
  sendAwait(server: Server, cmd: Record<string, unknown> & { type: string; cid: string }, timeoutMs?: number): Promise<ServerEvent>;
}
let sendAwait: SkillsDeps["sendAwait"];
export function initSkills(deps: SkillsDeps): void {
  ({ sendAwait } = deps);
}

let skills: FleetSkill[] = [];
let members: FleetSkillMemberSync[] = [];
let known = false;

/** Apply the hub's `skills` broadcast and repaint the panel if it's open. */
export function onSkills(e: SkillsEvent): void {
  skills = e.skills ?? [];
  members = e.members ?? [];
  known = true;
  renderSkillsPanel();
}

const supported = (): boolean => hub().sock.isOpen() && serverSupports(hub(), "fleet-skills");

/** Send a skill command to the hub; toast its error. Resolves true on ack. */
async function call(cmd: Record<string, unknown> & { type: string }, timeoutMs = 30_000): Promise<boolean> {
  const res = await sendAwait(hub(), { ...cmd, cid: newCid() }, timeoutMs);
  if (res.type === "command.error") {
    toast(res.message);
    return false;
  }
  return true;
}

function sourceLabel(s: FleetSkill): string {
  switch (s.source.kind) {
    case "git":
      return `${icon("cloud_download")} <code class="small">${esc(s.source.url)}</code>${s.source.subdir ? ` <span class="muted">/${esc(s.source.subdir)}</span>` : ""}${s.source.ref ? ` <span class="muted">@${esc(s.source.ref)}</span>` : ""}`;
    case "local":
      return `${icon("folder")} <code class="small">${esc(s.source.path)}</code>`;
    default:
      return `${icon("edit_note")} written here`;
  }
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

function syncCard(): string {
  if (!members.length) {
    return `<p class="small muted">${icon("dns")} No other servers in this fleet — skills apply to this server's sessions.</p>`;
  }
  const rows = members
    .map((m) => {
      const state = m.inSync
        ? `<span class="small">${icon("check_circle")} In sync</span>`
        : m.error
          ? `<span class="warn small">${icon("error")} ${esc(m.error)}</span>`
          : `<span class="warn small">${icon("sync")} Out of date</span>`;
      return `<tr><td><b>${esc(m.serverName)}</b></td><td>${state}</td><td class="small muted">${esc(new Date(m.checkedAt).toLocaleTimeString())}</td></tr>`;
    })
    .join("");
  return `<div class="card"><div class="card-main" style="gap:8px"><b>Servers</b><button id="skills-sync" class="mini" style="margin-left:auto">${icon("sync")} Sync now</button></div>
    <table class="pt-table small"><tbody>${rows}</tbody></table></div>`;
}

/** Settings → Skills. No-op when the panel isn't on screen. */
export function renderSkillsPanel(): void {
  const host = document.getElementById("skill-cards");
  if (!host) return;
  if (!serverSupports(hub(), "fleet-skills")) {
    host.innerHTML = `<p class="small muted">${icon("info")} Update Anvil on your hub to manage fleet skills.</p>`;
    return;
  }
  if (!known) {
    host.innerHTML = `<p class="small muted">Loading…</p>`;
    return;
  }
  const list = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const cards = list.length
    ? list
        .map(
          (s) => `<div class="card prompt-card" data-name="${esc(s.name)}">
        <div class="prompt-card-main">
          <span class="env-glyph msym">auto_awesome</span>
          <div class="prompt-card-meta">
            <b>/fleet:${esc(s.name)}</b>
            <div class="small">${esc(s.description)}</div>
            <div class="small muted">${sourceLabel(s)} · ${s.files} file${s.files === 1 ? "" : "s"}, ${kb(s.bytes)}</div>
            <label class="small" style="display:flex;align-items:center;gap:6px;margin-top:4px"><input type="checkbox" class="skill-headless" data-name="${esc(s.name)}" ${s.headless ? "checked" : ""}/> Also use in autopilot &amp; dev-pipeline runs</label>
          </div>
          <div class="prompt-card-actions">
            <button class="mini skill-edit" data-name="${esc(s.name)}">${icon(s.source.kind === "inline" ? "edit" : "visibility")} ${s.source.kind === "inline" ? "Edit" : "View"}</button>
            ${s.source.kind !== "inline" ? `<button class="mini skill-update" data-name="${esc(s.name)}">${icon("refresh")} Update</button>` : ""}
            <button class="mini skill-del" data-name="${esc(s.name)}">${icon("delete")} Remove</button>
          </div>
        </div>
      </div>`,
        )
        .join("")
    : `<p class="small muted">No fleet skills yet. Import a skill repo (e.g. <code>owner/repo</code> on GitHub) or a folder on the hub such as <code>~/.claude/skills/my-skill</code>, or write one here.</p>`;
  const updatable = list.some((s) => s.source.kind !== "inline");
  host.innerHTML = `${syncCard()}${updatable ? `<div class="card-main" style="margin:8px 0"><button id="skills-update-all" class="mini">${icon("refresh")} Update all from source</button></div>` : ""}${cards}`;

  host.querySelector<HTMLButtonElement>("#skills-sync")?.addEventListener("click", (ev) => {
    void busy(ev.currentTarget as HTMLButtonElement, "Syncing…", async () => {
      if (await call({ type: "skill.sync" }, 120_000)) toast("Skill library synced.");
    });
  });
  host.querySelector<HTMLButtonElement>("#skills-update-all")?.addEventListener("click", (ev) => {
    void busy(ev.currentTarget as HTMLButtonElement, "Updating…", async () => {
      const before = skills.map((s) => s.hash).join();
      if (await call({ type: "skill.update" }, 300_000)) toast(skills.map((s) => s.hash).join() !== before ? "Skills updated from source." : "Skills are up to date.");
    });
  });
  host.querySelectorAll<HTMLButtonElement>(".skill-update").forEach((b) =>
    b.addEventListener("click", () => {
      void busy(b, "Updating…", async () => {
        const before = skills.find((s) => s.name === b.dataset.name)?.hash;
        if (await call({ type: "skill.update", name: b.dataset.name }, 300_000)) {
          toast(skills.find((s) => s.name === b.dataset.name)?.hash !== before ? `Updated /fleet:${b.dataset.name}.` : `/fleet:${b.dataset.name} is up to date.`);
        }
      });
    }),
  );
  host.querySelectorAll<HTMLInputElement>(".skill-headless").forEach((cb) =>
    cb.addEventListener("change", () => void call({ type: "skill.set_headless", name: cb.dataset.name, headless: cb.checked })),
  );
  host.querySelectorAll<HTMLButtonElement>(".skill-edit").forEach((b) => b.addEventListener("click", () => void showSkillEditor(b.dataset.name)));
  host.querySelectorAll<HTMLButtonElement>(".skill-del").forEach((b) =>
    b.addEventListener("click", async () => {
      const name = b.dataset.name!;
      const ok = await confirmDialog({ title: "Remove skill?", body: `/fleet:${name} will be removed from every server in the fleet.`, confirmLabel: "Remove", danger: true, icon: "delete" });
      if (ok) await call({ type: "skill.remove", name });
    }),
  );
}

const TEMPLATE = `---
name: my-skill
description: One line saying what this skill does and when Claude should use it.
---

# My skill

Step-by-step instructions for Claude.
`;

/** New/edit (inline) or view (git/local) a skill's SKILL.md. */
export async function showSkillEditor(name?: string): Promise<void> {
  if (!supported()) {
    toast(hub().sock.isOpen() ? "Your hub is too old for fleet skills — update it." : "Connect to your hub to manage skills.");
    return;
  }
  const existing = name ? skills.find((s) => s.name === name) : undefined;
  let body = TEMPLATE;
  if (existing) {
    try {
      const res = await serverFetch(hub().url, `/api/skills/file?name=${encodeURIComponent(existing.name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.text();
    } catch (e) {
      toast(`Couldn't load SKILL.md: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }
  const readOnly = !!existing && existing.source.kind !== "inline";
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>${existing ? (readOnly ? `/fleet:${esc(existing.name)}` : "Edit skill") : "New fleet skill"}</h3>
    ${readOnly ? `<p class="small muted">Imported from its source — change it there, then use <b>Update</b>.</p>` : ""}
    <label>Name (invoked as <code>/fleet:&lt;name&gt;</code>)<input id="sk-name" placeholder="e.g. release-notes" value="${esc(existing?.name ?? "")}" ${existing ? "disabled" : ""}/></label>
    <label>SKILL.md<textarea id="sk-body" class="prompt-body-input" rows="14" spellcheck="false" ${readOnly ? "readonly" : ""}>${esc(body)}</textarea></label>
    ${existing ? "" : `<label class="cd-option"><input type="checkbox" id="sk-headless" checked/> Also use in autopilot &amp; dev-pipeline runs</label>`}
    <div class="btns"><button type="button" id="sk-cancel">${readOnly ? "Close" : "Cancel"}</button>${readOnly ? "" : `<button type="button" id="sk-save" class="primary">${existing ? "Save" : "Add"}</button>`}</div></div>`;
  showModal(m);
  $<HTMLButtonElement>("#sk-cancel").onclick = closeModal;
  const save = document.getElementById("sk-save") as HTMLButtonElement | null;
  if (!save) return;
  save.onclick = () => {
    const skillName = existing?.name ?? $<HTMLInputElement>("#sk-name").value.trim();
    const text = $<HTMLTextAreaElement>("#sk-body").value;
    if (!skillName) return toast("Give the skill a name.");
    const headless = existing ? undefined : $<HTMLInputElement>("#sk-headless").checked;
    void busy(save, "Saving…", async () => {
      if (await call({ type: "skill.save", name: skillName, body: text, ...(headless !== undefined ? { headless } : {}) })) closeModal();
    });
  };
}

/** Import one or more skills from a git repo or a directory on the hub. */
export function showSkillImport(): void {
  if (!supported()) {
    toast(hub().sock.isOpen() ? "Your hub is too old for fleet skills — update it." : "Connect to your hub to manage skills.");
    return;
  }
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>Import skills</h3>
    <p class="small muted">A git repo (<code>owner/repo</code> for GitHub, or any https/ssh URL) or a folder on the hub. Every folder with a <code>SKILL.md</code> — at the root, one level down, or under <code>skills/</code> — is imported.</p>
    <label>Source<input id="si-src" placeholder="vercel-labs/agent-skills  ·  ~/.claude/skills/my-skill" /></label>
    <label>Branch or tag <span class="small muted">(optional, git only)</span><input id="si-ref" placeholder="main" /></label>
    <label>Subfolder <span class="small muted">(optional)</span><input id="si-sub" placeholder="skills/react-best-practices" /></label>
    <label class="cd-option"><input type="checkbox" id="si-headless" checked/> Also use in autopilot &amp; dev-pipeline runs</label>
    <div class="btns"><button type="button" id="si-cancel">Cancel</button><button type="button" id="si-go" class="primary">Import</button></div></div>`;
  showModal(m);
  $<HTMLButtonElement>("#si-cancel").onclick = closeModal;
  const go = $<HTMLButtonElement>("#si-go");
  go.onclick = () => {
    const source = $<HTMLInputElement>("#si-src").value.trim();
    if (!source) return toast("Enter a git repo or a folder path.");
    const ref = $<HTMLInputElement>("#si-ref").value.trim();
    const subdir = $<HTMLInputElement>("#si-sub").value.trim();
    const headless = $<HTMLInputElement>("#si-headless").checked;
    const before = new Set(skills.map((s) => s.name));
    void busy(go, "Importing…", async () => {
      if (!(await call({ type: "skill.import", source, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}), headless }, 300_000))) return;
      const added = skills.filter((s) => !before.has(s.name)).length;
      toast(added ? `Imported ${added} skill${added === 1 ? "" : "s"} — syncing to the fleet.` : "Skills refreshed from source.");
      closeModal();
    });
  };
}
