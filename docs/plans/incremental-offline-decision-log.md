# Incremental Offline — Implementation Decision Log

Every non-trivial decision made during autonomous implementation, for later review. Companion to
`incremental-offline-resilience.md` (the spec). Newest entries appended at the bottom of each phase.

Format: **[ID] Decision** — rationale / alternative rejected.

---

## Cross-cutting / architecture

- **[A1] Watermark rides on connect, no extra round-trip.** The server pushes a new
  `resume.watermarks` event (per-session `{sessionId, epoch, lastSeq}`) on every WS open, right
  before `session.list`. The client verifies its cached `{epoch,lastSeq}` against it to choose
  delta-vs-snapshot. *Rejected:* a request/response `resume.verify` command — unnecessary because the
  connect-time watermark already carries everything, and epoch is stable for a session's life so a
  per-switch re-verify adds latency for no safety gain.

- **[A2] Epoch is minted once at session creation, persisted, and never mutated.** It exists purely as
  a safety guard: if a future change ever rebuilds/compacts the append-only log (none does today, per
  spec D7), a changed epoch forces the client back to a full snapshot. *Rejected:* regenerating epoch
  on `reset`/`new_topic` — those preserve scrollback (the log is intact, `seq` continues), so bumping
  epoch would force a needless full re-snapshot of the whole kept history on the next reload.

- **[A3] Incremental-resume validity = `epoch match AND server.lastSeq >= cached.lastSeq`.** Because
  the log is append-only and never pruned (D7), `since(lastSeq)` always returns every missed event, so
  an epoch match is sufficient to trust a persisted seq across reloads and across a not-yet-attached
  session switch.

- **[A4] PROTOCOL_VERSION 3 → 4, hard cutover.** `parseCommandFrame` already rejects any frame whose
  `v !== PROTOCOL_VERSION`, so a v3 client hitting a v4 daemon (or vice-versa) gets a clean
  `command.error`. This is the coordinated fleet upgrade the spec chose (D9); no capability gate for
  the resume/verify path.

