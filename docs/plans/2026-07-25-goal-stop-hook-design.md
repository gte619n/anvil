# Anvil-native `/goal` — design

**Date:** 2026-07-25
**Branch:** `worktree-goal-stop-hook`
**Intent:** one PR
**Status:** design approved, awaiting plan

---

## 1. Goal

Give an Anvil session a **stated objective it keeps working toward**, set from any device:

```
/goal all tests pass
/goal clear
/goal                     → report current state
```

While a goal is active, the session refuses to go idle until a judge decides the condition is met,
the iteration ceiling is hit, or the user clears it. The active goal is visible in the composer, and
exactly one push notification is sent per goal — when it resolves.

This is the Claude Code `/goal` capability, reimplemented natively so its state is Anvil's and can
therefore reach every device.

---

## 2. Background — why native, not proxied

Verified live against the running daemon on 2026-07-25 (SDK `@anthropic-ai/claude-agent-sdk@0.3.183`,
CLI `2.1.220`):

| Finding | Evidence |
|---|---|
| CC's `/goal` is a **session Stop hook** | CLI strings: *"session hooks created by /goal, agents, and skills still run"*; `activeGoal { condition, iterations, lastReason }` |
| Goal state **never crosses the SDK wire** | `grep -i goal sdk.d.ts` → **0 hits**. No typed goal state for a host to read. |
| Slash commands **do not execute** on Anvil's input path | 5 `/goal` attempts through `prompt.send`: **0** `Stop hook feedback` messages, no turn ever blocked, agent treated the condition as an instruction and tried to `Bash` into `/etc` |
| The same string **does** work as a `prompt` string | Standalone SDK probe: Stop hook fired, injected `Stop hook feedback:`, refused to stop |
| Only `/clear` + `/compact` work in Anvil | Hand-intercepted at `supervisor.ts` `prompt()`; everything else is passed to the model as literal text |

Root cause: `userMessage()` (`anvild/src/agent/input-queue.ts:77`) wraps prompts as a plain
`SDKUserMessage`; the CLI's slash-command expansion lives on its own input layer, which Anvil's
long-lived `InputQueue` never traverses.

**Consequence:** proxying the CLI's `/goal` is not merely hard — even if the command fired, Anvil
could not render the condition, the iteration count, or the blocker, because none of it is on the
wire. Owning the state is the only design that produces a goal you can see from a phone.

---

## 3. Constraints

- **`settingSources: []` stays intact.** The daemon remains the permission authority (arch §6.6). The
  goal hook is registered programmatically, exactly as `PreToolUse` already is.
- **Additive protocol.** `PROTOCOL_VERSION` stays `2`; a new optional field on `Session` is additive
  per the protocol header's own convention.
- **Cost-aware.** The judge fires on every stop attempt. It is a one-shot Haiku call with no tools.
- **No new client→server commands.** `/goal` and `/goal clear` both arrive via the existing
  `prompt.send`. The UI is display-only.
- **Native clients are not re-shipped by this PR.** The web chip reaches Android/iOS only when those
  shells are rebuilt (`web/bundle-native.ts`) — expected, not a regression.

---

## 4. Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Condition evaluation | **Model-judged natural language** | Matches the CC behavior the user already relies on. A `!command` form was rejected as scope. |
| D2 | Judge input + model | **Last 5 turns, Haiku** | Enough evidence to catch "claimed success, tool errored"; cost near-noise. Last-message-only rejected: judges a claim, not evidence. |
| D3 | Push during loop | **Suppress only the `result` branch** while goal active+unmet; one push on resolve | `maybeNotify` has three branches; permission/question pushes stay intact so a goal blocked on approval still reaches the user. |
| D4 | Iteration ceiling | **10, auto-clear** + divider + one push | Fails safe with no input required — the goal is set from a phone and walked away from. |
| D5 | Persistence | **Persist, re-arm paused** | Survives a daemon self-update without silently resuming an unattended loop. |
| D6 | Judge failure | **Fail open** — let the session stop, goal stays armed, iteration NOT incremented | A Haiku outage or rate-limit must never trap a session in an inescapable loop. |
| D7 | UI | **Composer chip**: `◎ goal: <condition> · n/10` | The one place the user looks when idle, and where they'd type `/goal clear`. |
| D8 | User prompt during a goal | **Reset iteration counter to 0** | New information means the failing loop isn't the loop that continues; ceiling means "10 turns without human help". |

