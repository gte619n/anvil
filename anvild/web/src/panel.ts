// ── Side panel: files + reader + terminal + git + links chrome ───────────────────────────────────
// Extracted verbatim from main.ts (P7 god-file decomposition). The whole side-panel seam lives
// here: the panel chrome (open/close/tabs), the file browser + drag-drop upload, the reader view
// (incl. the pop-out window and the Android full-screen overlay), the embedded XTerm terminal, the
// Git panel (status line, staged Claude actions, reset/cleanup/abandon), and the links-panel chrome
// (renderLinks — the links MODEL stays in conversation.ts, which receives renderLinks as its
// injected dep).
//
// This module evaluates BEFORE main.ts's body (main imports it), so the panel-owned scalars below
// (`panelView`/`readerPath`/`xterm`, the historical early-init set) are initialized by the time
// main's instant-restore init chain runs (see memory: web-early-init-decl-order-crash). The moved
// top-level DOM wiring (panel buttons, the in-conversation file-link listener) runs via
// initPanel(...), called from main at the original side-panel wiring point in its module init; the
// click-outside-closes-panel listener runs via wirePanelOutsideDismiss(), called from main at ITS
// original registration point (after the menu-dismiss pointerdown — the order is load-bearing, see
// the note on the function).
//
// main.ts ↔ panel.ts wiring: panel.ts never imports from main.ts. Everything panel code needs from
// main (the active session, the session-kill lifecycle) is injected once via
// initPanel(deps). Session lifecycle (killSession/purgeSessionLocally) stays in main — it reassigns
// main's `activeId` and touches the persistence/caches — and is reached via the injected
// `killSession`. `panelView`/`readerPath`/`xterm` are exported live bindings: panel.ts is their
// sole writer, main (the WS event router) only reads them.
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { sendTo, serverApiUrl, serverFetch, type Server } from "./fleet";
import { $, esc, icon, linkifyUrls } from "./dom";
// dialogs.ts is a leaf, so the modal/toast helpers are direct imports — they used to arrive via
// initPanel(deps).
import { closeModal, confirmDialog, showModal, toast } from "./dialogs";
import { currentTheme } from "./theme";
import { dismissOverlay, openOverlay, overlayOpen } from "./overlays";
import { isAndroidApp } from "./platform";
import { conversation, copyText, humanSize, references, relTime, runMermaid } from "./conversation";
import type { DirEntry, FileContent, GitResultEvent, GitStatus, Session } from "../../protocol";

const strToB64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

// ── Injected dependencies (initPanel) ────────────────────────────────────────────────────────────
// What panel code calls back into main.ts for. Each field documents the main.ts state it reaches.
export interface PanelDeps {
  /** The open session (main's `activeId` — a reassigned scalar, read at call time). */
  activeId(): string | null;
  /** The server that owns the currently-open session (main's `activeServer`). */
  activeServer(): Server;
  /** The merged session list (main owns it; the git panel reads status off it). */
  sessions: Map<string, Session>;
  /** Kill a session (main's `killSession` — session lifecycle: it reassigns main's `activeId`,
   *  drops caches/drafts, and watches the kill's cid reply for the disowned-ghost eviction). */
  killSession(id: string): void;
}
// Module-local mirrors of the injected deps, named as in main.ts so the moved code below stays
// verbatim (main's reassigned `activeId` scalar becomes the call `activeId()`). Assigned once by
// initPanel — which main.ts calls during its module init, before any socket exists — so no panel
// entry point can observe them unset.
let activeId: PanelDeps["activeId"];
let activeServer: PanelDeps["activeServer"];
let sessions: PanelDeps["sessions"];
let killSession: PanelDeps["killSession"];
export function initPanel(deps: PanelDeps): void {
  ({ activeId, activeServer, sessions, killSession } = deps);

  // ── Moved top-level DOM wiring (runs at main's original side-panel wiring point) ──
  // file links in the conversation (Read/Edit/… tool calls) open the reader
  conversation.addEventListener("click", (e) => {
    const link = (e.target as HTMLElement).closest(".file-link") as HTMLElement | null;
    if (!link) return;
    e.preventDefault();
    const path = link.dataset.path;
    if (path && activeId()) openFile(path);
  });

  $("#btn-files").addEventListener("click", () => (panelView === "files" || panelView === "reader" ? closePanel() : openPanel("files")));
  $("#btn-git").addEventListener("click", () => (panelView === "git" ? closePanel() : openPanel("git")));
  $("#btn-terminal").addEventListener("click", () => (panelView === "terminal" ? closePanel() : openPanel("terminal")));
  $("#btn-links").addEventListener("click", () => (panelView === "links" ? closePanel() : openPanel("links")));
  $("#panel-close").addEventListener("click", closePanel);
  document.querySelectorAll<HTMLElement>(".ptab").forEach((t) => t.addEventListener("click", () => openPanel(t.dataset.view as "files" | "reader" | "git" | "terminal" | "links")));
}

