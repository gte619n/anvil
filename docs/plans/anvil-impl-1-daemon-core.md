# Anvil Implementation Plan — Daemon Core (`anvild`)
**Phase:** 1 | **Depends on:** protocol.ts | **Status:** draft

## 1. Scope & goal

Build the `anvild` daemon CORE: the keystone process that replaces *both* the Python status server (`scripts/session-status-server.py`) and Zellij (arch §4, §10.1). This plan covers exactly the load-bearing spine and nothing downstream of it.

**In scope:**
- Bun/TypeScript project skeleton; how `anvil-protocol.ts` is shared as the wire contract.
- WebSocket server (`Bun.serve`) implementing the §6 protocol: envelope dispatch, per-connection lifecycle, per-session monotonic `seq` assignment, `cid` ack/error correlation.
- Session supervisor: create (existing-dir vs fresh-worktree incl. `git worktree add`), supervise (own process group + liveness), kill (SIGTERM→SIGKILL process-**group** reaping, per the `da870d5` discipline), persist.
- Claude Agent SDK integration: one long-lived **streaming-input** `query()` per session; map `SDKMessage` stream → `ServerEvent` union; `canUseTool` permission bridge; resume via `claudeSessionId`; usage/cost from the `result` message.
- Auth/billing guard (arch §3): startup assertion `CLAUDE_CODE_OAUTH_TOKEN` set AND `ANTHROPIC_API_KEY` absent; `/api/health` → `subscriptionAuthOk`.
- Event-log persistence + resume (§6.4): on-disk per-session append log keyed by `seq`; replay on `session.attach`; `conversation.snapshot` fallback.
- Budget tracker (arch §3, decision #9): track Opus/Sonnet usage against the Max weekly pool; emit `budget` events with `warn` threshold + a soft-stop hook.
- Autonomy policy engine (§6.6): `mostly-autonomous` default with the danger-list backstop applied inside the `canUseTool` callback.

**Out of scope (separate plans):** the §8.3 markdown→HTML render pipeline; terminal channel (§7); `fs.*` file browser/reader/watch (§8.1/§8.2); attachments REST (§6.5); push (§6.7); native clients (§9). This plan defines the *seams* (interfaces, `ServerEvent` emission points) those plans plug into but implements none of them.

**Goal / definition of done:** drive a real Claude session from `websocat` + a tiny CLI — create a session, send a prompt, watch `assistant.delta`/`tool.use`/`tool.result`/`result` stream with correct `seq`, hit a danger-list `permission.request` and answer it from a second connection, reconnect with `lastSeq` and get exact catch-up, see `budget` events tick, and `session.kill` a session and prove (filesystem-level) that no orphan process group remains.

## 2. Decisions inherited (cite arch-doc § and protocol types)

- **Daemon language: TypeScript/Bun** (arch §11 decision #2). In-process Agent SDK; no separate runtime hop.
- **Auth is a hard constraint** (arch §3 rules 1–4): always go through the Agent SDK (never raw Messages API); auth via `CLAUDE_CODE_OAUTH_TOKEN`; assert `ANTHROPIC_API_KEY` absent at startup; never `--bare`. Surfaced by `rest.HealthResponse.subscriptionAuthOk`.
- **Default model Opus** (arch §3, §11 #9) → `Session.model` defaults `"opus"`; per-session override via `SessionSetModelCmd`. This makes the budget tracker load-bearing, shipped in the MVP, not later (arch §3, §11 watch-items).
- **Mostly-autonomous default with danger-list backstop** (arch §6.6, §11 #6) → `AutonomyPolicy` defaults `"mostly-autonomous"`; the danger list is the only thing between autonomy and an unattended `rm -rf`, so it is conservative and auditable.
- **Per-session worktree choice** (arch §5, §11 #4) → `SessionSource = "existing-dir" | "fresh-worktree"`; `Worktree { repoRoot, branch, base }`.
- **Daemon owns lifecycle end-to-end** (arch §5): own process group per session; crash → `status: "error"`, no silent zombies; kill = SIGTERM-group → wait → SIGKILL-group → reap → worktree cleanup. Inherits `da870d5`'s rigor (`Popen(start_new_session=True)` + `os.killpg`).
- **Server is source of truth; resume via per-session monotonic `seq`** (arch §6.1, §6.4) → every session-scoped `ServerEvent` carries `SessionScoped { sessionId, seq }`, `seq` starts at 1.
- **Correlated commands** (protocol `Correlated.cid`) → reply `AckEvent { cid }` or `CommandErrorEvent { cid?, message }`.
- **Protocol version 1** (`PROTOCOL_VERSION`); every `Envelope.v = 1`.
- **Budget shape is fixed** (`Budget { opus, sonnet, windowResetsAt, warn }`, `PoolUsage { usedHrs, limitHrs }`).
- **Markdown is rendered by the daemon** (arch §8.3): the core emits `RenderedMarkdown { source, html }` everywhere a client reads prose. The core treats the renderer as an injected `MarkdownRenderer` interface; the actual pipeline is the §8.3 plan. **Decision for this plan:** ship a trivial pass-through renderer (`html = escapeHtml(source)`, `source` preserved) so the core is fully testable now and the real pipeline drops in behind the seam.

## 3. Project layout & tooling (Bun/TS, file tree)

Runtime **Bun ≥ 1.2** (native WebSocket server, `Bun.spawn` with process-group control, `bun:sqlite`, first-class TS, fast startup). The SDK's `executable: "bun"` option is supported, so the agent subprocess runs under the same runtime.

```
anvild/
├─ package.json
├─ tsconfig.json                 # "strict": true, "module":"esnext","moduleResolution":"bundler"
├─ bunfig.toml
├─ .env.example                  # CLAUDE_CODE_OAUTH_TOKEN=...  (ANTHROPIC_API_KEY intentionally absent)
├─ protocol.ts                   # symlink → ../docs/plans/anvil-protocol.ts (single source of truth)
├─ src/
│  ├─ main.ts                    # entrypoint: startup guard, Bun.serve, wiring
│  ├─ config.ts                  # env, paths (~/.anvil), port, thresholds
│  ├─ auth/guard.ts              # §3 startup assertion + subscriptionAuthOk()
│  ├─ server/
│  │  ├─ http.ts                 # Bun.serve: WS upgrade + REST (/api/health stub)
│  │  ├─ connection.ts           # per-connection state: attached sessions, cursor map
│  │  ├─ dispatch.ts             # ClientCommand → handler; cid ack/error
│  │  └─ broadcast.ts            # fan-out a ServerEvent to attached connections
│  ├─ session/
│  │  ├─ supervisor.ts           # registry: create/get/list/kill; persistence
│  │  ├─ session.ts              # one Session: state machine, SDK driver, seq counter
│  │  ├─ worktree.ts             # git worktree add/remove/status (shells out)
│  │  └─ procgroup.ts            # spawn-in-own-group + SIGTERM→SIGKILL group reaper
│  ├─ agent/
│  │  ├─ driver.ts               # wraps SDK query() in streaming-input mode
│  │  ├─ map.ts                  # SDKMessage → ServerEvent[] translator
│  │  ├─ permissions.ts          # canUseTool: autonomy policy + danger list
│  │  └─ danger-list.ts          # the reviewable danger-pattern table
│  ├─ eventlog/{log.ts,snapshot.ts}
│  ├─ budget/{tracker.ts,pools.ts}
│  ├─ render/markdown.ts         # MarkdownRenderer interface + passthrough impl (seam)
│  └─ util/{envelope.ts,ids.ts}
└─ test/{unit,integration,tools}
```

Persistence root `~/.anvil/`: `sessions.json` (durable registry), `budget.json`, `sessions/<id>/events.ndjson` (append-only, ordered by seq) + `meta.json` (claudeSessionId, lastSeq, model, autonomy).

`package.json` scripts: `start`, `dev` (`bun --watch`), `test` (`bun test`), `typecheck` (`bunx tsc --noEmit`). Dev dep `@biomejs/biome`.

**protocol.ts sharing:** symlink `anvild/protocol.ts → ../docs/plans/anvil-protocol.ts`; `tsconfig` `paths` alias `@protocol`. One copy, the daemon imports it directly.

## 4. Components

### 4.1 Auth guard (`auth/guard.ts`) — arch §3
At startup assert `CLAUDE_CODE_OAUTH_TOKEN` non-empty AND `ANTHROPIC_API_KEY` undefined; **also reject `ANTHROPIC_AUTH_TOKEN`** (it outranks the OAuth token in precedence). Violation → fatal log + `process.exit(1)`. `subscriptionAuthOk()` feeds `rest.HealthResponse`. The agent subprocess env is built **allow-list style** (`{ CLAUDE_CODE_OAUTH_TOKEN, PATH, HOME, … }`) because the SDK `env` option **replaces** rather than merges — so no stray key can leak in.

### 4.2 HTTP/WS server (`server/*`) — arch §6.1–6.3
`Bun.serve({ websocket, fetch })`. `fetch` upgrades `/ws` and serves `/api/health`. Each `Connection` holds attached `sessionId`s + a per-session delivered cursor. `dispatch.ts` parses each frame, checks `Envelope.v === 1`, narrows on `type` against `ClientCommand`, routes, and replies `AckEvent`/`CommandErrorEvent` (same `cid`). `broadcast.ts` fans a `ServerEvent` to every connection attached to that session. Unhandled-in-phase-1 commands (`fs.*`, `terminal.*`, `push.register`) return a typed `CommandErrorEvent { message: "unsupported in phase 1" }` so the contract stays whole.

### 4.3 Session supervisor (`session/*`) — arch §5
- **`supervisor.ts`** — registry: `create/get/list/kill/restoreFromDisk`; owns `sessions.json`; emits `session.created/updated/deleted` + connect-time `session.list`.
- **`session.ts`** — one live session: the `Session` row, the **per-session `seq` counter** (monotonic from 1, persisted), `AgentDriver`, `EventLog`, `SessionStatus` state machine. Single `emit(event)` method that (a) assigns `seq`, (b) appends to the log, (c) broadcasts — the **only** place `seq` is minted.
- **`worktree.ts`** — fresh-worktree: branch `anvil/<slug>-<short-id>`, `git worktree add -b <branch> <path> <base>`; `gitStatus(cwd): GitStatus`; on kill `git worktree remove --force` + retries → rmtree + `git worktree prune` fallback (port Python lines ~596–617).
- **`procgroup.ts`** — spawn agent in its **own process group**; kill = SIGTERM to `-pgid`, wait ~2 s, SIGKILL to `-pgid`, reap; unexpected exit → `status:"error"` + `SessionErrorEvent{fatal:true}`. Direct heir of `_run_raw`/`_kill_pids`.

### 4.4 Agent driver (`agent/*`) — arch §2, §6.2, §6.6
- **`driver.ts`** — wraps SDK `query()` in **streaming-input mode** (`prompt` = `AsyncIterable<SDKUserMessage>` fed from an internal queue; unlocks `interrupt()`, mid-session `setModel`/`setPermissionMode`, durable multi-turn). Options: `{ model, cwd, resume: claudeSessionId?, includePartialMessages: true, permissionMode: "default", canUseTool, executable: "bun", env: <oauth-only> }`. Captures `session_id` → persists as `Session.claudeSessionId`.
- **`map.ts`** — pure `SDKMessage → ServerEvent[]` translator (no I/O; fixture-testable): `stream_event/text_delta` → `AssistantDeltaEvent`; final `assistant` → `AssistantMessageEvent{blocks}` (+ `ToolUseEvent`, status→`running_tool`); `tool_result` → `ToolResultEvent`; token deltas → `UsageEvent`; `result` → `ResultEvent{stopReason,usage}`, status→`idle`, feed budget.
- **`permissions.ts`** — `canUseTool(tool, input, {signal, suggestions})`. `mostly-autonomous`: danger-list classify → not dangerous → `{behavior:"allow", updatedInput:input}` (no prompt). To prompt: mint `RequestId`, emit `PermissionRequestEvent`, status→`awaiting_permission`, **return a Promise resolved when `PermissionRespondCmd` arrives**. `allow_always` persists a rule + echoes a `localSettings` suggestion in `updatedPermissions` so the SDK stops re-asking. Callback may park indefinitely — the "answer from your phone later" UX.

### 4.5 Event log + resume (`eventlog/*`) — arch §6.4
`append(event)` writes one NDJSON line per session-scoped event; `since(lastSeq)` streams `seq > lastSeq`. On `session.attach{lastSeq}`: if log covers it → replay; else build `ConversationSnapshotEvent`. The log is the source of truth.

### 4.6 Autonomy / danger list (`agent/danger-list.ts`) — arch §6.6
`isDangerous(tool, input): {danger, reason?}` matching: `Bash` `rm -rf`, `git push --force`/`-f`, `git reset --hard` on shared branches, writes outside the worktree/cwd, credential paths (`.env`, `~/.ssh`, `**/credentials*`), destructive package/db verbs (`drop database`, `npm publish`, `DELETE FROM`). Every classification logged for audit. One reviewable table.

### 4.7 Budget tracker (`budget/*`) — arch §3, decision #9
Rolling weekly window of Opus vs Sonnet usage vs the Max pool; emit `BudgetEvent` on connect + change. Subscription bills in *hours* but the SDK reports tokens/cost → a calibratable token/cost→hours estimator per model (`pools.ts`: Max-5x ≈ 240 Sonnet / 20 Opus; Max-20x ≈ 480 / 40). `warn = used ≥ 0.8 × limit`. **Soft-stop hook** at ~0.95 fires `softStop(sessionId)` → advisory `SessionErrorEvent{fatal:false}` + optional auto-downgrade/pause. Estimator isolated so the paused billing-split (arch §3) can be re-pointed.

### 4.8 Render seam (`render/markdown.ts`) — arch §8.3 (interface only)
`interface MarkdownRenderer { render(source): RenderedMarkdown }` + passthrough impl. The §8.3 plan replaces it. Nothing in core builds HTML directly.

## 5. Implementation steps (M1–M8, each independently testable)

- **M1** — Skeleton + auth guard + `/api/health`. *Test:* refuses to start with `ANTHROPIC_API_KEY` set; `subscriptionAuthOk:true` with only OAuth token.
- **M2** — WS envelope + dispatch + cid. *Test:* unknown frame → `command.error`; no-op command with `cid` → matching `ack`.
- **M3** — Session registry + persistence + seq (existing-dir). *Test:* two sessions, independent seq from 1; restart restores `session.list`.
- **M4** — Fresh-worktree + kill discipline. *Test:* kill reaps the **entire process group** (`pgrep -g`) and removes the worktree.
- **M5** — Agent driver happy path (fixtures then real SDK). *Test:* `prompt.send` yields ordered `thinking → delta* → message → result → idle`, ascending seq.
- **M6** — Event log + resume/snapshot. *Test:* reconnect with `lastSeq=N` → exactly events `> N`; no `lastSeq` → one snapshot.
- **M7** — Permissions + autonomy + danger list. *Test:* benign tool auto-allows; `rm -rf` emits `permission.request`, blocks, `deny` from a second connection unblocks.
- **M8** — Budget tracker + soft-stop. *Test:* `warn` flips at 80%, soft-stop advisory at 95%, `/api/health.budget` matches.

CI runs `bun test` (unit + integration with a **mock SDK**, no token needed); a manual smoke runs M5/M7 against the real SDK.

## 6. Dependencies

| Lib | Version (2026) | License | Why |
|---|---|---|---|
| **Bun** | ≥ 1.2 | MIT | Native WS, `Bun.spawn`, fast TS |
| **`@anthropic-ai/claude-agent-sdk`** | latest 0.1.x (renamed from `claude-code-sdk` late 2025) | Anthropic SDK | The lever; **pin + lockfile — surface is moving** |
| `@biomejs/biome` (dev) | latest | MIT/Apache-2.0 | lint+format |

Deliberately NOT here: markdown/render libs (§8.3), PTY (§7), upload libs (§6.5). Core = Bun + SDK. **Auth:** one-year token from `claude setup-token` as `CLAUDE_CODE_OAUTH_TOKEN`; needs Pro/Max/Team/Enterprise; never `--bare`.

## 7. Key data flows
- **Prompt round-trip:** `PromptSendCmd` → ack → `message.user` → driver pushes `SDKUserMessage` → `assistant.delta`* → `assistant.message` (+`tool.use`) → `result`, idle, budget updated. Every event via `session.emit()`.
- **Create→stream→result:** `session.create` → (worktree add) → spawn in own group, OAuth-only env → `session.created` → prompt drives the flow.
- **Reconnect/resume:** `session.attach{lastSeq}` → replay `seq>lastSeq` or one snapshot; both connections may stay attached (no viewport binding).
- **Permission:** `canUseTool` → danger? emit request, park; `permission.respond` from any device resolves it; `allow_always` persists.
- **Kill:** SIGTERM group → wait → SIGKILL group → reap → worktree remove → delete state → `session.deleted`. Verified by filesystem.

## 8. Testing & verification
A `test/tools/anvil-cli.ts` (Bun WS client) + raw `websocat`. Auth refusal; cid error; seq isolation; **kill-discipline regression test** (the orphan-grandchild bug from `da870d5`); offline `map` fixture tests; resume tail vs snapshot; danger-list table tests + deny-from-second-connection; budget warn/soft-stop.

## 9. Risks & open questions
- **SDK surface drift (high).** `@anthropic-ai/claude-agent-sdk` is moving. *Confirmed:* `query({prompt,options})`, streaming-input via `AsyncIterable<SDKUserMessage>`, `Query.interrupt()/setPermissionMode()/setModel()`, `canUseTool(...) → {behavior:"allow",updatedInput,updatedPermissions?} | {behavior:"deny",message,interrupt?}`, `includePartialMessages`→`stream_event`, `resume`/`session_id`, `result` carrying `usage`/`total_cost_usd`/`modelUsage`/`num_turns`, `executable:"bun"`, `env` **replaces**. *Mitigation:* pin, lockfile, isolate all SDK contact in `driver.ts`+`map.ts`, fixture-based map tests.
- **`canUseTool` requires streaming-input mode (medium).** We use it anyway; M7 is the proof. *Open:* whether TS also needs a no-op `PreToolUse` hook to keep the stream open.
- **Auth precedence foot-gun (mitigated).** `ANTHROPIC_AUTH_TOKEN` (#2) and `ANTHROPIC_API_KEY` (#3) outrank `CLAUDE_CODE_OAUTH_TOKEN` (#5); guard rejects both; SDK env built allow-list-style.
- **Billing model could shift (tracked, arch §3).** Estimator isolated.
- **Hours-vs-tokens mapping (medium).** Heuristic; calibrate `pools.ts` against observed `/status`.
- **`Bun.spawn` process-group semantics (medium).** Confirm reliable killable group + `pgid`; else posix-spawn shim. M4 is the gate.

## 10. Cross-references
- Architecture §2, §3, §5, §6.1–6.4/6.6, §10.1, §11 (#2/#4/#6/#9).
- Protocol: `Envelope`, `SessionScoped`, `Session`, `Budget`, `ServerEvent`/`ClientCommand`, `AckEvent`/`CommandErrorEvent`, `PermissionRequestEvent`/`PermissionRespondCmd`, `ConversationSnapshotEvent`, `RenderedMarkdown`, `rest.HealthResponse`.
- Predecessor to replace: `scripts/session-status-server.py` (process-group reaping, filesystem-verified delete, git-status idioms, worktree-remove fallback). Discipline origin commit `da870d5`.
- Verified SDK/auth sources (2026): [Agent SDK TS reference](https://code.claude.com/docs/en/agent-sdk/typescript), [Handle approvals](https://code.claude.com/docs/en/agent-sdk/user-input), [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [Streaming vs single](https://docs.claude.com/en/docs/agent-sdk/streaming-vs-single-mode), [Authentication/precedence + setup-token](https://code.claude.com/docs/en/authentication).
- Downstream seams: §8.3 (`MarkdownRenderer`), §7 (`terminal.*`), §8.1/§8.2 (`fs.*`), §6.5 (attachments), §6.7 (push).
