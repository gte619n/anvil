# Incremental Conversation & Flaky-Connection Resilience

**Status:** **Implemented** (protocol v4 shipped 2026-08). Resume watermarks, per-session epoch/lastSeq,
delta-vs-snapshot resume, durable IndexedDB transcript cache, and resilience telemetry all landed; see
`resume-wire.test.ts`, `resume-watermark.test.ts`, `telemetry.test.ts`, `test/web/resume.test.ts`. The
improvement-program v2 (2026-08-01) fixed a replay-seq drop (BE2-8) and added an EventLog tail cache
(BE2-6). Original phased spec preserved below.
**Branch:** `incremental-offline` (based on `origin/main`)
**Author:** PM + senior dev (interview-driven spec)
**Created:** 2026-08-01
**Protocol impact:** `PROTOCOL_VERSION` bump `3 → 4` (coordinated fleet upgrade — no capability negotiation)

---

## 1. Problem statement

Anvil delivers "middling" performance on unstable connections. All four failure modes were
confirmed as painful:

1. **Stuck / stale UI** — spinners that never resolve, connection dot frozen, `Syncing…` banner
   that hangs, status stuck on `thinking`.
2. **Slow reloads / session switches** — reopening the app or switching sessions re-pulls the whole
   conversation even when nothing changed.
3. **Missing / dropped messages** — uncertainty that the transcript is complete after a reconnect.
4. **Sends fail / hang** — composing while degraded hangs, silently fails, or risks double-send.

The user's hypothesis — *move toward incremental conversation so cached content stays available and
we only pull new events from the server* — is directionally correct. Crucially, **the incremental
scaffolding already exists but is under-used** (see §3). This program finishes and hardens it.

---

## 2. Goals & non-goals

### Goals
- Cached content for the **last-viewed conversation** stays available and interactive when the link
  is flaky or dead.
- On reconnect / cold open, pull **only new events** (`seq > lastSeq`) instead of full snapshots
  whenever the cache is provably current.
- **Exactly-once** delivery of offline-composed sends (no loss, no duplicate).
- The UI never lies indefinitely: any optimistic/stale state is **guaranteed** to be re-asserted by
  resume.
- Measurable, self-verifiable stability improvement.

### Non-goals (explicitly out of scope)
- **Full offline mirror** of every session. Scope is **last-viewed only** — one durable cached
  transcript, delta-refreshed. No IndexedDB library of all transcripts.
- **Server-side log compaction** and **`since()` re-indexing** — deferred. The only server change is
  a cheap watermark/verify capability (§4, §6 Phase 2).
- Reviving dormant iOS/App-Store distribution — iOS is validation-only.

---

## 3. Current architecture (as-built, verified)

### Client (`anvild/web/`)
- **Connectivity:** `AnvilSocket` (`web/src/ws.ts`) — exponential backoff `500ms → 15s`
  (`ws.ts:52,79`), reset on open (`ws.ts:57`); reconnect triggers on `online` + `visibilitychange`
  (`ws.ts:28-32`); heartbeat ping every 15s with 10s pong grace + half-open force-reconnect
  (`ws.ts:19-20,108-131`). This layer is already solid.
- **Outbox:** `OutboxQueue` (`web/src/outbox.ts`) persists queued commands to `localStorage`
  (`anvil.outbox`); `flushOutbox()` (`web/src/main.ts:619-667`) routes per-server, sends with a 20s
  timeout per command, reconciles `tempId → realId` for offline `session.create`, and re-pulls a
  full snapshot after flush to clear optimistic bubbles (`main.ts:657-666`).
- **Incremental resume (present but under-used):** per-session monotonic `seq` persisted at
  `anvil.seq.<id>` (`main.ts:489-491`); `session.attach` sends `lastSeq` so the server replays only
  newer events — **but only when `snapshotLoaded` (an in-memory Set) already has the session**
  (`main.ts:833-836`). On every cold page load `snapshotLoaded` is empty → the client requests a
  **full snapshot** despite holding a valid persisted `seq`. **This is the single biggest lever.**
