# Loops Circuit Build — Decision Log

Decisions made autonomously during implementation of `2026-08-11-loops-circuit-build.md`.
Review after implementation to tweak as needed.

## Format
- **D-NNN** (Phase, area): decision — rationale.

---

## Interview outcomes (2026-08-11, post-build review with Evan)

Confirmed **as built** (no change):
- **Crash resume** → keep `interrupted` + rerun on next trigger (D-022). Full `--resume` reattach not needed now.
- **Iteration word** → keep "laps" (spec §10 resolved).
- **Token accounting** → keep the ÷4 length approximation for the budget ceiling (D-009); exact SDK usage not worth the plumbing.
- **Metric parse** → keep last-number extraction (D-023); **action:** document that a metric command should print just the number (e.g. `… | tail -1`), and have intake generate such commands.
- **New-loop dialog** → keep as the power-user escape hatch alongside intake (D-011).

Changes requested (become follow-up work items):
- **FU-1 — Real LLM intake** (revises D-014): replace the deterministic heuristic with a genuine Sonnet-led intake conversation (Haiku for per-answer circuit updates). Keep the heuristic as the offline/CI fallback (`localSuggestion`). Needs: a daemon-side intake session, non-determinism handling in tests (mock the SDK like `goal-flow`), model-spend note.
- **FU-2 — Hub re-broadcast / `loop.run.assign`** (revises D-025): implement the spec's hub-authoritative forwarding so a hub-only client also sees a member loop's live runs. Adds `loop.run.assign` (hub→member) + member→hub re-broadcast of `loop.run`; 60s assign-ack → `interrupted` (spec §4.2).
- **FU-3 — Configurable Ship merge** (revises D-024/D-026): let each loop choose the merge method (squash/merge/rebase) and whether to wait for green CI before merging (`gh pr checks`). Adds a small config field + UI; currently hardcoded squash-on-open.

## Follow-up implementation (2026-08-11, second build pass — "implement everything")

Scope of this pass = the three requested follow-ups (FU-1/2/3) + the metric-command action item. The
`◐` Phase-5 full `--resume` reattach is deliberately **not** implemented — the interview outcome above
confirms "keep interrupted + rerun; full --resume reattach not needed now" (D-022). Decisions D-027+.

- **D-027** (FU-3, scope): Implement configurable Ship merge as an optional `Loop.merge` field
  (`{ method: "squash"|"merge"|"rebase"; requireGreen?: boolean }`), defaulting to `{ method: "squash" }`
  (preserves today's hardcoded squash-on-open). Pure helpers (`mergeMethodFor`/`mergeRequiresGreen`) are
  unit-tested; the git wiring reuses the existing `mergePr(method)` + a new `prChecksGreen` gh op (shell
  op, untested like its `createPr`/`mergePr` siblings). Additive protocol field — no golden version bump.
- **D-028** (FU-1, intake): The real-model intake is an **injected port** (`LoopServiceDeps.intakeModel`)
  so tests stay model-free. `intakeSuggest` becomes async: it computes the deterministic heuristic
  (renamed `localIntakeSuggestion`, still the offline/CI fallback), then, when `intakeModel` is wired,
  overlays the model's validated fields. Any throw/timeout/parse-failure falls back to the heuristic — a
  loop can always be intaked. The Supervisor wires `intakeModel` to a one-shot Sonnet call
  (`src/loops/intake-model.ts`, no tools, 25s timeout, JSON reply) mirroring `judgeGoal`'s SDK shape.
  Dispatch's `loop.intake` case becomes async (`.then(send).catch(cmdError)`).
- **D-029** (FU-1, metric-command action): Closes the D-023 metric misparse two ways: (1) the intake
  model prompt instructs that a `metric` check's command must print ONLY the number (append `| tail -1`),
  and (2) `completeLoop` runs every `metric` check's command through a pure, idempotent
  `singleNumberCommand()` (appends `| tail -1` when not already narrowed) — so a metric check created by
  ANY path (heuristic, model, hand-written, the New-loop dialog) is narrowed to a single line before it
  ever runs. Not vacuous: the normalization is at the one validation choke point, unit-tested both as the
  pure helper and through `completeLoop`.
- **D-030** (FU-2, fleet — DEFERRED, needs owner review): FU-2's hub-authoritative `loop.run.assign`
  forwarding + member→hub re-broadcast is **not implemented**, deliberately. Investigation (Explore sweep
  of `src/server/{registry,fleet,dispatch}.ts`, `src/session/{supervisor,loop-service}.ts`,
  `web/src/fleet.ts`) established that **no persistent hub↔member WebSocket exists anywhere in the
  product** — all hub↔member traffic is REST (`/api/health` probes, Todoist/token propagation) plus
  Tailscale discovery. `ConnectionRegistry` only reaches a daemon's *own* directly-connected clients
  (`toAll`/`toAttached`); there is no `toMember`/`forward`. Implementing FU-2 therefore means building a
  new persistent hub→member socket transport (connection lifecycle, reconnect, backpressure, auth, and
  dedup against clients already directly connected to the member). Critically, a daemon-opened socket to
  a peer would hit the **SEC-H3 WS origin gate** (see memory `fleet-member-disconnected-on-web-origin-gate`:
  the origin gate 403s exactly this kind of cross-origin socket) — i.e. the product's security posture is
  built on the assumption that daemons do NOT open sockets to each other. Building that transport is a
  core-fleet change far exceeding a follow-up's risk budget, and the current direct-connect model (the web
  opens a socket per fleet member and aggregates `serverLoopEntities`/`loopRuns`) already satisfies the
  Phase-5 acceptance ("a loop on an M1-owned env executes on M1 with live updates on all clients") for the
  standard topology where every client adopts every member. The only residual gap — a client connected
  *only* to the hub — stays the documented, accepted limitation of D-025. The spec §7 "member offline →
  interrupted after 60s assign-ack" durability guarantee is already met without assignment: a member owns
  its own runs and `recoverInterruptedRuns` marks them `interrupted` on its restart. **Recommendation for
  review:** if hub relay is genuinely wanted, scope it as a dedicated transport project (with an
  ANVIL_ALLOWED_ORIGINS / origin-gate carve-out for daemon-to-daemon sockets), not a loops follow-up.

