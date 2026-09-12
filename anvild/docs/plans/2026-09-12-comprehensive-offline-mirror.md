# Comprehensive Offline: Client Event Mirror, Greedy Prefetch & Shadow Push

- **Status:** Built (Phases 1–3 + 4 server/web fully verified; 4a Android native implemented,
  instrumented-build-pending) — spec-critique gate (§9) still unrun · **Owner:** Evan · **Branch:**
  `offline-implementation`
- **Created:** 2026-09-12 · **Supersedes/extends:** extends `incremental-offline-resilience.md`
  (protocol v4, shipped 2026-08); **supersedes its decisions D1 (last-viewed-only scope) and D8
  (HTML-blob-as-primary-cache)**. The v4 seq/epoch/watermark machinery is the foundation here, not
  replaced.

## 1. Objective & non-goals

Today Anvil offline means "the last conversation you looked at, mostly." After this program, a
client that loses its link — flaky Tailscale, cellular dead zone, backgrounded Android app — can
open **any recently-active session** and read its full transcript, exactly as the daemon last knew
it, with missing tails appended (never repainted) when the link returns. While connected, the
client stays warm **without the user touching anything**: recent sessions sync in the background,
and (Phase 3) durable events land in the local store the moment they happen.

The architecture principle, applied three times already in this codebase (outbox cid-dedupe,
v4 delta-resume, droppable `assistant.delta`): **push for freshness, pull for truth.** Every
background mechanism in this spec is an optimization layered on one load-bearing guarantee — a
watermark-driven pull reconciliation that converges from *any* client state.

### Non-goals

- **Not an offline write expansion.** The outbox already handles offline sends; this spec does not
  add offline session-create flows, offline permission responses, or any new queued-write class.
- **Not server-side log compaction or `since()` re-indexing.** Same deferral as v4 (its D7). The
  server's O(history) attach read is a known cost, unchanged here.
- **Not a sync engine for shared/multi-user state.** Prompts, environments, accounts already have
  hub-authoritative broadcast; untouched.
- **Not offline media generation.** Artifact caching (Phase 4b) caches what was already fetched or
  prefetches small thumbnails; it does not guarantee every attachment of every session offline.
- **No protocol version bump.** v4 floor semantics + additive, capability-gated surface only. A
  mixed fleet (upgraded hub, stale member) degrades per-server to today's behavior.

## 2. Context

- **Prior art:** `incremental-offline-resilience.md` built the machinery this spec feeds on:
  per-session monotonic `seq` (minted only in `Session.emit`), `epoch` lineage tokens,
  `resume.watermarks` on every connect, delta-vs-snapshot resume (`supervisor.resume`), the
  IndexedDB rendered-HTML cache (`web/src/convoCache.ts`), and resilience telemetry.
- **This branch (2026-09-12):** fixed the flaky-link blank pane — deferred cold attach when no
  watermark is held, 500ms cache-paint budget, paint-on-disconnect, and the `session.list` prune
  guard that was wiping resume state for still-listed sessions on every connect
  (`test/web/flaky-attach.test.ts` covers the whole path). Result: reconnects now genuinely
  delta-append. This spec builds on that behavior.
- **Why now:** the v4 scope decision (D1: last-viewed only) was the right cut then; the remaining
  pain is every *other* session going stale, and the Android WebView being killed so often that
  "last viewed" is frequently cold too.
- **Key structural fact discovered during design:** the persisted event log has **seq gaps by
  design** — transient events (`assistant.delta`, `terminal.*`, `fs.changed`) mint seqs but are
  never persisted (`eventlog/log.ts` SKIP_PERSIST). Therefore the client can never distinguish "gap
  because transient" from "gap because a frame was dropped" by inspecting seqs alone. **Mirror
  completeness must be anchored on pull reconciliation against the server watermark, not on local
  contiguity checks.** This is why push (Phase 3) is spec'd as a freshness hint, never a
  correctness mechanism.

## 3. Inputs & scope

