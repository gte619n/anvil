# Team Support — Implementation Plan

**Goal:** Ship agent teams in Anvil where a lead session fans a goal out to member sessions (each a first-class `Session` linked by `parentId`, each with its own optional worktree + git lifecycle), then integrates their branches into one combined PR.
**Architecture:** A team member *is* an Anvil `Session` with a new `parentId`. A lead is an ordinary `fresh-worktree` session that (a) proposes a decomposition gated on the existing `AutonomyPolicy`, (b) spawns members via the existing `handoffCreate` path, (c) merges member branches in its own worktree and opens one PR via existing per-session git ops. `TeamInfo` is *derived* from the flat session list by grouping on `parentId` — no separate team store. Reuses: `handoffCreate`, `InputQueue`, `createWorktree`, `commit`/`push`/`createPr`/`mergePr`, the concierge in-process MCP tool pattern, and the Autopilot plan-card gate.
**Tech Stack:** Bun + TypeScript (`anvild/`), `bun:test`, the `@anthropic-ai/claude-agent-sdk`, vanilla-TS web client (`anvild/web/`), the wire protocol at `anvild/protocol.ts`.

**Design source:** `docs/plans/anvil-team-support.md` (approved 2026-07-24).

**Altitude note (read before executing):** Foundation + pure logic tasks (Phases 1–2, plus every helper module) carry **complete code + failing-test-first steps**. GUI and git-integration tasks that must weave into `main.ts` (6.3k lines) / `supervisor.ts` (1.8k lines) carry **exact anchors, real signatures, behavior specs, and representative snippets** — implement against the live file. All work happens on branch `design/anvil-team-support` (already checked out) or a child worktree; run `cd anvild && bunx tsc --noEmit && bun run typecheck:web && bun run build:web && bun test` before each commit.

---

## Status

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Protocol: `parentId`/`teamRole`/`memberTask`/`TeamPolicy` on `Session` | done | yes | no |
| 2 | Protocol: `TeamInfo` type + `team.*` events & commands + `ServerEvent`/command unions | done | yes | no |
| 3 | Contract: regenerate golden, bump `PROTOCOL_VERSION`, test green | done | yes | no |
| 4 | `team-tree.ts`: derive `TeamInfo` from sessions (pure) + unit test | done | yes | no |
| 5 | `team-plan.ts`: parse lead's fenced-JSON plan + integration order from `dependsOn` (pure) + unit test | done | yes | no |
| 6 | `team-gate.ts`: autonomy → auto-approve vs wait decision (pure) + unit test | done | yes | no |
| 7 | `member-base.ts`: resolve a member's base ref off the lead (pure) + unit test | done | yes | no |
| 8 | Supervisor: `handoffCreate` stamps `parentId`/`teamRole`/`memberTask`; broadcast members | done | yes | no |
| 9 | Supervisor: `teamInfo()` derivation + emit `team.info` on session changes | done | yes | no |
| 10 | Lead MCP tools: `propose_team_plan`/`create_member`/`list_members`/`integrate` + wire to lead sessions | done | yes | no |
| 11 | Team-plan gate: card event + approve/reject commands + autonomy auto-approve | done | yes⁎ | no |
| 12 | Integration: ordered merge in lead worktree → combined PR; `pr-per-member`; `needs-human` park | done | yes | no |
| 13 | Budget + danger backstops for autonomous teams (spawn cap, budget pause) | done | yes | no |
| 14 | Web: sidebar member tree under lead row (reuse `renderSessionItem`) | done | yes⁑ | no |
| 15 | Web: lead rollup + member board + `team.info` event handling | done | yes⁑ | no |
| 16 | Web smoke: nested-member render path in `headless-smoke.ts`; docs + phase table flip | done | yes⁑ | no |
| 17 | **Agent-driven live browser verification** (drive a real browser against a running daemon) | done | yes | no |
| 18 | **Manual browser acceptance** — user drives + agent-browser E2E stress test | done | yes | no |
| 19 | Open the PR — gated on 17 + 18 green and all four CI gates green | in progress | — | — |

