import MarkdownIt from "markdown-it";
import { AnvilSocket } from "./ws";
import type {
  AttachmentRef,
  Budget,
  ContentBlock,
  ConversationEvent,
  DirsListResultEvent,
  Environment,
  PermissionSuggestion,
  ServerEvent,
  Session,
} from "../../protocol";

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const conversation = $("#conversation");
const scrollDown = () => {
  conversation.scrollTop = conversation.scrollHeight;
};

// ── State ────────────────────────────────────────────────────────────────────
const sessions = new Map<string, Session>();
const environments = new Map<string, Environment>();
let activeId: string | null = null;
let streaming: HTMLElement | null = null;

const seqStore = {
  get: (id: string): number => Number(localStorage.getItem(`anvil.seq.${id}`) ?? 0),
  set: (id: string, seq: number): void => localStorage.setItem(`anvil.seq.${id}`, String(seq)),
};

// ── Theme (system default + persisted toggle) ────────────────────────────────
function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
(function initTheme() {
  const stored = localStorage.getItem("anvil.theme");
  const theme = stored ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
})();
$("#theme-toggle").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("anvil.theme", next);
});

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const sock = new AnvilSocket(wsUrl, onEvent, onStatus);
sock.connect();

// ── Connection status ────────────────────────────────────────────────────────
function onStatus(status: "connecting" | "connected" | "disconnected"): void {
  const el = $("#conn");
  el.textContent = status;
  el.className = `conn ${status}`;
  if (status === "connected" && activeId) {
    sock.send({ type: "session.attach", sessionId: activeId, lastSeq: seqStore.get(activeId) });
  }
}

// ── Event routing ──────────────────────────────────────────────────────────────
function onEvent(e: ServerEvent): void {
  if ("seq" in e && "sessionId" in e && typeof e.seq === "number") seqStore.set(e.sessionId, e.seq);

  switch (e.type) {
    case "session.list":
      e.sessions.forEach((s) => sessions.set(s.id, s));
      renderSessions();
      return;
    case "session.created":
      sessions.set(e.session.id, e.session);
      renderSessions();
      if (!activeId) selectSession(e.session.id);
      return;
    case "session.updated":
      sessions.set(e.session.id, e.session);
      renderSessions();
      return;
    case "session.deleted":
      sessions.delete(e.sessionId);
      if (activeId === e.sessionId) {
        activeId = null;
        clearConversation();
      }
      renderSessions();
      return;
    case "budget":
      renderBudget(e.budget);
      return;
    case "environments":
      onEnvironments(e.environments);
      return;
    case "dirs.list.result":
      onDirs?.(e);
      return;
    case "command.error":
      toast(e.message);
      return;
    case "ack":
      return;
    default:
      if ("sessionId" in e && e.sessionId !== activeId) return; // not the open pane
      handleSessionEvent(e);
  }
}

function handleSessionEvent(e: ServerEvent): void {
  switch (e.type) {
    case "conversation.snapshot":
      clearConversation();
      e.events.forEach(renderConversationEvent);
      return;
    case "message.user":
      appendUser(e.rendered.html, e.attachments);
      return;
    case "assistant.delta":
      appendDelta(e.text);
      return;
    case "assistant.message":
      commitAssistant(e.blocks);
      return;
    case "tool.result":
      appendToolResult(e.content, e.isError);
      return;
    case "status":
      setStatus(e.status);
      return;
    case "result":
      setStatus("idle");
      streaming = null;
      return;
    case "permission.request":
      showPermission(e.requestId, e.tool, e.input, e.suggestions);
      return;
    case "error":
      toast(e.message);
      return;
  }
}

// replay/snapshot events fold into the same renderers
function renderConversationEvent(ev: ConversationEvent): void {
  if (ev.kind === "user") appendUser(ev.rendered.html, ev.attachments);
  else if (ev.kind === "assistant") commitAssistant(ev.blocks);
  else if (ev.kind === "tool_result") appendToolResult(ev.content, ev.isError);
}