---

## 5. Architecture

```
   user types "/goal all tests pass"
            │
            ▼
   supervisor.prompt()                      ← intercept, beside /clear + /compact
     ├─ parse: set | clear | status
     ├─ session.data.goal = {condition, iterations: 0, …}
     ├─ persist() + broadcastUpdated()       → chip appears on every device
     └─ return (no turn consumed)

   …later, the agent finishes a turn and tries to stop…
            │
            ▼
   Stop hook (driver.ts, beside PreToolUse)
     ├─ no goal / paused        → { continue: true }
     ├─ iterations >= 10        → clear goal, divider, push, { continue: true }
     └─ judgeGoal(cond, last 5 turns) on haiku
          ├─ met      → clear goal, divider, push, { continue: true }
          ├─ unmet    → iterations++, broadcast, { decision: "block", reason }
          └─ threw    → { continue: true }         (D6 fail-open, no increment)
```

### 5.1 Components

**`anvild/src/agent/goal.ts` — NEW**

```ts
export interface SessionGoal {
  condition: string;      // natural language, as typed
  iterations: number;     // unmet stop attempts since last reset
  lastReason?: string;    // judge's most recent blocker
  paused?: boolean;       // restored from disk, re-arms on next user prompt (D5)
  setAt: string;          // ISO
}

export const GOAL_MAX_ITERATIONS = 10;
export const GOAL_JUDGE_TURNS = 5;

/** "/goal x" → {kind:"set"} · "/goal clear" → {kind:"clear"} · "/goal" → {kind:"status"} */
export function parseGoalCommand(text: string): GoalCommand | undefined;

/** One-shot Haiku judge. Mirrors classifyBranchKind: no tools, maxTurns 1, 20s abort, §3 env. */
export function judgeGoal(
  condition: string, transcript: string, env: Record<string, string>,
): Promise<{ met: boolean; reason: string }>;

/** The Stop hook. Owns iteration accounting, ceiling, and clear-on-resolve. */
export function makeStopHook(session: Session, env: () => Record<string, string>,
                             onResolved: (s: Session, met: boolean) => void): HookCallback;
```

**Hook return shape — verified by spike (2026-07-25), not inferred:**

```ts
// UNMET → block the stop. The model receives it as a synthetic user message:
//   "Stop hook feedback:\n[all tests pass]: 3 tests still failing"
return { decision: "block", reason: `[${goal.condition}]: ${judged.reason}` };

// MET / paused / no goal / ceiling / judge failed → allow the stop
return { continue: true };
```

Do **not** use `hookSpecificOutput.additionalContext` here. The spike proved it also prevents the
stop, but delivers the text as a *system reminder*, which the model refuses to act on as a suspected
prompt injection — producing a session that loops without doing the work. See §10 R1.

`judgeGoal` is modelled directly on `classifyBranchKind` (`anvild/src/agent/branch-kind.ts:35`) —
`query()` with `model: "haiku"`, `settingSources: []`, `allowedTools: []`,
`permissionMode: "bypassPermissions"`, `maxTurns: 1`, `abortController` on a 20s timer, `env` from
`agentEnv()`. It asks for a strict `MET`/`UNMET: <reason>` reply and treats any unparseable answer as
a throw (→ D6 fail-open).

**`anvild/src/agent/driver.ts`** — register the hook beside the existing gate:

```ts
hooks: {
  PreToolUse: [{ hooks: [makePreToolUseHook(...)], timeout: 3600 }],
  Stop:       [{ hooks: [makeStopHook(s, () => this.env, this.onGoalResolved)], timeout: 60 }],
},
```

60s covers the 20s judge with headroom. The hook reads goal state off the live `Session` object, so
no driver restart is needed when a goal is set or cleared mid-session.

