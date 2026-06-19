# anvild

The Anvil daemon — supervises Claude Code sessions and serves the Anvil protocol
(`../docs/plans/anvil-protocol.ts`, symlinked here as `protocol.ts`) over Tailscale.

See the plans in `../docs/plans/`: `anvil-native-architecture.md` (design),
`anvil-impl-1-daemon-core.md` (this component), `anvil-impl-INDEX.md` (all components).

## Run

```sh
bun install
# Auth (arch §3): subscription OAuth token, and NO metered API key in the env.
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"   # one-time
bun run start          # http://localhost:7701  (ws: /ws · health: /api/health)
bun run dev            # watch mode
bun test               # unit + integration (no token/network needed — uses a mock)
bun run typecheck
```

The daemon **refuses to start** if `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set
(they outrank the OAuth token and would meter billing — arch §3).

## Milestone status (impl plan 1)

- [x] **M1** — skeleton, auth/billing guard (§3), `GET /api/health` (`subscriptionAuthOk`)
- [x] **M2** — WS server, envelope dispatch, `cid` ack/error correlation, push register/unregister
- [x] **M3** — session registry + persistence (`sessions.json`) + per-session `seq`; `session.list` on connect; create/attach/detach/kill/set_model/set_autonomy
- [x] **M4** — fresh-worktree create (`git worktree add`) + process-group kill/reap (`detached` spawn, SIGTERM→SIGKILL group), worktree removal on kill
- [x] **M5** — Agent SDK streaming driver (`SDKMessage` → `ServerEvent`): `prompt.send`/`interrupt`,
      streaming `assistant.delta` → `assistant.message`, `tool.use`/`tool.result`, status
      transitions, `claudeSessionId` capture for resume, usage accounting. Verified live
      (`test/tools/live-prompt.ts`): plain reply + Bash tool execution both stream correctly.
- [x] **M6** — event-log persistence (`events.ndjson`) + resume: `session.attach{lastSeq}`
      replays `seq > lastSeq`, cold attach folds a `conversation.snapshot` (incl. `message.user`).
      Deltas/terminal events excluded from the durable log. Verified live (reconnect → snapshot + replay).
- [x] **M7** — authoritative permissions via a **`PreToolUse` hook** (fires on every tool, so the
      daemon's autonomy policy + danger list govern all tools — `canUseTool` alone only sees ops
      the CLI already flags). `permission.request`/`respond` round-trip + per-session `allow_always`.
      Verified live: a benign tool prompts under `prompt-all`; auto-allowed under `mostly-autonomous`.
- [x] **M8** — budget tracker: accumulates per-model USD-equivalent cost over a rolling 7-day
      window, converts to an hours-estimate (calibratable), emits `budget` on connect + per turn,
      `warn` threshold + one-shot soft-stop advisory. Verified live (budget event after each turn).

**Daemon core (M1–M8) complete.**

- [x] **Rendering pipeline (impl plan 2, daemon side)** — `src/render/markdown-pipeline.ts`:
      markdown-it (with `data-line` source attrs) → Shiki dual-theme highlighting → KaTeX math
      (`trust:false`) → DOMPurify (jsdom). Mermaid stays inert `<pre class="mermaid">` for the
      WebView. Loaded once at startup; `render()` stays sync. Verified live: daemon emits real
      Shiki/`data-line` HTML (CSS-var theming survives sanitization). `PassthroughRenderer`
      remains the fallback when no renderer is injected.

- [x] **Web client** (`web/`) — a browser client and the reusable rendering core for the
      future native shells. Vanilla TS + the daemon's server-rendered HTML; streaming via a
      live bubble that snaps to rendered HTML on completion; mermaid loads lazily; KaTeX is
      server-rendered (CSS only on the client). Session list + budget gauge, native textarea
      (Shift+Enter = newline), permission dialogs, reconnect + `session.attach` resume. Served
      by the daemon at `/` behind a CSP. Builds + serves; **interactive UI to be eyeballed in a browser.**

Remaining: streaming morph polish + select-to-cite in the web client; terminal + file
browser (plan 4); native clients (plans 3, 5); push/ops (plan 6).

## Web client

```sh
bun run build:web     # bundle web/src → web/dist
bun run start         # daemon serves the app at http://localhost:7701/
```

Over Tailscale (use from your phone + desktop):

```sh
tailscale serve --bg --https=443 http://localhost:7701
# then open https://<your-magicdns-host>/   (WS connects same-origin to /ws)
```

Rebuild with `bun run build:web` after editing `web/src`. Typecheck with `bun run typecheck:web`.

Note: the daemon runs with `settingSources: []` so it does NOT inherit your ambient Claude
Code allow-rules — the daemon is the permission authority (arch §6.6). Trade-off: the repo's
`CLAUDE.md` isn't auto-loaded; project-context injection is a later item.

## Layout

`src/auth` guard · `src/server` (http/dispatch/registry) · `src/push` registry ·
`src/budget` tracker (stub) · `src/session` `src/agent` `src/eventlog` `src/render` (M3+).
`bun:sqlite`/files for state land with M3.
