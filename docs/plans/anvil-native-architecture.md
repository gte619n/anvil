# Anvil Native Architecture — Dropping Zellij

**Version:** 0.2
**Created:** 2026-06-19 · **Updated:** 2026-06-20
**Status:** PARTIALLY IMPLEMENTED — daemon + web client shipping; native clients pending. See §10.
**Supersedes (eventually):** the Zellij web-client approach in `SPEC.md`

---

## 0. Build status (2026-06-20)

What's actually running today (branch `anvil-daemon`):

- ✅ **`anvild` daemon** — session supervisor, Agent SDK streaming (Opus/Sonnet), persisted
  event log, versioned WS protocol (`anvil-protocol.ts` v0.5), §3 auth assertions, usage
  budget, mostly-autonomous + danger-list, runs as a macOS LaunchAgent behind Tailscale.
- ✅ **§8.3 render pipeline** — markdown-it + Shiki + KaTeX + DOMPurify; mermaid in-client.
- ✅ **Web client** (NEW surface, not in the original phased plan) — vanilla TS served by the
  daemon at `/`; this is the current daily driver. Streaming render, select-to-cite, markdown
  reader (§8.2) with live `fs.watch`, file browser (§8.1), terminal (§7, `Bun.Terminal` PTY),
  image attachments (§6.5), environments (worktree-per-session), full git lifecycle
  (commit/push/PR/merge via "ask Claude"; cleanup/abandon), Sonnet-chosen session icons,
  collapsible sidebar, dark mode, instant conversation restore, themed dialogs, Material
  Symbols (CDN), connection indicator. Worktree isolation enforced via a system-prompt pin.
- ✅ **Push (§6.7)** — Web Push for the web client: VAPID keys + persisted browser subscriptions
  (`web-push`), service worker, a notify-toggle bell, and pushes on permission requests + turn
  completion (SW suppresses if a window is focused; click deep-links to the session). FCM/APNs
  for *native* clients still pending.
- ❌ **Native clients** — Android (Compose), Mac/iPhone (SwiftUI) not started. The web client
  currently fills the "daily driver" role the native Android app was meant to.

Nearest-term candidates: (a) real push delivery, (b) make the web client an installable PWA,
or (c) start the native clients. See §10.

**Future direction:** a **multi-server fleet** (one client managing `anvild` on several Macs, one Max
token across all) is designed in `anvil-multi-server.md` (status: design, not started).

---

## 1. Motivation

Today Anvil drives Claude Code by running it inside a PTY, inside Zellij, surfaced
through Zellij's browser web client, wrapped by a WebView app. We use it almost
entirely to **converse with Claude**, occasionally dropping to a shell.

Nearly every active frustration traces to one root cause: **we are using a terminal
multiplexer to do something that isn't fundamentally terminal work.** Zellij renders a
fixed character grid and shares that single grid across all attached clients.

| Pain point | Why it happens | Root cause |
|---|---|---|
| Monospace font, prose hard to read | TUI renders a fixed character grid | bytes-on-a-grid |
| Shift+Enter ≠ newline | terminal key encoding, not a text field | bytes-on-a-grid |
| Viewport mismatch across devices / foldable | one shared grid, clients fight over its size | bytes-on-a-grid |
| Can't paste/drag images & files | a PTY only accepts byte streams | bytes-on-a-grid |
| Session mgmt opaque; sessions won't die | Zellij owns lifecycle via sockets + husks | wrong layer owns state |
| Chrome tabs / phone titles all identical | web client surfaces only a title | no structured metadata |
| Worktree state invisible | git state lives outside the terminal view | no structured metadata |

**The reframe:** Anvil is a **Claude client that occasionally needs a terminal**, not a
terminal that occasionally talks to Claude. If conversation is *structured data*
(markdown, tool calls, diffs) instead of *a character grid*, the entire top half of that
table disappears for free — reflowable text has no fixed width, so multi-device and
foldable resize stop mattering, prose renders proportionally, and a native text input
gives Shift+Enter, paste, and drag-drop.

---

## 2. The lever: drive Claude Code, don't scrape it

Claude Code is programmatically driveable via the **Claude Agent SDK** (TypeScript +
Python) and headless mode (`claude -p --output-format stream-json --resume <id>`). It
runs the full agent loop and emits a typed event stream: assistant text deltas,
`tool_use` blocks, tool results, permission requests, usage/cost, and a final result
message. It supports session resume, a `canUseTool` permission callback, hooks, and MCP.

So we never scrape a TUI again. The server hosts the agent and forwards **structured
events**; clients render them natively. Permission prompts become native dialogs instead
of keystrokes into a pane. This is the single decision everything else hangs off.

---

## 3. Auth & Billing — load-bearing constraint (READ FIRST)

> **This section is a hard constraint, not a preference.** Violating it silently converts
> the whole system from "covered by my Max subscription" to "metered pay-per-token."