- **Content cache:** rendered conversation HTML cached at `anvil.convo.<id>` in `localStorage` with a
  **1.5MB cap** (`main.ts:494-523`); large transcripts silently drop the cache → full snapshot on
  next load. Session/environment lists cached at `anvil.sessions` / `anvil.environments`
  (`main.ts:374-395`).
- **UI:** connection dot (`index.html:44`), offline banner with queued count + retry
  (`index.html:62`, `main.ts:700-710`).

### Server (`anvild/src/`)
- **Seq minting:** the *only* place `seq` is assigned is `Session.emit()`
  (`session/session.ts:94`, `nextSeq = lastSeq + 1` at `:72`), guaranteeing per-session monotonicity.
- **Durable log:** append-only `events.ndjson` per session (`eventlog/log.ts`). `since(lastSeq)`
  filters `seq > lastSeq` (`log.ts:63-68`); `snapshot()` folds the log into compacted
  `ConversationEvent[]` (`log.ts:71-97`). **`readAll()` re-parses the entire file every attach**
  (`log.ts:49-61`) — O(history) per attach, never compacted. Transient events
  (`assistant.delta`, `terminal.*`, `fs.changed`) are **not persisted** (`log.ts:17-22`).
- **Resume:** `supervisor.resume(id, lastSeq)` returns `since()` events or a `snapshot()`, then
  **always appends a live `status` event and re-surfaces unanswered permission/question prompts**
  (`session/supervisor.ts:2062-2081`). This is why "keep optimistic status" is safe — resume
  re-asserts truth on every attach.
- **Dispatch:** `session.attach` adds the conn to `attached`, acks, and streams resume events
  (`server/dispatch.ts:64-76`). Commands carry a `cid`; `ack`/`command.error` echo it
  (`dispatch.ts:21-25`).
- **Broadcast:** `registry.toAll()` (global) vs `registry.toAttached(sessionId)` (session-scoped)
  (`server/registry.ts:23-35`).
- **Initial payload on WS open** (`server/http.ts:374-398`): `server.hello`, `session.list`, team,
  budget, environments, prompts, model labels, accounts, todoist, lapo, autopilot — but **no
  conversation history**. History is fetched lazily via `session.attach`.
- **Persistence:** `sessions.json` stores each session's `lastSeq` (`session/store.ts`).

### Key takeaways that shape the design
- Incremental delta-resume is real; it just isn't wired across reloads. **Trusting a persisted
  `lastSeq` is safe today** because logs are never pruned — but there is no epoch/identity guard, so
  a reset/recreated session id would silently mis-resume. Phase 2 adds that guard.
- Because `resume()` always ends with a live `status`, "keep optimistic" UI is correct **iff** a
  resume reliably runs. Making resume reliable is therefore a hard requirement.

---

## 4. Design decisions (interview-locked)