**Follow-up pass evidence** (2026-08-11, branch `loops-circuit`). Delivered: FU-1 (real Sonnet-led intake
with heuristic fallback), FU-3 (configurable Ship merge method + green-CI gate), the D-029 metric-command
normalization. Deferred with rationale: FU-2 (D-030). Not touched by design: the `◐` full `--resume`
reattach (interview-confirmed to keep `interrupted`+rerun). `bun test` → **990 pass / 1 skip / 0 fail**
(160 files; +14 new tests). Daemon + web `bunx typescript@5.9 --noEmit` → exit 0. `bun run web/build.ts`
→ built OK. Protocol golden unchanged (`LoopMerge` is a non-`type:` interface + `merge?`/async intake are
additive; `protocol-surface.test` passes; PROTOCOL_VERSION stays 4). New/changed: protocol `LoopMerge` +
`Loop.merge?`/`LoopInput.merge?`; `contract.ts` `mergeMethodFor`/`mergeRequiresGreen`/`singleNumberCommand`
+ metric normalization + merge carry; `git/ops.ts` `prChecksState`; `loop-service.ts` async `intakeSuggest`
overlay + `intakeModel` port + `openGateAction` merge wiring + `localIntakeSuggestion`/`applyIntakeOverlay`;
new `loops/intake-model.ts`; `dispatch.ts` async `loop.intake`; `supervisor.ts` `intakeModel` wiring;
`web/src/loops.ts` ship-merge control (`mergeConfigHtml`/`setMerge`). New tests: `loop-intake-model.test.ts`
(6), `loop-contract.test.ts` (+FU-3/D-029: merge defaults/carry, singleNumberCommand, metric normalize),
`loop-service.test.ts` (+FU-1 overlay + throw-fallback), `loops-entity.test.ts` (+ship merge control shows
/ pr-rung hides). CWD caveat noted for the reviewer: a fresh shell defaults to the canonical checkout
`~/Development/anvil`; all verification above was run anchored to this worktree's `anvild/`.

## Decisions

