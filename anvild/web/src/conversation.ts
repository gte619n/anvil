// ── Conversation pane: rendering + turn activity + links model + copy/download actions ───────────
// Extracted verbatim from main.ts (P7 god-file decomposition). The seams here:
//   1. Conversation rendering: bubbles, topic dividers, timestamps, the streaming draft renderer
//      (streamMd — also used by main's prompt-edit preview, hence exported), the thinking
//      indicator, assistant commit (incl. linkified .md paths), and the scroll lock.
//   2. The consolidated per-turn activity block (§5) + tool results.
//   3. The links MODEL (§links): `references` / `pendingAnswerRefs`, extraction/commit, and the
//      header badge. The links side-PANEL chrome (renderLinks) deliberately lives in panel.ts with
//      the rest of the side panel — it writes panelView/panelContent/setPanelTabs, which are
//      side-panel state — and is injected back here so addRefs/clearReferences can refresh it.
//   4. File-offer cards (§download), the session hero, the attach diagnostic, Stop (§stop),
//      copy-to-clipboard, link/attachment copy-download actions (hover bar + Android long-press
//      menu), and lazy Mermaid rendering.
//
// This module evaluates BEFORE main.ts's body (main imports it), which preserves the declare-up-top
// guarantee for the conversation-owned early-init scalars (`thinkingEl`/`activity*`/`references`/
// `pendingAnswerRefs`/`tailSpacer`): they initialize at module eval here, so main's instant-restore
// renderEmptyState() call — which runs during ITS module init — never sees them in a temporal dead
// zone (see memory: web-early-init-decl-order-crash). Top-level DOM side effects (listener wiring,
// attaching the floating action bar / long-press menu to <body>) run via initConversation(deps) —
// which main calls during its module init, before the instant restore and before any socket can
// deliver an event — not at import time.
//
// Cross-module REASSIGNED scalars (`ui.stickToBottom`, `ui.streaming`, `ui.turnCanceled`,
// `ui.replayingSnapshot`) live in state.ts: an imported binding can't be reassigned, and both this
// module and main.ts write them. In-place containers (`references`) stay exported `const`s here.
import MarkdownIt from "markdown-it";
import { $, esc, icon, sessIcon } from "./dom";
import { currentTheme } from "./theme";
import { ui } from "./state";
// dialogs.ts is a leaf, so toast + the permission/question card-map reset are direct imports —
// they used to arrive via initConversation(deps).
import { clearCardMaps, closeModal, showModal, toast } from "./dialogs";
import { envOrdinal, sessionBg, stripeColor } from "./sessionColor";
import { ensureOwningServer, hostOf, orderedServers, sendTo, serverApiUrl, serverByUrl, serverOf, servers, sessionServer, wireSessionId, type Server } from "./fleet";
import { isAndroidApp } from "./platform";
import { telemetry } from "./telemetry";
import { reconcileOptimistic } from "./sendReconcile";
import type { AttachmentRef, ContentBlock, Environment, FileOffer, Session, ToolResultImage } from "../../protocol";

// ── Injected dependencies (initConversation) ─────────────────────────────────────────────────────
// What conversation code calls back into main.ts for. Each field documents the main.ts state it
// reaches (or panel.ts state, routed through main — this module can't import panel.ts, which
// imports this one). Reassigned scalars (`activeId`, `panelView`) are injected as lazy reads.
export interface ConversationDeps {
  /** The currently-open session's id (main's `activeId` — a reassigned scalar, read at call time). */
  activeId(): string | null;
  /** The server that owns the currently-open session (main's `activeServer`). */
  activeServer(): Server;
  /** The merged session list (main owns it — fleet fan-in populates it). */
  sessions: Map<string, Session>;
  /** The merged environment list (session-hero tint + env-name chip). */
  environments: Map<string, Environment>;
  /** Sessions with a full snapshot loaded this page-load (main owns it — the attach flow writes it,
   *  the attach diagnostic reads/clears it). Mutated in place, so the Set itself is injected. */
  snapshotLoaded: Set<string>;
  /** Debounced per-session transcript cache write (main's `saveConvoCache`). */
  saveConvoCache(): void;
  /** Status fan-out (main's `setStatus` — cancelThinking forces "idle" through the same path). */
  setStatus(status: string): void;
  /** The open side panel, if any (panel.ts's `panelView` — a reassigned scalar, read at call time). */
  panelView(): string | null;
  /** The links side-panel chrome (lives in panel.ts; refreshed when the reference set changes). */
  renderLinks(): void;
}
// Module-local mirrors of the injected deps, named exactly as in main.ts so the moved code below
// stays verbatim (`activeId` becomes the call `activeId()`). Assigned once by initConversation —
// which main.ts calls during its module init, before the instant-restore render — so no
// conversation entry point can observe them unset.
let activeId: ConversationDeps["activeId"];
let activeServer: ConversationDeps["activeServer"];
let sessions: ConversationDeps["sessions"];
let environments: ConversationDeps["environments"];
let snapshotLoaded: ConversationDeps["snapshotLoaded"];
let saveConvoCache: ConversationDeps["saveConvoCache"];
let setStatus: ConversationDeps["setStatus"];
let panelView: ConversationDeps["panelView"];
let renderLinks: ConversationDeps["renderLinks"];
export function initConversation(deps: ConversationDeps): void {
  ({ activeId, activeServer, sessions, environments, snapshotLoaded, saveConvoCache, setStatus, panelView, renderLinks } = deps);
  // Re-bind the import-time DOM captures (`conversation`/`stopBtn`) to the LIVE document before wiring.
  // In production this is a no-op — the elements are present when the bundle loads. But the test harness
  // shares one module registry across files (bun), so conversation.ts may have been first imported before
  // a given test installed its DOM, leaving the captures null; re-resolving here makes init order-independent
  // (a null capture would otherwise throw at `conversation.addEventListener` below).
  conversation = $("#conversation") ?? conversation;
  stopBtn = $<HTMLButtonElement>("#stop") ?? stopBtn;
  wireConversationDom();
}

