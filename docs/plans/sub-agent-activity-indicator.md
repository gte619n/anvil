# Sub-Agent Activity Indicator — Specification & Delivery Plan

- **Status:** Built & automated-verified 2026-09-16 — Phases 0–5 complete and green (unit + contract + functional replay + production build). Phase 6 operator steps (live-on-real-daemon screenshots, Android on-device reship, PR) remain. See the implementation decision log: `sub-agent-activity-indicator-decision-log.md`.
- **Branch:** `sub-agent-indicator`
- **Owner:** Evan Ruff
- **Author of spec:** Claude (PM + senior dev pairing)
- **Related memory:** [[thinking-indicator-reconnect-gap]], [[offline-staged-sync-watermark-poison]], [[anvil-hidden-attr-css-override]], [[android-app-bundles-web-ui]], [[skills-via-plugins-not-settingsources]]

---

## 1. Problem statement

When a turn delegates work to sub-agents (the Claude Agent SDK `Task`/`Agent` tool), the web/Android UI appears **frozen**. The last visible assistant prose is something like:

> "167 mutating mappings across 63 controllers — too many to classify by hand reliably. Let me delegate the full audit to a subagent with a strict schema…"

…and then **nothing** renders until every sub-agent has completed. During a long parallel fan-out this can be minutes of apparent death. There is no signal of how many sub-agents are running, what they are doing, or whether progress is being made.

**Root cause (confirmed in code):**
- The daemon's SDK→protocol translator, `mapMessage` (`anvild/src/agent/map.ts`), **discards** the sub-agent linkage (`parent_tool_use_id`) on assistant/user messages and returns `[]` for the SDK's live heartbeat messages (`tool_progress`, `thinking_tokens`, sub-agent `stream_event`). So sub-agent activity is either flattened indistinguishably into the parent's activity block or dropped entirely.
- The web pane's thinking/activity indicator (`anvild/web/src/conversation.ts`, `showThinking`/`ensureActivity`) is driven only by top-level `status` and `tool.use`/`tool.result` events, so during an SDK-orchestrated sub-agent turn it has nothing to show.

## 2. Enabling discovery (why this is feasible)

The installed SDK — `@anthropic-ai/claude-agent-sdk@^0.3.183` — **already surfaces** sub-agent telemetry (verified in `sdk.d.ts`):

| SDK signal | Shape | Use |
| --- | --- | --- |
| Sub-agent `tool_use`/`tool_result` | `SDKAssistantMessage`/`SDKUserMessage` with `parent_tool_use_id` set + `subagentType` | Identify a sub-agent, its type, and count its steps. Emitted **by default** ("enough for a heartbeat counter"). |
| `SDKToolProgressMessage` | `{ type: 'tool_progress', tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds, task_id }` | Live "still alive, doing X, N seconds" heartbeat. |
| `SDKThinkingTokensMessage` | `{ type: 'system', subtype: 'thinking_tokens', estimated_tokens, … }` | Optional liveness pulse while a sub-agent is thinking (no tool running). |
| `forwardSubagentText` option | `Options.forwardSubagentText?: boolean` | (Not used in phase 1 — would forward full nested prose/thinking. Kept out per fidelity decision.) |

**Consequence:** the raw material exists on the wire. The work is (a) parse/keep the linkage in the daemon, (b) ship it to clients on a live channel, (c) render it in the pane.

---

## 3. Decision log (locked in interview 2026-09-16)