- **In scope (files/modules/systems):**
  - Client: `web/src/convoCache.ts` (superseded by new `web/src/mirror.ts`), `web/src/main.ts`
    (attach/prefetch orchestration), `web/src/conversation.ts` (render-from-events path already
    exists as `renderSnapshotEvents` — reused), `web/src/telemetry.ts` (new counters), `web/sw.js`
    (Phase 4b only).
  - Server: `protocol.ts` (additive types), `src/server/dispatch.ts` (new `session.history`
    command), `src/server/registry.ts` (shadow recipient set, Phase 3), `src/server/identity.ts`
    (`SERVER_CAPABILITIES` additions), `src/session/supervisor.ts` (history resolution — reuses
    `resume()` internals).
  - Android (Phase 4a only): `AnvilMessagingService.kt`, new WorkManager job, `MainActivity.kt`
    handoff.
- **Out of bounds (must not modify):**
  - `test/contract/protocol-surface.golden.json` except via `test/contract/regen-golden.ts`.
  - The outbox write path (`web/src/outbox.ts`, flush orchestration) — read-only dependency.
  - Registry backpressure caps (1 MiB soft / 8 MiB hard) — Phase 3 must live within them.
  - The Tailscale trust model — no per-request auth added anywhere (see §6).
- **Available inputs/tools/data:** `resume.watermarks` (complete per-session `{epoch,lastSeq}` on
  every connect), `seqStore`/`epochStore` (client-persisted watermarks), `supervisor.resume()`
  (exact replay semantics wanted for history), existing boot-harness test rig
  (`test/web/boot-bundle.ts` + jsdom node runner), FCM pipeline (Android).
- **Assumptions log:**
  - ~~*Folded snapshot events retain their original `seq` fields*~~ — **verified FALSE**
    (2026-09-12): `eventlog/log.ts` `snapshot()` folds to `ConversationEvent` shapes carrying `ts`
    but no per-event `seq`; only the envelope carries `lastSeq`, and folding is lossy (drops
    `tool.use`, permission, status events). Consequence: the mirror stores a **base snapshot blob +
    seq-keyed delta tail** (§4.1), mirroring the server's own snapshot+since model, instead of a
    single keyed event store. No server change needed.
  - *IndexedDB quota on target devices comfortably holds ~50 sessions of events* (text-dominated;
    attachments excluded). Default caps below sized to this; eviction handles the rest. Confirmed
    only by order-of-magnitude estimate.
  - *A member daemon lists at most low-hundreds of sessions*, so the prefetch work-list scan is
    trivially cheap. Matches observed fleet usage; unconfirmed at scale.

## 4. Design

### 4.1 The event mirror (client) — Phase 1

A per-session mirror of the daemon's persisted log, stored in IndexedDB, replacing the rendered-HTML
blob as the **source of truth** for offline paint. The HTML cache survives only as a paint
accelerator (instant `innerHTML` restore), now derivable and always droppable.

The mirror stores exactly what the server's resume model produces — a **base + tail**, because
folded snapshots carry no per-event seqs (see Assumptions log):

```ts
// web/src/mirror.ts — authoritative shapes
interface MirrorMeta {
  sessionId: string;
  epoch: Epoch;          // lineage token; mismatch with server ⇒ mirror invalid, full refetch
  baseSeq: Seq;          // the lastSeq the stored base snapshot covers (0 = no base)
  lastSeq: Seq;          // highest seq APPLIED (base or tail); tail spans (baseSeq, lastSeq]
  serverUrl: string;     // owning daemon (multi-server routing)
  lastActivityAt: string;// eviction ordering (mirrors Session.lastActivityAt)
  bytes: number;         // approximate stored size, maintained on write (eviction input)
  completeAt: string;    // last successful reconciliation timestamp (staleness display)
}
// IDB db "anvil" (existing), new stores:
//   "mirror-meta"  key: sessionId        → MirrorMeta
//   "mirror-base"  key: sessionId        → ConversationEvent[] (folded snapshot, verbatim)
//   "mirror-tail"  key: [sessionId, seq] → SessionEvent (raw wire frame: message.user,
//                                          assistant.message, tool.result, result, file.offer)
// localStorage "anvil.mirror.index" → sessionId[] (sync boot hint, same pattern as convoCache)
```