export let conversation = $("#conversation");
// Scroll lock: only auto-follow new content when the user is already at the bottom.
// `ui.stickToBottom` lives in state.ts — main's selectSession also re-pins it on session open.
export const scrollDown = (force = false): void => {
  if (force) ui.stickToBottom = true;
  // [WEB2-9] Snapshot replay is batched: every appended message used to scroll here, and each scroll
  // is a forced layout (scrollHeight read + scrollTop write) over an ever-growing pane — O(n²), which
  // froze large transcripts. During replay the appends skip the scroll entirely; main's
  // conversation.snapshot handler issues ONE scrollDown after clearing the flag.
  if (ui.replayingSnapshot) return;
  if (ui.stickToBottom) conversation.scrollTop = conversation.scrollHeight;
};

// Early-init module state (declare-up-top rule — see main.ts §Early-init): these initialize at
// module eval, which happens before main's body runs, so the instant-restore render can't hit
// their TDZ.
let thinkingEl: HTMLElement | null = null; // animated "thinking" indicator, pinned to the bottom while a turn runs
let activityEl: HTMLDetailsElement | null = null; // consolidated per-turn tool/thinking activity block (§5)
let activityCount = 0;
let activityLive = false;
const activityTail: string[] = [];
export const references = new Map<string, string>(); // url → display label, insertion-ordered (Links panel)
let pendingAnswerRefs: string[] = []; // links seen in the latest assistant prose, promoted on `result`

// ── Top-level DOM wiring (runs via initConversation, at main's original wiring time) ─────────────
function wireConversationDom(): void {
  conversation.addEventListener("scroll", () => {
    const dist = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
    ui.stickToBottom = dist < 60; // within 60px of the bottom counts as "following"
    const btn = document.getElementById("scroll-bottom");
    if (btn) (btn as HTMLElement).hidden = ui.stickToBottom;
  });
  $("#scroll-bottom").addEventListener("click", () => {
    ui.stickToBottom = true;
    conversation.scrollTop = conversation.scrollHeight;
    $("#scroll-bottom").hidden = true;
  });
  stopBtn.addEventListener("click", cancelThinking);
  // Click (or tap) any conversation image — a tool screenshot or a user attachment — to pop it
  // full-size. On desktop the hover bar still offers copy/download; on Android long-press does.
  conversation.addEventListener("click", (e) => {
    const img = (e.target as HTMLElement).closest<HTMLImageElement>("#conversation .att-img");
    if (!img) return;
    e.preventDefault();
    openImageLightbox(img.src, fileNameFromUrl(img.src, "image.png"));
  });
  // Flag the platform on <html> so CSS can suppress the native long-press callout on links/attachments.
  document.documentElement.classList.toggle("is-android", isAndroidApp);
  wireLinkActions();
  wireLinkMenu();
}

// ── Conversation rendering ─────────────────────────────────────────────────────
function bubble(role: string): HTMLElement {
  dropSessionHero(); // real content arriving — retire the blank-session title card
  removeTailSpacer(); // fresh content fills the pane; drop any "new topic" blank space below
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  conversation.appendChild(el);
  scrollDown();
  return el;
}

// A "new topic" divider (§0.6) acts like a header: it scrolls to the top of the pane with a viewport
// of blank space below, so the earlier conversation slides up out of view (it stays — scroll up).
// The spacer is temporary; the next message removes it via bubble().
let tailSpacer: HTMLElement | null = null;
function removeTailSpacer(): void {
  tailSpacer?.remove();
  tailSpacer = null;
}
function appendTopicDivider(label: string, note?: string): void {
  dropSessionHero();
  const el = document.createElement("div");
  el.className = "topic-divider";
  el.innerHTML = `<div class="topic-rule"><span class="topic-chip">${icon("restart_alt")}<span>${esc(label)}</span></span></div>`;
  if (note) {
    const n = document.createElement("div");
    n.className = "topic-note";
    n.textContent = note;
    el.appendChild(n);
  }
  conversation.appendChild(el);
  if (!ui.replayingSnapshot) pushDividerToTop(el); // a fresh clear pushes to top; replay keeps normal flow
}
function pushDividerToTop(el: HTMLElement): void {
  removeTailSpacer();
  const spacer = document.createElement("div");
  spacer.className = "convo-tail-spacer";
  spacer.style.height = `${conversation.clientHeight}px`; // a full viewport so the divider can reach the top
  conversation.appendChild(spacer);
  tailSpacer = spacer;
  ui.stickToBottom = false; // we're deliberately parked at the divider, not following the bottom
  requestAnimationFrame(() => {
    const top = el.getBoundingClientRect().top - conversation.getBoundingClientRect().top + conversation.scrollTop;
    conversation.scrollTop = Math.max(0, top - 16);
  });
}
// ── Timestamps ─────────────────────────────────────────────────────────────────
/** A small, muted time label for a message (short text; full date/time on hover). */
function timeEl(ts?: string): HTMLElement | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const el = document.createElement("div");
  el.className = "msg-time";
  el.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.title = d.toLocaleString();
  return el;
}

export function appendUser(html: string, attachments: AttachmentRef[] = [], ts?: string, cid?: string): void {
  // Exactly-once reconciliation (v4, spec A6): the authoritative echo carries the send's cid — retire
  // the matching optimistic bubble, and drop a true duplicate echo so exactly-once holds in the UI too.
  if (cid && reconcileOptimistic(conversation, cid) === "duplicate") {
    telemetry.mark("sendDuplicates");
    return;
  }
  resetActivity(); // a new user turn closes off the previous turn's activity block
  ui.turnCanceled = false; // a fresh user turn starts clean
  pendingAnswerRefs = []; // don't carry a prior turn's un-committed links across
  const b = bubble("user");
  if (cid) b.dataset.cid = cid; // tag so a later duplicate echo is recognised
  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = html; // daemon-sanitized (arch §8.3)
  b.appendChild(md);
  for (const att of attachments) {
    if (!activeId()) continue;
    // wireSessionId: the OWNING daemon's id in the path (#158 — a member's default chat is namespaced client-side)
    const href = serverApiUrl(activeServer().url, `/api/sessions/${wireSessionId(activeId()!)}/attachments/${att.id}`);
    if (att.kind === "image") {
      const img = document.createElement("img");
      img.className = "att-img";
      img.src = href;
      b.appendChild(img);
    } else {
      // a non-image attachment → a downloadable file chip
      const a = document.createElement("a");
      a.className = "att-file";
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.innerHTML = `${icon("description")}<span class="att-name">${esc(att.name)}</span>`;
      b.appendChild(a);
    }
  }
  const t = timeEl(ts);
  if (t) b.appendChild(t);
  // Note: we deliberately do NOT collect links from the user's own prompt — only from Claude's answers.
  scrollDown();
  saveConvoCache();
}
/** Optimistically render a queued (offline) user message; the authoritative copy (delivered on flush,
 *  carrying the same cid) retires this bubble — see appendUser's cid reconciliation (spec A6). */
