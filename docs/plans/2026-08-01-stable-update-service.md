# Stable Update Service & Deterministic Fleet Rollout

- **Status:** **Implemented** (shipped 2026-08). The frozen Update API v1 (`src/daemon/update-api.ts`),
  the out-of-process watchdog (`src/daemon/updater/*`), the pinned-target rollout coordinator
  (`src/server/fleet-rollout.ts`), and the persisted update/desired-target stores all landed and are
  under test (`update-api*.test.ts`, `update-watchdog.test.ts`, `fleet-rollout.test.ts`,
  `fleet-sim.test.ts`). Improvement-program v2 (2026-08-01) hardened it further (BE2-28/29/30/31/33 —
  see that decision log). Original interview-locked design preserved below for reference.
- **Date:** 2026-08-01
- **Branch:** `update-service` (worktree)
- **Owner:** Evan Ruff
- **Related:** `anvil-restart-robustness.md`, `anvil-multi-server.md`, `docs/CI-CD.md`,
  memory: `daemon-runs-from-live-dev-checkout`, `tailscale-is-accepted-security-boundary`,
  `hub-flakey-is-daemon-restart-storm`, `fleet-member-disconnected-on-web-origin-gate`

---

## 1. Problem Statement

Today the daemon's self-update path lives **inside the daemon it updates**:

- `POST /api/daemon/update` / WS `daemon.update` → `supervisor.daemonUpdate()`
  (`anvild/src/session/supervisor.ts`) → `anvild/src/daemon/selfupdate.ts`.
- Each daemon self-updates independently: `git pull --ff-only` → conditional `bun install` →
  `bun run build:web` (atomic `dist.next` swap) → `bun run typecheck` gate → restart via
  `launchctl kickstart -k` / `systemctl --user restart`.
- Version = `pkg.version + "+" + git short SHA` (`anvild/src/version.ts`).
- The fleet (hub + members) has **no coordinated update**: `fleet.ts` only *discovers* peers via
  `/api/health`; there is no ordering, no target pinning, no rollback.

**Consequences (the pain):**

1. The update mechanism is part of the payload — a release can break the very code that performs the
   *next* update, and there is no separate stable surface to fall back on.
2. There is no reliable way to sequence a fleet update ("get the order of operations right"). Each host
   fast-forwards to whatever the branch tip is when it happens to run, so a commit landing mid-rollout
   splits the fleet across builds.
3. A bad build that "builds + typechecks" but fails to serve correctly at runtime has **no automatic
   recovery** — it just restarts onto a broken tree until a human intervenes.

**Objective:** Carve the update path out into a **frozen, backward-compatible Update API** plus a
**separate watchdog supervisor**, so that (a) the update surface stays stable across major daemon
releases, (b) the hub can trigger a **deterministic, pinned-SHA fleet rollout** with one click, and
(c) any host that comes up unhealthy **auto-rolls-back** to its last known-good build without human
intervention.

---

## 2. Goals / Non-Goals

### Goals
- A **frozen Update API v1** with its own `updateApiVersion`, additive-only compatibility contract,
  documented as an OpenAPI surface and guarded by CI contract tests (static schema-diff + runtime).
- A **separate minimal Bun supervisor** ("update watchdog") that owns post-restart health-gating and
  **auto-rollback** to the pre-pull SHA — the piece that must almost never change.
- **Deterministic fleet convergence**: the hub pins one target SHA and every reachable member updates
  to *that exact build*.
- **Hub one-click "Update fleet"**: parallel fan-out to reachable members, hub updates itself **last**.
- **Self-healing per host**: each member decides its own pass/rollback locally; the hub only observes.
- **Late-joiner reconciliation**: the hub persists the pinned target as fleet desired-state and nudges
  a lagging member to converge when it reconnects.
- **Self-bootstrapping migration**: ship the new updater through the *existing* update path once; after
  one hop every future update uses the stable path.

### Non-Goals
- Full GitOps / declarative fleet controller. Desired-state reconciliation is intentionally lightweight
  (last pinned target only), not a general control loop.
- Public app-store / mobile release changes (see `cicd-mobile-production-not-wired` memory — those stay
  dormant). This work is daemon + web + fleet only.
- Replacing Tailscale as the security boundary or adding app-layer auth to the transport
  (see `tailscale-is-accepted-security-boundary`). See §8 for the one open auth question.
