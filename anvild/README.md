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
- [ ] **M6** — event-log persistence (`events.ndjson`) + resume replay / `conversation.snapshot`
- [ ] **M7** — authoritative permissions + autonomy + danger list. **Finding:** `canUseTool`
      only fires for ops the CLI itself flags; to make the daemon's danger-list the universal
      gate (catch e.g. secret-path reads / out-of-worktree writes the CLI would allow), use a
      **`PreToolUse` hook** (fires on every tool). Broker + danger-list + permission round-trip
      are already built (`src/agent/permissions.ts`, `danger-list.ts`); M7 rewires them onto the hook.
- [ ] **M8** — budget tracker + warn/soft-stop (driver already feeds usage in)

Note: the daemon runs with `settingSources: []` so it does NOT inherit your ambient Claude
Code allow-rules — the daemon is meant to be the permission authority (arch §6.6). Trade-off:
the repo's `CLAUDE.md` isn't auto-loaded; project context injection is a later item.

## Layout

`src/auth` guard · `src/server` (http/dispatch/registry) · `src/push` registry ·
`src/budget` tracker (stub) · `src/session` `src/agent` `src/eventlog` `src/render` (M3+).
`bun:sqlite`/files for state land with M3.