// Click anywhere off the open side panel to dismiss it. The header toggles, in-conversation
// file links, and the floating quote button legitimately drive/feed the panel, so they're
// excluded (they manage their own open/close). Modals/dialogs and the settings view are layers
// ABOVE the panel — a pointerdown there must NOT close the panel, because closePanel()
// (dismissOverlay) unwinds every overlay above the panel too, which would tear down the open
// dialog mid-click and swallow its button press (this is what made Cleanup/Abandon/Reset, all of
// which confirm in a dialog over the git panel, silently do nothing). Pointerdown beats those
// handlers' click.
//
// NOT wired in initPanel: main calls this at the listener's original registration point, AFTER its
// own click-outside-closes-menu pointerdown. That relative order is load-bearing — dismissOverlay
// pops the overlay stack synchronously, so with a menu open above an open panel, the menu listener
// (running first) closes the menu and this one, seeing overlayOpen("menu") now false, then closes
// the panel too — one outside click unwinds both, exactly as before the extraction.
export function wirePanelOutsideDismiss(): void {
  document.addEventListener("pointerdown", (e) => {
    if (!panelView) return; // panel already closed
    if (overlayOpen("modal") || overlayOpen("settings") || overlayOpen("autopilot") || overlayOpen("reader") || overlayOpen("menu")) return; // a dialog/settings/autopilot/reader/header-menu is on top — leave the panel be
    const t = e.target as HTMLElement;
    if (t.closest("#side-panel") || t.closest("#header") || t.closest(".file-link") || t.closest("#quote-btn") || t.closest("#modal-root") || t.closest("#menu-root") || t.closest("#settings-root") || t.closest("#autopilot-root") || t.closest(".resizer")) return;
    closePanel();
  });
}

// ── Side panel: files + reader (terminal lands next) ──────────────────────────────
export const panel = $("#side-panel");
const panelContent = $("#panel-content");
// The open side panel, if any. panel.ts is the sole writer; main.ts and conversation.ts read it
// (as a live import binding / an injected lazy getter). Initialized at module eval, which runs
// before main's instant-restore init chain — clearReferences() reads it at load.
export let panelView: "files" | "reader" | "git" | "terminal" | "links" | null = null;
let filesPath = "";
export let readerPath = ""; // main's fs.changed router + the composer's quote path read it
let readerWatch = "";
export let xterm: XTerm | null = null; // main's terminal.data/exit router writes into it
let fit: FitAddon | null = null;
let termObs: ResizeObserver | null = null;

/** Reset the per-session panel state for a newly selected session's worktree (main's selectSession). */
export function resetPanelForSession(): void {
  filesPath = "";
  readerPath = "";
  readerWatch = "";
}