| # | Decision | Choice | Rationale / consequence |
|---|----------|--------|-------------------------|
| D1 | Offline scope | **Last-viewed only** | One durable cached transcript, delta-refreshed. No full-library IndexedDB. |
| D2 | Platforms | **Web + Android + desktop + iOS** | Web bundle is primary; Android inherits via bundled APK (must reship APK to ship — see memory). All four verified. |
| D3 | Cache-trust posture | **Verify before paint**, realized as **skeleton-first** | On cold open paint a non-content skeleton, verify watermark, then fill from cache + apply deltas. Never shows a stale content frame; still shows immediate structure. |
| D4 | Verify budget | **Skeleton while verifying** (no blocking spinner) | Skeleton is the fallback for a slow/dead verify; content fills when the watermark lands. |
| D5 | Send semantics | **Optimistic + at-least-once** | Instant `pending` bubble, queued in outbox, sent on reconnect with a `cid` the **server dedupes** (idempotent). Never lose, never double-apply. |
| D6 | Stale live-status | **Keep optimistic** | Keep showing `thinking`/spinner on drop; rely on resume re-asserting truth. **Hard requirement:** resume must always run and re-assert `status` (already true at `supervisor.ts:2078`). |
| D7 | Server scope | **Cheap-verify endpoint only** | Add a lightweight per-session watermark `{epoch, lastSeq}`. No compaction, no `since()` reindex this program. |
| D8 | Client persistence | **HTML blob in IndexedDB, larger cap** | Move the rendered-HTML cache off `localStorage` into IndexedDB and raise/remove the 1.5MB cliff. Deltas are rendered and **appended** onto the cached HTML base. (Not a raw-event store — chosen for less code; incremental behavior comes from network-layer delta-resume + append.) |
| D9 | Compatibility | **Protocol bump `3→4`, coordinated fleet upgrade** | No capability gate. A straggler node is expected to be upgraded. |
| D10 | Kill-switch | **None — ship direct** | Trust the tiered gates. A regression requires rebuild/redeploy to undo (accepted). |
| D11 | Telemetry | **Rich, daemon-synced** | Persist + sync metrics via the daemon (mirror the prompt-library hub-synced pattern). Powers acceptance assertions (e.g. "delta not snapshot") and regression detection. |
| D12 | Sign-off | **Agent auto for all phases** | The agent self-marks a phase done once its automated + telemetry assertions pass and it has run the scripted runbook; it must paste evidence. No human gate — so verification rigor is non-negotiable. |

### The "epoch" (D7, D3)
An **epoch** is a per-session identity token that changes whenever the durable log's `seq` lineage
resets (session recreated, log truncated/rebuilt). The client stores `{epoch, lastSeq}` alongside its
cache. On verify: if `server.epoch === client.epoch` **and** `server.lastSeq >= client.lastSeq`, the
cache is current → attach with `lastSeq` (delta only). Otherwise the cache is invalid → full snapshot.
This is the safety guard that makes "trust persisted seq" correct even if the log is ever reset.

---

## 5. Target architecture (what changes)

1. **Cross-reload delta resume.** Seed `snapshotLoaded`-equivalent trust from the *persisted* verify
   result, not an in-memory Set. Cold open → verify `{epoch,lastSeq}` → attach with `lastSeq` when
   valid. (`main.ts:833-836`, new verify handshake.)
2. **Skeleton-first render.** Replace "paint cached HTML immediately" with "paint skeleton → verify →
   fill (cache + deltas) / snapshot". (`main.ts:494-540`.)
3. **IndexedDB HTML store.** New durable store module for the active-session HTML blob + `{epoch,
   lastSeq}`; raise/remove the 1.5MB cap. Delta events render-and-append onto the base. (Replaces
   `anvil.convo.<id>` localStorage path.)
4. **Server verify capability.** New protocol message/endpoint returning per-session
   `{sessionId, epoch, lastSeq}` cheaply (from `sessions.json` / in-memory, not `readAll()`). Epoch
   minted and persisted per session. (`server/http.ts`, `session/store.ts`, `protocol.ts`.)
5. **Idempotent sends.** Server records applied `cid`s per session (bounded dedupe window) so a
   retried offline send is acked without re-applying. Client stops the post-flush *full* snapshot
   re-pull in favor of a delta reconcile. (`server/dispatch.ts`, `web/src/main.ts:619-667`.)
6. **Reliable resume after any drop.** Guarantee a `session.attach` (delta) fires on every
   reconnect/daemon-restart for the active session, so optimistic status always re-asserts.
7. **Telemetry pipeline.** Client counters (reconnects, resume type delta-vs-snapshot, flush
   success/fail, time-to-interactive, verify latency) persisted and synced via the daemon; surfaced
   in a debug panel. (`protocol.ts`, supervisor store, `web/src`.)

