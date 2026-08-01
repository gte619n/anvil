# Anvil Improvement Program v2 — Test-First Implementation Plan

**Status:** Proposed (2026-08-01). Branch: `performance-refactoring`.
**Method:** Test-first, same as the [original program](anvil-improvement-program.md). Every change lands
as *failing guard test → implementation → green*. No behavior change ships without a test that would
have caught the regression it prevents. CI gates `typecheck` + `typecheck:web` + `build:web` + `bun test`
on every PR — keep all four green.

## Why a v2

The [first program](anvil-improvement-program.md) (2026-07-04) delivered its security, correctness, and
CI-gate foundation. Since then **~122 commits / ~27k lines** landed — multi-account tokens, the stable
update service + hub fleet rollout, incremental resume (protocol v4), the `/goal` stop hook, fleet
identity-gating, and the marketing site — **none of which the original seven-track audit ever saw.** A
fresh seven-track audit (backend, web, security, tests, CI/CD, docs) of the current tree produced the
findings below. Each was spot-verified against source; file:line citations are current as of HEAD `2059142`.

Two findings are **release-blocking security** and jump the queue ahead of everything else.

---

## Severity ladder (do in this order)

| Phase | Theme | Blocking? |
|---|---|---|
| **P0** | Fleet-update integrity + browser-origin gap (compound RCE path) | **Ship-blocker** |
| **P1** | Deterministic crashes & event-loop freezes (boot crash, sync-network on request path) | High |
| **P2** | Memory growth & broadcast amplification (leaks, unbounded maps, full-innerHTML rebuilds) | High |
| **P3** | Update-service robustness (rollback holes) + fleet correctness (500-wedge, dead reconcile) | High |
| **P4** | Scalability (eventlog index, virtualization, backpressure, bundle splitting) | Medium |
| **P5** | Test coverage — the guard suite the above is implemented against | Runs *with* P0–P4 |
| **P6** | CI/CD hardening (native PR builds, signature assertions, pins) | Medium |
| **P7** | Maintainability / DRY (god-file decomposition, dedup) | Medium |
| **P8** | Docs, requirements, CLAUDE.md | Parallel |

P5 is not a separate stage in time — each P0–P4 item names its guard test, and P5 is the ledger of that
suite plus the standalone coverage gaps. Native (Swift/Kotlin) test targets remain blocked on toolchain
(unchanged from v1 Phase 5) and are tracked but not scheduled here.

---

## P0 — Fleet-update integrity + browser-origin gate  *(ship-blocker; ~2–3 days)*

The stable update service and hub rollout added three state-mutating HTTP routes
(`/api/update/v1/apply`, `/api/fleet/update`, `/api/daemon/update`) that have **neither the WS origin
gate nor a signature/ancestry check**. In combination a malicious web page open in *one* trusted
device's browser can pin the whole fleet to an arbitrary commit and force a fleet-wide restart onto it.
Both halves stay strictly inside the accepted trust model (Tailscale is the boundary; these are
supply-chain integrity + defense-in-depth on the browser vector — **not** app-layer request auth).

| Tag | Fix | Guard test (write first) |
|---|---|---|
| **SEC2-1** | `applyUpdateToTarget` (`src/daemon/selfupdate.ts:229`) does `git checkout --detach <targetSha>` with **no ancestry/signature check** — and its own doc-comment (`:225-226`) *falsely claims* an ancestor-or-descendant guard. Before checkout, require `git merge-base --is-ancestor <target> origin/HEAD` (reject non-rollback targets not reachable from the trusted upstream tip). Fix the lying comment in the same commit. | Unit: a SHA on a side branch (not an ancestor of `origin/HEAD`) is rejected **before** any checkout/install runs; an on-branch SHA is accepted; rollback path (`allowNonFastForward`) still resets backwards. Inject `CommandRunner` (already supported). |
| **SEC2-2** | Origin gate `isAllowedWsOrigin` is wired **only** at the `/ws` upgrade (`http.ts:969`). Factor a shared `assertAllowedOrigin(req, host)` and apply it to **all** state-mutating `/api/*` routes (update, fleet, daemon, `permission.respond`, `session reset`, push register). Also require `Content-Type: application/json` and reject a body-less `apply` — defeats the CORS "simple request" (`text/plain` POST, no preflight) bypass. | Integration: POST to `/api/update/v1/apply`, `/api/fleet/update`, `/api/permission/respond` with `Origin: https://evil.example` → 403; no-Origin (native) and same-tailnet `*.ts.net` Origin → pass. |
| **SEC2-3** | `/api/update/v1/apply` and `/api/daemon/update` have **no identity gate at all** (contrast `/api/fleet/*` which reject `otherUser`). Add the same `callerIdentity()` posture (reject proven `otherUser`). | Unit/integration: apply from a whois-`otherUser` peer → 403; `sameUser`/`unknown` proceeds. |