export function appendOptimisticUser(text: string, cid: string): void {
  resetActivity();
  ui.turnCanceled = false;
  pendingAnswerRefs = [];
  const b = bubble("user");
  b.classList.add("queued");
  b.dataset.cid = cid; // matched against the authoritative message.user's cid on flush
  const md = document.createElement("div");
  md.className = "md";
  md.textContent = text; // plain text is safe; full markdown render comes from the daemon on flush
  b.appendChild(md);
  const badge = document.createElement("span");
  badge.className = "queued-badge";
  badge.innerHTML = `${icon("schedule")} queued`;
  b.appendChild(badge);
  const t = timeEl(new Date().toISOString());
  if (t) b.appendChild(t);
  scrollDown();
  saveConvoCache();
}
// Lightweight client renderer for the in-flight turn (the daemon ships authoritative,
// Shiki-highlighted HTML on assistant.message; this just makes streaming readable).
// Exported: main's prompt-edit preview renders through the same instance.
export const streamMd = new MarkdownIt({ html: false, linkify: true, typographer: true });
let streamText = "";
let streamRaf = 0;

export function appendDelta(text: string): void {
  if (!ui.streaming) {
    hideThinking(); // the streaming text itself is now the activity
    ui.streaming = bubble("assistant");
    ui.streaming.innerHTML = '<div class="md"></div>';
    streamText = "";
  }
  streamText += text;
  if (!streamRaf) streamRaf = requestAnimationFrame(renderStream);
}
const STREAM_TAIL_LINES = 10;
function renderStream(): void {
  streamRaf = 0;
  const md = ui.streaming?.querySelector(".md");
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
// `thinkingEl` is declared in the early-init cluster up top (reached by renderEmptyState at load).
const THINK_LABEL: Record<string, string> = { thinking: "Thinking", running_tool: "Working", running: "Working" };
export function showThinking(status: string): void {
  if (activityLive) return; // the live activity block already shows running state
  dropSessionHero(); // a turn is starting — retire the blank-session title card
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
export function hideThinking(): void {
  thinkingEl?.remove();
  thinkingEl = null;
}
export function commitAssistant(blocks: ContentBlock[], ts?: string): void {
  if (streamRaf) {
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
  }
  const mdBlocks = blocks.filter((b): b is Extract<ContentBlock, { kind: "markdown" }> => b.kind === "markdown");
  const toolBlocks = blocks.filter((b): b is Extract<ContentBlock, { kind: "tool_use" }> => b.kind === "tool_use");
  const dividerBlocks = blocks.filter((b): b is Extract<ContentBlock, { kind: "divider" }> => b.kind === "divider");

  // Topic dividers are full-width boundaries, not prose bubbles — render (and push-to-top) first.
  for (const d of dividerBlocks) appendTopicDivider(d.label, d.note);

  if (mdBlocks.length) {
    // The model's prose answer is its own clean bubble (separate from the tool churn below).
    const b = ui.streaming ?? bubble("assistant");
    b.innerHTML = "";
    const md = document.createElement("div");
    md.className = "md";
    md.innerHTML = mdBlocks.map((blk) => blk.rendered.html).join("");
    b.appendChild(md);
    const t = timeEl(ts);
    if (t) b.appendChild(t);
    addCopyButtons(md);
    linkifyFilePaths(md); // make plain-text mentions of .md files clickable → open in the reader
    noteAnswerRefs(md.innerHTML); // buffered; only the final answer's links reach the panel (on result)
    void runMermaid(md);
  } else if (ui.streaming) {
    // A tool-only turn: drop the empty streaming draft bubble so it isn't left blank.
    ui.streaming.remove();
  }
  ui.streaming = null;
  streamText = "";
  // Tool calls fold into the consolidated activity block, not inline in the prose.
  for (const b of toolBlocks) appendActivityStep(toolHtml(b));
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

// Markdown files Claude names in prose (e.g. "see docs/plans/design.md") are usually design docs you
// want to open — turn those mentions into the same `.file-link` the tool rows use, so one tap opens
// them in the reader. Limited to .md/.markdown to avoid over-linkifying ordinary words; skips text
// already inside a link or a fenced code block (but inline `path.md` in backticks is fair game).
const MD_PATH_RE = /(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown)(?![\w/-])/gi;
function linkifyFilePaths(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node): number {
      const v = n.nodeValue;
      MD_PATH_RE.lastIndex = 0;
      if (!v || !MD_PATH_RE.test(v)) return NodeFilter.FILTER_REJECT;
      for (let p = n.parentElement; p && p !== root; p = p.parentElement) {
        if (p.tagName === "A" || p.tagName === "PRE") return NodeFilter.FILTER_REJECT; // already a link / code block
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  while (walker.nextNode()) targets.push(walker.currentNode as Text);
  for (const node of targets) {
    const text = node.nodeValue ?? "";
    MD_PATH_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = MD_PATH_RE.exec(text)) !== null) {
      const raw = m[0];
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement("a");
      a.href = "#";
      a.className = "file-link md-file-link";
      a.dataset.path = raw.replace(/^\.\//, ""); // fs.read is worktree-relative
      a.title = `Open ${raw}`;
      a.textContent = raw;
      frag.appendChild(a);
      last = m.index + raw.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
}

// ── Consolidated activity block (§5) ─────────────────────────────────────────────
// All the tool/thinking churn for one turn collapses into a single block that previews the
// last few lines and expands on click — so the conversation reads as "what I said" / "what the
// model said" without every Read/Bash/result on its own line. Reset at each new user turn.
// activityEl / activityCount / activityLive / activityTail are declared in the early-init cluster up
// top — resetActivity() touches them at load.
const ACTIVITY_TAIL = 5;

export function resetActivity(): void {
  finalizeActivity(); // a prior turn that never saw a clean end (no `result`) left a block spinning — stop it
  activityEl = null;
  activityCount = 0;
  activityLive = false;
  activityTail.length = 0;
}
function ensureActivity(): HTMLDetailsElement {
  if (activityEl && activityEl.isConnected) return activityEl;
  dropSessionHero(); // a turn's activity block is appearing — retire the blank-session title card
  const d = document.createElement("details");
  d.className = "activity live";
  d.innerHTML =
    `<summary><span class="activity-row"><span class="activity-ind"><i></i><i></i><i></i></span>` +
    `<span class="activity-title">Working</span><span class="activity-count"></span>` +
    `<span class="msym activity-chevron">expand_more</span></span>` +
    `<div class="activity-tail"></div></summary><div class="activity-full"></div>`;
  conversation.appendChild(d);
  activityEl = d;
  activityLive = true;
  activityTail.length = 0;
  activityCount = 0;
  hideThinking(); // the activity block's spinner is now the running indicator
  return d;
}
function updateActivityHead(): void {
  if (!activityEl) return;
  const title = activityEl.querySelector(".activity-title");
  if (title) title.textContent = activityLive ? "Working" : "Worked";
  const count = activityEl.querySelector(".activity-count");
  if (count) count.textContent = activityCount ? `· ${activityCount} step${activityCount === 1 ? "" : "s"}` : "";
}
/** Append one step to the current activity block. `preview` is a single-line form shown in the
 *  collapsed tail; `full` (defaults to preview) is the rich form shown when expanded. */
function appendActivityStep(preview: string, full = preview): void {
  const d = ensureActivity();
  activityCount++;
  activityTail.push(preview);
  if (activityTail.length > ACTIVITY_TAIL) activityTail.shift();
  const tail = d.querySelector(".activity-tail");
  if (tail) tail.innerHTML = activityTail.join("");
  const body = d.querySelector<HTMLElement>(".activity-full");
  if (body) {
    body.insertAdjacentHTML("beforeend", full);
    const last = body.lastElementChild as HTMLElement | null;
    if (last) addCopyButtons(last);
  }
  updateActivityHead();
  scrollDown();
}
/** Mark the current activity block finished (turn ended): stop the spinner, relabel. */
export function finalizeActivity(): void {
  if (!activityEl) return;
  activityLive = false;
  activityEl.classList.remove("live");
  const ind = activityEl.querySelector(".activity-ind");
  if (ind) ind.innerHTML = icon("check");
  updateActivityHead();
}
export function appendToolResult(content: string, isError: boolean, images: ToolResultImage[] = []): void {
  const text = content.trim();
  const lineCount = text ? text.split("\n").length : 0;
  const shotNote = images.length ? `${images.length} image${images.length === 1 ? "" : "s"}` : "";
  const first = text.split("\n").find((l) => l.trim()) ?? (shotNote || "(no output)");
  const summary = `${icon(isError ? "error" : images.length ? "image" : "check")} ${isError ? "error" : "result"} · ${lineCount} line${lineCount === 1 ? "" : "s"}${shotNote ? ` · ${shotNote}` : ""} · ${esc(first.slice(0, 80))}`;
  const preview = `<div class="tool ${isError ? "result-error" : ""}">${summary}</div>`;
  const full =
    `<details class="tool-result ${isError ? "error" : ""}">` +
    `<summary>${summary}</summary>` +
    `<pre>${esc(text.slice(0, 8000))}${text.length > 8000 ? "\n… (truncated)" : ""}</pre></details>`;
  appendActivityStep(preview, full);
  // Screenshots the tool returned are shown as always-visible thumbnails (not buried inside the
  // collapsed activity block) — the whole point is to SEE them. Each opens full-size on click.
  if (images.length) appendToolShots(images);
}
/** A row of medium thumbnails for the screenshots a tool result carried. Reuses `.att-img` so the
 *  copy/download affordances (hover bar + Android long-press) and the click-to-lightbox handler apply. */
function appendToolShots(images: ToolResultImage[]): void {
  const id = activeId();
  if (!id) return;
  const row = document.createElement("div");
  row.className = "tool-shots";
  for (const im of images) {
    // wireSessionId + owning server: mirror appendUser so a member's namespaced session resolves right.
    const url = serverApiUrl(activeServer().url, `/api/sessions/${wireSessionId(id)}/attachments/${im.attachmentId}`);
    const img = document.createElement("img");
    img.className = "att-img tool-shot";
    img.loading = "lazy";
    img.src = url;
    img.alt = "screenshot";
    row.appendChild(img);
  }
  conversation.appendChild(row);
  scrollDown();
  saveConvoCache();
}
/** Pop an image into its own full-screen view (device/browser Back closes it — it's a modal layer). */
export function openImageLightbox(url: string, name = "image.png"): void {
  const wrap = document.createElement("div");
  wrap.className = "modal shot-modal";
  wrap.innerHTML =
    `<div class="shot-stage">` +
    `<img class="shot-full" src="${esc(url)}" alt="${esc(name)}" />` +
    `<div class="shot-actions">` +
    `<button type="button" class="shot-btn" data-act="download" title="Download">${icon("download")}</button>` +
    `<button type="button" class="shot-btn" data-act="close" title="Close">${icon("close")}</button>` +
    `</div></div>`;
  wrap.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-act="download"]')) {
      void downloadTarget({ host: wrap, url, name, isImage: true });
      return;
    }
    // A click on the image itself keeps the viewer open (so you can right-click / long-press to save);
    // the backdrop or the close button dismisses it.
    if (t.closest(".shot-full")) return;
    closeModal();
  });
  showModal(wrap);
}

// ── Links panel (§links) — the reference MODEL; the panel chrome (renderLinks) lives in panel.ts ──
// Surface only the links/addresses that appear in Claude's ANSWERS — the URLs and server
// addresses it hands you — not the noise from your pasted prompts or the transitional tool/
// thinking churn mid-turn. References are buffered from each assistant message (`pendingAnswerRefs`)
// and only committed to the panel when the turn ends. The header Links button shows a subtle dot
// (no count) while the panel is closed.
// `references` / `pendingAnswerRefs` are declared in the early-init cluster up top — clearReferences()
// reads them at load.
const REF_LIMIT = 50;

/** Pull http(s) URLs and bare host:port addresses out of a chunk of (rendered) text/HTML. */
function extractRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi)) {
    out.push(m[0].replace(/[.,;:!?)\]}'"]+$/, ""));
  }
  for (const m of text.matchAll(/\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3}):\d{2,5}\b/gi)) {
    out.push(`http://${m[0]}`); // bare address → make it openable
  }
  return out;
}
// `ui.replayingSnapshot` (state.ts): true while a full-history snapshot is replaying — assistant
// links are added straight away (all of Claude's past answers are relevant), rather than buffered
// for a turn-end `result` that won't come. Written by main's conversation.snapshot handler.
/** Note the links in one assistant message. Live: buffer them as "this turn's answer" so an earlier
 *  message's links are superseded by the final answer's (only it reaches the panel, on `result`).
 *  Replay: add immediately, since each is a finished historical answer. */
