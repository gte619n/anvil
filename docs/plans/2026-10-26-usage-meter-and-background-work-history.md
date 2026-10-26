# Usage meter, background sub-agents, waiting on CI, and crash-safe seqs: session history

**Dates:** 2026-10-25 to 2026-10-26
**Branch:** `ccr-66abb7e6-uhdpz4`. Work merged to `main` as the squash PR **#228** (`b4af0e0`); the
follow-up usage probe is `fc168d6` on the branch.
**Status:** shipped in #228 except the usage-meter data source, which is **broken under the daemon**
(see §5) and awaiting a probe run on a real host.

This records what was asked, what was found, what changed and why, and what is still open, so the next
person (or agent) doesn't have to reconstruct it from commits.

---

## 1. Plan-usage meter (commit `d564e17`, in #228)

**Ask:** see how much of the account's token allowance is used, in real time, across all anvil sessions,
account-wide rather than per session. Does the Claude API offer this?

**Findings at the time:**
- The public Admin API Usage & Cost endpoints only cover metered API-key orgs. Anvil refuses metered keys
  (§3 guard), so they don't apply. Pro/Max plans have no documented public usage API.
- Plan limits are percentages of the 5-hour and weekly windows, not token counts. Anthropic doesn't
  publish token caps for the plans.