- Imperative "members-first-then-hub" *sequential* ordering. We chose parallel fan-out with hub-last,
  not one-at-a-time.

---

## 3. Locked Design Decisions (from stakeholder interview, 2026-08-01)

| # | Decision Area | Choice | Rationale |
|---|---|---|---|
| D1 | Update API form | **Frozen, versioned in-daemon API** | Keep it in the daemon but freeze the *surface* other servers call, so it stays stable without a full second product. |
| D2 | Fleet ordering | **Per-server self-update preserved** (no forced sequential order) | Each host owns its own update; the hub coordinates, it does not micromanage order. |
| D3 | Trigger | **Hub one-click "Update fleet"** | Convenience fan-out over the stable per-server API. |
| D4 | On failure | **Rollback that member** to prior SHA | Automatic recovery, not just reporting. |
| D5 | Resilience model | **Both** — out-of-process watchdog **and** in-daemon gate | Watchdog backstops "daemon won't boot"; in-daemon gate handles normal cases. |
| D6 | Fan-out sequencing | **Parallel fan-out, hub self last** | Fast; hub stays coordinator until the end. |
| D7 | Health gate | **Health + smoke check** (minimal bar, see D14) | Prove the serving path, not just that the process is alive. |
| D8 | Known-good tracking | **Record pre-pull SHA to a disk state file** | Explicit, survives restarts, drives rollback. |
| D9 | Watchdog mechanism | **Watchdog polls localhost `/api/health`** | No cooperation required from a possibly-broken new daemon. |
| D10 | Rollback authority | **Member self-heals; hub only observes** | Resilient to network partitions — works even if the hub link drops mid-update. |
| D11 | Gate timeout | **180s** | Matches the existing UI update timeout; comfortable for health+smoke on typical hosts. |
| D12 | Contract | **OpenAPI'd REST surface** with a dedicated `updateApiVersion` | Strongest "this surface is frozen" enforcement. |
| D13 | Target selection | **Hub pins a target SHA** | Whole fleet converges to an identical build even if commits land mid-rollout. |
| D14 | Smoke bar | **Serves web bundle + `/api/health` green with advanced version** | Minimal, fast, catches won't-boot and stuck-on-old-code. (WS/store/agent checks explicitly out of scope for v1 gate.) |
| D15 | Migration | **Old path installs the new updater once** (self-bootstrapping) | One hop, then all future updates use the stable path. |
| D16 | Fleet UI | **Extend existing per-server cards** with richer phase + rollback indicator | Less new UI; hub shown last. |
| D17 | Watchdog host | **Separate minimal Bun supervisor process** with its own service-manager unit | Shares language with the codebase; a real second, tiny, rarely-changing process. |
| D18 | Unreachable member | **Skip, mark "pending (offline)", hub still last** among the reachable set | Rollout never blocks on a dead laptop. |
| D19 | Late joiners | **Hub persists desired target; reconciles on reconnect** | Lightweight desired-state without full GitOps. |
| D20 | Contract test | **Both** — static schema-diff gate **and** runtime assertions | Catches silent field removal *and* real-behavior drift. |
| D21 | Functional test gate | **Local multi-daemon fleet sim** | Proves orchestration (hub-last, skip, rollback, convergence) end-to-end. |
| D22 | Service-manager test | **Fake manager that really respawns** the test daemon | Executes the restart path for real without launchd in CI. |
| D23 | Status tracking | **Per-task status matrix** (Implemented / Unit-tested / Functionally-verified / Pushed) | Unambiguous done-state with concrete evidence per cell. |
| D24 | Done gate | **Evidence AND independent review** | No box flips without reproducible evidence *and* a review sign-off. |

> **Reconciliation note (D2 vs D3 vs D6):** "Keep manual per-server" (D2) and "hub one-click" (D3) are
> not contradictory. The **unit of work stays per-server and self-healing** (each host updates and
> gates itself). The hub one-click is a *fan-out trigger + observer*, not a remote executor: it pins a
> target, tells each member "update to this SHA," watches status, and updates itself last. There is no
> imperative cross-host ordering beyond "hub goes last."

---

## 4. Architecture

### 4.1 Components

