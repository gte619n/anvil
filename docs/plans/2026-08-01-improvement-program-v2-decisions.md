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

## P5 (baseline fix — done first to get a clean baseline)

- [boot-init.test.ts] Fixed the 1 red test by falling back to the source `web/index.html`
  when `web/dist/index.html` is absent (fresh worktree). build.ts copies the source shell to
  dist verbatim, so they are byte-identical; prefer dist when present. Chose fallback over
  "skip when unbuilt" so the guard still runs in a fresh checkout. Now 742 pass, 1 skip, 0 fail.

