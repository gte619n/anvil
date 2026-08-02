// ── Composer: the input box, send path, drafts/history, `/` menu, attachments, quote ─────────────
// Extracted verbatim from main.ts (P7 god-file decomposition). The seams here:
//   1. The composer proper: the textarea, auto-grow, the Send enable state, and the send path
//      (online prompt.send vs the offline/pending outbox enqueue + optimistic bubble).
//   2. Per-session drafts (unsent text follows its session across switches/reloads).
//   3. Sent-prompt history (ArrowUp / ArrowDown recall in a blank composer).
//   4. The `/` slash-command autocomplete (skills/commands from `session.commands`).
//   5. Attachment staging: the picker/paste/drag-drop upload flow + the chip row.
//   6. Select-to-quote (highlight message text → quote into the composer) and the copy hook that
//      strips select-to-cite `data-line` anchors from copied markdown.
//
// This module evaluates BEFORE main.ts's body (main imports it), so the composer-owned module
// state (the #input element ref, `pendingAttachments`, the slash-menu element/state) initializes at
// module eval, before any main entry point can reach it (declare-up-top rule — see memory:
// web-early-init-decl-order-crash). Top-level DOM side effects (appending the slash menu / quote
// button, listener wiring, the boot-time `restoreDraft(activeId)`) do NOT run at import time: they
// run via initComposer(deps), which main.ts calls at the original composer wiring point in its
// module init — after its state/outbox/init chain, before any socket can deliver an event.
//
// main.ts ↔ composer.ts wiring: composer.ts never imports from main.ts. Everything composer code
// needs from main (the merged session map, the reassigned `activeId`/`readerPath` scalars as lazy
// reads, `activeServer`, the outbox `enqueue`, `toast`) is injected once via initComposer(deps) —
// mirroring fleet/sidebar/conversation/autopilot/settings. main keeps importing `input`/`saveDraft`/
// `restoreDraft`/`autoGrow`/`updateSendState` for the session-switch draft stash, the prompt-library
// insert, and the Escape blur. The outbox flush/reconcile orchestration stays in main (it touches
// sockets, routing, and session state); the composer only calls the injected `enqueue`.
import { $, esc } from "./dom";
// dialogs.ts is a leaf, so toast is a direct import — it used to arrive via initComposer(deps).
import { toast } from "./dialogs";
import { newCid, type OutboxItem } from "./outbox";
import { sendTo, serverOf, serverFetch, type Server } from "./fleet";
import { appendOptimisticUser } from "./conversation";
import { isDaemonHandledCommand } from "./sendReconcile";
import type { AttachmentRef, CommandInfo, Session } from "../../protocol";

// ── Injected dependencies (initComposer) ─────────────────────────────────────────────────────────
// What composer code calls back into main.ts for. Each field documents the main.ts state it reaches.
export interface ComposerDeps {
  /** The merged session list (main owns it — `pending` gating + the active session's commands). */
  sessions: Map<string, Session>;
  /** The currently-open session's id (main's `activeId` — a reassigned scalar, so it's injected as
   *  a getter; the moved code only dereferences it at call time). */
  activeId(): string | null;
  /** The server that owns the currently-open session (main's `activeServer` — attachment uploads). */
  activeServer(): Server;
  /** Queue a write into main's outbox (badge + flush kick stay in main with the flush machinery). */
  enqueue(item: OutboxItem): void;
  /** The side-panel reader's open file (main's `readerPath` — a reassigned scalar, read at call
   *  time; select-to-quote prefixes a reader quote with its path). */
  readerPath(): string;
}
// Module-local mirrors of the injected deps, named exactly as in main.ts so the moved code below
// stays verbatim (main's reassigned `activeId`/`readerPath` scalars become the calls `activeId()`/
// `readerPath()`). Assigned once by initComposer — which main.ts calls during its module init, at
// the original composer wiring point — so no composer entry point can observe them unset.
let sessions: ComposerDeps["sessions"];
let activeId: ComposerDeps["activeId"];
let activeServer: ComposerDeps["activeServer"];
let enqueue: ComposerDeps["enqueue"];
let readerPath: ComposerDeps["readerPath"];
export function initComposer(deps: ComposerDeps): void {
  ({ sessions, activeId, activeServer, enqueue, readerPath } = deps);
  wireComposerDom();
}