function setPanelTabs(): void {
  document.querySelectorAll<HTMLElement>(".ptab").forEach((t) => t.classList.toggle("active", t.dataset.view === panelView));
  $("#btn-files").classList.toggle("active", panelView === "files" || panelView === "reader");
  $("#btn-git").classList.toggle("active", panelView === "git");
  $("#btn-terminal").classList.toggle("active", panelView === "terminal");
  $("#btn-links").classList.toggle("active", panelView === "links");
  // On phone the Files/Links buttons collapse into ⋮ More — light it up when either owns the panel.
  $("#btn-more").classList.toggle("active", panelView === "files" || panelView === "reader" || panelView === "links");
}
export function openPanel(view: "files" | "reader" | "git" | "terminal" | "links"): void {
  if (!activeId()) {
    toast("Open a session first");
    return;
  }
  if (view !== "terminal") disposeTerminal();
  panelView = view;
  panel.classList.add("open");
  openOverlay("panel", closePanelDom); // Back closes the panel (no-op if it's already a layer)
  setPanelTabs();
  if (view === "files") requestFiles(filesPath);
  else if (view === "reader" && !readerPath) requestFiles(filesPath);
  else if (view === "git") renderGit();
  else if (view === "terminal") mountTerminal();
  else if (view === "links") renderLinks();
}
/** Tear down the panel (DOM/state only). Reached via Back (popstate) or closePanel(). */
function closePanelDom(): void {
  if (readerWatch && activeId()) sendTo(activeId()!, { type: "fs.unwatch", sessionId: activeId()!, path: readerWatch });
  readerWatch = "";
  disposeTerminal();
  panelView = null;
  panel.classList.remove("open");
  setPanelTabs();
}
export const closePanel = (): void => dismissOverlay("panel"); // programmatic close → unwind the back-stack
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
    if (activeId()) sendTo(activeId()!, { type: "terminal.input", sessionId: activeId()!, data: strToB64(d) });
  });
  if (activeId()) sendTo(activeId()!, { type: "terminal.open", sessionId: activeId()!, cols: xterm.cols, rows: xterm.rows });
  // [WEB2-4] The ResizeObserver fired a fit() + a terminal.resize WS frame on every tick (many per drag).
  // Debounce ~100ms, and only send terminal.resize when the grid (cols/rows) actually changed — a repaint
  // that doesn't alter the character grid shouldn't spam the daemon (which re-sizes the real PTY).
  let lastCols = xterm.cols;
  let lastRows = xterm.rows;
  termObs = new ResizeObserver(() => {
    if (termFitTimer) return;
    termFitTimer = window.setTimeout(() => {
      termFitTimer = 0;
      if (!fit || !xterm || !activeId()) return;
      fit.fit();
      if (xterm.cols !== lastCols || xterm.rows !== lastRows) {
        lastCols = xterm.cols;
        lastRows = xterm.rows;
        sendTo(activeId()!, { type: "terminal.resize", sessionId: activeId()!, cols: xterm.cols, rows: xterm.rows });
      }
    }, 100);
  });
  termObs.observe(panelContent);
}
let termFitTimer = 0;
function disposeTerminal(): void {
  termObs?.disconnect();
  termObs = null;
  if (termFitTimer) {
    clearTimeout(termFitTimer);
    termFitTimer = 0;
  }
  xterm?.dispose();
  xterm = null;
  fit = null;
}
function requestFiles(path: string): void {
  if (!activeId()) return;
  filesPath = path;
  sendTo(activeId()!, { type: "fs.list", sessionId: activeId()!, path });
}
export function renderFiles(entries: DirEntry[]): void {
  panelView = "files";
  setPanelTabs();
  const wrap = document.createElement("div");
  wrap.className = "file-browser";
  const ul = document.createElement("ul");
  ul.className = "file-list";
  if (filesPath) {
    const up = document.createElement("li");
    up.className = "dir";
    up.innerHTML = `<span class="fb-name">📁 ..</span>`;
    up.onclick = () => requestFiles(filesPath.split("/").slice(0, -1).join("/"));
    ul.appendChild(up);
  }
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = e.isDir ? "dir" : "";
    const detail = [e.size !== undefined ? humanSize(e.size) : "", e.mtime !== undefined ? relTime(e.mtime) : ""].filter(Boolean).join(" · ");
    li.innerHTML =
      `<span class="fb-name">${e.isDir ? "📁" : "📄"} ${esc(e.name)}</span>` +
      `<span class="fb-detail">${esc(detail)}</span>` +
      (e.isDir ? "" : `<button type="button" class="fb-dl" title="Download">${icon("download")}</button>`);
    li.onclick = () => (e.isDir ? requestFiles(e.path) : openFile(e.path));
    const dl = li.querySelector<HTMLButtonElement>(".fb-dl");
    if (dl)
      dl.onclick = (ev) => {
        ev.stopPropagation(); // don't also open the file in the reader
        downloadFile(e.path, e.name);
      };
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  const hint = document.createElement("p");
  hint.className = "fb-drop-hint muted small";
  hint.textContent = "Drop files here to upload";
  wrap.appendChild(hint);
  wireBrowserDrop(wrap);
  panelContent.innerHTML = "";
  panelContent.appendChild(wrap);
}
/** Stream a worktree file to the client via the daemon's download endpoint (Content-Disposition
 *  forces a save-as). Routed to the active session's server so it works across a federated fleet. */