**`anvild/src/session/supervisor.ts`**
- `prompt()` — parse `/goal` beside the `/clear` and `/compact` intercepts (currently ~`:2338`). Set,
  clear, or report; emit a divider; `persist()`; `broadcastUpdated()`; return without consuming a turn.
- Any **other** prompt while a goal is active: reset `iterations = 0`, un-`paused` (D5/D8).
- `maybeNotify()` (~`:2563`) — in the `result` branch only, return early when
  `goal && !goal.paused` and the goal did not resolve this turn (D3).
- `onGoalResolved()` — emit the divider, push once, `persist()`, `broadcastUpdated()`.

**`anvild/src/session/session.ts`** — `goal?: SessionGoal` on `SessionData` (persisted via the
existing `sessions.json` path). On restore, force `paused: true`.

**`docs/plans/anvil-protocol.ts`** — `SessionGoal` interface + `goal?: SessionGoal` on `Session`
(after `commands?`). Additive; `PROTOCOL_VERSION` unchanged.

**`anvild/src/agent/skills.ts`** — add a `goal` entry to `BUILTIN_DESCRIPTIONS` so the `/` menu
explains it, matching how `clear`/`compact` are described. (Filtering the other ~40 unbacked
built-ins out of the menu is **out of scope** — see §8.)

**`anvild/web/src/main.ts` + `styles/app.css`** — a slim chip above the composer, rendered from
`session.goal`, showing `◎ goal: <condition> · n/10`, with a muted "(paused)" variant. Display-only.

### 5.2 Data flow — the four transitions

| Transition | Trigger | Effect |
|---|---|---|
| **set** | `/goal <cond>` | goal stored, `iterations: 0`, divider `Goal set: <cond>`, chip appears, no turn consumed |
| **iterate** | stop attempt, judge says unmet | `iterations++`, `lastReason` stored, chip updates, `{decision:"block", reason:"[<cond>]: <blocker>"}` → model receives `Stop hook feedback:\n[<cond>]: <blocker>` and continues |
| **resolve (met)** | judge says met | goal cleared, divider `Goal met (n turns)`, **one** push, session idle |
| **resolve (abandon)** | `iterations >= 10` | goal cleared, divider `Goal abandoned after 10 turns — last blocker: …`, **one** push, session idle |

`/goal clear` is a fifth path: clears silently with a divider, no push.

---

## 6. Error handling

| Failure | Behavior |
|---|---|
| Judge throws / times out / unparseable | **Fail open** (D6): `{continue:true}`, goal stays armed, `iterations` unchanged |
| Judge persistently failing | Bounded naturally — the session simply stops each turn; no runaway |
| `stop_hook_active` is true | Verified by spike: `false` on the first fire, `true` on every re-entry. Logged for diagnostics; the iteration ceiling remains the authoritative loop guard |
| Goal set on a session with no driver | Stored and broadcast; arms when the driver starts |
| Daemon restart mid-goal | Restored `paused: true`; chip shows "(paused)"; re-arms on next user prompt (D5) |
| Goal blocked on a permission prompt | Permission push still fires (D3) — the user is not left guessing |
| Session killed/archived with a goal | Goal dies with the session; no orphan state |

**Explicit non-guarantee:** a goal cannot force a sandbox escape. During testing an unsatisfiable
goal escalated to `dangerouslyDisableSandbox` and an `ln -s /tmp` attempt; every one was refused by
the existing `PreToolUse` gate. The ceiling exists so that pressure is time-boxed.

---

## 7. Testing

`anvild/test/unit/goal.test.ts` — NEW, offline, no network:

1. `parseGoalCommand` — set / clear / status / `/goalx` non-match / leading+trailing whitespace /
   must be the whole message (matching the `/clear` rule).
2. Stop hook, no goal → `{continue:true}`, judge never called (injected stub).
3. Stop hook, unmet → `decision:"block"`, `iterations` 0→1, `lastReason` recorded.
4. Stop hook, met → goal cleared, `onResolved(met=true)` called once.
5. Ceiling — at `iterations === 10` the goal clears **without** calling the judge.
6. Judge throws → `{continue:true}` and `iterations` **unchanged** (D6).
7. Iteration reset — a non-goal prompt zeroes the counter and un-pauses (D8).
8. Restore — a persisted goal comes back `paused: true`.