Semantics:

- **Snapshot apply** replaces the base (`baseSeq = lastSeq = snapshot.lastSeq`) and clears tail
  entries `≤ baseSeq`. **Tail apply** is an idempotent put keyed `(sessionId, seq)` for the
  persistable event types only (same set the server's log keeps); re-receiving is a no-op, so
  overlapping push and pull is always safe. Render = replay base, then tail in seq order — the
  exact composition `supervisor.resume` produces on the wire.
- **Completeness is a pull-derived property:** the mirror for session S is *complete as of* the
  moment a reconciliation observed `server.lastSeq(S) === meta.lastSeq(S)` under a matching epoch.
  No contiguity inference (see §2 seq-gap fact). An unbounded tail is folded away by requesting a
  fresh snapshot when `tailCount > TAIL_COMPACT_THRESHOLD = 500` (client-side "compaction" by
  re-snapshot; OD-2).
- **Epoch mismatch** (watermark says a different epoch): drop the session's events + meta, refetch
  full. Identical policy to v4's `canDeltaResume` guard, applied to storage.
- **Eviction:** LRU by `lastActivityAt`, caps `MIRROR_MAX_SESSIONS = 50` and
  `MIRROR_MAX_BYTES = 256 MiB` (defaults, Open Decision OD-2). The active session and any session
  with queued outbox items are never evicted. Eviction removes meta + events + HTML cache together
  (extends `forgetConvoState`).
- **Render path:** opening a session offline (or pre-validation) renders from mirror events via the
  existing `renderSnapshotEvents` replay (batched, scroll-once — already the snapshot path). The
  HTML accelerator, when present and epoch-valid, paints first exactly as today; the mirror is what
  makes it *rebuildable* and removes the 200-node serialization cap from correctness (the cap stays
  for the accelerator only).
- **Migration:** existing `convoCache` HTML entries stay valid as accelerators; mirrors backfill
  lazily via prefetch. No migration step; `anvil.convo.index` retained.

### 4.2 `session.history` + greedy prefetch (pull) — Phase 2

**Protocol (additive, capability `"history"`):**

```ts
// Client → server. Like session.attach's resume semantics, WITHOUT subscription side effects:
// no attach-set membership, no live status append, no parked permission/question re-surfacing.
interface SessionHistoryCommand { type: "session.history"; sessionId: SessionId; sinceSeq?: Seq; cid: Cid }
// Server → client (cid-correlated):
//   sinceSeq given & epoch-compatible → { type: "session.history.events", events, lastSeq, epoch, cid }
//   else                             → { type: "session.history.snapshot", snapshot: ConversationSnapshotEvent, cid }
// Resolution reuses supervisor.resume()'s log access verbatim (log.since / log.snapshot).
```

Registered in `SERVER_CAPABILITIES` as `"history"`; `server.hello` advertises it; the client
prefetches only against servers that do. A stale member simply keeps today's behavior.

**Prefetcher (client, `web/src/prefetch.ts`):**

- **Trigger:** per-server, after `resume.watermarks` + `session.list` land on a `connected` socket.
  Work-list = sessions on that server where `mirror.lastSeq < watermark.lastSeq`, or no mirror, or
  epoch mismatch; ordered by `lastActivityAt` desc; capped at `PREFETCH_MAX_SESSIONS = 20` per
  connect (OD-3).
- **Scheduling:** strictly serialized — one in-flight `session.history` per server, next request
  issued from an idle callback (`requestIdleCallback`, 2s timeout fallback). Never runs while the
  active session has an unanswered attach/snapshot outstanding; live traffic always wins.
- **Flake-tolerance:** each request rides `sendAwait` (20s cid timeout). Timeout or
  `command.error` → drop the remainder of this connect's work-list (do NOT retry-loop a dying
  link); the next connect rebuilds the list from fresh watermarks. Self-healing by construction.
- **Write path:** events → mirror apply → meta advance → (active session only) DOM append via the
  normal event path. Background sessions touch storage only — no DOM work.