**Product impact:** closes a fleet-wide RCE + persisted-across-restart vector and a forced-update DoS. The
rollback watchdog does **not** mitigate SEC2-1 — a malicious-but-healthy build passes its 180s health gate
and is adopted as the new known-good. `permission.respond` behind SEC2-2 is the sharpest edge: a foreign
page can currently auto-`allow_always` a parked agent tool call.

---

## P1 — Deterministic crashes & event-loop freezes  *(High; ~1 week)*

The daemon is single-threaded; a sync network subprocess freezes **every** session, WS frame, and HTTP
request for up to `NET_TIMEOUT_MS` (60s). The v1 audit deferred BE-4; since then the pattern **spread**
into new code. Separately, the web client has a reproduced cold-boot crash of the exact class 3.0.33 shipped.

### Web boot crash (same class as commit `2059142`)

| Tag | Fix | Guard test (write first) |
|---|---|---|
| **WEB2-1** | Cold deep-link boot (`#p/<id>`, `#autopilot`) runs `openAutopilot → renderScheduleBar → scheduleSummaryHtml` at init (`main.ts:919`), reading `serverSchedule`/`autopilotLog`/`runState` declared ~3000 lines below → synchronous `undefined` access aborts module init → dead app. Reproduced under node+jsdom. Fix now: `queueMicrotask` the init call (as `2059142` did for `loadConversation`). Fix structurally in P7: move those scalars to `state.ts`. | Extend `test/web/boot-init.test.ts`: seed URL `#p/x` and `#autopilot`, assert `initErr === null`. Also seed `anvil.sessions` matching `anvil.active` to cover the `setHeaderTitle` sync branch. |
| **WEB2-10** | Per-event `localStorage.setItem` in the WS hot path (`seqStore.set`/`epochStore.set`, `main.ts:494/502`, called per `assistant.delta`) is **unguarded**; `ws.ts:72` calls `onEvent` with **no try/catch**. On a quota-full device one throw silently freezes all WS processing (the 3.0.33 incident class). Wrap both stores in try/catch; throttle seq persistence off the delta path; wrap `onEvent` in try/catch + `console.error`. | jsdom: Storage stub throwing `QuotaExceededError`; deliver `assistant.delta` then `assistant.message` → both render, no exception escapes the socket handler. |

### Sync-network-subprocess family (BE-4 metastasized)

All share the fix shape: use the existing async spawn twin, or move the work off the request path. All are
S/M effort, high confidence.

| Tag | Freeze source | Fix |
|---|---|---|
| **BE2-1** | `git.prStatus(cwd)` (sync `gh pr view`, 60s) on the synchronous `git` dispatch case (`supervisor.ts:2401`); async twin `prStatusAsync` already exists and is used 85 lines away. | Route `gitOp("status")` through `prStatusAsync`. Guard: fake `gh` sleeps 2s; concurrent `ping` gets `pong` <100ms. |
| **BE2-2** | Sync `git fetch` on every session/worktree create (`worktree.ts:164`→`:129`) — blocks `session.create`, team spawn, autopilot `startPlan`. | Async spawn for worktree creation, or background fetch with cached tip. |
| **BE2-3** | `runTeamIntegration` (N sync merges + push + `gh pr create`) on the sync dispatch path (`supervisor.ts:1375`, `dispatch.ts:169`). | Async-ify like `session.kill` (`.then(ack)`). |
| **BE2-4** | "Background" session teardown still runs sync network spawns (`git.deleteRemoteBranch`, `supervisor.ts:2938`). | Async `deleteRemoteBranch`/`removeWorktree`. |
| **BE2-5** | `refreshGit` runs 4–5 sync git subprocesses after **every** agent turn (`supervisor.ts:3243`→`worktree.ts:297`). | Async spawn + per-session coalescing window. |
| **BE-4** | Root cause: `run()` in `git/ops.ts:13` → `Bun.spawnSync` backs ~20 fns. | Convert the request-path callers above; the delicate `mergePr` worktree-rollover stays a separate reviewed PR. |