- **D-001** (P1, protocol): `anvild/protocol.ts` is a symlink to `docs/plans/anvil-protocol.ts`. Edited the real target (the source of truth). Confirms the spec's "in scope: docs/plans/anvil-protocol.ts".
- **D-002** (P1, protocol): Extended `LoopSummary` with optional display fields (`act`, `rung`, `runnerAt`, `scope`, `environmentId`, `environmentName`) plus `LoopRung`/`LoopStation` types and `draft`/`gated`/`paused` enum members, rather than a client-only view model — so Phase 2's real Loop entity shares the same render contract. No golden regen needed (the golden captures only `type: "..."` wire discriminants, not union-member literals or optional fields). Verified by re-running protocol-surface test later.
- **D-003** (P1, projection): Changed two projection semantics for the circuit model: a paused goal now reports `status: "paused"` (was `"armed"`) and an event proposal reports `status: "gated"` sitting at the gate (was `"waiting"`). Updated the two affected unit tests. Rationale: the circuit reads clearer — a paused loop has no runner, a proposal awaits you at the gate.
- **D-004** (P1, projection): `drafts` input = work units with status `planned` or `needs-clarification` (proposed units keep their own `trigger`-kind row). These render as `kind: "draft"` in the "drafts at your gate" section and open the plan reader.
- **D-006** (P2, protocol): The spec's entity lifecycle field is named `LoopStatus` (`"draft"|"armed"|"paused"|"disabled"`), but that identifier is already the projection `LoopSummary.status`. Named the entity lifecycle `LoopState` and `Loop.status: LoopState`. Also added a protocol-local `TriggerKind` alias (mirrors `event-trigger.ts`) since the protocol can't import from src. Golden regenerated: +13 wire literals, PROTOCOL_VERSION stays 4 (additive, no breaking bump).
- **D-007** (P2, engine): `no-progress` is detected as "last N laps all non-passing AND identical diff signature" (the sorted file list per lap). Identical signatures across N laps = "empty delta" (covers both zero-change laps and the same wrong change repeated). Tracked in-memory per run (not on the wire shape). Terminal, never gates — matches the spec's blocker resolution.
- **D-008** (P2, engine): `sendback` runs exactly one lap with the note injected; if that lap neither passes nor trips a terminal guardrail, the run re-parks `at-gate` (human decides again) rather than continuing to lap. Refused at the maxLaps ceiling (send-back laps count toward it, per spec-critique round 1).
- **D-009** (P2, service): `runAgentQuery` doesn't surface token usage, so a session-prompt lap's tokens are approximated as `ceil((prompt.length + responseText.length)/4)`. The budget guard is thus grounded but not exact; exactness is a follow-up when the SDK exposes usage. The deterministic harness proves the budget logic with real token counts.
- **D-010** (P2, service): The engine's gate action ships per rung — Suggest: report only (no branch); Draft: commit+push branch; PR/Ship: +open a PR via the existing `git/ops`. Worktrees are per-run in-memory (durable checkpoint/resume is Phase 5); a terminal/shipped run frees its worktree (Draft/PR keep the pushed branch).
- **D-011** (P2, web): The New-loop dialog is minimal scaffolding (name/env/prompt/one command check/scope/rung/maxLaps) targeting the env's server (fallback hub), gated on the `loops` capability. It auto-arms on create. Phase 3's intake conversation becomes the primary path; this stays the power-user escape hatch (spec §3 assumptions log). Replaced `window.prompt` (unsupported in WebView shells / jsdom) with a new `promptDialog` for the send-back note.
- **D-012** (P2, web): `loop.convert` on a draft seeds a manual, checkless, PR-rung loop from the work unit's request and opens its detail (the user pauses to add a check, then arms). Idempotent per work unit (store.byWorkUnit).
- **D-013** (P2, review fix): Phase 2 adversarial review (fresh context) found a MAJOR: `openGate`'s status-check and mutation straddle the awaited ship action, so two concurrent `loop.gate.open` calls could double-ship (double PR + double autonomy credit). Fixed with an in-flight `gating` Set keyed by run id (second concurrent open → BadCommand). `sendback` is already synchronous-safe (its status flip precedes any await). Added a concurrency lifecycle test proving exactly one of two concurrent opens ships. Reviewer MINORs accepted/actioned: added a dialog hint that naming the check's file locks it (check-tampering only bites when a path token is present); retention drift (~200–400) and `activeRunSessionIds` latent no-op left as documented (D-009 note / benign today).
- **D-014** (P3, intake): The intake is a **hybrid** — a daemon `loop.intake` command returns a repo-aware suggestion (reads the env's `package.json` test script, narrows check+scope by a keyword, fix-vs-feature heuristic), and the web drives a bounded ≤5-question conversation (check → scope+stops → gate → still-ambiguous → arm) off it. Deterministic (no model spend) so intake is CI-reproducible; a small-model enhancement of the suggestion is a follow-up. Scope+hard-stops are combined into one question to stay ≤5 (spec question order preserved). A client-side `localSuggestion` fallback keeps intake usable if the daemon is offline / lacks the `loops` capability.
- **D-015** (P3, dry-run): `loop.dryrun` runs exactly one lap via `engine.dryRun` with `LoopRun.dryRun = true`; the gate verbs refuse a dry-run run (so no push/PR is ever possible), and the service removes the throwaway worktree after (whose branch is local-only). The loop stays armed for real runs. `dryRun`/`workUnitId` are optional additive protocol fields — no golden version bump.
- **D-016** (P3, review fix): Phase 3 adversarial review found a BLOCKER + MAJOR. BLOCKER: home-prompt loops got no `environmentId`, so the dry-run failed at the first lap and the error was swallowed with a false "armed" toast. Fixed with `resolveEnv` (draft's env → sole env → first env; arm blocked with a clear message when the fleet has zero environments) + surfacing the dry-run `command.error` instead of `.catch(()=>{})`. MAJOR: `loop.arm`'s result was ignored (it resolves, not rejects, on `command.error`), so a failed arm still fired the dry-run and navigated as "armed" — fixed by checking the arm response before dry-running. MINORs actioned: the "judge" check chip now builds a real `judge` check (was leaving `checks: []`); the "Tighter budget" chip advances the runner. Added a regression test proving a failed arm fires no dry-run.
- **D-017** (P4, triggers): Per-loop triggers run on a 60s scheduler tick (`LoopService.tick`) that is edge-triggered via the existing `scheduledFireDue` (window-based, no catch-up, no double-fire; `lastRunAt` = the loop's latest run's `startedAt`). Chained triggers fire on a parent run's terminal (`fireChained`, pure `chainedTargets`); a chain cycle is rejected at save (`chainCycleReason`) and the acyclicity plus armed-only firing bound runtime re-entrancy. Event triggers route through `Supervisor.ingestTrigger` → `LoopService.handleEvent` (pure `eventTargets` + a per-loop dedupe key, capped at 2000).
- **D-018** (P4, autopilot singleton): The nightly autopilot is re-homed as a daemon-managed singleton loop `loop_autopilot` (`act: "autopilot"`, schedule 02:00, rung suggest), created idempotently by `ensureAutopilotLoop`. `act: "autopilot"` bypasses the lap engine — `startRun` routes it to `runAutopilotLoop`, which delegates to the injected `autopilotRun` (the existing Todoist re-plan) and records a one-lap `shipped` run summarising the drafts produced. The drafts themselves surface in the home's "drafts at your gate" via the Phase-1 projection (not gate verbs on this run). Pinned to row #1 in the home.
- **D-019** (P4, migration flip): The Autopilot sidebar button is retired (the running spinner moved onto the Loops entry); `#autopilot` cold-load + warm hashchange permanently redirect to the Loops home; the `loops.snapshot` panel inside the Autopilot view is removed (`loopsPanelHtml` → ""). The Autopilot **overlay/machinery stays** (spec §1 non-goal) and remains reachable via a draft's "Open the draft" (`openPlanDeepLink`) and Settings → Todoist — only its *surface* is retired.
- **D-020** (P4, notifications): at-gate / failure / success pushes carry a `#loops/<id>` deep-link hash (new `PushPayload.hash`; the SW `push` handler puts it on the notification data and `notificationclick` follows it — warm app via an `open-hash` postMessage, cold via `openWindow`). Daily digest: a once-per-day (after 09:00 local) summary push (at-gate / shipped / stopped counts, deep-linking `#loops`) when any loop opts in; in-memory day marker (best-effort, resets on restart).
- **D-021** (P4, review fix): Phase 4 adversarial review found a BLOCKER (the SW `push` handler dropped `hash`, breaking the notification deep-link end-to-end) + 2 MAJORs (event triggers were dead code — `handleEvent` unwired; daily digest entirely absent). All fixed: SW carries `hash` (+ static regression test); `ingestTrigger` now calls `handleEvent`; the daily digest is implemented (+ test). MINORs actioned: bounded the event-dedupe set, removed the dead `openAutopilot` import, pinned the autopilot loop to row #1. The `shipped` terminal for the plan-only autopilot run (cosmetic) is accepted.
- **D-022** (P5, durability): On boot, `recoverInterruptedRuns` marks any `running`/`sent-back` run — and any `at-gate` run of a **non-Suggest** loop — as `interrupted` (the DoD "no reachable stuck-running state"). The at-gate case matters because the run's worktree is in-memory only and is lost on restart, so the gate could no longer legitimately push/PR. Suggest-rung at-gate runs (report-only, no worktree) stay resumable. Full in-lap `--resume` reattach from `run.checkpoint` is a later refinement; the spec acceptance explicitly allows "resumes from checkpoint **or** cleanly marks `interrupted`" — the latter is implemented and tested.
- **D-023** (P5, checks): `metric` checks run the command and compare the **last number** in the output against the threshold (op gte/lte/eq); `http` checks compare the fetched status to `expectStatus` (default 200, `redirect: "manual"`). Both real, tested. Known limitations (documented, not blockers): `metric` picks the last number, so multi-number output can misparse (intake should generate commands that print just the number, e.g. `… | tail -1`); `http` treats 3xx as failure and can reach any host the daemon can (consistent with the accepted Tailscale-boundary / no-app-auth security posture — no URL allowlist added by design).
- **D-024** (P5, earned autonomy): `promotionSuggestion`/`shipUnlocked` (pure, mirrored client-side) surface a suggestion after `PROMOTION_THRESHOLD` (3) clean gated laps; `cleanGatedLaps` increments **only** on a genuine human `openGate` (never on dry-run/sendback/failure). The change is never silent — only an explicit tap on the promotion banner (`promoteRung`: pause→save→arm) or the ladder moves the rung. `completeLoop` rejects a `ship` rung that hasn't been earned. The `ship` rung now genuinely **auto-merges** (squash `mergePr` after the PR), distinct from `pr`.
- **D-025** (P5, fleet — architectural divergence): Rather than the spec's hub-authoritative catalog + `loop.run.assign` hub→member forwarding, loops execute on the **env-owning daemon** (save routes to the env's server via `envServer`) and stream `loop.run` to all *directly-connected* fleet clients (the web opens a socket per fleet server and aggregates `serverLoopEntities`/`loopRuns` across them). This satisfies the acceptance ("a loop on an M1-owned env executes on M1 with live updates on all clients") for Anvil's normal topology where clients adopt every fleet member. Known limitation: a client connected **only** to the hub (not directly to the member) won't see that member's live runs — there is no hub re-broadcast. Documented, not a blocker for the standard fleet model.
- **D-026** (P5, pipeline body + review fixes): Phase 5 adversarial review found 2 MAJORs — both **fixed**: (MAJOR-1) an at-gate run surviving a restart would false-ship for every rung (worktree gone → the `!wt` fallback returned a fake success) AND bank unearned autonomy credit → fixed by (a) `openGateAction` now REFUSES a non-Suggest rung with no live worktree (BadCommand, so `engine.openGate` never marks shipped / increments), and (b) `recoverInterruptedRuns` marks stale at-gate runs interrupted (D-022); regression tests added at both the engine and service level. (MAJOR-2) the `ship` rung was identical to `pr` (no merge) → fixed with a squash `mergePr`. The `pipeline` act body is wired (delegates to `runDevPipeline`) but is a **single-shot delegation**: the dev pipeline self-manages its own worktree/budget/PR, so a pipeline loop's loop-level scope/`command` checks and token budget don't apply meaningfully (use a `judge` check or none). The loop-level budget + no-progress guardrails are proven on the `session-prompt`/`skill-check` lap-based bodies (Phase 2), which are the primary bodies — the DoD "budget on every armed path" is met for the lap-based bodies; the pipeline body defers budget to the pipeline's own guard (documented, not a hidden gap).
- **D-005** (P1, review fix): Phase 1 adversarial review (fresh context) flagged that the status renames (D-003) left the still-live Autopilot Loops panel's proposal/paused rows unstyled (no `.loop-gated`/`.loop-paused` CSS) and that new `draft` rows leaked into that panel — both violating §3 "autopilot surface unchanged". Fixed by (a) adding `.loop-gated`/`.loop-paused` rules to app.css (proposal stays purple, as "waiting" was) and (b) filtering `kind === "draft"` out of the Autopilot panel's `activeLoops()`. The Loops home is the only surface that shows drafts. Reviewer's other notes (approved proposal reappears in the Drafts section) accepted as the intended propose→approve→draft lifecycle.