// ── Composer ───────────────────────────────────────────────────────────────────
export const input = $<HTMLTextAreaElement>("#input");
// `dataUrl` is set only for images (the chip thumbnail); other files show an icon + name chip.
const pendingAttachments: { id: string; name: string; kind: "image" | "file"; dataUrl?: string }[] = [];
const attachRow = $("#attach-row");

// `/` autocomplete state — declared here (before the first `restoreDraft` runs) so the hoisted menu
// functions below have their backing element/state initialized. Logic lives further down. The menu
// element is attached to #input-box in wireComposerDom (main's original wiring time).
const slashMenu = document.createElement("div");
slashMenu.id = "slash-menu";
slashMenu.hidden = true;
let slashItems: CommandInfo[] = [];
let slashIdx = 0;

// ── Per-session composer drafts ──────────────────────────────────────────────────
// Unsent text belongs to the session it was typed in, not the box. Switching sessions stashes the
// current draft under the outgoing session and restores the incoming one's (usually blank), so a
// half-written message for one session never bleeds into another. Persisted per session so a draft
// also survives a reload / app restart.
const draftKey = (id: string): string => `anvil.draft.${id}`;
export function saveDraft(id: string | null, text: string): void {
  if (!id) return;
  try {
    if (text.trim()) localStorage.setItem(draftKey(id), text);
    else localStorage.removeItem(draftKey(id));
  } catch {
    /* quota */
  }
}
function loadDraft(id: string | null): string {
  if (!id) return "";
  try {
    return localStorage.getItem(draftKey(id)) ?? "";
  } catch {
    return "";
  }
}
// ── Sent-prompt history (ArrowUp / ArrowDown recall in a blank composer) ──────────
// Keep the last few sent prompts per session so ArrowUp cycles back through them (ArrowDown
// forward) — handy after stopping a run to re-edit and resend. Persisted like drafts so it
// survives a reload. Newest first; capped so the list can't grow unbounded.
const HISTORY_LIMIT = 10;
const historyKey = (id: string): string => `anvil.history.${id}`;
function loadHistory(id: string | null): string[] {
  if (!id) return [];
  try {
    const arr: unknown = JSON.parse(localStorage.getItem(historyKey(id)) ?? "[]");
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function pushHistory(id: string | null, text: string): void {
  if (!id || !text.trim()) return;
  // Drop any prior identical entry so repeats don't stack up, then prepend as newest.
  const hist = [text, ...loadHistory(id).filter((t) => t !== text)].slice(0, HISTORY_LIMIT);
  try {
    localStorage.setItem(historyKey(id), JSON.stringify(hist));
  } catch {
    /* quota */
  }
}
// Cursor into the recall list: -1 means "composing fresh text, not navigating history".
// `historyStash` holds that fresh text so ArrowUp-then-back-down-past-newest restores it.
let historyIdx = -1;
let historyStash = "";

/** Put `id`'s saved draft into the composer (or clear it), and resize/enable Send to match. */
export function restoreDraft(id: string | null): void {
  input.value = loadDraft(id);
  historyIdx = -1; // a fresh composer context — start recall from the top again
  closeSlashMenu(); // don't carry one session's open `/` menu into another
  autoGrow();
  updateSendState();
}

// Uploads are async (read file → POST → push to pendingAttachments). If the user sends text
// before an upload lands, the attachment id wouldn't be in pendingAttachments yet and the
// file would be silently dropped. Track in-flight uploads so send() can wait for them.
let uploadsInFlight = 0;
const uploadWaiters: Array<() => void> = [];
function uploadsSettled(): Promise<void> {
  return uploadsInFlight === 0 ? Promise.resolve() : new Promise((resolve) => uploadWaiters.push(resolve));
}

async function sendComposer(): Promise<void> {
  // Never send ahead of a file that's still uploading — wait for it to land first.
  if (uploadsInFlight > 0) {
    toast("Finishing upload…");
    await uploadsSettled();
  }
  const text = input.value;
  if (!activeId() || (!text.trim() && pendingAttachments.length === 0)) return;
  const s = sessions.get(activeId()!);
  // Every send carries a stable cid (v4 exactly-once, spec A5/A6): online it lets the daemon dedupe a
  // retry and lets us match the authoritative echo to any optimistic bubble; offline it's the outbox
  // idempotency key the server dedupes on flush.
  const cid = newCid();
  if (serverOf(activeId())?.sock.isOpen() && !s?.pending) {
    sendTo(activeId(), { type: "prompt.send", sessionId: activeId()!, text, attachmentIds: pendingAttachments.map((a) => a.id), cid });
  } else {
    // offline, or a session that itself hasn't been created yet → queue it.
    if (pendingAttachments.length) toast("Attachments need a connection — sent text only");
    enqueue({ cid, cmd: { type: "prompt.send", sessionId: activeId()!, text } });
    // Only show an optimistic bubble for an ORDINARY prompt. Daemon-handled commands (/clear, /compact,
    // /goal) emit no message.user, so an optimistic bubble would never be retired — an eternal orphan.
    // They also produce no user bubble online, so skipping it is the consistent behaviour.
    if (!isDaemonHandledCommand(text)) appendOptimisticUser(text, cid);
  }
  saveDraft(activeId(), ""); // the draft was just sent — drop the stored copy
  pushHistory(activeId(), text); // remember it for ArrowUp/ArrowDown recall
  historyIdx = -1; // back to composing fresh text
  input.value = "";
  pendingAttachments.length = 0;
  renderAttachRow();
  autoGrow();
  updateSendState();
}
/** Drop `text` into the composer as a recalled history entry, caret at the end. */
function applyRecall(text: string): void {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  autoGrow();
  updateSendState();
}
export function autoGrow(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}
export function updateSendState(): void {
  $<HTMLButtonElement>("#send").disabled = !input.value.trim() && pendingAttachments.length === 0;
}

// ── `/` slash-command autocomplete ────────────────────────────────────────────────
// Typing "/" at the very start of the composer pops a menu of the active session's skills/commands
// (built-in + the user's & project's `.claude/skills`, reported by the daemon on `session.commands`).
// Picking one drops the invocable "/name " into the box; sending it triggers the skill. The menu only
// arms while the text is a single "/token" (no space yet) — once you type an argument it gets out of
// the way, and Enter/Arrows fall back to their normal send/history behaviour.
// (The menu element + `slashItems`/`slashIdx` state are declared up in the composer setup so the
// first `restoreDraft` at load already has them ready.)
const slashOpen = (): boolean => !slashMenu.hidden;

/** The commands published for the active session, or [] before its first turn. */
function activeCommands(): CommandInfo[] {
  return (activeId() && sessions.get(activeId()!)?.commands) || [];
}

/** The "/token" the user is typing, or null when the menu shouldn't be armed (no leading "/", or a
 *  space has been typed so we're now into arguments). */
function slashToken(): string | null {
  const v = input.value;
  if (!v.startsWith("/")) return null;
  const rest = v.slice(1);
  return /\s/.test(rest) ? null : rest;
}

function closeSlashMenu(): void {
  slashMenu.hidden = true;
  slashMenu.replaceChildren();
}

/** Recompute the menu from the current composer text (called on every input). */
function updateSlashMenu(): void {
  const token = slashToken();
  if (token === null) {
    closeSlashMenu();
    return;
  }
  const q = token.toLowerCase();
  const all = activeCommands();
  // Prefix matches first (what you'd expect while typing), then any substring hit.
  slashItems = [
    ...all.filter((c) => c.name.toLowerCase().startsWith(q)),
    ...all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)),
  ].slice(0, 50);
  if (!slashItems.length) {
    closeSlashMenu();
    return;
  }
  slashIdx = Math.min(slashIdx, slashItems.length - 1);
  renderSlashMenu();
}