**Product impact:** removes the daemon's worst deterministic stalls — a single "git status" click or a
3-member team spawn currently freezes the whole daemon for seconds to a minute.

---

## P2 — Memory growth & broadcast amplification  *(High; ~1 week)*

Unbounded maps and full-rebuild broadcasts that grow with uptime/traffic. All S-effort unless noted.

### Backend leaks & amplification

| Tag | Issue | Fix / guard test |
|---|---|---|
| **BE2-23 / SEC2-4** | `clientTelemetry` map (`supervisor.ts:204`) grows forever, keyed by **unvalidated client-supplied id**; whole map re-serialized into a broadcast on every report + every connect. Also a DoS vector. | LRU cap ~50 + TTL; validate `clientId`/`counters`; coalesce broadcast. Test: 5000 unique ids → size ≤ cap; malformed report ignored. |
| **BE2-21** | Every `session.updated` (fires on every status flap, several/turn) re-derives + broadcasts the **full team tree** to every connection (`supervisor.ts:3445`), team or not. | Only when `teamRole || parentId`; coalesce 250ms; skip unchanged status. |
| **BE2-22** | Unbounded `diffstat` (2000-file array) rides every broadcast **and** every debounced full-registry `writeFileSync` (`worktree.ts:315`). | Cap ~200 lines + summary. |
| **BE2-24** | `awaitingAnnounced`/`goalPushSuppressed` never deleted on `kill()` (`supervisor.ts:208`). | Two deletes in `kill()`. |
| **BE2-20** | **No WS backpressure anywhere** — `toAll`/`toAttached` ignore `ws.send()`'s return (`registry.ts:23`); a half-open phone buffers unbounded outbound bytes for up to `idleTimeout:120`s. Deltas are re-derivable (v4 resume), so dropping is safe. | Check `getBufferedAmount()`; drop delta-class past a threshold, close past a hard cap. Effort M. |
| **BE2-14** | `fleet.json` + `~/.config/anvil/env` (holds `CLAUDE_CODE_OAUTH_TOKEN`) written **non-atomically** (`fleet/store.ts:46`, `auth/env-file.ts:74`); torn write on the documented restart-storm box = fleet amnesia / degraded boot. `util/atomic.ts` exists and is used next door. | Adopt `writeFileAtomic` in all four sites. Test: simulated torn write doesn't zero the file. |

### Web leaks & unnecessary renders

| Tag | Issue | Fix / guard test (jsdom `test/web/dom-env.ts`) |
|---|---|---|
| **WEB2-2** | Sidebar full-`innerHTML` rebuild on **every** event (`main.ts:2405`); per-row cost is O(N² log N) (`envOrdinal` sorts all sessions per row) + a `localStorage.getItem`+parse per row. | rAF-coalesced dirty flag; keyed diff by `li.dataset.id`; hoist `envOrdinal` to one precomputed Map; cache `orderedServers()` per pass. Test: unrelated `status` event leaves other `<li>` node identities unchanged; two synchronous renders = one mutation batch. Effort M. |
| **WEB2-14** | `persistSessions` stringifies **all** sessions on every `session.updated`/status churn (`main.ts:381`). | Debounce 1s trailing + `visibilitychange` flush. Test: 10 events in one tick → ≤1 write. |
| **WEB2-11** | convoCache / `anvil.seq|epoch|history|draft` keys **orphaned** when `session.list` prunes a session deleted while disconnected (`main.ts:1017`); `anvil.history.<id>` never removed on any path. Directly the 3.0.33 quota class. | Call `forgetConvoState(id)` + remove draft/history in the prune loop; boot-sweep IDB entries not in `anvil.sessions`; LRU ~10 transcripts. Test: seed keys for X, deliver `session.list` without X → all gone. |
| **WEB2-12** | `AnvilSocket` adds `window online` + `document visibilitychange` listeners never removed on `close()` (`ws.ts:27`); the URL-drift heal path leaks a pair per member per fetch. | Store + remove handlers in `close()`. Test (FakeWS): `close()` then dispatch `online` → no connect, listener count zero. |
| **WEB2-13** | Diagnostics panel subscribes a new telemetry listener per open, never unsubscribed (`main.ts:663`). | Keep the unsubscribe; call on close. |
| **WEB2-16** | Team board full-`innerHTML` rebuild + listener re-wire on every member `session.updated` (`main.ts:2482`). | Diff rows by `data-id` or rAF-coalesce with the sidebar flag. |
| **WEB2-15** | Autopilot run log O(n²): per line `autopilotLog.join("\n")` + full `textContent` replace + forced scroll (`main.ts:4004`). | `appendChild(textNode)` + rAF scroll; dedupe the two copies. |

