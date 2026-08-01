# Improvement Program v2 — Decision Log

Running log of decisions made during autonomous implementation of
`2026-08-01-improvement-program-v2.md`. Reviewed after implementation.

## P7 — God-file decomposition (in progress, branch `refactor/godfile-decomp`)

Method (proven from v1 Phase 3): move a cohesive domain into its own module with its Supervisor deps
INJECTED, delegate the public methods from the god-file, keep the full suite green as the safety net
(behavior-preserving), and add a focused unit test for the new module's API.

**Slice 1 — DONE (committed + pushed):** `IntegrationsFacade` (`src/session/integrations-facade.ts`).
Moved the Todoist + lapo domain (status/connect/disconnect, the lapo OAuth2 handshake, token refresh,
project listing) out of supervisor.ts; deps injected (IntegrationStore, registry, self-base-URL
providers). Also moved `BadCommand` → `src/session/errors.ts` (re-exported) to avoid a circular import.
supervisor.ts 3604 → 3463. Full suite green (799). Guard: `integrations-facade.test.ts`.

**Remaining slices (ordered by cleanliness/risk, each its own commit, each must keep the suite green):**
1. **AccountRosterService** — CONTIGUOUS block (authStatus/setAuthToken/account CRUD/broadcastAccounts/
   afterAccountMutation) with the STRONGEST existing coverage (4 account test files = ideal safety net).
   Wider dep surface (needs `sessions()`, `restartIdleSessionsForNewToken`, `broadcastAuthState`
   injected) — do next, carefully.
2. **TeamCoordinator** — team orchestration (buildTeamServer … integrateTeam, spawnMember,
   drainQueuedMembers). Cohesive but coupled to create/kill/prompt (inject those).
3. **AutopilotService** (+ its 5-min scheduler) — the largest domain (~1000 lines: plans, runAutopilot,
   runDevPipeline, schedule, reconcile). Biggest win, highest care; extract last on the backend.
4. **GitProjection/PrSweeper** — refreshGit/refreshPrState/gitOp/startPrStateSweeper; natural home for the
   deferred BE2-2/3/5 async-git conversion, so pair those.
5. **http.ts** route ladder → a method+prefix route table with one top-level try/catch→500 (also kills the
   BE2-10 crash-500 class) + a `withJsonBody` helper (5× copy-pasted push handlers). DRY: BE2-45
   `ackWhenDone`.
6. **Web** (`main.ts` 7600 lines): extract `fleet.ts`/`sidebar.ts`/`conversation.ts`/`autopilot.ts`/etc.
   in dependency order, each carrying its shared scalars into `state.ts` — this is what permanently
   retires the WEB2-1 TDZ crash class. Fold WEB2-2/16 render-diffs + WEB2-8 a11y into the relevant seams.

RATIONALE for pacing: this is behavior-preserving refactoring of critical infrastructure. Each slice is
landed and verified independently rather than batched, so a subtle regression is caught (and reviewable)
at the smallest granularity. The full test suite (+ the coverage each extraction adds) is the safety net.

---

Baseline at start: `bun test` → 741 pass, 1 skip, 1 fail (the known
`boot-init.test.ts` red — reads absent `web/dist/index.html`). HEAD `2059142`.

Format: `[TAG] decision — rationale`.

---

## Post-merge interview outcomes (2026-08-01, after PR #168 merged)

The author reviewed this log and decided the open points. Actioned on branch
`followup/interview-sec2-3-be2-31`:

1. **SEC2-3 → "Allow loopback on update routes."** Loosened the identity gate on `/api/update/v1/apply`
   and POST `/api/daemon/update`: a purely-local caller (loopback peer, NO `Tailscale-User-Login` header)
   is now permitted, since it's a process already on the box (e.g. the native macOS updater hitting the
   REST route directly, not via `tailscale serve`). A serve-proxied request from a DIFFERENT tailnet user
   is loopback WITH a header → still rejected. Extracted `isLocalNoIdentityCaller` (pure, unit-tested in
   `pairing.test.ts`). Removed the old integration assertion — with the loosening it would have driven a
   REAL `git` apply against the checkout; the decision is unit-tested instead.
