# Anvil Improvement Program — Test-First Implementation Plan

**Status:** Proposed (2026-07-04). Branch `refactoring`.
**Method:** Test-first. Every change lands as *failing test → implementation → green*. No behavior
change ships without a test that would have caught the regression it prevents.

This plan is derived from a seven-track audit (backend architecture, web frontend, security, test
coverage, CI/CD, docs/CLAUDE.md, native clients). Findings are cited inline as tags like
`[SEC-H1]`, `[BE-3]`, `[WEB-2]`, `[CI-G1]`, `[NAT-2]`, `[DOC-1]`.

---

## 0. Why this order

Two facts set the sequencing:

1. **There is no CI gate.** No workflow triggers on `pull_request`; nothing runs `bun test`,
   `tsc --noEmit`, `typecheck:web`, or `build:web` before merge. 46 test files and the typecheck
   scripts in `anvild/package.json` exist but **CI never invokes them**. A PR that fails every test
   merges green and auto-ships to Play/TestFlight/Firebase. *A test-first program is meaningless
   until the tests actually gate merges* — so **Phase 0 is the CI gate**, and it is a hard
   prerequisite for the rest.

2. **Tailscale is the accepted network security boundary** (confirmed by the owner, 2026-07-04). The
   daemon's lack of per-request auth on `/api/*` and `/ws` is **by design** — the tailnet + its ACLs
   are the perimeter, and every device that can reach the daemon is trusted at the network layer.
   Audit findings **SEC-H1 (add app-layer auth)** and **SEC-H2 (default tailnet binding)** are
   therefore **out of scope**, as is intra-tailnet peer-auth hardening (SEC-M3). Phase 1 keeps only
   the security work that is *orthogonal to the network perimeter*: agent code-execution limits,
   browser-origin defense (a malicious site in a trusted device's browser can still reach the
   daemon), local filesystem containment, local file permissions, and content XSS.

Everything else (correctness, performance, decomposition, frontend, native, docs) layers on top of a
green, gated baseline.

---

## Phase 0 — Test & CI foundation  *(prerequisite; ~1–2 days)*

**Goal:** every PR is gated by typecheck + web-typecheck + web-build + full test suite; the test
harness exists for all tiers (backend, frontend, native, contract) even where suites start near-empty.

### 0.1 PR gate `[CI-G1..G3]`
- Add `.github/workflows/ci.yml`, trigger `pull_request` + `push` to `main`:
  - `bun install --frozen-lockfile`
  - `bun run typecheck` (daemon) and `bun run typecheck:web` (separate tsconfig — the daemon
    typecheck does **not** cover `web/`)
  - `bun run build:web` (catches bundle breakage before it reaches self-update)
  - `bun test`
- Make the `release.yml` ship jobs `needs:` a green CI job (or gate the `release-*` tag on a green
  `main`). `[CI-S1]`
- Enable caching for `~/.bun` and Gradle; pin `bun-version` (drop `latest`). `[CI-G6, CI-R5]`

### 0.2 Supply-chain / scanning `[CI-G5]`
- `.github/dependabot.yml` (bun + gradle + github-actions ecosystems).
- CodeQL workflow (JS/TS + Swift + Kotlin where supported).
- Enable GitHub secret scanning + push protection (repo setting; document in SECURITY.md).

### 0.3 Test harness scaffolding (so later phases have somewhere to write tests)
- **Backend:** already on `bun test` — no new harness, but add a `test/helpers/` for the reused
  tmpdir/git/WS fixtures currently copy-pasted across tests.
- **Frontend:** stand up `bun test` + a DOM environment (happy-dom or jsdom) for `web/src/*`. First
  target the pure-logic modules (`ws.ts`, `state.ts`, `api.ts`, `overlays.ts`).
- **UI/E2E:** promote `test/tools/headless-smoke.ts` into an automated Playwright (or headless-Chrome)
  smoke that boots the app against a stub daemon and asserts first paint + WS connect. `[TEST-3]`
- **Native:** add a SwiftPM `testTarget` to both `apple/` and `anvil-server/`, and an
  `androidTest`/`test` source set to `app/` — even if each starts with one trivial test, so the CI
  wiring and the pattern exist. `[TEST-6]`
