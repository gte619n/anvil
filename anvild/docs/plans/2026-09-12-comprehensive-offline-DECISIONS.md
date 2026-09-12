# Comprehensive Offline — Implementation Decision Log

Live log of every non-trivial decision made while implementing
`2026-09-12-comprehensive-offline-mirror.md`, so we can review/tweak after the fact. Newest at
bottom of each phase. Format: **[ID] decision · why · reversible?**

## Phase 0 — setup

- **[D0.1]** Build directly on branch `offline-implementation` (the flaky-fix work already here),
  not a fresh branch. Why: the spec extends this branch's `session.list`/attach fixes, and the mirror
  reuses `convoCache` patterns just added. Reversible: yes (rebase/split later).
- **[D0.2]** Implement in strict dependency order 1→2→3→4, running the done-gate after each phase.
  Why: mirror is the foundation; later phases are pure additions. Reversible: n/a (process).

## Phase 1 — event mirror

- **[D1.1]** Mirror uses its **own IndexedDB database `anvil-mirror`** (stores `meta`/`base`/`tail`),
  separate from convoCache's `anvil` DB. Why: avoids cross-module IDB version-upgrade coordination
  (two modules bumping one DB's version is a footgun); each store owns its lifecycle. Reversible:
  yes (could merge under one coordinated upgrade later).
- **[D1.2]** Mirror eviction/delete/invalidate also remove that session's `anvil.epoch.<id>` /
  `anvil.seq.<id>` localStorage keys. Why: preserve the invariant *no mirror ⇒ no delta-resume* — a
  resume watermark must never outlive the mirror it points into, else attach would delta against an
  empty base. Reversible: yes.
- **[D1.3]** Tail is stored as **folded `ConversationEvent` keyed by `[sessionId, seq]`** (not raw
  wire frames). Why: one render path (`renderSnapshotEvents(base ++ foldedTail)`) reusing the
  existing renderer; the fold mirrors the server's `log.snapshot()` exactly (same 5 persistable
  kinds), so client/server agree on what's durable. `cid` is dropped in the fold — it matters only
  for live optimistic reconciliation, never for offline replay. Reversible: yes.
- **[D1.4]** A lone delta with **no existing base is skipped** (can't establish a mirror from a
  tail). Snapshots establish/replace the base; deltas only extend an existing base. Matches the
  server's snapshot-then-since model. Reversible: yes.
- **[D1.5]** Caps: `MIRROR_MAX_SESSIONS=50`, `MIRROR_MAX_BYTES=256MiB`, `TAIL_COMPACT=500`
  (per spec OD-2). Eviction is LRU by `lastActivityAt`; active + outbox-pinned sessions passed in
  as a `keep` set are never evicted. Reversible: yes (tuning).

- **[D1.6]** Eviction on `session.list` is gated by a **synchronous count check**
  (`mirror.keys().length > cap`) so the async LRU sweep only runs when actually over — cheap to call
  on every connect. Boot-time sweep deferred via `queueMicrotask` (TDZ-safe). Reversible: yes.
- **[D1.7]** `mirrorEpochResets` is marked in the `resume.watermarks` handler when a cached epoch
  differs from the server's — the earliest observable lineage-change point on the client. Reversible:
  yes.
- **[D1.8]** Functional tests use a shared in-memory IndexedDB (`test/web/fake-idb.mjs`, supports
  compound-key cursors + `IDBKeyRange.bound`) so boot-harness tests can seed/inspect the mirror.
  Reused by Phases 2–3. Reversible: yes.
- **Phase 1 DONE-GATE (2026-09-12):** `bun test` 1029 pass / 0 fail / 1 skip · daemon `tsc` 0 · web
  `tsc` 0 · `web/build.ts` 0 · functional `offline-mirror.test.ts` (cold offline boot renders
  base+tail from mirror; online boot delta-resumes without a cold attach) green · mirror unit tests
  10/10.

## Phase 2 — session.history + prefetch

- **[D2.1]** `session.history.events` carries the **raw persisted frames** (`ServerEvent[]`, each with
  `seq`), not folded `ConversationEvent`s — the client's mirror folds them itself, keeping the wire
  identical to what `log.since()` already produces. Reversible: yes.
- **[D2.2]** `supervisor.history()` reuses `log.since`/`log.snapshot` verbatim but omits ALL of
  `resume()`'s side effects (no `attached` add, no trailing `status`, no re-surfaced prompts). Purity
  is asserted on the wire (`resume-wire.test.ts`: no `status` after history). Reversible: yes.
- **[D2.3]** Client picks delta-vs-snapshot (server just honors `sinceSeq`), mirroring the existing
  attach contract — the server's resume path also trusts the client's epoch guard. Reversible: yes.
- **[D2.4]** Added `mirror.setCovered()` so a completed delta advances coverage to the server watermark
  even when the last durable event's seq trails it (server `lastSeq` counts transient seqs the mirror
  never stores). Without it the mirror could never be marked complete. Reversible: yes.
- **[D2.5]** Prefetch trigger = the `session.list` handler (fires every connect, watermarks already in),
  idle-scheduled via `requestIdleCallback` (2s fallback). Gate reads `anvil.prefetch`
  (`all`|`wifi-only`|`off`, default `all`) + honors `navigator.connection.saveData`. Reversible: yes.