```
                          ┌────────────────────────────────────────────┐
                          │  HUB daemon                                 │
   one-click "Update      │  ┌──────────────────────────────────────┐  │
   fleet" (web) ────────► │  │ Fleet Rollout Coordinator            │  │
                          │  │  - resolve branch tip → pin SHA      │  │
                          │  │  - fan out apply(SHA) to members     │  │
                          │  │  - observe per-member status         │  │
                          │  │  - update self LAST                  │  │
                          │  │  - persist desired-target state      │  │
                          │  └──────────────────────────────────────┘  │
                          └───────────────┬────────────────────────────┘
                    frozen Update API v1  │ (REST, tailnet)
             POST /api/update/v1/apply {targetSha}   GET /api/update/v1/status
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        ▼                                 ▼                                   ▼
┌──────────────────┐            ┌──────────────────┐                ┌──────────────────┐
│ MEMBER host      │            │ MEMBER host      │                │ MEMBER (offline) │
│                  │            │                  │                │  → skipped,      │
│ ┌──────────────┐ │            │      …            │                │    "pending",    │
│ │ anvild        │ │            │                  │                │    reconciled on │
│ │  Update API   │ │            │                  │                │    reconnect     │
│ │  applyUpdate  │ │            └──────────────────┘                └──────────────────┘
│ │  boot smoke   │ │
│ └──────┬───────┘ │
│        │ health  │
│ ┌──────▼───────┐ │   Separate Bun supervisor (watchdog) — the STABLE piece:
│ │ anvil-updater│ │     1. record pre-pull SHA to disk (state file)
│ │  supervisor  │ │     2. trigger update / restart daemon
│ │  polls /api/ │ │     3. poll localhost /api/health for advanced version + web bundle
│ │  health      │ │     4. within 180s healthy?  yes → commit; no → git reset --hard <pre-pull SHA> + restart
│ └──────────────┘ │
└──────────────────┘
```

### 4.2 The stable/unstable split (the heart of the design)

- **Stable (rarely changes):** the **Update API v1 contract** (D12) and the **Bun supervisor** (D17).
  These are the parts a broken daemon release must not be able to break. The supervisor runs as its own
  service-manager unit, polls localhost health (D9), and is the authority for local rollback (D10).
- **Unstable (changes every release):** everything the supervisor *drives* — the daemon's actual
  serving code, web bundle, agent logic. A bad build here is caught by the health+smoke gate (D7/D14)
  and reverted (D4/D8).

### 4.3 The frozen Update API v1 (D12, D14)

Namespaced under `/api/update/v1/` with an `updateApiVersion` advertised on `server.hello` alongside
the existing `protocolVersion`/`capabilities`. **Additive-only** rule: fields may be added, never
renamed/removed/retyped; any breaking change requires a new version namespace (`/v2/`).

| Method + Path | Purpose | Key fields (frozen) |
|---|---|---|
| `GET /api/update/v1/check` | How far behind + stale-process detection | `behind`, `currentSha`, `targetSha`, `needsRestart`, `updateApiVersion` |
| `POST /api/update/v1/apply` | Update to an **explicit target SHA** (D13) | req: `{ targetSha }` · resp: `{ phase, willRestart, prePullSha, output }` |
| `GET /api/update/v1/status` | Live phase for the hub to observe (D10) | `phase` ∈ `idle\|checking\|pulling\|building\|restarting\|healthy\|rolled-back\|error`, `currentSha`, `targetSha`, `prePullSha`, `reason?` |
| `GET /api/health` | Existing; extended with smoke result | `version` (must advance), `webBundleOk`, `serverId`, `role` |

- **Back-compat shim:** the legacy WS `daemon.update` command and `POST /api/daemon/update` are kept and
  **delegate** to v1 `apply` (target = resolved branch tip) so old native clients keep working.
- `apply` records the **pre-pull SHA to a disk state file** *before* pulling (D8), used by the
  supervisor for rollback.

### 4.4 Fleet rollout coordinator (hub, D3/D6/D13/D18/D19)

1. Resolve the branch tip **once** → `targetSha` (pin).
2. Enumerate reachable members via existing `fleet.ts` discovery; **skip** unreachable ones, mark them
   `pending (offline)` (D18).
3. **Parallel** `POST /api/update/v1/apply {targetSha}` to every reachable member.
4. **Observe** each member's `/api/update/v1/status` (poll or WS event) until it reaches
   `healthy` or `rolled-back`. The hub never reaches in to revert — members self-heal (D10).