| # | Decision | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | **Scope of "sub-agent"** | SDK `Task`/`Agent` tool sub-agents **only**. Anvil "team members" (`create_member`, first-class sessions) are explicitly **out of scope**. | Matches the actual complaint; team members already appear in the sidebar as sessions. |
| D2 | **Fidelity** | **Live activity line** per sub-agent: label (type + description), current tool being run, and a step count. Not just a bare counter; not a full nested transcript. | Answers "what is each one doing" without transcript noise or extra wire cost. |
| D3 | **"Completion estimate"** | **Running-vs-done count + terminal state**. No ETA. Elapsed time may be shown as a small secondary detail, never a predicted finish. | SDK gives no true ETA; a fake one misleads. Honest liveness beats guessed timers. |
| D4 | **UI placement** | **Nested inside the existing collapsible activity block.** A `Task` tool_use expands in place into a group of its child sub-agents and their steps. | Reuses the established `<details class="activity">` pattern; keeps it in conversation flow. |
| D5 | **Event channel** | **Ephemeral live-only.** Progress broadcasts via `sink()` **without** minting `seq` or appending to the durable log. | Avoids poisoning offline/delta-resume watermarks (a class of bug already hit — see [[offline-staged-sync-watermark-poison]]). Progress is transient by nature. |
| D6 | **Labeling** | **Description + type**, e.g. `Explore · "Audit mutating mappings"`. Fall back to `type #index` when the Agent tool's `description` is absent. | Most human-meaningful; degrades gracefully. |
| D7 | **Failure UX** | **Distinct terminal states** per sub-agent: done `✓`, error `⚠` (with reason), canceled `⊘`. Failures remain visible after the turn. | So a user can see *what broke* in a fan-out, not just a vanished row. |
| D8 | **Client target** | **Web implementation**; Android rides the same bundle. **Android on-device verification + APK reship is an in-scope done-gate.** | Android serves the web UI from APK assets — see [[android-app-bundles-web-ui]]; daemon updates don't reach the phone. |
| D9 | **Reconnect / late-join** | **Daemon holds an in-memory live snapshot** of currently-running sub-agents per session and pushes it on every attach/reconnect. | The reconnect gap is precisely the "looks frozen" moment — see [[thinking-indicator-reconnect-gap]]. |
| D10 | **Post-turn persistence** | At turn finalize, fold a **compact per-agent summary** (label, type, terminal state, step count) into the persisted activity block **once**. Live ticking stays ephemeral; only the settled summary is durable. | Terminal states survive reload / offline replay without flooding the seq'd log. |
| D11 | **Functional test bar** | **Fixture/replay drives the real client**: a recorded/synthesized multi-sub-agent SDK stream → daemon mapping → headless DOM harness → assert counts/labels/terminal states + live updates. Plus daemon unit tests underneath. | Proves the UI actually renders and updates, deterministically, runnable by the agent. |
| D12 | **Nesting depth** | **One level.** Direct sub-agents of the main turn render; grandchildren roll up into their parent's step count. | Covers the audit example; caps data/UI complexity. |
| D13 | **Frozen-scope boundary** | **Sub-agents only, but harden top-level liveness**: guarantee the pane's top-level indicator never looks dead during a sub-agent turn. Generic long-single-tool liveness is **out of scope**. | Fixes the actual pain without scope creep. |
| D14 | **Rollout** | **On by default, no flag.** Additive and ephemeral; older clients ignore unknown live events. | Matches the "just make it visible" goal; no settings-sync surface to build. |

**Reconciliation note (D2 vs D3):** the per-agent row's *headline* is the running/done count and terminal state (D3). The row also shows current tool + step count (D2) and MAY show elapsed seconds as a muted secondary detail. No predicted completion time is ever rendered.

---

## 4. Non-goals

- Team-member (`create_member`) visualization (D1).
- Full nested sub-agent transcripts / `forwardSubagentText` (D2).
- Any ETA / predicted-finish computation (D3).
- Nesting beyond one level (D12).
- Generic "long single tool looks frozen" liveness (D13).
- A settings/capability flag or per-user toggle (D14).
- Changing how sub-agents are *spawned*, permissioned, or scheduled — this is display-only.

---

## 5. Architecture & data flow

```
Claude Agent SDK  ──stream──▶  AgentDriver.consume()      (anvild/src/agent/driver.ts)
                                     │
                                     ├─ mapMessage(m)      (anvild/src/agent/map.ts)
                                     │     • detects parent_tool_use_id on assistant/user msgs
                                     │     • maps tool_progress / thinking_tokens
                                     │     → SubAgentSignal[]  (NOT SessionEventBody)
                                     │
                                     ▼
                          SubAgentTracker (per session, in-memory)   ◀── NEW
                            • map: parentToolUseId → SubAgentState
                            • derives label (D6), step count, terminal state (D7)
                            • holds the live snapshot (D9)
                                     │
                                     │ session.emitLive(subagent.update)   ◀── NEW, ephemeral (D5)
                                     │   (sink() broadcast; NO seq, NO append)
                                     ▼
                              attached clients (web / Android)
                                     │
                                     ▼
        conversation.ts renderer: nested group inside the activity block (D4)
                                     │
        on turn finalize: tracker → compact summary folded into the
        persisted activity block via a normal seq'd event (D10)
```

