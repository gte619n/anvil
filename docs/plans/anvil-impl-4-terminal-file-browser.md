# Anvil Implementation Plan — Terminal & File Browser
**Phase:** 3 | **Depends on:** daemon core, rendering pipeline, protocol.ts | **Status:** draft

## 1. Scope & goal
Phase 3 (arch §10.3): the **terminal channel** and the **file browser + markdown reader data source**, after which Zellij is fully retired. Daemon side + client integration contract only (full client UI in the client plans).
1. **Terminal** (§7): a persistent, server-side PTY per session that survives disconnect, retains scrollback, spawned lazily on `terminal.open`, streams bytes as `terminal.data`, accepts `terminal.input/resize/close`, emits `terminal.exit`. Plus the client mode-switch contract and vetted emulator widgets.
2. **File browser + reader source** (§8.1/§8.2): daemon `fs.*` — `fs.list`→`DirEntry[]`, `fs.read`→`FileContent` (markdown via §8.3 pipeline, text otherwise, `binaryUrl` for binaries), live `fs.watch/unwatch`→`fs.changed` with `rev`, **path-traversal-scoped to the session tree**, binary serving over `GET /api/sessions/{id}/files?path=`.

## 2. Decisions inherited
Terminal durable not ephemeral (#10); default shell in session `cwd`; one PTY per session; active/most-recent client owns dimensions (last-attach-wins); mode-switch is a client contract. File browsing first-class from daemon `fs.*`, **superseding** SFTP in `file-browser-sftp.md` (reuse its UX: folders-first D23, breadcrumb D12, hidden toggle D17, large-file truncation D10, on-demand image D14, read-only D4). Reader rendered by the shared §8.3 pipeline. **Path safety load-bearing.**
Protocol types: `TerminalDataEvent`(base64 `data`), `TerminalExitEvent`, `FsChangedEvent`(`FileContent`); `TerminalOpen/Input/Resize/Close`, `FsList/Read/Watch/Unwatch`; `FileContent{path,rev,mime,markdown?,text?,binaryUrl?}`, `DirEntry`, `RenderedMarkdown`. `terminal.input`/`terminal.resize` are deliberately **not** `Correlated` (high-frequency). **See Q3** — `fs.list`/`fs.read` need a typed result message (protocol amendment).

## 3. Terminal — daemon side
**PTY backend — DECISION: Bun's native `Bun.Terminal` (Bun ≥ 1.3.5), NOT node-pty.** This retires the headline risk. Bun shipped first-class PTY in v1.3.5 (Dec 2025): `new Bun.Terminal({cols,rows,data(term,bytes){…}})` + `Bun.spawn(cmd,{terminal})`, with `write/resize/setRawMode/close/ref/unref/closed`, termios accessors, `[Symbol.asyncDispose]`. POSIX-only (fine, daemon on Mac). node-pty is still not reliably loadable under Bun (native addon instability). Map: `data` cb → base64 → `terminal.data`; `terminal.input` → decode → `term.write`; `terminal.resize`/resize-on-attach → `term.resize`; subprocess `exited` → `terminal.exit`.

**Per-session `TerminalChannel`** (lazily created, owned by the supervisor): `{pty?, proc?, scrollback:RingBuffer, rev, dims, attachedClients}`.
- `terminal.open{cols,rows}`: if no pty, spawn `$SHELL`/`/bin/zsh` in `session.cwd` with `terminal:new Bun.Terminal(...)`; replay scrollback; add client; resize to this client (last-attach-wins); ack on cid.
- `terminal.input`: decode → write. `terminal.resize`: resize + update dims.
- `terminal.close`: remove client; **do not kill the PTY** (persistence) — only torn down on shell exit or session kill.
- shell exit: `terminal.exit{code}`, keep scrollback until next open or session kill.

**Scrollback:** in-memory byte ring (~256 KB / ~5000 lines, configurable); replay raw bytes on (re)attach so the VT emulator reconstructs the screen. Process-lifetime only (daemon restart loses it; the conversation log survives — Q2).

**Sizing:** one size at a time; resize to the attaching/most-recent client. No negotiation (matches serial device-switching, §7).

**Lifecycle:** PTY shell runs in the session process group (§5/da870d5); `session.kill` SIGTERMs the group → shell dies → `terminal.exit` → teardown; daemon shutdown closes all terminals. **Pin Bun ≥ 1.3.14** (macOS UAF fix).

## 4. Terminal — client integration & widgets
**Mode-switch contract:** no wire "mode" flag — entering terminal mode is client-local UI state. After `terminal.open` ack: (1) mount emulator; (2) swap font → monospace + keyboard/IME (Android: Termux extra-keys row; Apple: standard encodings the view handles); (3) send `terminal.resize` whenever cell dims change. Leaving → `terminal.close` (detach, shell persists) + restore prose font/keyboard. Key encoding lives in the **client widget**; the daemon ferries opaque base64.

**Widgets (integration points):**
- **Apple — SwiftTerm** (MIT, actively maintained 2026): UI-agnostic VT100 engine + UIKit/AppKit front-ends. Wrap in `UI/NSViewRepresentable`; `feed(byteArray:)` ← `terminal.data`; delegate `send` → base64 → `terminal.input`; `sizeChanged` → `terminal.resize`.
- **Android — Termux `terminal-view`+`terminal-emulator`** via `AndroidView`: redirect a `TerminalSession`'s I/O to the WS; extra-keys row; cell metrics → cols/rows → `terminal.resize`. **GPL-3.0 license caveat — verify per module (Q5).**
Both are real emulators, so "replay raw scrollback bytes" needs zero special handling.

## 5. File browser & reader source — daemon side
**5.1 Path safety (do first; gates everything).** Central `resolveInside(root, userPath)`: `resolve` → `realpathSync` (resolves symlinks) → require `real === rootReal || real.startsWith(rootReal + sep)` else reject. Defeats `..`, absolute escape, and **symlink escape** (the only boundary since the daemon runs as the dev user). Apply identically to `fs.list/read/watch` and `GET /files`.
**5.2 `fs.list`:** resolve → `readdir` → `DirEntry[]` (folders-first, hidden included; toggle client-side). Reply by `cid`.
**5.3 `fs.read`→`FileContent`:** compute `rev` (`mtimeMs:size` or hash) + `mime`. Markdown → §8.3 pipeline → `markdown`. Other text → `text` (size cap ~256 KB; truncate + signal — Q4). Image/binary → `binaryUrl = /api/sessions/{id}/files?path=…`.
**5.4 Live watch:** **chokidar default** (v4/v5, robust to editor atomic-rename saves that raw `fs.watch` mis-reports), behind an adapter seam (Bun's 1.3.14 native `fs.watch` is now plausible). `fs.watch{path}` → resolve → register (ref-counted by client); on change → **debounce 150–250 ms** → internal `fs.read` → `fs.changed{content}` with new `rev`; client drops unchanged `rev`. **Claude-edits-mid-conversation superpower:** Claude `Edit`/`Write` → watcher → re-render → `fs.changed` → reader updates live; debounce collapses edit bursts. Cleanup on unwatch/detach/kill; cap watchers/session.
**5.5 `fs.changed` inlining:** markdown/small text inlined; large/binary → `path`+`rev`+`binaryUrl`, client re-fetches.
**5.6 Binary/image REST:** `GET /api/sessions/{id}/files?path=` → auth → **same 5.1 guard** → stream `Bun.file` with `Content-Type` + `ETag=rev`. Read-only.

## 6. Implementation steps
- **M0** Pin Bun ≥ 1.3.14; add chokidar; implement+test `resolveInside` (`..`/absolute/symlink); confirm `renderMarkdown()` callable (Phase 1).
- **M1** `fs.list` (+folders-first, hidden, escape-reject).
- **M2** `fs.read` (mime, rev, markdown/text/binary branches, cap).
- **M3** Binary REST (`ETag=rev`, traversal reject, 404).
- **M4** Live watch (chokidar registry, debounce, re-render → `fs.changed`; cleanup; **Claude-edits → live re-render** test).
- **M5** Terminal channel (`Bun.Terminal`, lazy spawn in process group, data↔input, scrollback replay, exit/close semantics, kill integration).
- **M6** Client adapters (Apple SwiftTerm Representable; Android Termux view + extra-keys; browser/reader panels).
- **M7** Retire Zellij once durable shell + browser prove out (§10.3).

## 7. Dependencies
| Lib | Version | License | For |
|---|---|---|---|
| Bun | **≥ 1.3.14** | MIT | `Bun.Terminal` PTY, `Bun.file`, native fs.watch fallback |
| chokidar | ^4/^5 | MIT | file watching (atomic-rename robustness) |
| markdown-it+Shiki+KaTeX+DOMPurify | (Phase 1 §8.3) | MIT/Apache | `fs.read`/`fs.changed` markdown — **reused** |
| SwiftTerm | latest 2026 | **MIT** | Apple terminal widget |
| Termux terminal-view/-emulator | master | **GPL-3.0/Apache mix — VERIFY (Q5)** | Android terminal widget |
| node-pty | — | — | **Rejected** (not reliable under Bun) |

## 8. Key flows
- **A) Open→stream→reattach:** A `terminal.open` → spawn shell+PTY → ack, resize to A; stdout → base64 → `terminal.data`; A input → `term.write`; A WS drops → PTY stays alive, long cmd runs, scrollback fills; B `terminal.open` → replay scrollback → resize to B → live resumes; `session.kill` → SIGTERM group → `terminal.exit` → teardown.
- **B) Watch→Claude edits→live re-render:** `fs.read`→render; `fs.watch`→chokidar; Claude `Edit` → debounce → re-read → `fs.changed{rev:r1}` → reader morphs in place (scroll preserved); close → `fs.unwatch`.
- **C) Browse→open:** `fs.list`→tree; tap `.md`→`fs.read.markdown`→reader (then B); code/text→`text`; image→`binaryUrl`→REST (ETag); escape → `command.error`/403.