---

## 6. Phases & status tracking

Legend: ☐ not started · ◐ in progress · ☑ done. Each phase tracks four independent bits:
**Impl** (code written) · **Test** (automated tests green) · **Verified** (agent ran the scenario
runbook + telemetry assertions, evidence pasted) · **Pushed** (merged to branch/remote).

> The agent MUST NOT flip **Verified** without pasting the harness output / runbook transcript /
> telemetry values that prove the phase's acceptance criteria (§7). Per D12 the agent self-signs, so
> evidence is the only guardrail.

### Phase 0 — Baseline & harness
Establish the measurement + fault-injection substrate everything else is gated on.
- Deliverables: deterministic fault harness (simulated WS drop mid-turn, half-open socket, offline
  toggle, stale-seq reconnect, daemon restart); scripted app-driving runbook using network throttling
  / airplane mode; telemetry scaffold (D11) with the counters in §5.7; **recorded baseline metrics**
  on `origin/main` for regression comparison.
- Acceptance: harness runs green against *current* code for scenarios that already pass; baseline
  numbers recorded in this doc's §9 appendix.

| Impl | Test | Verified | Pushed |
|:----:|:----:|:--------:|:------:|
| ☑ | ☑ | ☑ | ☐ |

### Phase 1 — Cross-reload delta resume (client)
Stop cold reloads from pulling full snapshots when the persisted `seq` is valid.
- Deliverables: seed resume trust from persisted state; attach with `lastSeq` on cold open;
  skeleton-first paint (D3/D4).
- Acceptance: **Cold reload → no full snapshot** (telemetry asserts `resume=delta` when cache valid);
  transcript identical to a full-snapshot render (golden comparison).

| Impl | Test | Verified | Pushed |
|:----:|:----:|:--------:|:------:|
| ☑ | ☑ | ☑ | ☐ |

### Phase 2 — Server verify capability + epoch (protocol v4)
Add the cheap watermark that makes cache-trust safe.
- Deliverables: mint/persist per-session `epoch`; `{epoch,lastSeq}` verify message/endpoint;
  `PROTOCOL_VERSION → 4`; client verify handshake gating delta-vs-snapshot.
- Acceptance: verify round-trip is O(1) (no `readAll()`); a forced epoch change forces a snapshot;
  a valid epoch yields delta. Mixed-version node correctly rejected/upgraded (D9).

| Impl | Test | Verified | Pushed |
|:----:|:----:|:--------:|:------:|
| ☑ | ☑ | ☑ | ☐ |

### Phase 3 — Durable IndexedDB HTML cache (client)
Kill the 1.5MB cliff; make the last-viewed transcript robustly available offline.
- Deliverables: IndexedDB store for active-session HTML + `{epoch,lastSeq}`; delta render-and-append;
  migration/cleanup of the old `anvil.convo.*` localStorage keys.
- Acceptance: a transcript > 1.5MB survives reload without dropping to snapshot; offline reload of the
  last-viewed session renders fully from cache with no network.

| Impl | Test | Verified | Pushed |
|:----:|:----:|:--------:|:------:|
| ☑ | ☑ | ☑ | ☐ |

### Phase 4 — Exactly-once sends (**hard gate**)
- Deliverables: server per-session `cid` dedupe (bounded window, persisted across the turn); client
  optimistic `pending` bubble; replace post-flush full-snapshot re-pull with a delta reconcile.
- Acceptance: **Offline send → exactly-once** — compose offline, reconnect (incl. ambiguous-ack
  retry): message applied exactly once. This is a **non-negotiable gate** (§7).

| Impl | Test | Verified | Pushed |
|:----:|:----:|:--------:|:------:|
| ☑ | ☑ | ◐ | ☐ |

### Phase 5 — Reliable recovery after drop / daemon restart (**hard gate**)
- Deliverables: guarantee an active-session delta `session.attach` on every reconnect and after a
  daemon restart; ensure optimistic status (D6) always re-asserts; flush the outbox on the same
  recovery path.
