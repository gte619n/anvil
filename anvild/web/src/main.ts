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
  GitResultEvent,
  GitStatus,
  PermissionSuggestion,
  ServerEvent,
  Session,
} from "../../protocol";

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const icon = (name: string): string => `<span class="msym">${name}</span>`;
const sessIcon = (s: Session): string => s.icon ?? (s.source === "fresh-worktree" ? "account_tree" : "folder");
const conversation = $("#conversation");
// Scroll lock: only auto-follow new content when the user is already at the bottom.
let stickToBottom = true;
const scrollDown = (force = false): void => {
  if (force) stickToBottom = true;
  if (stickToBottom) conversation.scrollTop = conversation.scrollHeight;
};
conversation.addEventListener("scroll", () => {
  const dist = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
  stickToBottom = dist < 60; // within 60px of the bottom counts as "following"
  const btn = document.getElementById("scroll-bottom");
  if (btn) (btn as HTMLElement).hidden = stickToBottom;
});

// ── State ────────────────────────────────────────────────────────────────────
const sessions = new Map<string, Session>();
const environments = new Map<string, Environment>();
// URL routing: the active session lives in the hash (#s/<id>) so Back/Forward works and a
// session is deep-linkable / openable in its own tab. A ?session= query (old push links) still works.
const sessionFromHash = (): string | null => {
  const m = location.hash.match(/^#s\/(.+)$/);
  return m ? decodeURIComponent(m[1]!) : null;
};
const sessionHref = (id: string): string => `${location.pathname}#s/${encodeURIComponent(id)}`;
function setSessionHash(id: string | null, push: boolean): void {
  const url = id ? sessionHref(id) : location.pathname;
  if (push) history.pushState({}, "", url);
  else history.replaceState({}, "", url);
}
let activeId: string | null = sessionFromHash() || new URLSearchParams(location.search).get("session") || localStorage.getItem("anvil.active");
setSessionHash(activeId, false); // canonicalize the URL (also strips any ?session=)
window.addEventListener("popstate", () => {
  const id = sessionFromHash();
  if (id && sessions.has(id)) selectSession(id, false);
  else deselectSession();
});
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
      // Don't persist transient UI (the thinking indicator / empty state) — it would
      // re-paint as a frozen "stuck" status on return.
      const clone = conversation.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".thinking, .empty-state").forEach((e) => e.remove());
      const html = clone.innerHTML;
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
} else {
  renderEmptyState();
}

// ── Theme (system default + persisted toggle) ────────────────────────────────
function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
function applyThemeIcon(): void {
  $("#theme-toggle").innerHTML = icon(currentTheme() === "dark" ? "light_mode" : "dark_mode");
}
(function initTheme() {
  const stored = localStorage.getItem("anvil.theme");
  const theme = stored ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
})();
applyThemeIcon();
$("#theme-toggle").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("anvil.theme", next);
  applyThemeIcon();
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
function toggleSidebar(): void {
  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem("anvil.sidebar", sidebarCollapsed ? "collapsed" : "open");
  applySidebar();
}
// both the header ☰ and an in-sidebar button toggle it — the in-sidebar one stays reachable
// when the open sidebar overlays the header (e.g. unfolding a foldable).
$("#btn-sidebar").addEventListener("click", toggleSidebar);
$("#sidebar-collapse").addEventListener("click", toggleSidebar);

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const sock = new AnvilSocket(wsUrl, onEvent, onStatus);
sock.connect();

// ── Web Push (arch §6.7) ──────────────────────────────────────────────────────────
let swReg: ServiceWorkerRegistration | null = null;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function urlB64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
async function initPush(): Promise<void> {
  if (!pushSupported) return; // unsupported (e.g. iOS Safari until installed as a PWA)
  const bell = $("#btn-notify");
  bell.hidden = false;
  try {
    swReg = await navigator.serviceWorker.register("/sw.js");
  } catch {
    bell.hidden = true;
    return;
  }
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open-session" && e.data.sessionId && sessions.has(e.data.sessionId)) selectSession(e.data.sessionId);
  });
  bell.addEventListener("click", () => void toggleNotify());
  void refreshBell();
}
async function refreshBell(): Promise<void> {
  const sub = await swReg?.pushManager.getSubscription();
  const on = Notification.permission === "granted" && !!sub;
  const bell = $("#btn-notify");
  bell.innerHTML = icon(on ? "notifications_active" : "notifications_off");
  bell.classList.toggle("active", on);
}
async function toggleNotify(): Promise<void> {
  if (!swReg) return;
  const existing = await swReg.pushManager.getSubscription();
  if (existing) {
    await fetch("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: existing.endpoint }) });
    await existing.unsubscribe();
    toast("Notifications off");
  } else {
    if ((await Notification.requestPermission()) !== "granted") {
      toast("Notifications blocked in browser settings");
      return;
    }
    const { publicKey } = (await (await fetch("/api/push/key")).json()) as { publicKey: string };
    const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(publicKey) });
    await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
    toast("Notifications on");
  }
  void refreshBell();
}
void initPush();