⁎ auto-spawn/spawn-on-approve are SDK-driven → verified live in T17. ⁑ web gates (`typecheck:web` +
`build:web`) pass; the Chrome smoke seeds a team but only runs where headless Chrome is available
(the user's Mac, T17/T18) — full visual acceptance is the T17/T18 gate.

**Deviations from the plan (filled gaps, all committed):** (a) added optional `teamRole`/`team` to
`SessionCreateCmd` + a "Team lead" toggle in the new-session dialog — the plan added the fields to
`Session` but never specified how a lead is created; (b) the repo's documented
`bun test/contract/regen-golden.ts` is broken under Bun 1.3.14 (it imports the test module, which runs
`test()` at import) — the golden was regenerated via an equivalent standalone script; the regen tool
itself is left as-is. (c) conflict handling is an idempotent resume (prompt lead → re-integrate skips
already-merged members) rather than an in-call agent round-trip; no `needs-human` protocol field was
added (the conflict surfaces via the lead's conversation + no PR).

**Live-verification findings + fixes (agent-driven run, 2026-07-24):** driving a real browser against
a running daemon surfaced three issues, all fixed: (d) the sidebar team **rendered side-by-side**
(lead squished left, members overflowing right) because the nested member `<ul>` landed inside the
lead's flex row — now a proper top-down indented tree (trunk + elbow connectors). (e) a **member spawn
failure was swallowed** (only a daemon-log line) and `propose_team_plan` counted attempts not
successes — the common trigger is a branch-name collision (two teams in one repo → same member title →
same branch slug → `git worktree add` fails); now each failure emits an error on the lead's
conversation (design §7) and the count reflects real successes. (f) **no team teardown existed** — added
a `dismiss_member` lead MCP tool (the board buttons were later removed — see below).

**Post-verification hardening (agent-browser E2E stress test, 2026-07-24 — 5 journeys, 14 screenshots,
9 issues, all fixed):** #1 slug-collision auto-suffix (colliding member titles no longer silently drop
a member); #2 live board/rollup status (broadcast `session.updated` on any team session's status change,
since member `status` events are session-scoped); #3 clamp `maxConcurrentMembers>=1`; #4 cascade
teardown when a lead is killed (no orphaned members leaking budget); #5 drain the queue on member
dismiss/kill; #6 refuse `integrate` while any member is still working; #7 a lead without an environment
spawns members off its own `repoRoot`; #8 reject empty plans + clear `activeTeamPlans` on integrate/kill.
Also from live UX feedback: the sidebar renders as a proper indented **treeview**; the member board is
**observational** (banded background, no action buttons — actions go through the lead agent),
**collapsible**, and height-bounded; and **full two-way lead↔member conversations** (`message_member`
+ `message_lead`, with a relay loop-guard) — the design's §8 deferral was clarified to cover only
member↔member *peer* messaging. Combined-PR integration verified end-to-end live (throwaway repo PRs).

---

## Phase 1 — Protocol & data model

### Task 1: Session team fields

**Files:**
- Modify: `anvild/protocol.ts:207-239` (the `Session` interface)

**Step 1: Add fields.** Inside `interface Session`, after the `environmentId?` line (`protocol.ts:213`), add:

```ts
  // ── Teams (see docs/plans/anvil-team-support.md) ──────────────────────────
  parentId?: SessionId;                 // present on a member; points at its lead session
  teamRole?: "lead" | "member";         // absent on a plain (non-team) session
  memberTask?: string;                  // the one-line task the lead assigned this member
  team?: TeamPolicy;                     // set only on a lead: this team's integration/concurrency policy
```

**Step 2: Add the `TeamPolicy` type.** Immediately after the `Session` interface (`protocol.ts:239`), add:

```ts
/** A team's policy. Lives on the lead `Session`; a team is otherwise derived from `parentId`. */
export interface TeamPolicy {
  integration: "combined-pr" | "pr-per-member"; // default "combined-pr"
  maxConcurrentMembers: number;                 // spawn/concurrency cap (default 3)
}
```

**Step 3: Verify types.** Run: `cd anvild && bunx tsc --noEmit`
Expected: PASS (fields are optional; no call sites break).

**Step 4: Commit** `git commit -am "feat(protocol): team fields on Session + TeamPolicy"`

---

### Task 2: TeamInfo type + team events & commands

**Files:**
- Modify: `anvild/protocol.ts` (near the session events ~`376-395`, the `ServerEvent` union ~`815`, and the command section ~`881+`)

**Step 1: `TeamInfo` display type.** Add near `Session` (after `TeamPolicy`):