### 5.1 Daemon

- **`anvild/src/agent/map.ts`** — the SDK-drift containment point; extend here only.
  - Add extraction of `parent_tool_use_id` and `subagentType` from `assistant`/`user` messages.
  - Map `type: 'tool_progress'` and `subtype: 'thinking_tokens'` into `SubAgentSignal`s.
  - Emit these as a **new signal kind**, distinct from `SessionEventBody`, so they don't accidentally enter the seq'd path.
  - The main-turn (parent_tool_use_id === null) path is unchanged — no regression to normal turns.
- **`SubAgentTracker`** (new module, e.g. `anvild/src/agent/subagents.ts`) — per-session, in-memory:
  - Keyed by `parent_tool_use_id` (the `Task` tool_use id). Correlates the `Task` tool_use (which carries the Agent tool's `description`/`subagent_type` input) with the child stream.
  - Tracks: label, type, step count, current tool, elapsed (from `elapsed_time_seconds`), state (`running` | `done` | `error` | `canceled`).
  - Rolls grandchildren (parent_tool_use_id that is itself a sub-agent) into the nearest depth-1 ancestor's step count (D12).
  - Exposes `snapshot(sessionId)` for attach (D9) and `finalizeSummary()` for D10.
- **`anvild/src/session/session.ts`** — add `emitLive(body)`:
  - Broadcasts via the existing `sink(sessionId, event)` primitive.
  - Does **not** call `this.nextSeq++`, `append()`, or `onChange()`.
  - Tags the event with `sessionId` and a monotonic-but-non-seq `live` marker so clients never treat it as a resumable event. (Confirm the offline mirror / delta-resume path ignores events lacking `seq` — add a guard/test.)
- **Attach path** — when a connection attaches/reattaches to a session, push the current `SubAgentTracker.snapshot()` immediately (D9), alongside the existing status re-light.
- **Finalize** — on the turn's `result` message, the driver asks the tracker for its compact summary and folds it into the activity block as a single **seq'd** event (D10), then clears the tracker's live state.

### 5.2 Protocol (`anvild/protocol.ts`)

- New **live** (non-`SessionScoped`-seq) event: `SubAgentActivityEvent`
  ```ts
  interface SubAgentActivityEvent {
    type: "subagent.activity";
    sessionId: string;
    live: true;              // marker: never persisted, never resumed
    parentToolUseId: string; // the Task tool_use id this belongs to
    agents: SubAgentView[];  // full current snapshot for this parent (idempotent replace)
  }
  interface SubAgentView {
    id: string;              // parent_tool_use_id of the child, stable per sub-agent
    label: string;           // e.g. "Audit mutating mappings"
    type: string;            // subagent_type, e.g. "Explore"
    state: "running" | "done" | "error" | "canceled";
    steps: number;           // tool calls made so far (incl. rolled-up grandchildren)
    currentTool?: string;    // tool_name currently running, if any
    elapsedSeconds?: number; // secondary detail only; never an ETA
    error?: string;          // reason, when state === "error"
  }
  ```
  Sent as a **full snapshot per parent** (idempotent replace) so a late-joiner or a dropped frame self-heals — no per-delta bookkeeping on the client.
- Extend the **persisted** activity/tool-block schema (in `ContentBlock` / assistant.message) with an optional `subagentSummary?: SubAgentView[]` folded at finalize (D10). Older clients ignore the unknown field (D14).
- Bump `PROTOCOL_VERSION` only if required by the persisted-field addition; the live event needs no bump (unknown live events are ignored by older clients — verify in the client dispatcher).

### 5.3 Web client

- **`anvild/web/src/ws.ts` / `main.ts`** — route `subagent.activity` to a new handler; it must **not** touch the `{epoch,lastSeq}` watermark (guard: live events carry no `seq`).
- **`anvild/web/src/conversation.ts`** — extend the activity block (D4):
  - When a `Task` tool_use appears, render a nested `<details>`/group under that step keyed by `parentToolUseId`.
  - On each `subagent.activity` snapshot, reconcile the nested rows (create/update/mark-terminal). Idempotent replace — the snapshot is authoritative.
  - Row template: `[state icon] {type} · "{label}"  · {steps} steps  · {currentTool}  · {elapsed}` with `state icon` ∈ spinner/`✓`/`⚠`/`⊘`.
  - Update the activity-block headline to reflect fan-out, e.g. `Working · 3 sub-agents` while any are running.
  - **Top-level liveness guarantee (D13):** while any sub-agent is running, the top-level activity/thinking indicator must remain visibly "alive" (spinner + `N sub-agents running`), never the frozen last-prose state.
  - On finalize, render the durable `subagentSummary` in place of the live rows so a reload shows the settled outcome.
  - Reuse Material Symbols via `icon()`; beware the `hidden`-attribute CSS quirk — use a class that actually toggles `display`, verified against computed style ([[anvil-hidden-attr-css-override]]).
- **Reconnect (D9):** on socket reconnect, the daemon-pushed snapshot repopulates the nested rows with no gap.

### 5.4 Android

- No native code (D8). Android serves the web bundle from APK assets ([[android-app-bundles-web-ui]]); the web changes reach it only via an **APK reship**. On-device verification of the reshipped APK is a done-gate (see Phase 6).

---

## 6. UX states (functional acceptance surface)

| State | Trigger | Expected UI |
| --- | --- | --- |
| **Fan-out start** | First `Task` tool_use of the turn | Activity block headline flips to `Working · N sub-agents`; nested group appears; top-level indicator visibly alive. |
| **Running** | `tool_progress` / child tool_use | Each row shows spinner, type + label, current tool, incrementing step count. Never looks frozen. |
| **One finishes** | child sub-agent result | That row → `✓ done`, final step count; siblings keep running; headline count updates. |
| **One errors** | child sub-agent error result | That row → `⚠ error` with reason; stays visible. |
| **User hits Stop mid-fan-out** | turn canceled | In-flight rows → `⊘ canceled`; already-done rows keep `✓`. |
| **All done (finalize)** | turn `result` | Live rows replaced by the durable compact summary; headline → `Worked · N sub-agents (X ok, Y error, Z canceled)`. |
| **Reload after turn** | page refresh | Summary from D10 renders from history; no live rows, no gap, no error. |
| **Reconnect mid-fan-out** | socket drop + reconnect while running | Snapshot (D9) repopulates current rows immediately; live ticking resumes. |
| **No sub-agents (regression guard)** | ordinary turn, no `Task` tool | Activity block behaves exactly as today; no empty nested group, no headline change. |

---

## 7. Phased delivery & tracking

Legend: `☐` not started · `◐` in progress · `☑` complete. Each phase tracks four gates independently: **Impl** (code written) · **Tested** (its tests pass) · **Verified** (functional/behavioral check done) · **Pushed** (merged to branch/PR).

### Phase 0 — Spec & fixtures
| Item | Impl | Tested | Verified | Pushed |
| --- | --- | --- | --- | --- |
| This spec committed to `docs/plans/` | ☑ | n/a | n/a | ☐ |
| Synthesized a multi-sub-agent SDK-shaped stream as the replay fixture (Task launches, live heartbeats, error, cancel, no-sub-agent) — inlined in `test/web/subagents.test.ts` + `test/unit/*` fixtures rather than a standalone file | ☑ | ☑ | ☑ | ☐ |

### Phase 1 — Daemon: parse & track (no client yet)
| Item | Impl | Tested | Verified | Pushed |
| --- | --- | --- | --- | --- |
| `subAgentSignals` (`src/agent/map.ts`) extracts `parent_tool_use_id`/`subagent_type`/`task_description`; maps `task_progress` → `SubAgentSignal` (thinking_tokens skipped, ID9) | ☑ | ☑ | ☑ | ☐ |
| `SubAgentTracker` (`src/agent/subagents.ts`): correlate `Task` tool_use ↔ child stream (ID2), labels (D6/ID3), step count, terminal states (D7), grandchild roll-up (D12/ID7) | ☑ | ☑ | ☑ | ☐ |
| Main-turn path (`parent_tool_use_id === null`) provably unchanged — `map.test.ts` asserts the Task tool_use still emits normally + ordinary turns yield no signals | ☑ | ☑ | ☑ | ☐ |

### Phase 2 — Daemon: ephemeral live channel + snapshot
| Item | Impl | Tested | Verified | Pushed |
| --- | --- | --- | --- | --- |
| `session.emitLive()` broadcasts via `sink()` with **no** seq/append/onChange (D5/ID5) | ☑ | ☑ | ☑ | ☐ |
| `subagent.activity` snapshots emitted on **structural** change only (ID11 anti-flood) | ☑ | ☑ | ☑ | ☐ |
| Snapshot pushed on attach/reconnect via `supervisor.resume()` (D9/ID13) | ☑ | ☑ | ☑ | ☐ |
| **Watermark-safety test:** `emitLive` never mints seq / appends / dirties (`session-subagents.test.ts`); client guard at `main.ts:1397` ignores seq-less events ([[offline-staged-sync-watermark-poison]]) | ☑ | ☑ | ☑ | ☐ |

### Phase 3 — Protocol
| Item | Impl | Tested | Verified | Pushed |
| --- | --- | --- | --- | --- |
| `SubAgentActivityEvent` + `SubAgentView`/`SubAgentState` added; live event carries **no** `seq` (type-excluded from `SessionScopedEvent`) | ☑ | ☑ | ☑ | ☐ |
| Durable `subagent?` field on `ToolResultEvent` + `ConversationEvent(tool_result)` (D10/ID6) — mapped in `eventlog/log.ts` **and** `web/src/mirror.ts` (ID17) | ☑ | ☑ | ☑ | ☐ |
| Unknown-event tolerance (D14); contract golden regenerated, PROTOCOL_VERSION stays 4 (ID18) | ☑ | ☑ | ☑ | ☐ |

### Phase 4 — Web rendering
| Item | Impl | Tested | Verified | Pushed |
| --- | --- | --- | --- | --- |
| Route `subagent.activity`; guarded off the watermark path (no `seq`) | ☑ | ☑ | ☑ | ☐ |
| Sub-agent rows inside the activity block `<summary>`, keyed by Task tool_use id; idempotent snapshot reconcile + merge guard (D4/ID15) | ☑ | ☑ | ☑ | ☐ |
| Row template with state icons ✓/⚠/⊘/spinner (D7); state via `data-state` class, **not** `hidden` ([[anvil-hidden-attr-css-override]]) | ☑ | ☑ | ☑ | ☐ |
| Headline reflects fan-out (`· N sub-agents`); **top-level never looks frozen (D13)** — activity spinner + rows always visible | ☑ | ☑ | ☑ | ☐ |
| Finalize renders durable summary from Task `tool.result.subagent`; reload/offline replay shows it (D10) | ☑ | ☑ | ☑ | ☐ |

### Phase 5 — Functional (fixture/replay) test harness
| Item | Impl | Tested | Verified | Pushed |
| --- | --- | --- | --- | --- |
| Replay stream → **real bundle** under jsdom → assert §6 states (fan-out/running/done/error, headline, step counts) — `test/web/subagents.test.ts` (D11) | ☑ | ☑ | ☑ | ☐ |
| Reconnect-mid-fan-out (bare live snapshot), late-heartbeat merge guard, and no-sub-agent regression cases covered | ☑ | ☑ | ☑ | ☐ |

### Phase 6 — Ship & cross-client verification (OPERATOR STEPS — not doable headless)
| Item | Impl | Tested | Verified | Pushed |
| --- | --- | --- | --- | --- |
| Web bundle rebuilt (`bun run build:web` green) | ☑ | ☑ | ☑ | ☐ |
| Deployed with browser/SW cache-bust verified ([[anvil-web-bundle-cache-staleness]]) | ☐ | ☐ | ☐ | ☐ |
| Live end-to-end on web against a real multi-sub-agent turn (screenshots of each §6 state) | ☐ | ☐ | ☐ | ☐ |
| Android APK reshipped; on-device verification of the same states (D8) | ☐ | ☐ | ☐ | ☐ |
| PR opened with test output + screenshots referenced | ☐ | ☐ | ☐ | ☐ |

---

## 8. Testing approach

### 8.1 Technical (unit) — fast, no network
- **`anvild/src/agent/map.ts`** (extend `test/unit/map.test.ts`): given fixture SDK messages, assert correct `SubAgentSignal`s — parent linkage, type, step increments, tool_progress mapping, terminal detection. Assert main-turn messages are unchanged.
- **`SubAgentTracker`**: label derivation + fallback (D6), grandchild roll-up (D12), terminal transitions incl. cancel (D7), snapshot idempotency.
- **`session.emitLive`**: broadcasts, but `nextSeq`, `append`, `onChange` are **not** invoked (spy/mocks). Guards the watermark-poison class of bug.

### 8.2 Functional (fixture/replay drives the real client) — the primary behavioral bar (D11)
A deterministic harness that:
1. Loads the Phase-0 fixture (a recorded/synthesized multi-sub-agent SDK stream, including an error, a cancel, and a reconnect point).
2. Feeds it through the **actual** `mapMessage` + tracker + `emitLive` path.
3. Drives the **actual** web renderer in a headless DOM (jsdom/happy-dom or headless browser).
4. **Asserts each row of the §6 table**: counts, labels, current tool, step counts, terminal icons, headline text, finalize summary, reload-from-history, reconnect snapshot, and the no-sub-agent regression guard.

This is the gate that proves the *functional* behavior — that the pane visibly updates and never looks frozen — not merely that payloads are shaped right.

### 8.3 Live end-to-end + cross-client (D8)
- Run a real turn that fans out (e.g. the audit example) against a dev daemon; capture a screenshot at each §6 state on web.
- Reship the APK; repeat the on-device walkthrough on Android.

### 8.4 What "tested" must NOT rely on
- No assertion may pass by checking only daemon payloads while the DOM is unrendered — functional gates require the DOM harness (§8.2).
- Snapshot idempotency must be proven by replaying a duplicate/out-of-order frame and asserting no double rows.

---

## 9. Definition of Done

The feature is **Done** only when **all** hold:

1. **Every §7 checkbox** across Phases 0–6 is `☑` in all four gates (Impl/Tested/Verified/Pushed).
2. **Behavioral:** a real (or replayed) multi-sub-agent turn shows, on web: live per-agent rows with type+label+current tool+step count, running/done counts, and the three terminal states — and the top-level indicator **never** reverts to the frozen last-prose state while sub-agents run (D13).
3. **Reconnect (D9):** dropping and restoring the socket mid-fan-out repopulates the rows immediately, verified in the functional harness and once live.
4. **Persistence (D10):** after the turn, a full page reload shows the compact per-agent summary from history; **and** the offline/delta-resume watermark is provably unaffected by the live channel (§8.1 + §8.2 tests green).
5. **No regression:** an ordinary turn with no sub-agents renders exactly as before (regression test green).
6. **Cross-client (D8):** verified on web **and** on a reshipped Android APK on-device.
7. **Evidence attached to the PR:** unit + functional test output, and screenshots of each §6 state on both web and Android.

## 10. Agent self-verification protocol (run before marking anything Done)

Before flipping any Phase gate to `☑`, the implementing agent MUST:
1. Run the unit suite (`bun test` in `anvild`) and paste the relevant passing output — no skipped/todo for the items claimed.
2. Run the functional replay harness (§8.2) and confirm **each** §6 assertion is present and green; a phase is not "Verified" if any §6 state lacks an assertion.
3. For Phase 6, rebuild+deploy the web bundle, hard-verify cache-bust ([[anvil-web-bundle-cache-staleness]]), drive a real fan-out turn, and capture the state screenshots; then reship + on-device check Android.
4. Re-read the Decision log (§3) and confirm the implementation matches each `Dn` it touches; if any decision was deviated from, STOP and surface it rather than silently marking Done.
5. Only then update the §7 tables and the top-of-file **Status** line.

A gate marked `☑` without its corresponding evidence (test output or screenshot) is invalid and must be reverted to `◐`.

---

## 11. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Live channel accidentally advances `seq`/offline watermark → the exact poison bug class already hit | D5 + dedicated §8.1 spy test asserting `emitLive` never touches seq/append; §8.2 asserts client ignores live events for watermarking. |
| Heartbeat flood overwhelms the socket/DOM | Coalesce snapshots (≤ ~2/sec per parent) and always send on state-change (start/step/terminal); snapshot is a full idempotent replace so intermediate frames are droppable. |
| SDK shape drift (`parent_tool_use_id`, `tool_progress`) changes upstream | All SDK-shape knowledge confined to `map.ts` (the documented drift-containment point) + fixture tests flag breakage. |
| `hidden`-attribute CSS quirk hides state icons silently | Use a display-toggling class, assert against computed style in the DOM harness ([[anvil-hidden-attr-css-override]]). |
| Android not updated (daemon-only deploy) | D8 makes APK reship + on-device check an explicit done-gate ([[android-app-bundles-web-ui]]). |
| Grandchild sub-agents create confusing/duplicated rows | D12 roll-up + idempotency test with nested fixture. |