## 9. Risks & open questions
- **(Headline, now retired) node-pty-on-Bun** — replaced by native `Bun.Terminal` (high confidence it exists/covers our needs; ~6 mo old). *Mitigation:* thin `PtyBackend` interface so we can swap to `bun-pty` (FFI/portable-pty). **Do not reach for node-pty.**
- **Q1 — terminal `seq` vs conversation log:** `terminal.*` are `SessionScoped` (carry `seq`) but raw PTY bytes shouldn't bloat the durable log. *Proposal:* `seq` for live ordering but **exclude terminal events from the persisted conversation log**; terminal "resume" = scrollback replay, not snapshot. **Needs protocol/arch clarification.**
- **Q2 — scrollback across daemon restart:** lost (fresh shell). Accept for v1, document.
- **Q3 — `fs.list`/`fs.read` result shape:** the union has no result message; only `ack`/`command.error`. **Recommend adding `FsListResultEvent`/`FsReadResultEvent` to protocol.ts** before M1.
- **Q4 — large-text policy:** `FileContent.text` cap/truncation not in protocol; decide cap + range fetch.
- **Q5 — Android terminal-view GPL-3.0:** verify per-module; a distribution gate. Fallback ReTerminal (same upstream) or clean-room/Rust engine.
- **Q6 — chokidar vs native:** default chokidar; keep the seam; revisit after measuring Claude-edit fidelity on macOS.
- **Q7 — REST image origin:** ensure `binaryUrl` origin is allowed by the reader WebView `img-src`.

## 10. Cross-references
Architecture §7, §8.1, §8.2, §8.3, §5, §6.1/§6.4, §6.5, §10.3, §11 #2/#10–#13. Protocol: `terminal.*`, `fs.*`, `FsChangedEvent`, `FileContent`/`DirEntry`/`RenderedMarkdown`, `Envelope`/`SessionScoped`/`Correlated`, `rest` namespace (amendments Q3/Q4). `file-browser-sftp.md` — superseded on transport, UX reused.
Sources (2026): Bun v1.3.5 PTY, `Bun.Terminal` ref, Bun v1.3.14 fs.watch rewrite, node-pty-on-Bun issues, bun-pty, chokidar, SwiftTerm, Termux terminal-view, ReTerminal.