```ts
/** A team, computed from the session list by grouping on `parentId`. Sent via `team.info`. */
export interface TeamInfo {
  leadId: SessionId;
  policy: TeamPolicy;
  members: TeamMemberInfo[];
  rollup: { total: number; running: number; awaiting: number; done: number; error: number };
}
export interface TeamMemberInfo {
  sessionId: SessionId;
  task?: string;
  status: SessionStatus;
  git?: GitStatus;      // reuse the existing per-session git projection
}
export type TeamPlanMember = { title: string; task: string; source: SessionSource; dependsOn?: string[] };
export interface TeamPlan { leadId: SessionId; members: TeamPlanMember[]; integration: TeamPolicy["integration"] }
```

**Step 2: Events.** Add three event interfaces near `SessionUpdatedEvent` (`protocol.ts:385`):

```ts
export interface TeamInfoEvent extends Envelope { type: "team.info"; teams: TeamInfo[] }
export interface TeamPlanEvent extends Envelope { type: "team.plan"; sessionId: SessionId; plan: TeamPlan }
export interface TeamPlanResolvedEvent extends Envelope { type: "team.plan.resolved"; sessionId: SessionId; approved: boolean }
```
Add `| TeamInfoEvent | TeamPlanEvent | TeamPlanResolvedEvent` to the `ServerEvent` union (`protocol.ts:815+`).

**Step 3: Commands.** Add near the session commands (`protocol.ts:881+`), each `extends Envelope, Correlated`:

```ts
export interface TeamPlanApproveCmd extends Envelope, Correlated { type: "team.plan.approve"; sessionId: SessionId; plan: TeamPlan }
export interface TeamPlanRejectCmd extends Envelope, Correlated { type: "team.plan.reject"; sessionId: SessionId }
export interface TeamIntegrateCmd extends Envelope, Correlated { type: "team.integrate"; sessionId: SessionId }
```
Add all three to the client-command union (find it near the `ServerEvent` union — the type aggregating `*Cmd`).

**Step 4: Verify.** Run: `cd anvild && bunx tsc --noEmit`
Expected: PASS.

**Step 5: Commit** `git commit -am "feat(protocol): TeamInfo + team.* events and commands"`

---

### Task 3: Contract golden + PROTOCOL_VERSION

**Files:**
- Modify: `anvild/protocol.ts:49` (`PROTOCOL_VERSION`)
- Modify: `anvild/test/contract/protocol-surface.golden.json` (regenerated)

**Step 1: Run the contract test, verify it fails on the new surface.** Run: `cd anvild && bun test test/contract/protocol-surface.test.ts`
Expected: FAIL (protocol surface changed / version mismatch).

**Step 2: Bump version.** `protocol.ts:49`: `export const PROTOCOL_VERSION = 2 as const;`

**Step 3: Regenerate golden.** Run: `cd anvild && bun test/contract/regen-golden.ts`
Expected: writes `protocol-surface.golden.json` (now includes `team.*`).

**Step 4: Verify green.** Run: `cd anvild && bun test test/contract/protocol-surface.test.ts`
Expected: PASS.

**Step 5: Commit** `git commit -am "chore(protocol): bump PROTOCOL_VERSION to 2 + regen golden for teams"`

---

## Phase 2 — Pure logic (test-first, SDK-free)

> These modules hold all branchy team logic so it's deterministically testable, mirroring `integrations/schedule.ts` and `agent/autostart-gate.ts`. Each task is red→green.

### Task 4: `team-tree.ts` — derive TeamInfo

**Files:**
- Create: `anvild/src/integrations/team-tree.ts`
- Test: `anvild/test/unit/team-tree.test.ts`

**Step 1: Write failing test.**
```ts
import { test, expect } from "bun:test";
import { deriveTeams } from "../../src/integrations/team-tree";
import type { Session } from "@protocol";

const s = (over: Partial<Session>): Session => ({
  id: "x", title: "t", cwd: "/c", source: "fresh-worktree", model: "opus",
  autonomy: "mostly-autonomous", status: "idle", createdAt: "", lastActivityAt: "",
  usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...over,
});

test("groups members under their lead and rolls up status", () => {
  const sessions = [
    s({ id: "lead", teamRole: "lead", team: { integration: "combined-pr", maxConcurrentMembers: 3 } }),
    s({ id: "m1", parentId: "lead", teamRole: "member", memberTask: "auth", status: "running_tool" }),
    s({ id: "m2", parentId: "lead", teamRole: "member", memberTask: "tests", status: "awaiting_permission" }),
    s({ id: "solo" }), // not part of any team
  ];
  const teams = deriveTeams(sessions);
  expect(teams).toHaveLength(1);
  expect(teams[0]!.leadId).toBe("lead");
  expect(teams[0]!.members.map((m) => m.sessionId).sort()).toEqual(["m1", "m2"]);
  expect(teams[0]!.rollup).toMatchObject({ total: 2, running: 1, awaiting: 1 });
});

test("no teams when no leads", () => {
  expect(deriveTeams([s({ id: "solo" })])).toEqual([]);
});
```

