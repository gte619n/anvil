# CLAUDE.md Reflection — post-PR learning loop

- **Status:** Approved (critique round 1 logged) · **Owner:** Evan Ruff · **Branch:** `memory-management`
- **Created:** 2026-08-12 · **Supersedes/extends:** N/A (first memory-management slice)

## 1. Objective & non-goals

When a user clicks **Create PR** in a session, the knowledge accumulated during that session —
deployment quirks, build/test commands, code-style conventions, gotchas the agent hit — currently
evaporates. After this feature, the moment the PR is created the session's own agent reviews the
work, and if it finds durable, project-wide learnings not yet in `CLAUDE.md`, it interviews the
user about each candidate (description + exact text, accept/skip) and amends the just-opened PR
with the accepted additions. If nothing clears the bar, it says so in one sentence and stops.

**Non-goals** (each an explicit decision, see §9):
- **PRs created in the side-panel terminal do not trigger.** A user typing `gh pr create` into
  the PTY produces `terminal.data` bytes, not tool events — out of scope by design. (Agent-run
  `gh pr create` in Bash DOES trigger — that is the git panel PR button's actual mechanism, see
  §4 and critique round 2.)
- **The autonomous dev-pipeline (P6 Transfer) is untouched.** It runs unattended; an interview
  there has no one to answer.
- **No daemon-side enforcement of the guardrails.** "Only touch CLAUDE.md, no new PR" is
  prompt-level, part of the trust model (the session agent is already trusted with the worktree —
  consistent with the Tailscale-boundary philosophy).
- **No hub-synced or per-session toggle.** Gating is a per-host env flag only.

## 2. Context

First slice of the memory-management effort: closing the loop between what a session learns and
what the next session knows. Prior art in-repo: the `/compact` daemon-initiated turn pattern
(`supervisor.ts` prompt handling), the AskUserQuestion broker (`agent/questions.ts`, arch §6.6),
and the git projection domain (`session/git-projection-service.ts`, arch §8). Decisions were made
in the 2026-08-12 planning interview and the critique interview logged in §9.

## 3. Inputs & scope

- **In scope:** `anvild/src/session/claude-md-reflection.ts` (new), `anvild/src/session/supervisor.ts`
  (`gitOp` hook + guard), `anvild/test/unit/claude-md-reflection.test.ts`.
- **Out of bounds:** `GitProjectionService` (the hook lives above it, in the Supervisor delegate),
  the protocol (no new wire types — the interview rides the existing `question.request`/
  `question.respond` flow), all clients (no UI changes).
- **Available inputs:** the session's own live agent context (full transcript), its Edit/Bash/git
  tools, the AskUserQuestion tool, the repo-root `CLAUDE.md`.
- **Assumptions log:**
  - The session agent's context window still contains enough of the session to reflect on —
    unconfirmed for very long sessions that were `/compact`ed; accepted (the compacted summary
    is what the agent has, and is usually where durable learnings survive anyway).
  - `driver.prompt()` injection while a turn is in flight queues safely — confirmed by
    `AgentDriver.prompt` (input-stream push).

## 4. Design

No new pipeline. The session's live agent already holds the transcript, the interview UI, and the
tools — so the daemon injects **one scoped follow-up turn** into the same session right after a
successful PR creation, mirroring `/compact` (a `driver.prompt()` with no `message.user` echo;
the agent's own reply announces the automated step).

- `claude-md-reflection.ts` — `claudeMdReflectionEnabled()` (env gate `ANVIL_CLAUDEMD_REFLECT`,
  on by default, off only for `0`/`false`/`off`/`no`) and `CLAUDE_MD_REFLECTION_PROMPT` (the
  injected turn: silent review → read CLAUDE.md (propose creating it if absent) → nothing-to-add
  short-circuit → AskUserQuestion interview (≤4 questions per call, batch if more) → for accepted
  items only: edit + `git add CLAUDE.md` + commit + push onto the open PR → confirm with link;
  guardrails: no new PR, no file but CLAUDE.md, no unrelated pushes).
- **Trigger, primary path — the PR-activity watcher.** The web git panel's PR/Merge buttons do
  NOT send the protocol's `create-pr`/`merge-pr` git commands: they PROMPT the session agent
  (web `panel.ts` `STAGE_PROMPT`) to run `gh pr create` / `gh pr merge` itself. So the daemon
  detects the PR step from the session's own tool traffic: `PrActivityWatcher` (one per session,
  fed from the emit sink in `Supervisor.wrap`) observes `tool.use`/`tool.result`/`result` events.
  - Bash `tool.use` matching `gh pr create` whose `tool.result` succeeds AND contains a
    `/pull/<n>` URL arms a reflection — **deferred to the turn's `result` event**, because the
    Merge button's single turn may run create AND merge; reflecting on an already-merged PR
    would tell the agent to push to a deleted remote branch. A same-turn successful
    `gh pr merge` cancels the pending reflection and (any turn) resets the PR-cycle guard.
- **Trigger, secondary path — the protocol command.** `supervisor.ts` `gitOp`, after delegating
  to `GitProjectionService`:
  - `create-pr && result.ok` → `maybeReflectOnClaudeMd(sessionId)`. Gated on `ok` alone: `url`
    is regex-scraped from `gh` output and a miss must not silently drop the reflection.
  - `merge-pr && result.ok` → clear the session's reflected flag (a merge rolls the worktree onto
    a `_followup` branch — a new PR cycle begins).
  Kept for protocol completeness (a client MAY send these ops); the once-per-cycle guard dedupes
  if both paths ever fire for the same PR.
