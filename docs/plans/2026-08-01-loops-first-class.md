# Loops as a First-Class Citizen — Specification

> **⚠ Direction superseded (2026-08-01):** the product model in this spec (wizard-form authoring over separate primitives) was reconceived as the **Loop Circuit** — see `2026-08-01-loop-circuit-concept.md`. The infrastructure sections here (store, protocol, fleet sync, durability, testing + done-gate) still apply, re-scoped to that model; the phase tables must be re-cut before build.

- **Status:** Draft (approved for phased build) · **Owner:** Evan · **Author:** Claude (PM + senior dev)
- **Created:** 2026-08-01 · **Branch:** `loops`
- **Supersedes/extends:** the loop-engineering foundation shipped this session (see [Phase 0](#phase-0--foundation-already-shipped)).

> **How to read this doc.** [§1–§3](#1-vision) are the *what and why*. [§4–§9](#4-loop-model) are the *design*. [§10](#10-phased-development-plan) is the *build plan* — the authoritative tracker for what's implemented, remaining, tested, and pushed. [§11](#11-testing--verification-strategy) is the testing + done-gate the agent must satisfy before marking anything done. Update the status tables in §10 as work lands; they are the single source of truth for progress.

---

## 1. Vision

Loops are Anvil's unit of autonomy: *do work, check it, repeat until a stop condition is met.* Today that capability is real but scattered across three primitives — the `/goal` Stop-hook, the in-daemon autopilot **schedule**, and the event **triggers**/proposals shipped this session — and it's only ever surfaced as a **derived, read-only** projection ([`buildLoopsSnapshot`](../../anvild/src/integrations/loops.ts)).

The problem this spec solves is the one the user named: **"how do you set a loop up and make sure each requirement for a successful loop is filled?"** A loop only works if four slots are filled — what **triggers** it, what it **does**, how it **verifies success (the stop condition)**, and what **guardrails** bound it. Nothing in Anvil today makes those four slots explicit, forces them to be complete, or lets you dial them in and monitor them over time.

**This spec makes a Loop a first-class, persisted, user-authored entity** with its own store, lifecycle, authoring wizard, and dedicated monitoring home — one that *compiles down* to the existing primitives at runtime so there is a single mental model instead of three.

### 1.1 Decisions locked in the design interview (2026-08-01)

| # | Question | Decision |
|---|----------|----------|
| 1 | Loop model | **Persisted first-class entity** (own store, CRUD, lifecycle, run history) |
| 2 | Relationship to primitives | **Loop compiles down** to goal + schedule + trigger at runtime |
| 3 | v1 triggers | **Schedule, Event, Manual, Chained** (all) |
| 4 | v1 actions (body) | **Session-prompt, Autopilot, Dev-pipeline, Skill/shell-check** (all) |
| 5 | Builder UX | **Stepper wizard** … reconciled with → |
| 6 | Arm gate | **Soft warnings + auto-defaults** (wizard guides; review warns but allows) |
| 7 | Dial-in tools | **Dry-run, test-the-check-now, next-fire+cost preview, single-step** (all) |
| 8 | Success/stop condition | **Composable checks** — deterministic (command/metric/http) AND/OR LLM-judge |
| 9 | Monitoring | **Dedicated Loops view + per-loop detail pages** |
| 10 | Mandatory guardrails | **Per-run budget cap + auto-pause after N failures** |
| 11 | Fleet scope | **Hub-authoritative catalog; executes on the daemon that owns the env** |
| 12 | Restart/durability | **Checkpoint & resume** (finest-grained the SDK allows; see [§8](#8-durability--checkpointresume)) |
| 13 | Resume semantics | **Sub-step target**, delivered as turn-level `--resume` + iteration/phase checkpoints |
| 14 | Loop run model | **Session for heavy bodies (own worktree), run-record for light bodies** |
| 15 | Editing an armed loop | **Must pause to edit** (+ config-change audit log) |
| 16 | Notifications | **Failure/auto-pause, approval-needed, success, daily digest** (all available) |
| 17 | Functional testing | **Deterministic headless lifecycle harness** |
| 18 | Done gate | **Executable acceptance script + adversarial reviewer agent** |
| 19 | Headline acceptance demo | **Schedule loop: fires → runs → judged → stops → logged** |
| 20 | Phasing | **Vertical slices, each shippable** |

### 1.2 Reconciled tensions (where two answers pulled apart)

- **Wizard (can't-skip) vs soft arm-gate (allow with defaults).** The authoring flow is a **stepper wizard** — each of the four contract slots is its own step so none is silently omitted — but every step offers a **"use recommended default"** affordance, and the final **Review** step shows a completeness meter with warnings yet **does not block Arm**. You are guided through all requirements; you are never trapped.
- **Full sub-step checkpoint vs SDK reality.** The Agent SDK query is **not resumable mid-turn**. We deliver the finest resume the platform supports: turn-boundary resume via Claude Code's native `--resume` (the `claudeSessionId` we already persist on a session) plus loop-level **iteration/phase checkpoints**. True intra-turn checkpointing is a documented, SDK-bounded stretch goal ([§8.3 risk](#83-risks)).
- **Must-pause-to-edit vs config versioning.** Because armed loops are **read-only until paused**, there is never an in-flight version conflict, so we skip heavyweight per-run version pinning and instead keep a lightweight **config-change audit log** (`configRevision` + change entries) to answer the monitoring question *"why did this loop's behavior change?"*.

---

## 2. Goals & non-goals

**Goals**
- A Loop is a real object: named, listed, edited, paused, resumed, deleted, with durable run history.
- The four contract slots (trigger · action · success-check · guardrails) are explicit and the UI makes completeness visible.
- Authors can **dial a loop in** — dry-run, test the check, preview next fire + cost, single-step — before trusting it.
- A dedicated **Loops** view is the home for setup and monitoring.
- The build is **verifiable**: every phase has a deterministic functional test and an executable done-gate the agent runs before claiming done.

**Non-goals (v1)**
- A visual DAG editor for chained loops (chaining is config-level in v1).
- Arbitrary third-party integrations beyond the trigger channels already modeled (`ci-failure | github | todoist-label | webhook | manual`).
- Multi-tenant/shared-team loop ownership beyond the existing hub/fleet model.
- Replacing the autopilot card grid (loops and autopilot coexist; a loop *body* can be "run autopilot").

---

## 3. Glossary

- **Loop** — the persisted config entity (trigger + action + checks + guardrails + notify).
- **Loop Contract** — the four required slots that must be filled for a loop to be valid.
- **Run** — one execution of a loop's body, iterated until a check passes or a guardrail stops it.
- **Iteration** — one pass of the body+check cycle within a run (mirrors `goal.iterations`).
- **Check** — one success test (deterministic or judge); a run's stop condition is a composition of checks.
- **Armed** — enabled and eligible to fire. **Paused** — retained but not firing. **Draft** — incomplete, never fires.

---

## 4. Loop model

A Loop **owns** its runtime primitives. When armed, it *compiles* to the existing machinery rather than duplicating it:

| Loop trigger | Compiles to |
|---|---|
| `schedule` | the `AutopilotScheduleStore` due-logic (`scheduledFireDue`/`nextScheduledFire`) generalized per-loop |
| `event` | the `autopilot.trigger` intake (`normalizeTrigger`) → routed to this loop |
| `manual` | a `loops.run` command |
| `chained` | a post-run hook that fires the dependent loop |

| Loop action (body) | Compiles to |
|---|---|
| `session-prompt` | a fresh-worktree Session driven by a prompt, stop-gated by the `/goal` Stop-hook (`makeStopHook`) |
| `autopilot` | `Supervisor.runAutopilot(...)` |
| `pipeline` | `Supervisor.runDevPipeline(...)` |
| `skill-check` | a skill invocation or a shell command (no worktree unless it writes) |

| Loop check (stop condition) | Compiles to |
|---|---|
| `judge` | the existing `judgeGoal` Haiku judge |
| `command` | run a shell command; pass on expected exit code |
| `metric` | read a numeric source; compare to a threshold |
| `http` | request a URL; pass on expected status/body predicate |

### 4.1 Data model (authoritative TypeScript shapes)

Lives in `@protocol` (wire) with the store type mirrored in `anvild/src/loops/store.ts`.

```ts
type LoopStatus = "draft" | "armed" | "paused" | "disabled";

interface Loop {
  id: string;                 // "loop_..."
  name: string;
  description?: string;
  environmentId?: string;     // which env (and thus which daemon) executes it
  status: LoopStatus;
  trigger: LoopTrigger;
  action: LoopAction;
  successMode: "all" | "any"; // how the checks combine
  checks: LoopCheck[];        // >= 1 required to leave draft cleanly (soft-warned otherwise)
  guardrails: LoopGuardrails;
  notify: LoopNotifyPrefs;
  configRevision: number;     // bumped on every edit (audit)
  consecutiveFailures: number;// drives auto-pause
  lastRunId?: string;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

type LoopTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; timeOfDay: string; days?: number[] }
  | { kind: "event"; eventKind: TriggerKind; dedupe?: string; autoApprove?: boolean }
  | { kind: "chained"; onLoopId: string; on: "success" | "failure" | "any" };

type LoopAction =
  | { kind: "session-prompt"; prompt: string; model?: Model; autonomy?: AutonomyPolicy }
  | { kind: "autopilot"; environmentId?: string }
  | { kind: "pipeline"; workUnitId?: string }
  | { kind: "skill-check"; command?: string; skill?: string };

type LoopCheck =
  | { kind: "judge"; condition: string }
  | { kind: "command"; command: string; expectExit?: number }   // default 0
  | { kind: "metric"; command: string; op: "gte" | "lte" | "eq"; threshold: number }
  | { kind: "http"; url: string; expectStatus?: number };        // default 2xx

interface LoopGuardrails {
  maxIterations: number;          // default 10 (mirrors GOAL_MAX_ITERATIONS)
  perRunTokenBudget?: number;     // MANDATORY-configurable; hard stop → "over-budget"
  perRunTimeBudgetMs?: number;    // hard stop → "over-budget"
  autoPauseAfterFailures: number; // default 3; 0 disables
  requireApprovalFirstRun?: boolean; // optional (propose-don't-run for a new loop)
  maxConcurrentRuns?: number;     // optional
}

interface LoopNotifyPrefs {
  onFailure: boolean;   // default true
  onApproval: boolean;  // default true
  onSuccess: boolean;   // default false (opt-in; noisy for frequent loops)
  dailyDigest: boolean; // default false
}

type LoopRunStatus =
  | "queued" | "running" | "succeeded" | "failed"
  | "blocked" | "over-budget" | "interrupted" | "paused";

interface LoopRun {
  id: string;                 // "run_..."
  loopId: string;
  configRevision: number;     // the loop version this run executed
  trigger: { kind: string; source?: string; at: Iso8601 };
  status: LoopRunStatus;
  iterations: number;
  sessionId?: SessionId;      // present for heavy (session) bodies
  checkVerdicts: { check: string; passed: boolean; detail?: string; at: Iso8601 }[];
  cost?: { tokens?: number; ms?: number };
  checkpoint?: LoopCheckpoint;// resume state (see §8)
  reason?: string;            // why it ended (last blocker, budget, error)
  startedAt: Iso8601;
  endedAt?: Iso8601;
}

interface LoopCheckpoint {
  iteration: number;
  claudeSessionId?: string;   // turn-level resume via Claude Code --resume
  pipelinePhase?: string;     // resume the pipeline body at the last completed phase
  updatedAt: Iso8601;
}
```

---

## 5. Architecture

Follows Anvil's established patterns exactly (mapped in the design exploration):

- **Store** — `anvild/src/loops/store.ts` `LoopStore`, modeled on `AutopilotScheduleStore`: atomic write via `writeFileAtomic`, persisted to `<stateDir>/loops/loops.json` (catalog) and `<stateDir>/loops/runs/<loopId>.jsonl` (append-only run history). Corrupt-file quarantine like `WorkUnitStore.load()`.
- **Protocol** — new wire types in `docs/plans/anvil-protocol.ts` (the real file behind the `anvild/protocol.ts` symlink):
  - Events: `loops.list` (catalog), `loop.updated` (one loop), `loop.run` (a run record/update), `loop.runs` (a loop's history), `loops.snapshot` (existing live projection — kept, now sourced from real loops).
  - Commands: `loops.list`, `loop.save`, `loop.remove`, `loop.arm`, `loop.pause`, `loop.run` (run-now), `loop.dryRun`, `loop.testCheck`, `loop.step`, `loop.runs.get`.
- **Supervisor** — `LoopStore` field + methods: `loopsEvent()`, `saveLoop()`, `removeLoop()`, `armLoop()`/`pauseLoop()`, `runLoop()`, `dryRunLoop()`, `testLoopCheck()`, `stepLoop()`. A **LoopEngine** (`anvild/src/loops/engine.ts`) owns execution: trigger scheduling tick, run lifecycle, iteration+check loop, guardrail enforcement, checkpoint persistence, notifications.
- **Execution** — `session-prompt`/`pipeline` bodies spawn a **fresh worktree Session** (`createWorktree` + `handoffCreate`), reusing all existing transcript/monitoring infra; `skill-check` bodies run as a lightweight `LoopRun` with no worktree. Each heavy run gets **its own worktree** (per interview note) so concurrent runs never collide.
- **Fleet/hub** — the **hub holds the authoritative catalog** and broadcasts it (`registry.toAll(loopsEvent())`); a loop **executes on the daemon that owns `environmentId`** (the hub forwards a run request to that member; members report run state back to the hub, which re-broadcasts). Clients keep a localStorage instant-paint cache overwritten by the hub broadcast (mirrors the prompt-library pattern).
- **Capability** — add `"loops"` to `SERVER_CAPABILITIES` in `anvild/src/server/identity.ts`; the web gates all loop commands behind `serverSupports(hub(), "loops")` so older members degrade gracefully.
- **Web** — a new top-level overlay/view `"loops"` (`openOverlay("loops", closeLoops, "#loops")`) with deep-link support, plus the wizard and detail pages ([§7](#7-ux)).

---

## 6. The Loop Contract (completeness model)

The contract is the spec's core UX idea. A Loop is **valid** when all four slots are filled:

| Slot | Filled when | Auto-default if skipped |
|---|---|---|
| **Trigger** | a trigger kind + its params are set | `manual` |
| **Action** | an action kind + its required params are set | *(none — action is the one hard requirement)* |
| **Success check** | ≥ 1 check configured | a `judge` check seeded from the action's intent |
| **Guardrails** | a per-run budget cap + iteration cap set | `maxIterations: 10`, `autoPauseAfterFailures: 3`, prompt for a budget cap |

The wizard renders a **live completeness meter** (4 pips, red→green). Per the arm-gate decision, arming with an unfilled slot is **allowed** but fills the default and shows a warning banner naming exactly what was auto-defaulted — so "requirements filled" is always *true at arm time*, either by the user or by an explicit, visible default. The only genuinely blocking condition is a missing/invalid **action** (a loop with no body can't run).

---

## 7. UX

### 7.1 The dedicated Loops view (`#loops`)
- **List:** every loop across the fleet, grouped by environment, each row = name · trigger summary · status chip · last-run verdict · next-fire · sparkline of recent runs. Reuses the `loop-row` visual language already added to the Autopilot Loops panel.
- **Detail page (per loop):** the contract summary (4 slots), the run-history **timeline**, cost/duration **trend**, success-vs-fail **sparkline**, live iteration counter, last verdict + blocker, and controls (Run now · Pause/Arm · Edit (→ pause) · Dry-run · Delete). Clicking a run opens its Session (heavy body) or its run record (light body).

### 7.2 The authoring wizard (stepper)
Steps: **① Trigger → ② Action → ③ Success checks → ④ Guardrails & notifications → ⑤ Review & dial-in.** Each step has a "use recommended default" button. Step ⑤ shows the completeness meter, the auto-default warnings, and the four **dial-in tools**:
- **Dry-run / simulate** — execute one run in a throwaway worktree with side effects suppressed (no PR, no push, no Todoist writes); show what it did + each check verdict.
- **Test the check now** — run just the composed success check against current state → "would pass / would fail + why".
- **Next-fire + cost preview** — computed next trigger time + estimated tokens/time per run, updating live as the config changes.
- **Single-step** — run exactly one iteration and pause for inspection before arming.

### 7.3 Monitoring signals
- Live status via the existing `loops.snapshot` broadcast (now backed by real loops), plus `loop.run` updates streamed as a run progresses (iteration count, current check verdict).
- Notifications per `LoopNotifyPrefs` via the existing web/FCM/APNs push (`webpush`/`fcm`/`apns`).

---

## 8. Durability & checkpoint/resume

### 8.1 Model
- The engine persists a `LoopCheckpoint` on the `LoopRun` at every **iteration boundary** and at every **completed pipeline phase**.
- On daemon restart, an in-flight run is loaded as `interrupted`; the engine offers **resume** (default for `schedule`/`chained`, prompt for `manual`) which restarts the body at `checkpoint.iteration`, re-attaching the Claude session via `--resume` (`claudeSessionId`) so the model keeps its context, and re-entering the pipeline at `checkpoint.pipelinePhase`.
- A never-latching **running** state: like the autopilot run watchdog, a run's live status is time-bounded by `perRunTimeBudgetMs`, so a hung run can't pin the UI.

### 8.2 Resume granularity (honest scope)
- **Turn-boundary resume:** delivered — Claude Code's native `--resume` restarts the session at its last completed turn.
- **Iteration/phase checkpoint:** delivered — the loop re-enters at the last completed iteration/phase.
- **Intra-turn (sub-step) resume:** *not deliverable on the current SDK* (a query is not resumable mid-turn). Documented as best-effort/stretch; the interim behavior is: the interrupted turn re-runs from its start (idempotent for read-only/plan phases; the pipeline's P3/P4 write phases re-run against the persisted worktree).

### 8.3 Risks
- **R1 (SDK):** intra-turn checkpoint is impossible today → mitigated by turn-level `--resume`; revisit if the SDK adds mid-turn resumability.
- **R2 (idempotency):** re-running a write phase after a crash could double-apply side effects → mitigation: worktree is the unit of isolation; phases are designed to be re-runnable against the persisted worktree; external side effects (PR open, push) are guarded by "already done?" checks before repeating.

---

## 9. Security & guardrails

- **Trigger intake** (`event`/webhook) inherits Anvil's Tailscale trust boundary; a webhook trigger endpoint (Phase 2) is gated behind the same network boundary and requires the `loops` capability. No new app-layer auth (per the accepted security-boundary memory).
- **Mandatory guardrails on every armed loop:** a per-run budget cap and auto-pause-after-N-failures (interview §10). A loop that trips its budget ends `over-budget`; one that fails N consecutive runs flips to `paused` and notifies.
- **Propose-don't-run** carries over: `requireApprovalFirstRun` (optional per loop) routes a new loop's first live run through the existing approval gate.

---

## 10. Phased development plan

Vertical slices — **each phase is independently usable and shippable.** Legend for the status tables:
`☐` not started · `◐` in progress · `☑` done. **Tested** = has passing unit + functional harness coverage. **Pushed** = merged to the working branch / committed (this session's work is working-tree only unless noted).

> **The agent MUST NOT mark a phase row `☑` in "Implemented" until its [Done-Gate](#112-the-per-phase-done-gate) passes and the evidence block is pasted into that phase's section.**

### Phase 0 — Foundation (already shipped this session)
The loop-engineering primitives this spec builds on.

| Deliverable | Implemented | Tested | Pushed |
|---|---|---|---|
| `loops.snapshot` live projection (`buildLoopsSnapshot`) | ☑ | ☑ | ◐ (working tree) |
| Event intake + dedupe (`event-trigger.ts`) | ☑ | ☑ | ◐ |
| `proposed` status + `autopilot.approve` (propose-don't-run) | ☑ | ☑ | ◐ |
| Goal Stop-hook run-until-done (`agent/goal.ts`) | ☑ | ☑ | ◐ |
| Goal-seeded build sessions + adversarial hold on cards | ☑ | ☑ | ◐ |
| Loops panel + card chips + loopback narrative (web) | ☑ | ◐ (manual) | ◐ |

### Phase 1 — Loop entity + manual run + judge check + detail view *(shippable: create a loop, Run now, watch it)*
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| `Loop`/`LoopRun` protocol types + `LoopStore` (atomic, JSONL history) | ☐ | ☐ | ☐ |
| `"loops"` capability + `loops.list`/`loop.save`/`loop.remove`/`loop.run` cmds | ☐ | ☐ | ☐ |
| `LoopEngine`: run lifecycle for `session-prompt` body + `judge` check | ☐ | ☐ | ☐ |
| Run history + `loop.run`/`loop.runs` events | ☐ | ☐ | ☐ |
| Web: `#loops` view (list + detail page) + Run-now | ☐ | ☐ | ☐ |
| **Acceptance:** create a loop, Run now, judge verdict renders, run stops, run logged in history | ☐ | ☐ | ☐ |

### Phase 2 — Triggers (schedule + event + chained) + mandatory guardrails + notifications
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Schedule trigger (per-loop due-logic, edge-triggered) | ☐ | ☐ | ☐ |
| Event trigger routing (`autopilot.trigger` → loop) + chained triggers | ☐ | ☐ | ☐ |
| Guardrails: per-run budget cap (→ `over-budget`) + auto-pause-after-N | ☐ | ☐ | ☐ |
| Notifications (failure/approval/success/digest) via existing push | ☐ | ☐ | ☐ |
| **Acceptance (HEADLINE DEMO):** schedule loop fires on time → runs → judged → stops → logged | ☐ | ☐ | ☐ |

### Phase 3 — Composable deterministic checks + dial-in tools
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| `command`/`metric`/`http` checks + `successMode` all/any | ☐ | ☐ | ☐ |
| Dry-run/simulate (side-effect-suppressed) + `loop.dryRun` | ☐ | ☐ | ☐ |
| Test-the-check-now + next-fire+cost preview + single-step | ☐ | ☐ | ☐ |
| **Acceptance:** dry-run produces no side effects; a failing deterministic check gates a run; check-now matches a real run's verdict | ☐ | ☐ | ☐ |

### Phase 4 — Authoring wizard + monitoring depth + edit lifecycle
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Stepper wizard with completeness meter + auto-default warnings | ☐ | ☐ | ☐ |
| Detail page: timeline, cost/duration trend, success sparkline | ☐ | ☐ | ☐ |
| Pause-to-edit + `configRevision` audit log | ☐ | ☐ | ☐ |
| **Acceptance:** a loop authored end-to-end in the wizard arms with all four contract slots green; editing requires pause; history shows the config change | ☐ | ☐ | ☐ |

### Phase 5 — Fleet/hub sync + heavy bodies + checkpoint/resume
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Hub-authoritative catalog synced to members (capability-gated) | ☐ | ☐ | ☐ |
| Execute-where-env-lives routing (hub → owning member → hub) | ☐ | ☐ | ☐ |
| `autopilot` + `pipeline` action bodies (own worktree per run) | ☐ | ☐ | ☐ |
| Checkpoint at iteration/phase; resume via `--resume` on restart | ☐ | ☐ | ☐ |
| **Acceptance:** a member-hosted loop runs where its env lives; kill a run mid-flight → daemon restart → run resumes/cleanly retries with no stuck "running" state | ☐ | ☐ | ☐ |

---

## 11. Testing & verification strategy

Testing covers **both** the technical implementation (units) **and** the functional behavior (lifecycle harness), per the interview.

### 11.1 Layers
1. **Unit tests** (`test/unit/`, `bun test`) — pure logic: loop validation/completeness, contract defaulting, check composition (`all`/`any`), guardrail math (budget/auto-pause), schedule due-logic per loop, checkpoint serialization, snapshot projection. Follow existing patterns (`autostart-gate.test.ts`, `loops.test.ts`).
2. **Deterministic functional lifecycle harness** (`test/integration/loops-*.test.ts`) — the primary functional guarantee. A fake clock, fake model/judge, and a fixture environment drive a loop through its **whole lifecycle** and assert observable outcomes: trigger fires → body runs → checks render a verdict → run stops with the right status → run record persisted; plus guardrail trips (`over-budget`, auto-pause), dry-run side-effect suppression, and resume-after-interrupt. No real model spend; reproducible in CI.
3. **Thin manual/visual pass** — a short scripted checklist (via the `/verify` skill) for the wizard + detail-page visuals a headless test can't see. Documented per phase, not a merge blocker but a done-gate input for UI phases.

### 11.2 The per-phase Done-Gate
A phase is **not done** until the agent runs and pastes evidence for this gate **and** an adversarial reviewer signs off:

**A. Executable acceptance script** (must show green):
```
bun test                                   # unit + functional harness, 0 fail
./node_modules/.bin/tsc --noEmit           # daemon typecheck, exit 0
./node_modules/.bin/tsc --noEmit -p web/tsconfig.json   # web typecheck, exit 0
bun run web/build.ts                        # web bundle builds
bun test ./test/integration/loops-<phase>.test.ts       # THIS phase's functional scenario, 0 fail
```
The phase's functional scenario test **is** its acceptance criterion encoded — it asserts the observable success demarcation in that phase's Acceptance row.

**B. Adversarial reviewer** — a fresh-context reviewer agent (see `code-review`/adversarial pattern) independently checks the phase against its acceptance row and the contract completeness rules, and can **veto** "done". Its verdict is pasted alongside the script evidence.

**C. Evidence block** — appended to the phase's section:
```
### Phase N evidence (YYYY-MM-DD)
- bun test: <pass/fail counts>
- typecheck (daemon/web): <exit codes>
- web build: <ok>
- functional scenario (loops-<phase>): <pass/fail>
- adversarial review verdict: <approved / vetoed + reasons>
- pushed: <commit sha / "working tree">
```
Only after B approves and C is filled may the phase's **Implemented** cells flip to `☑`.

### 11.3 Definition of Done (global)
The whole feature is done when:
- All Phase 1–5 acceptance rows are `☑` with pasted evidence.
- The **headline demo** (Phase 2 schedule loop: fires → runs → judged → stops → logged) passes in the functional harness **and** is demonstrated once against a real environment.
- Every armed-loop path enforces the two mandatory guardrails (budget cap + auto-pause).
- Protocol golden regenerated (`test/contract/regen-golden.ts` flow) and the Swift/Kotlin clients' new wire types are tracked as a follow-up (the golden regen is the checkpoint).
- No stuck "running" state is reachable (watchdog/time-bound verified by a functional test).
- Docs: this file's status tables reflect reality; a short user-facing "Authoring a loop" note added.

---

## 12. Open decisions (defaults chosen; revisit if needed)
- **Webhook trigger transport** (Phase 2): default = a daemon HTTP endpoint behind the Tailscale boundary, `loops` capability required. Alternative = poll-only (no inbound endpoint). *Default assumed unless you object.*
- **Chained-loop cycle protection:** default = reject arming a chain that forms a cycle (static check at save).
- **Run-history retention:** default = keep last 200 runs per loop in JSONL, older truncated (logged).
- **Per-loop autonomy/account:** default = inherit the target environment's account (like autopilot); overridable per loop later.

---

## 13. Appendix — file map (where each piece lands)
- `docs/plans/anvil-protocol.ts` — Loop/LoopRun types, events, commands (behind the `anvild/protocol.ts` symlink).
- `anvild/src/loops/store.ts` — `LoopStore` (catalog + JSONL run history).
- `anvild/src/loops/engine.ts` — `LoopEngine` (trigger tick, run lifecycle, checks, guardrails, checkpoint, notify).
- `anvild/src/loops/contract.ts` — pure validation/completeness/defaulting (heavily unit-tested).
- `anvild/src/integrations/loops.ts` — existing `buildLoopsSnapshot`, re-sourced from real loops.
- `anvild/src/integrations/event-trigger.ts` — existing intake, extended to route to a loop.
- `anvild/src/session/supervisor.ts` — store field + `loop*` methods; engine wiring.
- `anvild/src/server/dispatch.ts` — `loop.*` command cases.
- `anvild/src/server/identity.ts` — `"loops"` capability.
- `anvild/web/src/main.ts` — `#loops` view, wizard, detail pages, dial-in tools.
- `anvild/web/styles/app.css` — loop view/wizard styles (extends the `loop-row`/`loops-panel` classes already added).
- `anvild/test/unit/loop-*.test.ts` + `anvild/test/integration/loops-*.test.ts` — unit + functional harness.