There are two different "APIs" with completely different billing:

- **Raw Anthropic Messages API** (`api.anthropic.com/v1/messages`, our own agent loop) →
  **API key only, pay-per-token. The Max subscription does NOT apply.**
- **Driving Claude Code via the Agent SDK / headless `claude -p`** → can authenticate
  with the **Max subscription via OAuth**, and currently draws from the subscription pool
  with **no per-token charge.**

### Rules `anvild` MUST follow

1. **Always go through the Agent SDK / Claude Code.** Never call the raw Messages API for
   the main conversation, not even "just for one feature." The moment we do, that path
   needs an API key and meters us.
2. **Authenticate with subscription OAuth.** Generate a token with `claude setup-token`
   and provide it to the daemon as `CLAUDE_CODE_OAUTH_TOKEN`. This is the documented path
   for scripts/headless contexts.
3. **`ANTHROPIC_API_KEY` MUST be absent from the daemon's environment.** Auth precedence
   means a stray API key silently takes over and meters every turn. The daemon should
   assert at startup that `ANTHROPIC_API_KEY` is unset and `CLAUDE_CODE_OAUTH_TOKEN` is
   present, and refuse to start otherwise.
4. **`--bare` mode does NOT read `CLAUDE_CODE_OAUTH_TOKEN`** — do not use bare mode for
   the subscription path.

### Caveats to track (these can move the cost model)

- **Agent-SDK billing split: announced, then paused.** Anthropic planned (2026-06-15) to
  move Agent SDK / `claude -p` usage to a separate metered credit pool (~$100/mo Max 5x,
  ~$200/mo Max 20x) and then **paused** it pending redesign. Today nothing has changed —
  programmatic use still draws from the subscription. **This is the assumption most likely
  to shift; watch official channels.**
- **ToS / unattended use.** Docs explicitly bless `setup-token` for "scripts and CI," but
  the general Terms restrict "automated or non-human means" except via API key. A daemon
  *we drive interactively* from phone/Mac is squarely fine (human-initiated). A daemon
  running *fully unattended/scheduled* is the grey zone. **Design keeps it human-initiated.**
- **Shared usage pool.** Max 5x ≈ 240 Sonnet / 20 Opus hrs/wk; Max 20x ≈ 480 / 40 — shared
  across Claude Code, claude.ai chat, and Cowork. Heavy multi-session use eats the same pool.

### The one sanctioned exception

If we later add something the subscription can't cover (e.g. a cheap background model to
summarize session-list previews), scope it to its **own narrow, explicitly-metered API
call** with its own API key — never blended into the main conversation env.

### Model default & usage guardrails (decided)

- **Default model: Opus** for new sessions (best model everywhere). The user accepted the
  trade-off knowingly.
- **This makes usage tracking load-bearing, not optional.** Default-Opus × *mostly
  autonomous* (§6.6) × *2–4 concurrent* sessions (§5) will consume the small Opus weekly
  budget (~20 Opus hrs/wk on Max 5x, ~40 on Max 20x) quickly. The daemon MUST surface, in
  real time and prominently in every client's session list:
  - remaining Opus vs Sonnet budget in the shared Max pool,
  - per-session burn rate, and
  - a **warning threshold** (e.g. 80% of Opus pool) and a **soft stop** option so an
    autonomous session can't silently exhaust the week.
- Per-session model override is still available (bump down to Sonnet to conserve, up to
  Opus for heavy lifting) — default is just Opus.