- **[A5] Exactly-once = server-side `cid` dedupe on `prompt.send`, seeded from the durable log.** The
  outbox already tags every queued command with a stable `cid` and re-sends the same `cid` on each
  flush. The server records applied prompt cids per session (in memory, seeded at load by scanning the
  event log's `message.user` cids) and re-acks a duplicate without re-running the turn. Persisting the
  cid in the `message.user` log entry is what makes exactly-once survive a daemon restart between
  "apply" and "client re-flush" — the restart gate + the exactly-once gate in one mechanism.

- **[A6] Optimistic bubbles are tagged with their `cid`; the authoritative `message.user` (delivered
  by a delta re-attach after flush) removes the matching optimistic node.** This replaces the old
  "re-pull a full snapshot to clear optimistic bubbles" with a cheap delta reconcile, and gives
  exactly-once in the UI as well as on the server.

- **[A7] Offline cold-boot shows cached content immediately; online cold-boot is skeleton-first.**
  D3 (verify-before-paint) only makes sense when there's a server to verify against. Offline there is
  nothing to verify, and D1 requires the last-viewed conversation be available offline — so offline we
  paint the cache. Online we render a skeleton, and only fill validated cache once the watermark
  confirms the epoch matches (else the incoming snapshot repaints).

---

## Phase 2 — protocol v4 + epoch + watermark + dedupe (server)

- **[P2.1] `protocol.ts` is a symlink to `docs/plans/anvil-protocol.ts`.** Edited the real target;
  both paths now read v4. No divergence risk — they are the same inode.
- **[P2.2] Applied-cid ring cap = 1000 per session.** Bounded memory; far exceeds any realistic
  in-flight-retry window. Eviction is FIFO (oldest applied cid drops first). Seeded at load from the
  log's `message.user` cids so it survives restart.
- **[P2.3] `wrap(data, lastSeq, epoch = newId("ep"))` mints an epoch by default.** All create paths
  (including the two secondary `wrap(data,0)` callsites) get a fresh epoch for free; `restore` passes
  the persisted one; a pre-v4 row (undefined) falls through to a freshly minted token — forcing one
  harmless full snapshot on the next attach. *Rejected:* a required epoch param — would have touched
  every callsite for no benefit.
- **[P2.4] Dedupe guard lives in BOTH the dispatcher and `supervisor.prompt`.** The dispatcher short-
  circuits to a bare `ack` (so the client dequeues) before any side effect; `prompt()` also guards
  internally as defense-in-depth for non-dispatch callers (team relay, autopilot). The dedupe check is
  intentionally BEFORE the auth-degrade check so a degraded session never half-applies.
- **[P2.5] Golden updated by hand, not via `regen-golden.ts`.** That script imports the contract test
  module, which executes `test()` at import outside a `bun test` runner and throws. Editing the two
  golden fields (protocolVersion 3→4, add `resume.watermarks`) is equivalent and reviewable in the
  diff. Flagged as a follow-up: `regen-golden.ts` should be runnable standalone.
- **[P2.6] Contract test now asserts the connect frame order** `server.hello → resume.watermarks →
  session.list`, encoding the invariant Phase 1 depends on (watermarks in hand before the list handler
  attaches).

---

## Phase 1 — cross-reload delta resume (client)

- **[P1.1] Pure resume decision extracted to `web/src/resume.ts`.** `canDeltaResume(wm, cachedEpoch,
  cachedSeq)` is DOM/socket-free and unit-tested (7 assertions). main.ts's `canResumeIncrementally`
  is a thin wrapper. Matches the codebase's `outbox.ts`/`ws.ts` extract-for-testability pattern.
- **[P1.2] Skeleton-first with a 1500ms offline budget (`CACHE_FALLBACK_MS`).** On cold open we paint a
  shimmer skeleton and defer the cached transcript until `resume.watermarks` validates the epoch. If no
  server opens within 1500ms we treat it as offline and paint the cache anyway (spec A7/D1). *Rejected:*
  D4's ~400ms — that budget is for the verify handshake once a socket is already open; a cold boot
  includes the connect time, so a slightly longer budget avoids a premature "offline" cache flash on a
  merely-slow reconnect. Tunable in one place.
- **[P1.3] A delta attach requires `cacheReady` (cache pending this load OR already loaded this
  page-load).** Guards the trap where `seq`/`epoch` persist but the HTML cache was evicted: a bare delta
  would leave old history missing, so we cold-snapshot instead. This is why `canResumeIncrementally`
  alone doesn't gate the attach.
- **[P1.4] `epochStore` + `serverWatermarks` are the client's half of the watermark.** Epoch is cached
  per session in `localStorage` (`anvil.epoch.<id>`) when a snapshot lands; watermarks are held in
  memory per page-load (rebuilt on every connect). A reconnect mid-session delta-attaches without
  wiping the screen (pendingCache is null, conversation already has content).
- **[P1.5] snapshot handler now records `{epoch,lastSeq}`** so the very next reload can delta-resume —
  without this the first reload after any snapshot would still cold-attach. This closes the gap the spec
  identified (in-memory `snapshotLoaded` never persisted the trust).

---

## Phase 3 — IndexedDB conversation cache (client)

- **[P3.1] Bulk HTML in IndexedDB, a tiny id-index in localStorage.** The attach decision needs a
  SYNCHRONOUS "do we have a cache?" answer at boot, but IDB is async — so `convoCache.has(id)` reads a
  small localStorage index (`anvil.convo.index`) while the bulky transcript lives in IDB. Best of both:
  no size cliff, no async race at the decision point.
- **[P3.2] Load flow is now async: skeleton → `await convoCache.get` → decide.** The attach is issued
  only AFTER the cache is in hand, which guarantees a validated cache paints BEFORE the deltas that
  append on top of it (no lost/reordered events). The reconnect-mid-session path (`attachReconnect`)
  stays synchronous — the pane already has content, so it just delta-resyncs.
- **[P3.3] In-memory fallback when `indexedDB` is undefined.** Keeps the module working in jsdom tests
  and private-mode edge cases without branching at the call sites; behaviour (has/get/set/delete/move)
  is identical, so the unit tests cover the real contract.
- **[P3.4] `migrateLegacyConvoCache()` wipes the old `anvil.convo.*` localStorage blobs on boot.**
  Reclaims that quota; the index key is preserved. Idempotent, best-effort.
- **[P3.5] `forgetConvoState(id)` on kill/purge** drops the transcript AND the resume watermark
  (epoch+seq), so a future session id can never delta-resume against a dead session's stale state.
- **[P3.6] No explicit size cap on IDB writes.** The 1.5MB cliff is gone; IDB quota is orders larger
  and a failed write degrades to a snapshot (caught). If a pathological transcript ever matters, a cap
  is a one-line add — flagged, not implemented.

---

## Phase 4 — exactly-once sends (client half; server half is A5/P2.4)

- **[P4.1] EVERY send carries a stable cid, online and offline.** The outbox path always had one; the
  online path now does too. Online it lets the daemon dedupe an accidental duplicate and lets the echo
  match its bubble; offline it's the outbox idempotency key.
- **[P4.2] Optimistic bubbles tagged `data-cid`; the authoritative echo retires them.** Reconciliation
  extracted to `sendReconcile.ts` (`reconcileOptimistic`) and unit-tested. A second authoritative echo
  for the same cid is detected as a true duplicate and dropped → exactly-once holds in the UI, not just
  on the server.
- **[P4.3] Flush reconcile is a DELTA re-attach, not a full snapshot.** The daemon broadcasts the
  authoritative `message.user` (with cid) as we flush — which already retired the optimistic bubble — so
  a full re-pull is wasteful. The delta re-attach only re-syncs any missed tail and re-asserts status.
  This is the concrete replacement the spec called out for the old "re-pull a full snapshot" line.
- **[P4.4] `sendDuplicates` counts only TRUE duplicates** (an authoritative echo arriving for a cid
  already rendered authoritatively), not the normal optimistic→authoritative swap — so the acceptance
  assertion "sendDuplicates == 0" is meaningful.

---

## Phase 5 — reliable recovery after drop / daemon restart

- **[P5.1] Recovery is largely emergent from Phases 1/2/4, by design.** On reconnect: `onStatus` fires
  `flushOutbox`, and the daemon's `resume.watermarks`→`session.list` drives `attachReconnect` (a delta,
  no pane wipe). No new bespoke recovery code was needed — the pieces compose. Documented rather than
  re-invented.