function renderSlashMenu(): void {
  slashMenu.replaceChildren();
  slashItems.forEach((c, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "slash-item" + (i === slashIdx ? " sel" : "");
    row.innerHTML =
      `<span class="slash-name">/${esc(c.name)}</span>` +
      (c.source !== "builtin" ? `<span class="slash-src">${esc(c.source)}</span>` : "") +
      (c.description ? `<span class="slash-desc">${esc(c.description)}</span>` : "");
    // mousedown (not click) so the textarea never loses focus / selection before we act.
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptSlash(i);
    });
    slashMenu.appendChild(row);
  });
  slashMenu.hidden = false;
  slashMenu.querySelector(".slash-item.sel")?.scrollIntoView({ block: "nearest" });
}

function moveSlash(delta: number): void {
  slashIdx = (slashIdx + delta + slashItems.length) % slashItems.length;
  renderSlashMenu();
}

/** Insert the chosen command as "/name " and close the menu. */
function acceptSlash(i: number): void {
  const c = slashItems[i];
  if (!c) return;
  input.value = `/${c.name} `;
  closeSlashMenu();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  saveDraft(activeId(), input.value);
  autoGrow();
  updateSendState();
}

// attach button → file picker (wired in wireComposerDom)
const fileInput = $<HTMLInputElement>("#file-input");