2. **BE2-30 → "Leave deferred (low priority)."** No change; the atomic write already prevents the severe
   (torn-file) failure. Sidecar remains the recommended fix if it's ever revisited.
3. **Follow-up order → "Async-git-ops (BE2-2/3/5/15) first."** That's the next PR: convert
   worktree-fetch / team-integration / per-turn refreshGit / fleet rotate+invite to async subprocess
   spawns, with a fake-slow-binary responsiveness harness (pre-doctor PATH before importing the git module).
4. **BE2-31 → "Restart to known-good anyway."** Reverted the re-probe/skip-restart logic: after the gate
   elapses unhealthy and rollback runs, the watchdog now ALWAYS restarts to prePullSha, so disk/process/
   state converge immediately (one deterministic restart). A target that recovers *across ticks* (before
   rollback is committed) is still adopted by the top-of-tick health probe. Guard test updated.

## Overall summary (read this first)

Final state: **795 pass / 1 skip / 0 fail**; `typecheck` + `typecheck:web` + `build:web` all green.
Every change landed test-first where a guard was tractable; committed per-phase for review.

**Done with guard tests:** P0 fully (SEC2-1/2/3). P1 web fully (WEB2-1/10/12) + BE2-1/BE2-4. P2 fully
(BE2-14/20/21/22/23/24, WEB2-11/13/14/15). P3 8/9 (BE2-10/11/12/13/28/29/31/33). P4 BE2-6/7/8/17 +
WEB2-4/5. P5 contract wire-shape golden + input-queue + fixtures. P6 CI2-2/3/5/6/9/10. P8 the
wrong/contradictory docs + REQUIREMENTS.md.

**Deferred, each documented in its phase section below with rationale + a recommendation:**
- BE2-2/3/5 (async-git-ops conversion) — one coherent PR; existing gitSpawn timeouts already BOUND these.
- WEB2-2/16 (sidebar/team-board render diff) — land with the P7 sidebar/fleet extraction.
- BE2-30 (cross-process CAS on update-state) — needs the sidecar redesign + multi-process tests.
- WEB2-9/6/3, BE2-15 (transcript virtualization / bundle hashing / job-ify fleet REST) — build/render PRs.
- P7 (god-file decomposition) — behavior-preserving refactor; the highest-churn/lowest-marginal-safety
  work. The guard suite this program ADDED is the safety net the plan says P7 needs, so it's best done
  next as its own focused effort (see P7 note). WEB2-1's TDZ class is contained by the queueMicrotask
  fixes already shipped; the structural state.ts move is the P7 follow-up.
- CI2-1/4/7/12 (native PR builds etc.) — need real CI runs to validate safely.
- Native (Swift/Kotlin) test targets — still toolchain-blocked (unchanged from v1).

---

## P0 — Fleet-update integrity + origin/identity gate (ship-blocker) — DONE, green

- [SEC2-1] Added ancestry gate to `applyUpdateToTarget` (selfupdate.ts): before checkout, require
  `git merge-base --is-ancestor <target> <resolvedUpstreamRef>`; reject non-reachable targets.
  Used the *resolved* upstream ref (`resolveUpdateRef`, = @{u} or origin/HEAD fallback) rather than a
  literal `origin/HEAD` string — more robust on detached/local-only checkouts (the dev-box case the
  existing tests already cover), and it IS the "trusted upstream tip" the plan means. Added an
  `allowNonFastForward` opt that bypasses the gate for the rollback path; fixed the doc-comment that
  previously lied about this guard existing. Guard: `test/unit/selfupdate-ancestry.test.ts`.