- **[P5.2] Exactly-once survives the restart because applied cids are seeded from the durable log
  (P2/A5).** A prompt applied then lost to a restart is recognised on re-flush → re-acked, not re-run.
  This is precisely why the dedupe seed reads the log, not just in-memory state.
- **[P5.3] "Keep optimistic status" (D6) is safe because `resume()` always ends with a live status.**
  The recovery test asserts the delta's last frame is a `status` event, so a spinner left running while
  disconnected is corrected the instant the client re-attaches — no stuck UI once reconnected.
- **[P5.4] Stale `serverWatermarks` are refreshed before any re-attach.** The daemon sends
  `resume.watermarks` BEFORE `session.list` on every (re)connect, so the map is current before
  `attachReconnect` reads it — no risk of delta-resuming against a pre-restart watermark.

---

## Phase 6 — telemetry sync + debug surface

- **[P6.1] Free-form counter maps on the wire** (`Record<string, number>`) for both the client report
  and the daemon snapshot, so new metrics never need a protocol bump. The typed `TelemetryCounters`
  lives only client-side.
- **[P6.2] Client reports are throttled (4s coalesce) + flushed on `visibilitychange:hidden`.** Avoids
  a frame per counter bump while still capturing short sessions. The daemon keys the latest report per
  stable `clientId` (persisted in localStorage).
- **[P6.3] Daemon counts what IT served** (`resumeDelta`/`resumeSnapshot` in `resume()`,
  `promptDeduped` in the dispatch dedupe branch). This is the authoritative source for the
  "cold reload → delta, not snapshot" and "exactly-once" acceptance assertions — the client's view is
  corroborating, not sole.
- **[P6.4] Debug panel is opt-in** (`#diag`, Ctrl/Cmd+Shift+D, or `window.__anvilDiag()`), not always
  rendered — zero cost in normal use, full readout (client + daemon counters) when investigating.
- **[P6.5] Two new connect frames + wire types → golden + CONNECT_FRAMES updated** (`telemetry.snapshot`
  event, `telemetry.report` command). Frame-order test unaffected (telemetry.snapshot lands after the
  autopilot frames, well past the resume/session-list ordering the client depends on).
- **[P6.6] `resume.watermarks`/`telemetry.snapshot` are handled in `handleSessionEvent` (no `url`).**
  They're global (no sessionId) so they reach it via the default case; verify latency is measured from
  the hub's `connectStartedAt`, a good-enough proxy without threading `url` through.

---

## Phase 0 + 7 — harness, baseline, verification

- **[P0.1] The test suite IS the fault harness.** Rather than a separate framework, deterministic
  fault scenarios live as focused tests: WS backoff/half-open/reconnect (`ws.test.ts`, pre-existing),
  outbox persistence/cascade (`outbox.test.ts`, pre-existing), plus the new resume/epoch/dedupe/cache
  suites and a real-WebSocket E2E (`resume-wire.test.ts`). This keeps the harness in CI where it gates
  merges, exactly as the spec's Tier-1 requires.
- **[P0.2] Baseline is structural, not percentile.** Runtime p50/p95 numbers need the live browser
  matrix (unavailable here); the meaningful baseline is structural (delta:snapshot was 0:100 because
  `snapshotLoaded` was in-memory; the 1.5MB cliff; no cid dedupe) and is recorded in spec §9.1 with the
  after-state.