- Acceptance: **Daemon restart → recovery** — restart the daemon under the client; it reconnects,
  re-attaches, transcript + queued writes recover **without a manual refresh**, and no status is left
  stuck. Non-negotiable gate (§7). Also validate **Mid-turn drop → resume** (transcript converges to
  correct final turn) as an important — not gating — scenario.

| Impl | Test | Verified | Pushed |
|:----:|:----:|:--------:|:------:|
| ☑ | ☑ | ◐ | ☐ |

### Phase 6 — Telemetry sync + debug surface
- Deliverables: persist + hub-sync the counters (D11) following the prompt-library pattern; debug
  panel; wire telemetry assertions into the harness.
- Acceptance: metrics visible + synced; harness reads them to assert Phase 1/4/5 outcomes;
  post-change metrics beat the Phase-0 baseline on reconnect recovery time + snapshot-avoidance rate.

| Impl | Test | Verified | Pushed |
|:----:|:----:|:--------:|:------:|
| ☑ | ☑ | ☑ | ☐ |

### Phase 7 — Cross-platform release verification
- Deliverables: run the manual runbook on Web, Android (**reship APK** — bundled UI won't update
  otherwise, per memory), desktop, iOS (validation-only).
- Acceptance: release runbook green on all four; telemetry from real dogf_ood use confirms
  improvement over several days of dogfood use (D-tiered gate).

| Impl | Test | Verified | Pushed |
|:----:|:----:|:--------:|:------:|
| ☐ | ◐ | ◐ | ☐ |

---

## 7. Testing strategy & definition of done

Per D-primary-gate the gate is **tiered**: automated harness gates *merge*, manual runbook gates
*release*, telemetry confirms *in the wild*. Per D12 the agent self-signs — so every "done" requires
pasted evidence.

### 7.1 Tier 1 — Automated fault harness (gates every merge)
Deterministic, CI-enforced. Simulates and asserts recovery for:
- WS drop mid-turn → transcript converges, status never stuck.
- Half-open socket → force-reconnect within heartbeat+grace.
- Offline toggle → outbox queues; reconnect flushes.
- Stale-seq / bad-epoch reconnect → correct snapshot fallback.
- Daemon restart → re-attach + recover.
Extends existing `anvild/test/web/ws.test.ts` and `outbox.test.ts`; adds resume/verify/epoch and
dedupe suites server-side.

### 7.2 Tier 2 — Manual/scripted runbook (gates release)
Scripted app-driving (DevTools throttling / airplane mode / kill-daemon) with explicit pass/fail
checkpoints, executed by the agent across the platform matrix (D2). Each checkpoint records the
observed UI state + telemetry snapshot.

### 7.3 Tier 3 — Telemetry (confirms in the wild)
Dogfood over several days; "improved" means: higher delta-vs-snapshot ratio on reconnect, lower
reconnect-to-interactive time, zero exactly-once violations, fewer stuck-status events — all vs the
Phase-0 baseline.

### 7.4 Hard-gate scenarios (must pass — block done)
1. **Offline send → exactly-once** (Phase 4): compose offline → reconnect (incl. ambiguous-ack
   retry) → applied exactly once. *Verify:* server dedupe log shows one apply; transcript shows one
   message; telemetry `sendDuplicates == 0`.
2. **Daemon restart → recovery** (Phase 5): restart daemon under client → auto reconnect + re-attach
   + queued-writes recover, **no manual refresh**, no stuck status. *Verify:* runbook transcript +
   telemetry `stuckStatusEvents == 0`, `recoveredWithoutRefresh == true`.

### 7.5 Important-but-not-gating scenarios
- **Mid-turn drop → resume converges** (Phase 5).
- **Cold reload → no full snapshot** when cache valid (Phase 1) — telemetry `resume=delta`.