function downloadFile(path: string, name: string): void {
  if (!activeId()) return;
  const url = serverApiUrl(activeServer().url, `/api/sessions/${activeId()}/files?path=${encodeURIComponent(path)}&download=1`);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
/** Drag-and-drop upload into the currently-browsed worktree directory (`filesPath`). Uploads the
 *  raw bytes via PUT; the daemon refuses to overwrite an existing name (409 → "already exists"). */
function wireBrowserDrop(wrap: HTMLElement): void {
  wrap.addEventListener("dragover", (e) => {
    e.preventDefault();
    wrap.classList.add("drag-over");
  });
  wrap.addEventListener("dragleave", (e) => {
    if (e.target === wrap) wrap.classList.remove("drag-over");
  });
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    wrap.classList.remove("drag-over");
    void uploadToBrowser(Array.from((e as DragEvent).dataTransfer?.files ?? []), filesPath);
  });
}
async function uploadToBrowser(files: File[], dir: string): Promise<void> {
  if (!activeId() || files.length === 0) return;
  let ok = 0;
  for (const file of files) {
    const rel = (dir ? `${dir}/` : "") + file.name;
    try {
      const res = await serverFetch(activeServer().url, `/api/sessions/${activeId()}/files?path=${encodeURIComponent(rel)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: await file.arrayBuffer(),
      });
      if (res.status === 409) {
        toast(`"${file.name}" already exists — rename it or remove the old one first`);
        continue;
      }
      if (!res.ok) {
        toast(`Upload of "${file.name}" failed`);
        continue;
      }
      ok++;
    } catch {
      toast(`Upload of "${file.name}" failed`);
    }
  }
  if (ok > 0) {
    toast(ok === 1 ? "Uploaded 1 file" : `Uploaded ${ok} files`);
    if (panelView === "files" && filesPath === dir) requestFiles(dir); // refresh to show the new files
  }
}
function openFile(path: string): void {
  if (!activeId()) return;
  disposeTerminal();
  panel.classList.add("open"); // a file link may open the reader while the panel is closed
  openOverlay("panel", closePanelDom); // Back closes it (no-op if the panel is already a layer)
  readerPath = path;
  panelView = "reader";
  setPanelTabs();
  if (readerWatch && readerWatch !== path) sendTo(activeId()!, { type: "fs.unwatch", sessionId: activeId()!, path: readerWatch });
  sendTo(activeId()!, { type: "fs.read", sessionId: activeId()!, path });
  sendTo(activeId()!, { type: "fs.watch", sessionId: activeId()!, path });
  readerWatch = path;
  panelContent.innerHTML = `<p class="muted small">Loading ${esc(path)}…</p>`;
}
export function renderReader(content: FileContent): void {
  if (content.path !== readerPath) return;
  panelView = "reader";
  setPanelTabs();
  // A picker has nothing to pop out yet. Otherwise: on the Android shell (no real second window)
  // the button opens an in-app full-screen overlay; on Mac/web it pops out a standalone window.
  const popoutBtn = content.choices
    ? ""
    : isAndroidApp
      ? `<button type="button" id="reader-popout" class="reader-act" title="Full screen">${icon("fullscreen")}</button>`
      : `<button type="button" id="reader-popout" class="reader-act" title="Open in its own window">${icon("open_in_new")}</button>`;
  const head =
    `<div class="reader-head"><b>${esc(content.path)}</b>` +
    `<span class="reader-head-actions">${popoutBtn}` +
    `<a href="#" id="reader-back">← files</a></span></div>`;
  if (content.choices) {
    // A prose-named file (e.g. "design.md") matched several paths — let the user pick which to open.
    const items = content.choices
      .map((p) => `<li><a href="#" class="file-link reader-choice" data-path="${esc(p)}">${esc(p)}</a></li>`)
      .join("");
    panelContent.innerHTML = head + `<div class="reader-choices"><p class="muted small">${esc(content.path)} matches several files — pick one:</p><ul>${items}</ul></div>`;
    for (const a of panelContent.querySelectorAll<HTMLElement>(".reader-choice")) {
      a.onclick = (e) => {
        e.preventDefault();
        const p = a.dataset.path;
        if (p) openFile(p);
      };
    }
  } else if (content.markdown) {
    panelContent.innerHTML = head + `<div class="md reader-md">${content.markdown.html}</div>`;
    void runMermaid(panelContent.querySelector(".reader-md") as HTMLElement);
  } else if (content.text !== undefined) {
    panelContent.innerHTML = head + `<pre class="reader-text">${esc(content.text)}</pre>` + (content.truncated ? '<p class="muted small">(truncated)</p>' : "");
  } else if (content.binaryUrl) {
    const burl = serverApiUrl(activeServer().url, content.binaryUrl); // daemon-relative → absolute, routed to the session's server
    panelContent.innerHTML =
      head + (content.mime.startsWith("image/") ? `<img src="${burl}" style="max-width:100%" />` : `<a href="${burl}" target="_blank" rel="noopener noreferrer">Open ${esc(content.path)}</a>`);
  }
  const back = document.getElementById("reader-back");
  if (back) back.onclick = (e) => { e.preventDefault(); openPanel("files"); };
  const popout = document.getElementById("reader-popout");
  if (popout) popout.onclick = () => (isAndroidApp ? openFullScreenReader(content.path) : popOutReader(content.path));
}
/** Open the currently-rendered reader content in a standalone window (Mac + Web). Reuses the page's
 *  stylesheets + theme and the already-rendered DOM (Mermaid/KaTeX/code highlighting intact), minus
 *  the in-app chrome, so the file reads as its own clean document you can park beside the chat. */
function popOutReader(path: string): void {
  const clone = panelContent.cloneNode(true) as HTMLElement;
  clone.querySelector(".reader-head")?.remove(); // in-app header + back link don't belong in the window
  clone.querySelectorAll(".copy-btn").forEach((b) => b.remove()); // their click handlers don't survive the copy
  const styles = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    .map((l) => `<link rel="stylesheet" href="${esc(l.href)}" />`)
    .join("");
  const theme = document.documentElement.dataset.theme ?? "light";
  const title = path.split("/").pop() || path;
  // NB: no "noopener" here — with it, window.open() returns null (the opener link is severed), so we
  // could never write into the window and were left with a blank about:blank pop-up. We need the
  // handle to document.write our own content; it's same-origin self-authored markup, so this is safe.
  const win = window.open("", "_blank", "width=860,height=920");
  if (!win) {
    toast("Allow pop-ups to open the reader in its own window");
    return;
  }
  win.document.write(
    `<!doctype html><html lang="en" data-theme="${esc(theme)}"><head><meta charset="utf-8" />` +
      `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
      `<title>${esc(title)}</title>${styles}` +
      // The shared app stylesheets pin html/body to height:100%;overflow:hidden so the in-app
      // shell never scrolls — but in this standalone window that traps the content and kills the
      // scrollbar. Reset both back to a normal, scrollable document.
      `<style>html,body{margin:0;height:auto;overflow:auto;background:var(--bg);color:var(--text)}` +
      `.popout-wrap{max-width:880px;margin:0 auto;padding:28px clamp(16px,4vw,40px)}` +
      `.popout-head{font:600 12px/1.4 ui-monospace,Menlo,monospace;color:var(--muted);margin-bottom:16px;word-break:break-all}</style>` +
      `</head><body><div class="popout-wrap"><div class="popout-head">${esc(path)}</div>${clone.innerHTML}</div></body></html>`,
  );
  win.document.close();
}
/** Android in-app full-screen reader. The WebView shell can't make a real second window, so instead of
 *  popOutReader's standalone window we overlay the whole document with a clean, full-bleed, scrollable
 *  copy of the already-rendered file (Mermaid/KaTeX/highlighting intact), minus the in-app chrome. It's
 *  a back-stack layer, so the device Back button and the on-screen ✕ both close it. */
function openFullScreenReader(path: string): void {
  const clone = panelContent.cloneNode(true) as HTMLElement;
  clone.querySelector(".reader-head")?.remove(); // the panel's header + back link don't belong full-screen
  clone.querySelectorAll(".copy-btn").forEach((b) => b.remove()); // their click handlers don't survive the clone
  document.getElementById("reader-fs")?.remove(); // never stack two
  const title = path.split("/").pop() || path;
  const fs = document.createElement("div");
  fs.className = "reader-fs";
  fs.id = "reader-fs";
  fs.innerHTML =
    `<div class="reader-fs-head"><span class="reader-fs-title" title="${esc(path)}">${esc(title)}</span>` +
    `<button type="button" class="reader-fs-close" aria-label="Close" title="Close">${icon("close")}</button></div>` +
    `<div class="reader-fs-body">${clone.innerHTML}</div>`;
  document.body.appendChild(fs);
  fs.querySelector(".reader-fs-close")?.addEventListener("click", () => dismissOverlay("reader"));
  openOverlay("reader", () => document.getElementById("reader-fs")?.remove());
}

// ── Links panel chrome ─────────────────────────────────────────────────────────
// The links MODEL (`references`, extraction/commit, the header badge) lives in conversation.ts;
// this chrome writes panelView/panelContent/setPanelTabs (side-panel state), so it lives here and
// is handed to conversation.ts as the `renderLinks` dep so a reference-set change refreshes an
// open panel.
export function renderLinks(): void {
  panelView = "links";
  setPanelTabs();
  if (references.size === 0) {
    panelContent.innerHTML =
      `<p class="muted small links-empty">No links yet. URLs and server addresses (e.g. <code>http://localhost:3000</code>) Claude mentions show up here.</p>`;
    return;
  }
  const rows = [...references.entries()]
    .reverse() // most-recent first
    .map(
      ([url, label]) =>
        `<li class="link-row"><a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(url)}">${icon("open_in_new")}<span class="link-label">${esc(label)}</span></a>` +
        `<button type="button" class="ref-copy" data-url="${esc(url)}" title="Copy">${icon("content_copy")}</button></li>`,
    )
    .join("");
  panelContent.innerHTML = `<ul class="link-list">${rows}</ul>`;
  panelContent.querySelectorAll<HTMLElement>(".ref-copy").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault();
      const url = b.dataset.url ?? "";
      void copyText(url).then((ok) => {
        b.innerHTML = icon(ok ? "check" : "error");
        setTimeout(() => (b.innerHTML = icon("content_copy")), 1400);
      });
    }),
  );
}

