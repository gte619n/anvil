# Team support — design

**Date:** 2026-07-24
**Status:** DESIGN — approved 2026-07-24 (via md-review-plus; member↔member messaging deferred, §8)
**Extends:** `anvil-native-architecture.md` (§5 sessions, §6 protocol), `anvil-protocol.ts`,
`anvil-autopilot-ui.md` (the plan-gate pattern this reuses), `anvil-restart-robustness.md`.

---

## 0. Summary

Add **agent teams** to Anvil: a coordinating **lead** session can fan a goal out to several
**member** sessions that work in parallel, each in its own git worktree, and then bring their
branches home as **one combined PR**. A new GUI surfaces the team as a tree in the sidebar — you can
observe any member live, chat with it, see its worktree/diff, and answer its permission prompts,
because **a member is just a session**.

The whole design rests on one decision: **a team member is a first-class Anvil `Session`, linked to
its lead by a new `parentId`.** Anvil already treats "a conversation against one working tree, with
a git lifecycle, independently observable and gated" as its atomic unit. A team is simply *several of
that unit* with a parent link and an integration story. No new primitive; we compose the one we have.

Rejected alternatives (see §9): SDK-native teammate *lanes* (contradicts "a member can do anything /
own worktree"; would rebuild the entire multi-agent UI from zero) and a *hybrid* that keeps the SDK's
orchestrator and Anvil's in sync (two sources of truth — the one thing this codebase refuses).

---

## 1. Goals & non-goals

**Goals**
- A team member is a full session: own worktree (optional), own `query()`, own git lifecycle, own
  permission/question cards, observable and chattable from any device — all by reuse, not rebuild.
- A **lead** decomposes a goal into member tasks, proposes the split as a reviewable plan, and — once
  gated — spawns and runs the members, then integrates their work.
- Integration: **one combined PR by default** (lead merges member branches into its own branch),
  **PR-per-member** as a per-team option for unrelated work.
- The autonomy of the whole flow rides Anvil's existing per-session `AutonomyPolicy` dial, so
  "propose→gate→run" and "fully autonomous" are the *same* build at different settings.

**Non-goals (YAGNI — explicitly cut from v1)**
- **Member↔member messaging.** The lead is the only coordinator; members don't talk to each other.
  (This is the one thing the SDK's `TeamCreate` gives that child-sessions don't — deferred until a
  real workflow needs it. Noted in §8.)
- **Answering a member's permission prompt from the *parent's* view.** v1: selecting a member makes
  it the active session, so the existing card path works unchanged. Live cross-member gating from the
  team header is a later enhancement (§8).
- **Cross-daemon teams.** A team is server-local, exactly as sessions are (worktrees are
  machine-local; see `anvil-multi-server.md` §1). The lead and all members live on one daemon.
- **A separate team store.** A team is *derived* from `parentId` across the persisted session list;
  there is no second source of truth to keep in sync or to heal on restart (§6).

---

## 2. Core model

### 2.1 A member is a session

`Session` (`anvild/protocol.ts:207`) gains three optional fields:

```ts
parentId?: SessionId;   // present on a member; points at the lead session
teamRole?: "lead" | "member";
memberTask?: string;    // the one-line task the lead assigned this member (member rows show it)
```

And the lead carries the team's policy (a team is just its lead + whoever points at it):

```ts
export interface TeamPolicy {
  integration: "combined-pr" | "pr-per-member"; // default "combined-pr"
  maxConcurrentMembers: number;                 // spawn cap, default 3 (mirrors autopilot maxAutoStart)
}
team?: TeamPolicy; // set only on a lead session
```

No `Team` object is persisted. `TeamInfo` sent to clients (§5) is **computed** from the flat session
list by grouping on `parentId`. On daemon restart the tree reconstitutes for free from the persisted
sessions; member worktrees heal via the existing `worktreeHealth`/`recreateWorktree`
(`session/worktree.ts:196,212`).

### 2.2 Combined PR = the lead's own worktree, unchanged

A lead is an **ordinary `fresh-worktree` session** — nothing about a lead is special or different
from any other session; it has a worktree and a branch exactly like every session does. The only
observation is that in `combined-pr` mode that existing branch happens to be where the members'
branches get merged, so **the combined PR is just the lead session's normal PR** — the same
per-session `commit`/`push`/`createPr`/`mergePr` (`git/ops.ts:116,129,147,165`) and in-app git
buttons every session already has, with zero new PR machinery. No separate "integration branch" is
created and nothing new happens to a lead *as a session*; "integration" (§4) is just a merge run in
the worktree the lead already occupies.

- **Member base ref:** each member is spawned off the lead's branch HEAD at spawn time, so members
  share a consistent starting point (and pick up any scaffolding the lead committed first). A member
  is a `fresh-worktree` session with its own branch — a distinct branch off the lead branch's commit,
  which git worktrees allow (you branch off the commit, you don't re-check-out the lead's branch).
- **Read-only / no-worktree members:** a member that only reviews or researches is spawned
  `existing-dir` (Anvil's other `SessionSource`, `protocol.ts:102`). "Often needs a worktree," not
  always — already expressible, no new concept.

### 2.3 Spawning reuses `handoffCreate`

Member creation is `handoffCreate` (`session/supervisor.ts:1425`) — the exact path the concierge
already uses to spin up seeded worktree sessions — extended to stamp `parentId`/`teamRole`/
`memberTask` and to accept `base = <lead branch>`. The lead gets this as an MCP tool, generalizing
the concierge's `create_session` tool (`agent/default-tools.ts:61`).

---

## 3. Orchestration: propose → gate → run

Reuses the Autopilot plan-card spine (`anvil-autopilot-ui.md`) rather than inventing a review flow.

1. **Decompose.** You give the lead a goal. The lead (an agent turn) proposes a **team plan**: an
   ordered list of members, each with `{ title, task, source, dependsOn? }`. It emits this as a
   fenced-JSON block parsed off its output (same trick as the autopilot planner's metadata block,
   `integrations/autopilot.ts`).
2. **Gate.** The plan surfaces as a **reviewable team-plan card** (same UI family as an Autopilot
   plan card). You edit/approve/reject. **The gate rides `AutonomyPolicy`:** at `bypass` the plan
   auto-approves (fully-autonomous / overnight mode); at `mostly-autonomous`+ it waits for you.
3. **Run.** On approval the lead spawns up to `maxConcurrentMembers` members via `handoffCreate`,
   each seeded with its task as the opening brief; remaining members queue and start as slots free
   (mirrors `maxAutoStart` in `runAutopilot`). Members run independently and concurrently.

The lead's toolset (in-process MCP, like `default-tools.ts`): `propose_team_plan`, `create_member`,
`list_members` (live status/git of each member — reuses the session projection), `integrate`.

**Manual composition falls out for free:** because a member is a session, "create a session with
`parentId = <this lead>`" is a plain session-create. No lead agent is *required* — you can hand-build
a team. That is option 3 from the interview, obtained for nothing.

---

## 4. Integration: bringing branches home

When members reach a terminal state (their own git lifecycle says done — e.g. committed, or the lead
marks the task complete), the lead **integrates**, as a normal agent turn in its own worktree:

- **`combined-pr` (default):** the lead merges each member branch into **its own branch — the
  worktree it already occupies** — **in dependency order**, resolving conflicts as an ordinary agent
  turn (merging is just another task in a worktree — the lead has tools and a worktree). Then the
  lead opens **one PR** via the existing per-session flow. A conflict the lead can't resolve parks the team in a **`needs-human`** state and
  surfaces the conflicted member (same shape as autopilot's `anvil:blocked`); you resolve in that
  member's or the lead's session and re-trigger `integrate`.
- **`pr-per-member`:** no merge; each member opens **its own PR** through its own session git
  lifecycle. The team is a grouping/observation construct only.

Integration policy is a `TeamPolicy` field, chosen at team creation, editable before integration.

---

## 5. GUI

Findings from the web-client map (`anvild/web/src/main.ts`) drive minimal, additive changes.

- **Sidebar tree.** The list is deliberately flat today (`renderSessions` `main.ts:2071`,
  `renderSessionItem` `main.ts:2097`). Add: members are filtered out of the top-level loop and
  rendered as an **indented nested list under their lead's row**, reusing `renderSessionItem` with an
  indent class + the member's `memberTask` in the meta line. A lead row shows a rollup (`3 members ·
  2 running · 1 needs approval`).
- **Member view = session view.** Selecting a member makes it the active session; the entire existing
  conversation/permission/question/terminal/git UI works unchanged. **Human↔member chat is free.**
- **Team header / board.** Opening a *lead* shows, above its conversation, a compact **member board**
  (one row per member: task, status, git dirty/ahead, PR badge) — each row deep-links to that member.
  This reuses the session projection already sent in `session.list`.
- **Attention routing.** A member entering `awaiting_permission`/`awaiting_question` already sets the
  "awaiting" class on its sidebar row (`main.ts:2099`) and fires a push — so a member needing you is
  visible without opening the lead. v1 answers it by selecting that member (its cards route correctly
  via the existing `sendTo(sessionId)` because it becomes active). No `activeId`-guard change needed
  for v1.

---

## 6. Data flow, protocol & restart

- **Protocol.** Additive fields on `Session` (§2.1) + a `TeamInfo` display type + a `team.plan`
  event (the reviewable plan) and `team.plan.approve`/`team.plan.reject`/`team.integrate` commands.
  These are additive; per the contract test, bump `PROTOCOL_VERSION` (`protocol.ts:49`, currently
  `1`) and refresh the golden (`test/contract/`).
- **Derivation, not storage.** `TeamInfo` = group persisted sessions by `parentId`; roll up member
  statuses. Nothing team-specific is persisted beyond the fields on the sessions themselves.
- **Restart robustness.** On daemon restart the session store is reloaded as today; the team tree is
  recomputed from `parentId`; member worktrees heal via `worktreeHealth`/`recreateWorktree`. A team
  mid-run resumes its members (each session resumes independently) or parks a member in `error` that
  restart recovery already handles.

---

## 7. Error handling & budget

- **Member spawn fails** (e.g. `git worktree add` fails): the team continues; that member is flagged
  and reported to the lead; per-member try/catch so one failure never aborts the run (mirrors
  `runAutopilot`'s per-unit guarding).
- **Member crashes / errors:** shown in its own row via the existing session `error` status; restart
  recovery heals its worktree.
- **Unresolvable merge conflict:** team → `needs-human`, conflicted member surfaced; no silent
  half-merge.
- **Budget.** N members burn ~N× concurrently. Reuse the autopilot guards: `maxConcurrentMembers`
  caps concurrency; when the subscription budget is in warn/soft-stop, **new member spawns pause**
  (running members finish) — same policy as autopilot skipping auto-start under budget pressure.
- **Danger-list.** Members run under the same `PreToolUse` gate + danger list as any session; an
  autonomous (`bypass`) team is still backstopped on genuinely destructive ops.

---

## 8. Deferred (revisit in review or later)

- **Member↔member messaging** (the SDK-team capability child-sessions lack). Lead-as-hub covers the
  decompose→integrate pattern; add peer messaging only when a workflow needs peers to negotiate.
  **Lift:** the *plumbing* is small — a `message_member(id, text)` MCP tool that calls
  `supervisor.prompt(targetId, text)` reuses the existing input queue (`agent/input-queue.ts`,
  `supervisor.prompt` at `supervisor.ts:1783`) that already lets any session be prompted. The real
  cost is the *semantics* (a sibling roster so a member can address peers; loop / turn-taking guards
  so agents don't ping-pong) and *GUI attribution* (showing who said what to whom across lanes) —
  which is why it's deferred, not because delivering the bytes is hard.
- **Cross-member gating from the team header** (answer any member's card without leaving the lead) —
  needs relaxing the single-active-session `activeId` drop-guard (`main.ts:920`) into a
  "team-group-active" concept. v1 selects the member instead.
- **Member↔member worktree sharing / stacked branches** beyond the two integration modes.
- **Persisting in-flight orchestration state across a daemon restart.** The lead's queued-but-not-yet-
  spawned members (`queuedMembers`), the active plan (`activeTeamPlans`, used only to order the merge),
  and a not-yet-approved `team.plan` card (`pendingTeamPlans`) live in memory only. A restart
  reconstitutes the *derived* team tree and already-spawned members (§6) but drops these: an overflow
  plan's unspawned tail never spawns, and an unapproved plan card vanishes (the lead's tool call
  already returned "awaiting approval"). Known v1 limitation — surfaced in code review 2026-07-24;
  spawn every member up front (no cap) or persist a small team sidecar to close it. Low-frequency
  (only a restart mid-run with an overflowing/unapproved plan), so deferred, not fixed, in v1.

---

## 9. Alternatives considered

| Option | Why rejected |
|---|---|
| **SDK teammate lanes** (one lead `query()`, teammates demuxed via `parent_tool_use_id`) | Teammates would be ephemeral sub-streams sharing the lead's cwd — contradicts "a member can do anything / own worktree." Requires net-new agent-attribution on every conversation event + a lane renderer + per-lane permission attribution: the entire multi-agent UI from zero, vs. reusing the session UI. |
| **Hybrid** (SDK orchestrates; Anvil promotes each spawn to a child session) | Two orchestrators (SDK's + Anvil's) to keep in sync forever; violates the daemon-is-single-source-of-truth invariant central to restart robustness. |
| **Separate persisted `Team` store** | A second source of truth to heal on restart. `parentId`-derived `TeamInfo` needs none. |

---

## 10. Testing approach

Aligned with the repo's existing conventions (`bun test`, the layout under `anvild/test/`):

- **Unit — `anvild/test/unit/*.test.ts`, `bun:test`, pure & SDK-free** (the style of
  `autostart-gate.test.ts` and `worktree-ref-safety.test.ts`): team-tree derivation from `parentId`;
  rollup status; member base-ref computation; team-plan JSON parse; the gate decision (autonomy →
  auto-approve vs wait); integration order from `dependsOn`. The team logic lives in pure,
  injectable modules (as `schedule.ts`/`autostart-gate.ts` do) so these tests pass `now`/inputs and
  assert deterministically.
- **Contract — `anvild/test/contract/`:** protocol additions bump `PROTOCOL_VERSION`
  (`protocol-surface.test.ts` pins it); regenerate the golden with
  `bun test/contract/regen-golden.ts` and commit `protocol-surface.golden.json`.
- **Integration — `anvild/test/integration/`:** in a temp repo, spawn a 2-member team on trivial
  tasks, integrate, assert the lead's branch contains both members' changes and one PR branch is
  produced; assert `pr-per-member` yields two.
- **Web — `anvild/test/web/` + `test/tools/headless-smoke.ts`:** the headless load smoke guards that
  the sidebar tree-render path doesn't throw with nested members.

All four gates the repo already runs in CI (`typecheck`, `typecheck:web`, `build:web`, `bun test`)
stay green.

---

## 11. Phase tracking

| Phase | Description | Status | Tested | Pushed |
|-------|-------------|--------|--------|--------|
| 1 | Protocol + data model: `parentId`/`teamRole`/`memberTask`/`TeamPolicy` on `Session`; `TeamInfo`; team events/commands; bump `PROTOCOL_VERSION` + golden | done | yes | no |
| 2 | Daemon team lifecycle: `handoffCreate` stamps parent link + lead-branch base; `TeamInfo` derivation + rollup; member spawn cap; restart reconstitution | done | yes | no |
| 3 | Lead orchestration: in-process MCP tools (`propose_team_plan`/`create_member`/`list_members`/`integrate`); team-plan card + gate on `AutonomyPolicy` | done | yes¹ | no |
| 4 | Integration: lead-driven ordered merge + conflict-as-agent-turn → combined PR; `pr-per-member` mode; `needs-human` parking | done | yes² | no |
| 5 | Web GUI: sidebar member tree, lead rollup, member board, member-as-active-session view | done | yes³ | no |
| 6 | Budget/danger backstops for autonomous teams; docs | done | yes | no |

¹ Unit + integration tests cover the tools, the gate decision, and the reject/policy paths; the
  bypass **auto-spawn** and spawn-on-approve run real SDK drivers, so they're verified live (Phase 7,
  plan T17). ² Merge/order/resume/conflict logic is unit-tested (fake git) and the combined-pr vs
  pr-per-member merge is integration-tested against a real temp repo (push/PR faked). The
  conflict-as-agent-turn is implemented as an idempotent, resumable prompt-then-re-integrate flow
  (not an in-call recursion). ³ jsdom + a Chrome headless smoke (seeded lead+members) guard the
  render path; full visual acceptance on desktop + phone-over-Tailscale is the Phase 7 user gate
  (plan T17/T18). **A lead is created via a "Team lead" toggle in the new-session dialog** (a small
  addition beyond the original design, which left lead-creation implicit).