// ── Conversation rendering ─────────────────────────────────────────────────────
function bubble(role: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  conversation.appendChild(el);
  scrollDown();
  return el;
}
function appendUser(html: string, attachments: AttachmentRef[] = []): void {
  const b = bubble("user");
  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = html; // daemon-sanitized (arch §8.3)
  b.appendChild(md);
  for (const att of attachments) {
    if (att.kind === "image" && activeId) {
      const img = document.createElement("img");
      img.className = "att-img";
      img.src = `/api/sessions/${activeId}/attachments/${att.id}`;
      b.appendChild(img);
    }
  }
  scrollDown();
}
// Lightweight client renderer for the in-flight turn (the daemon ships authoritative,
// Shiki-highlighted HTML on assistant.message; this just makes streaming readable).
const streamMd = new MarkdownIt({ html: false, linkify: true, typographer: true });
let streamText = "";
let streamRaf = 0;

function appendDelta(text: string): void {
  if (!streaming) {
    streaming = bubble("assistant");
    streaming.innerHTML = '<div class="md"></div>';
    streamText = "";
  }
  streamText += text;
  if (!streamRaf) streamRaf = requestAnimationFrame(renderStream);
}
function renderStream(): void {
  streamRaf = 0;
  const md = streaming?.querySelector(".md");
  if (md) md.innerHTML = streamMd.render(streamText);
  scrollDown();
}
function commitAssistant(blocks: ContentBlock[]): void {
  if (streamRaf) {
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
  }
  const b = streaming ?? bubble("assistant");
  b.innerHTML = "";
  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = blocks.map((blk) => (blk.kind === "markdown" ? blk.rendered.html : toolHtml(blk))).join("");
  b.appendChild(md);
  void runMermaid(md);
  streaming = null;
  streamText = "";
  scrollDown();
}
function toolHtml(b: Extract<ContentBlock, { kind: "tool_use" }>): string {
  return `<div class="tool">🔧 <b>${esc(b.name)}</b> <code>${esc(JSON.stringify(b.input)).slice(0, 200)}</code></div>`;
}
function appendToolResult(content: string, isError: boolean): void {
  const el = document.createElement("div");
  el.className = `bubble tool-result ${isError ? "error" : ""}`;
  el.textContent = content.slice(0, 4000);
  conversation.appendChild(el);
  scrollDown();
}
function clearConversation(): void {
  conversation.innerHTML = "";
  streaming = null;
}
function setStatus(status: string): void {
  $("#status").textContent = status === "idle" ? "" : status.replace("_", " ") + "…";
  const s = activeId ? sessions.get(activeId) : undefined;
  if (s) {
    s.status = status as Session["status"];
    renderSessions();
  }
}

// ── Mermaid (lazy) ──────────────────────────────────────────────────────────────
let mermaidReady: Promise<any> | null = null;
async function runMermaid(container: HTMLElement): Promise<void> {
  const nodes = [...container.querySelectorAll<HTMLElement>("pre.mermaid")];
  if (nodes.length === 0) return;
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: currentTheme() === "dark" ? "dark" : "default" });
      return m.default;
    });
  }
  const mermaid = await mermaidReady;
  for (const node of nodes) {
    try {
      const id = "m" + Math.random().toString(36).slice(2);
      const { svg } = await mermaid.render(id, node.textContent ?? "");
      node.innerHTML = svg;
    } catch {
      /* leave the source text in place */
    }
  }
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
function renderSessions(): void {
  const ul = $("#session-list");
  ul.innerHTML = "";
  for (const s of sessions.values()) {
    const li = document.createElement("li");
    li.className = `session${s.id === activeId ? " active" : ""}`;
    const envName = s.environmentId ? environments.get(s.environmentId)?.name : undefined;
    const where = envName ?? s.git?.branch ?? s.source;
    li.innerHTML = `<div class="title">${esc(s.title)}</div><div class="meta">${esc(where)} · ${esc(s.status)} · ${esc(s.model)}</div>`;
    li.onclick = () => selectSession(s.id);
    ul.appendChild(li);
  }
}
function onEnvironments(list: Environment[]): void {
  environments.clear();
  for (const e of list) environments.set(e.id, e);
  renderSessions();
  if (document.getElementById("ns-modal")) showNewSession(); // refresh an open new-session modal
}
function renderBudget(b: Budget): void {
  const el = $("#budget");
  el.classList.toggle("warn", b.warn);
  el.textContent = `Opus ${b.opus.usedHrs}/${b.opus.limitHrs}h · Sonnet ${b.sonnet.usedHrs}/${b.sonnet.limitHrs}h`;
}
function selectSession(id: string): void {
  activeId = id;
  clearConversation();
  renderSessions();
  const s = sessions.get(id);
  $("#header-title").textContent = s?.title ?? "Anvil";
  sock.send({ type: "session.attach", sessionId: id, lastSeq: seqStore.get(id) });
}

