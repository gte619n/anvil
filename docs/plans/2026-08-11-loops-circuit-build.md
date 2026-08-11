# Loops Circuit — Build Specification

- **Status:** Draft | **Spec-critiqued** | Approved | Building | Done · **Owner:** Evan · **Author:** Claude
- **Created:** 2026-08-11 · **Branch:** new branch off `origin/main` (Phase 0 merged as v4.0.53 / PR #193)
- **Supersedes/extends:** implements `2026-08-01-loop-circuit-concept.md` (design of record); re-cuts the phase tables of `2026-08-01-loops-first-class.md` (v1 spec — its infra decisions carry over); follows `SPEC-TEMPLATE.md`.

## 1. Objective & non-goals

Ship the **Loop Circuit as a real product surface**: a first-class, persisted `Loop` entity with a dedicated **Loops home** (`#loops`), every loop drawn as the same circuit (**Trigger → Act ⇄ Check → 🔒 gate → Ship**), authored through a **Claude-led intake conversation**, bounded by three hard stops, and monitored through lap history — replacing the autopilot card grid and sidebar entry by the final phase. A user can state an outcome ("fix the flaky upload test"), answer 3–4 one-tap questions, watch the circuit light up, dry-run a lap, arm the loop, and later do exactly one of two things at the gate: **open it** or **send back a lap**.

**Non-goals (this spec):**
- No sandbox/container isolation for laps (sandcastle-style mount enforcement was evaluated and rejected 2026-08-11); scope is enforced by lap-boundary diff guard only.
- No visual DAG editor for chained loops (chaining is config-level).
- No new trigger channels beyond the existing `TriggerKind` set; no Todoist webhooks (polling stays).
- No `Ship` (auto-merge) rung until Phase 5 — new loops cannot merge unattended before promotion machinery exists.
- No native (Swift/Kotlin) work: both apps are WebView shells; all UI lands in the web client.
- No removal of the autopilot *machinery* (planner, work units, pipeline) — only its *surface* (grid, sidebar label, flags) is retired, per concept §6.3.

## 2. Context

Phase 0 (merged to `main` as v4.0.53) shipped the loop-engineering **foundation — a read-only projection plus intake plumbing, NOT a persisted entity**: the `loops.snapshot` fold over existing state, event-trigger intake with `proposed` status + `autopilot.approve`, durable adversarial holds, goal-seeded build sessions, and a compact Loops panel inside the Autopilot view. No `Loop`/`LoopRun` types exist in the protocol yet; Phase 2 builds the entity and store from scratch. The catalog incident (autopilot building an underspecified task) motivated propose-don't-run and the specification-engineering additions (Contract v2: scope + check integrity; "still ambiguous" intake step).

Since Phase 0 was designed, `main` landed the **P7 decomposition**: autopilot logic lives in `anvild/src/session/autopilot-service.ts` (Supervisor delegates), and the web client is modular (`web/src/autopilot.ts`, `fleet.ts`, `overlays.ts`, `state.ts`). This spec targets that architecture — the v1 spec's references to a monolithic Supervisor/main.ts are obsolete.

Decisions of record: the 20-item interview table in the v1 spec §1.1; the circuit model, autonomy-as-gate-position, and migration plan in the concept doc §2–§6; retire-the-cards (decided 2026-08-12, concept §6.3); Contract v2 (concept §2.1). Interactive mock: `anvild/web/preview/loops-preview.html`; walkthrough deck: `anvild/web/preview/deck/`.

## 3. Inputs & scope

- **In scope (files/modules/systems):**
  - `docs/plans/anvil-protocol.ts` (via the sanctioned regen flow) — Loop/LoopRun wire types, `loop.*` commands/events, `loops` capability.
  - `anvild/src/loops/` (new): `store.ts`, `engine.ts`, `contract.ts`, `checks.ts`, `scope-guard.ts`.
  - `anvild/src/session/autopilot-service.ts`, `supervisor.ts`, `server/dispatch.ts`, `server/identity.ts` — wiring, delegation, capability.
  - `anvild/src/integrations/loops.ts`, `event-trigger.ts`, `workunit.ts` — projection re-source, trigger routing, draft conversion.
  - `anvild/web/src/`: new `loops.ts` (+ `loops-intake.ts`); `overlays.ts` (add `"loops"` to `OverlayName` + hash helper); `main.ts` (event-router cases, `#loops` route, init wiring); `fleet.ts` (`serverLoops`-style caches for `loop.updated`/`loop.run`, cleanup on removeServer); `autopilot.ts` (draft convert entry, Phase 4 retirement); `index.html` (sidebar entry), `styles/app.css`.
  - `anvild/test/unit/loop-*.test.ts`, `anvild/test/integration/loops-*.test.ts`.
- **Out of bounds (must not modify):**
  - `test/contract/protocol-surface.golden.json` except via regen after an intentional protocol change.
  - Existing acceptance-check test files backing the done-gate (check-integrity applies to us too).
  - The Tailscale trust boundary — no app-layer auth (accepted security decision).
  - Autopilot behavior regressions before Phase 4: until the flip, the existing grid/schedule/flags must keep working unchanged. **Two review surfaces coexisting through Phases 1–3 (cards + loop pages) is deliberate** (concept §6.3 step 1 "coexist"); the retire-the-cards decision executes at Phase 4, not before.
  - The Agent SDK internals — resume uses only public `--resume`/`claudeSessionId` surface.
- **Available inputs/tools:** Phase 0 primitives (goal Stop-hook, event-trigger, holds, `loops.snapshot`), `AutopilotService` deps pattern, `AutopilotScheduleStore` due-logic, worktree lifecycle (`createWorktree`/`removeWorktree`), push registries, functional-test harness patterns (`test/integration/goal-flow.test.ts` SDK mocking).
- **Assumptions log:**
  - "**Laps**" is the user-facing word for iterations (open question; owner may swap to "attempts" — string-table change only). *Unconfirmed.*
  - Gate-promotion suggestion threshold = **3 clean gated laps**. *Unconfirmed.*
  - Phase 2's minimal "New loop" dialog is **scaffolding** that Phase 3's intake conversation replaces as the primary path (dialog remains as a power-user escape hatch). *Confirmed by phasing decision.*
  - A lap for a `session-prompt` body = one full agent turn cycle ending in a Stop-hook evaluation (reuses `goal.iterations` semantics). *Design decision, confirmed by concept.*
  - The daemon that owns `environmentId` executes the loop; loops with no environment run on the hub. *From v1 fleet decision.*

## 4. Design

### 4.1 Data model (wire + store; authoritative)

```ts
type LoopStatus = "draft" | "armed" | "paused" | "disabled";
type LoopRung = "suggest" | "draft" | "pr" | "ship"; // gate position = autonomy (concept §2)

interface Loop {
  id: string;                  // "loop_…"
  name: string;
  environmentId?: string;      // owning env → executing daemon; absent = hub
  status: LoopStatus;
  trigger: LoopTrigger;        // manual | schedule | event | chained
  act: LoopAct;                // session-prompt | autopilot | pipeline | skill-check
  checks: LoopCheck[];         // ≥1 to arm without warning; judge | command (P2) · metric | http (P4)
  checksMode: "all" | "any";
  scope?: LoopScope;           // Contract v2: allowed globs + implicit check-file locks
  rung: LoopRung;
  hardStops: { maxLaps: number; tokenBudget: number; timeBudgetMs?: number; noProgressLaps: number };
  // maxLaps default 10 · tokenBudget REQUIRED (contract.ts defaults: 300k session/skill bodies, 500k
  // autopilot/pipeline bodies — the mandatory-budget guarantee is structural, not optional) ·
  // timeBudgetMs optional extra ceiling · noProgressLaps default 2
  assumptions: string[];       // logged at intake ("still ambiguous" acceptances)
  notify: { onGate: boolean; onFailure: boolean; onSuccess: boolean; dailyDigest: boolean };
  cleanGatedLaps: number;      // consecutive human-approved laps → promotion suggestion
  configRevision: number;      // bumped on every edit; a run pins the revision it started with
  workUnitId?: string;         // set when this loop was converted from an autopilot draft
  createdAt: Iso8601; updatedAt: Iso8601;
}

type LoopTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; timeOfDay: string; days?: number[] }              // AutopilotScheduleStore due-logic, per loop
  | { kind: "event"; eventKind: TriggerKind; dedupeKey?: string }
  | { kind: "chained"; onLoopId: string; on: "success" | "failure" | "any" };

type LoopAct =
  | { kind: "session-prompt"; prompt: string; model?: Model; autonomy?: AutonomyPolicy }
  | { kind: "autopilot" }                                                  // RESERVED: only the daemon-managed Todoist-intake
                                                                           // singleton (contract.ts rejects it on user-created loops)
  | { kind: "pipeline" }                                                   // §4 dev pipeline over the linked unit
  | { kind: "skill-check"; command: string };                              // deterministic body, no model

type LoopCheck = { locks?: string[] } & (                                // locks: globs the acting lap may NOT touch
  | { kind: "judge"; condition: string }                                   // judgeGoal, maker–checker separated
  | { kind: "command"; command: string; expectExit?: number }
  | { kind: "metric"; command: string; op: "gte" | "lte" | "eq"; threshold: number }
  | { kind: "http"; url: string; expectStatus?: number });
// Check-input lock rule (deterministic, testable): the guard denies the union of every check's `locks`.
// `locks` is EXPLICIT config — intake auto-suggests it for command/metric checks by extracting
// repo-relative path tokens from the command string that exist on disk (the user confirms); judge/http
// checks default to no locks (their inputs live outside the worktree). No hidden inference in the engine.

interface LoopScope { allow: string[]; note?: string }                     // globs relative to repo root

type LapVerdict = "pass" | "fail" | "check-error" | "scope-violation" | "check-tampering";
interface Lap { n: number; summary: string; verdicts: { check: string; v: LapVerdict; detail?: string }[]; tokens?: number; at: Iso8601 }

type LoopRunStatus = "running" | "at-gate" | "shipped" | "failed" | "over-budget" | "no-progress" | "interrupted" | "sent-back";
interface LoopRun {
  id: string; loopId: string; configRevision: number;
  trigger: { kind: string; source?: string; at: Iso8601 };
  status: LoopRunStatus;
  laps: Lap[];
  sessionId?: SessionId;        // heavy bodies; tapping a lap opens this transcript
  checkpoint?: { lap: number; claudeSessionId?: string; pipelinePhase?: string };
  gate?: { openedAt?: Iso8601; sentBackNote?: string };
  reason?: string;              // terminal explanation (budget, no-progress, error)
  startedAt: Iso8601; endedAt?: Iso8601;
}
```

**Persistence** (`anvild/src/loops/store.ts`, patterned on `AutopilotScheduleStore` + `WorkUnitStore`): catalog at `<stateDir>/loops/loops.json` (atomic write, corrupt-file quarantine); runs appended to `<stateDir>/loops/runs/<loopId>.jsonl`, last 200 retained per loop (truncation logged).

### 4.2 Engine (`anvild/src/loops/engine.ts`)

Owned by the daemon, wired through `AutopilotService`-style injected deps. Responsibilities: per-loop trigger tick (schedule reuses `scheduledFireDue` semantics — edge-triggered, no restart catch-up); run lifecycle (`lap → checks → verdict → repeat | gate | stop`); hard-stop enforcement (lap ceiling; token/time budget evaluated at lap boundaries; **no-progress = N consecutive laps with identical failing verdict sets AND an empty diff delta, and it is TERMINAL** — the run ends `no-progress`, it never parks at the gate); **scope guard** (lap-boundary `git diff --name-only` matched against `scope.allow`; a check's own input files are implicitly denied → `check-tampering`); gate handling (`at-gate` pauses the run; `loop.gate.open` ships per rung — Suggest: publish report · Draft: push branch · PR: open PR; `loop.gate.sendback` records the note and runs one more lap with it injected); checkpoint persisted **at each lap boundary, after the verdict is rendered** (a crash mid-check resumes by re-running that lap's checks against the persisted worktree); member-assigned runs time out `interrupted` if the member doesn't ack `loop.run.assign` within **60s**; notifications via existing push registries.

**Maker–checker:** `judge` checks run through `judgeGoal` in a separate spawn, never the acting session. `command`/`metric` checks execute in the run's worktree with the working tree as-is.

**Session bodies:** a lap = drive the session one turn-cycle (the goal Stop-hook mechanism generalized: the engine arms an internal goal derived from `checks` and reads verdicts off the hook), so live iteration counts ride the existing `session.updated` path.

### 4.3 Fleet & protocol

Hub-authoritative catalog: hub persists all loops, broadcasts `loops.list`; a loop with a member-owned env is **forwarded** to that member for execution (`loop.run.assign` hub→member over the existing fleet socket), and the member streams `loop.run` updates back for re-broadcast. Members without the `loops` capability: their envs' loops are hub-held and shown "waiting for daemon update". New capability `"loops"` in `SERVER_CAPABILITIES`; web gates every `loop.*` send on `serverSupports`.

**Commands:** `loops.list`, `loop.save`, `loop.remove`, `loop.arm`, `loop.pause`, `loop.run` (manual lap/run), `loop.dryrun`, `loop.gate.open`, `loop.gate.sendback`, `loop.runs.get`, `loop.convert` (`{ workUnitId }` → replies `loop.updated` carrying the new Loop; the source unit keeps living — the loop stores `workUnitId` and drives the unit's Todoist tags off run state: armed→`planned`, at-gate→`review`, gate-opened→`completed`). **Events:** `loops.list`, `loop.updated`, `loop.run` (live run/lap updates), `loop.runs`. Existing `loops.snapshot` stays for the Phase 0 panel until Phase 4 removes it. Protocol golden regenerated at each phase that touches the wire.

### 4.4 Web (`anvild/web/src/loops.ts` + `loops-intake.ts`)

- **Loops home** — overlay `"loops"` at `#loops` (registered in `overlays.ts`), sidebar entry added alongside Autopilot (coexist) until Phase 4 flips it. Rows = mini-circuit glyph (runner position, lock, lap badge) + name + trigger→act + status chip, grouped by environment; "drafts at your gate" section lists `proposed`/converted drafts.
- **Loop detail** — full circuit SVG (station highlights + runner + gate lock + scope shield line), hard-stop bars, assumptions card, lap history (lap row → session transcript), gate verbs (`Open the gate` / `Send back a lap` with note), controls (Run now · Pause/Arm · Edit-when-paused · Dry-run · Delete), autonomy ladder (rung select; `ship` disabled until Phase 5).
- **Intake** (Phase 3) — conversation panel driven by a daemon-side intake session (Haiku/Sonnet): check-first question order (check → scope → hard stops → gate), one-tap suggested answers, live circuit building above the chat, **"still ambiguous"** step writing `assumptions`, intent preview, dry-run-first arm. Falls back to the Phase 2 dialog offline.
- The circuit renderer is a pure module (`circuitSvg(loop, run)`) ported from the validated mock.

## 5. Deliverables & phases

Vertical slices; each independently shippable. `☐` not started · `◐` in progress · `☑` done (only via the §8 done-gate).

### Phase 1 — Loops home over existing state (projection-first)
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| `#loops` overlay + sidebar entry + deep link; overlay registration | ☑ | ☑ | ☐ |
| Circuit renderer module (full + mini glyph) ported from mock | ☑ | ☑ | ☐ |
| Projection: schedule/goals/pipelines/proposals/work-unit drafts → circuit rows (extends `buildLoopsSnapshot` with drafts + richer fields) | ☑ | ☑ | ☐ |
| Detail pages for projected loops (goal loop: live laps + condition; proposal: approve/reject verbs; draft: open reader) | ☑ | ☑ | ☐ |
| **Acceptance:** with an armed schedule, one armed `/goal`, and one pending proposal, `#loops` lists 3 circuit rows with correct runner/lock/lap state; tapping the goal row's detail shows the live lap count that increments on an unmet stop; the proposal is approvable from its detail page and leaves the list | ☑ | ☑ | ☐ |

> **Phase 1 evidence** (2026-08-11, branch `loops-circuit`). `bun test` → 908 pass / 1 skip / 0 fail (150 files). `bunx typescript@5.9 --noEmit` (daemon) → exit 0. `bunx typescript@5.9 --noEmit -p web/tsconfig.json` (web) → exit 0. `bun run web/build.ts` → built OK. Protocol golden unchanged (only union members + optional `LoopSummary` fields added — no new `type:` wire literals; `protocol-surface.test` passes). New tests: `test/unit/loops.test.ts` (projection: 3 rows + circuit fields + drafts + ordering), `test/web/circuit.test.ts` (renderer: stations, gate-by-rung, runner, laps, scope, `loopToCircuit` defaults), `test/web/loops.test.ts` (acceptance: 3 rows w/ status chips, gate badge, goal detail live lap count 2→3 on new snapshot, proposal approvable). Fresh-context adversarial review: 1 MAJOR (status-rename left Autopilot panel's proposal/paused rows unstyled + drafts leaked into it) — **resolved** (added `.loop-gated`/`.loop-paused` CSS + filtered `draft` kind from the Autopilot panel; see decision D-005). *Pushed left ☐: committed to the feature branch, not merged to `main`.*

### Phase 2 — Loop entity, engine v1, gate verbs
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Protocol: Loop/LoopRun types, `loop.*` commands/events, `loops` capability; golden regen | ☐ | ☐ | ☐ |
| `LoopStore` (catalog + JSONL runs, quarantine, retention) | ☐ | ☐ | ☐ |
| `contract.ts`: validation/completeness/defaulting (pure) | ☐ | ☐ | ☐ |
| Engine v1: manual trigger; `session-prompt` + `skill-check` bodies; `judge` + `command` checks; hard stops (laps/budget/no-progress); lap history | ☐ | ☐ | ☐ |
| Scope guard: lap-boundary diff vs `scope.allow`; check-input lock → `check-tampering` | ☐ | ☐ | ☐ |
| Gate: `at-gate` state; `Open the gate` (Suggest→report / Draft→branch / PR→PR) + `Send back a lap` (note injected) | ☐ | ☐ | ☐ |
| Web: real loops in home/detail; minimal "New loop" dialog (scaffolding); `loop.convert` on drafts | ☐ | ☐ | ☐ |
| Projection dedupe: `buildLoopsSnapshot` input gains `excludeSessionIds` (sessions owned by any live `LoopRun`) so a real Loop and its session never render as two rows | ☐ | ☐ | ☐ |
| **Acceptance:** create a loop (prompt body, `bun test` command check, PR rung, 5-lap cap) via the dialog; Run now → laps advance with verdicts in the detail page; a lap whose diff exits scope fails `scope-violation`; a lap that edits the check's test file fails `check-tampering`; a passing check parks the run `at-gate`; `Open the gate` opens the PR; `Send back a lap` runs exactly one more lap carrying the note; 6th lap never runs; a run hitting no-progress ends terminal `no-progress` without parking at the gate | ☐ | ☐ | ☐ |

### Phase 3 — Claude-led intake
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Daemon intake session (check→scope→stops→gate question order; suggested answers; repo-aware check proposal) | ☐ | ☐ | ☐ |
| Live circuit build above chat; "still ambiguous" → `assumptions`; intent preview | ☐ | ☐ | ☐ |
| Dry-run first lap (throwaway worktree; report only, no branch/PR/push) via `loop.dryrun` | ☐ | ☐ | ☐ |
| Todoist task → intake path (draft conversion enters the same conversation) | ☐ | ☐ | ☐ |
| **Acceptance:** typing an outcome in the home's prompt box yields a ≤5-question conversation ending in an armed loop whose check, scope, stops, rung, and ≥1 logged assumption match the answers; the first lap is a dry-run leaving no branch/PR; a Todoist draft converts through the same flow | ☐ | ☐ | ☐ |

### Phase 4 — Triggers, migration flip, notifications
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Schedule + event + chained triggers per loop (edge-triggered; event routing via existing intake; chain cycle-check at save) | ☐ | ☐ | ☐ |
| Autopilot nightly re-homed as the **Todoist-intake loop** (act: `autopilot`); schedule card/flags absorbed | ☐ | ☐ | ☐ |
| Card grid retired; sidebar flips to **Loops**; `loops.snapshot` panel removed; `#autopilot` deep-links redirect | ☐ | ☐ | ☐ |
| Notifications: at-gate, failure/auto-stop, success (opt-in), daily digest | ☐ | ☐ | ☐ |
| **Acceptance (headline demo):** a schedule loop fires within its window → runs → check verdicts recorded → parks at gate → push notification received → gate opened from the notification's deep link; the sidebar shows only Loops; the nightly Todoist loop appears as row #1 and produces drafts at the gate | ☐ | ☐ | ☐ |

### Phase 5 — Fleet execution, durability, earned autonomy
| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Hub catalog sync + `loop.run.assign` member execution + re-broadcast | ☐ | ☐ | ☐ |
| Checkpoint/resume: lap + pipeline-phase checkpoints; `--resume` reattach; `interrupted` recovery on restart | ☐ | ☐ | ☐ |
| `metric` + `http` checks; `pipeline` act body | ☐ | ☐ | ☐ |
| Earned autonomy: `cleanGatedLaps` tracking; promotion *suggestion* (never silent); `ship` rung unlocked post-promotion | ☐ | ☐ | ☐ |
| **Acceptance:** a loop on an M1-owned env executes on M1 with live updates on all clients; kill the daemon mid-lap → restart → the run resumes from its last checkpoint (or cleanly marks `interrupted`) with no stuck `running`; after 3 opened gates the loop's detail shows a promotion suggestion and only an explicit tap changes the rung | ☐ | ☐ | ☐ |

## 6. Constraints

- **Security:** Tailscale is the trust boundary — no app-layer auth on `loop.*`; event intake stays behind the existing command surface (no new HTTP endpoints this spec).
- **Compatibility:** protocol changes only via golden regen; older members degrade via the `loops` capability (cid-less unknown-command errors remain benign); autopilot surface untouched until Phase 4's flip; native apps need no changes (WebView shells).
- **Budget:** engine work bills like autopilot (env's account, existing budget guard blocks unattended runs in the warn zone); intake conversations use small models (Haiku/Sonnet).
- **Release train:** every phase merge to `main` ships everywhere (docs/CI-CD.md) — each phase must be releasable alone; Phase 4's flip is the only user-visible breaking change and carries its own release note.
- **Platform:** TS 5.9 (`^5` pin); note the canonical checkout's stray TS 7 breaks local `bun run typecheck` (use the pinned toolchain).

## 7. Edge cases & failure modes

| Scenario | Expected behavior | Covered by |
|---|---|---|
| Daemon restart mid-lap | Run reloads as `interrupted`; schedule/chained loops auto-resume from checkpoint (Phase 5; Phases 2–4: cleanly `interrupted`, next trigger reruns); never a latched `running` (time-bounded like autopilot runs) | `loops-restart` harness |
| Judge/check unreachable or errors | Lap verdict `check-error`; counts toward no-progress; run never blocks forever on a dead judge (20s timeout, mirrors `judgeGoal`); loop is NOT failed on a single check-error | `loop-checks` unit |
| Duplicate/concurrent triggers | Event dedupe via `dedupeKeyFor`; a trigger firing while a run is live for that loop is coalesced (one run per loop at a time), logged | `loop-engine` unit |
| Corrupt `loops.json` / run JSONL | Quarantine + start empty (WorkUnitStore pattern); runs truncated per-line, never wiping the catalog | `loop-store` unit |
| Budget exhausted mid-turn | Enforced at lap boundary (a turn can't be killed cleanly); run ends `over-budget` with the partial lap recorded | `loops-lifecycle` harness |
| DST/clock change on schedule | Inherits `scheduledFireDue` edge-trigger semantics (window-based, no catch-up, no double-fire) | existing `autopilot-schedule` tests + loop variant |
| Gate opened twice / stale gate (run superseded) | Gate verbs are idempotent per run id; a verb on a non-`at-gate` run returns BadCommand | `loop-engine` unit |
| Member offline for an assigned run | Hub marks the run `interrupted` after the 60s assign-ack timeout; visible in detail; next trigger retries | `loops-fleet` harness |
| Edit while armed | Rejected (pause-to-edit); `configRevision` bumps on save; an in-flight run keeps its pinned revision | `loop-contract` unit |
| **Gamed spec** — how could an agent satisfy the letter and miss the intent? | (a) editing check inputs → `check-tampering` lap fail; (b) trivial no-op laps to reach the gate → checks must pass, and `suggest`-rung reports carry the diff for human eyes; (c) satisfying `any`-mode via the weakest check → intake defaults to `all` and warns on `any`; (d) the intake itself under-specifying → "still ambiguous" step + logged assumptions | `loop-scope-guard` unit + intake harness |

## 8. Evaluation & verification

- **Technical (unit):** `contract.ts` (validation/defaults/completeness), circuit projection, lap/hard-stop accounting, scope-glob matcher + check-input lock, chain cycle-check, store quarantine/retention, gate idempotency. Pure modules, no SDK (the `autostart-gate.ts` extraction pattern).
- **Functional (deterministic harness, `test/integration/loops-*.test.ts`):** the engine takes injected deps (like `AutopilotDeps`), so the harness passes `now()` (fake clock), a fake `runLap` agent fn (scripted diffs + outputs — no worktree, no subprocess), a scripted judge, and a real `LoopStore` over a temp dir; the SDK is stubbed via the `mock.module("@anthropic-ai/claude-agent-sdk", …)` pattern from `goal-flow.test.ts`. Scenarios drive whole lifecycles per phase: trigger fires → laps advance → verdicts → gate → open/send-back → terminal states; guardrail trips (`over-budget`, `no-progress`, `scope-violation`, `check-tampering`); restart/resume; the Phase 4 headline demo end-to-end. No real model spend; CI-reproducible.
- **Manual/visual pass (UI phases):** scripted `/verify` checklist per phase (circuit rendering, intake conversation feel, notification deep links) — logged in the evidence block, not a merge gate.
- **Done-gate (per phase):** run and paste evidence — `bun test` (0 fail) · `bunx typescript@5.9 --noEmit` (daemon + web, exit 0) · `bun run web/build.ts` · this phase's `loops-*` scenario (0 fail) — then a **fresh-context adversarial reviewer** checks the phase against its acceptance row and may veto. Evidence block appended under the phase table; only then flip cells to `☑`.
- **Definition of done (global):** all acceptance rows `☑` with evidence; headline demo passes in harness **and** once against a real environment; both mandatory guardrail classes (budget + no-progress) proven by tests on every armed path; protocol golden regenerated each wire change; the migration flip ships with a release note; no reachable stuck-`running` state.

## 9. Spec-critique gate (before any build)

- **Round 1 (2026-08-11, author self-critique — advisory only, does not satisfy the gate):** six findings resolved during drafting: `loop.convert` unit-lifecycle mapping; send-back laps count toward `maxLaps` (refused at the ceiling); intake capped at 12 turns on small models; projected-vs-real loop double-vision; no-progress made mechanically testable; Phase 4 flip rollback = revert via the release train.
- **Round 2 (2026-08-11, fresh-context adversarial review): VETO** — 12 findings, all resolved in this revision:
  1. *(MAJOR)* `tokenBudget` optional contradicted the mandatory-budget guarantee → now **required** with contract.ts defaults (300k/500k) — §4.1.
  2. *(BLOCKER)* no-progress gate-vs-terminal ambiguity → **terminal `no-progress`, never gatable** — §4.2 + Phase 2 acceptance row.
  3. *(BLOCKER)* check-input lock inference undefined → **explicit `locks?: string[]` per check**, auto-suggested at intake, no hidden engine inference — §4.1.
  4. *(BLOCKER)* user-created `act: autopilot` semantics undefined → **reserved for the daemon-managed Todoist-intake singleton**; contract rejects it elsewhere — §4.1.
  5. *(MAJOR)* Phases 1–3 dual review surfaces read as contradicting retire-the-cards → made explicit as the deliberate "coexist" step — §3.
  6. *(MINOR)* member-assign timeout unspecified → **60s ack timeout** — §4.2/§7.
  7. *(MINOR)* checkpoint timing vague → **lap boundary, after verdict** — §4.2.
  8. *(MAJOR)* Phase 0 framing overstated (implied entity types exist) → reframed as projection + plumbing only; Phase 2 builds the entity from scratch — §2.
  9. *(MINOR)* web file list lacked per-file changes → itemized (OverlayName, router cases, fleet caches, sidebar entry) — §3.
  10. *(MINOR)* harness determinism unproven → injected-deps harness sketch added (fake clock/agent/judge, temp-dir store, SDK mock.module) — §8.
  11. *(BLOCKER)* `loop.convert` wire contract missing → defined (`{workUnitId}` → `loop.updated`; unit tag mapping) — §4.3.
  12. *(MINOR)* projection dedupe unowned → Phase 2 task: `buildLoopsSnapshot` gains `excludeSessionIds` — §5.
- **Round 3 (2026-08-11, fresh-context confirmation): CONFIRMED-PASS** — all seven blocking/major findings verified closed against the spec text (each with the resolving line quoted); no new blockers introduced by the fixes.
- **Verdict: gate satisfied — Status: Spec-critiqued.** Owner approval flips it to Approved; Phase 1 may then begin.

## 10. Open decisions

- **"Laps" naming** — default assumed ("laps") unless you object; string-table swap at any time.
- **Promotion threshold** — default 3 clean gated laps before Claude *suggests* moving the gate right.
- **Intake model** — default Sonnet for the conversation, Haiku for per-answer circuit updates.
- **`#autopilot` deep-link afterlife (Phase 4)** — default: permanent redirect to `#loops` with the drafts section focused.
- **Run retention** — default 200 runs/loop, truncation logged.