---

## P3 — Update-service robustness + fleet correctness  *(High; ~4–5 days)*

The update service's own rollback design has three holes; the fleet GET path has a 500-wedge and a dead
reconcile promise.

| Tag | Issue | Fix / guard test |
|---|---|---|
| **BE2-28** | `POST /api/update/v1/apply` has **no concurrency guard** — the `private updating` flag protects only the legacy WS path; the v1 route + fleet-rollout `applySelf` bypass it. Interleaved applies corrupt the checkout and poison `prePullSha`. | Module-level in-flight promise in `update-api.ts` shared by all three transports. Test: two concurrent applies → second gets "already in progress". |
| **BE2-29** | Crash mid-`bun install`/build leaves phase `pulling|building`; the watchdog only arms on `restarting` (`watchdog.ts:68`) → launchd respawns broken source, no rollback. A hole in the longest window of the "survives a bricked release" backstop. | Watchdog arms on `pulling|building|restarting`; roll back to `prePullSha` (recorded before checkout moves). Effort M. |
| **BE2-30** | `UpdateStateStore.set()` is cross-process read-modify-write (`update-state.ts:57`); daemon and watchdog lose each other's updates (atomic write ≠ atomic RMW). | `updatedAt` compare-and-swap, or watchdog writes a sidecar. Effort M. |
| **BE2-31** | Watchdog commits to rollback, spends minutes in `rollbackTo`, then restarts **unconditionally, no re-probe** (`watchdog.ts:100`) — a boot that goes healthy at t=181s is reset backwards under the now-healthy daemon. Manufactures the restart-storm class. | Re-probe health after `rollback()` resolves; adopt target if healthy. |
| **BE2-33** | `shaMatches` triplicated verbatim across daemon/watchdog/update-api; `startsWith` prefix-match means a 1-char SHA matches anything. | One shared dep-free module + min-length guard. |
| **BE2-10** | `healStaleFleetRecords` **awaited, unthrottled** on every `GET /api/fleet/members` (`http.ts:534`); a malformed stored URL throws through `Promise.all` → **the endpoint 500s forever** until hand-edited. | `void`+throttle (mirror the correct `healFleetUrlsByDiscovery` next to it); try/catch the `new URL`. Tests: (a) never-resolving probe → GET <100ms; (b) `url:"not a url"` → 200 not 500. |
| **BE2-11** | Fleet-rollout coordinator can wedge `active:true` forever — `run()` clears `active` only on its last lines with no try/finally; a throw is swallowed and every future update is rejected "already in progress" (`fleet-rollout.ts:111`). | try/finally around the body. Test: `members: () => throw` → `status().active === false`; second `start()` succeeds. |
| **BE2-12** | `reconcile()` (converge members offline at rollout time) is **dead code** — no call site (`fleet-rollout.ts:193`). Members marked `pending-offline` never converge → persistent fleet SHA divergence. | Wire a throttled background reconcile off the members/heal path. Effort M. |
| **BE2-13** | Pairing code has **no attempt cap** (`pairing.ts:102`) — 10⁶ space, 30-min armed window, prize is the hub POSTing its OAuth token. (Timing-safe compare is good but moot.) | Disarm after ~5 wrong codes. Test: 6 wrong → correct code returns "not accepting pairings". |