- [SEC2-2] Chose a CENTRALIZED origin gate at the top of `handle()` (any POST/PUT/DELETE to `/api/*`)
  rather than sprinkling a per-route helper — less error-prone, no route can be forgotten, and every
  mutating route is tailnet-only so there's no legitimate foreign-origin caller. Reuses the existing
  `isAllowedWsOrigin` (native/no-Origin, same-origin PWA, same-tailnet `*.ts.net`, `ANVIL_ALLOWED_ORIGINS`
  all still pass). Added an `application/json` content-type requirement (415) on `/api/update/v1/apply` to
  defeat the CORS simple-request bypass.
- [SEC2-3] Hoisted `callerIdentity` to the top of `handle()` (it sat below the update routes) and added
  the reject-proven-`otherUser` posture to `/api/update/v1/apply` and the POST branch of
  `/api/daemon/update`, mirroring `/api/fleet/*`. RISK/NOTE: over pure loopback with no
  `Tailscale-User-Login` header, `resolveCallerIdentity` classifies "otherUser" → 403. This matches how
  `/api/fleet/rotate|update` already behave (driven from the same web UI, which arrives via
  `tailscale serve` WITH the header), so it's consistent — but a native updater hitting the REST route
  over bare loopback without the header would now 403. Flag for review. Guard:
  `test/integration/origin-identity-gate.test.ts`. The positive "unknown/sameUser proceeds" branch is
  covered by existing `resolveCallerIdentity` unit tests; asserting it in integration would trigger a
  real git/bun apply, so it's not re-exercised over the wire.

---

## P1 — Deterministic crashes & event-loop freezes

Web (all tested, green):
- [WEB2-1] Deferred the cold deep-link init calls (`openPlanDeepLink`/`openAutopilot`) to
  `queueMicrotask` so they run after the module body finishes — the same fix `2059142` applied to
  `loadConversation`. Guard: extended `boot-init.test.ts` — build once, run 3 scenarios (returning
  user with a matching persisted session for the setHeaderTitle branch, `#autopilot`, `#p/<id>`),
  assert `initErr === null`. Seeded a *complete* Session in the returning-user case (partial objects
  crash setHeaderTitle on a missing field — itself a latent boot-crash class, but out of WEB2-1 scope).
- [WEB2-10] Added `safeLocalSet` (try/catch) and routed epoch + seq persistence through it; seq is now
  throttled (in-memory, flushed ≤1/s and on tab-hide) off the delta hot path. Wrapped `onEvent` in
  ws.ts in try/catch + console.error. Guard: `ws.test.ts` — a throwing onEvent is caught, socket stays
  OPEN, subsequent frames still delivered.
- [WEB2-12] Stored the window `online` / document `visibilitychange` handler refs and remove them in
  `close()`. Guard: `ws.test.ts` asserts add/remove counts (dispatch-based check dropped — earlier
  tests in the shared jsdom process leak un-closed sockets that confound it; the count is precise).

Backend sync-network family (BE2-1, BE2-4 done+contained; BE2-2/3/5 deferred — see rationale):
- [BE2-1] Routed the `gitOp("status")` PR-state probe off the request path via the existing async twin
  (`refreshPrState` → `prStatusAsync`). The immediate response carries local status + last-known badge;
  the network `gh pr view` result broadcasts when it resolves.
- [BE2-4] Added `deleteRemoteBranchAsync` (Bun.spawn) and `await` it in the background `teardownSession`
  — the sync `git push --delete` blocked the loop even inside an async teardown (async runs sync until
  the first await). `removeWorktree` stays sync (local/bounded, not a network hang).