### 7.6 Definition of Done (per phase)
A phase is **Done** only when **all four bits** are ☑ with evidence:
1. **Impl** — code complete, `lint` + `typecheck` clean.
2. **Test** — Tier-1 automated suites for that phase green (paste run output).
3. **Verified** — the phase's §7.4/§7.5 scenarios executed via the runbook; telemetry assertions
   printed and within thresholds (paste transcript + numbers).
4. **Pushed** — merged to `incremental-offline` (and release-verified in Phase 7).

The program is **Done** when every phase is ☑, both hard gates (§7.4) pass on the platform matrix,
and Tier-3 telemetry beats baseline.

### 7.7 Agent self-verification protocol (because of D12)
Before flipping **Verified**, the agent MUST, in order:
1. Run the Tier-1 suite for the phase → paste output.
2. Drive the app through the phase's runbook scenarios (use the `run` / `verify` skills) under the
   relevant fault injection → paste the observed sequence.
3. Read back the telemetry counters and assert them against thresholds → paste values.
4. Only then mark the bit ☑. If any step lacks evidence, the bit stays ◐.

---

## 8. Risks & mitigations
- **No kill-switch (D10):** a resume regression needs redeploy to undo. → Tier-1 harness must cover
  regressions before merge; keep phases small and independently revertible.
- **Coordinated protocol bump (D9):** a straggler fleet node breaks until upgraded. → Sequence the
  rollout hub-first; document the required simultaneous upgrade; Phase 7 verifies the whole fleet.
- **"Keep optimistic" status (D6):** if resume ever fails to run, a spinner sticks forever. → Phase 5
  makes active-session re-attach guaranteed on every reconnect; harness asserts no stuck status.
- **IndexedDB async/quota (D8):** slower first paint / eviction. → skeleton-first (D3) hides async
  latency; handle quota/eviction by falling back to snapshot, never to a crash.
- **`readAll()` still O(history) (out of scope D7):** very old sessions stay slow to snapshot. →
  acceptable this program; cross-reload delta resume (Phase 1) avoids the snapshot in the common
  case; note as follow-up.

---

## 9. Appendix — baseline metrics & verification evidence

### 9.1 Structural baseline (`origin/main`, by code inspection)
| Metric | Baseline (`origin/main`) | After this program | Target |
|--------|--------------------------|--------------------|--------|
| Cold reload resume type (delta:snapshot) | **0:100** — `snapshotLoaded` is in-memory, so every reload cold-attaches (`main.ts` pre-change) | delta whenever epoch matches (proven on the wire, §9.3) | ≫ delta |
| Content cache durability | drops silently >1.5MB (localStorage cap) | no cap (IndexedDB); 2MB transcript round-trips in `convoCache.test.ts` | no cliff |
| Exactly-once on re-flush | none — a lost ack re-runs the turn (duplicate) | server dedupes by `cid`, seeded from the durable log across restart | 0 dupes |
| Stuck status after reconnect | relies on resume running; nothing guarantees delta re-attach on cold reload | resume always ends with a live `status`; delta re-attach guaranteed (`restart-recovery.test.ts`) | 0 stuck |

Runtime percentile baselines (reconnect→interactive p50/p95, stuck-status/session-hour) require the
live browser matrix and are captured in the Tier-2/3 runbook (§9.4, pending).