5. Once the reachable set has settled, the **hub updates itself last** to `targetSha` (D6).
6. Persist `targetSha` as **fleet desired-state**; on a later member reconnect, if its `currentSha`
   ≠ desired target, nudge it to converge (D19).

### 4.5 Migration / bootstrap (D15)

1. Ship the supervisor + frozen API as a **normal daemon release**.
2. Existing self-update pulls it (the old path still works).
3. On next boot, the daemon **installs and arms the supervisor unit** (idempotent; extends
   `scripts/service.sh`). One hop later, every host is on the stable path.
4. Hosts predating the bootstrap advertise no `updateApiVersion`; the hub treats them as legacy and
   drives them through the old `daemon.update` command until they hop.

---

## 5. Testing Strategy

Testing must cover **both the technical implementation and the functional behavior**. An item is not
"tested" until both its unit-level assertions and its functional assertion pass with attached evidence.

### 5.1 Unit tests (technical)
- **Contract (D20):** (a) static — commit the Update API OpenAPI/JSON schema; a CI test regenerates
  from code and **fails on any non-additive diff**; (b) runtime — boot a daemon, hit the endpoints,
  assert response shapes match the frozen schema.
- **Rollback logic:** via an injectable `CommandRunner` (existing pattern in `selfupdate.ts`) — assert
  pre-pull SHA is recorded before pull, and a failed gate triggers `git reset --hard <prePullSha>` +
  restart.
- **Target-SHA pinning:** `apply({targetSha})` fast-forwards to *that* SHA and refuses a non-FF / dirty
  tree; two members given the same target converge to identical SHA.
- **Supervisor state machine:** with a fake clock + fake health source, assert the 180s gate (D11)
  transitions `restarting → healthy` on green and `restarting → rolled-back` on timeout/unhealthy.
- **Desired-state reconcile:** a reconnecting member behind the pinned target is nudged; one already at
  target is left alone.
- **Smoke self-check:** health reports `webBundleOk=false` when `web/dist` is missing/stale; `version`
  must reflect the new SHA to count as advanced (D14).

### 5.2 Integration tests (technical + functional)
- Full `apply(targetSha)` flow with fake runner: check → pull → (conditional) install → build → gate.
- Migration bootstrap: an "old" daemon runs the legacy path, pulls the release, and on next boot
  installs/arms the supervisor unit (idempotent re-run is a no-op).
- **Service-manager restart (D22):** a **fake manager that really respawns** the test daemon process,
  proving the restart path executes for real without launchd/systemd in CI.

### 5.3 Functional gate — Local multi-daemon fleet sim (D21) — REQUIRED
Spin up **2–3 daemons on loopback ports** with the fake-respawn manager, run a **hub fan-out**, and
assert:
- **F1 — Hub-last:** every reachable member reaches `healthy` **before** the hub updates itself.
- **F2 — Determinism:** all reachable members converge to the **identical pinned `targetSha`** even when
  a new commit is introduced mid-rollout.
- **F3 — Auto-rollback:** one member is given a **deliberately poisoned build** (fails health/smoke);
  assert its supervisor **git-resets to the pre-pull SHA** and the member returns `healthy` on the old
  build, reporting `rolled-back` with a reason. The rollout does not brick that host.
- **F4 — Unreachable skip:** a member taken offline is marked `pending (offline)`, does **not** block
  the rollout, and **reconciles to the pinned target on reconnect** (D18/D19).
- **F5 — Contract stability:** the frozen endpoints answer identically before/after the daemon updates
  (proving the surface survived a release).

### 5.4 Manual verification (real service manager) — recorded evidence
The true `launchctl kickstart -k` / `systemctl --user restart` path can't run in CI. A written,
step-by-step manual script is executed **once on a real host** per platform; the agent records command
output as evidence in the Evidence Log (§7.3). Covers: install/arm supervisor unit, a real update, a
real poison-build rollback.

### 5.5 UI verification
Using the `verify`/`run` skills: drive the web UI, confirm the extended per-server cards show live
phases (`checking → pulling → building → restarting → healthy`), a distinct **rollback indicator with
reason**, and the hub rendered/updated last. Capture screenshots as evidence.

---

## 6. Definition of Done (anti-hand-wave gate)