// ── Composer ───────────────────────────────────────────────────────────────────
const input = $<HTMLTextAreaElement>("#input");
const pendingAttachments: { id: string; name: string; dataUrl: string }[] = [];
const attachRow = $("#attach-row");

$<HTMLFormElement>("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  if (!activeId || (!text.trim() && pendingAttachments.length === 0)) return;
  sock.send({ type: "prompt.send", sessionId: activeId, text, attachmentIds: pendingAttachments.map((a) => a.id) });
  input.value = "";
  pendingAttachments.length = 0;
  renderAttachRow();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $<HTMLFormElement>("#composer").requestSubmit();
  }
});

function renderAttachRow(): void {
  attachRow.innerHTML = "";
  pendingAttachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.innerHTML = `<img src="${a.dataUrl}" alt="${esc(a.name)}" /><button type="button" class="rm" title="Remove">×</button>`;
    chip.querySelector(".rm")!.addEventListener("click", () => {
      pendingAttachments.splice(i, 1);
      renderAttachRow();
    });
    attachRow.appendChild(chip);
  });
}
async function uploadAttachment(file: File): Promise<void> {
  if (!activeId) {
    toast("Open a session first");
    return;
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const base64 = dataUrl.split(",")[1] ?? "";
  try {
    const res = await fetch(`/api/sessions/${activeId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name || "pasted-image.png", mediaType: file.type || "image/png", dataBase64: base64 }),
    });
    if (!res.ok) {
      toast("Upload failed");
      return;
    }
    const { attachment } = (await res.json()) as { attachment: { id: string; name: string } };
    pendingAttachments.push({ id: attachment.id, name: attachment.name, dataUrl });
    renderAttachRow();
  } catch {
    toast("Upload failed");
  }
}
input.addEventListener("paste", (e) => {
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) {
        e.preventDefault();
        void uploadAttachment(f);
      }
    }
  }
});
const composerEl = $("#composer");
composerEl.addEventListener("dragover", (e) => e.preventDefault());
composerEl.addEventListener("drop", (e) => {
  e.preventDefault();
  for (const f of Array.from((e as DragEvent).dataTransfer?.files ?? [])) {
    if (f.type.startsWith("image/")) void uploadAttachment(f);
  }
});

// ── Select-to-quote (highlight any message text → quote into the composer) ─────────
const quoteBtn = document.createElement("button");
quoteBtn.id = "quote-btn";
quoteBtn.textContent = "❝ Quote";
quoteBtn.style.display = "none";
document.body.appendChild(quoteBtn);
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? "";
  const node = sel && sel.rangeCount > 0 ? sel.anchorNode : null;
  const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
  if (!text || !el?.closest("#conversation")) {
    quoteBtn.style.display = "none";
    return;
  }
  const rect = sel!.getRangeAt(0).getBoundingClientRect();
  quoteBtn.style.display = "block";
  quoteBtn.style.top = `${window.scrollY + rect.top - 36}px`;
  quoteBtn.style.left = `${window.scrollX + rect.left}px`;
});
quoteBtn.addEventListener("mousedown", (e) => {
  e.preventDefault(); // keep the selection alive through the click
  const text = window.getSelection()?.toString().trim() ?? "";
  if (!text) return;
  const quoted = text.split("\n").map((l) => `> ${l}`).join("\n");
  input.value = input.value ? `${quoted}\n\n${input.value}` : `${quoted}\n\n`;
  input.focus();
  quoteBtn.style.display = "none";
  window.getSelection()?.removeAllRanges();
});

// ── Modals ─────────────────────────────────────────────────────────────────────
let onDirs: ((e: DirsListResultEvent) => void) | null = null;
const browse = { path: "", parent: undefined as string | undefined };

$("#new-session").addEventListener("click", showNewSession);

const closeModal = (): void => {
  onDirs = null;
  $("#modal-root").innerHTML = "";
};
const MODEL_AUTONOMY = `<div class="row">
  <label>Model<select id="ns-model"><option value="opus">Opus</option><option value="sonnet">Sonnet</option></select></label>
  <label>Autonomy<select id="ns-auto"><option value="mostly-autonomous">Mostly autonomous</option><option value="allowlist">Allowlist</option><option value="prompt-all">Prompt all</option></select></label>
</div>`;

/** A reusable directory browser (used by add-environment and one-off). */
function browserMarkup(): string {
  return `<div class="browser">
    <div class="browser-path"><button type="button" id="ns-up" title="Up">⬆</button><code id="ns-cur">…</code></div>
    <ul id="ns-dirs" class="browser-list"></ul>
  </div>`;
}
function wireBrowser(): void {
  onDirs = (e) => {
    browse.path = e.path;
    browse.parent = e.parent;
    $("#ns-cur").textContent = e.path;
    $<HTMLButtonElement>("#ns-up").disabled = !e.parent;
    const ul = $("#ns-dirs");
    ul.innerHTML = "";
    for (const d of e.entries) {
      const li = document.createElement("li");
      li.innerHTML = `<span>📁 ${esc(d.name)}</span>${d.isRepo ? '<span class="repo">git</span>' : ""}`;
      li.onclick = () => sock.send({ type: "dirs.list", path: d.path });
      ul.appendChild(li);
    }
  };
  $<HTMLButtonElement>("#ns-up").onclick = () => {
    if (browse.parent) sock.send({ type: "dirs.list", path: browse.parent });
  };
  sock.send({ type: "dirs.list" });
}

/** Primary flow: pick an environment + name → fresh worktree. */
function showNewSession(): void {
  const root = $("#modal-root");
  const envs = [...environments.values()];
  const m = document.createElement("div");
  m.className = "modal";
  if (envs.length === 0) {
    m.innerHTML = `<div class="modal-box" id="ns-modal"><h3>New session</h3>
      <p class="muted">No environments yet — register a project repo to get started.</p>
      <div class="btns"><button type="button" id="ns-cancel">Cancel</button><button type="button" id="ns-addenv">＋ Add environment</button></div>
      <p class="small muted"><a id="ns-oneoff" href="#">or work in a one-off folder…</a></p></div>`;
  } else {
    const opts = envs.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join("");
    m.innerHTML = `<div class="modal-box" id="ns-modal"><h3>New session</h3>
      <label>Environment<div class="env-row"><select id="ns-env">${opts}</select><button type="button" id="ns-addenv" title="Add environment">＋</button></div></label>
      <label>Session name<input id="ns-name" placeholder="e.g. fix-login-bug" /></label>
      <p class="small muted" id="ns-note"></p>
      <p class="small warn-text" id="ns-warn"></p>
      ${MODEL_AUTONOMY}
      <div class="btns"><button type="button" id="ns-cancel">Cancel</button><button type="button" id="ns-create">Create</button></div>
      <p class="small muted"><a id="ns-oneoff" href="#">or work in a one-off folder…</a></p></div>`;
  }
  root.innerHTML = "";
  root.appendChild(m);
  onDirs = null; // this modal has no browser

  document.getElementById("ns-cancel")?.addEventListener("click", closeModal);
  document.getElementById("ns-addenv")?.addEventListener("click", () => showAddEnvironment());
  document.getElementById("ns-oneoff")?.addEventListener("click", (e) => {
    e.preventDefault();
    showOneOff();
  });
  const envSel = document.getElementById("ns-env") as HTMLSelectElement | null;
  const nameInp = document.getElementById("ns-name") as HTMLInputElement | null;
  const createBtn = document.getElementById("ns-create") as HTMLButtonElement | null;
  const note = document.getElementById("ns-note");
  const warn = document.getElementById("ns-warn");

  const validate = (): void => {
    if (!envSel || !nameInp || !createBtn) return;
    const env = environments.get(envSel.value);
    const name = nameInp.value.trim();
    const slug = slugify(name);
    const dup = !!env && slug.length > 0 && [...sessions.values()].some((s) => s.environmentId === env.id && slugify(s.title) === slug);
    if (note) {
      note.textContent = !env
        ? ""
        : env.isRepo
          ? slug
            ? `→ fresh worktree on branch “${slug}”`
            : "Creates a fresh git worktree."
          : `Works directly in ${env.repoRoot} (no worktree).`;
    }
    if (warn) warn.textContent = dup ? `A session named “${name}” already exists in this environment.` : "";
    createBtn.disabled = !env || !name || dup;
  };
  envSel?.addEventListener("change", validate);
  nameInp?.addEventListener("input", validate);
  nameInp?.focus();
  validate();

  createBtn?.addEventListener("click", () => {
    if (!envSel || !nameInp) return;
    const env = environments.get(envSel.value);
    const name = nameInp.value.trim();
    if (!env || !name) return;
    const common = {
      title: name,
      environmentId: env.id,
      model: $<HTMLSelectElement>("#ns-model").value,
      autonomy: $<HTMLSelectElement>("#ns-auto").value,
    };
    if (env.isRepo) {
      sock.send({ type: "session.create", source: "fresh-worktree", repoRoot: env.repoRoot, base: env.defaultBase ?? "HEAD", ...common });
    } else {
      sock.send({ type: "session.create", source: "existing-dir", cwd: env.repoRoot, ...common });
    }
    closeModal();
  });
}

/** Register a project repo as an environment. */
function showAddEnvironment(): void {
  const root = $("#modal-root");
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>Add environment</h3>
    <label>Name<input id="ae-name" placeholder="e.g. OXOS Bots" /></label>
    <p class="small muted">Pick a project repo (gets worktrees) or any folder:</p>
    ${browserMarkup()}
    <div class="btns"><button type="button" id="ae-back">Back</button><button type="button" id="ae-save">Add</button></div></div>`;
  root.innerHTML = "";
  root.appendChild(m);
  wireBrowser();
  $<HTMLButtonElement>("#ae-back").onclick = () => showNewSession();
  $<HTMLButtonElement>("#ae-save").onclick = () => {
    if (!browse.path) return;
    const name = $<HTMLInputElement>("#ae-name").value.trim() || (browse.path.split("/").pop() ?? browse.path);
    sock.send({ type: "env.add", name, repoRoot: browse.path });
    showNewSession(); // the environments broadcast will populate the new env
  };
}

/** One-off: work directly in a folder, no worktree. */
function showOneOff(): void {
  const root = $("#modal-root");
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>One-off session</h3>
    <p class="small muted">Work directly in a folder (no worktree):</p>
    ${browserMarkup()}
    ${MODEL_AUTONOMY}
    <div class="btns"><button type="button" id="oo-back">Back</button><button type="button" id="oo-create">Open here</button></div></div>`;
  root.innerHTML = "";
  root.appendChild(m);
  wireBrowser();
  $<HTMLButtonElement>("#oo-back").onclick = () => showNewSession();
  $<HTMLButtonElement>("#oo-create").onclick = () => {
    if (!browse.path) return;
    sock.send({
      type: "session.create",
      source: "existing-dir",
      cwd: browse.path,
      model: $<HTMLSelectElement>("#ns-model").value,
      autonomy: $<HTMLSelectElement>("#ns-auto").value,
    });
    closeModal();
  };
}
function showPermission(requestId: string, tool: string, inputObj: unknown, suggestions: PermissionSuggestion[]): void {
  const root = $("#modal-root");
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>Permission needed</h3><p><b>${esc(tool)}</b></p><pre>${esc(JSON.stringify(inputObj, null, 2)).slice(0, 800)}</pre><div class="btns"></div></div>`;
  const btns = m.querySelector(".btns")!;
  for (const s of suggestions) {
    const b = document.createElement("button");
    b.textContent = s.label;
    b.onclick = () => {
      sock.send({ type: "permission.respond", requestId, decision: s.decision });
      root.innerHTML = "";
    };
    btns.appendChild(b);
  }
  root.innerHTML = "";
  root.appendChild(m);
}

// ── Toast ──────────────────────────────────────────────────────────────────────
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}