### 9.2 Tier-1 automated gate — RESULT: GREEN
Full suite: **698 pass / 0 fail / 1 skip** across 108 files (baseline was 672; **+26 new tests**).
Both typechecks (`tsc` server + web) pass; `build:web` succeeds. New/extended coverage:
- `resume.test.ts` (4) — delta-vs-snapshot decision (epoch match / mismatch / no-watermark / ahead).
- `resume-watermark.test.ts` (4) — watermark event, epoch persists across restart, pre-v4 migration, dedupe seeded from log across restart.
- `resume-dedupe.test.ts` (2) — Session applied-cid ring; dispatcher re-acks a duplicate without re-applying.
- `restart-recovery.test.ts` (2) — **hard gate 2**: delta resume of the missed tail after restart, ending with a status; cold client still gets a snapshot.
- `convoCache.test.ts` (5) — IDB get/set/has/delete/move; **2MB transcript survives** (no cliff); legacy cleanup.
- `sendReconcile.test.ts` (3) — optimistic bubble retire + true-duplicate detection (**exactly-once in the UI**).
- `telemetry.test.ts` (2) — `resume()` counts delta-vs-snapshot; client-report aggregation.
- `resume-wire.test.ts` (3) — **end-to-end over a real WebSocket**: watermark before session.list + telemetry.snapshot on connect; cold attach → snapshot with epoch; warm attach → delta (status), never a snapshot.
- `eventlog.test.ts` (+1) — `promptCids` seed + snapshot carries epoch.

### 9.3 Hard-gate evidence
- **Offline send → exactly-once (Phase 4):** mechanism verified by `resume-dedupe.test.ts` (dispatcher
  re-acks a repeated `cid` without a second apply) + `resume-watermark.test.ts` (applied cids survive a
  restart via log seeding) + `telemetry.test.ts` (`promptDeduped` counts a caught re-flush). The
  full non-degraded browser→daemon E2E (turn actually runs) is a Tier-2 runbook item (§9.4).
- **Daemon restart → recovery (Phase 5):** `restart-recovery.test.ts` + `resume-wire.test.ts` prove
  the server re-serves a delta of the missed tail with a stable epoch and a trailing status (spinner
  self-heals). The live "restart the daemon under an open browser, no manual refresh" observation is a
  Tier-2 runbook item (§9.4).

### 9.4 Tier-2 (browser matrix) & Tier-3 (dogfood) — PENDING
These require the live runtime (a real Claude-authenticated daemon + a driven browser on
Web/Android/desktop/iOS) which is outside this implementation environment. Runbook to execute:
1. Web: reload with DevTools "Offline" toggled → skeleton then cached transcript; toggle online →
   delta (watch `#diag` panel: `resumeDelta` increments, `resumeSnapshot` does not).
2. Compose offline → reconnect → exactly one message; `sendDuplicates == 0`, daemon `promptDeduped`
   increments only on a forced re-flush.
3. `kill -9` the daemon under an open tab → auto-reconnect, transcript + queued writes recover, no
   manual refresh, no stuck spinner.
4. Repeat on Android (**reship the APK** — bundled UI), desktop, iOS (validation-only).
5. Dogfood several days; confirm `#diag` counters trend: delta≫snapshot on reload, reconnects recover,
   `sendDuplicates == 0`.

---

## 10. Decision log (interview record)
- Core pain: **all four** (stuck UI, slow reloads, missing messages, sends fail) — broad quality effort.
- Offline scope: **last-viewed only**.
- Platforms: **Web + Android + desktop + iOS** (iOS validation-only).
- Cache trust: **verify before paint** → realized as **skeleton-first**.
- Verify budget: **paint skeleton while verifying**.
- Send semantics: **optimistic + at-least-once** (server `cid` dedupe).
- Stale status: **keep optimistic** (safe via guaranteed resume re-assert).
- Server scope: **cheap-verify endpoint only** (no compaction, no `since()` reindex).
- Primary gate: **tiered** (harness→merge, runbook→release, telemetry→wild).
- Hard-gate scenarios: **daemon-restart recovery** + **offline-send exactly-once**.
- Compatibility: **protocol bump 3→4, coordinated fleet upgrade**.
- Telemetry: **rich, daemon-synced**.
- Client persistence: **HTML blob in IndexedDB, larger cap** (delta render-and-append).
- Kill-switch: **none, ship direct**.
- Sign-off: **agent auto for all phases** (evidence-gated).