**Product impact:** the update service today can (a) corrupt a checkout under retry, (b) brick a member on a
mid-build crash, (c) permanently 500 the fleet dashboard, (d) silently strand offline members on an old SHA,
and (e) leave the rollout coordinator wedged. These defeat the very reliability the service was built for.

---

## P4 — Scalability  *(Medium; ~1.5 weeks)*

Costs that are fine today and quadratic at fleet/transcript scale.

| Tag | Issue | Fix / guard test |
|---|---|---|
| **BE2-6 / BE-11** | EventLog `readAll()` re-parses the **whole** `events.ndjson` on every `since()`/`snapshot()`/`promptCids()` (`eventlog/log.ts:49`). Protocol v4 fires `since()` on **every reconnect**; after a restart all clients reconnect at once → back-to-back full-file parses of a 5–10MB log (~30–150ms each) blocking the loop. | In-memory tail cache inside `EventLog` (append already sees every event; `since()` slices memory); size-cap rotation. Test: spy `readFileSync` → after hydration, N `since()` calls = 0 file reads. Effort M. |
| **BE2-7** | Boot re-reads every session's full log for `promptCids()` (`supervisor.ts:3162`); boot latency = sum of all ndjson bytes, before serving. | Falls out free with BE2-6's cache. |
| **BE2-8** | Resume-resurfaced events reuse `seq = lastSeq` (`session.ts:237/287`, `supervisor.ts:2070`) → a v4 delta client filtering `seq > watermark` **drops re-surfaced permission prompts** (invisible-prompt / stuck-session — the exact failure v4 exists to prevent). | Omit `seq` on replay events, or add `replay:true`; never reuse `lastSeq`. Test: attach with `lastSeq = s.lastSeq` to a session holding a pending permission → prompt survives the client's seq filter. Effort M. |
| **WEB2-9** | **No transcript virtualization** — snapshot replay renders every event with a `scrollDown` (forced layout) per message → O(n²); 10k messages = multi-second freeze + ~50–100k permanent DOM nodes taxing every subsequent render. | Cheap first: batch snapshot into a DocumentFragment, one `scrollDown` (gate on the existing `replayingSnapshot` flag) → O(n²)→O(n). Real: window to last ~200 bubbles, load older on scroll-up via `lastSeq` ranges. Test: 1000-event snapshot → ≤2 layout read/write cycles. Effort S (batch) / L (window). |
| **WEB2-6** | `saveConvoCache` clones + serializes the **entire** transcript DOM per turn (`main.ts:682`) — 30–150ms block on long sessions (debounce + IDB already fixed). | Incremental append-only serialization, or cap cached transcript to last N bubbles (resume re-syncs the rest). Effort M. |
| **WEB2-3** | Bundle not content-hashed (`build.ts:26`) → stale-bundle class; Settings/Autopilot/accounts/xterm all in the initial bundle (no lazy chunks); sourcemaps shipped ungated. | `naming:"[name]-[hash]"` + rewrite `index.html` script src at build; dynamic `import()` for Settings/Autopilot/terminal/sortables; `sourcemap:"external"` gated on `!RELEASE`; SW precache the hashed-asset manifest + prune non-manifest on activate (WEB2-17). Test: `dist/index.html` references the hashed filename; no `.map` when `RELEASE=1`. Effort M. |
| **WEB2-4/5** | Terminal `ResizeObserver` runs `fit()` + WS frame per tick (`main.ts:5996`); `selectionchange` does layout read→write per tick (`main.ts:5888`). | Debounce RO ~100ms + only send `terminal.resize` on cols/rows change; rAF-coalesce selection positioning. Tests: 20 resize callbacks → ≤1 WS frame; 10 selection events → ≤1 `getBoundingClientRect` after rAF. Effort S each. |
| **BE2-15 (server)** | Fleet REST latency bound to slowest remote; `rotate`/`invite` hold a request ~14s/member; the global `idleTimeout:120` was raised to accommodate it. | Job-ify rotate/invite (the rollout coordinator is the in-repo model); dedupe the invite double-probe. Effort M–L. |
| **BE2-17** | Identity gate spawns up to 2 tailscale subprocesses **per request**, uncached (`pairing.ts:279` via `http.ts:613`) — including static-asset requests. | Memoize selfLogin (5min TTL), LRU whois (60s), cache the binary path; dedupe the duplicated `TAILSCALE_BINS`. |

