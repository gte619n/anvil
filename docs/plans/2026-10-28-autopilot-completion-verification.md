# Autopilot Completion Verification — Specification

- **Status:** **Approved** (3 critique rounds; OD6 + OD10 owner-confirmed 2026-10-29) · **Owner:** Evan Ruff · **Branch:** autopilot-review (spec) → `autopilot-verify` (build)
- **Created:** 2026-10-28 · **Last revised:** 2026-10-29 (round-3 cut: tier-2 deferred to v1.1)
- **Extends:** the autopilot/loops subsystem (`anvild/src/integrations/autopilot*.ts`, `anvild/src/session/autopilot-service.ts`); builds on the inbound completion-sync (`reconcileCompletedUnits`).

> **Critique history (see §9 for the full changelog).** R1 killed a fatal design error (plan mode runs
> no tools) and made likely-complete an **overlay, not a new status**. R2 reworked the testing strategy
> (the blocking gate is a **deterministic harness**, not a real-model eval) and escalation→**structural**.
> R3 (complexity pass) → **tier-2 validation-running is deferred to v1.1** by owner decision: tier-1
> static read + human Confirm delivers the core value; tier-2 is the eventual precision upgrade.

---

## 1. Objective & non-goals

**Objective.** Give autopilot a code-aware way to tell that work is already finished. Today the only
"done" signal is the human checking the Todoist box (`reconcileCompletedUnits`, defined
`autopilot-service.ts:523`). This feature adds a **completion verifier**: a read-only agent that
inspects the repo at the env's `origin/<defaultBase>` and judges whether a work unit's tasks are
*already implemented*. Work that looks done but isn't marked done gets a **"Likely complete" overlay**
on its card with file:line evidence and one-click **Confirm / Dismiss** — a human, not an LLM, makes
the final call. It runs across all hub-local repos, on demand (a **Verify completion** button) and at
the start of each nightly run, and it **gates auto-start** so autopilot skips units it can confirm are
already built.

**User-observable outcome:** In Loops, a `planned`/`blocked` unit whose work already exists shows a
"Likely complete" badge + evidence + Confirm/Dismiss; Confirm closes the Todoist task and clears the
card. Auto-start no longer builds units it can cheaply confirm are implemented. The nightly report says
how many units look already done.

**Non-goals (first-class):**
- **NG1 — No autonomous closing on the code signal alone.** A code-only `done` never closes a task or
  completes a unit by itself. Auto-complete fires only when the task has been **seen closed** (sticky
  `todoistClosedSeen`, §4.1) **and** the code verdict is `done`. (Honors [[autopilot-underspecified-catalog-incident]].)
- **NG2 — No verification of un-planned tasks.** Operates on existing `WorkUnit`s only; an un-bundled
  task is still caught by the Todoist checkbox poll.
- **NG3 — No reopening / rework of human decisions.** A seen-closed task the code says is *not* done is
  held as a mismatch for the human, never auto-reopened or auto-completed. The human resolves it:
  **Acknowledge** (trust the checkbox → complete) or **Keep as work** (the checkoff was a mistake →
  return the unit to buildable). (OD10.)
- **NG4 — No member-hosted repos in v1.** Hub-local environments only (Phase 7, deferred).
- **NG5 — Not a quality reviewer.** Answers "does this exist and look wired up," not "is it good code."
- **NG6 — No new `AnvilStatus`.** Likely-complete/partial/mismatch are an **overlay** on the real status.
- **NG7 — No validation-command execution in v1 (tier-2 deferred, R3).** The verifier reads code; it
  does **not** run the plan's `## Validation` commands. Consequence: a *present-but-broken/unwired*
  implementation can read as `done` — the human Confirm is the backstop, and tier-2 (v1.1) is the fix
  (OD6). This is an accepted v1 limitation, not a bug.

---

## 2. Context

**Why now.** Work frequently gets done out-of-band — a human implements it, or another unit's build
subsumes it — but the Todoist task stays open, so autopilot re-plans and can rebuild it. The only
closing signal today is the manual checkbox.