/** Upload every selected file (images, PDFs, code, logs, …); the daemon decides how to feed each
 *  to the model. We don't gate on MIME type here — Android's picker frequently hands back an empty
 *  `File.type` even for images, which is exactly what used to silently drop attachments. */
function attachFiles(files: File[]): void {
  for (const f of files) void uploadAttachment(f);
}

function renderAttachRow(): void {
  attachRow.innerHTML = "";
  pendingAttachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = a.kind === "image" ? "attach-chip" : "attach-chip file";
    const inner =
      a.kind === "image" && a.dataUrl
        ? `<img src="${a.dataUrl}" alt="${esc(a.name)}" />`
        : `<span class="msym">description</span><span class="att-name" title="${esc(a.name)}">${esc(a.name)}</span>`;
    chip.innerHTML = `${inner}<button type="button" class="rm" title="Remove">×</button>`;
    chip.querySelector(".rm")!.addEventListener("click", () => {
      pendingAttachments.splice(i, 1);
      renderAttachRow();
    });
    attachRow.appendChild(chip);
  });
  updateSendState();
}
async function uploadAttachment(file: File): Promise<void> {
  if (!activeId()) {
    toast("Open a session first");
    return;
  }
  uploadsInFlight++;
  updateSendState();
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const base64 = dataUrl.split(",")[1] ?? "";
    const res = await serverFetch(activeServer().url, `/api/sessions/${activeId()}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // mediaType may be empty (Android picker) — the daemon infers it from the filename.
      body: JSON.stringify({ name: file.name || "attachment", mediaType: file.type || "", dataBase64: base64 }),
    });
    if (!res.ok) {
      toast("Upload failed");
      return;
    }
    const { attachment } = (await res.json()) as { attachment: AttachmentRef };
    pendingAttachments.push({
      id: attachment.id,
      name: attachment.name,
      kind: attachment.kind,
      dataUrl: attachment.kind === "image" ? dataUrl : undefined,
    });
    renderAttachRow();
  } catch {
    toast("Upload failed");
  } finally {
    uploadsInFlight--;
    if (uploadsInFlight === 0) for (const resolve of uploadWaiters.splice(0)) resolve();
    updateSendState();
  }
}
const composerEl = $("#composer");

// ── Select-to-quote (highlight any message text → quote into the composer) ─────────
// The button element is created here (module eval) and attached to <body> + wired in
// wireComposerDom (main's original wiring time).
const quoteBtn = document.createElement("button");
quoteBtn.id = "quote-btn";
quoteBtn.textContent = "❝ Quote";
quoteBtn.style.display = "none";
function selectionEl(): Element | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) return null;
  const node = sel.anchorNode;
  const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
  return el?.closest("#conversation, #panel-content") ?? null;
}
// [WEB2-5] selectionchange fires rapidly during a drag; each handler did a layout read
// (getBoundingClientRect) immediately followed by a style write — a forced synchronous reflow per event.
// Coalesce to one read+write per animation frame.
let selectionRaf = 0;
function positionQuoteButton(): void {
  selectionRaf = 0;
  const el = selectionEl();
  if (!el) {
    quoteBtn.style.display = "none";
    return;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    quoteBtn.style.display = "none";
    return;
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  quoteBtn.style.display = "block";
  quoteBtn.style.top = `${window.scrollY + rect.top - 36}px`;
  quoteBtn.style.left = `${window.scrollX + rect.left}px`;
}

// ── Top-level DOM wiring (runs via initComposer, at main's original wiring time) ─────────────────
function wireComposerDom(): void {
  $("#input-box").appendChild(slashMenu);

  restoreDraft(activeId()); // on load, bring back the active session's own unsent draft (if any)

  $<HTMLFormElement>("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    void sendComposer();
  });
  input.addEventListener("keydown", (e) => {
    // While the `/` menu is open it owns the navigation keys — intercept before send/history below.
    if (slashOpen()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSlash(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSlash(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptSlash(slashIdx);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlashMenu();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $<HTMLFormElement>("#composer").requestSubmit();
      return;
    }
    // ArrowUp/ArrowDown cycle through recently sent prompts so one can be re-edited and resent.
    // We only start recall from a blank box, so it never steals cursor navigation from a draft;
    // once navigating, the arrows keep stepping through history until you edit or reach the bottom.
    if (e.key === "ArrowUp" && (historyIdx >= 0 || !input.value)) {
      const hist = loadHistory(activeId());
      if (!hist.length) return;
      if (historyIdx < 0) historyStash = input.value; // stash the fresh (blank) text to return to
      if (historyIdx >= hist.length - 1) return; // already at the oldest — nothing older to show
      e.preventDefault();
      historyIdx += 1;
      applyRecall(hist[historyIdx]!);
      return;
    }
    if (e.key === "ArrowDown" && historyIdx >= 0) {
      const hist = loadHistory(activeId());
      e.preventDefault();
      historyIdx -= 1;
      applyRecall(historyIdx < 0 ? historyStash : (hist[historyIdx] ?? ""));
      return;
    }
  });
  input.addEventListener("input", () => {
    historyIdx = -1; // a manual edit leaves history navigation — next ArrowUp starts fresh
    autoGrow();
    updateSendState();
    updateSlashMenu();
  });
  // Close the menu when focus leaves the box (deferred so a row's mousedown still lands first).
  input.addEventListener("blur", () => setTimeout(closeSlashMenu, 100));

  // attach button → file picker
  $("#btn-attach").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    attachFiles(Array.from(fileInput.files ?? []));
    fileInput.value = "";
  });
  input.addEventListener("paste", (e) => {
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      // Only file items (a pasted image or file) — `kind === "string"` is the normal text paste.
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) {
          e.preventDefault();
          void uploadAttachment(f);
        }
      }
    }
  });
  composerEl.addEventListener("dragover", (e) => e.preventDefault());
  composerEl.addEventListener("drop", (e) => {
    e.preventDefault();
    attachFiles(Array.from((e as DragEvent).dataTransfer?.files ?? []));
  });

  // Select-to-quote (highlight any message text → quote into the composer)
  document.body.appendChild(quoteBtn);
  document.addEventListener("selectionchange", () => {
    if (selectionRaf || typeof requestAnimationFrame === "undefined") {
      if (typeof requestAnimationFrame === "undefined") positionQuoteButton();
      return;
    }
    selectionRaf = requestAnimationFrame(positionQuoteButton);
  });
  quoteBtn.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keep the selection alive through the click
    const el = selectionEl();
    const text = window.getSelection()?.toString().trim() ?? "";
    if (!el || !text) return;
    const fromReader = el.closest("#panel-content") && readerPath();
    const prefix = fromReader ? `> from \`${readerPath()}\`:\n` : "";
    const quoted = prefix + text.split("\n").map((l) => `> ${l}`).join("\n");
    input.value = input.value ? `${quoted}\n\n${input.value}` : `${quoted}\n\n`;
    input.focus();
    quoteBtn.style.display = "none";
    window.getSelection()?.removeAllRanges();
  });

  // ── Strip select-to-cite anchors from copied markdown ──────────────────────────────
  // Every rendered block carries a `data-line="start,end"` attribute — the select-to-cite hook,
  // read from the *live* DOM by the native clients. It must never ride along on the clipboard:
  // the browser's text/html flavor otherwise leaks a stray id on each block/line into paste
  // targets. When a copy originates in a markdown surface, rewrite the clipboard from a cleaned
  // clone (plain text is already anchor-free; we set it too so both flavors stay in sync).
  document.addEventListener("copy", (e) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !selectionEl()) return;
    const cd = (e as ClipboardEvent).clipboardData;
    if (!cd) return;
    const wrap = document.createElement("div");
    wrap.appendChild(sel.getRangeAt(0).cloneContents());
    wrap.querySelectorAll("[data-line]").forEach((n) => n.removeAttribute("data-line"));
    cd.setData("text/plain", sel.toString());
    cd.setData("text/html", wrap.innerHTML);
    e.preventDefault();
  });
}