- **Contract:** create `test/contract/` with a versioned golden fixture of the protocol envelopes
  (source of truth: `docs/plans/anvil-protocol.ts`); one test asserts the daemon's emitted event
  shapes match the golden. This is the guard against silent drift between the daemon and its three
  clients. `[TEST-7]`

**Exit criteria:** a red test blocks merge; all four harnesses run in CI; coverage baseline reported.

---

## Phase 1 — Security hardening (perimeter-orthogonal)  *(with tests first; ~2–4 days)*

**Scope note:** Tailscale is the accepted network boundary (§0.2), so app-layer request auth
(SEC-H1), default-binding (SEC-H2), and intra-tailnet peer-auth (SEC-M3) are **out of scope**. What
remains is everything an attacker could do *without* breaching the tailnet: get the autonomous agent
to run destructive/untrusted code, trick a trusted device's *browser* into driving the daemon, write
outside the intended directory, or inject content. Write the attack as a failing test first.

| Tag | Fix | Guard test (write first) |
|---|---|---|
| `[SEC-H4]` | Wire the danger-list (`PreToolUse`/`canUseTool`) into `runAgentQuery` (`agent/query.ts`) for the autonomous pipeline, especially `readonly:false` phases; OS-sandbox the pipeline subprocess; treat GLM as untrusted execution. **Highest value** — the autonomous pipeline runs a third-party model with Write/Edit/Bash and no danger gate. | Unit: a dangerous command in a pipeline write phase is intercepted; integration: pipeline denies `rm -rf`. |
| `[SEC-H5]` | `git clone` hardening: insert `--` before the URL, scheme allowlist (`https`/`ssh`/scp form), reject `ext::`/leading-dash, set `-c protocol.ext.allow=never`. Agent/client-supplied URLs otherwise reach `ext::sh -c` → RCE. | Unit: `ext::sh -c 'touch pwned'` and `-upload-pack=…` URLs are rejected before spawn. |
| `[SEC-H3]` | WebSocket `Origin` allowlist check before `srv.upgrade`, and reflect an origin allowlist instead of CORS `*` (M1). Tailscale does **not** stop a malicious website loaded in a trusted device's browser from opening `ws://<daemon>` (cross-site WS hijack). *Defense-in-depth; confirm the app's own origin(s) before enforcing.* | Integration: WS upgrade from a foreign `Origin` is rejected; app origin accepted. |
| `[SEC-M2]` | Attachment store path containment: sanitize client-derived `ext` to `[A-Za-z0-9]+`, validate `id`/`sessionId`, add `resolveInside` guard (mirror `session-fs.ts`). | Unit: filename `x./../../../evil.` cannot escape the attachments dir. |
| `[SEC-L1]` | Validate/`--`-guard the agent-controlled `base` git ref (`worktree.ts:149`). | Unit: leading-dash base ref rejected. |
| `[SEC-L3]` | `chmod 0600` on push-subscription registries (they hold push secrets; matters on a multi-user host). | Unit: file mode asserted `0600` after write. |
| `[SEC-L4/L5/L6]` | Drop `style` from DOMPurify `ADD_ATTR`; run client streaming markdown through DOMPurify; add `rel="noopener noreferrer"` to linkified `target="_blank"`. | Unit: sanitizer strips `style`; render test asserts `rel`. |

**Also:** add `SECURITY.md` stating the trust model explicitly — **Tailscale + its ACLs are the
security boundary; the daemon is unauthenticated by design and must never be exposed off-tailnet** —
plus the disclosure policy (`[DOC]`). This turns the "no auth" posture into documented, intentional
design rather than an apparent gap.

### Phase 1 status (as implemented)

- ✅ **H4** — `agent/pipeline-guard.ts`; `runAgentQuery` now installs a PreToolUse hook that
  hard-denies danger-list hits. Tests: `test/unit/pipeline-guard.test.ts` (3).
- ✅ **H5** — `assertSafeCloneUrl` + `git -c protocol.ext.allow=never clone --` in `git/ops.ts`.
  Tests: `test/unit/git-clone-safety.test.ts` (3).