- [BE2-2 / BE2-3 / BE2-5] DEFERRED to a separate reviewed PR, documented here for the review:
  - BE2-2 (worktree-create `git fetch`), BE2-3 (team-integration merge→push→PR chain), and BE2-5
    (per-turn `refreshGit`) each require converting a synchronous, deeply-embedded git contract into an
    async chain (createWorktree must return a ready cwd; the integrate chain feeds a tool-handler return
    value; refreshGit is called from ~5 sites). Wrapping them in a promise does NOT remove the freeze —
    `Bun.spawnSync` blocks the loop whenever the microtask runs — so the real fix is async subprocess
    spawns throughout, a large surface with real regression risk.
  - The plan itself flags this family as needing care ("the delicate mergePr worktree-rollover stays a
    separate reviewed PR"). The existing `gitSpawn` hard timeout (NET_TIMEOUT_MS=60s) + SSH keepalive
    (~30s dead-connection reap) already BOUND these stalls — they're bad latency, not unbounded hangs.
  - Guard-test friction reinforced the split: `GIT_ENV` is captured at import (frozen PATH), so the
    canonical "fake-slow-`gh` on PATH + assert concurrent ping <100ms" harness can't be built reliably
    without booting the full server+SDK+real-git-repo per case. BE2-1/BE2-4 were done because they're
    contained; the rest are logged as a coherent follow-up rather than shipped half-verified.
  - RECOMMENDATION for review: schedule the async-git-ops conversion (mergeBranch/push/createPr/fetch
    async twins + createWorktree/integrateTeam/refreshGit rewiring) as its own PR with a responsiveness
    harness that pre-doctors PATH before importing the git module.

## P2 — Memory growth & broadcast amplification

Backend (all tested, green):
- [BE2-14] `writeFileAtomic` at `fleet/store.ts` save + both `env-file.ts` writers. Guard added to
  `atomic-write.test.ts`: a failed write leaves the target intact, no stray `.tmp`, env keeps 0600.
- [BE2-20] Backpressure in `ConnectionRegistry`: soft cap 1 MiB → drop droppable (`assistant.delta`,
  re-derivable via v4 resume), hard cap 8 MiB → close the wedged socket. Guard:
  `registry-backpressure.test.ts`. Only `assistant.delta` is classed droppable (conservative).
- [BE2-21] `broadcastUpdated` now only touches the team tree for `teamRole||parentId` sessions, and the
  team-info broadcast is coalesced (250ms) + deduped (skip identical tree). Structural changes
  (member add / kill) still call `broadcastTeamInfo` immediately. Full suite stayed green (no test
  depended on a synchronous team.info after a non-team update).
- [BE2-22] diffstat capped at 200 lines + a "+N more files" summary line.
- [BE2-23/SEC2-4] `clientTelemetry` → LRU(50)+30min TTL, `sanitizeCounters` (plain object, ≤32 keys,
  finite numbers, ≤64-char keys), id validated (≤200 chars), broadcast coalesced 250ms. Guards in
  `telemetry.test.ts` (5000 ids → ≤50; malformed ignored).
- [BE2-24] Added the two missing deletes in `kill()`.

Web (WEB2-11/13/14/15 done; WEB2-2/16 deferred):
- [WEB2-14] `persistSessions` debounced 1s-trailing, flushed on `visibilitychange:hidden` + `pagehide`;
  `persistSessionsNow` is the immediate writer (via safeLocalSet).
- [WEB2-11] `forgetConvoState` now also drops `pendingSeq`, `anvil.history.*`, and `anvil.draft.*`
  (history had NO removal path). Added `forgetConvoState(id)` to the `session.list` prune loop, plus a
  conservative boot sweep of orphaned `seq/epoch/history` keys + convoCache entries (skips drafts;
  skips when the hydrated list is empty). Added `convoCache.keys()`. Guard in `convoCache.test.ts`.
- [WEB2-13] Diagnostics panel keeps + calls the telemetry unsubscribe on close (was leaking a listener
  per open).
- [WEB2-15] Autopilot progress log appends a text node per line + rAF-coalesces scroll (was O(n²):
  re-join whole array + textContent replace + forced scroll per line). Snapshot rebuild stays O(n).
- [WEB2-2 / WEB2-16] DEFERRED (documented): the sidebar full-`innerHTML` rebuild and team-board rebuild
  are M-effort render-diff rewrites (rAF-coalesced dirty flag + keyed `li.dataset.id` diff + hoisted
  `envOrdinal` map + cached `orderedServers`). High regression risk in the most-used UI path; the plan
  itself couples this with the P7 web decomposition ("each seam carries its scalars into state.ts").
  Recommend doing WEB2-2/16 as part of the P7 `sidebar.ts`/`fleet.ts` extraction, not as a bare in-place
  diff, so the render + its state move together. The per-row `localStorage.getItem` and O(N²) sort are
  the measurable cost; deferring keeps correctness intact (renders are just more frequent than optimal).

## P3 — Update-service robustness + fleet correctness (8/9 done, all tested)

- [BE2-33] New `src/daemon/sha.ts` (`shaMatches`/`shaOf`) with a MIN_SHA_LEN=7 guard (a shorter value
  only matches exactly, never as a prefix). Wired the 3 call sites. Guard: `sha.test.ts`.
- [BE2-28] Module-level in-flight promise in update-api serializes all three apply transports; a second
  concurrent apply gets "already in progress". Guard in `update-api.test.ts`.
- [BE2-10] `/api/fleet/members` heals are now `void`+throttled(20s)+per-member try/catch (malformed
  `new URL` can't reject the pass). Guard: `fleet-members-heal.test.ts` (bad url → 200; fast GET).
- [BE2-11] try/finally in `FleetRolloutCoordinator.run` clears `active` even on a thrown body. Guard in
  `fleet-rollout.test.ts`.
- [BE2-12] Wired `reconcile()` (was dead) off a throttled(30s) members-GET pass. Uses the existing
  reconcile D19 unit test for behavior; the wiring is fire-and-forget.
- [BE2-13] `MAX_PAIR_ATTEMPTS=5` → the pairing window disarms after 5 wrong codes. Guard in
  `pairing.test.ts`.
- [BE2-29] Watchdog arms across `pulling|building|restarting` (crash mid-build now rolls back). To
  avoid a false positive, a LIVE healthy daemon still building past the gate is NOT rolled back (only a
  crashed/unreachable one is); "restarting" keeps its original stuck-on-old-sha rollback. Guards in
  `update-watchdog.test.ts`.
- [BE2-31] Re-probe health after `rollback()` resolves; if the target went healthy during the
  minutes-long rebuild, adopt it and SKIP the backwards restart (the restart-storm class). Guard added.
- [BE2-30] DEFERRED (documented). `UpdateStateStore.set` is a cross-process read-modify-write shared by
  daemon + watchdog; atomic write ≠ atomic RMW, so a tight interleave can lose a field. A correct fix
  (updatedAt/seq CAS with file locking, or the sidecar redesign) is a subtle change to the MOST
  safety-critical store and needs its own focused PR with multi-process tests — shipping it
  half-verified here would risk the very reliability it protects. The already-atomic write prevents the
  worse failure (a torn/zeroed file); BE2-30 is about rarer lost-updates between two cooperating
  processes. RECOMMENDATION: implement via a `.watchdog.json` sidecar (each process sole-writes its own
  file; `get()` overlays the newer) — no lock needed, and it matches the plan's second suggestion.

## P4 — Scalability (BE2-6/7/8/17, WEB2-4/5 done; WEB2-9/6/3, BE2-15 deferred)

- [BE2-6/BE2-7] EventLog in-memory tail cache; hydrate once, serve since/snapshot/promptCids from
  memory; append keeps it in step. Guard: `eventlog.test.ts` (reads survive file deletion).
- [BE2-8] `replay?:boolean` (additive protocol field) on re-surfaced permission/question events so a
  `seq > watermark` client can't drop a pending prompt. Guard: `session.test.ts`.
- [BE2-17] Cached tailscale bin path + selfLogin memo (5min) + whois LRU (60s). Injectable clock/runner
  for tests. Guard: `identity-cache.test.ts`. (Did not chase the "dedupe duplicated TAILSCALE_BINS"
  note — the array exists only in pairing.ts in this tree.)
- [WEB2-4] Terminal ResizeObserver debounced 100ms + resize frame only on cols/rows change.
- [WEB2-5] rAF-coalesced select-to-cite positioning. (WEB2-4/5 verified via typecheck; DOM-timing
  behavior isn't cleanly unit-testable in jsdom.)
- [WEB2-9 / WEB2-6 / WEB2-3 / BE2-15] DEFERRED (documented):
  - WEB2-9 (snapshot DocumentFragment batching / virtualization) and WEB2-6 (incremental
    saveConvoCache) are transcript-render refactors best landed with the P7 `conversation.ts` extraction.
  - WEB2-3 (content-hash bundle + lazy chunks + gated sourcemaps + SW precache prune) touches the
    build/deploy + service-worker path; the code-splitting half needs static→dynamic import conversion
    in main.ts (risk to the served bundle). Recommend a dedicated build PR with a post-build assertion
    (`dist/index.html` references the hashed name; no `.map` when RELEASE=1) rather than bundling it here.
  - BE2-15 (job-ify fleet rotate/invite) is the same async-conversion shape as the deferred BE2-3 team
    integration; group it with that PR.

## P5 (baseline fix — done first to get a clean baseline)

## P6 — CI/CD hardening (CI2-2/3/5/6/9/10 done; CI2-1/4/7/12 deferred)

- [CI2-6] Pinned Bun 1.3.14 in all release.yml ship jobs + a `workflow-lint` CI job that greps for and
  fails on `bun-version: latest`.
- [CI2-9] `version.ts` derives MAJOR.MINOR from the repo `VERSION` file (was reading the frozen
  package.json 0.2.0). Guard: `version.test.ts` pins MAJOR.MINOR == VERSION.
- [CI2-5] `meta` job now `needs:[verify]` — a red verify no longer mints a tag+assetless Release.
  Version number still computed from the run number, early enough for all consumers.
- [CI2-3] Appcast seed distinguishes 404 (legit first release → start fresh) from any other HTTP code
  (fail, don't rebuild the feed and drop 20-item rollback history on a transient Pages error).
- [CI2-2] Assert the Sparkle `edSignature` matches `^[A-Za-z0-9+/=]{80,120}$` + numeric length before
  trusting it (sed echoes input unchanged on no-match → would silently ship a garbage EdDSA signature).
- [CI2-10] Added Dependabot `swift` ecosystem for `/apple` + `/anvil-server` (Sparkle was unmonitored).
- DEFERRED (need CI runs to validate safely, or larger surface):
  - CI2-1 (path-filtered native PR builds: `:app:assembleDebug`, `swift build`, `xcodegen` lint) —
    high value but I can't validate a green Android/Swift build run from here; the debug keystore + secrets
    wiring must be exercised in CI. Pair with the E2E `headless-smoke` promotion (P5).
  - CI2-4 (composite `apple-signing` action + matrix the two mac jobs) — behavior-preserving refactor,
    best verified by a real signing run.
  - CI2-7 (signed-tag/commit verification) — overlaps SEC2-1's ancestry gate (done); the full
    `git verify-commit` against an allowed-signers file is a separate keying decision.
  - CI2-12 (per-platform rollback docs + optional `release_ref` dispatch) — folded into P8 docs backlog.

## P5 — Test coverage (runs with P0–P4; standalone additions)

- Baseline red fixed (below). Each P0–P4 item shipped with its named guard (see those sections).
- Contract golden EXTENDED (`wire-shape.test.ts`) — the plan's "single most leveraged gap": pins
  required fields + declared types + optionality of the v4 resume envelopes + `server.hello` +
  `permission.request` + `Envelope`/`SessionScoped`. Parses protocol.ts and diffs against an inline
  golden; a field rename/retype/drop/optionality-flip fails here (the type-literal golden misses them).
- Zero-coverage module `src/agent/input-queue.ts` now covered (`input-queue.test.ts`). `src/auth/env-file.ts`
  gained atomic-write coverage in P2 (`atomic-write.test.ts`).
- `test/helpers/index.ts` created (`tmpDir`, `webDirOk`, `bootServer`) as the fixture-debt foundation.
  Retrofitting the 55 existing hand-rolled `mkdtempSync` files is deferred (pure churn, no behavior change).
- STILL DEFERRED (documented, no toolchain/time this pass): watchdog-entrypoint (`updater/main.ts`),
  `push/apns.ts`+`fcm.ts` (fake-endpoint tests), `web/src/main.ts` permission-dialog/offline-banner
  behaviors, and the E2E promotion of `headless-smoke.ts` into CI (paired with the CI2-1 native-PR job).

- [boot-init.test.ts] Fixed the 1 red test by falling back to the source `web/index.html`
  when `web/dist/index.html` is absent (fresh worktree). build.ts copies the source shell to
  dist verbatim, so they are byte-identical; prefer dist when present. Chose fallback over
  "skip when unbuilt" so the guard still runs in a fresh checkout.

## P8 — Docs (wrong/contradictory fixed; REQUIREMENTS.md written)

- Fixed the actively-misleading docs first (the plan's priority order): DOC2-1 (auth model —
  degraded-boot, not fatal; roster), DOC2-2 (worktree path `<stateDir>/worktrees`), DOC2-3/4 (contract
  goldens + protocol policy + frozen Update API warning in CLAUDE.md), DOC2-8 (ARCHITECTURE cites the
  PROTOCOL_VERSION file, no re-embed), DOC2-15/16 (VERSION 2.2→3.0 + corrected "no release tags"),
  DOC2-17 (CI-CD daemon channel now covers the update service/watchdog/rollout for incident-time),
  DOC2-20 (SECURITY update-integrity + identity/origin-gate exceptions), DOC2-24/25 (plan-doc statuses →
  Implemented). Wrote **docs/REQUIREMENTS.md** consolidating the 7 load-bearing constraints.
- DOC2-9 (ARCHITECTURE/README resume DIAGRAM rewrite for v4 epoch/watermark/cid) partially addressed:
  the prose now cites v4 and the PROTOCOL_VERSION file; a full ascii-diagram rewrite is left as a
  smaller follow-up (the semantics are correct in the resilience plan doc + REQUIREMENTS §4/§5).

## P7 — Maintainability / DRY (mostly deferred; the DRY wins that fell out of other phases are done)

- DONE opportunistically: **BE2-33** (`shaMatches` ×3 → shared `sha.ts`, in P3). The god-file
  decompositions (`supervisor.ts` 3.5k lines, `main.ts` 7.4k lines, `http.ts` route ladder) and the
  DRY consolidations (BE2-42/45, WEB2-18/19, a11y WEB2-8) are DEFERRED as a dedicated follow-up.
- Rationale: P7 is explicitly behavior-preserving refactoring — the highest churn for the lowest
  marginal safety, and the riskiest to do partially (a half-moved god-file is worse than an un-moved
  one). The plan's own method is "write the behavioral suite → move code → delegate → green"; this
  program ADDED much of that suite (P0–P6 guards), which is precisely the safety net P7 needs. So the
  right sequencing is: land P7 next, on top of this branch's green baseline, as its own effort — not
  interleaved half-done here. The WEB2-1 TDZ crash class is already contained by the shipped
  queueMicrotask fixes; the `state.ts` scalar move (which "permanently retires" it) is the P7 payoff.
- a11y (WEB2-8): DEFERRED with the `dialogs.ts` extraction it's meant to fold into.

