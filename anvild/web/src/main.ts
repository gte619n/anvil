import { AnvilSocket } from "./ws";
import type {
  Budget,
  ContentBlock,
  ConversationEvent,
  PermissionSuggestion,
  ServerEvent,
  Session,
} from "../../protocol";

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const conversation = $("#conversation");
const scrollDown = () => {
  conversation.scrollTop = conversation.scrollHeight;
};

// ── State ────────────────────────────────────────────────────────────────────
const sessions = new Map<string, Session>();
let activeId: string | null = null;
let streaming: HTMLElement | null = null;

const seqStore = {
  get: (id: string): number => Number(localStorage.getItem(`anvil.seq.${id}`) ?? 0),
  set: (id: string, seq: number): void => localStorage.setItem(`anvil.seq.${id}`, String(seq)),
};

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
      appendUser(e.rendered.html);
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
  if (ev.kind === "user") appendUser(ev.rendered.html);
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
function appendUser(html: string): void {
  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = html; // daemon-sanitized (arch §8.3)
  bubble("user").appendChild(md);
  scrollDown();
}
function appendDelta(text: string): void {
  if (!streaming) {
    streaming = bubble("assistant");
    const pre = document.createElement("pre");
    pre.className = "stream";
    streaming.appendChild(pre);
  }
  const pre = streaming.querySelector(".stream");
  if (pre) pre.textContent += text;
  scrollDown();
}
function commitAssistant(blocks: ContentBlock[]): void {
  const b = streaming ?? bubble("assistant");
  b.innerHTML = "";
  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = blocks.map((blk) => (blk.kind === "markdown" ? blk.rendered.html : toolHtml(blk))).join("");
  b.appendChild(md);
  void runMermaid(md);
  streaming = null;
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
      m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
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
    li.innerHTML = `<div class="title">${esc(s.title)}</div><div class="meta">${esc(s.git?.branch ?? s.source)} · ${esc(s.status)} · ${esc(s.model)}</div>`;
    li.onclick = () => selectSession(s.id);
    ul.appendChild(li);
  }
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
$<HTMLFormElement>("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  if (!activeId || !text.trim()) return;
  sock.send({ type: "prompt.send", sessionId: activeId, text });
  input.value = "";
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $<HTMLFormElement>("#composer").requestSubmit();
  }
});

// ── Modals ─────────────────────────────────────────────────────────────────────
$("#new-session").addEventListener("click", showNewSession);
function showNewSession(): void {
  const root = $("#modal-root");
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h3>New session</h3>
    <label>Working directory<input id="ns-cwd" placeholder="/Users/you/project" /></label>
    <label>Model<select id="ns-model"><option value="opus">Opus</option><option value="sonnet">Sonnet</option></select></label>
    <label>Autonomy<select id="ns-auto"><option value="mostly-autonomous">Mostly autonomous</option><option value="allowlist">Allowlist</option><option value="prompt-all">Prompt all</option></select></label>
    <div class="btns"><button id="ns-cancel">Cancel</button><button id="ns-create">Create</button></div></div>`;
  root.innerHTML = "";
  root.appendChild(m);
  $<HTMLButtonElement>("#ns-cancel").onclick = () => (root.innerHTML = "");
  $<HTMLButtonElement>("#ns-create").onclick = () => {
    const cwd = $<HTMLInputElement>("#ns-cwd").value.trim();
    if (!cwd) return;
    sock.send({
      type: "session.create",
      source: "existing-dir",
      cwd,
      model: $<HTMLSelectElement>("#ns-model").value,
      autonomy: $<HTMLSelectElement>("#ns-auto").value,
    });
    root.innerHTML = "";
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