- **[D2.6]** The golden-regen command in the repo (`bun test/contract/regen-golden.ts`) is broken under
  this Bun (it imports a file that calls `test()` at top level → "Cannot use test outside the test
  runner"). Regenerated the golden with a standalone script using the same extraction regex; result is
  byte-identical in form (PROTOCOL_VERSION stayed 4, 3 wire types added). **Flag for review:** the
  documented regen path needs a fix (extract `extractWireTypes` into a non-test module). Reversible: yes.
- **Phase 2 DONE-GATE (2026-09-12):** `bun test` 1041 pass / 0 fail / 1 skip · daemon+web `tsc` 0 ·
  `web/build.ts` 0 · functional `offline-prefetch.test.ts` (never-viewed session pulled into mirror on
  connect, active excluded) green · `prefetch.test.ts` 8 unit · `resume-wire.test.ts` +3 history cases.

## Phase 3 — shadow subscriptions

- **[D3.1]** Shadow copies fan out from **inside `registry.toAttached`** (an `else` branch after the
  attached check), so a conn that is both attached and shadow-subscribed gets exactly one copy. Only
  `isShadowable` kinds (the 5 durable ones) shadow — never `assistant.delta`/control frames — and every
  shadow copy is unconditionally droppable. Reversible: yes.
- **[D3.2]** Client DOM safety needed no new guard: `onEvent`'s existing `default` branch already drops
  session-scoped events whose `sessionId !== activeId`. The mirror apply happens earlier (top of
  `onEvent`), so a shadow frame updates the mirror then is dropped from the DOM. Added only a
  `shadowEvents` telemetry mark there. Reversible: yes.
- **[D3.3]** Mirror-apply epoch source switched to `serverWatermarks.get(id)?.epoch ?? epochStore.get`
  — the live authoritative epoch — so a shadow frame for a non-active session applies under the right
  lineage (epochStore might lag for a background session). Reversible: yes.
- **[D3.4]** `shadow.subscribe` sent from the `server.hello` handler (first frame per connect →
  re-subscribes every reconnect). Scope `"all"` normally; bounded top-`PREFETCH_MAX_SESSIONS` on a
  metered/save-data link; skipped when `anvil.prefetch === "off"`. Reversible: yes.
- **[D3.5]** `shadowDegraded` marked in prefetch when a session with a current-lineage mirror
  (`mirrorLastSeq>0`, same epoch) is found behind at plan time — a shed/missed shadow frame. Cold /
  lineage-reset mirrors are excluded (first-fill, not degradation). Reversible: yes.
- **Phase 3 DONE-GATE (2026-09-12):** `bun test` 1049 pass / 0 fail / 1 skip · daemon+web `tsc` 0 ·
  `web/build.ts` 0 · `registry-shadow.test.ts` 7 unit (fanout, delta-excluded, droppability,
  attached-wins) · `shadow-mirror.test.ts` functional (shadow push advances B's mirror, no DOM churn).

## Phase 4 — Android + artifacts

- **[D4.1]** REST history endpoint `GET /api/sessions/:id/history?sinceSeq=` added to the http route
  table, reusing `supervisor.history()` verbatim (same semantics as the WS command, GET-only so it
  rides the same Tailscale boundary as the attachments GET). Integration-tested. Reversible: yes.
- **[D4.2]** SW artifact cache: immutable session attachments (`/api/sessions/*/attachments/*`, served
  `max-age=31536000`) cached cache-first in a dedicated **version-independent** `anvil-artifacts` cache,
  exempted from the activate-sweep, with a `forget-session` message hook (fired from
  `forgetConvoState`). The blanket `/api/*` no-cache rule is otherwise untouched. Build-verified;
  runtime behaviour is manual (no SW test harness in the repo — consistent with sw.js having no tests).
- **[D4.3] Phase 4a native closed-app sync — IMPLEMENTED, NOT VERIFIED HERE.** This environment has no
  Android SDK/Gradle/emulator, and there is native Android CI that unverified Kotlin would turn red, so:
  (a) NO new Gradle dependency (WorkManager was the spec's suggestion; I used a stdlib `Thread` +
  staged-file handoff instead — same effect, zero new deps, nothing to break the build); (b) the Android
  change is a **purely additive branch** (`kind == "sync"` in `AnvilMessagingService`) that no-ops unless
  the daemon sends that kind, so it cannot alter existing push behaviour; (c) the web-side apply hook
  (`window.__anvilApplyStagedHistory`) IS typecheck-verified. Per spec §4.4a (best-effort, "asserted in
  an instrumented build, not CI") and OD-5 (4a explicitly optional), this is flagged for an
  instrumented-build pass; the connect-time prefetch (Phase 2, verified) remains the actual guarantee —
  4a only narrows the cold-open gap. **Daemon sync-hint emit was NOT added**: the existing session-
  activity FCM pushes already wake the app, so the client treats any push carrying a `sessionId` as a
  sync trigger — no daemon change, no new throttle needed. Reversible: yes (delete the branch + hook).
- **[D4.4]** REST history returns the **same wire-event shape** as the WS `session.history` response
  (`type: "session.history.snapshot"|".events"`), not `supervisor.history()`'s raw `{kind}` — so the
  client's `applyHistoryToMirror` path is identical whether a batch arrives over WS or REST. Reversible:
  yes.
- **Phase 4 DONE-GATE (2026-09-12):** `bun test` 1050 pass / 0 fail / 1 skip · daemon+web `tsc` 0 ·
  `web/build.ts` 0 (validates the modified sw.js copy) · `history-rest.test.ts` (REST snapshot/delta/404).
  Android native = implemented, unverified here (see [D4.3]).