**Step 2: Run, verify fail.** Run: `cd anvild && bun test test/unit/team-tree.test.ts`
Expected: FAIL ("Cannot find module '.../team-tree'").

**Step 3: Implement.**
```ts
import type { Session, TeamInfo, TeamMemberInfo, TeamPolicy } from "@protocol";

const DEFAULT_POLICY: TeamPolicy = { integration: "combined-pr", maxConcurrentMembers: 3 };

/** Group sessions into teams by `parentId`. A team = a lead + every session pointing at it. Pure. */
export function deriveTeams(sessions: Session[]): TeamInfo[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const membersByLead = new Map<string, Session[]>();
  for (const s of sessions) {
    if (s.parentId && byId.has(s.parentId)) {
      (membersByLead.get(s.parentId) ?? membersByLead.set(s.parentId, []).get(s.parentId)!).push(s);
    }
  }
  const teams: TeamInfo[] = [];
  for (const lead of sessions) {
    if (lead.teamRole !== "lead") continue;
    const members = membersByLead.get(lead.id) ?? [];
    teams.push({
      leadId: lead.id,
      policy: lead.team ?? DEFAULT_POLICY,
      members: members.map(toMemberInfo),
      rollup: rollup(members),
    });
  }
  return teams;
}

function toMemberInfo(s: Session): TeamMemberInfo {
  return { sessionId: s.id, task: s.memberTask, status: s.status, git: s.git };
}

function rollup(members: Session[]) {
  const r = { total: members.length, running: 0, awaiting: 0, done: 0, error: 0 };
  for (const m of members) {
    if (m.status === "thinking" || m.status === "running_tool") r.running++;
    else if (m.status === "awaiting_permission" || m.status === "awaiting_question") r.awaiting++;
    else if (m.status === "error") r.error++;
    else if (m.status === "idle" || m.status === "exited") r.done++;
  }
  return r;
}
```

**Step 4: Run, verify pass.** Run: `cd anvild && bun test test/unit/team-tree.test.ts`
Expected: PASS.

**Step 5: Commit** `git commit -am "feat(teams): deriveTeams pure helper + test"`

---

### Task 5: `team-plan.ts` — parse plan + integration order

**Files:**
- Create: `anvild/src/integrations/team-plan.ts`
- Test: `anvild/test/unit/team-plan.test.ts`

**Step 1: Write failing test.**
```ts
import { test, expect } from "bun:test";
import { parseTeamPlan, integrationOrder } from "../../src/integrations/team-plan";

test("parses a fenced json plan block, strips it from prose", () => {
  const out = 'Here is the split:\n```json\n{"members":[{"title":"Auth","task":"oauth","source":"fresh-worktree"}],"integration":"combined-pr"}\n```\n';
  const r = parseTeamPlan(out, "lead");
  expect(r?.plan.members[0]).toMatchObject({ title: "Auth", task: "oauth" });
  expect(r?.plan.integration).toBe("combined-pr");
});

test("integrationOrder respects dependsOn (topological)", () => {
  const members = [
    { title: "B", task: "", source: "fresh-worktree" as const, dependsOn: ["A"] },
    { title: "A", task: "", source: "fresh-worktree" as const },
  ];
  expect(integrationOrder(members).map((m) => m.title)).toEqual(["A", "B"]);
});

test("returns null when no json block", () => {
  expect(parseTeamPlan("no plan here", "lead")).toBeNull();
});
```

**Step 2: Run, verify fail.** Run: `cd anvild && bun test test/unit/team-plan.test.ts` → FAIL (missing module).