Sources: [Claude Code Authentication](https://code.claude.com/docs/en/authentication),
[Help Center: Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

---

## 4. System overview

```
┌─────────────────────── Mac (the dev box) ────────────────────────┐
│  anvild  (the daemon)                                            │
│   • Session supervisor: 1 session = worktree + Claude SDK stream │
│   • Per-session: structured event log (persisted), git metadata, │
│     status, token usage                                          │
│   • On-demand PTY channel (real shell) per session               │
│   • WebSocket API + small REST control plane                     │
│   • Auth: CLAUDE_CODE_OAUTH_TOKEN, no ANTHROPIC_API_KEY (see §3)  │
└────────────────────────────┬─────────────────────────────────────┘
                             │  Tailscale (MagicDNS + ACLs; serve for HTTPS)
        ┌────────────────────┼────────────────────────┐
     Mac app              Android app             iPhone (future)
   (SwiftUI)            (Compose)                 (SwiftUI, shared core)
```

`anvild` replaces **both** the current Python status server *and* Zellij.

---

## 5. Session model & lifecycle

A **session** is the unit of work — one conversation against one working tree.

```ts
type Session = {
  id: string;            // server-assigned, stable
  title: string;         // human label; auto-derived from first prompt if unset
  cwd: string;           // absolute working directory
  source: "existing-dir" | "fresh-worktree";  // chosen at create time (§5 lifecycle)
  worktree?: {           // present when source === "fresh-worktree"
    repoRoot: string;
    branch: string;
    base: string;        // branch/commit it was created from
  };
  model: "opus" | "sonnet";  // default "opus" (§3); per-session override
  autonomy: AutonomyPolicy;  // default "mostly-autonomous" (§6.6)
  claudeSessionId?: string;  // Claude Code's own --resume id
  status: SessionStatus;
  createdAt: string;     // ISO 8601
  lastActivityAt: string;
  usage: { inputTokens: number; outputTokens: number; turns: number };
};

type AutonomyPolicy =
  | "mostly-autonomous"  // default: auto-allow nearly everything; prompt only on
                         //   genuinely dangerous ops (rm -rf, force push, secret access)
  | "allowlist"          // auto-allow reads/searches/safe cmds; prompt for writes/net
  | "prompt-all";        // ask on every tool use

type SessionStatus =
  | "idle"               // waiting for user input
  | "thinking"           // model generating
  | "running_tool"       // a tool_use is executing
  | "awaiting_permission"// blocked on a permission decision
  | "error"
  | "exited";            // process gone
```

### Lifecycle — the daemon owns it explicitly

This is the fix for "sessions are hard to understand / hard to kill." Unlike Zellij,
there are no sockets to negotiate with and no husks to reap blindly.

- **Create:** the client chooses the working dir per session — either **attach to an
  existing dir/repo as-is** (`source: "existing-dir"`, quick poke) or **spin up a fresh
  git worktree off a base branch** (`source: "fresh-worktree"`, isolated task). `anvild`
  then spawns a supervised Claude Code process (or SDK query), records the session row,
  persists an event log file. Model defaults to Opus, autonomy to mostly-autonomous.
- **Supervise:** each session runs in its **own process group**. The supervisor tracks
  liveness; on crash it marks `status: error` and surfaces it (no silent zombies).
- **Kill:** SIGTERM the **process group**, wait, SIGKILL on timeout, reap, remove the
  worktree (if owned and clean — or prompt), delete state. Reliable and observable.
  *(We already learned the process-group/reaping discipline in commit `da870d5`; this is
  the same rigor, but now we own the lifecycle end-to-end.)*
- **Persist:** the event log (§6) is the source of truth, so any device resumes full
  history; the daemon survives restarts by replaying logs and re-attaching live sessions.

---

## 6. The protocol

Transport: a single **WebSocket** per client connection, carrying a typed, versioned,
**sequenced** event stream. One control plane, two logical channels per session:
`conversation` (structured) and `terminal` (raw PTY bytes, opened lazily). Bulk
attachment upload uses a side REST endpoint (§6.5).

### 6.1 Envelope

Every message shares an envelope. Server→client events within a session carry a
**monotonic `seq`** (per session) — the backbone of resume (§6.4).

```ts
type Envelope = {
  v: 1;
  type: string;          // discriminator, e.g. "assistant.delta"
  sessionId?: string;    // omitted for global/control messages
  seq?: number;          // server→client, per-session monotonic
  ts: string;            // ISO 8601
  // ...type-specific fields
};
```

### 6.2 Server → Client events

**Global / control**
- `session.list` — `{ sessions: Session[] }` (sent on connect)
- `session.created` / `session.updated` / `session.deleted` — `{ session }` / `{ sessionId }`
- `budget` — `{ opus: { usedHrs, limitHrs }, sonnet: { usedHrs, limitHrs }, windowResetsAt }`
  — the shared Max-pool state (§3); pushed on change and on connect. Clients render this
  prominently; daemon emits a `warn` flag past the threshold.

**Conversation (per session)**
- `conversation.snapshot` — `{ events: ConversationEvent[], lastSeq }` — full replay on
  cold attach (no cached `lastSeq`)
- `message.user` — `{ text, attachments }` — echo of a user prompt (so all devices agree)
- `assistant.delta` — `{ text }` — streaming token chunk
- `assistant.message` — `{ blocks }` — finalized assistant turn (text + tool_use blocks)
- `tool.use` — `{ toolUseId, name, input }`
- `tool.result` — `{ toolUseId, content, isError }`
- `permission.request` — `{ requestId, tool, input, suggestions[] }` (see §6.6)
- `status` — `{ status: SessionStatus }`
- `usage` — `{ inputTokens, outputTokens }`
- `result` — `{ stopReason, usage }` — turn complete; session returns to `idle`
- `error` — `{ message, fatal }`

> Markdown in `assistant.delta` / `assistant.message` / `message.user` is rendered to
> sanitized HTML by the daemon pipeline (§8.3) for display in the WebView surface; deltas
> stream as text and are morphed in client-side (Streamdown-style) to avoid flicker.

**Files (per session, for watched paths — see §8.2)**
- `fs.changed` — `{ path, content?, rev }` — a watched file changed (markdown reader
  re-renders in place); content inlined for small text files, else fetch via `fs.read`

**Terminal (per session, only after `terminal.open`)**
- `terminal.data` — `{ data }` (base64 PTY bytes)
- `terminal.exit` — `{ code }`

### 6.3 Client → Server commands

**Session control**
- `session.create` — `{ cwd?, repoRoot?, base?, title? }` → server replies `session.created`
- `session.attach` — `{ sessionId, lastSeq? }` (resume; see §6.4)
- `session.detach` — `{ sessionId }`
- `session.kill` — `{ sessionId }`

**Conversation**
- `prompt.send` — `{ sessionId, text, attachmentIds[] }`
- `permission.respond` — `{ requestId, decision: "allow"|"deny"|"allow_always", updatedInput? }`
- `interrupt` — `{ sessionId }` — stop the current turn (the native equivalent of Esc)
- `session.set_model` — `{ sessionId, model: "opus"|"sonnet" }`
- `session.set_autonomy` — `{ sessionId, policy: AutonomyPolicy }`

**File browser & reader (per session, see §8.1 / §8.2)**
- `fs.list` — `{ sessionId, path }` → `{ entries[] }`
- `fs.read` — `{ sessionId, path }` → file content / preview metadata
- `fs.watch` / `fs.unwatch` — `{ sessionId, path }` — subscribe a path for live updates
  (markdown reader, §8.2)

**Notifications**
- `push.register` — `{ platform: "fcm"|"apns", token }` — register this device for push (§6.7)

**Terminal**
- `terminal.open` — `{ sessionId, cols, rows }` — spawns/attaches a PTY for *this client*
- `terminal.input` — `{ sessionId, data }` (base64)
- `terminal.resize` — `{ sessionId, cols, rows }`
- `terminal.close` — `{ sessionId }`

### 6.4 Reconnection & resume (the mosh lesson, without mosh)

The server is the source of truth; clients hold a cache and reconcile on reconnect.

- Every server→client session event has a per-session monotonic `seq`.
- The client persists the highest `seq` it has rendered, per session.
- On reconnect it sends `session.attach { sessionId, lastSeq }`.
- Server replays all events with `seq > lastSeq` from the on-disk log, then resumes live.
- If `lastSeq` is missing/too old (log truncated), the server sends a full
  `conversation.snapshot` instead.

This makes device-switching and network drops a non-event: pick up your phone, it
reconciles to exactly where the Mac left off. **No shared viewport means switching
devices mid-conversation needs no "disconnect the other one" dance** — the bug you hit
with Zellij simply cannot occur, because nothing is bound to a single client's dimensions.

### 6.5 Attachments (paste / drag-drop images & files)

1. Client uploads bytes via REST: `POST /api/sessions/{id}/attachments` (multipart) →
   `{ attachmentId, kind: "image"|"file", path }`. Server stores under
   `<<cwd>>/.anvil/attachments/` (or a session-scoped temp dir).
2. Client sends `prompt.send` referencing `attachmentIds`.
3. Server feeds them to Claude Code appropriately — images as image content blocks, files
   as path references the agent can read.

This is the clean fix for "can't paste screenshots / drag-drop files": it never touches a
byte-stream PTY; it's a first-class structured upload.

### 6.6 Permissions & autonomy

Claude Code's `canUseTool` callback fires on the server; the daemon applies the session's
**autonomy policy** before ever prompting:

- **`mostly-autonomous` (default, decided):** auto-allow nearly every tool use; prompt
  only on a curated **danger list** (`rm -rf`, `git push --force`, writes outside the
  worktree, secret/credential access, destructive package/db commands). This keeps remote
  phone-driving low-friction while still gating the genuinely irreversible.
- `allowlist`: auto-allow reads/searches/safe commands; prompt for writes and network.
- `prompt-all`: ask on every tool use.

When a prompt *is* required the daemon emits `permission.request`, **blocks that session**
(`status: awaiting_permission`), fires a push (§6.7), and waits for `permission.respond`
from any device. `allow_always` is persisted to the session's policy so it won't re-ask.
Strictly better than the TUI prompt: a real dialog, visible on every device, answerable
from the phone, and reached by a push when you're away.

The **danger list is the safety backstop for autonomous sessions** — it's the only thing
standing between "mostly autonomous" and an unattended `rm -rf`, so it must be
conservative and auditable.

### 6.7 Push notifications

Decided: **FCM/APNs for true background push + live-WS fallback while the app is open.**

- Each device registers via `push.register` with its FCM (Android) / APNs (iOS) token.
- The daemon fires a push when a session needs you (`permission.request`, §6.6) **and**
  when a turn completes (`result`) — the "fire work, put the phone down, get pulled back"
  loop, extending today's Slack hook.
- While a client holds a live WS, it gets the in-app event instantly and the daemon
  suppresses the redundant push to that device.
- **Cloud-dependency caveat:** background push requires Google/Apple services, the one
  spot the system isn't pure-Tailscale. Accepted for reliability. The daemon still
  functions fully without push (in-app status works over Tailscale alone); push is an
  additive alert layer, not a hard dependency.

---

## 7. Terminal mode (the escape hatch)

When you need a raw shell, the client sends `terminal.open`; the daemon ensures a
**persistent, server-side PTY** (default shell) exists for that session in its cwd,
retains scrollback, and streams bytes over the `terminal.*` events. The client renders
them with a real terminal-emulator widget (SwiftTerm on Apple, a Compose terminal on
Android) and the UI **switches mode**: monospace font + terminal IME (Esc/Tab/Ctrl/arrows)
on Android, proportional font + prose keyboard otherwise.

Decided: **the shell is durable, not ephemeral.** It survives disconnects, so a
long-running command keeps going and the scrollback is intact when you reattach from
another device — the durable-session benefit you wanted from Zellij. On attach the daemon
replays recent scrollback and resizes the PTY to the attaching device.

> **Implementation note (planning finding):** Bun shipped a native `Bun.Terminal` PTY API
> (v1.3.5), so the daemon uses that — **not** `node-pty` (which isn't reliably loadable
> under Bun). Pin Bun ≥ 1.3.14. The Android emulator widget (Termux `terminal-view`) is
> **GPL-3.0** — an open licensing decision (see `anvil-impl-INDEX.md`). Apple uses SwiftTerm
> (MIT). Detail in `anvil-impl-4-terminal-file-browser.md`.

**On the viewport-size war:** the conversation (the main flow) is reflowable and immune
regardless. For the terminal fallback, the rule is **the active/most-recently-attached
client owns the PTY dimensions**; when you switch devices the shell resizes to the new one.
Because you switch devices serially (not genuinely co-driving one shell from two screens),
last-attach-wins makes the old Zellij size-fight a non-issue in practice — and if two
clients are attached at once, the size simply follows whichever you last touched.

---

## 8. Worktree / git integration

Because the daemon already owns the working tree, it can surface git state as structured
metadata and push `session.updated` on change (fs-watch or poll):

- branch, base, ahead/behind, dirty file count, short diffstat.
- Clients render a **worktree panel** alongside the conversation — so you can finally see
  *where you are* while talking to Claude. Fixes "worktree management is hard to see."
- Session creation can take a `base` and spin up a fresh worktree per task, making the
  "one task = one worktree = one conversation" model explicit and visible.

### 8.1 File browser (decided: first-class panel)

A **file/worktree browser** is a first-class panel in the native clients, served by the
daemon's `fs.list` / `fs.read` API (§6.3) scoped to the session's working tree:

- Browse the tree, preview/open files (proportional for prose/markdown, monospace +
  syntax for code).
- Pairs with drag-drop attachments (§6.5) — drag a file *out* to reference it, drop one
  *in* to upload.
- Reuses the thinking already captured in `file-browser-sftp.md`, but sourced from the
  daemon over the same WS/REST plane rather than a separate SFTP connection.

### 8.2 Markdown reader (decided: first-class, concurrent with chat)

A **rendered markdown reader is a peer pane to the conversation, not a sub-feature of the
file browser.** The defining requirement: **view a markdown document and chat with Claude
about it at the same time, side by side.** This is the document-centric half of how Anvil
is actually used (specs, READMEs, design docs, Claude's own output).

**Primacy:** the conversation is the primary surface; the reader is a *contextual* pane
that appears **when there is markdown to review** (open a file from the browser, or a doc
Claude just produced) and is otherwise hidden. Default view = conversation + session list.
Do not confuse this with §8.3: the WebView *rendering engine* is used for all markdown
including the chat bubbles, but the *reader pane* is on-demand, not the home screen.

- **Rich rendering:** proportional typography — headings, tables, task lists, blockquotes,
  syntax-highlighted code blocks, inline images (served via the daemon), math, and
  **mermaid diagrams**. This is also the cleanest expression of the "monospace makes prose
  hard to read" fix — a real reading surface, not a terminal pane. Rendering is done by the
  shared daemon pipeline (§8.3), not per-platform native renderers.
- **Concurrent layout:** on Mac and the Fold *inner* display, reader and conversation sit
  **side by side**; on the Fold *outer* / phones, they're swipeable tabs or a drawer. The
  client is a multi-pane workspace (conversation · reader · files · worktree · terminal),
  laid out to the device — and because everything is reflowable, opening/closing the
  foldable just re-lays-out, never fights a fixed grid.
- **Live, not a snapshot:** the reader subscribes to the file via `fs.watch`; when Claude
  edits it, the daemon emits `fs.changed` and the reader re-renders in place. You literally
  watch a spec evolve as you discuss it. (Scroll position is preserved across re-renders.)
- **Select-to-cite (the concurrency superpower):** select a passage in the reader and
  "Ask Claude about this" — the client resolves the selection to a source line range (via
  the `data-line` mechanism in §8.3) and injects the quoted excerpt with a file+line anchor
  into the next `prompt.send`. No new protocol; it's a client affordance over §6.5/§6.3.
- **Sources:** any markdown in the worktree (via `fs.read`), or markdown the conversation
  produces. A doc Claude writes can be opened in the reader and then watched live as it's
  refined.

### 8.3 Markdown rendering pipeline (decided via research, 2026-06-19)

We researched native-per-platform Markdown rendering vs. a shared WebView — this is the
one place the native-per-platform choice (§11) costs the most. Findings (sources in the
research appendix, §13): native renderers **can't do mermaid** (Compose: none; SwiftUI:
one partial lib, ~6 of 20+ diagram types), have **crippled select-to-cite** (SwiftUI's
native selection is select-all-only on iOS and disables custom rendering), **flicker on
streaming re-render**, and would mean maintaining **two divergent renderers** with
different feature matrices. A read-only document WebView avoids all of that and does **not**
re-inherit Zellij's pain — those problems (connection fragility, IME, input latency) came
from an *interactive terminal over a live socket with a focused input field*, none of which
exist in a read-only rendered body. It's also the mainstream pattern for this app category
(Obsidian, VS Code preview, Notion, Joplin, Logseq, Zettlr).

**Decision: render markdown once, in the TS/Bun daemon, and display it in a scoped,
read-only WebView — for ALL markdown surfaces (conversation messages AND the reader
pane).** Native shells (SwiftUI/Compose) still own everything else: session list,
navigation, input, layout/panes, terminal, file tree. This is a deliberate, *scoped*
partial walk-back of "native rendering" — the apps stay native; only the markdown body is
shared HTML — and it buys **one rendering pipeline** across Mac/iOS/Android instead of two.

**Pipeline (in the daemon):**
- `markdown-it` → HTML, emitting `data-line` source attributes on block tokens (the hook
  for select-to-cite — the same mechanism that powers VS Code's preview scroll-sync).
- **Shiki** for code highlighting — server-side, ships no highlighter JS to the client.
- **KaTeX `renderToString`** for math — server-side static HTML+CSS (bundle KaTeX CSS/fonts
  in the WebView).
- **DOMPurify / `rehype-sanitize`** sanitizes all markdown-derived HTML (markdown libraries
  do **not** sanitize by default — `marked` removed `sanitize` in v8; markdown-it ships
  `html:false`).
- **Mermaid: `mermaid.js` runs in the WebView** with `securityLevel:'strict'` + a CSP
  nonce (chosen for full diagram fidelity). JS stays enabled but locked down. **Never use
  `securityLevel:'loose'`** — it's the root of mermaid's XSS CVE history.

**WebView hardening (both platforms):**
- CSP `script-src 'self' 'nonce-…'` (deliverable via `<meta>` for local HTML); no inline
  scripts from document content.
- Apple: `allowsContentJavaScript` on (needed for mermaid), content sanitized + CSP-bounded;
  `WKScriptMessageHandler` for the select-to-cite bridge.
- Android: **no `addJavascriptInterface`** — use `WebViewCompat.addWebMessageListener` with
  an origin check; `setAllowFileAccess(false)`; opaque/null base origin.
- Handle WebView process termination (`onRenderProcessGone` /
  `webViewWebContentProcessDidTerminate`) → reload + restore saved scroll. This is the one
  residual WebView risk, and it's bounded with standard handling.

**Streaming (assistant deltas + live file edits):**
- Never re-`innerHTML` the whole tree (destroys scroll/selection). Use DOM morphing
  (morphdom/idiomorph) + the Streamdown-style technique: cache completed blocks, re-render
  only the trailing incomplete block (O(n), not O(n²)). Gate auto-scroll on the user being
  pinned to the bottom. This is why streaming lives in the WebView and not native — the web
  stack has solved it; the native libs flicker.

---

## 9. Clients

Thin, native shells (SwiftUI / Compose) sharing the §6 protocol. **Hybrid rendering: the
native shell owns navigation, layout, input, lists, terminal, and file tree; markdown
bodies are displayed in a scoped read-only WebView fed by the daemon pipeline (§8.3).**
Responsibilities:

- **Conversation view:** markdown bodies rendered via the §8.3 WebView pipeline
  (proportional font, code/tool-call/diff styling, mermaid); tool calls as collapsible
  cards; **native** multiline input (Shift+Enter = newline), paste & drag-drop → §6.5.
- **Session list with real previews:** branch, last-message snippet, status, diffstat,
  token use, **and the shared Opus/Sonnet budget gauge (§3)**. Fixes "all Chrome tabs /
  phone titles look identical." On Mac a ⌘-switchable sidebar; on Android a rich list.
- **Worktree panel:** §8.
- **File browser panel:** §8.1.
- **Markdown reader pane:** §8.2 — rendered, live-watched, side-by-side with the
  conversation; select-to-cite into chat. Multi-pane workspace laid out per device.
- **Terminal mode:** §7, persistent server-side, with font/keyboard swap.
- **Notifications:** native push (§6.7) for permission prompts and turn completion.

Two client-stack decisions remain open (see §11).

---

## 10. Phased plan

Build the daemon first — it is the keystone and is independently testable. **Detailed
per-component implementation plans live in `anvil-impl-INDEX.md` and `anvil-impl-1..6-*.md`.**

> **Status note (2026-06-20):** Phase 1 ✅ and Phase 3 ✅ are done. A **web client** (not in
> this list) was built on top of the daemon and became the daily driver, covering most of what
> Phase 2's native Android app was for. Phases 2/4/5 (native clients) are not started; push
> delivery (§6.7) is stubbed. See §0 for the full status. The list below is the original intent.

1. **`anvild` MVP** — session supervisor + Agent SDK streaming (Opus default) + persisted
   event log + WS API + §3 auth assertions + **usage-budget tracking with warn/soft-stop**
   + mostly-autonomous policy with the danger-list backstop + **the §8.3 markdown→HTML
   render pipeline (markdown-it + Shiki + KaTeX + DOMPurify)**, behind Tailscale. Drive
   from a CLI/`websocat` to prove the structured stream and reliable kill. Replaces the
   Python status server; de-risks the bet. *(Budget guardrails ship here, not later — §3.)*
2. **Android client** — ⚠️ **the existing app is Java/Views, not Compose** (planning
   finding) — so this is a **greenfield Compose rewrite in the same Gradle module**, not a
   refactor; ~3 utility classes survive. Becomes a **native shell hosting the §8.3 WebView
   render surface**: conversation view, session list with previews + budget gauge, worktree
   panel, **live markdown reader pane side-by-side with chat (§8.2)** with select-to-cite +
   mermaid, push (§6.7). First daily-driver win. *(Markdown reader is a hard requirement,
   ships here.)* See `anvil-impl-3-android-client.md`.
3. **Terminal channel + file browser** — persistent PTY + emulator widget + mode switch
   (§7); `fs.*` browser panel (§8.1). Zellij fully retired.
4. **Mac app** — SwiftUI, same protocol.
5. **iPhone** — share the Swift core with the Mac app.

---

## 11. Decisions (resolved 2026-06-19, via interview)

| # | Decision | Choice | Notes / consequence |
|---|---|---|---|
| Driver | What success looks like in 6 mo | **Custom UX & control** | Tie-breaker for everything below |
| 1 | Build vs. buy | **Build fully custom** | `anvild` + native clients, all ours |
| 2 | Daemon language | **TypeScript / Bun** | In-process Agent SDK integration; assert no `ANTHROPIC_API_KEY` (§3) |
| 3 | Client stack | **Native per platform** | SwiftUI (Mac+iOS shared) + Compose (Android); ~2× code, best UX ceiling |
| 4 | Worktree model | **Per-session choice** | existing-dir OR fresh-worktree (§5) |
| 5 | Notifications | **Push for both** | FCM/APNs + live-WS fallback (§6.7) |
| 6 | Autonomy | **Mostly autonomous** | Auto-allow; prompt only on danger list (§6.6) |
| 7 | Concurrency | **2–4 typical** | Per-session + aggregate usage in list |
| 8 | Push delivery | **FCM/APNs + WS fallback** | One accepted non-Tailscale cloud dependency |
| 9 | Model default | **Opus** | ⚠️ With #6 + #7 this stresses the Opus pool → usage guardrails are load-bearing (§3) |
| 10 | Terminal persistence | **Persistent server-side** | Durable shell + scrollback; active client owns size (§7) |
| 11 | File browsing | **First-class panel** | Daemon `fs.*` API; reuses SFTP plan (§8.1) |
| 12 | Markdown reader | **First-class, concurrent w/ chat** | Live-watched rendered pane side-by-side with conversation + select-to-cite (§8.2) |
| 13 | Markdown rendering | **Shared daemon WebView pipeline, all surfaces** | markdown-it + Shiki + KaTeX + DOMPurify in the daemon; scoped read-only WebView in native shells; one pipeline, not two native renderers (§8.3) |
| 14 | Mermaid diagrams | **mermaid.js in WebView + strict CSP** | Full fidelity; JS locked down (`securityLevel:'strict'`, CSP nonce); never `loose` (§8.3) |

### Watch-items (not decisions, but live risks)

- **Opus budget under autonomy.** The #6/#7/#9 combination is the single biggest cost
  risk. Usage tracking + warning threshold + soft-stop (§3) is the mitigation and must
  ship with the MVP, not after.
- **Agent-SDK billing split** could un-pause (§3) — would change the cost model overnight.

---

## 12. Pain-point → resolution traceability

| Original pain point | Resolved by |
|---|---|
| Session management opaque | §5 explicit session model + status |
| Sessions won't die | §5 process-group kill + reap |
| Viewport mismatch across devices | §1 reflowable structure + §6.4 no shared grid |
| Foldable open/close resize | §1 reflowable + §7 per-client PTY sizing |
| Monospace prose hard to read | §9 proportional font |
| Need raw terminal, mode-aware | §7 terminal channel + font/keyboard swap |
| Shift+Enter ≠ newline | §9 native text input |
| Can't paste/drag images & files | §6.5 attachments |
| Chrome tabs look identical | §9 session list with previews |
| Phone shows only title | §9 rich previews |
| Worktree state invisible | §8 worktree panel + §8.1 file browser |
| **Must keep Max subscription** | **§3 auth & billing constraint** |
| Get pulled back when Claude needs me / finishes | §6.7 push (FCM/APNs + WS) |
| Low-friction remote driving from phone | §6.6 mostly-autonomous + danger-list backstop |
| Don't silently exhaust Opus weekly budget | §3 usage guardrails (warn + soft-stop) |
| Durable shell across device switches | §7 persistent server-side terminal |
| Read a doc *and* chat about it concurrently | §8.2 live markdown reader + select-to-cite |
| Diagrams in docs/specs | §8.3 mermaid.js in WebView |

---

## 13. Research appendix — markdown rendering (2026-06-19)

Three parallel research tracks (SwiftUI, Compose, WebView) informed §8.3. Condensed
findings; treat library versions/stars as point-in-time.

**SwiftUI native:** Apple's `AttributedString`/`Text` is inline-only (no headings/tables/
code blocks) — not viable alone. Best native lib: **MarkdownView** (LiYanan2004, active,
swift-markdown parser, Highlightr + LaTeXSwiftUI integrated). **MarkdownUI** is now
maintenance-mode (successor: **Textual**). Mermaid: only **beautiful-mermaid-swift** (~6 of
20+ diagram types, drops HTML labels/clicks/styling). Native selection is crippled (iOS =
select-all only; enabling it disables custom `TextRenderer`s); no source-range mapping.
Streaming re-render flickers (MarkdownUI discussion #261 — unsolved).

**Compose native:** Best lib: **mikepenz/multiplatform-markdown-renderer** (active, full
KMP incl. iOS, GFM tables in core, Highlights for code, exposes `ASTNode.startOffset/
endOffset` for cite-mapping). No native mermaid exists in the Compose ecosystem at all; no
native LaTeX (only the dormant Markwon). Hard limit: can't have whole-doc selection **and**
LazyColumn virtualization simultaneously (verified KDoc: off-screen items dropped from
select-all).

**WebView (chosen):** Decisive advantages — mermaid works (native can't), select-to-cite is
*easier* (markdown-it `token.map`/`data-line` → JS bridge, the VS Code preview mechanism),
streaming is solved (morphdom/idiomorph, Vercel **Streamdown**, block caching). Zellij's
pains are specific to interactive-terminal-over-live-socket + focused input — they do **not**
transfer to a read-only document body. One residual risk: WebView content-process
suspension → blank view + scroll loss (standard handling: `onRenderProcessGone` /
`webViewWebContentProcessDidTerminate` → reload + restore scroll). It's the mainstream
pattern (Obsidian, VS Code preview, Notion, Joplin, Logseq, Zettlr). Security: markdown libs
don't sanitize by default (`marked` removed `sanitize` in v8; markdown-it ships `html:false`)
→ DOMPurify/`rehype-sanitize`; mermaid needs JS so keep it on but lock down with
`securityLevel:'strict'` + CSP nonce; Android avoid `addJavascriptInterface` (use
`addWebMessageListener`), `setAllowFileAccess(false)`; Apple `allowsContentJavaScript` on +
`WKScriptMessageHandler` bridge. KaTeX can be pre-rendered server-side (`renderToString`),
mermaid generally cannot without a headless browser.

Key sources: [MarkdownView](https://github.com/LiYanan2004/MarkdownView),
[Textual](https://github.com/gonzalezreal/textual),
[beautiful-mermaid-swift](https://github.com/lukilabs/beautiful-mermaid-swift),
[multiplatform-markdown-renderer](https://github.com/mikepenz/multiplatform-markdown-renderer),
[markdown-it](https://github.com/markdown-it/markdown-it), [Shiki](https://shiki.style/),
[KaTeX](https://github.com/KaTeX/KaTeX), [DOMPurify](https://github.com/cure53/DOMPurify),
[mermaid](https://github.com/mermaid-js/mermaid),
[idiomorph](https://github.com/bigskysoftware/idiomorph),
[VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview),
[mermaid XSS advisory CVE-2025-54881](https://github.com/advisories/GHSA-7rqq-prvp-x9jh).