- Anvil already called the Agent SDK's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` after
  each turn and broadcast a `budget` event, but the web client discarded it (`srv.budget` stored, "no
  longer surfaced in the UI").
- Weak points: one gauge per daemon (flipped between roster accounts), updated only after a turn,
  duplicated per fleet member, and dependent on an experimental SDK method.

**Change:**
- `RateLimitTracker` (`src/budget/tracker.ts`) keys gauges and the weekly soft-stop latch by roster account
  id. `snapshot()` keeps the old "latest reading" semantics that autopilot and teams gate on. A legacy
  `budget.json` is only the snapshot fallback.
- The supervisor polls each account every 5 min through one live driver (`AgentDriver.readUsage()`) while a
  client is attached. `ANVIL_BUDGET_POLL_MS` tunes it (0 disables). Removed accounts are dropped and labels
  are stamped at send time.
- Protocol (additive, still v4): `Budget.accountId` / `accountLabel`, `BudgetEvent.budgets`.
- Web: `web/src/usage.ts` merges gauges across servers (newest reading per account) and renders 5h and
  weekly bars above **Loops**. Bars turn amber at 80% and red at 95%, and readings older than 15 min are
  dimmed.

**Outcome:** the meter never appears in practice. See §5.

---

## 2. Background sub-agents out of sync (commits `957a95d`, `2fd3eb7`, in #228)

**Ask:** when a session fans out to sub-agents and waits on them, the UI doesn't always stay in sync,
especially for long runs with the phone idle or the desktop closed.

**Findings:**
- The **foreground** path was sound: `Supervisor.resume()` re-sends live status, pending
  permission/question cards and the live sub-agent snapshot, and a settled row survives reload via
  `tool.result.subagent`.
- **Background** sub-agents (`run_in_background`, or backgrounded mid-run) were broken, read from the
  bundled CLI binary:
  1. Their launching tool.result is an instant `async_launched` ack ("Async agent launched
     successfully…"), and anvil settled the row as **done** at launch. The client's `mergeView` never
     regresses a settled row, so nothing could correct it.
  2. With streaming input (anvil's mode, `inputClosed === false`), the CLI does **not** hold back `result`
     while background tasks run. Anvil idled the session and sent "your turn" while work continued.
  3. Anvil ignored `task_started` / `task_updated` / `task_notification`.
  4. When agents finish, the CLI starts a follow-up turn **by itself** (no `prompt()`), and anvil showed it
     as idle.
  5. A client that slept through it all reloaded the wrong "done" state.

**Change:**
- `map.ts`: new signals for `task_started` / `task_updated` / `task_notification`;
  `asyncLaunchedToolIds` (structured `tool_use_result.status` first, ack text as fallback); and
  `signalsTurnActivity` (main-thread activity, or `session_state_changed: running`).
- `SubAgentTracker`: a `background` flag. The launch ack no longer settles a background agent;
  `task_notification` does. A new user turn keeps still-running background agents, and their settlements
  are queued for persistence.
- Protocol (additive): `SubAgentView.background`, a **durable** seq'd `subagent.settled` event, and a
  `subagent_settled` snapshot kind. It is folded by `eventlog/log.ts`, mirrored offline (`mirror.ts`),
  and fanned out to shadow subscribers.
- Driver: sets `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` and flips idle to thinking on unprompted
  main-thread activity. Supervisor: suppresses the "your turn" push while a background agent runs.
- Web: rows are matched by id across the whole transcript (no duplicates; settles land on the original
  row), with a "Background tasks running" block title. Merge rules live in `web/src/subagentView.ts`.
- Restart: `EventLog.orphanedBackgroundAgents()` lets `restore()` persist a `canceled` settle for agents
  that died with the old CLI process, exactly once.

---

## 3. "I'll report when it completes" loses track (commit `2d50e6d`, in #228)

**Ask:** sessions say "I'll wait until CI finishes" and then lose track, so the user has to ask for status.
Example: an Android APK release ("I'll report the moment it completes") with the session showing idle.

**Findings:** three ways an agent can "wait":
1. It promises to wait but starts nothing. The turn ends and nothing can resume it. This needs model
   guidance; no runtime fix exists.
2. It starts a background shell (`Bash` with `run_in_background`, or `Monitor`). The CLI reports these as
   `local_bash` tasks, notifies on exit and wakes the model. Before this change anvil only tracked
   `Agent`/`Task`.
3. It blocks in a foreground poll and hits the Bash tool timeout.

**Change:**
- Background shell tasks reuse the background sub-agent machinery. A main-turn `Bash`/`Monitor` tool_use
  is an inert `shell_use` candidate. It becomes a `kind: "shell"` row only if its result shows it went to
  the background: structured `tool_use_result.backgroundTaskId`, else the "Command running in background"
  trailer. `Monitor` always counts as background. The shell's output still renders. Protocol (additive):
  `SubAgentView.kind`.
- `AgentDriver.TOOLING_GUIDANCE` gains a **WAITING** rule: never end a turn promising to wait or report
  back unless a background watcher is running (`gh run watch <id> --exit-status`, or a bounded poll with
  `run_in_background`). Otherwise say plainly that no notification will come. This is guidance, not a
  guarantee.

---

## 4. Seq reuse after an unclean restart (commit `486c93d`, in #228)

**Bug:** the session registry's `lastSeq` is flushed on a 100ms debounce, but `restore()` trusted it.
After a hard crash the daemon re-minted seqs:
- durable events got seqs already in the log (duplicates; the offline mirror, keyed by seq, overwrote
  events);
- a client whose watermark came from a transient `assistant.delta` seq (never persisted) delta-resumed
  **past** the new events and silently lost them.
A code comment wrongly claimed "restart reconciles them anyway".

**Change:** `wrap()` floors the seq at `EventLog.maxSeq()`. `shutdown()` writes a `clean-shutdown` marker
after the final flush, and `restore()` consumes it. With no marker (a crash, or the first boot on this
build), each session skips `SEQ_CRASH_GAP` (10,000) ahead. Seq gaps are already legitimate (transient
frames leave them), so clients are unaffected. Clean restarts such as self-updates skip nothing. Three
regression tests fail on the old code and pass on the new.

**Known residue:** logs that already got duplicate seqs from past crashes aren't repaired. The first
restart after deploying jumps 10k once.

---

## 5. Usage meter shows nothing: root cause (commit `fc168d6`, open)

**Report:** after updating and finishing a turn, the meter never appears.

**Root cause** (read from the bundled CLI binary, then confirmed by running the SDK call here):
- The usage call returns `rate_limits_available = Co() && DC()`. `DC()` requires the `user:profile` scope.
- When the token comes from `CLAUDE_CODE_OAUTH_TOKEN`, the CLI sets scopes to
  `CLAUDE_CODE_OAUTH_SCOPES` if present, else **`["user:inference"]`**. So under the daemon the call always
  answers `rate_limits_available: false`, and `rate_limits` is null.
- This predates #228. The pre-existing per-turn read never produced data either.
- `subscription_type` is likewise null unless `CLAUDE_CODE_SUBSCRIPTION_TYPE` is set (cosmetic).

**What the CLI does have:** every API response carries `anthropic-ratelimit-unified-5h-utilization` /
`-7d-utilization` and reset headers. The CLI parses them (`gFi`), and when the scope check passes but
`GET /api/oauth/usage` fails, it falls back to these header values (status `"seeded"`). So setting
`CLAUDE_CODE_OAUTH_SCOPES="user:inference user:profile"` should yield at least the 5h and weekly numbers
[Likely, not yet verified with a real token]. `rate_limit_event` messages carry utilization only near a
limit, so they can't drive a meter.

**Probe:** `anvild/scripts/usage-probe.ts` runs the daemon's exact SDK call after one tiny Haiku turn, as
(A) the daemon runs today and (B) with the profile scope declared, then (C) calls `GET /api/oauth/usage`
directly. A dummy-token run here confirmed A reports `false` and B reports `true`. Values were null only
because the dummy token can't authenticate. The 429 from C reflects this container's egress, not the
endpoint's verdict on a real token.

Run on a daemon host, from the canonical checkout:
```
cd anvild && (set -a; . ~/.config/anvil/env; bun scripts/usage-probe.ts)
```

**Decision tree:**
- B shows numbers: set `CLAUDE_CODE_OAUTH_SCOPES="user:inference user:profile"` in `buildAgentEnv`
  (`src/agent/env.ts`), and render a "no reading yet" state instead of hiding the widget.
- C is HTTP 200: the token really has profile scope, so the Opus/Sonnet weekly split is available too.
- B is still null: a setup-token can't supply this. Another source is needed (e.g. reading the unified
  rate-limit headers outside the CLI).

Risk to check when applying the fix: declaring `user:profile` may make the CLI call other profile-gated
endpoints that then fail with an inference-only token [Guessing]. Watch the daemon log after enabling it.

---

## 6. Open items

| Item | Notes |
|---|---|
| Usage meter data source | Blocked on the §5 probe output from a real host. |
| Meter hidden until the first reading | Show a "no reading yet" state, and read on client connect. |
| Native apps | iOS/Android bundle the web UI. Rows, `subagent.settled` rendering and the meter need an app rebuild. |
| Teams and background work | A member whose turn ends with background agents still running counts as finished for the team's concurrency cap. |
| Pre-existing duplicate seqs | Logs corrupted by past crashes aren't repaired. |
| CLI behavior coupling | The "no held-back result in streaming mode", `async_launched`, `backgroundTaskId` and scope-gating findings come from the CLI bundled with `@anthropic-ai/claude-agent-sdk ^0.3.183`. An SDK bump can change them; re-check before relying on them. |
| Live verification | None of §2–§5 was exercised against a real subscription session; this environment has no token. Coverage is unit tests, a driver end-to-end test with a fake query, and jsdom tests of the real web bundle. |
| Test environment | `captureGitDiff` and `killGroup` fail in the cloud container with and without these changes. |

## 7. Branch notes

#228 squash-merged every commit on this branch. A force-push to restart the branch from `main` was denied
by auto mode, so `main` was **merged** into the branch instead (`c5e8acc`, tree identical to `main`), and
the probe was committed on top (`fc168d6`). A PR from this branch contains only post-#228 work.