**Step 3: Implement.**
```ts
import type { TeamPlan, TeamPlanMember } from "@protocol";

/** Extract the lead's fenced ```json team-plan block; returns null if absent/unparseable. */
export function parseTeamPlan(text: string, leadId: string): { plan: TeamPlan; prose: string } | null {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]!.trim()) as Partial<TeamPlan>;
    if (!Array.isArray(raw.members) || raw.members.length === 0) return null;
    const plan: TeamPlan = {
      leadId,
      members: raw.members.map((x) => ({
        title: String(x.title ?? "member"),
        task: String(x.task ?? ""),
        source: x.source === "existing-dir" ? "existing-dir" : "fresh-worktree",
        dependsOn: Array.isArray(x.dependsOn) ? x.dependsOn.map(String) : undefined,
      })),
      integration: raw.integration === "pr-per-member" ? "pr-per-member" : "combined-pr",
    };
    return { plan, prose: text.replace(m[0], "").trim() };
  } catch {
    return null;
  }
}

/** Topologically order members by `dependsOn` (title = node id). Stable; cycles fall back to input order. */
export function integrationOrder(members: TeamPlanMember[]): TeamPlanMember[] {
  const byTitle = new Map(members.map((m) => [m.title, m]));
  const seen = new Set<string>(), out: TeamPlanMember[] = [];
  const visit = (m: TeamPlanMember, stack: Set<string>) => {
    if (seen.has(m.title) || stack.has(m.title)) return;
    stack.add(m.title);
    for (const d of m.dependsOn ?? []) { const dep = byTitle.get(d); if (dep) visit(dep, stack); }
    stack.delete(m.title); seen.add(m.title); out.push(m);
  };
  for (const m of members) visit(m, new Set());
  return out;
}
```

**Step 4: Run, verify pass.** `cd anvild && bun test test/unit/team-plan.test.ts` → PASS.

**Step 5: Commit** `git commit -am "feat(teams): team-plan parse + integration order + test"`

---

### Task 6: `team-gate.ts` — autonomy gate decision

**Files:**
- Create: `anvild/src/integrations/team-gate.ts`
- Test: `anvild/test/unit/team-gate.test.ts`

**Step 1: Write failing test.**
```ts
import { test, expect } from "bun:test";
import { shouldAutoApprove } from "../../src/integrations/team-gate";

test("bypass auto-approves; everything else waits", () => {
  expect(shouldAutoApprove("bypass")).toBe(true);
  expect(shouldAutoApprove("mostly-autonomous")).toBe(false);
  expect(shouldAutoApprove("allowlist")).toBe(false);
  expect(shouldAutoApprove("prompt-all")).toBe(false);
});
```

**Step 2: Run, verify fail.** → FAIL (missing module).

**Step 3: Implement.**
```ts
import type { AutonomyPolicy } from "@protocol";
/** The team-plan gate rides the session's autonomy dial: only `bypass` auto-approves. */
export function shouldAutoApprove(autonomy: AutonomyPolicy): boolean {
  return autonomy === "bypass";
}
```

**Step 4: Run, verify pass.** → PASS.
**Step 5: Commit** `git commit -am "feat(teams): team-gate autonomy decision + test"`

---

### Task 7: `member-base.ts` — resolve a member's base ref

**Files:**
- Create: `anvild/src/integrations/member-base.ts`
- Test: `anvild/test/unit/member-base.test.ts`

**Step 1: Write failing test.**
```ts
import { test, expect } from "bun:test";
import { memberBaseRef } from "../../src/integrations/member-base";