function noteAnswerRefs(text: string): void {
  if (ui.replayingSnapshot) addRefs(extractRefs(text));
  else pendingAnswerRefs = extractRefs(text);
}
/** Turn ended: promote the final answer's buffered links into the panel. */
export function commitAnswerRefs(): void {
  const urls = pendingAnswerRefs;
  pendingAnswerRefs = [];
  addRefs(urls);
}
/** Add `urls` to the reference set (deduped, capped) and refresh the panel/badge if anything's new. */
function addRefs(urls: string[]): void {
  let added = false;
  for (const url of urls) {
    if (references.has(url)) continue;
    references.set(url, url.replace(/^https?:\/\//, ""));
    added = true;
    if (references.size > REF_LIMIT) references.delete(references.keys().next().value as string);
  }
  if (added) {
    updateLinksBadge();
    if (panelView() === "links") renderLinks();
  }
}
function clearReferences(): void {
  references.clear();
  pendingAnswerRefs = [];
  updateLinksBadge();
  if (panelView() === "links") renderLinks();
}
/** Reflect on the header Links button whether there are any links (a subtle dot, no count). */
function updateLinksBadge(): void {
  const btn = document.getElementById("btn-links");
  if (!btn) return;
  const n = references.size;
  btn.classList.toggle("has-links", n > 0);
  btn.title = n > 0 ? `Links (${n})` : "Links";
}

// ── File-offer card (§download) ────────────────────────────────────────────────────
// A deliverable file the model produced, shown as an attachment-style card "from the model",
// with a one-tap download (served by the daemon) and a note when it was also pushed via Taildrop.
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
/** Compact "modified N ago" for the file browser detail column. */
export function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.round(d)}d ago`;
  return new Date(ms).toLocaleDateString();
}
function fileOfferIcon(mime: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "movie";
  if (mime.startsWith("audio/")) return "audio_file";
  if (mime === "application/pdf") return "picture_as_pdf";
  if (/zip|tar|gzip|compressed|x-7z|rar/.test(mime)) return "folder_zip";
  if (/spreadsheet|csv|excel/.test(mime)) return "table_chart";
  return "description";
}
export function appendFileOffer(file: FileOffer): void {
  const b = bubble("assistant");
  b.className = "bubble assistant file-offer";
  const href = serverApiUrl(activeServer().url, file.downloadUrl);
  const taildrop = file.taildropped ? `<span class="fo-taildrop">${icon("send_to_mobile")} Sent to your device</span>` : "";
  b.innerHTML =
    `<div class="fo-card">` +
    `<span class="fo-icon">${icon(fileOfferIcon(file.mime))}</span>` +
    `<span class="fo-meta"><span class="fo-name" title="${esc(file.name)}">${esc(file.name)}</span>` +
    `<span class="fo-sub">${esc(humanSize(file.size))}${taildrop}</span></span>` +
    `<a class="fo-dl" href="${esc(href)}" download="${esc(file.name)}" title="Download">${icon("download")}</a>` +
    `</div>`;
  scrollDown();
  saveConvoCache();
}
// ── Transcript serialization for the durable convo cache (WEB2-6) ────────────────
/**
 * Serialize the rendered transcript for the convo cache, bounded to the last `maxNodes` top-level
 * blocks (bubbles / activity blocks / dividers). Cloning + serializing the ENTIRE pane on every
 * turn cost 30–150ms on long sessions — the cache is an instant-paint snapshot, not an archive, so
 * each save only touches a bounded amount of DOM. The clone is cache-shaped, the live pane is never
 * mutated:
 *   - transient UI (the thinking indicator / empty-state & hero cards) is stripped — it would
 *     re-paint as a frozen "stuck" status on return;
 *   - a still-"live" activity block is frozen to "Worked" — the cache is a snapshot, not a running
 *     turn, and must never restore as an animated "Working" that can't stop (no WS yet on reload).
 */
export function serializeTranscript(maxNodes: number): string {
  const kids = conversation.children;
  const start = Math.max(0, kids.length - maxNodes);
  const clone = document.createElement("div");
  for (let i = start; i < kids.length; i++) clone.appendChild(kids[i]!.cloneNode(true));
  clone.querySelectorAll(".thinking, .empty-state").forEach((e) => e.remove());
  clone.querySelectorAll(".activity.live").forEach((a) => {
    a.classList.remove("live");
    const ind = a.querySelector(".activity-ind");
    if (ind) ind.innerHTML = `<span class="msym">check</span>`;
    const title = a.querySelector(".activity-title");
    if (title) title.textContent = "Worked";
  });
  return clone.innerHTML;
}

export function clearConversation(): void {
  conversation.innerHTML = "";
  ui.streaming = null;
  tailSpacer = null; // detached by the innerHTML reset
  thinkingEl = null; // detached by the innerHTML reset
  ui.turnCanceled = false;
  resetActivity(); // detached by the reset
  clearReferences();
  clearCardMaps(); // cards are detached by the reset; the re-surfaced request re-adds them
  updateComposerMode("idle"); // a freshly cleared pane shows Send, not a stale Stop
}
export function renderEmptyState(): void {
  ui.streaming = null;
  thinkingEl = null;
  resetActivity();
  clearReferences();
  // inlined (not a top-level const) so it's safe to call during early module init
  conversation.innerHTML =
    `<div class="empty-state"><img src="/anvil.svg" class="empty-art" alt="Anvil" width="132" height="132" /><p>Select a session, or create a new one.</p></div>`;
}

// ── Session hero (blank-conversation placeholder) ────────────────────────────────
// A freshly created session has no messages yet. Rather than a void, fill the conversation with a
// big, colour-coded title card — the session's icon, name, environment and branch — so it's always
// unmistakable which session (and project) you're about to talk to. Removed the instant any real
// content lands (see dropSessionHero in the content-append paths).
export function dropSessionHero(): void {
  conversation.querySelector(".session-hero")?.remove();
  clearAttachDiagnostic(); // real content landed — retire any "couldn't load history" note
}
/** Show the hero iff `activeId` is set and the conversation holds nothing but (optionally) the hero. */
export function maybeShowSessionHero(): void {
  if (!activeId()) return;
  const s = sessions.get(activeId()!);
  if (!s) return;
  // Any non-hero child means there's real content (a bubble, activity, card, thinking dots) — no hero.
  if ([...conversation.children].some((c) => !c.classList.contains("session-hero"))) return;
  dropSessionHero(); // avoid stacking duplicates on repeated calls
  const env = s.environmentId ? environments.get(s.environmentId) : undefined;
  const theme = currentTheme();
  const ord = envOrdinal(s, sessions.values());
  const accent = env ? stripeColor(env, ord, theme) : "var(--accent)";
  const bg = env ? sessionBg(env, ord, theme) : "var(--panel)";
  const branch = !s.isDefault ? s.git?.branch : undefined;
  const srv = serverOf(s.id);
  const multi = orderedServers().length > 1;
  const chip = (ic: string, text: string): string => `<span class="hero-chip">${icon(ic)}<span>${esc(text)}</span></span>`;
  const chips = [
    env ? chip("dashboard", env.name) : "",
    branch ? chip("account_tree", branch) : "",
    chip("smart_toy", s.model),
    multi && srv ? chip("dns", srv.name) : "",
  ].join("");
  const hero = document.createElement("div");
  hero.className = "session-hero empty-state"; // empty-state → margin:auto centers it; also stripped from the cache
  hero.style.setProperty("--hero-accent", accent);
  hero.style.setProperty("--hero-bg", bg);
  hero.innerHTML = `<div class="hero-emblem">${icon(sessIcon(s))}</div>
    <h1 class="hero-title">${esc(s.title)}</h1>
    <div class="hero-meta">${chips}</div>
    <p class="hero-hint">${s.pending ? "Queued — will start when you're back online." : "Send a message to get started."}</p>`;
  conversation.appendChild(hero);
}

// ── Attach diagnostic ────────────────────────────────────────────────────────────
// A session can appear in the sidebar (from cache or a peer's list) while the daemon that OWNS it
// isn't reachable/attached from THIS client — most often a fleet member on a phone. The attach then
// goes nowhere and the pane stays blank ("as if it has no chat"). Rather than a silent void, after a
// grace period with no history we surface WHICH server owns it and its live socket state, so the
// failure is legible instead of mysterious. Cleared the moment a snapshot (or any content) lands.
let attachDiagTimer = 0;
export function armAttachDiagnostic(id: string): void {
  clearTimeout(attachDiagTimer);
  attachDiagTimer = window.setTimeout(() => maybeShowAttachDiagnostic(id), 6000);
}
export function clearAttachDiagnostic(): void {
  clearTimeout(attachDiagTimer);
  conversation.querySelector(".attach-diag")?.remove();
}
function maybeShowAttachDiagnostic(id: string): void {
  if (id !== activeId() || snapshotLoaded.has(id)) return; // switched away, or history already arrived
  // Any real content (a bubble/activity/card) means it's working — only the hero/empty may remain.
  if ([...conversation.children].some((c) => !c.classList.contains("session-hero") && !c.classList.contains("empty-state") && !c.classList.contains("attach-diag"))) return;
  const url = sessionServer.get(id);
  const srv = url ? serverByUrl(url) : undefined;
  const status = srv ? srv.status : url ? "unreachable" : "unknown";
  const name = srv?.name ?? (url ? hostOf(url) : "its server");
  const line =
    status === "connected"
      ? `Attached to ${esc(name)} but no history has arrived yet…`
      : `This session lives on ${esc(name)} (${status}). Reconnecting…`;
  conversation.querySelector(".attach-diag")?.remove();
  const el = document.createElement("div");
  el.className = "attach-diag empty-state";
  el.innerHTML = `<p class="small muted">${icon("cloud_off")} ${line}</p><button class="mini" id="attach-diag-retry">${icon("refresh")} Retry</button>`;
  el.querySelector("#attach-diag-retry")?.addEventListener("click", () => {
    ensureOwningServer(id);
    for (const s of servers.values()) s.sock.connectNow();
    clearAttachDiagnostic();
    snapshotLoaded.delete(id);
    sendTo(id, { type: "session.attach", sessionId: id });
    armAttachDiagnostic(id);
  });
  conversation.appendChild(el);
}

// ── Stop the running turn (§stop) ────────────────────────────────────────────────
let stopBtn = $<HTMLButtonElement>("#stop");
/** While a turn is actively running, a subtle Stop appears to the left of Send. Send itself stays
 *  enabled-when-there's-input (it was getting stuck disabled) — you can queue a follow-up either way. */
export function updateComposerMode(status: string): void {
  const busy = status === "thinking" || status === "running_tool";
  stopBtn.hidden = !busy; // Stop shows only while actively thinking/running a tool
}
/** Stop button: interrupt the turn, drop the in-flight thinking/activity, and mark it cancelled —
 *  jumping back to the last prompt with a "Thinking canceled" notice (UI refinement §stop). */
function cancelThinking(): void {
  if (!activeId()) return;
  sendTo(activeId()!, { type: "interrupt", sessionId: activeId()! });
  ui.turnCanceled = true; // suppress the trailing churn the daemon is still draining
  if (streamRaf) {
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
  }
  ui.streaming?.remove(); // drop the partial streaming answer
  ui.streaming = null;
  streamText = "";
  if (activityEl && activityLive) activityEl.remove(); // remove the in-flight activity block
  resetActivity();
  hideThinking();
  pendingAnswerRefs = [];
  const note = document.createElement("div");
  note.className = "turn-canceled";
  note.innerHTML = `${icon("cancel")} Thinking canceled`;
  conversation.appendChild(note);
  setStatus("idle"); // also hides the spinner and restores the Send button
  scrollDown(true);
  saveConvoCache();
}

// ── Copy-to-clipboard ─────────────────────────────────────────────────────────────
/** Copy `text` to the clipboard (with a legacy fallback for non-secure contexts). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
/** Add a one-click copy button to every code block under `root` (commands, snippets, output). */
function addCopyButtons(root: HTMLElement): void {
  for (const pre of root.querySelectorAll<HTMLElement>("pre")) {
    if (pre.parentElement?.classList.contains("code-wrap") || pre.classList.contains("mermaid")) continue;
    const code = pre.textContent ?? "";
    if (!code.trim()) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.title = "Copy";
    btn.innerHTML = icon("content_copy");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void copyText(code).then((ok) => {
        btn.innerHTML = icon(ok ? "check" : "error");
        btn.classList.toggle("copied", ok);
        setTimeout(() => {
          btn.innerHTML = icon("content_copy");
          btn.classList.remove("copied");
        }, 1400);
      });
    });
    // Pin the button to a non-scrolling wrapper, not the <pre> itself: an absolutely-positioned
    // child of the horizontally-scrolling <pre> would drift left as the code scrolls.
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    pre.before(wrap);
    wrap.appendChild(pre);
    wrap.appendChild(btn);
  }
}

// ── Link & attachment actions (copy / download) ───────────────────────────────────
// Every URL link and file attachment in a message gets copy + download affordances.
//   • Desktop / web: a small icon-only bar floats over the target's top-right on hover.
//   • Android: a long-press opens a menu with the same actions (native callout suppressed).
// "Copy" adapts to the target — an image copies its bits, everything else copies the URL.
type ActionTarget = { host: HTMLElement; url: string; name: string; isImage: boolean };

/** Best-effort filename from a URL path (falls back to a generic name). */
function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last && /\.[a-z0-9]{1,8}$/i.test(last)) return decodeURIComponent(last);
  } catch {
    /* not a parseable URL — use the fallback */
  }
  return fallback;
}

/** Resolve the copy/download target for an event target, walking up to a link or attachment. */
function actionTargetFor(el: EventTarget | null): ActionTarget | null {
  const start = el instanceof HTMLElement ? el : null;
  if (!start) return null;
  const img = start.closest<HTMLImageElement>("#conversation .att-img");
  if (img) return { host: img, url: img.src, name: fileNameFromUrl(img.src, "image.png"), isImage: true };
  const chip = start.closest<HTMLAnchorElement>("#conversation a.att-file");
  if (chip) {
    const name = chip.querySelector(".att-name")?.textContent?.trim() || fileNameFromUrl(chip.href, "file");
    return { host: chip, url: chip.href, name, isImage: false };
  }
  // A plain URL link in message prose (skip in-app file links, which open the reader, not a URL).
  const a = start.closest<HTMLAnchorElement>("#conversation .md a[href]");
  if (a && !a.classList.contains("file-link") && /^https?:/i.test(a.href)) {
    return { host: a, url: a.href, name: fileNameFromUrl(a.href, "download"), isImage: false };
  }
  return null;
}

/** Re-encode any image blob to PNG (the format the async clipboard reliably accepts) via a canvas. */
function blobToPng(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const obj = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas");
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return (URL.revokeObjectURL(obj), reject(new Error("no 2d context")));
      ctx.drawImage(im, 0, 0);
      c.toBlob((b) => {
        URL.revokeObjectURL(obj);
        b ? resolve(b) : reject(new Error("toBlob failed"));
      }, "image/png");
    };
    im.onerror = () => (URL.revokeObjectURL(obj), reject(new Error("image decode failed")));
    im.src = obj;
  });
}

/** Copy an image's actual bits to the clipboard (PNG). Returns false if the platform can't. */
async function copyImageFromUrl(url: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
    const blob = await (await fetch(url)).blob();
    const png = blob.type === "image/png" ? blob : await blobToPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

/** The "copy" action: image → its bits (falling back to the URL); anything else → the URL. */
async function copyTarget(t: ActionTarget): Promise<boolean> {
  if (t.isImage && (await copyImageFromUrl(t.url))) return true;
  return copyText(t.url);
}

/** Save a URL to a file. Fetch→blob keeps same-origin attachments as true downloads; on a
 *  cross-origin failure, fall back to opening it (the browser may still offer to save). */
async function downloadTarget(t: ActionTarget): Promise<boolean> {
  try {
    const res = await fetch(t.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const obj = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = obj;
    a.download = t.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(obj), 4000);
    return true;
  } catch {
    window.open(t.url, "_blank", "noopener");
    return false;
  }
}

// ── Desktop / web: floating icon bar on hover ──
// The element is created detached at module eval (TDZ-safe for the functions below); it's
// configured, attached to <body>, and wired via initConversation — main's original wiring time.
const linkActions = document.createElement("div");
let laTarget: ActionTarget | null = null;
let laHideTimer = 0;

function positionLinkActions(t: ActionTarget): void {
  const r = t.host.getBoundingClientRect();
  linkActions.hidden = false;
  const w = linkActions.offsetWidth;
  linkActions.style.top = `${Math.max(4, r.top + 4)}px`;
  linkActions.style.left = `${Math.min(window.innerWidth - w - 4, Math.max(4, r.right - w - 4))}px`;
  (linkActions.querySelector('.la-btn[data-act="copy"]') as HTMLElement).title = t.isImage ? "Copy image" : "Copy link";
}
function showLinkActions(t: ActionTarget): void {
  clearTimeout(laHideTimer);
  if (laTarget?.host === t.host && !linkActions.hidden) return; // already up for this target
  laTarget = t;
  positionLinkActions(t);
}
function hideLinkActions(): void {
  linkActions.hidden = true;
  laTarget = null;
}
function scheduleHideLinkActions(): void {
  clearTimeout(laHideTimer);
  laHideTimer = window.setTimeout(hideLinkActions, 160);
}

function flashActionBtn(btn: HTMLElement, done: Promise<boolean>, restore: string): void {
  void done.then((ok) => {
    btn.innerHTML = icon(ok ? "check" : "error");
    btn.classList.toggle("done", ok);
    setTimeout(() => {
      btn.innerHTML = icon(restore);
      btn.classList.remove("done");
    }, 1400);
  });
}

function wireLinkActions(): void {
  linkActions.id = "link-actions";
  linkActions.hidden = true;
  linkActions.innerHTML =
    `<button type="button" class="la-btn" data-act="copy">${icon("content_copy")}</button>` +
    `<button type="button" class="la-btn" data-act="download" title="Download">${icon("download")}</button>`;
  document.body.appendChild(linkActions);

  conversation.addEventListener("mouseover", (e) => {
    if (isAndroidApp) return; // Android uses long-press, not hover
    const t = actionTargetFor(e.target);
    if (t) showLinkActions(t);
  });
  conversation.addEventListener("mouseout", (e) => {
    if (isAndroidApp) return;
    const to = e.relatedTarget;
    if (to instanceof HTMLElement && (to.closest("#link-actions") || actionTargetFor(to)?.host === laTarget?.host)) return;
    scheduleHideLinkActions();
  });
  linkActions.addEventListener("mouseenter", () => clearTimeout(laHideTimer));
  linkActions.addEventListener("mouseleave", scheduleHideLinkActions);
  linkActions.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".la-btn");
    if (!btn || !laTarget) return;
    e.preventDefault();
    e.stopPropagation();
    const t = laTarget;
    if (btn.dataset.act === "download") flashActionBtn(btn, downloadTarget(t), "download");
    else flashActionBtn(btn, copyTarget(t), "content_copy");
  });
}

// ── Android: long-press action menu ──
// Same pattern as the hover bar: created detached at module eval, attached + wired via init.
const linkMenu = document.createElement("div");
let menuTarget: ActionTarget | null = null;

function hideLinkMenu(): void {
  linkMenu.hidden = true;
  menuTarget = null;
}
function openLinkMenu(t: ActionTarget, x: number, y: number): void {
  menuTarget = t;
  linkMenu.innerHTML =
    `<button type="button" class="lm-item" data-act="copy">${icon("content_copy")}<span>${t.isImage ? "Copy image" : "Copy link"}</span></button>` +
    `<button type="button" class="lm-item" data-act="download">${icon("download")}<span>Download</span></button>`;
  linkMenu.hidden = false;
  const w = linkMenu.offsetWidth;
  const h = linkMenu.offsetHeight;
  linkMenu.style.left = `${Math.min(Math.max(8, x), window.innerWidth - w - 8)}px`;
  linkMenu.style.top = `${Math.min(Math.max(8, y), window.innerHeight - h - 8)}px`;
}

let pressTimer = 0;
let pressTarget: ActionTarget | null = null;
let pressX = 0;
let pressY = 0;

function wireLinkMenu(): void {
  linkMenu.id = "link-menu";
  linkMenu.hidden = true;
  document.body.appendChild(linkMenu);

  linkMenu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".lm-item");
    if (!item || !menuTarget) return;
    const t = menuTarget;
    const act = item.dataset.act;
    hideLinkMenu();
    if (act === "download") void downloadTarget(t).then((ok) => toast(ok ? "Downloading…" : "Opened in a new tab"));
    else void copyTarget(t).then((ok) => toast(ok ? (t.isImage ? "Image copied" : "Link copied") : "Couldn't copy"));
  });

  conversation.addEventListener(
    "touchstart",
    (e) => {
      const touch = e.touches[0];
      if (!isAndroidApp || e.touches.length !== 1 || !touch) return;
      const t = actionTargetFor(e.target);
      if (!t) return;
      pressTarget = t;
      pressX = touch.clientX;
      pressY = touch.clientY;
      clearTimeout(pressTimer);
      pressTimer = window.setTimeout(() => {
        if (pressTarget) openLinkMenu(pressTarget, pressX, pressY);
      }, 500);
    },
    { passive: true },
  );
  conversation.addEventListener(
    "touchmove",
    (e) => {
      const touch = e.touches[0];
      if (!pressTarget || !touch) return;
      if (Math.abs(touch.clientX - pressX) > 10 || Math.abs(touch.clientY - pressY) > 10) {
        clearTimeout(pressTimer);
        pressTarget = null;
      }
    },
    { passive: true },
  );
  conversation.addEventListener("touchend", () => {
    clearTimeout(pressTimer);
    pressTarget = null;
  });
  // A long-press we've claimed shouldn't also raise the WebView's native link/image menu.
  conversation.addEventListener("contextmenu", (e) => {
    if (isAndroidApp && actionTargetFor(e.target)) e.preventDefault();
  });
  // Tap elsewhere dismisses the menu; scrolling dismisses both floating layers.
  document.addEventListener(
    "touchstart",
    (e) => {
      if (!linkMenu.hidden && !(e.target as HTMLElement).closest("#link-menu")) hideLinkMenu();
    },
    { capture: true },
  );
  conversation.addEventListener("scroll", () => {
    hideLinkActions();
    hideLinkMenu();
  });
}

// ── Mermaid (lazy) ──────────────────────────────────────────────────────────────
let mermaidReady: Promise<any> | null = null;
export async function runMermaid(container: HTMLElement): Promise<void> {
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