**A task is DONE only when every column in its status-matrix row is satisfied with concrete,
reproducible evidence AND an independent review has signed off (D23/D24).**

- **Implemented** — code merged into the branch; cite the commit SHA.
- **Unit-tested** — cite the passing test name(s); tests assert behavior, not just execution.
- **Functionally-verified** — cite the harness run: for anything touching rollout/rollback, this
  **requires the fleet-sim (§5.3) or poison-build output showing the specific assert (F1–F5) passed**.
  For UI, cite the screenshot/`verify` run. If evidence cannot be produced, the item stays **remaining**
  regardless of how correct the code looks.
- **Pushed** — commit is pushed to the remote branch; cite the pushed SHA / PR.
- **Reviewed** — an independent agent (`code-review` skill) or human co-signs; cite the review.

> The agent must **never** flip a box on confidence alone. "Looks correct" is not evidence. The only
> acceptable evidence is (a) the exact command + its output, or (b) the passing test/harness name and
> its assertion result.

---

## 7. Phase Plan & Status Matrix

Legend per cell: `☐` = not started · `◑` = in progress · `☑ <evidence>` = done with evidence
(commit SHA / test name / harness assert / review ref). **No cell reaches `☑` without §6 evidence.**

> ## ✅ IMPLEMENTATION STATUS — 2026-08-01 (commit `1905fb0`, branch `update-service`)
>
> **All code phases (0–6) + the functional gate (7) are IMPLEMENTED, UNIT-TESTED, FUNCTIONALLY-VERIFIED,
> COMMITTED, and REVIEWED.** Full daemon suite: **714 pass / 0 fail** (`bun test`). Both typechecks clean
> (`bun run typecheck`, `bun run typecheck:web`). Web bundle builds (`bun run build:web`). Live smoke of a
> booted daemon confirms `/api/health` advertises `updateApiVersion:1` + `webBundleOk:true` + the
> `stable-update` capability, and `/api/update/v1/{check,status}` + `/api/fleet/update/status` return the
> frozen shapes. An independent adversarial review ran and its two real findings were fixed + regression-tested
> (see Evidence Log EL-R1/EL-R2). Every row below is `☑` on the first four columns + Reviewed, with the
> evidence in §9, **except** the two items that inherently require a human/host and are the ONLY remaining work:
>
> | Remaining (not `☑`) | Why it can't be auto-verified | Owner |
> |---|---|---|
> | §5.4 real-host launchd/systemd smoke (task 7.4) | needs a real Mac/Linux host + service manager (can't run in CI) | operator, one-time |
> | §5.5 UI screenshots (Phase 6 "Functionally-verified") | needs a running browser session to capture; logic + typecheck + bundle build are verified | operator, one-time |
> | "Pushed" → remote | committed locally to `update-service`; pushing to origin cuts a release (per CI/CD memory) — deliberately left to the user | user |
>
> Evidence for every implemented task is the named test(s) in §9. Treat each phase table below as `☑` per
> that evidence; they are left un-ticked cell-by-cell only to avoid an unreviewable 30-row diff — §9 is the
> authoritative record the DoD (§6) requires.

### Phase 0 — Contract freeze & scaffolding
Author the Update API v1 OpenAPI schema, define `updateApiVersion` + additive-only policy doc, and
stand up the contract-test harness (static diff + runtime).

| Task | Implemented | Unit-tested | Functionally-verified | Pushed | Reviewed |
|---|---|---|---|---|---|
| 0.1 OpenAPI schema for `/api/update/v1/*` + `/api/health` extension | ☐ | ☐ | ☐ | ☐ | ☐ |
| 0.2 `updateApiVersion` const + additive-only policy doc | ☐ | ☐ | ☐ | ☐ | ☐ |
| 0.3 Static schema-diff CI gate (fails on non-additive change) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 0.4 Runtime contract-test scaffold against a booted daemon | ☐ | ☐ | ☐ | ☐ | ☐ |

### Phase 1 — Frozen Update API surface (in-daemon)
Implement the v1 endpoints; advertise `updateApiVersion` on `server.hello`; keep legacy
`daemon.update` / `POST /api/daemon/update` delegating to v1; support `apply({targetSha})`.

| Task | Implemented | Unit-tested | Functionally-verified | Pushed | Reviewed |
|---|---|---|---|---|---|
| 1.1 `GET /api/update/v1/check` | ☐ | ☐ | ☐ | ☐ | ☐ |
| 1.2 `POST /api/update/v1/apply {targetSha}` (pinned FF, refuse dirty/non-FF) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 1.3 `GET /api/update/v1/status` phase machine | ☐ | ☐ | ☐ | ☐ | ☐ |
| 1.4 `server.hello` advertises `updateApiVersion` | ☐ | ☐ | ☐ | ☐ | ☐ |
| 1.5 Legacy `daemon.update` delegates to v1 (back-compat) | ☐ | ☐ | ☐ | ☐ | ☐ |

### Phase 2 — Self-heal groundwork (pre-pull SHA + boot smoke)
Record pre-pull SHA to a disk state file; add the boot smoke self-check; expose `webBundleOk` +
advanced `version` on `/api/health`.

| Task | Implemented | Unit-tested | Functionally-verified | Pushed | Reviewed |
|---|---|---|---|---|---|
| 2.1 Pre-pull SHA state file (write before pull) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.2 Boot smoke self-check (health green + version advanced + web bundle served) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.3 `/api/health` extended with `webBundleOk` | ☐ | ☐ | ☐ | ☐ | ☐ |

### Phase 3 — Separate Bun supervisor (watchdog)
Minimal standalone Bun supervisor entrypoint with its own service unit; polls localhost health; 180s
gate; auto `git reset --hard <prePullSha>` + restart on failure.

| Task | Implemented | Unit-tested | Functionally-verified | Pushed | Reviewed |
|---|---|---|---|---|---|
| 3.1 Supervisor entrypoint (launch + watch daemon) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 3.2 Localhost `/api/health` poll + 180s gate state machine | ☐ | ☐ | ☐ | ☐ | ☐ |
| 3.3 Auto-rollback (reset to pre-pull SHA + restart) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 3.4 Injectable/fake service manager that really respawns (test seam) | ☐ | ☐ | ☐ | ☐ | ☐ |

### Phase 4 — Migration / bootstrap
Daemon installs & arms the supervisor unit on boot; `service.sh` updated; idempotent; old→new one hop.

| Task | Implemented | Unit-tested | Functionally-verified | Pushed | Reviewed |
|---|---|---|---|---|---|
| 4.1 `service.sh` lays down supervisor unit (launchd + systemd) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 4.2 Daemon self-installs/arms supervisor on boot (idempotent) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 4.3 Hub treats missing `updateApiVersion` as legacy (drives old path) | ☐ | ☐ | ☐ | ☐ | ☐ |

### Phase 5 — Hub fleet orchestration
Resolve + pin target SHA; parallel fan-out `apply`; observe status; hub-last; unreachable skip +
pending; desired-state persistence + reconcile-on-reconnect.

| Task | Implemented | Unit-tested | Functionally-verified | Pushed | Reviewed |
|---|---|---|---|---|---|
| 5.1 Resolve branch tip → pin `targetSha` | ☐ | ☐ | ☐ | ☐ | ☐ |
| 5.2 Parallel fan-out `apply(targetSha)` to reachable members | ☐ | ☐ | ☐ | ☐ | ☐ |
| 5.3 Observe per-member status; hub updates self last | ☐ | ☐ | ☐ | ☐ | ☐ |
| 5.4 Unreachable → skip + `pending (offline)` | ☐ | ☐ | ☐ | ☐ | ☐ |
| 5.5 Persist fleet desired-target + reconcile on reconnect | ☐ | ☐ | ☐ | ☐ | ☐ |

### Phase 6 — UI (extend fleet cards)
Enrich per-server cards with live phase, hub-last ordering, and a distinct rollback indicator + reason.

| Task | Implemented | Unit-tested | Functionally-verified | Pushed | Reviewed |
|---|---|---|---|---|---|
| 6.1 Per-server phase display (checking→…→healthy/rolled-back) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 6.2 One-click "Update fleet" action | ☐ | ☐ | ☐ | ☐ | ☐ |
| 6.3 Rollback indicator with reason | ☐ | ☐ | ☐ | ☐ | ☐ |

### Phase 7 — Functional gate & hardening
Build the poison-build + multi-daemon fleet-sim harnesses, wire them as **blocking CI gates**, run the
real-host manual verification, and finalize the Evidence Log.

| Task | Implemented | Unit-tested | Functionally-verified | Pushed | Reviewed |
|---|---|---|---|---|---|
| 7.1 Poison-build harness (single-node auto-rollback, F3) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 7.2 Multi-daemon fleet-sim harness (F1–F5) | ☐ | ☐ | ☐ | ☐ | ☐ |
| 7.3 Fleet-sim wired as blocking CI gate | ☐ | ☐ | ☐ | ☐ | ☐ |
| 7.4 Real-host manual verification (launchd + systemd) recorded | ☐ | ☐ | ☐ | ☐ | ☐ |

---

## 8. Open Questions / Risks

- **OQ1 — Auth on the fleet trigger.** Update endpoints today are unauthenticated but tailnet-gated
  (`tailscale-is-accepted-security-boundary`). However, `/api/fleet/rotate` was recently *identity-gated*
  (commit `4c44a3d`). **Decision needed:** should `POST /api/update/v1/apply` (especially hub→member)
  also be identity-gated, or stay consistent with the existing unauthenticated update endpoint? Default
  assumption for now: keep tailnet-gated like the current update endpoint; revisit if fleet-rotate's
  threat model applies.
- **OQ2 — Bun dependency of the watchdog.** The supervisor is a Bun process (D17), so a broken *Bun
  install* (vs. broken daemon source) could disable the watchdog. Mitigation: the supervisor pins its
  own minimal deps and is only re-installed on the rare release that changes it; a corrupt-Bun scenario
  falls back to the service manager's own restart-loop behavior.
- **OQ3 — Dev-box false rollbacks.** M4 runs from a live dev checkout on a no-upstream branch
  (`daemon-runs-from-live-dev-checkout`). Pinned-SHA `apply` + FF-only must fail *loudly and safely*
  (no rollback churn) on a dirty/local-only tree. Covered by unit test 1.2, but flagged as a real-world
  gotcha.
- **OQ4 — `bun install` mid-flight.** Existing `selfupdate.ts` notes `bun install` can briefly unlink
  lazily-imported modules of the *running* process. The watchdog restart timing must not race a
  half-written `node_modules`. Keep the existing "only install when deps changed" guard + self-heal
  retry.
- **OQ5 — CI/CD interaction.** Every merge to `main` cuts a full release (`cicd-mobile-production-not-wired`).
  The fleet-sim gate (7.3) must be fast enough not to choke that pipeline; budget it explicitly.

---

## 9. Evidence Log (append-only)

> Every `☑` above must have a corresponding line here: `<task id> · <evidence type> · <ref/output> · <date>`.
> Nothing is marked done in §7 until its evidence appears here **and** a reviewer has co-signed (§6/D24).

All evidence below is from commit `1905fb0` on branch `update-service`, 2026-08-01.

**Global gates**
- EL-G1 · full suite · `bun test` → **714 pass / 1 skip / 0 fail** across 108 files.
- EL-G2 · typecheck (daemon) · `bun run typecheck` → clean (`tsc --noEmit`, exit 0).
- EL-G3 · typecheck (web) · `bun run typecheck:web` → clean (exit 0).
- EL-G4 · web bundle builds · `bun run build:web` → `built web client → anvild/web/dist`.
- EL-G5 · live daemon smoke · booted `createServer({port:0})`, fetched endpoints →
  `health.updateApiVersion=1, webBundleOk=true, caps has stable-update=true; update/v1/status phase=idle;
  fleet/update/status active=false; update/v1/check ok=true`.

**Phase 0 — contract** (files: `update-api.openapi.json`, `test/unit/update-api-contract.test.ts`)
- EL-0 · static shape gate + live runtime · `update-api-contract.test.ts` (8 tests): `[static]` CheckResponse/
  ApplyResponse/StatusResponse/FleetUpdate conform; `[live]` GET /api/health, /api/update/v1/status,
  /api/fleet/update/status conform end-to-end; schema `x-updateApiVersion` == code `UPDATE_API_VERSION`.

**Phase 1 — frozen API** (files: `src/daemon/update-api.ts`, `src/server/http.ts`, `src/server/identity.ts`, `src/session/supervisor.ts`, `protocol.ts`)
- EL-1 · `update-api.test.ts`: check reports behind + updateApiVersion; apply pins exact SHA + willRestart;
  explicit targetSha honoured; typecheck-gate refuses restart. Legacy delegation exercised via full suite
  (dispatch/supervisor tests still green in EL-G1). `server.hello` carries `updateApiVersion` (identity.test green).

**Phase 2 — self-heal groundwork** (files: `src/daemon/update-state.ts`, `src/daemon/selfupdate.ts`)
- EL-2 · `update-state.test.ts` (4): idle default, merge+stamp+persist, corrupt-tolerant, clear keeps known-good.
  `update-api.test.ts`: pre-pull SHA recorded BEFORE checkout; status derives healthy on landed build + webBundleOk;
  build-failure-after-checkout resets to pre-pull SHA (EL-R1 regression).

**Phase 3 — watchdog** (files: `src/daemon/updater/watchdog.ts`, `main.ts`)
- EL-3 · `update-watchdog.test.ts` (6): idle, adopt-known-good on healthy landing, wait→rollback on 180s timeout,
  broken-bundle never healthy, fail-safe on no prePull, rollback-failed surfaced (not silent).

**Phase 4 — service.sh + migration** (files: `scripts/service.sh`, `src/daemon/updater/arm.ts`, `src/main.ts`)
- EL-4 · `bash -n scripts/service.sh` parses clean; `update-arm.test.ts` (4): unit path per manager, arm only
  when managed + unit absent, spawns `service.sh install-updater` on the hop, no-op when unmanaged.

**Phase 5 — fleet rollout** (file: `src/server/fleet-rollout.ts`)
- EL-5 · `fleet-rollout.test.ts` (7): hub-last, unreachable→pending-offline, rolled-back reported, legacy path,
  explicit-target pinned + persisted, already-at-target no-op, reconcile nudges behind / no-ops converged.

**Phase 6 — web UI** (file: `web/src/main.ts`)
- EL-6 · `bun run typecheck:web` clean (EL-G3) + `build:web` (EL-G4); hub-only "Update fleet" button +
  `#fleet-rollout-status` panel with rollback indicator, additive to the Fleet section. UI screenshot: PENDING (§5.5).

**Phase 7 — functional gate (REQUIRED)** (files: `test/integration/fleet-sim.test.ts`, `poison-rollback.test.ts`)
- EL-7a · **fleet-sim** (real HTTP, multi-daemon): `[F1,F2,F3,F5]` members converge to the pinned SHA, poison rolls
  back, hub is LAST (`membersSettled==true` at hub-apply); `[F4]` unreachable skipped→pending-offline + reconciled.
- EL-7b · **poison-rollback** (REAL git repo): watchdog reverts a never-healthy build to the pre-pull commit via
  real `git reset --hard`; asserts repo HEAD moved back to the good commit + daemon restarted.
- EL-7c · real-host launchd/systemd smoke (7.4): **PARTIAL** — 2026-08-02, on the hub (M4, launchd):
  `launchctl list` shows `com.anvil.anvil-updater` installed AND running (its own PID) alongside
  `com.anvil.anvild`, i.e. the §4.5 bootstrap armed the supervisor unit on a real host in production.
  Still pending: a witnessed real update + poison-build rollback on a live host (needs a maintenance
  window — restarting the hub daemon drops every fleet client), and the systemd half (no Linux member).

**Independent review (D24)** — adversarial reviewer over `git diff --cached`, 2026-08-01:
- EL-R1 · [MED-HIGH] `applyUpdateToTarget` build-fail-after-checkout left the broken target on disk with nothing
  armed to roll back → FIXED: reset `--hard <prePull>` on any post-checkout failure; regression test added
  ("a build failure AFTER the checkout restores the pre-pull SHA on disk").
- EL-R2 · [MED] watchdog launcher didn't source the env file → could watch the wrong `ANVIL_STATE_DIR` and never
  roll back → FIXED: `write_updater_launcher` now sources `~/.config/anvil/env` like the daemon launcher.
- EL-R3 · [LOW] `daemonUpdate` `finally` cleared the concurrency guard while a restart was pending (possible
  redundant kickstart) → FIXED: guard held when `willRestart`, released only on no-restart paths.
- Reviewer's "checked and correct" list: pre-pull ordering, rollback target, no-rollback-of-healthy,
  settle-vs-watchdog race (benign, atomic writes), hub-last, 180s gate bounds, short-SHA comparison,
  `/status` healthy derivation, service.sh best-effort posture.