test("fresh-worktree member branches off the lead branch; existing-dir needs none", () => {
  expect(memberBaseRef({ source: "fresh-worktree", leadBranch: "team/foo" })).toBe("team/foo");
  expect(memberBaseRef({ source: "existing-dir", leadBranch: "team/foo" })).toBeUndefined();
});
test("falls back to env default when lead branch unknown", () => {
  expect(memberBaseRef({ source: "fresh-worktree", leadBranch: undefined, envDefault: "main" })).toBe("main");
});
```

**Step 2: Run, verify fail.** → FAIL.

**Step 3: Implement.**
```ts
/** A member's worktree branches off the lead's branch HEAD (consistent start). existing-dir needs no base. */
export function memberBaseRef(a: { source: "fresh-worktree" | "existing-dir"; leadBranch?: string; envDefault?: string }): string | undefined {
  if (a.source === "existing-dir") return undefined;
  return a.leadBranch ?? a.envDefault ?? "HEAD";
}
```

**Step 4: Run, verify pass.** → PASS.
**Step 5: Commit** `git commit -am "feat(teams): member base-ref resolver + test"`

---

## Phase 3 — Daemon lifecycle & orchestration (spec + integrate against live code)

### Task 8: Stamp parent link on member spawn

**Files:**
- Modify: `anvild/src/session/supervisor.ts:1425-1470` (`handoffCreate`)
- Modify: `anvild/src/agent/default-tools.ts` (`DefaultToolDeps.handoff` arg type)

**Spec:** Extend the `handoffCreate` arg object and the `DefaultToolDeps.handoff` signature with optional `parentId?: string`, `teamRole?: "lead" | "member"`, `memberTask?: string`. When building `SessionCreateCmd`, pass them through; after `this.create(cmd)`, set the new fields on `session.data` before the `session.created` broadcast (so members arrive labeled). Reuse the existing `this.prompt(session.id, a.brief)` to auto-start. **Verify:** `bunx tsc --noEmit` passes; a member created with `parentId` appears in `deriveTeams`.
**Commit:** `feat(teams): handoffCreate stamps parent/role/task`

### Task 9: `teamInfo()` + broadcast

**Files:**
- Modify: `anvild/src/session/supervisor.ts` (add method near `autopilotPlansEvent`, ~`753`)

**Spec:** Add `private teamInfoEvent(): TeamInfoEvent { return { v: PROTOCOL_VERSION, type: "team.info", ts: now(), teams: deriveTeams(this.list()) }; }` and call `this.registry.toAll(this.teamInfoEvent())` everywhere sessions change (create/update/kill/status) — colocate with the existing `session.updated` broadcasts. Send `team.info` on WS attach alongside `session.list`. **Verify:** connect a client, spawn a member → client receives `team.info` with the member. **Commit:** `feat(teams): derive + broadcast team.info`

### Task 10: Lead MCP toolset

**Files:**
- Create: `anvild/src/agent/team-tools.ts` (mirror `default-tools.ts:65-145` structure)
- Modify: `anvild/src/session/supervisor.ts:1784-1797` (driver construction) to pass the team MCP server + tool ids when `session.data.teamRole === "lead"`

**Spec:** `buildTeamToolsServer(deps)` exposing, via the same `createSdkMcpServer`/`tool()` pattern: `propose_team_plan(members[], integration)` (emits a `team.plan` event for the gate), `create_member({title, task, source, base?, brief})` (calls `deps.handoff` with `parentId=<lead>`, `teamRole:"member"`, `memberTask:task`, `base=memberBaseRef(...)`), `list_members()` (returns `deriveTeams` rollup for this lead), `integrate()` (triggers Task 12). Define `TEAM_TOOL_IDS` like `DEFAULT_TOOL_IDS` (`default-tools.ts:61`). A lead session is a normal session whose `teamRole:"lead"` + `team` policy is set at creation. **Verify:** `sdk-smoke` style probe — a lead can call `create_member` and a labeled member session appears. **Commit:** `feat(teams): lead orchestration MCP tools`

### Task 11: Team-plan gate

**Files:**
- Modify: `anvild/src/server/dispatch.ts` (handle `team.plan.approve`/`team.plan.reject`)
- Modify: `anvild/src/session/supervisor.ts` (spawn members on approve; auto-approve when `shouldAutoApprove(lead.autonomy)`)

**Spec:** On `propose_team_plan`, if `shouldAutoApprove(lead.autonomy)` spawn immediately (up to `maxConcurrentMembers`); else emit `team.plan` and park. `team.plan.approve` spawns members from the (possibly user-edited) plan via `create_member`; `team.plan.reject` emits `team.plan.resolved{approved:false}`. Queue overflow beyond the cap starts as members finish (mirror `runAutopilot`'s cap loop, `supervisor.ts` autostart). **Verify:** unit-test the gate branch (Task 6 already covers the decision); integration: a `bypass` lead auto-spawns, a `mostly-autonomous` lead waits for `team.plan.approve`. **Commit:** `feat(teams): plan gate on autonomy dial`

---

## Phase 4 — Integration

### Task 12: Ordered merge → combined PR / per-member

**Files:**
- Create: `anvild/src/integrations/team-integrate.ts`
- Modify: `anvild/src/session/supervisor.ts` (handle `team.integrate`)
- Reuse: `anvild/src/git/ops.ts` (`commit:116`, `push:129`, `createPr:147`, `mergePr:165`), `session/worktree.ts`

**Spec:** For `integration === "combined-pr"`: compute `integrationOrder(members)`; in the **lead's own worktree** run `git merge <member-branch>` per member in order. A clean merge proceeds; a conflict is handed to the lead **as an agent turn** (prompt the lead session: "resolve the merge conflict in <files>, then commit") — reusing `this.prompt(leadId, ...)`. If the lead cannot resolve (still conflicted after its turn), set a `needs-human` marker on the lead and emit `team.info` surfacing the conflicted member; do not open a PR. On success, open one PR via the lead session's existing `createPr`. For `pr-per-member`: skip merging; each member opens its own PR via its own git lifecycle. **Verify:** integration test (Task in Phase 6) — 2-member team, `combined-pr` yields one PR branch containing both diffs; `pr-per-member` yields two. **Commit:** `feat(teams): integrate member branches → combined PR`

### Task 13: Budget + danger backstops

**Files:**
- Modify: `anvild/src/session/supervisor.ts` (member spawn path)

**Spec:** Cap concurrent members at `team.maxConcurrentMembers`. Before spawning a member, check the same budget signal `runAutopilot` uses; when in warn/soft-stop, **pause new spawns** (running members finish) and emit a note on `team.info`. Members inherit the standard `PreToolUse` danger-list gate (no change needed — they're sessions). **Verify:** unit-test the "pause when budget warns" predicate as a pure helper if extracted; otherwise assert via a stubbed budget in an integration test. **Commit:** `feat(teams): spawn cap + budget-aware pause`

---

## Phase 5 — Web GUI

### Task 14: Sidebar member tree

**Files:**
- Modify: `anvild/web/src/main.ts:2071` (`renderSessions`) and `:2097` (`renderSessionItem`)

**Spec:** In `renderSessions`, filter sessions with a `parentId` (whose lead is present) out of the top-level loop; after appending a lead's `<li>`, append a nested `<ul class="team-members">` rendering each member via `renderSessionItem` with an added `member` indent class, showing `memberTask` in the meta line. A lead row gains a rollup chip (`3 · 2▶ · 1⏳`) from the session's derived team (carried on `team.info`, cached client-side like `serverPlans`). Selecting a member makes it the active session (existing `selectSession`) — permission/question cards then work unchanged (they route via `sendTo(sessionId)`). **Verify:** `bun run typecheck:web && bun run build:web`; load client, spawn a member, see it nested under the lead. **Commit:** `feat(web): team member tree in sidebar`

### Task 15: Lead rollup + member board + event handling

**Files:**
- Modify: `anvild/web/src/main.ts` — add `team.info` to the top-level `onEvent` switch (~`744`); cache `teamsByServer: Map<url, TeamInfo[]>`; when a **lead** is the active session, render a member board above its conversation (one row per member: task, status dot, git dirty/ahead, PR badge; each row deep-links via `selectSession`).

**Spec:** Mirror the autopilot plans caching (`serverPlans`) for `team.info`. Board rows reuse the session projection already present. No change to the `activeId` drop-guard in v1 (member cards are answered by selecting the member). **Verify:** typecheck:web + build:web; opening a lead shows the board; clicking a row opens that member. **Commit:** `feat(web): lead member board + team.info handling`

---

## Phase 6 — Smoke, docs, close-out

### Task 16: Smoke test + docs + phase table

**Files:**
- Modify: `anvild/test/tools/headless-smoke.ts` (assert the sidebar render path doesn't throw with a lead + nested members in the session list)
- Create: `anvild/test/integration/team-integrate.test.ts` (2-member team in a temp repo: `combined-pr` → one PR branch with both diffs; `pr-per-member` → two)
- Modify: `docs/plans/anvil-team-support.md` (flip §11 phase rows to done as they land)

**Steps:**
1. Add the integration test; run `cd anvild && bun test test/integration/team-integrate.test.ts` → PASS.
2. Extend headless smoke; run `cd anvild && bun test test/web` (or the smoke runner) → PASS.
3. Full gate: `cd anvild && bunx tsc --noEmit && bun run typecheck:web && bun run build:web && bun test` → all green.
4. Update the design doc's phase table.
5. **Commit** `test(teams): integration + smoke; docs: flip phase table`

---

## Phase 7 — Live browser acceptance (gates the PR)

> The repo has **no committed browser-e2e harness** (`test/web` is jsdom via `dom-env.ts`), and teams are a fundamentally visual, multi-session feature. So the GUI is verified **live against a running daemon** — once by the agent, once by the user — before any PR. Neither is a unit test; both are acceptance gates.

**Shared prerequisite — run the daemon locally:**
```sh
cd anvild
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"   # subscription auth
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN             # §3 guard: daemon refuses to start otherwise
bun run build:web && bun run start                       # serves http://localhost:7701
```

### Task 17: Agent-driven live browser verification

**Who:** the executing agent, driving a real browser (agent-browser / the browser tool available at execution time) against `http://localhost:7701`. Not headless jsdom — a real page.

