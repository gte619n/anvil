# Improvement Program v2 — Decision Log

Running log of decisions made during autonomous implementation of
`2026-08-01-improvement-program-v2.md`. Reviewed after implementation.

Baseline at start: `bun test` → 741 pass, 1 skip, 1 fail (the known
`boot-init.test.ts` red — reads absent `web/dist/index.html`). HEAD `2059142`.

Format: `[TAG] decision — rationale`.

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

- [boot-init.test.ts] Fixed the 1 red test by falling back to the source `web/index.html`
  when `web/dist/index.html` is absent (fresh worktree). build.ts copies the source shell to
  dist verbatim, so they are byte-identical; prefer dist when present. Chose fallback over
  "skip when unbuilt" so the guard still runs in a fresh checkout. Now 742 pass, 1 skip, 0 fail.