- **Cellular/metered gate (Android):** prefetch respects `navigator.connection?.saveData` and a
  Settings toggle (`anvil.prefetch = "all" | "wifi-only" | "off"`, default `"all"`; OD-4).

### 4.3 Shadow subscriptions (push) — Phase 3

**Protocol (additive, capability `"shadow"`):**

```ts
// Client → server, once per connection (re-sent on reconnect):
interface ShadowSubscribeCommand { type: "shadow.subscribe"; sessionIds: SessionId[] | "all" }
// Server behavior: for each session event that IS persisted (not in SKIP_PERSIST), also send it to
// shadow-subscribed connections that are not attached. Droppable classification: ALL shadow frames
// are droppable under backpressure (soft-cap shedding) — pull reconciliation is the safety net.
```

- **Registry:** `toAttached` gains a shadow recipient pass — second `Set` per conn
  (`ws.data.shadowed`), same fanout loop, `droppable = true` unconditionally for shadow copies.
  Backpressure caps unchanged; a shadowed client under pressure silently degrades to Phase-2
  behavior (next connect's prefetch catches it up) — **this degradation is by design and must not
  be "fixed"**.
- **Client:** shadow frames route straight to the mirror (`sessionId` ≠ active) — no DOM, no
  seqStore interference with the active session's resume bookkeeping beyond the mirror meta.
  `meta.lastSeq` advances on apply; `completeAt` does **not** (only reconciliation sets it —
  keeping "fresh" and "verified complete" distinct).
- **Sidebar freshness win:** shadowed `message.user`/`assistant.message` frames let the session
  list show accurate last-activity/preview without polling — free UI improvement, same frames.
- **Default scope:** `"all"` on desktop/web; top-`PREFETCH_MAX_SESSIONS` recent on Android
  (OD-4's toggle governs both).

### 4.4 Android closed-app sync + artifact caching — Phase 4 (optional polish)

- **4a — FCM-triggered native sync:** daemon sends an FCM *data* message (no notification) on
  durable session activity, throttled to ≥ 1/15min per device per session. `AnvilMessagingService`
  enqueues a WorkManager one-shot (constraints: network) that calls a REST mirror of
  `session.history` (`GET /api/sessions/:id/history?sinceSeq=`) and writes results to an app-private
  staging file; `MainActivity` hands staged batches to the web layer on next boot via
  `WebMessageListener` → mirror apply (idempotent, so double-delivery is harmless). Honest framing:
  FCM is best-effort and Doze throttles WorkManager — this narrows the cold-open gap, it does not
  close it; the connect-time prefetch remains the guarantee.
- **4b — Artifact cache (service worker):** new SW route: cache-first for
  `/api/sessions/:id/files/*` responses **only when tagged immutable** (content-addressed or
  versioned), stored in a dedicated `anvil-artifacts` cache, evicted when the web layer posts a
  `forgetSession` message (hooked from `forgetConvoState`). The blanket `/api/*` no-cache rule
  stays for everything else — the control plane exclusion is untouched.

### 4.5 Telemetry (all phases)

New counters (pattern: `web/src/telemetry.ts`, daemon aggregation via existing `telemetry.report`):
`prefetchSessions`, `prefetchEvents`, `prefetchAborts`, `mirrorEvictions`, `mirrorEpochResets`,
`shadowEvents`, `shadowDegraded` (soft-cap sheds observed via reconciliation delta > 0),
`offlineMirrorOpens` (session opened offline from mirror — the headline number).

## 5. Deliverables & phases

Each phase independently shippable; later phases are pure additions.

### Phase 1 — Event mirror (client storage foundation)

| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| ~~Verify A1~~ resolved at spec time: folded snapshots carry no seqs → base+tail design (§4.1) | ✓ | n/a | |
| `web/src/mirror.ts` (meta/base/tail stores, apply, compact, evict, epoch-invalidate, index) | ✓ | ✓ | |
| Route active-session snapshot/delta/live events into mirror apply | ✓ | ✓ | |
| Offline open renders from mirror when HTML accelerator absent/invalid | ✓ | ✓ | |
| Eviction sweep on boot + on `session.list` prune (extends `forgetConvoState`) | ✓ | ✓ | |
| Telemetry: `mirrorEvictions`, `mirrorEpochResets`, `offlineMirrorOpens` | ✓ | ✓ | |

**Acceptance:** with the daemon reachable, view session S fully; kill the link; reload the app
(cold boot, HTML accelerator deleted manually); opening S renders the complete transcript from the
mirror. Delivering an epoch-changed watermark then drops the mirror and a fresh snapshot repaints.
**✓ VERIFIED 2026-09-12** — `mirror.test.ts` (10 unit) + `offline-mirror.test.ts` (2 functional); full done-gate green.

### Phase 2 — `session.history` + prefetch (pull; the robustness core)

| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Protocol types + golden regen (`session.history*`, capability `"history"`) | ✓ | ✓ | |
| Dispatch + supervisor resolution (no subscription side effects) | ✓ | ✓ | |
| `web/src/prefetch.ts` (work-list from watermarks, serialized, idle-scheduled, flake-abort) | ✓ | ✓ | |
| Metered/Settings gate (`anvil.prefetch`) | ✓ | ✓ | |
| Telemetry: `prefetchSessions/Events/Aborts` | ✓ | ✓ | |

**Acceptance:** two sessions A (viewed) and B (never viewed this boot) exist with history; connect;
within seconds and with zero user action, killing the link and opening B renders B's full
transcript offline. A server without the `"history"` capability produces zero `session.history`
frames (behavior identical to today).
**✓ VERIFIED 2026-09-12** — `prefetch.test.ts` (8 unit incl. gate/capability skip + flake-abort +
single-flight), `offline-prefetch.test.ts` (functional: B prefetched on connect, active excluded),
`resume-wire.test.ts` (+3: history purity — no status side-effect, delta/snapshot, unknown→error).

### Phase 3 — Shadow subscriptions (push freshness)

| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Protocol types + golden regen (`shadow.subscribe`, capability `"shadow"`) | ✓ | ✓ | |
| Registry shadow set + unconditionally-droppable fanout pass | ✓ | ✓ | |
| Client subscribe-on-hello + mirror routing (no DOM for background sessions) | ✓ | ✓ | |
| Sidebar last-activity/preview from shadow frames | n/a¹ | | |
| Telemetry: `shadowEvents`, `shadowDegraded` | ✓ | ✓ | |

¹ Sidebar preview from shadow frames: session metadata (title/last-activity) already rides
`session.updated`/`session.list`, so the sidebar stays fresh without extra wiring; a per-message
preview snippet was descoped as cosmetic (not needed for offline correctness).

**Acceptance:** with A active and B shadowed, drive a turn in B from a second client; the first
client's mirror for B advances (observable via diagnostics panel) with no attach and no DOM churn;
kill the link immediately after; B opens offline including the just-pushed turn. Under a simulated
1 MiB backpressure buffer, shadow frames shed, nothing errors, and the next connect's prefetch
reconciles B exactly (registry-backpressure test pattern reused).
**✓ VERIFIED 2026-09-12** — `registry-shadow.test.ts` (7 unit: fanout, delta-excluded, droppable-shed
vs attached-delivered, attached-wins), `shadow-mirror.test.ts` (functional: shadow push advances B's
mirror to seq 8, no DOM churn, subscribe-on-connect); backpressure-shed→prefetch-reconcile covered by
registry-shadow droppability + `prefetch.test.ts`.

### Phase 4 — Android closed-app sync + artifact cache (polish; ship independently)

| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| REST `GET /api/sessions/:id/history` (same wire shape as the WS command) | ✓ | ✓ | |
| FCM-triggered fetch (Thread + staging handoff — no WorkManager dep) + web apply hook | ✓¹ | ✓² | |
| SW `anvil-artifacts` cache-first route + forget hook | ✓ | ✓³ | |

¹ Android native (Net.getString, HistorySync, AnvilMessagingService branch, MainActivity onPageFinished
inject) is IMPLEMENTED but **not verified in this environment** (no Android SDK/Gradle here). Purely
additive + stdlib-only + no new Gradle deps, so it can't break the existing build; flagged for an
instrumented-build pass ([D4.3]). No daemon sync-hint added — existing activity pushes already wake the
app. ² The web apply hook (`window.__anvilApplyStagedHistory` → `applyHistoryToMirror`) is
typecheck-verified and reuses the prefetch write path. ³ SW build-verified; runtime is manual (repo has
no SW test harness).

**Acceptance (4a):** with the app fully backgrounded, drive a turn; foreground the app in airplane
mode; the new turn is present. **(4b):** view a session with a screenshot; go offline; reload; the
screenshot renders from cache. (4a acceptance is best-effort-flagged: asserted in an instrumented
build, not CI.)
**✓ VERIFIED (server + web) 2026-09-12** — `history-rest.test.ts` (REST returns WS-symmetric
snapshot/delta, 404 unknown); SW + Android flagged per ¹³ above.

## 6. Constraints

- **Security boundary unchanged:** Tailscale is the accepted boundary (memory:
  `tailscale-is-accepted-security-boundary`) — no per-request auth on `session.history` (WS or
  REST). The REST history endpoint carries the same exposure as the existing attach path.
- **Protocol discipline:** additive surface only; every wire change lands via
  `test/contract/regen-golden.ts`; `PROTOCOL_VERSION` stays 4; new commands are capability-gated so
  mixed fleets degrade per-server, never break.
- **Backpressure inviolable:** shadow fanout must not alter the 1 MiB/8 MiB caps or add buffering;
  shedding shadow frames is correct behavior.
- **Main-thread budget:** background mirror writes must not run DOM work; prefetch is serialized
  and idle-scheduled; per-event apply cost stays O(1) puts (no full-store rewrites).
- **Storage budget:** hard caps + LRU eviction (OD-2); quota errors are best-effort-swallowed
  exactly like `convoCache` today — a failed mirror write can only ever cost freshness, never
  correctness (pull re-derives).
- **Android reality:** UI ships in the APK (memory: `android-app-bundles-web-ui`) — Phases 1–3
  reach the phone only via an APK reship; release notes must say so.
- **Battery/data:** no polling loops anywhere; every network action is connect-triggered,
  push-triggered, or user-triggered; metered gate honored on Android.

## 7. Edge cases & failure modes

| # | Scenario | Expected behavior | Covered by |
|---|---|---|---|
| E1 | Crash/kill mid-prefetch (IDB batch partially applied) | Idempotent keyed puts; meta.lastSeq advances only after its batch commits; next connect re-pulls from meta.lastSeq — duplicates no-op | mirror unit test (crash-replay) |
| E2 | Epoch reset arrives while that session's prefetch is in flight | cid-correlated response carries epoch; mismatch with current watermark ⇒ discard batch, invalidate mirror, re-request full | prefetch unit test |
| E3 | Half-open socket during prefetch | `sendAwait` 20s timeout aborts the work-list; no retry storm; heartbeat reconnect (existing) rebuilds list from fresh watermarks | flaky-attach harness extension |
| E4 | Shadow frame arrives for an evicted/never-mirrored session | Apply creates meta lazily iff session is in `sessions` map and passes the scope gate; else frame dropped (pull will cover it if it matters) | mirror unit test |
| E5 | Persisted frame dropped by soft-cap shedding while shadowed | Undetectable locally (seq gaps ambiguous — §2); `completeAt` stays stale; next reconciliation pulls the exact miss; `shadowDegraded` marks it | Phase 3 acceptance (backpressure sim) |
| E6 | Session deleted while mirrored | `session.list` prune (fixed this branch, `!listed` guard) → `forgetConvoState` → mirror + artifacts dropped | flaky-attach test (prune phase) extension |
| E7 | Offline-created session (temp id) later realized | Mirror `move(from,to)` mirrors `convoCache.move` in the existing tempId reconcile path | outbox reconcile test extension |
| E8 | Quota exhausted mid-apply | Write fails silently (best-effort), telemetry marks, eviction sweep runs; correctness preserved via pull | mirror unit test (throwing IDB fake) |
| E9 | Multi-server: same-named session ids on hub + member | All mirror keys scoped by namespaced sessionId (#158 namespacing already guarantees uniqueness); `meta.serverUrl` routes reconciliation | prefetch unit test |
| E10 | Duplicate triggers (watermarks re-delivered, overlapping connects) | Work-list rebuilt per connect; in-flight serialization per server; keyed idempotent applies | prefetch unit test |
| E11 | Stale/corrupt mirror meta (bad JSON, impossible seq) | Treat as absent: invalidate session mirror, telemetry `mirrorEpochResets`, refetch — quarantine-by-deletion, matching v4 posture | mirror unit test |
| E12 | Gamed-spec case | "Comprehensive offline" satisfied by mirroring only tiny/empty sessions while big ones evict instantly, or `completeAt` set without observing the watermark equality. Guards: acceptance tests use multi-hundred-event sessions; `completeAt` may be set in exactly one code path (reconciliation observing `server.lastSeq === meta.lastSeq`), asserted by unit test | acceptance + unit |

## 8. Evaluation & verification

- **Technical (unit):** `mirror.ts` (apply idempotency, eviction order + pinning, epoch
  invalidation, corrupt-meta quarantine, quota fallback — jsdom + throwing-IDB fake, pattern:
  `convoCache.test.ts`); `prefetch.ts` (work-list derivation from watermark fixtures, serialization,
  abort-on-timeout, capability gate); registry shadow fanout (recipient sets, unconditional
  droppability — pattern: `registry-backpressure.test.ts`); protocol shapes via golden regen.
- **Functional:** extend the flaky-attach boot harness (`test/web/flaky-attach.test.ts` rig): boot
  real bundle → deliver watermarks/list → observe `session.history` requests → deliver history
  frames → kill socket → assert offline open of a *non-active* session renders its transcript.
  Phase 3 adds the backpressure-shed + reconcile scenario. Daemon side: integration test driving
  `session.history` through dispatch against a real EventLog (pattern: `resume-wire.test.ts`).
- **Done-gate (per phase):** `bun test` 0 fail · `tsc --noEmit` (daemon + web) exit 0 ·
  `bun run web/build.ts` clean · this phase's functional scenario green, evidence pasted into the
  phase table · fresh-context adversarial review against the Acceptance row, with veto.

## 9. Spec-critique gate (before any build)

- **Critique round 1:** _not yet run._ Requested focus areas for the critic: (a) the seq-gap
  ambiguity argument in §2 — is pull-anchored completeness actually airtight against a shed
  *persisted* frame followed by a matching-lastSeq coincidence? (b) IDB write-ordering assumptions
  in E1; (c) whether `"all"` shadow scope on a many-session hub violates the backpressure budget in
  realistic fleets.

## 10. Open decisions (defaults assumed unless you object)

- **OD-1 — `session.history` transport:** WS command (chosen) vs REST-only. WS reuses cid
  correlation + capability gating for free; REST added only in Phase 4a where a socketless caller
  exists.
- **OD-2 — Mirror caps:** 50 sessions / 256 MiB / LRU by `lastActivityAt`, active + outbox-pinned
  sessions exempt; tail re-snapshot compaction at 500 tail events. Pure tuning; revisit with
  telemetry.
- **OD-3 — Prefetch breadth:** 20 sessions per connect, serialized single-flight per server.
  Deliberately conservative — freshness beyond that arrives via Phase 3.
- **OD-4 — Android defaults:** prefetch `"all"` (Tailscale traffic is usually wifi-class), shadow
  scope top-20; single Settings toggle governs both. Flip to `"wifi-only"` if data telemetry says
  otherwise.
- **OD-5 — Phase 4a inclusion:** spec'd but explicitly optional; it's the only phase whose
  guarantee is best-effort. Skipping it loses closed-app freshness on Android, nothing else.