**Scenario (capture a screenshot at each ✔):**
1. Open `http://localhost:7701`; pick or add an environment (a small throwaway git repo). ✔ sidebar loads.
2. Create a **lead** session with a multi-part goal (e.g. "add a README section, add a trivial test, and a docs note" — three independent members). ✔ lead appears.
3. Lead proposes a plan → a **team-plan card** renders. Approve it. ✔ card → approved.
4. ✔ **members spawn as nested rows under the lead** in the sidebar, each showing its `memberTask`.
5. Open the lead → ✔ the **member board** renders above the conversation (one row per member with status + git).
6. Click a member row → ✔ it becomes the active session and its conversation shows.
7. Drive a member into a permission prompt (a task that hits the danger list) → ✔ a **permission card appears on that member**, and answering it (Allow) routes correctly and the member continues. *(This is the critical cross-session routing check — the design's known sharp edge.)*
8. Let members finish; trigger `integrate` → ✔ the lead opens **one PR** (combined-pr) and the lead row shows the PR badge.

**Expected:** all 8 ✔ observed; screenshots saved to `docs/plans/assets/team-verify/` (create dir). Any failure → file a fix task, re-run.
**Do NOT commit** browser screenshots into the PR unless they aid review; keep them local or attach to the PR description.

### Task 18: Manual browser acceptance (user)

**Who:** the user (David). **This task blocks the PR and cannot be self-approved by the agent.**

**Checklist — the agent presents this; the user runs it and replies with pass/fail per line:**
- [ ] Desktop `http://localhost:7701`: run the Task-17 scenario end to end; the team tree + member board read clearly.
- [ ] **Phone over Tailscale** (`https://<magicdns-host>/`): the sidebar member tree and member board are legible on a small screen; nesting/indent is clear, not cramped.
- [ ] A member entering `awaiting_permission` fires a **push notification**; opening it deep-links to that member; answering from the phone routes correctly.
- [ ] Switching a member↔lead↔another member mid-run reconciles without a stuck spinner or lost scroll position.
- [ ] `pr-per-member` mode (second run): each member opens its own PR; the lead does not merge.

**Gate:** the agent waits for the user's explicit per-line sign-off (ideally via `md-review-plus` with this checklist, or a direct reply). No PR until every box is checked.

### Task 19: Open the PR (gated)

**Preconditions (all must hold):** Tasks 17 and 18 signed off; `cd anvild && bunx tsc --noEmit && bun run typecheck:web && bun run build:web && bun test` all green.
**Action:** push `design/anvil-team-support` (or the implementation branch), open the PR with a body summarizing the feature, linking `docs/plans/anvil-team-support.md`, and noting the two acceptance gates passed. Prefer the worktree-safe flow in `anvild/scripts/merge-session.sh` semantics for any later merge (never `gh pr merge --delete-branch` in a worktree — CLAUDE.md).
**Commit/PR is the terminal step — do not merge without the user.**

---

## Definition of done

- All 19 tasks complete; the four CI gates (`typecheck`, `typecheck:web`, `build:web`, `bun test`) green.
- **Both live browser gates passed:** the agent's 8-step scenario (Task 17) and the user's manual acceptance on desktop + phone-over-Tailscale (Task 18) — before the PR (Task 19).
- A lead session can decompose → (gate) → spawn members in their own worktrees → integrate into one combined PR, all observable/chattable from the sidebar tree.
- `team.info` derives entirely from `parentId` (no separate store); a daemon restart reconstitutes the tree and heals member worktrees via existing recovery.
- Deferred (not in scope, per design §8): member↔member messaging, cross-member gating from the lead view, cross-daemon teams.
