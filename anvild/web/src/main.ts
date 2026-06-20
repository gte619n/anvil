import MarkdownIt from "markdown-it";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AnvilSocket } from "./ws";

const strToB64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
};
import type {
  AttachmentRef,
  Budget,
  ContentBlock,
  ConversationEvent,
  DirEntry,
  DirsListResultEvent,
  Environment,
  FileContent,
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
let activeId: string | null = localStorage.getItem("anvil.active");
let streaming: HTMLElement | null = null;
const snapshotLoaded = new Set<string>(); // sessions with a full snapshot loaded this page-load

const seqStore = {
  get: (id: string): number => Number(localStorage.getItem(`anvil.seq.${id}`) ?? 0),
  set: (id: string, seq: number): void => localStorage.setItem(`anvil.seq.${id}`, String(seq)),
};

// Cache the rendered conversation per session so it shows instantly on reload, before the WS
// even connects. Best-effort (skipped if it exceeds the localStorage quota).
let cacheTimer = 0;
function saveConvoCache(): void {
  const id = activeId;
  if (!id) return;
  clearTimeout(cacheTimer);
  cacheTimer = window.setTimeout(() => {
    try {
      const html = conversation.innerHTML;
      if (html.length < 1_500_000) localStorage.setItem(`anvil.convo.${id}`, html);
      else localStorage.removeItem(`anvil.convo.${id}`);
    } catch {
      /* quota exceeded — the snapshot still loads from the daemon */
    }
  }, 600);
}

// instant restore: paint the cached conversation immediately on load
if (activeId) {
  const cached = localStorage.getItem(`anvil.convo.${activeId}`);
  if (cached) {
    conversation.innerHTML = cached;
    conversation.scrollTop = conversation.scrollHeight;
  }
}

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

// ── Sidebar collapse ─────────────────────────────────────────────────────────────
const isNarrow = (): boolean => matchMedia("(max-width: 720px)").matches;
let sidebarCollapsed =
  localStorage.getItem("anvil.sidebar") === "collapsed" ||
  (localStorage.getItem("anvil.sidebar") === null && isNarrow());
function applySidebar(): void {
  $("#sidebar").classList.toggle("collapsed", sidebarCollapsed);
}
applySidebar();
$("#btn-sidebar").addEventListener("click", () => {
  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem("anvil.sidebar", sidebarCollapsed ? "collapsed" : "open");
  applySidebar();
});

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const sock = new AnvilSocket(wsUrl, onEvent, onStatus);
sock.connect();

// ── Connection status ────────────────────────────────────────────────────────
function onStatus(status: "connecting" | "connected" | "disconnected"): void {
  const el = $("#conn");
  el.textContent = status;
  el.className = `conn ${status}`;
  // (re)attach happens in the session.list handler, which the daemon sends on every connect.
}

// ── Event routing ──────────────────────────────────────────────────────────────
function onEvent(e: ServerEvent): void {
  if ("seq" in e && "sessionId" in e && typeof e.seq === "number") seqStore.set(e.sessionId, e.seq);

  switch (e.type) {
    case "session.list":
      e.sessions.forEach((s) => sessions.set(s.id, s));
      renderSessions();
      if (activeId && sessions.has(activeId)) {
        $("#header-title").textContent = sessions.get(activeId)!.title;
        // first attach this page-load → full snapshot (DOM was reloaded); a later reconnect
        // (DOM intact) → resume only new events from the watermark.
        if (snapshotLoaded.has(activeId)) {
          sock.send({ type: "session.attach", sessionId: activeId, lastSeq: seqStore.get(activeId) });
        } else {
          sock.send({ type: "session.attach", sessionId: activeId });
        }
      } else if (activeId) {
        activeId = null; // the remembered session is gone
        localStorage.removeItem("anvil.active");
        clearConversation();
      }
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
      localStorage.removeItem(`anvil.convo.${e.sessionId}`);
      if (activeId === e.sessionId) {
        activeId = null;
        localStorage.removeItem("anvil.active");
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
    case "fs.list.result":
      if (panel.classList.contains("open") && e.sessionId === activeId) renderFiles(e.entries);
      return;
    case "fs.read.result":
      renderReader(e.content);
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
      snapshotLoaded.add(e.sessionId);
      saveConvoCache();
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
      saveConvoCache();
      return;
    case "permission.request":
      showPermission(e.requestId, e.tool, e.input, e.suggestions);
      return;
    case "fs.changed":
      if (panel.classList.contains("open") && e.content.path === readerPath) renderReader(e.content);
      return;
    case "terminal.data":
      xterm?.write(b64ToBytes(e.data));
      return;
    case "terminal.exit":
      xterm?.write(`\r\n\x1b[90m[process exited: ${e.code}]\x1b[0m\r\n`);
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
  saveConvoCache();
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
  localStorage.setItem("anvil.active", id);
  clearConversation();
  const cached = localStorage.getItem(`anvil.convo.${id}`);
  if (cached) {
    conversation.innerHTML = cached; // instant, replaced by the snapshot below
    scrollDown();
  }
  renderSessions();
  const s = sessions.get(id);
  $("#header-title").textContent = s?.title ?? "Anvil";
  snapshotLoaded.delete(id);
  sock.send({ type: "session.attach", sessionId: id }); // full snapshot (always show history)
  if (isNarrow() && !sidebarCollapsed) {
    sidebarCollapsed = true;
    applySidebar(); // on a phone, get out of the way once you've picked a session
  }
  // reset the side panel for the new session's worktree
  filesPath = "";
  readerPath = "";
  readerWatch = "";
  if (panelView) openPanel("files");
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
  autoGrow();
  updateSendState();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $<HTMLFormElement>("#composer").requestSubmit();
  }
});
input.addEventListener("input", () => {
  autoGrow();
  updateSendState();
});
function autoGrow(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}
function updateSendState(): void {
  $<HTMLButtonElement>("#send").disabled = !input.value.trim() && pendingAttachments.length === 0;
}

// attach button → file picker
const fileInput = $<HTMLInputElement>("#file-input");
$("#btn-attach").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  for (const f of Array.from(fileInput.files ?? [])) {
    if (f.type.startsWith("image/")) void uploadAttachment(f);
  }
  fileInput.value = "";
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
  updateSendState();
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
function selectionEl(): Element | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) return null;
  const node = sel.anchorNode;
  const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
  return el?.closest("#conversation, #panel-content") ?? null;
}
document.addEventListener("selectionchange", () => {
  const el = selectionEl();
  if (!el) {
    quoteBtn.style.display = "none";
    return;
  }
  const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
  quoteBtn.style.display = "block";
  quoteBtn.style.top = `${window.scrollY + rect.top - 36}px`;
  quoteBtn.style.left = `${window.scrollX + rect.left}px`;
});
quoteBtn.addEventListener("mousedown", (e) => {
  e.preventDefault(); // keep the selection alive through the click
  const el = selectionEl();
  const text = window.getSelection()?.toString().trim() ?? "";
  if (!el || !text) return;
  const fromReader = el.closest("#panel-content") && readerPath;
  const prefix = fromReader ? `> from \`${readerPath}\`:\n` : "";
  const quoted = prefix + text.split("\n").map((l) => `> ${l}`).join("\n");
  input.value = input.value ? `${quoted}\n\n${input.value}` : `${quoted}\n\n`;
  input.focus();
  quoteBtn.style.display = "none";
  window.getSelection()?.removeAllRanges();
});