// ── Git panel ──────────────────────────────────────────────────────────────────
function askClaude(instruction: string): void {
  if (!activeId()) return;
  sendTo(activeId()!, { type: "prompt.send", sessionId: activeId()!, text: instruction });
  toast("Asked Claude →");
  closePanel(); // jump to the conversation to watch it work
}
type Stage = "commit" | "push" | "pr" | "merge";
// Each stage tells Claude to do EVERYTHING up to and including that stage.
const STAGE_PROMPT: Record<Stage, string> = {
  commit: "In this worktree, stage and commit all current changes with a clear, conventional commit message based on what changed. If there's nothing to commit, say so.",
  push: "In this worktree: commit all current changes with a clear conventional message (if any are uncommitted), then push the branch to its origin remote (set the upstream with -u if needed).",
  pr: "In this worktree, take the branch to an open PR: commit any uncommitted changes (good conventional message), push to origin, then create a GitHub pull request with the gh CLI (concise title + summary) if one doesn't already exist. Give me the PR URL.",
  merge: "In this worktree, take the branch all the way to merged: commit any uncommitted changes (good message), push to origin, create a GitHub PR with gh if none exists, then merge it with `gh pr merge --squash` (NOT `--delete-branch`). IMPORTANT: this is a git worktree and the repo's default branch is checked out by another worktree, so do NOT try to switch this worktree to the default branch and do NOT use `--delete-branch` — it switches the checkout before deleting the remote branch, fails on the occupied default, and aborts, leaving the worktree stranded and the remote branch undeleted. After the merge succeeds, delete the remote branch yourself with `git push origin --delete <branch>` (a plain push that never touches the checkout), and leave this worktree on its current branch — staying on the merged branch is expected and correct. Report each step and confirm when it's merged.",
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
  const en = gitStageEnabled(activeId() ? sessions.get(activeId()!)?.git : undefined);
  for (const { key } of STAGE_META) {
    const btn = document.getElementById(`ga-${key}`) as HTMLButtonElement | null;
    if (btn) btn.disabled = !en[key];
  }
}
export function requestGitStatus(): void {
  if (activeId()) sendTo(activeId()!, { type: "git", sessionId: activeId()!, op: "status" });
}
function renderGit(): void {
  panelView = "git";
  setPanelTabs();
  const s = activeId() ? sessions.get(activeId()!) : undefined;
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
      <button type="button" id="ga-reset" title="Un-stick: recover the worktree, clear a parked permission, reset to idle">${icon("restart_alt")} Reset</button>
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
    if (!activeId()) return;
    setGitOutput("loading diff…");
    sendTo(activeId()!, { type: "git", sessionId: activeId()!, op: "diff" });
  };
  for (const m of STAGE_META) {
    const btn = document.getElementById(`ga-${m.key}`) as HTMLButtonElement | null;
    if (btn) btn.onclick = () => runStage(m.key, m.label);
  }
  $("#ga-reset").onclick = resetSession;
  $("#ga-cleanup").onclick = cleanupSession;
  $("#ga-abandon").onclick = abandonSession;
  applyGitButtons();
  requestGitStatus(); // sync status + PR state on open
}
/** Run all stages up to `key`: lock the buttons immediately, refresh when the turn ends. */
function runStage(key: Stage, label: string): void {
  if (!activeId()) return;
  for (const m of STAGE_META) {
    const b = document.getElementById(`ga-${m.key}`) as HTMLButtonElement | null;
    if (b) b.disabled = true; // immediate response; re-evaluated on the next status
  }
  setGitOutput(`Working… asked Claude to ${label.toLowerCase()}.`);
  sendTo(activeId()!, { type: "prompt.send", sessionId: activeId()!, text: STAGE_PROMPT[key] });
  toast(`${label} →`);
  closePanel(); // get out of the way and jump to the conversation to watch it work
}
function gitStatusLine(s: Session | undefined): string {
  const g = s?.git;
  if (!g) return "(no git info)";
  const pr = g.prState ? ` · PR ${g.prState}` : "";
  return `${esc(g.branch)} · ${g.dirtyFileCount} changed · ${g.ahead}↑ ${g.behind}↓${pr}`;
}
export function updateGitPanelMeta(): void {
  if (panelView !== "git") return;
  const s = activeId() ? sessions.get(activeId()!) : undefined;
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
/** Un-stick a session: recover a missing worktree, clear a parked permission, reset to idle. */
async function resetSession(): Promise<void> {
  if (!activeId()) return;
  const id = activeId()!;
  const ok = await confirmDialog({
    icon: "restart_alt",
    title: "Reset this session?",
    body: "Recovers the worktree if it's missing, clears any pending permission, drops the current turn, and returns the session to idle. Your committed work is untouched.",
    confirmLabel: "Reset",
  });
  if (ok) {
    sendTo(id, { type: "session.reset", sessionId: id });
    setGitOutput("resetting…");
  }
}
async function cleanupSession(): Promise<void> {
  if (!activeId()) return;
  const id = activeId()!;
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
  if (!activeId()) return;
  const id = activeId()!;
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
/** Cleanup found outstanding work — offer to handle it first, or remove anyway. */
function showOutstandingDialog(outstanding: string[]): void {
  const s = activeId() ? sessions.get(activeId()!) : undefined;
  const pr = s?.git?.prState;
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
  showModal(m);
  const handle = (t: string) => {
    closeModal();
    askClaude(t);
  };
  $<HTMLButtonElement>("#od-commit").onclick = () => handle(STAGE_PROMPT.commit);
  $<HTMLButtonElement>("#od-push").onclick = () => handle(STAGE_PROMPT.push);
  $<HTMLButtonElement>("#od-pr").onclick = () => handle(pr === "open" ? STAGE_PROMPT.merge : STAGE_PROMPT.pr);
  $<HTMLButtonElement>("#od-cancel").onclick = () => closeModal();
  $<HTMLButtonElement>("#od-remove").onclick = () => {
    closeModal();
    if (activeId()) killSession(activeId()!); // "Remove anyway" — the listed outstanding work IS the warning
  };
}
function setGitOutput(text: string): void {
  const el = document.getElementById("git-output");
  if (el) el.textContent = text;
}
export function showGitResult(e: GitResultEvent): void {
  const el = document.getElementById("git-output");
  if (!el) return;
  const head = e.ok ? "" : "⚠ failed\n";
  el.innerHTML = linkifyUrls(head + e.output); // [SEC-L6] esc + safe new-tab links (rel=noopener)
}