---

## P5 — Test coverage (the guard suite)  *(runs with P0–P4; standalone gaps ~1 week)*

Suite today: **743 tests / 118 files, 7.9s, stable** (1 environmental failure below). Recent big features
*did* ship with tests — the gaps are specific.

**Fix immediately (blocks a clean baseline):**
- **Fix `boot-init.test.ts`** — it reads `web/dist/index.html`, which is absent in a fresh worktree, and
  fails with a misleading `initErr undefined`. Have the test build/synthesize the html (or skip with a
  clear "run build:web first"). *This is the 1 red test in this worktree.*

**Zero-coverage modules, ranked by blast radius:**

| Risk | Module | Guard to add |
|---|---|---|
| Critical | `src/daemon/updater/main.ts` (watchdog entrypoint) | Spawn against a fake daemon dir: arms, detects dead daemon, invokes rollback. |
| High | `src/auth/env-file.ts` | Atomic write, correct key for bound account, **never** writes the developer's real credential path (regression 3ee7814). |
| High | `src/agent/input-queue.ts` | Enqueue-while-busy preserves order; drain-on-idle exactly once; no loss on driver restart. |
| High | `src/push/apns.ts`, `src/push/fcm.ts` | Against a fake endpoint: auth header, payload shape, 410/`UNREGISTERED` prunes the registry. |
| High | `web/src/main.ts` behaviors | Permission-dialog approve/deny flow; offline banner + reconnect; both zero-coverage safety UI. |
| Med | `web/src/setup.ts`, `telemetry.ts`, `push.ts`, `layout.ts` | First-run pairing; client resume telemetry. |

**Contract test — the single most leveraged gap:** `test/contract/` pins only `PROTOCOL_VERSION` + the set
of `type` string literals. Renaming a v4 field (`watermarks`→`items`), retyping `lastSeq`, or dropping
`epoch` from `conversation.snapshot` **passes** — exactly the fields the Swift/Kotlin clients decode.
Extend the golden to pin **required fields + types per wire type** (mirror the existing
`update-api-contract.test.ts` `assertShape` pattern), starting with the v4 resume envelopes and
`server.hello`. This is the only guard between a field rename and three broken native clients.

**E2E:** the planned promotion of `test/tools/headless-smoke.ts` into CI never happened; nothing E2E runs
in CI. Promote it (install Chrome in the workflow, run post-`build:web`) to pin "bundle boots, shell
renders, no uncaught init exception" in a real browser — the WEB2-1 class.

**Fixture debt:** the planned `test/helpers/` never landed — 55 files hand-roll `mkdtempSync`, ~13 duplicate
the Supervisor boot line. Extract `tmpDir()`, `bootSupervisor()`, `wsSession()` (lift from `resume-wire`),
`webDirOk()`. This makes every P0–P4 integration test ~30 lines instead of ~100 and pays for itself.

**Native:** still zero test targets (Swift/Kotlin), still blocked on toolchain (full Xcode or a
`swift-testing` dep + a library-target extraction). Tracked, not scheduled.

---

## P6 — CI/CD hardening  *(Medium; ~3–4 days)*