$("#scroll-bottom").addEventListener("click", () => {
  stickToBottom = true;
  conversation.scrollTop = conversation.scrollHeight;
  $("#scroll-bottom").hidden = true;
});

// Native Android shell bridge (present only inside the app): ADB-wifi connect, etc.
const nativeBridge: { postMessage(s: string): void; onmessage?: (e: MessageEvent) => void } | undefined = (window as unknown as { AnvilNative?: typeof nativeBridge }).AnvilNative;
if (nativeBridge) {
  nativeBridge.onmessage = (e) => {
    try {
      toast((JSON.parse(e.data) as { message?: string }).message ?? "done");
    } catch {
      /* ignore */
    }
  };
}

// ── Connection status ────────────────────────────────────────────────────────
function onStatus(status: "connecting" | "connected" | "disconnected"): void {
  const dot = $("#conn-dot");
  dot.className = `conn-dot ${status}`;
  dot.title = status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Disconnected";
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
        setHeaderTitle(sessions.get(activeId));
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
      if (e.session.id === activeId) updateGitPanelMeta();
      return;
    case "session.deleted":
      sessions.delete(e.sessionId);
      localStorage.removeItem(`anvil.convo.${e.sessionId}`);
      if (activeId === e.sessionId) deselectSession();
      else renderSessions();
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
    case "git.result":
      if (e.sessionId === activeId) showGitResult(e);
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
      if (panelView === "git" && e.sessionId === activeId) requestGitStatus(); // refresh the SCM buttons
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

// file links in the conversation (Read/Edit/… tool calls) open the reader
conversation.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest(".file-link") as HTMLElement | null;
  if (!link) return;
  e.preventDefault();
  const path = link.dataset.path;
  if (path && activeId) openFile(path);
});

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
    hideThinking(); // the streaming text itself is now the activity
    streaming = bubble("assistant");
    streaming.innerHTML = '<div class="md"></div>';
    streamText = "";
  }
  streamText += text;
  if (!streamRaf) streamRaf = requestAnimationFrame(renderStream);
}
const STREAM_TAIL_LINES = 10;
function renderStream(): void {
  streamRaf = 0;
  const md = streaming?.querySelector(".md");
  if (md) {
    // While streaming, show only the trailing lines so an in-flight turn stays compact;
    // the full, authoritative message replaces this on commit (assistant.message).
    const lines = streamText.split("\n");
    const tail = lines.length > STREAM_TAIL_LINES ? "…\n" + lines.slice(-STREAM_TAIL_LINES).join("\n") : streamText;
    md.innerHTML = streamMd.render(tail);
  }
  scrollDown();
}
// Animated "thinking" indicator (like Claude's), pinned to the bottom while a turn runs.
let thinkingEl: HTMLElement | null = null;
const THINK_LABEL: Record<string, string> = { thinking: "Thinking", running_tool: "Working", running: "Working" };
function showThinking(status: string): void {
  if (!thinkingEl) {
    thinkingEl = document.createElement("div");
    thinkingEl.className = "thinking";
    thinkingEl.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span class="think-label"></span>`;
  }
  const label = thinkingEl.querySelector(".think-label");
  if (label) label.textContent = THINK_LABEL[status] ?? "Thinking";
  conversation.appendChild(thinkingEl); // move to the bottom
  scrollDown();
}
function hideThinking(): void {
  thinkingEl?.remove();
  thinkingEl = null;
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
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
function toolPath(input: unknown): string | undefined {
  const i = input as Record<string, unknown> | undefined;
  for (const k of ["file_path", "path", "notebook_path"]) {
    if (typeof i?.[k] === "string") return i[k] as string;
  }
  return undefined;
}
function toolHtml(b: Extract<ContentBlock, { kind: "tool_use" }>): string {
  const path = toolPath(b.input);
  if (FILE_TOOLS.has(b.name) && path) {
    const base = path.split("/").pop() || path;
    return `<div class="tool">${icon("description")} <b>${esc(b.name)}</b> <a href="#" class="file-link" data-path="${esc(path)}" title="${esc(path)}">${esc(base)}</a></div>`;
  }
  const i = b.input as Record<string, unknown> | undefined;
  if (b.name === "Bash" && typeof i?.command === "string") {
    return `<div class="tool">${icon("terminal")} <code>${esc(i.command.slice(0, 240))}</code></div>`;
  }
  return `<div class="tool">${icon("build")} <b>${esc(b.name)}</b> <code>${esc(JSON.stringify(b.input)).slice(0, 160)}</code></div>`;
}
function appendToolResult(content: string, isError: boolean): void {
  const text = content.trim();
  const lineCount = text ? text.split("\n").length : 0;
  const first = text.split("\n").find((l) => l.trim()) ?? "(no output)";
  const el = document.createElement("details");
  el.className = `bubble tool-result ${isError ? "error" : ""}`;
  el.innerHTML =
    `<summary>${icon(isError ? "error" : "check")} ${isError ? "error" : "result"} · ${lineCount} line${lineCount === 1 ? "" : "s"} · ${esc(first.slice(0, 80))}</summary>` +
    `<pre>${esc(text.slice(0, 8000))}${text.length > 8000 ? "\n… (truncated)" : ""}</pre>`;
  conversation.appendChild(el);
  scrollDown();
}
function clearConversation(): void {
  conversation.innerHTML = "";
  streaming = null;
  thinkingEl = null; // detached by the innerHTML reset
}
const EMPTY_ART = `<img src="/anvil.svg" class="empty-art" alt="Anvil" width="132" height="132" />`;
function renderEmptyState(): void {
  streaming = null;
  thinkingEl = null;
  conversation.innerHTML = `<div class="empty-state">${EMPTY_ART}<p>Select a session, or create a new one.</p></div>`;
}
/** No session selected: reset the title, show the empty state, drop the persisted active id. */
function deselectSession(): void {
  activeId = null;
  localStorage.removeItem("anvil.active");
  setSessionHash(null, false);
  setHeaderTitle(undefined);
  renderEmptyState();
  renderSessions();
}
function setStatus(status: string): void {
  if (status === "idle") hideThinking();
  else if (!streaming) showThinking(status); // while text streams, the text is the activity
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
  const items = [...sessions.values()].sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
  for (const s of items) {
    const li = document.createElement("li");
    li.className = `session${s.id === activeId ? " active" : ""}${s.archived ? " archived" : ""}`;
    const envName = s.environmentId ? environments.get(s.environmentId)?.name : undefined;
    const where = envName ?? s.git?.branch ?? s.source;
    const tag = s.archived ? "archived" : esc(s.status);
    const a = document.createElement("a");
    a.className = "srow";
    a.href = sessionHref(s.id);
    a.innerHTML = `<div class="title">${icon(sessIcon(s))}<span class="t">${esc(s.title)}</span></div><div class="meta">${esc(where)} · ${tag} · ${esc(s.model)}</div>`;
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a new tab
      e.preventDefault();
      selectSession(s.id);
    });
    const open = document.createElement("button");
    open.className = "open-tab";
    open.title = "Open in new tab";
    open.innerHTML = icon("open_in_new");
    open.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(sessionHref(s.id), "_blank");
    });
    li.append(a, open);
    ul.appendChild(li);
  }
}
function setHeaderTitle(s: Session | undefined): void {
  $("#header-title").innerHTML = s ? `${icon(sessIcon(s))} ${esc(s.title)}` : "Anvil";
}
function onEnvironments(list: Environment[]): void {
  environments.clear();
  for (const e of list) environments.set(e.id, e);
  renderSessions();
  if (document.getElementById("ns-modal")) showNewSession(); // refresh an open new-session modal
  if (document.getElementById("env-cards")) renderEnvCards(); // refresh an open settings view
}

// ── Settings & servers (first-class management area) ──────────────────────────────
function openSettings(): void {
  const root = $("#settings-root");
  root.innerHTML = `<div class="settings-view">
    <div class="settings-head">
      <h2>${icon("tune")} Settings &amp; servers</h2>
      <button id="settings-close" class="icon-btn" title="Close">${icon("close")}</button>
    </div>
    <div class="settings-body">
      <section class="settings-section">
        <h3>Servers</h3>
        <div id="server-cards"><p class="small muted">Loading…</p></div>
      </section>
      <section class="settings-section">
        <div class="section-head"><h3>Environments</h3><button id="set-add-env" class="primary">${icon("add")} Add repo</button></div>
        <p class="small muted">Environments are git repositories. A new session branches a fresh worktree off one.</p>
        <div id="env-cards"></div>
      </section>
    </div>
  </div>`;
  $("#settings-close").addEventListener("click", closeSettings);
  $("#set-add-env").addEventListener("click", () => showAddEnvironment());
  renderServerCards();
  renderEnvCards();
}
function closeSettings(): void {
  $("#settings-root").innerHTML = "";
}
async function renderServerCards(): Promise<void> {
  const host = $("#server-cards");
  try {
    const h = (await (await fetch("/api/health")).json()) as { serverName?: string; version?: string; budget?: Budget };
    const b = h.budget;
    const budgetLine = b ? `Opus ${b.opus.usedHrs.toFixed(1)}/${b.opus.limitHrs}h · Sonnet ${b.sonnet.usedHrs.toFixed(1)}/${b.sonnet.limitHrs}h` : "";
    host.innerHTML = `<div class="card server-card">
      <div class="card-main"><span class="conn-dot connected"></span><b>${esc(h.serverName ?? location.host)}</b> <span class="small muted">(this server)</span></div>
      <div class="small muted"><code>${esc(location.host)}</code> · anvild ${esc(h.version ?? "?")}</div>
      <div class="small muted">${esc(budgetLine)}</div>
    </div>
    <p class="small muted">Multi-server (managing anvild on your other Macs from here) is on the roadmap — see the fleet design.</p>`;
  } catch {
    host.innerHTML = `<p class="small muted">Couldn't reach the server.</p>`;
  }
  if (nativeBridge) {
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="card"><div class="card-main">${icon("smartphone")} <b>This phone</b></div>
      <div class="small muted">Connect the Mac to this phone over wifi for app installs/debugging. Turn on <b>Wireless debugging</b> in Developer options first (pair once manually; after that it's one tap).</div>
      <div class="git-row" style="margin-top:10px"><button class="primary" id="adb-connect">${icon("wifi")} Connect via ADB (wifi)</button></div></div>`,
    );
    $("#adb-connect").addEventListener("click", () => {
      nativeBridge.postMessage(JSON.stringify({ type: "adb.connect" }));
      toast("Discovering phone…");
    });
  }
}
function renderEnvCards(): void {
  const host = document.getElementById("env-cards");
  if (!host) return;
  const envs = [...environments.values()];
  if (envs.length === 0) {
    host.innerHTML = `<p class="small muted">No environments yet. Add a git repo to get started.</p>`;
    return;
  }
  host.innerHTML = envs
    .map(
      (e) => `<div class="card env-card" data-env="${esc(e.id)}">
      <div class="env-head">
        <div class="env-meta">
          <b>${esc(e.name)}</b>
          <div class="small muted"><code>${esc(e.repoRoot)}</code></div>
          <div class="small muted">${icon("account_tree")} off <code>${esc(e.defaultBase ?? "HEAD")}</code></div>
        </div>
        <div class="env-actions">
          <button class="mini env-readme" data-env="${esc(e.id)}">${icon("description")} README</button>
          <button class="mini env-edit" data-env="${esc(e.id)}">${icon("edit")} Edit</button>
        </div>
      </div>
      <div class="env-readme-body" id="readme-${esc(e.id)}" hidden></div>
    </div>`,
    )
    .join("");
  host.querySelectorAll<HTMLElement>(".env-edit").forEach((b) => b.addEventListener("click", () => showEditEnvironment(b.dataset.env!)));
  host.querySelectorAll<HTMLElement>(".env-readme").forEach((b) => b.addEventListener("click", () => toggleReadme(b.dataset.env!)));
}
const readmeLoaded = new Set<string>();
async function toggleReadme(id: string): Promise<void> {
  const body = document.getElementById(`readme-${id}`);
  if (!body) return;
  body.hidden = !body.hidden;
  if (body.hidden || readmeLoaded.has(id)) return;
  body.innerHTML = `<p class="small muted">Loading README…</p>`;
  try {
    const r = (await (await fetch(`/api/environments/${encodeURIComponent(id)}/readme`)).json()) as { markdown?: { html: string }; text?: string; missing?: boolean };
    if (r.missing) body.innerHTML = `<p class="small muted">No README found in this repo.</p>`;
    else if (r.markdown) {
      body.innerHTML = `<div class="md reader-md">${r.markdown.html}</div>`;
      void runMermaid(body.querySelector(".reader-md") as HTMLElement);
    } else body.innerHTML = `<pre class="reader-text">${esc(r.text ?? "")}</pre>`;
    readmeLoaded.add(id);
  } catch {
    body.innerHTML = `<p class="small muted">Couldn't load the README.</p>`;
  }
}
function renderBudget(b: Budget): void {
  const el = $("#budget");
  el.classList.toggle("warn", b.warn);
  el.textContent = `Opus ${b.opus.usedHrs}/${b.opus.limitHrs}h · Sonnet ${b.sonnet.usedHrs}/${b.sonnet.limitHrs}h`;
}
function selectSession(id: string, push = true): void {
  activeId = id;
  localStorage.setItem("anvil.active", id);
  setSessionHash(id, push); // reflect in the URL (history entry unless restoring via Back/Forward)
  stickToBottom = true; // a freshly opened session starts pinned to the latest
  clearConversation();
  const cached = localStorage.getItem(`anvil.convo.${id}`);
  if (cached) {
    conversation.innerHTML = cached; // instant, replaced by the snapshot below
    scrollDown();
  }
  renderSessions();
  const s = sessions.get(id);
  setHeaderTitle(s);
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
let panelView: "files" | "reader" | "git" | "terminal" | null = null;
let filesPath = "";
let readerPath = "";
let readerWatch = "";
let xterm: XTerm | null = null;
let fit: FitAddon | null = null;
let termObs: ResizeObserver | null = null;

function setPanelTabs(): void {
  document.querySelectorAll<HTMLElement>(".ptab").forEach((t) => t.classList.toggle("active", t.dataset.view === panelView));
  $("#btn-files").classList.toggle("active", panelView === "files" || panelView === "reader");
  $("#btn-git").classList.toggle("active", panelView === "git");
  $("#btn-terminal").classList.toggle("active", panelView === "terminal");
}
function openPanel(view: "files" | "reader" | "git" | "terminal"): void {
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
  else if (view === "git") renderGit();
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
  disposeTerminal();
  panel.classList.add("open"); // a file link may open the reader while the panel is closed
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
// ── Git panel ──────────────────────────────────────────────────────────────────
function askClaude(instruction: string): void {
  if (!activeId) return;
  sock.send({ type: "prompt.send", sessionId: activeId, text: instruction });
  toast("Asked Claude →");
  closePanel(); // jump to the conversation to watch it work
}
type Stage = "commit" | "push" | "pr" | "merge";
// Each stage tells Claude to do EVERYTHING up to and including that stage.
const STAGE_PROMPT: Record<Stage, string> = {
  commit: "In this worktree, stage and commit all current changes with a clear, conventional commit message based on what changed. If there's nothing to commit, say so.",
  push: "In this worktree: commit all current changes with a clear conventional message (if any are uncommitted), then push the branch to its origin remote (set the upstream with -u if needed).",
  pr: "In this worktree, take the branch to an open PR: commit any uncommitted changes (good conventional message), push to origin, then create a GitHub pull request with the gh CLI (concise title + summary) if one doesn't already exist. Give me the PR URL.",
  merge: "In this worktree, take the branch all the way to merged: commit any uncommitted changes (good message), push to origin, create a GitHub PR with gh if none exists, then merge it into the repo's default branch with `gh pr merge --squash --delete-branch`. Report each step and confirm when it's merged.",
};
const STAGE_META: { key: Stage; icon: string; label: string }[] = [
  { key: "commit", icon: "commit", label: "Commit" },
  { key: "push", icon: "cloud_upload", label: "Push" },
  { key: "pr", icon: "call_merge", label: "PR" },
  { key: "merge", icon: "merge", label: "Merge" },
];
/** Which stages still have work to do, given the current source-control state. */
function gitStageEnabled(g: GitStatus | undefined): Record<Stage, boolean> {
  const dirty = g?.dirtyFileCount ?? 0;
  const ahead = g?.ahead ?? 0;
  const pr = g?.prState;
  return {
    commit: dirty > 0, // something uncommitted
    push: dirty > 0 || ahead > 0, // something not on the remote
    pr: pr !== "open" && pr !== "merged", // no PR yet
    merge: pr !== "merged", // not already merged
  };
}
function applyGitButtons(): void {
  const en = gitStageEnabled(activeId ? sessions.get(activeId)?.git : undefined);
  for (const { key } of STAGE_META) {
    const btn = document.getElementById(`ga-${key}`) as HTMLButtonElement | null;
    if (btn) btn.disabled = !en[key];
  }
}
function requestGitStatus(): void {
  if (activeId) sock.send({ type: "git", sessionId: activeId, op: "status" });
}
function renderGit(): void {
  panelView = "git";
  setPanelTabs();
  const s = activeId ? sessions.get(activeId) : undefined;
  const wt = s?.worktree;
  const stageBtns = STAGE_META.map((m) => `<button type="button" id="ga-${m.key}">${icon(m.icon)} ${m.label}</button>`).join("");
  panelContent.innerHTML = `<div class="git-panel">
    <div class="git-status"><span id="git-status-text">${gitStatusLine(s)}</span>
      <button type="button" class="mini" id="git-refresh" title="Refresh">${icon("refresh")}</button>
      <button type="button" class="mini" id="git-view-diff" title="View diff">${icon("difference")}</button></div>
    <div class="small muted git-worktree">${wt ? `worktree at <code>${esc(s!.cwd)}</code><br/>off <code>${esc(wt.base)}</code>` : esc(s?.cwd ?? "")}</div>
    <hr />
    <div class="git-row git-stages">${stageBtns}</div>
    <hr />
    <div class="git-row">
      <button type="button" id="ga-cleanup">${icon("cleaning_services")} Cleanup</button>
      <button type="button" class="danger" id="ga-abandon">${icon("delete_forever")} Abandon</button>
    </div>
    <pre class="git-output" id="git-output"></pre>
  </div>`;

  $("#git-refresh").onclick = () => {
    setGitOutput("refreshing…");
    requestGitStatus();
  };
  $("#git-view-diff").onclick = () => {
    if (!activeId) return;
    setGitOutput("loading diff…");
    sock.send({ type: "git", sessionId: activeId, op: "diff" });
  };
  for (const m of STAGE_META) {
    const btn = document.getElementById(`ga-${m.key}`) as HTMLButtonElement | null;
    if (btn) btn.onclick = () => runStage(m.key, m.label);
  }
  $("#ga-cleanup").onclick = cleanupSession;
  $("#ga-abandon").onclick = abandonSession;
  applyGitButtons();
  requestGitStatus(); // sync status + PR state on open
}
/** Run all stages up to `key`: lock the buttons immediately, refresh when the turn ends. */
function runStage(key: Stage, label: string): void {
  if (!activeId) return;
  for (const m of STAGE_META) {
    const b = document.getElementById(`ga-${m.key}`) as HTMLButtonElement | null;
    if (b) b.disabled = true; // immediate response; re-evaluated on the next status
  }
  setGitOutput(`Working… asked Claude to ${label.toLowerCase()}.`);
  sock.send({ type: "prompt.send", sessionId: activeId, text: STAGE_PROMPT[key] });
  toast(`${label} →`);
}
function gitStatusLine(s: Session | undefined): string {
  const g = s?.git;
  if (!g) return "(no git info)";
  const pr = g.prState ? ` · PR ${g.prState}` : "";
  return `${esc(g.branch)} · ${g.dirtyFileCount} changed · ${g.ahead}↑ ${g.behind}↓${pr}`;
}
function updateGitPanelMeta(): void {
  if (panelView !== "git") return;
  const s = activeId ? sessions.get(activeId) : undefined;
  const txt = document.getElementById("git-status-text");
  if (txt) txt.innerHTML = gitStatusLine(s);
  applyGitButtons();
}
/** Outstanding work that removing the session would lose. */
function outstandingWork(s: Session | undefined): string[] {
  const g = s?.git;
  const out: string[] = [];
  if (!g) return out;
  if (g.dirtyFileCount > 0) out.push(`${g.dirtyFileCount} uncommitted change${g.dirtyFileCount === 1 ? "" : "s"}`);
  if (g.ahead > 0) out.push(`${g.ahead} unpushed commit${g.ahead === 1 ? "" : "s"}`);
  if (g.prState === "open") out.push("an open PR (not merged)");
  return out;
}
async function cleanupSession(): Promise<void> {
  if (!activeId) return;
  const id = activeId;
  const outstanding = outstandingWork(sessions.get(id));
  if (outstanding.length === 0) {
    const ok = await confirmDialog({
      icon: "cleaning_services",
      title: "Clean up this session?",
      body: "Removes the local + remote branch and the worktree. The work is committed, pushed, and/or merged.",
      confirmLabel: "Clean up",
      danger: true,
    });
    if (ok) killSession(id);
    return;
  }
  showOutstandingDialog(outstanding);
}
async function abandonSession(): Promise<void> {
  if (!activeId) return;
  const id = activeId;
  const s = sessions.get(id);
  const ok = await confirmDialog({
    icon: "delete_forever",
    title: `Abandon “${s?.title ?? "this session"}”?`,
    body: "Force-deletes the local + remote branch and the worktree, discarding ALL uncommitted / unmerged work. This cannot be undone.",
    confirmLabel: "Abandon",
    danger: true,
  });
  if (ok) killSession(id);
}
/** Kill a session and tidy the UI immediately (the session.deleted broadcast also arrives). */
function killSession(id: string): void {
  sock.send({ type: "session.kill", sessionId: id });
  if (panelView) closePanel();
  if (activeId === id) deselectSession(); // don't wait for the (possibly slow) round-trip
}
/** Cleanup found outstanding work — offer to handle it first, or remove anyway. */
function showOutstandingDialog(outstanding: string[]): void {
  const s = activeId ? sessions.get(activeId) : undefined;
  const pr = s?.git?.prState;
  const root = $("#modal-root");
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>${icon("warning")} Outstanding work</h3>
    <p class="small muted">This session still has work that cleanup would lose:</p>
    <ul>${outstanding.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
    <p class="small muted">Have Claude handle it first:</p>
    <div class="git-row">
      <button type="button" id="od-commit">${icon("commit")} Commit</button>
      <button type="button" id="od-push">${icon("cloud_upload")} Push</button>
      <button type="button" id="od-pr">${icon(pr === "open" ? "merge" : "rocket_launch")} ${pr === "open" ? "Merge PR" : "Create PR"}</button>
    </div>
    <div class="btns"><button type="button" class="danger" id="od-remove">${icon("delete_forever")} Remove anyway</button><span style="flex:1"></span><button type="button" id="od-cancel">Cancel</button></div>
  </div>`;
  root.innerHTML = "";
  root.appendChild(m);
  const handle = (t: string) => {
    root.innerHTML = "";
    askClaude(t);
  };
  $<HTMLButtonElement>("#od-commit").onclick = () => handle(STAGE_PROMPT.commit);
  $<HTMLButtonElement>("#od-push").onclick = () => handle(STAGE_PROMPT.push);
  $<HTMLButtonElement>("#od-pr").onclick = () => handle(pr === "open" ? STAGE_PROMPT.merge : STAGE_PROMPT.pr);
  $<HTMLButtonElement>("#od-cancel").onclick = () => (root.innerHTML = "");
  $<HTMLButtonElement>("#od-remove").onclick = () => {
    root.innerHTML = "";
    if (activeId) killSession(activeId); // "Remove anyway" — the listed outstanding work IS the warning
  };
}
function setGitOutput(text: string): void {
  const el = document.getElementById("git-output");
  if (el) el.textContent = text;
}
function showGitResult(e: GitResultEvent): void {
  const el = document.getElementById("git-output");
  if (!el) return;
  const head = e.ok ? "" : "⚠ failed\n";
  el.innerHTML = esc(head + e.output).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
}

$("#btn-files").addEventListener("click", () => (panelView === "files" || panelView === "reader" ? closePanel() : openPanel("files")));
$("#btn-git").addEventListener("click", () => (panelView === "git" ? closePanel() : openPanel("git")));
$("#btn-terminal").addEventListener("click", () => (panelView === "terminal" ? closePanel() : openPanel("terminal")));
$("#panel-close").addEventListener("click", closePanel);
document.querySelectorAll<HTMLElement>(".ptab").forEach((t) => t.addEventListener("click", () => openPanel(t.dataset.view as "files" | "reader" | "git" | "terminal")));

// ── Modals ─────────────────────────────────────────────────────────────────────
let onDirs: ((e: DirsListResultEvent) => void) | null = null;
const browse = { path: "", parent: undefined as string | undefined };

$("#new-session").addEventListener("click", showNewSession);
$("#open-settings").addEventListener("click", openSettings);

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
      <p class="muted">No environments yet — add a project repo in Settings to get started.</p>
      <div class="btns"><button type="button" id="ns-cancel">Cancel</button><button type="button" id="ns-manage" class="primary">Settings &amp; servers</button></div>
      <p class="small muted"><a id="ns-oneoff" href="#">or work in a one-off folder…</a></p></div>`;
  } else {
    const opts = envs.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join("");
    m.innerHTML = `<div class="modal-box" id="ns-modal"><h3>New session</h3>
      <label>Environment<div class="env-row"><select id="ns-env">${opts}</select></div></label>
      <label>Session name<input id="ns-name" placeholder="e.g. fix-login-bug" /></label>
      <p class="small muted" id="ns-note"></p>
      <p class="small warn-text" id="ns-warn"></p>
      ${MODEL_AUTONOMY}
      <div class="btns"><button type="button" id="ns-cancel">Cancel</button><button type="button" id="ns-create">Create</button></div>
      <p class="small muted"><a id="ns-manage" href="#">⚙ Manage environments…</a> · <a id="ns-oneoff" href="#">one-off folder…</a></p></div>`;
  }
  root.innerHTML = "";
  root.appendChild(m);
  onDirs = null; // this modal has no browser

  document.getElementById("ns-cancel")?.addEventListener("click", closeModal);
  document.getElementById("ns-manage")?.addEventListener("click", (e) => {
    e.preventDefault();
    closeModal();
    openSettings();
  });
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
      const base = env?.defaultBase ?? "HEAD";
      note.textContent = !env
        ? ""
        : env.isRepo
          ? slug
            ? `→ fresh worktree on branch “${slug}” (off ${base})`
            : `Creates a fresh git worktree (off ${base}).`
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
    <label>Default branch (optional)<input id="ae-base" placeholder="e.g. main or dev — leave blank for HEAD" /></label>
    <p class="small muted">Pick a project <b>git repository</b> (environments must be git repos):</p>
    ${browserMarkup()}
    <div class="btns"><button type="button" id="ae-back">Cancel</button><button type="button" id="ae-save" class="primary">Add</button></div></div>`;
  root.innerHTML = "";
  root.appendChild(m);
  wireBrowser();
  $<HTMLButtonElement>("#ae-back").onclick = closeModal; // returns to Settings underneath
  $<HTMLButtonElement>("#ae-save").onclick = () => {
    if (!browse.path) return;
    const name = $<HTMLInputElement>("#ae-name").value.trim() || (browse.path.split("/").pop() ?? browse.path);
    const defaultBase = $<HTMLInputElement>("#ae-base").value.trim();
    sock.send({ type: "env.add", name, repoRoot: browse.path, ...(defaultBase ? { defaultBase } : {}) });
    closeModal(); // the environments broadcast refreshes Settings / the new-session list
  };
}

/** Edit an environment's name / default branch, or remove it. */
function showEditEnvironment(id: string): void {
  const env = environments.get(id);
  if (!env) return;
  const root = $("#modal-root");
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>Edit environment</h3>
    <label>Name<input id="ee-name" value="${esc(env.name)}" /></label>
    <label>Default branch<input id="ee-base" value="${esc(env.defaultBase ?? "")}" placeholder="e.g. main or dev — blank for HEAD" /></label>
    <p class="small muted">repo: <code>${esc(env.repoRoot)}</code>${env.isRepo ? "" : " (not a git repo)"}</p>
    <div class="btns"><button type="button" class="danger" id="ee-remove">Remove</button><span class="spacer" style="flex:1"></span><button type="button" id="ee-back">Back</button><button type="button" id="ee-save">Save</button></div></div>`;
  root.innerHTML = "";
  root.appendChild(m);
  $<HTMLButtonElement>("#ee-back").onclick = closeModal;
  $<HTMLButtonElement>("#ee-save").onclick = () => {
    sock.send({ type: "env.update", id, name: $<HTMLInputElement>("#ee-name").value, defaultBase: $<HTMLInputElement>("#ee-base").value });
    closeModal();
  };
  $<HTMLButtonElement>("#ee-remove").onclick = async () => {
    const ok = await confirmDialog({
      icon: "delete",
      title: `Remove “${env.name}”?`,
      body: "Removes this environment from the list. Existing sessions are unaffected.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (ok) {
      sock.send({ type: "env.remove", id });
      closeModal();
    }
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

/** Themed replacement for window.confirm — resolves true if confirmed. */
function confirmDialog(opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean; icon?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="modal-box">
      <h3>${opts.icon ? icon(opts.icon) + " " : ""}${esc(opts.title)}</h3>
      ${opts.body ? `<p class="small muted">${esc(opts.body)}</p>` : ""}
      <div class="btns"><button type="button" id="cd-cancel">Cancel</button><button type="button" id="cd-ok" class="${opts.danger ? "danger" : "primary"}">${esc(opts.confirmLabel ?? "OK")}</button></div>
    </div>`;
    root.innerHTML = "";
    root.appendChild(m);
    const done = (v: boolean): void => {
      root.innerHTML = "";
      resolve(v);
    };
    $<HTMLButtonElement>("#cd-ok").onclick = () => done(true);
    $<HTMLButtonElement>("#cd-cancel").onclick = () => done(false);
    m.addEventListener("click", (e) => {
      if (e.target === m) done(false); // click backdrop to cancel
    });
  });
}