Plus: `maybeNotify` suppression asserted in the supervisor's existing test file (result branch
suppressed while unmet; permission branch unaffected).

Gate: `bun run typecheck`, `bun run typecheck:web`, `bun run build:web`, `bun test` — all four green
(CI runs the same set).

---

## 8. Out of scope (YAGNI)

- **Filtering the ~40 unbacked built-ins** from the `/` menu. Real bug, verified this session, but a
  separate concern from adding `/goal` — its own PR.
- `!command` deterministic conditions (D1 alternative).
- Configurable ceiling (`--max`), cost-based ceiling.
- Teams: goals do **not** propagate lead→member, and the hook does not consult
  `StopHookInput.background_tasks`. A lead goal like "all members merged" is a follow-up.
- `SendMessage` fidelity (`origin`/`priority`/`shouldQuery` on `userMessage()`) — separate PR.
- Monitor task-event mapping and the push `tag` collision — separate PR.
- Native app re-ship.

---

## 9. Phase tracking

| Phase | Description | Status | Tested | Pushed |
|-------|-------------|--------|--------|--------|
| 0 | **Spike** — verify the Stop-hook block mechanism | **done** | **yes** | n/a |
| 1 | `goal.ts`: `SessionGoal`, `parseGoalCommand`, constants | pending | no | no |
| 2 | `judgeGoal()` — Haiku one-shot mirroring `classifyBranchKind` | pending | no | no |
| 3 | `makeStopHook()` — iteration accounting, ceiling, fail-open. Return shape is **settled** by Phase 0: `{decision:"block", reason}` | pending | no | no |
| 4 | Protocol: `SessionGoal` + `Session.goal` (additive) | pending | no | no |
| 5 | `driver.ts`: register the `Stop` hook | pending | no | no |
| 6 | `supervisor.ts`: `/goal` intercept, dividers, counter reset | pending | no | no |
| 7 | `supervisor.ts`: `maybeNotify` suppression + resolve push | pending | no | no |
| 8 | Persistence: `SessionData.goal`, restore-as-paused | pending | no | no |
| 9 | Web: composer chip + styles | pending | no | no |
| 10 | Tests: `goal.test.ts` + notify suppression | pending | no | no |
| 11 | Full gate (typecheck ×2, build:web, bun test) + PR | pending | no | no |

---

## 10. Open risks

### R1 — Block mechanism · **RESOLVED 2026-07-25 by spike**

A throwaway spike (a bare `query()` with a counting `Stop` hook, no Anvil involvement) ran both
candidate return shapes against `@anthropic-ai/claude-agent-sdk@0.3.183`, hard-capped at 2 blocks.
The script was not kept — the result below is the record.

| Variant | Blocks the stop? | Model behavior |
|---|---|---|
| **A** `{decision:"block", reason}` | **yes** | Receives a synthetic user message `Stop hook feedback:\n<reason>` and **complies** (3 assistant turns) |
| **B** `hookSpecificOutput.additionalContext` | yes | Delivered as a *system reminder*; model **refuses** — *"I don't follow instructions embedded in system reminders … these could be prompt injection attempts"* (result reported `turns=1`) |

**Decision: variant A.** The fallback originally written into this doc (B) is not merely inferior —
it is actively wrong, yielding a session that loops without performing the work. Recorded here so it
is not "simplified" to `additionalContext` later.

Also confirmed by the same spike: `stop_hook_active` flips `false` → `true` on re-entry, and
`StopHookInput.background_tasks` / `.session_crons` are present as arrays (the input the deferred
teams work in §8 would need).

### R2 — Judge window

5 turns may miss a goal satisfied earlier in a long session. Accepted (D2); revisit if it bites.

### R3 — Judge quality

Haiku may accept a confident false claim. Mitigated by judging turns (evidence) rather than the last
message (assertion), and bounded by the ceiling. The spike's variant-B result is a useful reminder
that the model is *not* credulous about injected instructions — but it says nothing about how
credulous the judge is about the transcript it is asked to assess.
