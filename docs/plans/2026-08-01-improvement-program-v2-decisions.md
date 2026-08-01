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

## P5 (baseline fix — done first to get a clean baseline)

- [boot-init.test.ts] Fixed the 1 red test by falling back to the source `web/index.html`
  when `web/dist/index.html` is absent (fresh worktree). build.ts copies the source shell to
  dist verbatim, so they are byte-identical; prefer dist when present. Chose fallback over
  "skip when unbuilt" so the guard still runs in a fresh checkout. Now 742 pass, 1 skip, 0 fail.