**Prior art (reuse, don't reinvent) — verified against code across 3 critique rounds:**
- `reconcileCompletedUnits` — defined `autopilot-service.ts:523`, called pre-planning at `:767` in
  `runAutopilot` and on the 5-min tick at `:172`. The Todoist-checkbox half; sets the pattern (poll per
  project, pure `selectCompletedUnits`, local `update` + `broadcastAutopilotPlans`, fail-open). Does a
  *local* status update only — writes no labels/comments. Guards itself with `if (autopilotRunning) return`.
- `planUnit` — `autopilot.ts:234`. The read-only inspection mechanism: `runQuery(prompt, {readonly:true,
  cwd})` → `permissionMode:"plan"` (`autopilot.ts:85`). Plan mode runs **no tools** (`sdk.d.ts:1648,1993`)
  — reads/greps only, which is exactly (and only) what v1 needs. [[plan-mode-runs-no-tools]]
- `classifyIntake` — `autopilot.ts:305`. Fail-open + `extractJson` parse discipline the verifier mirrors.
- `selectCompletedUnits` / `RECONCILABLE_STATUSES` — `autopilot-plans.ts:39,53`. Pure selectors; new
  ones live beside them. "Closed" = `u.taskIds.every(id ∈ completedTaskIds)` where `completedTaskIds`
  comes from `completedTasks({windowDays: RECONCILE_WINDOW_DAYS=60})` (`autopilot-service.ts:82,539`) —
  a **sliding 60-day window**, not durable (→ `todoistClosedSeen` sticky, §4.1).
- `resolvePlan`/`tagTasks`/`postPlanComment` — `autopilot-service.ts:497,1061,1075`. `resolvePlan(id,
  status, close)` relabels + optional `closeTask`; posts **no** comment → auto-complete needs a new
  idempotent comment helper.
- `createWorktree`/`syncedBase`/`linkDeps` — `worktree.ts:166,128,28`. Always `worktree add -b` a new
  branch off a *fetched* `origin/<base>`, symlinks the canonical `node_modules`. A read-only pin needs a
  **new `--detach` helper that fetches first** (§4.2). The bare-origin+clone test pattern at
  `worktree.test.ts:51-71` is reused to generate fixtures.
- `autoStartDecision` / `AutoStartCandidate` — `autostart-gate.ts:52,61`. Pure, **sync, SDK-free** by
  design; the gate reads a plain annotated field, never calls the verifier itself (§4.5).
- `autopilotRunStartedAt` / `autopilotRunToken` / watchdog — `autopilot-service.ts:803-817,926`.
  Explicitly **multi-writer-safe** (per-run token); the manual verify handler reuses this pattern.
- Push events — `autopilot.run.progress` (`AutopilotRunProgressEvent`, cid-less broadcast via
  `registry.toAll`, `autopilot-service.ts:1039`) is the envelope precedent for the metrics push (§4.7).
- `SERVER_CAPABILITIES` (`identity.ts:86`) + `serverSupports` (`web/src/fleet.ts:114`) — capability gating.

**Decisions** come from the 2026-10-28 interview (§10) and 3 critique rounds (§9).

**Memories.** [[plan-mode-runs-no-tools]], [[autopilot-underspecified-catalog-incident]],
[[autopilot-schedule-hub-only]] (nightly hub-only → NG4), [[daemon-runs-from-live-dev-checkout]] (never
verify in the live tree), multi-account §6 (per-spawn account env).

---

## 3. Inputs & scope

- **In scope (files):** `workunit.ts` (`verification` block); `autopilot.ts` (`verifyUnit` tier-1);
  `autopilot-plans.ts` (pure selectors/parser/combine); `autopilot-service.ts` (`reconcileAndVerify`
  core + guarded wrappers, auto-start pre-pass, tick rule, `clearVerificationOnBuild`, manual command,
  metrics, summary); `worktree.ts` (**new branchless `--detach` read helper**); `protocol.ts`
  (`AutopilotPlanInfo.verification` fields, `autopilot.verify`/`.confirm`/`.dismiss`/`.ack`/`.keep` commands,
  capability tag, `autopilot.verify.metrics` event); `web/src/loops.ts` (+ support); tests +
  `test/fixtures/verify/` generator.
- **Out of bounds:** the Todoist checkbox as the authority for *closing*; `reconcileCompletedUnits`
  behavior **when the flag is off** (when on, its `:767` call is replaced by `reconcileAndVerify` and
  its tick call gains the deferral rule — §4.5); the protocol golden except via regen; the Tailscale
  trust model (no new auth — [[tailscale-is-accepted-security-boundary]]); any new `AnvilStatus` (NG6);
  running validation commands (NG7, tier-2 deferred).
- **Available inputs/tools:** `TodoistClient`; Agent SDK `query` via `runQuery` (**plan mode only** in
  v1); `EnvironmentStore` (`repoRoot`, optional `defaultBase`, `todoistProjectId`, `accountId`);
  `AccountStore`; git via `gitSpawnAsync`; run `AbortSignal`; push + lapo-report.
- **Assumptions log:**
  - A1 · `origin/<defaultBase>` is the authoritative "done" ref · interview + `syncedBase` · **confirmed**.
  - A2 · The blocking, always-on done-gate is the **deterministic** harness (injected `queryFn`); the
    real-model eval is **opt-in advisory** (SDK has no temperature knob; an agentic verifier isn't
    sampling-deterministic) · R2 · **confirmed (OD1)**.
  - A3 · Reusing the env's account/model is cost-acceptable; cost is made observable via metrics (§4.7) · **confirmed**.
  - A4 · `resolveBaseSha` **fetches** before `git rev-parse origin/<defaultBase ?? HEAD>` (a bare
    rev-parse reads a stale local mirror) · R2-C7/R3 · **confirmed**.
  - A5 · The branchless read worktree is built via `git worktree add --detach <path> <ref>` and shares
    `resolveBaseSha`'s fetch; it needs **no** `node_modules` (tier-1 reads source, runs nothing) · R3 · **confirmed buildable**.
  - A6 · Task text may have drifted since planning; the verdict is judged against *current* task text +
    the stored plan · **default assumed (OD7)**.
  - A7 · Fixtures are **generated at test time** (bare origin + clone, `worktree.test.ts:51-71` pattern),
    each carrying a unique **sentinel symbol** the advisory eval asserts is cited · R2-T4/R3 · **default assumed (OD8)**.

---

## 4. Design

### 4.1 Data model — overlay, not status

The unit keeps its real `status`. Add to `WorkUnit` (`workunit.ts`), all optional:

```ts
interface WorkUnit {
  // …existing status unchanged…
  verification?: {
    verdict: "done" | "partial" | "not-done";
    evidence: string;                   // rendered markdown: file:line citations
    raw: string;                        // raw verdict JSON, persisted for debugging a wrong call
    perTask?: { taskId: string; verdict: "done" | "not-done"; cited: boolean; note?: string }[];
    confidence?: number;                // 0..1 — DISPLAY ONLY; never gates control flow (R2-T3)
    baseRef: string;                    // "origin/<defaultBase>"
    baseSha: string;                    // SHA of baseRef when computed
    at: string;                         // ISO 8601
    todoistClosedSeen?: boolean;        // sticky: tasks were observed closed in the 60-day window (R2-S2)
    mismatch?: boolean;                 // closed-seen but code not-done → held for human (NG3)
    keptAsWork?: string;                // human hit "Keep as work" (mistaken checkoff) → skip verify+complete; stays buildable (OD10)
    dismissedAt?: string;               // human dismissed a done-overlay; suppress until stale
    commentPosted?: boolean;            // idempotency guard for the Todoist evidence comment
  };
}
```

**Visibility predicates (single source of truth, `autopilot-plans.ts`).**
- `isLikelyComplete(unit, liveIds)` ⇔ `verdict==="done"` ∧ `!dismissedAt` ∧ verifiable status (§4.3) ∧ `!liveIds.has(sessionId)`.
- `hasOverlay(unit, liveIds)` ⇔ `isLikelyComplete(unit, liveIds)` **∨** `verification.mismatch`. The
  **grid** and **web badge** key on `hasOverlay`; the **auto-start gate** keys on the annotated
  `verdict` (§4.5). (Fixes R3-#3/#4: the grid must also show mismatch units, which `isLikelyComplete`
  excludes.)

**Why overlay:** Dismiss needs no stored prior status; a build start clears `verification` so a stale
`done` can't re-flag; no label-mirror; flag-off never strands a unit.

### 4.2 The verifier — `verifyUnit()` (tier-1 static read, v1)

```ts
verifyUnit(unit, tasks, { baseWorktree, baseRef, baseSha, plan, model, accounts, accountId, signal, queryFn })
  : Promise<VerificationResult>
```

`runQuery(prompt, { readonly:true, cwd: baseWorktree })` — plan mode (no tool execution). Prompt asks,
**per task**, for a verdict **and** a `file:line` citation; the unit's stored plan is included for
context. Parse via `extractJson`; **fail-open** to `{verdict:"not-done"}` on any error (classifyIntake
discipline). Unit verdict = `done` iff every task is `done` with a citation; `partial` if some tasks are
`done`; else `not-done`.

- **Reads run in a shared per-repo read worktree** at `origin/<defaultBase>` — a **new branchless helper**
  (`git worktree add --detach`, fetch-first via `resolveBaseSha`) created once per repo per sweep and
  torn down at sweep end. Never the live `repoRoot` ([[daemon-runs-from-live-dev-checkout]]). A startup
  prune removes any read worktree orphaned by a crash. (`createWorktree` can't be reused — it always
  branches; A5.)
- **baseSha / staleness:** `resolveBaseSha(env)` = fetch, then `git rev-parse origin/<defaultBase ?? HEAD>`
  (A4). A verdict is **stale when `baseSha` changed** (OD4 simplified staleness to ref-moved-only — no
  wall-clock timer; `origin/main` moving is the real "code changed" signal).
- **Model/account:** inherit the env's account + model (A3; multi-account §6 via `buildAgentEnv`).

*(Tier-2 — re-judging after running the plan's `## Validation` commands in a writable worktree — is
deferred to v1.1; see OD6 and NG7.)*

### 4.3 Signal combination

Verifiable statuses: **`planned` and `blocked`** only. Excluded: `review`/open-PR (work is on a branch,
not `main`), `needs-clarification` (verifying discards its open questions), `proposed`, `building`/live,
`completed`/`dismissed`/`expired`. Eligibility also requires `!liveIds.has(sessionId)`, no `keptAsWork`,
and **stale** (baseSha changed, or no verdict yet).

"**Closed**" = every task in the 60-day completed window. The **first** time a unit's tasks are seen
closed, set the sticky `verification.todoistClosedSeen` so an aged-out completion doesn't flip the unit
back to "open" (R2-S2). `combineSignals(unit, codeVerdict, closedSeen)` returns `{autoComplete, mismatch,
overlay}`:

| Closed-seen | Code verdict | Action |
|---|---|---|
| yes | `done` | **Auto-complete** → `resolvePlan("completed", close)` + idempotent evidence comment |
| yes | `not-done` | **Mismatch** → no auto-complete; set `mismatch`; `hasOverlay` forces the card visible with **Acknowledge** + **Keep as work** (NG3) |
| no | `done` | overlay "Likely complete"; Confirm / Dismiss |
| no | `partial` | record `perTask`; no status change; card shows "2/3 appear done" (advisory) |
| no | `not-done` | no change; refresh `verification.at`/`baseSha` |

`overlay = (verdict==="done" ∧ !dismissedAt) ∨ mismatch` — the one visibility flag the grid consumes (R3-#4).

**Mismatch exit (R2-S1 / OD10).** Todoist has no reopen API (`closeTask` only), so the system can't
"fix" a mismatch — the human does, via one of two actions:
- **Acknowledge** = "trust my checkbox, it really is done" → **complete immediately** (status→`completed`;
  the task is already closed in Todoist so no close call, and **no evidence comment** — "couldn't find
  the code" reads as noise on a done task). Terminal; the card clears.
- **Keep as work** = "I checked it off by mistake, I still want it built" → set `keptAsWork`, clear the
  mismatch overlay; the unit stays in its `planned`/`blocked` status and is buildable again. A
  `keptAsWork` unit is skipped by both `selectVerifiableUnits` and the completion reconcile (so its
  still-closed Todoist checkbox can't re-trigger mismatch or auto-complete).

No ack flag is persisted — Acknowledge *is* completion. An untouched mismatch **lingers on the grid
indefinitely** (counted in the nightly summary; OD10), re-verified only when `baseSha` moves (so if the
work later lands on `main`, it flips to closed+`done`→auto-complete). It never churns (staleness =
baseSha-moved) and `todoistClosedSeen` stops it oscillating back to "open."

**Idempotent evidence comment:** `postVerificationComment(taskId, body)` scans `comments(taskId)` for a
marker (`<!-- anvil:verify -->`); if present, skip; sets `commentPosted`. Exactly-once (R2-C5 confirmed).

### 4.4 Pure helpers (`autopilot-plans.ts`, unit-tested)

- `parseVerdict(raw)` — tolerant JSON → typed; carry `raw`; `confidence` display-only.
- `selectVerifiableUnits(units, baseShaByEnv, liveIds)` — status scope (`planned`/`blocked`) +
  `!liveIds.has(sessionId)` + `!keptAsWork` + stale (baseSha change / no verdict) + skip `dismissedAt`.
- `combineSignals(unit, codeVerdict, closedSeen)` — the table above.
- `isLikelyComplete` / `hasOverlay` — the §4.1 predicates (shared grid + gate + web).

*(No `shouldEscalate` in v1 — escalation was tier-2 only; removed with it, resolving R3-#10.)*

### 4.5 Triggers, gate & UX — **two verification passes per nightly run** (R3-#6)

A nightly run performs **two distinct, disjoint verification passes**:
1. **Pre-planning reconcile** over *existing* eligible units: `reconcileAndVerify()` **replaces** the
   `:767` `reconcileCompletedUnits()` call when `verifyEnabled`. Per unit: verify tier-1 (if stale),
   then apply the §4.3 table. Verify-first means no complete-before-verify race (R2-S4).
2. **Post-planning auto-start pre-pass** over the *freshly-created* units: verify tier-1, annotate each
   with its `verdict`, then the filter at `autopilot-service.ts:880` drops `done` units from
   `autoStartable` (hold reason `"already-implemented"`). `autoStartDecision` stays sync + SDK-free — it
   reads the plain annotated `verification?.verdict` field added to `AutoStartCandidate` (R2-S6). These
   two passes touch disjoint unit sets (existing-stale vs just-created), so there's no double-writer on
   `verification` (R3-#5).

- **Manual button** "Verify completion" → `autopilot.verify`: fleet-wide over hub-local envs,
  progress-streamed + cancelable. The handler **must set `autopilotRunStartedAt` + bump
  `autopilotRunToken` + arm the watchdog** (mirror `:803-817`) and clear them in a `finally` **guarded by
  `token === this.autopilotRunToken`** (mirror `:926`) — else the single-flight guard is inert or a
  superseded run wipes a newer one's state (R2-C3/R3-#5-polish). Rejects when the flag is off; second
  concurrent invoke rejected.
- **5-min tick (R3-C2):** the tick **never spawns the verifier** (respects "off the tick", OD3). When
  `verifyEnabled`, the tick's `reconcileCompletedUnits` auto-completes a closed unit **only if it already
  has a fresh, non-mismatch `done` verdict**; a closed unit lacking a fresh verdict is **deferred** to
  the next verifying pass (run or manual button). This keeps the tick cheap *and* closes the race on the
  tick path.
- **Confirm / Dismiss / Acknowledge / Keep-as-work** → `autopilot.verify.confirm`/`.dismiss`/`.ack`/`.keep`.
  - **Confirm** (done-overlay) = `resolvePlan(id,"completed",true)` + `postVerificationComment`; degrades
    to **local-only** completion when Todoist is unavailable (never block the human).
  - **Dismiss** (done-overlay) = set `dismissedAt`.
  - **Acknowledge** (mismatch) = `resolvePlan(id,"completed",false)` **immediately** — task already
    closed, so no close call and **no comment** (OD10).
  - **Keep as work** (mismatch) = set `keptAsWork`, clear the overlay; unit stays `planned`/`blocked`
    and buildable (OD10).
  - All four available regardless of the flag.
- **Manual "Go" on a likely-complete unit** is an intentional human override — the unit is still
  `planned`, so the normal build works; the UI shows a soft "looks already implemented — build anyway?"
  confirm but does **not** hard-block (the gate blocks only *auto*-start — R2-S3).
- **Build start clears `verification`** via one `clearVerificationOnBuild(unitId)` helper called from
  **`startPlan`, `runDevPipeline`, and `linkPlan`** — the three entry points that **start real work** on
  a unit. (Not identified by a `status:"building"` grep: `runDevPipeline` does real work but never writes
  `status:"building"` — R3-C4.)
- **Nightly summary:** one line ("N already implemented, M mismatches"). No per-event push.
- **UI:** "Likely complete" badge + evidence in the plan reader; Confirm/Dismiss (assert dispatched
  command payload, not just DOM removal); mismatch warning + **Acknowledge** + **Keep as work**;
  "2/3 appear done" partial note.
  Grid shows any `hasOverlay` unit even if its base status wouldn't otherwise render (R2-S8). Verify
  button hidden when the flag is off.

### 4.6 Feature flag & capability

- `verifyEnabled` on `AutopilotScheduleStore` (OD5), **default OFF**, broadcast via `autopilot.schedule`.
  Client hides the button when off; **daemon handler also rejects** when off.
- New capability tag `"autopilot-verify"` in `SERVER_CAPABILITIES` (`identity.ts:86`); clients gate the
  `autopilot.verify*` sends via `serverSupports(srv, "autopilot-verify")` (`web/src/fleet.ts:114`) — the
  daemon *errors* on an ungated unknown command (`dispatch.ts:596`). Additive `verification` fields are
  ignored by old clients.

### 4.7 Observability

Emit `autopilot.verify.metrics` at sweep end as a **cid-less push** (envelope modeled on
`autopilot.run.progress` — `registry.toAll`, R3-C8): units verified, verdict histogram, aborts,
mismatches, estimated token/cost (answers A3). Persist `verification.raw` so a wrong verdict is
debuggable.

---

## 5. Deliverables & phases

A row flips ✅ only after the per-phase done-gate (§8) passes **and** its evidence block is filled.
`Pushed` carries the commit SHA / PR link. *(Phase 3-tier2 from earlier drafts is removed — deferred.)*

> **Build status (implementation complete, awaiting independent review).** Phases 0–6 are implemented
> with tests; `bun test` is green (0 failures, new `[P0]`–`[P6]` tests included), `tsc --noEmit` (daemon)
> + `typecheck:web` exit 0, and `bun run web/build.ts` succeeds. Per the §8 binding protocol the rows are
> **not** self-flipped to ✅: "Tested"/"Pushed" require a **fresh-context adversarial reviewer** who
> re-runs `bun test` at the commit SHA (gate-5) and a SHA/PR link — the one gate a self-build can't
> satisfy. Run `/code-review ultra` (or a fresh reviewer) against this branch to reproduce the gate and
> flip the rows. Sequencing notes vs. the original plan: the `autopilot.verify*` **dispatch handlers +
> server-side reject-when-off** landed with Phase 4 (where the handler lives), and the **client send-gate**
> with Phase 6 (where the web send lives), rather than as Phase-0 stubs — the behaviour is unchanged.

### Phase 0 — Scaffolding: types, protocol, flag, capability
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| `verification` overlay block on `WorkUnit` | ❌ | ❌ | ❌ |
| `AutopilotPlanInfo.verification` fields + `autopilot.verify`/`.confirm`/`.dismiss`/`.ack`/`.keep` + regen golden | ❌ | ❌ | ❌ |
| `"autopilot-verify"` capability tag + client send-gate | ❌ | ❌ | ❌ |
| `verifyEnabled` flag (default off) + server-side reject-when-off | ❌ | ❌ | ❌ |

**Acceptance:** regen → **no diff** vs committed golden + new command/fields grep-present; a `WorkUnit`
with a `verification` block persists/reloads (incl. `raw`); flag-off → daemon rejects `autopilot.verify`;
**capability both branches** — a capability-present client sends, a capability-absent client does not (R2-T13).

### Phase 1 — Pure logic (test-first)
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| `parseVerdict` (carry `raw`, tolerate garbage, `confidence` display-only) | ❌ | ❌ | ❌ |
| `selectVerifiableUnits` (`planned`/`blocked` + `!live` + `!keptAsWork` + staleness + dismissed) | ❌ | ❌ | ❌ |
| `combineSignals` (the §4.3 table incl. `todoistClosedSeen` sticky + mismatch) | ❌ | ❌ | ❌ |
| `isLikelyComplete` + `hasOverlay` predicates | ❌ | ❌ | ❌ |

**Acceptance:** unit tests cover every §4.3 row (closed-seen+not-done→mismatch, open+done→overlay,
`todoistClosedSeen` sticky so an aged-out completion doesn't flip to open), status scope, `keptAsWork`
→not-eligible (and skipped by completion), staleness branches (no-verdict / baseSha-change /
dismissed-skip), and `hasOverlay` = done ∨ mismatch. `liveIds` threaded in (no `isLive` field).

### Phase 2 — Tier-1 verifier + read helper + fixtures
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| `verifyUnit` tier-1 (plan-mode read, per-task verdict+citation, fail-open) | ❌ | ❌ | ❌ |
| Branchless `--detach` read helper (fetch-first) + startup prune | ❌ | ❌ | ❌ |
| Fixture **generator** (`done`/`not-done`/`partial`/`present-but-broken`), each with a unique sentinel symbol | ❌ | ❌ | ❌ |
| Deterministic unit test (injected `queryFn`) — **blocking gate** | ❌ | ❌ | ❌ |
| Real-model eval (opt-in advisory calibration) | ❌ | ❌ | ❌ |

**Acceptance (blocking, deterministic):** with an injected `queryFn`, `verifyUnit` returns the parsed
verdict, never throws on malformed output, and — via canned verdicts — produces the full enum incl. ≥1
`done` and ≥1 `partial` (a fail-open-to-`not-done` stub can't pass — R1-TEST-4). The read helper creates
a `--detach` worktree at `origin/<defaultBase>` after a fetch and prunes a seeded orphan at startup.
**Advisory eval (opt-in, non-blocking):** real model vs generated fixtures reports K-run agreement and
whether `evidence` cites each fixture's **sentinel symbol** (path alone is echoable — R2-T6); labels
versioned to a prompt hash (R2-T5). **Documents** that `present-but-broken` reads as `done` under tier-1
(the NG7 limitation). Not a CI gate (R2-T9).

### Phase 3 — Combined reconcile pass (cross-repo, bounded, mismatch-aware)
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| `reconcileAndVerify()` across hub-local envs (bounded-parallel + global per-run cap) | ❌ | ❌ | ❌ |
| Verify-first-then-combine; persist (`verification`, incl. `raw`) + `broadcastAutopilotPlans` | ❌ | ❌ | ❌ |
| Mismatch hold (closed-seen+not-done) + Acknowledge→complete-now / Keep-as-work→buildable (OD10) | ❌ | ❌ | ❌ |
| Auto-complete: `resolvePlan("completed",close)` + idempotent `postVerificationComment` | ❌ | ❌ | ❌ |
| Deleted-task (404) → clear overlay + `expired`; suppress env without BOTH account AND Todoist; `autopilot.verify.metrics` | ❌ | ❌ | ❌ |

**Acceptance (lifecycle harness — fake clock/model, real `WorkUnitStore`, fake `TodoistClient`):** two
envs, one unit each. `done`+closed-seen → `completed` + comment; `done`+open → overlay; `not-done`+closed-seen
→ **held as mismatch, not completed**. **Acknowledge** completes it **immediately** with **no** comment;
**Keep as work** sets `keptAsWork`, leaves status `planned`, and a subsequent reconcile **skips** it (no
mismatch, no auto-complete) even though the task is still closed. **Staleness control (R2-T10):** sweep 2 with unchanged baseSha → verifier `queryFn` call-count stays
**1→1** and comment spy stays **==1**; sweep 3 after **bumping baseSha** → verifier **is** called again
(proves the skip was staleness, not a dead unit). Metrics push carries the histogram.

### Phase 4 — Manual command + streamed/cancelable UX (backend)
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| `autopilot.verify` handler — sets `autopilotRunStartedAt`+token+watchdog (token-guarded `finally`); flag-guarded | ❌ | ❌ | ❌ |
| Progress streaming + late-joiner snapshot | ❌ | ❌ | ❌ |
| Cancel via run `AbortSignal` (observed by injected `queryFn`; read worktree torn down) | ❌ | ❌ | ❌ |

**Acceptance:** invoking `autopilot.verify` sets `autopilotRunning` true (asserted); a second concurrent
invoke is rejected; cancel mid-sweep propagates the abort to the injected `queryFn` and tears down the
read worktree; a late-joining client gets the snapshot.

### Phase 5 — Nightly integration + auto-start gate + tick rule + summary
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| `reconcileAndVerify` **replaces** the `:767` call when flag on (verify-first) | ❌ | ❌ | ❌ |
| Auto-start **pre-pass** annotates `createdUnits`; sync `autoStartDecision` reads `verification?.verdict`; filter at `:880` | ❌ | ❌ | ❌ |
| Tick rule: tick never verifies; defers completing a fresh-verdict-less closed unit (R3-C2) | ❌ | ❌ | ❌ |
| `clearVerificationOnBuild` from `startPlan` + `runDevPipeline` + `linkPlan`; summary line | ❌ | ❌ | ❌ |

**Acceptance (lifecycle harness):** auto-start ON, two freshly-planned units — one `done`, one `not-done`.
The `not-done` unit **reaches** the mocked build-start seam (positive control — the gate is reachable,
R1-TEST-7); the `done` unit does **not**, is held `"already-implemented"`, and `clearVerificationOnBuild`
clears its `verification` when later built via **each** of the three entry points (asserted per-path,
R2-S5). The control is **unit-level** — "a build actually runs" is only on the opt-in real path (R2-T11).
A tick sweep does **not** call the verifier and does **not** complete a closed unit lacking a fresh verdict.

### Phase 6 — Web UI
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| "Likely complete" badge + evidence in plan reader | ❌ | ❌ | ❌ |
| Confirm / Dismiss / Acknowledge / Keep-as-work (assert command payload + idempotent re-render) | ❌ | ❌ | ❌ |
| Mismatch warning + Acknowledge + Keep-as-work + partial ("2/3") rendering; grid shows `hasOverlay` units | ❌ | ❌ | ❌ |
| "Verify completion" button (hidden when flag off) + progress indicator | ❌ | ❌ | ❌ |

**Acceptance (DOM harness):** a `done`-overlay unit renders badge + evidence + Confirm/Dismiss; Confirm
**dispatches the confirm command with the correct unit id** (asserted separately from DOM removal), and a
re-render from `completed` keeps it gone; a mismatch unit shows the warning + Acknowledge + Keep-as-work
(Acknowledge dispatches `.ack`→unit completes; Keep-as-work dispatches `.keep`→unit stays planned); an off-grid
`blocked`+overlay unit is forced visible; the Verify button is hidden when the flag is off.

### Phase 7 — (Deferred) Member-hosted repos via fleet-repo surface
*Out of scope for v1 (NG4). And **tier-2 validation-running is deferred to v1.1** (NG7/OD6) — a separate
later effort: `shouldEscalate`, writable per-unit worktree, read-only validation allowlist, abort-after-
create seam, orphan pruning.*

---

## 6. Constraints

- **Autonomy (NG1/NG3):** code signal never completes/closes alone; auto-complete needs closed-seen **and**
  code-`done`; closed-seen+not-done is held, never reopened; the human exits via Acknowledge (complete)
  or Keep-as-work (back to buildable) — OD10.
- **Permission mode:** v1 is **tier-1 only — `plan` mode, no tool execution** (NG7). No new auth.
- **Budget/model:** env's account/model; bounded-parallel (OD3) + global per-run cap; verifier **never**
  runs on the 5-min tick; cost emitted via metrics.
- **Back-compat:** `autopilot.verify*` capability-gated client-side + flag-checked server-side;
  `verification` fields additive; `reconcileCompletedUnits` unchanged when the flag is off.
- **Git truth:** `origin/<defaultBase>`, fetch-first; verdicts carry `baseRef`+`baseSha`; staleness =
  baseSha moved.
- **Rollout:** behind `verifyEnabled`, default OFF.

---

## 7. Edge cases & failure modes

| Scenario | Expected behavior | Covered by |
|---|---|---|
| Verifier model errors / garbage | Fail **open** to `not-done`; no change; retried when stale | P2 (malformed `queryFn`) |
| Run aborted / daemon restart mid-sweep | In-flight verdict discarded; read worktree torn down; startup prune removes orphans; persisted units unchanged | P2 + P4 |
| Crash after status write, before `closeTask` | Local status authoritative; `closeTask`/comment best-effort + idempotent (marker dedupe) | P3 |
| Concurrent run + manual verify / double-click | Verify handler **sets `autopilotRunning`** (token-guarded) → second invoke rejected; in-run passes use the core directly | P4 |
| 5-min tick vs verification | Tick never verifies; defers completing a closed unit that lacks a fresh verdict (R3-C2) | P5 |
| Duplicate verify of same unit | Staleness short-circuits; `commentPosted` + marker ⇒ no duplicate comment | P1 + P3 |
| Stale/corrupt `workunits.json` | Existing quarantine (`workunit.ts:95`); `verification` optional ⇒ old units load | existing + P0 |
| `defaultBase` missing | `"HEAD"` fallback; never crash sweep | P2 |
| Present-but-broken / unwired code | **Known v1 limitation (NG7):** tier-1 may read `done`; human Confirm is the backstop; tier-2 (v1.1) fixes it | P2 (documented) |
| Multi-task unit partially done | `partial` → per-task annotate, no auto-move (advisory) | P1 + P2 (partial fixture) |
| Closed-seen but code not-done | Mismatch hold + warning; **Acknowledge**→complete-now (no comment) or **Keep as work**→`keptAsWork`, stays buildable; no auto-complete, no reopen (NG3/OD10) | P1 + P3 |
| Mismatch nobody acts on | Lingers on grid indefinitely + nightly summary; re-verified only when baseSha moves; never auto-resolves (OD10) | P1 + P3 |
| `keptAsWork` unit, task still closed | Skipped by verify **and** completion reconcile so the closed checkbox can't re-trigger mismatch/auto-complete; stays planned/buildable | P1 + P3 |
| Completion ages out of 60-day window | `todoistClosedSeen` sticky ⇒ unit does **not** flip back to "open" | P1 |
| `review`/open-PR, `needs-clarification`, `proposed` | Not verifiable (out of scope) | P1 |
| Overlay on off-grid (`blocked` w/o `devPipeline`) unit | `hasOverlay` forces it visible — no invisible overlay (R2-S8) | P1 + P6 |
| Human clicks "Go" on a likely-complete unit | Intentional override: soft confirm, not a hard block (R2-S3) | P6 |
| Build starts (3 entry points) | `clearVerificationOnBuild` from `startPlan`/`runDevPipeline`/`linkPlan` (R3-C4) | P5 |
| Reconcile ordering | Two disjoint passes; both verify-first (R2-S4/R3-#6) | P3 + P5 |
| Todoist task deleted while overlaid | `getTask`/`closeTask` 404 ⇒ clear overlay + `expired` | P3 (404 path) |
| Env unlinked from Todoist mid-flight | Sweep skips env; Confirm degrades to local-only | P3/P4 |
| **Gamed-spec** | Marking ✅ on fake tests while judgment is never exercised. **Mitigation:** blocking gate is the **deterministic** harness whose canned verdicts force ≥1 `done` + ≥1 `partial`; real-model eval is advisory; gate-5 reviewer **re-runs `bun test` at the SHA**; new tests carry `[Pn]` tags so "new tests ran green" is grep-checkable | §8 |

---

## 8. Evaluation & verification

**Technical (unit, deterministic, always-on CI):** `parseVerdict`, `selectVerifiableUnits`,
`combineSignals`, `isLikelyComplete`/`hasOverlay` (`autopilot-plans.ts`); `verifyUnit` with injected
`queryFn`; `WorkUnit` persist/reload (incl. `raw`); the reconcile with a fake model/Todoist + real store.

**Functional:**
1. **Lifecycle harness (blocking, always-on)** — fake clock/model (injected `queryFn`, canned verdicts),
   real `WorkUnitStore`, fake `TodoistClient`: drives each phase's Acceptance row (auto-complete-once,
   overlay, mismatch-hold + ack-exit, staleness 1→1 then re-verify on baseSha bump, auto-start pos/neg
   control, tick-defers, cancel/teardown, deleted-task 404). Canned verdicts force the full enum so a
   fail-open stub can't pass. **This is the gate.**
2. **Real-model eval (opt-in advisory, NOT a CI gate — R2-T1/T2/T9):** SDK has no temperature knob and an
   agentic verifier isn't sampling-deterministic, so a real-model pass/fail CI assertion is flaky/theater.
   Run locally with an account; **report** (don't gate) K-run agreement + sentinel-symbol citation per
   generated fixture; fixture labels versioned to a prompt hash. Pasted into the phase evidence as
   calibration.

> **No confidence-band gate.** All control flow keys on **structural** signals (per-task citation
> present / verdict enum), never a model-emitted `confidence` — uncalibrated, so gating on it tests
> verbosity (R2-T3). `confidence` is display-only.

**Per-phase done-gate — a row flips ✅ only after all pass:**
1. `bun test` — **0 failures**; new tests carry a `[Pn]` tag, and `bun test` filtered to the tag shows
   them green (grep-checkable against the diff — R2-T8). *[every phase]*
2. `tsc --noEmit` (daemon) + `typecheck:web` — exit 0. *[every phase]*
3. `bun run web/build.ts` — web-touching phases.
4. The phase's lifecycle-harness rows green.
5. **Fresh-context adversarial reviewer** checks out the SHA and **re-runs `bun test` itself** (this
   re-run, not pasted output, is the authority — CI uploads no per-SHA test artifact, R2-T7), reads the
   diff against the Acceptance row, and may veto.

> **Agent self-verification protocol (binding).** No row is ✅ on self-assessment. "Tested" requires the
> `[Pn]`-tagged tests shown green in a `bun test` run the reviewer **reproduces** at the SHA; "Pushed"
> requires a SHA/PR link. The real-model eval is advisory evidence, never the gate. An empty or
> non-reproducible evidence block is not done regardless of how finished the code looks.

**Verification evidence (one block per phase):**
```
### Phase N evidence
- bun test: <cmd> → <pass/fail>; [Pn] new tests: <names> green
- typecheck (daemon/web): <exit codes>
- web build: <exit / n/a>
- functional: <lifecycle-harness rows> → <result>
- real-model eval (advisory): <K-run agreement / sentinel-cite> or "not run"
- adversarial reviewer (re-ran tests @ SHA): <verdict + vetoes resolved>
- commit/PR: <sha / link>
```

---

## 9. Spec-critique changelog

Three fresh-context, three-reviewer rounds. Full per-finding logs are in git history; this is the
consolidated record.

- **Round 1 (2026-10-28) — testability / code / scope.** Fatal: *plan mode runs no tools* → tier-2 can't
  use plan mode. Structural: likely-complete became an **overlay, not a status**. Plus: capability gating
  must be explicit (daemon errors on unknown commands); `resolvePlan` posts no comment → new idempotent
  helper; `isLive` isn't a field → selectors take `liveIds`; worktree syncs to `origin/<base>` & always
  branches.
- **Round 2 (2026-10-29) — attacked the R1 fixes.** Testing strategy rested on category errors →
  **blocking gate = deterministic harness**, real-model eval **demoted to advisory** (no SDK temperature;
  agentic verifier isn't sampling-deterministic); escalation→**structural**, not a confidence band.
  Structural seams: mismatch had no exit → **`mismatchAck`**; "closed" is a 60-day window → **`todoistClosedSeen`
  sticky**; done-overlay unit still `planned` → manual "Go" override stated; reconcile race → **verify-first
  combined pass**; off-grid overlays → **grid-visibility invariant**; build-clear → one helper at 3 entry
  points; auto-start gate stays sync/SDK-free via an annotated field; single-flight needs the handler to
  set the run token.
- **Round 3 (2026-10-29) — consistency + complexity + build-readiness.** Complexity verdict:
  "ready-after-trimming." **Owner cut: tier-2 validation-running deferred to v1.1** (NG7/OD6) — removes the
  worktree-exec/allowlist/abort/prune cluster; tier-1 + human Confirm delivers the core value. Consistency
  fixes folded in: the nightly run has **two** verification passes (not "one") on disjoint unit sets;
  `hasOverlay = done ∨ mismatch` (the grid can't use `isLikelyComplete` alone); `combineSignals.overlay` is
  the single visibility flag; staleness simplified to **baseSha-moved only**; `clearVerificationOnBuild`
  justified by "starts real work" (not a `building`-grep — `runDevPipeline` doesn't set it); the **tick
  path** defers completing an unverified closed unit; metrics push envelope modeled on `run.progress`;
  citations clarified (`reconcileCompletedUnits` defined `:523`, called `:767`). Confirmed buildable: the
  `--detach` read helper, the fixture generator pattern, the multi-writer-safe run token.
- **OD10 resolved (owner interview, 2026-10-29).** The R2 `mismatchAck` sticky is **replaced**: Acknowledge
  now **completes immediately** (no persisted ack state), and a new **Keep-as-work** action
  (`keptAsWork` + `autopilot.verify.keep`) handles the mistaken-checkoff case by returning the unit to
  buildable. Untouched mismatches linger on the grid indefinitely. See OD10.

---

## 10. Open decisions

Defaults chosen without explicit sign-off — each reversible; object to flip.

- **OD1 — Blocking done-gate = deterministic harness; real-model eval = opt-in advisory.** (R2) *Default assumed.*
- **OD3 — Concurrency/cap:** 4 concurrent, ≤25 units/run, global across accounts; verifier never on the 5-min tick. *Default assumed.*
- **OD4 — Staleness = `baseSha` moved only** (no wall-clock timer — simpler + more correct; R3). *Default assumed.*
- **OD5 — Flag home:** `verifyEnabled` on `AutopilotScheduleStore`. *Default assumed.*
- **OD6 — Tier-2 deferred to v1.1 (owner decision, R3).** v1 is tier-1 static read only; a present-but-
  broken implementation can read `done` and relies on human Confirm (NG7). Revisit if flag-on experience
  shows tier-1 over-reports. *Confirmed by owner.*
- **OD7 — Task text drift:** verdict judged against current task text + stored plan. *Default assumed.*
- **OD8 — Fixtures generated at test time**, each with a sentinel symbol. *Default assumed.*
- **OD10 — Mismatch resolution (owner-confirmed 2026-10-29).** Two human actions on a mismatch card:
  **Acknowledge** = trust the checkbox → **complete immediately**, no close call (already closed), no
  evidence comment; **Keep as work** = the checkoff was a mistake → set `keptAsWork`, return the unit to
  `planned`/buildable (skipped by verify + completion thereafter). No persisted ack state (Acknowledge
  *is* completion). An untouched mismatch **lingers on the grid indefinitely** + nightly summary,
  re-verified only when `baseSha` moves; never auto-resolves. *Confirmed.*
