# Sub-Agent Activity Indicator — Implementation Decision Log

This log records every non-trivial decision made **during implementation** (as opposed to the
interview-time decisions D1–D14 in the spec). Reviewed after implementation to decide tweaks.

Format: `IDn — title` · date · **Decision** · **Why** · **Alternatives considered** · **Reversible?**

---

## Phase 1–4 implementation decisions (2026-09-16)

**ID1 — Suppress sub-agent internal messages from the normal event path.** `mapMessage` now returns `[]` for `assistant`/`user` SDK messages whose top-level `parent_tool_use_id` is set. *Why:* those are a sub-agent's internal tool_use/tool_result; today they flatten indistinguishably into the parent's activity block. They now feed only the tracker (via `subAgentSignals`). *Alt:* keep emitting them (rejected — pollutes the main flow, the exact confusion we're fixing). *Reversible:* yes (one guard).

**ID2 — Correlation key = the Task/Agent tool_use id.** One `Task`/`Agent` tool_use == one sub-agent; the child stream's `parent_tool_use_id` equals that id. *Why:* it's the only stable id linking the launch, the child stream, and the terminal tool.result. *Reversible:* yes.

**ID3 — Label priority (D6):** `task_description` (≡ Task input `description`) as the label, `subagent_type` as the type; fallback `"{type} #{index}"` then `"Sub-agent #{index}"`. *Reversible:* yes.

**ID4 — Live event carries the full agent set, idempotent replace.** `SubAgentActivityEvent = { type:"subagent.activity", sessionId, live:true, agents: SubAgentView[] }` — each view has its own `id`. Dropped the spec's per-parent shape. *Why:* simpler client reconcile; a dropped/late frame self-heals from the next full snapshot. *Reversible:* moderate (event shape).

**ID5 — Ephemeral via `Session.emitLive()`:** builds the event with NO `seq`, calls only `sink()` — never `append`/`onChange`/`nextSeq`. *Why:* D5 (avoid offline-watermark poison). An event without `seq` is excluded from `SessionScopedEvent`, so it is type-impossible to send it through `emit()`. *Reversible:* yes.

**ID6 — Durable summary rides the persisted Task `tool.result`.** New optional `subagent?: SubAgentView` on `ToolResultEvent` + `ConversationEvent(tool_result)`, mapped in `log.ts`. Anchor = the Task tool_use block already carried in the persisted `assistant.message`. *Why:* D10 without a new persisted event type or seq flooding; survives reload + offline mirror. *Reversible:* yes (optional field).

**ID7 — Grandchild roll-up (D12):** a nested `Task` launch (child message with `parent_tool_use_id` set) registers `descendant→depth-1 ancestor` and counts as one step on the ancestor; deeper steps roll up too. No depth-2 rows. *Reversible:* yes.

**ID8 — `task_progress` is an overlay, not the baseline.** Baseline (steps, currentTool) derives from default-emitted sub-agent `tool_use`/`tool_result`; `SDKTaskProgressMessage` refines steps(max)/currentTool/label/type/elapsed when present. `agentProgressSummaries` is NOT enabled (off by default; cost; not needed for D2). *Why:* works even if `task_progress` is absent. *Reversible:* yes.

**ID9 — `thinking_tokens` unused.** `SDKThinkingTokensMessage` has no `parent_tool_use_id`, so it can't be attributed to a specific sub-agent. *Reversible:* yes.

**ID10 — `elapsedSeconds` only from `task_progress.duration_ms`.** Keeps the tracker clock-free (pure, deterministic, unit-testable — `Date.now()` is also banned in workflow scripts and awkward in tests). Consistent with D3 (elapsed is optional/secondary; no ETA). *Reversible:* yes.

**ID11 — Coalesce live emits to STRUCTURAL changes only.** `emitLive` fires on new-agent/steps/currentTool/state/label/type changes; an `elapsedSeconds`-only delta does NOT emit. *Why:* prevents a `task_progress` heartbeat flood (risk in spec §11). *Reversible:* yes.

**ID12 — Tracker resets at the start of each user turn** (`driver.prompt`). Terminal rows persist in the live view until the next turn; reload restores them from the durable tool.result. *Reversible:* yes.

**ID13 — Attach/reconnect snapshot (D9):** `supervisor.resume()` appends ONE `subagent.activity` live event (no seq) after the status re-light, mirroring `permissionRequestEvents`. NOT added to the non-attaching `history()` path (that fills the offline mirror, which uses the durable tool.result instead). *Reversible:* yes.

**ID14 — PROTOCOL_VERSION stays 4.** All additions are additive (a new tolerated live event + one optional field); matches the file's documented additive-change practice and D14 (on by default, older clients ignore unknowns). *Reversible:* n/a.

**ID15 — Sub-agent rows live in the activity block's `<summary>`** (always visible, even collapsed) so a fan-out is visible at a glance — serving "never look frozen" (D13). State icons toggle via a CSS class, never the `hidden` attribute (avoids the known `.msym` display-override quirk). *Reversible:* yes.

**ID16 — Task/Agent tool_use no longer renders as a generic activity step** — it becomes the sub-agent group. All other tools render exactly as before. *Reversible:* yes.

## Phase 5–6 / test-integration decisions (2026-09-16)

**ID17 — `mirror.foldEvent` also carries `subagent`.** The web offline mirror's fold must mirror `eventlog/log.ts snapshot()` exactly, else an OFFLINE reopen would drop the settled sub-agent row. Added the same spread. *Reversible:* yes.

**ID18 — Regenerated the protocol contract golden** (`protocol-surface.golden.json`) to add `subagent.activity` (153 types); PROTOCOL_VERSION stays 4. This is the intended checkpoint to update the Swift/Kotlin clients for the new wire type (they currently ignore unknowns → no break). *Note:* the documented `bun test/contract/regen-golden.ts` errors under this bun version (it imports a file with top-level `test()`), so the golden was regenerated with an equivalent inline script. Worth fixing the regen script separately.

**ID19 — Functional harness force-exits the spawned node process.** A booted app leaves live timers (socket heartbeat interval, reconnect backoff), so `Bun.spawnSync(node …)` would hang forever. The harness calls `process.exit(0)` once the report is written. *Reversible:* yes (test-only).

**ID20 — Driver test doubles extended.** `driver-cleanup` / `driver-resume-fallback` fake Sessions gained no-op `resetSubAgents`/`applySubAgentSignals`/`finishSubAgent`/`cancelRunningSubAgents` (the driver now calls them). Test-double maintenance, not a behavior change. *Reversible:* yes.

## Honest status of Phase 6 (operator steps NOT done by the agent)

Automated gates are green (unit + contract + functional replay + production `build:web`). NOT done — they need a real environment/device the agent can't reach:
- Live end-to-end against a real daemon running a real multi-sub-agent turn (screenshots of each §6 state).
- Android APK reship + on-device verification (D8).
- Opening the PR with test output + screenshots.
These remain for a human/operator; the code + automated verification are complete and green.