- ✅ **H3** — `server/origin.ts` `isAllowedWsOrigin` wired into the `/ws` upgrade; allowlists the
  PWA (same-origin), Android (`appassets.androidplatform.net`), iOS/macOS (`anvil-app://`), and
  no-Origin native clients; `ANVIL_ALLOWED_ORIGINS` extends it. Tests: `test/unit/ws-origin.test.ts` (3).
- ✅ **M2** — `sanitizeExt` + `assertSafeSegment` in `attach/store.ts`. Tests: `test/unit/attach-store.test.ts` (3).
- ✅ **L1** — `assertSafeRef` in `worktree.ts` applied to base + branch. Tests: `test/unit/worktree-ref-safety.test.ts` (2).
- ✅ **L3** — `{ mode: 0o600 }` on the webpush/apns/fcm registries. Tests: `test/unit/push-perms.test.ts` (1).
- ✅ **SECURITY.md** — trust model + disclosure.
- ⏭️ **L4 (deferred/declined)** — removing `style` from DOMPurify `ADD_ATTR` would break KaTeX
  (which emits inline `style` for glyph positioning). Not a live injection (DOMPurify filters CSS),
  so the functional regression isn't worth it; left as-is.
- ✅ **L6 (done in Phase 4)** — `rel="noopener noreferrer"` on the two linkified `target="_blank"`
  spots (git output, reader file-open), via a reusable tested `linkifyUrls` in `dom.ts` (4 tests).