- `maybeReflectOnClaudeMd` guards, in order: env gate → auth-degraded (mirrors `prompt()`) →
  once-per-PR-cycle (`reflectedSessions` in-memory Set) → session exists → **plain interactive
  sessions only** (skip `teamRole` and `workUnitId` sessions — nobody is watching those cards).
  Entire body try/caught: no failure may propagate into the `git.result` the client awaits.

## 5. Deliverables & phases

Single phase (shipped on this branch):

| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Env gate + reflection prompt module | ✅ | ✅ | pending PR |
| `gitOp` trigger + PR-cycle guard + session-type gate | ✅ | ✅ | pending PR |
| Unit suite (8 tests) | ✅ | ✅ | pending PR |

**Acceptance:** clicking Create PR on a plain interactive session with a usable token injects
exactly one reflection turn; a re-click does not; a merge followed by a new create-pr does; team/
work-unit sessions, env-off, degraded auth, and failed PR creation never do; a throw inside the
hook never corrupts the `git.result` reply.

## 6. Constraints

- Must never break or delay the `git.result` reply (the client is waiting on it synchronously).
- No app-layer auth / no new trust surfaces (Tailscale boundary stands).
- Cost: on-by-default means every PR spends one agent turn even to conclude "nothing to add" —
  accepted; the off-switch is the mitigation.
- No protocol changes (older clients unaffected; the interview uses existing events).

## 7. Edge cases & failure modes

| Scenario | Expected behavior | Covered by |
|---|---|---|
| Crash/restart mid-interview | Learnings lost; trigger does not re-fire (create-pr already happened). Accepted. | documented only |
| Daemon restart between PRs | In-memory guard re-arms — a re-click after restart may re-interview. Accepted (rare, skip is cheap). | documented only |
| Reflection injected while a turn is in flight | Queues behind it (`AgentDriver.prompt` input-stream push); runs next. | driver behavior |
| `gh` output yields no parseable URL | Reflection still fires (gate is `ok`, not `url`). | unit test |
| Duplicate Create PR click | Once-per-PR-cycle guard: second click no-ops. | unit test |
| Merge → new PR in same session | Guard cleared on `merge-pr` ok / agent `gh pr merge` ok; next create reflects. | unit test |
| Merge button: create + merge in ONE turn | Same-turn merge cancels the pending reflection (nothing left to amend). | unit test |
| Turn aborted after `gh pr create` succeeded | No `result` event → the armed reflection fires when the NEXT turn settles. Accepted (late but still useful). | documented only |
| Session killed with a live watcher | Watcher + guard entries removed in `kill()` ([BE2-24] block). | code |
| Team lead/member, autopilot work-unit session | Skipped entirely. | unit test |
| Degraded auth (no usable token) | Skipped (mirrors `prompt()`'s gate). | unit test |
| No CLAUDE.md in the project | Agent proposes creating one in the interview. | prompt text |
| Armed `/goal` on the session | The Stop-hook goal judge also evaluates the reflection turn, burning one iteration. Accepted (rare overlap, negligible). | documented only |
| Gamed-spec case | The agent could "amend the PR" with unrelated changes — guardrails are prompt-only by decision (§9-4); the PR diff is human-reviewed anyway. | trust model |

## 8. Evaluation & verification

- **Technical:** `anvild/test/unit/claude-md-reflection.test.ts` — env-gate matrix, prompt
  guardrail pins, and the full trigger matrix above (8 tests). `bun test` 0 fail, `tsc --noEmit`
  clean at time of writing.
- **Functional (manual — the turn itself is LLM-driven):** in a dev session, land a change that
  surfaces a convention, Create PR, confirm the reflection turn fires and either short-circuits
  or interviews; accept one candidate and skip one; confirm only the accepted item lands in
  CLAUDE.md, on the same PR, no second PR; set `ANVIL_CLAUDEMD_REFLECT=0`, restart, confirm
  silence.

## 9. Spec-critique gate

- **Critique round 1 (2026-08-12):** self-critique + owner interview. Findings & resolutions:
  1. `result.url` gate could silently drop reflections on a `gh`-output regex miss → **fixed**,
     gate on `ok` alone.
  2. Once-per-session-ever guard contradicted the multi-PR session lifecycle (merge-pr
     `_followup` rollover) → **fixed**, once per PR cycle (guard cleared on merge).
  3. Out-of-band PR creation (agent `gh pr create`, terminal) never triggers → **accepted as
     non-goal** (owner: button-only).
  4. Guardrails prompt-only; a misbehaving turn could push unrelated changes → **accepted as
     trust model** (owner: trust the prompt; PR diff is human-reviewed).
  5. Team/planner/work-unit sessions undifferentiated → **fixed**, interactive sessions only.
  6. No-CLAUDE.md case unspecified → **fixed**, agent proposes creating one.
  7. Goal-judge overlap burns an iteration on the automated turn → **accepted & documented**.
  8. AskUserQuestion 4-question cap could truncate large interviews → **fixed**, batching
     instruction in the prompt.
- **Critique round 2 (2026-08-12):** the round-1 "button-only" decision (finding 3) rested on a
  FALSE premise: the git panel's PR button was described as dispatching the `create-pr` git
  command, but the web client only sends `git` commands for status/diff — the PR/Merge buttons
  prompt the agent to run `gh` itself, so the shipped hook never fired from the UI. Resolution
  (owner): detect the PR step by watching the session's Bash tool results (`PrActivityWatcher`,
  §4), keeping every daemon gate intact; the protocol hook stays as a secondary path; the
  terminal PTY remains the (corrected) non-goal. Merge detection moved to the same watcher so
  the PR-cycle guard also resets on agent-driven merges.

## 10. Open decisions

- None. All defaults were either confirmed or overridden in critique round 1.