| Tag | Issue | Fix / verify |
|---|---|---|
| **CI2-2** | Sparkle `edSignature` extraction via `sed` (`release.yml:316/405`) — **sed echoes input unchanged on no-match, exits 0**; a format shift (already happened once with Sparkle 2.9) ships a garbage signature → every Mac's update check fails EdDSA silently. | Assert shape `^[A-Za-z0-9+/=]{80,120}$` + numeric length; ideally `sign_update --verify` before upload. |
| **CI2-1** | **Android/iOS/macOS/anvil-server get their first build at release time, post-merge** — ci.yml only builds the daemon. The AGP 9 bump (#109) went green then broke the release. | Path-filtered PR jobs: `:app:assembleDebug` (secrets-free — debug keystore committed), `swift build` for `apple/` + `anvil-server/`, `xcodegen generate` lint. Verify: reintroducing the AGP 9 bump goes red at PR time. Effort M. |
| **CI2-3** | Appcast history wiped on a transient Pages fetch failure — `curl -fsSL … || echo "(no existing)"` treats a 5xx like a first release (`release.yml:431`) → feed rebuilt with one item, 20-item rollback history lost. | Distinguish 404 (legit) from other codes; fail otherwise. |
| **CI2-6** | Bun pinned in the gate but `latest` in every ship job (`release.yml:108/175/259/345/428`) — the web bundle that actually ships is built by an unvalidated Bun. | Pin `1.3.14` everywhere; a lint step fails on `bun-version: latest`. |
| **CI2-10** | Dependabot has no `swift`/SPM ecosystem → **Sparkle (the update-verification framework) is unmonitored**; all `uses:` are tag-pinned (not SHA) in jobs holding the Sparkle private key + Developer ID p12; gradle wrapper unchecksummed. | Add `package-ecosystem: swift` for `/apple` + `/anvil-server`; SHA-pin actions in `release.yml`; add `distributionSha256Sum`. |
| **CI2-5** | `meta` mints the public `v<version>` tag + Release **before/regardless of** `verify` (`release.yml:44`, no `needs:`) → red verify still leaves a tag + assetless Release, polluting the only commit↔version audit trail. | `needs:[verify]` (keep version computation early), or create `--draft` and publish in `pages`. |
| **CI2-4** | Apple keychain/signing block copy-pasted **3×**; mac-client vs mac-server jobs near-identical. | Composite action `.github/actions/apple-signing` + matrix the two mac jobs. Effort M. |
| **CI2-9** | `anvild/package.json` frozen at `0.2.0` while the release train is `3.0.x` → every daemon surface (health, badge, fleet views, watchdog logs) reports a version 3 majors stale. | Derive the human line from the `VERSION` file (package.json fallback); a test asserts MAJOR.MINOR == `VERSION`. |
| **CI2-7** | Daemon self-update still has no signed-tag/commit verification (v1 CI-S4). *Now cheap* — CI mints `v*` tags. Overlaps SEC2-1's ancestry check; do together. | `git verify-commit`/`verify-tag` against a pinned allowed-signers file, or minimally the SEC2-1 ancestry assertion. |
| **CI2-12** | Rollback is best-in-class for the daemon, **roll-forward-only** for every native surface, and the per-platform procedure is undocumented. | Document per-platform rollback in CI-CD.md; optional `workflow_dispatch` `release_ref` input to cut a release from a known-good SHA. |

**Also confirm** (repo setting, not in-tree): is `ci.yml` a *required* status check? Everything downstream
assumes a red PR check blocks merge.

---

## P7 — Maintainability / DRY  *(Medium; ~1.5 weeks; behavior-preserving)*

Method is proven from v1 Phase 3: write the behavioral suite against the new module's API → move code with
deps injected → delegate from the god-file → green. The extraction *creates* the coverage.

**Backend — `supervisor.ts` re-grew 1971 → 3529.** Five accreted, already-closure-injected domains:
`TeamCoordinator`, `AutopilotService` (+ its 5-min timer), `IntegrationsFacade` (Todoist/lapo),
`AccountRosterService`, `GitProjection/PrSweeper` (natural home for the P1 async git conversion). Plus
`http.ts` (560-line flat if-ladder, `handle()` `:483` — a method+prefix route table also gives a top-level
try/catch→500 that kills BE2-10's crash-500 class, and one `withJsonBody` helper for the 5× copy-pasted push
handlers). DRY: **BE2-33** (`shaMatches` ×3), **BE2-42** (`planAndTagProject`/`Tasks` 40-line near-dupes;
lapo-report grouping ×2), **BE2-45** (dispatch `.then(ack).catch(cmdError)` ×10 → `ackWhenDone`).

**Web — `main.ts` still 7451 lines (grew from 5149).** Extract in dependency order, and **each seam carries
its shared scalars into `state.ts`** — this is what permanently retires the WEB2-1 TDZ crash class:
`fleet.ts`, `sidebar.ts`, `conversation.ts`, `autopilot.ts` (← the WEB2-1 crash set), `settings.ts`,
`composer.ts`, `panel.ts`, `dialogs.ts`. DRY: **WEB2-18** (modal-promise triplication → one `modalPromise`
primitive — also the single site for the WEB2-8 dialog-a11y fix), **WEB2-19** (plan-action + busy-button
boilerplate ×7+).

**Accessibility (WEB2-8, fold into `dialogs.ts`):** modals (incl. permission-adjacent confirms) are bare
`div.modal` — no `role="dialog"`, `aria-modal`, or focus trap; permission/question cards append with no
`aria-live`/`role="alert"` announcement (safety UI a screen-reader user never hears); the `role="tablist"`
wraps plain buttons (invalid — complete or drop it). One ~15-line focus-trap in `showModal` covers all
modals. Test: `confirmDialog` has `[role=dialog][aria-modal]`, Tab from last focuses first; permission card
carries `role="alert"`.

---

## P8 — Docs, requirements, CLAUDE.md  *(parallel with all phases)*

Prioritized (full table with tags in the audit notes). Fix the **wrong/contradictory** first — they
actively mislead an agent working the repo:

1. **DOC2-17** — CI-CD.md's daemon-channel section predates the update service; the doc people follow *during
   an incident* omits the rollback watchdog + fleet rollout. Rewrite.
2. **DOC2-24/25** — two shipped features (`stable-update-service`, `incremental-offline-resilience`) whose
   plan docs still say "implementation not started" / "Draft". Flip to Implemented + phase table.
3. **DOC2-8** — ARCHITECTURE.md says `PROTOCOL_VERSION = 1`; actual is **4**. Cite the file header, don't
   re-embed the number (it has rotted twice).
4. **DOC2-1** — CLAUDE.md "**needs** `CLAUDE_CODE_OAUTH_TOKEN`" contradicts the degraded-boot design
   documented in ARCHITECTURE + README (missing token → degraded; only a *metered key* is fatal).
5. **DOC2-4** — CLAUDE.md is silent on the **frozen Update API v1**: an agent could casually refactor
   `update-api.ts`/`updater/*` and break fleet self-heal. Highest-value *missing* guidance.
6. **DOC2-15/16** — CI-CD.md + RELEASING.md say `VERSION` is "currently 2.2" and "there are no release
   tags"; it's `3.0` and the workflow mints `v3.0.x` tags every merge.
7. **DOC2-20** — SECURITY.md has no update-integrity statement now that unattended pull+rollback exists
   (and, post-P0, an ancestry gate); state the trust anchors and that rollback is a *health*, not
   *authenticity*, guarantee. Fold in the SEC2-2/3 identity-gate exceptions to the flat "no auth" line.
8. **DOC2-9** — ARCHITECTURE + README resume diagrams miss v4 epoch/watermark/cid semantics; a client built
   from the docs gets resume wrong.
9. **DOC2-3** — CLAUDE.md should point at the contract golden + protocol-change policy.
10. **Write `docs/REQUIREMENTS.md`** (v1 Phase 7 item, still open) — consolidate the 7 scattered
    load-bearing constraints: §3 subscription-only billing, daemon-as-permission-authority
    (`settingSources:[]`), Tailscale boundary + identity-gate exceptions, protocol policy
    (v4/additive-or-bump/contract golden), update/rollback guarantees (`UPDATE_API_VERSION=1`, 180s gate,
    prePullSha, hub-last), platform/ship matrix, multi-account blast radius.

Minor CLAUDE.md fixes: **DOC2-2** worktree path is `<stateDir>/worktrees` (default `~/.anvil`), not
`.claude/worktrees` (no such path exists); **DOC2-5** note tokens live in the account roster now.

---

## Rough sequencing

| Phase | Theme | Size | Gate |
|---|---|---|---|
| P0 | Fleet-update integrity + origin gate | 2–3 d | **do first (ship-blocker)** |
| P1 | Crashes & freezes | ~1 wk | P0 |
| P2 | Memory & amplification | ~1 wk | P0 |
| P3 | Update/fleet robustness | 4–5 d | P0 |
| P4 | Scalability | ~1.5 wk | P1 patterns |
| P5 | Coverage | with P0–P4 + ~1 wk standalone | fixture helpers first |
| P6 | CI/CD | 3–4 d | parallel |
| P7 | Maintainability/DRY | ~1.5 wk | P1–P3 tests as safety net |
| P8 | Docs | parallel | — |

P0 is the only true prerequisite. P6 and P8 parallelize immediately. Total ≈ 6–8 focused weeks serial;
much less with parallel tracks. Every item above has a named guard test — implement against the suite.