- ⏭️ **L5 (declined)** — the streaming markdown renderer already uses `html: false` (markdown-it
  won't emit raw HTML, so injection is blocked) and the transient stream is replaced by the
  daemon-DOMPurify-sanitized authoritative render on commit. DOMPurify isn't in the web bundle;
  adding it for the transient path is disproportionate. Left as-is (like L4).

---

## Phase 2 — Backend correctness & performance  *(with tests; ~1 week)*

Highest-ROI first (a single `finally` closes three bugs at once).

| Tag | Fix | Guard test |
|---|---|---|
| `[BE-3]` | `driver.consume()`/`stop()` `finally`: reset status, clear `this.q`/`pendingOffers`/`askQuestionIds`, resolve both permission & question brokers. Closes broker-map leak + wedged-on-crash sessions + per-turn map growth. | Unit: a thrown SDK turn leaves status idle, maps empty, brokers resolved. |
| `[BE-13]` | Move `saveMetrics` into the pipeline `finally` (fixes biased collusion metric). | Unit: a failed run still persists its verdicts. |
| `[BE-9]` | Shared atomic-write util (tmp+rename+try/catch) for the three push stores, `budget/tracker`, `schedule`. | Unit: a torn write (simulated) does not zero the file / silently disable the schedule. |
| `[BE-6]` | Reap child processes: `await p.exited`, kill spawned children on abort (`captureGitDiff`, terminal PTY). | Unit: aborting a pipeline leaves no live child. |
| `[BE-10]` | `killGroup` PID-reuse guard: short-circuit if `group.exited` resolved; only signal while the tracked child is unexited. | Unit: a recycled PID is not signalled. |
| `[BE-1]` | Debounced/coalesced session persistence (dirty-flag; drop `null,2` on hot write; consider per-session files). Removes full-registry re-serialize on every event. | Unit/bench: N events produce ≤1 write per debounce window. |
| `[BE-4]` | Async git for clone/push/merge/createPr on request paths; consolidate `gitStatus` into one `status --porcelain=v2 --branch`. | Existing `git/ops.test.ts` extended; assert no `spawnSync` on the request path. |
| `[BE-5]` | Shared retry-with-backoff+jitter honoring `Retry-After` for Todoist/OpenRouter; tolerate partial tag failure; cap fan-out concurrency. | Unit: a 429-then-200 sequence succeeds; partial failure leaves recorded state consistent. |
| `[BE-11]` | EventLog byte-offset index or in-memory cache; size-cap rotation/snapshot. | Unit: `since(seq)` does not re-parse full history; rotation preserves tail. |
| `[BE-12]` | String/escape-aware JSON extraction; wrap phase parse and map format failure to `reject`/`escalate` instead of hard-fail. | Unit: an objection string containing `{` parses; malformed model JSON degrades gracefully. |
| `[BE-14]` | Async ADB (`Bun.spawn`+timeout); move fleet healing off the GET path to a timer; add `.catch` to fire-and-forget refreshes. | Integration: `GET /api/fleet/members` latency independent of member reachability. |
| `[BE-misc]` | `seq` monotonicity (route fabricated events through `emit()`); centralize timing/port constants in `config.ts` with validation (`NaN` port guard); remove dead `PENDING` set and redundant dynamic import; prune completed WorkUnits. | Targeted units. |

### Phase 2 status (as implemented)

- ✅ **BE-3** — driver crash-cleanup `finally` (brokers resolved, status reset, `this.q` released);
  `query` made injectable. `test/unit/driver-cleanup.test.ts`.
- ✅ **BE-13** — `saveMetrics` moved into the pipeline `finally` (failed runs persist their verdicts);
  added store round-trip tests. `test/unit/pipeline-trace-metrics.test.ts`.
- ✅ **BE-9** — shared `util/atomic.ts` `writeFileAtomic` (tmp+rename); adopted by webpush/apns/fcm/
  budget/schedule. `test/unit/atomic-write.test.ts`.
- ✅ **BE-12** — string/escape-aware `extractJson` walker. `test/unit/extract-json.test.ts`.
- ✅ **BE-10** — `killGroup(group)` refuses to signal once the tracked leader exited (PID-reuse
  guard). `test/unit/procgroup.test.ts`.
- ✅ **BE-1** — debounced session-registry persistence (100ms coalesce) on the hot emit path;
  lifecycle ops flush synchronously; guarded + unref'd timer. `test/unit/persist-debounce.test.ts`.
- ✅ **BE-6** — `captureGitDiff` awaits child `exited` (no zombie git procs). The terminal-PTY reap
  on abort is deferred (heavier). `test/unit/capture-diff.test.ts`.
- ✅ **BE-misc (config)** — validated numeric env (`ANVIL_PORT`/budget fractions) with a clear
  startup error instead of a silent `NaN`. `test/unit/config.test.ts`.
- ✅ **BE-5** — shared `util/retry.ts` (backoff + jitter + Retry-After); wired into the Todoist and
  OpenRouter clients (429/5xx only; 401 not retried). `test/unit/retry.test.ts`.
- ✅ **BE-14 (ADB)** — `runAdb` is async with a 15s timeout (no longer `spawnSync`-blocks the loop).
- ⏳ **Deferred (need dedicated, carefully-reviewed effort)**:
  - **BE-4** (async git on request paths) — `run()` backs ~20 fns and `mergePr` is the delicate
    worktree-rollover logic CLAUDE.md flags as fragile; a broad sync→async conversion should be its
    own reviewed PR, not rushed. The recurring-hot-path `prStatus` already has an async variant.
  - **BE-11** (eventlog index/rotation) — needs a format/index design; moderate.
  - **BE-14 (fleet-heal off GET path)** — move `healStaleFleetRecords` to a timer.
  - **BE-misc** — seq monotonicity (route fabricated events through `emit()`), dead-code removal
    (`dispatch.ts` PENDING set, `phases.ts` redundant dynamic import), terminal-PTY reap on abort.

---

## Phase 3 — Backend maintainability (decompose god-files)  *(behavior-preserving; ~1 week)*

Guarded by the Phase 1–2 tests plus new per-module unit tests. No behavior change intended.

- `[BE-7]` Split `supervisor.ts` (2035 lines) into cohesive services: `AutopilotService`,
  `TerminalManager`, `FileWatchManager`, `GitService`. Extract the ~165-line `runAutopilot`.
- `[BE-7]` `http.ts` (270-line if-ladder) → a route table; `dispatch.ts` (435-line switch) →
  per-command handlers (also unlocks `[TEST-2]` per-command tests).
- `[BE-7]` De-duplicate the two ~90%-identical autopilot planning fns into one `planCandidates`.
- `[BE-8]` Extract `TokenStore<T>` + `fanOut(items, sendOne) → dead[]`; collapse the three
  copy-pasted push providers and the repeated register/unregister HTTP handlers.

Each extraction: characterization tests on the current behavior first, then move code, then green.

### Phase 3 status (as implemented)

Method proven: write the full behavioral test suite against the new module's API → move the logic
with dependencies injected → wire the god-file to delegate → verify typecheck + full suite. The
extraction *creates* the coverage (these clusters were untestable in place).

- ✅ **TerminalManager** (`session/terminal-manager.ts`) — PTY channel; injected spawn factory. 6 tests.
- ✅ **FileWatchManager** (`session/file-watch-manager.ts`) — fs-change watching; injected
  locate/read/watch. 6 tests.
- ✅ **Autopilot plan selection + presentation** (`integrations/autopilot-plans.ts`) — the grid-
  selection rules, card shaping, and build brief (pure). 7 tests. The Supervisor keeps the
  session-coupled orchestration (`runAutopilot`/`startPlan`) and delegates.
- ✅ **PR-badge helpers** (`session/worktree.ts` `applyPrBadge`/`isPrSweepEligible`) — dedupe the
  badge-apply triple (3× in gitOp/refreshPrState) and the gh-probe eligibility guard (shared by
  refreshPrState + the fleet sweep). 5 tests. The rest of the git-refresh cluster is session-coupled
  orchestration whose pure bits were already extracted.
- ✅ **parseCommandFrame** (`server/command-frame.ts`) — the WS router's envelope-validation gate
  (JSON/version/type), now pure + unit-tested; dropped the dead `PENDING` set. 6 tests. dispatch.ts
  435 → 408.
- ✅ **BE-8 push consolidation** (`push/token-store.ts` `TokenStore<T>` + `fanOut`) — collapses the
  byte-identical registries + fan-out skeleton across apns/fcm/webpush. 7 tests (the push stack had
  none); providers shrank apns 159→128, fcm 133→103, webpush 107→84.
- `supervisor.ts`: 2035 → 1971 lines; **37 new tests** across 6 cohesive modules.
- ⏳ **Remaining**: the autopilot *orchestration* (needs the session-creation machinery mapped),
  `http.ts` route table (538-line if-ladder — mechanical, higher churn), `dispatch.ts` per-command
  handler table (lower value — cases are trivial glue), and `web/src/main.ts` (gated on the Phase 4
  DOM harness).

---

## Phase 4 — Web frontend  *(tests + refactor + a11y + PWA; ~1.5 weeks)*

- `[TEST-3]` Frontend unit tests for `ws.ts` (backoff/reconnect), `state.ts`, `api.ts`,
  `overlays.ts` (back-stack), plus the automated headless UI smoke from Phase 0.
- `[WEB-1/12]` Split `main.ts` (5170 lines) along its seams: `fleet.ts`, `outbox.ts`, `events.ts`,
  `conversation.ts`, `sidebar.ts`, `settings.ts`, `autopilot.ts`, `panel.ts`, `composer.ts`,
  `dialogs.ts`. Funnel shared scalars through `state.ts` to kill the TDZ load-order hazards.
- `[WEB-2]` Sidebar: diff by `data-id` + rAF-coalesced dirty flag instead of full `innerHTML`
  rebuild on every event.
- `[WEB-3/11]` Content-hash the bundle filename so HTML always references the matching JS (fixes the
  stale-bundle class); gate/externalize PWA sourcemaps; lazy-import Settings/Autopilot/panel chunks.
- `[WEB-7/8/9/10]` Throttle terminal `ResizeObserver`, `selectionchange`, and `saveConvoCache`;
  only re-render stream tail on actual change.
- **Accessibility** `[WEB-4/5/6/13/14]`: `aria-live` for toasts/offline banner; `role="dialog"
  aria-modal` + focus trap on all modals (permission prompts are safety UI); global `:focus-visible`
  outline + `aria-label` on icon buttons; `prefers-reduced-motion`; fix the `role="tablist"` to a
  real tabs pattern or drop the role.
  - UI tests assert: toast has `role=status`; permission dialog traps focus and is announced.

### Phase 4 status (as implemented)

- ✅ **DOM test harness** (`test/web/dom-env.ts`) — jsdom-based `installDom`/`uninstallDom` (no new
  dep); isolated so backend tests never see a `window`. The unblocker for testing + decomposing
  `main.ts`.
- ✅ **First frontend tests** (were zero): `overlays.ts` back-stack (6), `ws.ts` reconnection/backoff
  (6, with a FakeWS + captured timer), `api.ts` endpoint resolution + wss guard (4).
- ✅ **First `main.ts` decomposition**: `OutboxQueue` + `newCid` → `web/src/outbox.ts` (8 tests vs a
  fake Storage); flush/reconcile orchestration stays in `main.ts`. 5170 → 5149.
- ⏳ **Remaining**: more `main.ts` seams (fleet/routing layer, conversation cache, settings/autopilot
  views); sidebar diffing/rAF; SW content-hash; accessibility pass (aria-live, dialog focus-trap,
  focus-visible, reduced-motion); deferred **L5/L6** XSS hardening (client sanitize + rel=noopener),
  now writable test-first; automated headless UI smoke.

---

## Phase 5 — Native clients  *(with tests; ~1 week)*

- `[NAT-1]` Replace the hardcoded personal `mac-mini-m4.softshell-mark.ts.net` default in all three
  clients with an unset "configure your server" state (or derive from pairing).
- `[NAT-2]` WebView failure/offline handling: Android `onRenderProcessGone` (return true + recreate)
  + `onReceivedError`; Apple `didFail*` with a reload affordance.
- `[NAT-3]` Daemon crash-recovery in the menu-bar app: on sustained unreachability, auto-`restart`
  once with backoff and surface repeated failures.
- `[NAT-4]` Fix `Shell.run` two-pipe deadlock (drain stdout+stderr concurrently).
- `[NAT-5]` Extract shared `SparkleUpdater` (reconcile the `@MainActor` drift).
- `[NAT-7/8]` Bounded retry on push-token registration; cap/timeout the hand-rolled pairing HTTP
  parser (slow-loris).
- `[NAT-11]` Protocol-version negotiation: `/api/health` exposes `protocolVersion`/`minClient`;
  clients show an upgrade banner on mismatch.
- `[TEST-6]` SwiftPM tests for `HTTP.parse` and `Tailscale.tailnetIP`; Kotlin tests for `Net`/NSD.
  **Prereq found (2026-07):** attempted `HTTP.parse` tests but this env's Command-Line-Tools Swift
  toolchain ships **neither `XCTest` (needs full Xcode) nor `Testing`/swift-testing**, and
  `@testable import` of the *executable* target fails emit-module. So native tests need: (a) full
  Xcode in CI *or* a `swift-testing` package dependency, **and** (b) extracting the pure logic
  (`HTTP`, tailnet-IP CGNAT check) into a small dependency-free **library target** both the executable
  and tests depend on (avoids the executable-@testable limitation). A dedicated setup task, not a
  drop-in — reverted the exploratory attempt rather than commit unrunnable config.
- `[NAT-misc]` Remove residual "Zellij" branding; centralize duplicated endpoint string literals;
  document the intentionally-committed `anvil-debug.keystore` + `google-services.json` in the README.

---

## Phase 6 — CI/CD & release hardening  *(~3–4 days)*

- `[CI-S4/S5]` Daemon self-update: verify signed tags/commits before applying, pin to `release-*`
  tags (not a branch tip), enforce HTTPS/SSH remotes, and run typecheck+test before
  `scheduleRestart()`. (The Sparkle app path is already EdDSA-protected; this closes the git-source
  gap.)
- `[CI-R1/R2]` Extract the copy-pasted Apple keychain/signing block into a composite action; matrix
  the near-identical mac-client/mac-server jobs.
- `[CI-R3]` Add assertions to fragile parse steps (fail if an extracted Sparkle signature is empty).
- `[CI-S3/R4]` Align `package.json` version with the `VERSION` line (or document the split);
  centralize hardcoded bundle IDs / feed URLs / min-OS.
- `[CI-S2]` Decide + document the Android beta debug-signing (or move to a signed internal track).

---

## Phase 7 — Documentation & requirements  *(~2–3 days; can parallel earlier phases)*

- `[DOC-2]` **Root `README.md`** — fixes two dead links (`docs/README.md`, ARCHITECTURE banner both
  point at a nonexistent `../README.md`); reuse the banner block in `docs/assets/README.md`.
- `[DOC-1]` **Expand `CLAUDE.md`**: orientation/module map (link `docs/ARCHITECTURE.md`), full verify
  commands (note `typecheck` **and** `typecheck:web` cover different trees; `bun test`), the
  daemon-refuses-to-start-with-`ANTHROPIC_API_KEY` constraint, and a **Common pitfalls** section
  naming web-bundle-cache staleness and "Android bundles the web UI." (Existing content is accurate —
  the fault is under-coverage, not errors.)
- `[DOC]` `docs/REQUIREMENTS.md` — consolidate the scattered constraints (Max-subscription-only
  billing, daemon-is-permission-authority, Tailscale-private transport, `PROTOCOL_VERSION=1`,
  platform matrix) into one requirements statement.
- `[DOC]` `docs/PROTOCOL.md` — prose reference generated from/companion to `anvil-protocol.ts`.
- `[DOC-3.1]` `docs/plans/anvil-adversarial-pipeline.md` — the OpenRouter/GLM Anthropic-skin
  integration + consensus math is currently documented nowhere in prose (only in code + the type
  file).
- `[DOC-3.2]` ARCHITECTURE.md autopilot section (autostart-gate + adversarial review).
- `[DOC-3.3]` Update the stale `anvil-impl-INDEX.md` ("Android is Java, not Kotlin" is false now;
  top-line status stale).
- `[DOC]` `CONTRIBUTING.md`, `SECURITY.md` (from Phase 1), `LICENSE` (resolve the Termux GPL
  question the INDEX raises), and a `CHANGELOG`.

---

## Test suite design — the definition of "done"

Every phase adds to this matrix. Coverage is reported in CI from Phase 0.

- **Unit (backend):** danger-list/permissions, git-clone hardening, atomic writes, driver lifecycle,
  killGroup guard, retry/backoff, eventlog index, JSON extraction, config validation, push
  TokenStore/fanOut, autopilot planning/classify.
- **Unit (frontend):** ws backoff/reconnect, state reducers, api client, overlays back-stack,
  outbox flush, sanitizer.
- **Integration (daemon):** WS Origin rejection; pipeline danger-gate denies destructive tools;
  per-command dispatch (unlocked by Phase 3); fleet-members latency; attachment traversal.
  *(No app-layer-auth tests — Tailscale is the accepted boundary, §0.2.)*
- **Contract:** golden protocol envelopes vs daemon emissions, versioned; guards daemon↔web/iOS/
  Android drift.
- **UI/E2E:** headless boot smoke (first paint + WS connect); permission-dialog focus trap +
  aria-live announce; offline banner; sidebar renders N sessions without full rebuild.
- **Native:** Swift `HTTP.parse` + `tailnetIP`; Kotlin `Net`/NSD; both wired into CI.

---

## Rough sequencing & size

| Phase | Theme | Size | Gating dependency |
|---|---|---|---|
| 0 | CI gate + harness | 1–2 d | none (do first) |
| 1 | Security-critical | 3–5 d | Phase 0 |
| 2 | Backend correctness/perf | ~1 wk | Phase 0 |
| 3 | Backend decomposition | ~1 wk | Phases 1–2 tests |
| 4 | Frontend | ~1.5 wk | Phase 0 harness |
| 5 | Native | ~1 wk | Phase 0 harness |
| 6 | CI/CD hardening | 3–4 d | Phase 0 |
| 7 | Docs/requirements | 2–3 d | parallel |

Phases 4, 5, 7 can run in parallel with 2/3 once Phase 0 lands. Total ≈ 5–7 focused weeks if serial;
less with parallel tracks.