// ── Side panel: files + reader (terminal lands next) ──────────────────────────────
const panel = $("#side-panel");
const panelContent = $("#panel-content");
let panelView: "files" | "reader" | "terminal" | null = null;
let filesPath = "";
let readerPath = "";
let readerWatch = "";
let xterm: XTerm | null = null;
let fit: FitAddon | null = null;
let termObs: ResizeObserver | null = null;

function setPanelTabs(): void {
  document.querySelectorAll<HTMLElement>(".ptab").forEach((t) => t.classList.toggle("active", t.dataset.view === panelView));
  $("#btn-files").classList.toggle("active", panelView === "files" || panelView === "reader");
  $("#btn-terminal").classList.toggle("active", panelView === "terminal");
}
function openPanel(view: "files" | "reader" | "terminal"): void {
  if (!activeId) {
    toast("Open a session first");
    return;
  }
  if (view !== "terminal") disposeTerminal();
  panelView = view;
  panel.classList.add("open");
  setPanelTabs();
  if (view === "files") requestFiles(filesPath);
  else if (view === "reader" && !readerPath) requestFiles(filesPath);
  else if (view === "terminal") mountTerminal();
}
function closePanel(): void {
  if (readerWatch && activeId) sock.send({ type: "fs.unwatch", sessionId: activeId, path: readerWatch });
  readerWatch = "";
  disposeTerminal();
  panelView = null;
  panel.classList.remove("open");
  setPanelTabs();
}
function mountTerminal(): void {
  disposeTerminal();
  panelContent.innerHTML = '<div id="term-host" style="height:100%;width:100%"></div>';
  const dark = currentTheme() === "dark";
  xterm = new XTerm({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: dark ? { background: "#1a1b1e", foreground: "#e6e7e9" } : { background: "#ffffff", foreground: "#1c2024" },
  });
  fit = new FitAddon();
  xterm.loadAddon(fit);
  xterm.open($("#term-host"));
  fit.fit();
  xterm.onData((d) => {
    if (activeId) sock.send({ type: "terminal.input", sessionId: activeId, data: strToB64(d) });
  });
  if (activeId) sock.send({ type: "terminal.open", sessionId: activeId, cols: xterm.cols, rows: xterm.rows });
  termObs = new ResizeObserver(() => {
    if (fit && xterm && activeId) {
      fit.fit();
      sock.send({ type: "terminal.resize", sessionId: activeId, cols: xterm.cols, rows: xterm.rows });
    }
  });
  termObs.observe(panelContent);
}
function disposeTerminal(): void {
  termObs?.disconnect();
  termObs = null;
  xterm?.dispose();
  xterm = null;
  fit = null;
}
function requestFiles(path: string): void {
  if (!activeId) return;
  filesPath = path;
  sock.send({ type: "fs.list", sessionId: activeId, path });
}
function renderFiles(entries: DirEntry[]): void {
  panelView = "files";
  setPanelTabs();
  const ul = document.createElement("ul");
  ul.className = "file-list";
  if (filesPath) {
    const up = document.createElement("li");
    up.className = "dir";
    up.innerHTML = "📁 ..";
    up.onclick = () => requestFiles(filesPath.split("/").slice(0, -1).join("/"));
    ul.appendChild(up);
  }
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = e.isDir ? "dir" : "";
    li.innerHTML = `${e.isDir ? "📁" : "📄"} ${esc(e.name)}`;
    li.onclick = () => (e.isDir ? requestFiles(e.path) : openFile(e.path));
    ul.appendChild(li);
  }
  panelContent.innerHTML = "";
  panelContent.appendChild(ul);
}
function openFile(path: string): void {
  if (!activeId) return;
  readerPath = path;
  panelView = "reader";
  setPanelTabs();
  if (readerWatch && readerWatch !== path) sock.send({ type: "fs.unwatch", sessionId: activeId, path: readerWatch });
  sock.send({ type: "fs.read", sessionId: activeId, path });
  sock.send({ type: "fs.watch", sessionId: activeId, path });
  readerWatch = path;
  panelContent.innerHTML = `<p class="muted small">Loading ${esc(path)}…</p>`;
}
function renderReader(content: FileContent): void {
  if (content.path !== readerPath) return;
  panelView = "reader";
  setPanelTabs();
  const head = `<div class="reader-head"><b>${esc(content.path)}</b><a href="#" id="reader-back">← files</a></div>`;
  if (content.markdown) {
    panelContent.innerHTML = head + `<div class="md reader-md">${content.markdown.html}</div>`;
    void runMermaid(panelContent.querySelector(".reader-md") as HTMLElement);
  } else if (content.text !== undefined) {
    panelContent.innerHTML = head + `<pre class="reader-text">${esc(content.text)}</pre>` + (content.truncated ? '<p class="muted small">(truncated)</p>' : "");
  } else if (content.binaryUrl) {
    panelContent.innerHTML =
      head + (content.mime.startsWith("image/") ? `<img src="${content.binaryUrl}" style="max-width:100%" />` : `<a href="${content.binaryUrl}" target="_blank">Open ${esc(content.path)}</a>`);
  }
  const back = document.getElementById("reader-back");
  if (back) back.onclick = (e) => { e.preventDefault(); openPanel("files"); };
}
$("#btn-files").addEventListener("click", () => (panelView === "files" || panelView === "reader" ? closePanel() : openPanel("files")));
$("#btn-terminal").addEventListener("click", () => (panelView === "terminal" ? closePanel() : openPanel("terminal")));
$("#panel-close").addEventListener("click", closePanel);
document.querySelectorAll<HTMLElement>(".ptab").forEach((t) => t.addEventListener("click", () => openPanel(t.dataset.view as "files" | "reader" | "terminal")));

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