- **[P7.1] Verified bits: automated acceptance ☑, live matrix ◐.** Per D12 the agent self-signs on
  automated + telemetry evidence, which is green and pasted (spec §9.2–9.3). The two hard gates' MECHANISMS
  are automated-verified; their full non-degraded browser→daemon E2E (a turn actually running, a real
  `kill -9` under an open tab) needs a Claude-authenticated runtime this environment lacks, so those
  bits are honestly left ◐ with a concrete runbook (spec §9.4) rather than over-claimed.
- **[P7.2] Not committed/pushed.** All Pushed bits are ☐ — the harness convention is to commit only on
  explicit request. The branch `incremental-offline` holds the working tree for review.
- **[FOLLOW-UPS] Flagged, not done:** (1) make `regen-golden.ts` runnable standalone (P2.5);
  (2) optional IDB write cap if a pathological transcript ever matters (P3.6); (3) the O(history)
  `readAll()` per attach remains (spec D7 out-of-scope) — cross-reload delta resume avoids it in the
  common case but a compaction pass is the real fix.

---

## Adversarial review (post-implementation) — 3 real bugs found & fixed

A skeptical review of the full diff surfaced three triggerable defects, all now fixed + regression-tested:

- **[R1] `saveConvoCache` could clobber a session's cache with a skeleton / the wrong session's DOM.**
  The 600ms debounced writer captured `id = activeId` but cloned the SHARED conversation node without
  re-checking. Switching sessions within the debounce window wrote session B's skeleton into A's cache
  → A reopens to a frozen shimmer + empty delta. *Fix:* the timer bails if `activeId !== id` or a
  `.convo-skeleton` is present (`main.ts`). Introduced by the skeleton-first async load; invisible before.
- **[R2] Daemon-handled commands (`/goal` `/clear` `/compact`) weren't deduped.** They apply a real
  side effect but early-return in `prompt()` before the cid was recorded → an offline re-flush ran the
  side effect twice (exactly-once violation for exactly the messages the gate protects). *Fix:* record
  the cid inside each of the three branches (NOT the degraded branch — nothing applied there, so it
  should retry when the token heals). Regression test: `exactly-once-commands.test.ts`.
- **[R3] An offline-queued slash command left a permanent orphan `.queued` bubble.** No `message.user`
  echo is ever emitted for `/clear`/`/compact`/`/goal`, so `reconcileOptimistic` never retired the
  optimistic bubble. *Fix:* `sendComposer` skips the optimistic bubble for `isDaemonHandledCommand`
  text (still queues the command) — consistent with their online behaviour (no user bubble). Extracted
  `isDaemonHandledCommand` to `sendReconcile.ts` + unit-tested.

Everything the review checked and passed (delta-onto-empty-pane guard, cache-before-deltas ordering,
dual-order cid reconcile, server dedupe placement, epoch round-trip, convoCache index/IDB divergence)
is recorded as correct. Post-fix: **700 pass / 0 fail**, both typechecks + web build green.

---

## HOTFIX (post-deploy) — 3.0.33 "dead app" for returning users

**Symptom:** 3.0.33 came up but showed no servers/environments and the wrong theme.

**Root cause:** the skeleton-first change made the top-level "instant restore" call
`loadConversation(activeId)` → `clearConversation()`, which touches `permCards`/`questionCards` — consts
declared ~6300 lines below and therefore in their **temporal dead zone** during synchronous module init.
Init threw for **every returning user (activeId set)**, aborting before theme/socket/server-load. This is
the exact "declare-up-top rule" the codebase documents (memory: web-early-init-decl-order-crash).

**Why every gate was green:** typecheck/build never *execute* init, and all tests + my Chrome/jsdom
repros used a FRESH profile (no `activeId`) → they took the `renderEmptyState` branch and never reached
the crashing path. The bug only triggers with a persisted open session.

**Fixes:**
- **[H1] Defer the init conversation load** — `queueMicrotask(() => loadConversation(activeId))` so it runs
  after synchronous module init completes and every const it reaches is initialized.
- **[H2] Quota safety** — an upgraded app can have localStorage near full of old `anvil.convo.*` blobs;
  moved `migrateLegacyConvoCache()` to run FIRST (frees that quota) and wrapped the new `clientId`
  `localStorage.setItem` in try/catch so a full quota can never abort init.
- **[H3] Regression test** — `test/web/boot-init.test.ts` builds the real bundle and boots it under node+
  jsdom with a returning user's state (saved theme + activeId); asserts no init throw + theme applied.
  Verified it FAILS with the fix reverted and PASSES with it — closing the fresh-install-only test gap.

**Lesson:** any code added to the top-level init chain must obey the declare-up-top rule; the boot test
now guards the returning-user path that all prior coverage missed.
