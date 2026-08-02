/**
 * Team orchestration domain, extracted from Supervisor (P7 slice 5). Owns the team-plan lifecycle
 * (propose → approve/reject → spawn up to the concurrency cap → queue/drain overflow), the lead/member
 * MCP tool closures (propose_plan/create_member/…/message_lead), the lead↔member relay loop guard, the
 * derived team.info broadcast (immediate + BE2-21 coalesced), and branch integration.
 *
 * Behaviour-preserving: moved verbatim from Supervisor with the widest injection surface of the P7
 * slices — it CREATES sessions (via handoffCreate), KILLS them (dismiss/cascade), and PROMPTS them
 * (message relay, conflict handoff). The Supervisor delegates approveTeamPlan/rejectTeamPlan/
 * integrateTeam/noteHumanPrompt/teamInfoEvent here and calls onLeadKilled/drainQueuedMembers/
 * broadcastTeamInfo/scheduleTeamInfoBroadcast from its lifecycle paths.
 */
import {
  PROTOCOL_VERSION,
  type AutonomyPolicy,
  type Budget,
  type Environment,
  type Model,
  type Session as SessionData,
  type TeamInfo,
  type TeamInfoEvent,
  type TeamPlan,
  type TeamPlanEvent,
  type TeamPlanMember,
} from "@protocol";
import { now } from "../util/envelope";
import type { ConnectionRegistry } from "../server/registry";
import { buildTeamToolsServer } from "../agent/team-tools";
import { buildMemberToolsServer } from "../agent/member-tools";
import { memberBaseRef } from "../integrations/member-base";
import { shouldAutoApprove, spawnPaused, relayExhausted, MAX_TEAM_RELAY_HOPS } from "../integrations/team-gate";
import { deriveTeams } from "../integrations/team-tree";
import { integrationOrder } from "../integrations/team-plan";
import { integrateTeam as runTeamIntegration, safeRemoteBranch, type IntegrateMember } from "../integrations/team-integrate";
import * as git from "../git/ops";
import { gitStatus } from "./worktree";
import { slugify } from "./slug";
import { BadCommand } from "./errors";
import type { Session } from "./session";

export interface TeamCoordinatorDeps {
  /** Resolve a session or throw BadCommand (mirrors Supervisor.require). */
  require: (id: string) => Session;
  getSession: (id: string) => Session | undefined;
  /** The flat session-data list (Supervisor.list()) — the input to the derived team tree. */
  list: () => SessionData[];
  registry: ConnectionRegistry;
  persist: () => void;
  broadcastUpdated: (data: SessionData) => void;
  /** Queue a prompt on a session's InputQueue (starts a turn if idle) — the relay + conflict path. */
  prompt: (sessionId: string, text: string) => void;
  /** Full session teardown (worktree + branch + state) — the dismiss path. */
  kill: (id: string) => Promise<void>;
  budget: () => Budget;
  getEnvironment: (id: string) => Environment | undefined;
  /** Create-and-brief a new session (Supervisor.handoffCreate) — how members are spawned. */
  handoffCreate: (a: {
    environmentId?: string | undefined;
    repoRoot?: string | undefined;
    source: "fresh-worktree" | "existing-dir";
    cwd?: string | undefined;
    base?: string | undefined;
    title: string;
    model?: Model | undefined;
    autonomy?: AutonomyPolicy | undefined;
    brief: string;
    parentId: string;
    teamRole: "member";
    memberTask: string;
  }) => { id: string; title: string; cwd: string };
}

export class TeamCoordinator {
  // ── Teams (see docs/plans/anvil-team-support.md) ──────────────────────────────────────────────
  /** Plans awaiting the user's approval, keyed by lead id (the reviewable team-plan card). */
  private readonly pendingTeamPlans = new Map<string, TeamPlan>();
  /** The approved/active plan per lead — kept so `integrate` can order the merge by `dependsOn`. */
  private readonly activeTeamPlans = new Map<string, TeamPlan>();
  /** Members not yet spawned because the lead is at its concurrency cap; drained as members finish. */
  private readonly queuedMembers = new Map<string, TeamPlanMember[]>();
  /** Per-team (leadId) count of automatic lead↔member relay hops since the last human prompt — the
   *  loop guard for two-way conversations. Reset by `noteHumanPrompt`. */
  private readonly teamRelayHops = new Map<string, number>();

  constructor(private readonly deps: TeamCoordinatorDeps) {}

  /** Teams are derived (not stored): group the flat session list by `parentId` (see team-tree.ts). */
  teamInfoEvent(): TeamInfoEvent {
    return { v: PROTOCOL_VERSION, type: "team.info", ts: now(), teams: deriveTeams(this.deps.list()) };
  }
  broadcastTeamInfo(): void {
    const ev = this.teamInfoEvent();
    this.deps.registry.toAll(ev);
    this.lastTeamInfoJson = JSON.stringify(ev.teams); // keep the coalesced path from re-sending an identical tree
  }
  // [BE2-21] The full team tree was re-derived and broadcast to EVERY connection on every
  // session.updated (which fires several times per turn, for team and non-team sessions alike). Coalesce
  // (250ms) and skip when the derived tree hasn't actually changed, so ordinary status flaps don't fan
  // out an O(sessions) rollup to the whole fleet.
  private teamInfoTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTeamInfoJson = "";
  scheduleTeamInfoBroadcast(): void {
    if (this.teamInfoTimer) return;
    this.teamInfoTimer = setTimeout(() => {
      this.teamInfoTimer = null;
      const ev = this.teamInfoEvent();
      const json = JSON.stringify(ev.teams);
      if (json === this.lastTeamInfoJson) return; // nothing changed → no broadcast
      this.lastTeamInfoJson = json;
      this.deps.registry.toAll(ev);
    }, 250);
    this.teamInfoTimer.unref?.(); // never hold the process/test open for a coalesced broadcast
  }

  /** Build the lead-only orchestration MCP server, closed over this lead's session id. */
  buildTeamServer(leadId: string) {
    return buildTeamToolsServer({
      leadId,
      proposePlan: (members, integration) => this.teamProposePlan(leadId, members, integration),
      createMember: (a) => this.teamCreateMember(leadId, a),
      listMembers: () => this.teamListMembers(leadId),
      integrate: () => this.integrateTeam(leadId),
      dismissMember: (sid) => this.teamDismissMember(leadId, sid),
      messageMember: (sid, text) => this.teamMessageMember(leadId, sid, text),
    });
  }

  /** Steer a member (lead→member): queue `text` as a prompt for the member's next turn — the same
   *  input path any session uses. Guarded to the lead's own members. Member↔member peer messaging
   *  stays deferred (only leads get this tool), so there's no ping-pong risk between members. */
  private teamMessageMember(leadId: string, memberId: string, text: string): string {
    const member = this.deps.getSession(memberId);
    if (!member || member.data.parentId !== leadId) throw new BadCommand(`not a member of this team: ${memberId}`);
    this.chargeRelay(leadId);
    this.deps.prompt(memberId, text); // queues via the member's InputQueue; starts a turn if idle
    return `Sent to member "${member.data.title}" (${memberId}); it will act on your message next turn.`;
  }

  /** Member→lead reply: the other half of the two-way conversation. Queues the member's message as a
   *  prompt for the lead's next turn, attributed so the lead knows who spoke. Guarded to the member's
   *  own lead (a member can talk only to its lead — never a sibling: member↔member stays deferred). */
  private teamMessageLead(memberId: string, text: string): string {
    const member = this.deps.getSession(memberId);
    const leadId = member?.data.parentId;
    if (!member || !leadId) throw new BadCommand(`not a team member: ${memberId}`);
    const lead = this.deps.getSession(leadId);
    if (!lead || lead.data.teamRole !== "lead") throw new BadCommand("this member has no lead to message");
    this.chargeRelay(leadId);
    this.deps.prompt(leadId, `Member "${member.data.title}" (${memberId}) says: ${text}`);
    return `Relayed to your lead "${lead.data.title}"; it will see your message next turn.`;
  }

  /** Charge one lead↔member relay hop and enforce the loop guard. A human prompt to any team session
   *  resets the counter (see `noteHumanPrompt`), so a person can always continue a long conversation. */
  private chargeRelay(leadId: string): void {
    const hops = (this.teamRelayHops.get(leadId) ?? 0) + 1;
    if (relayExhausted(hops)) {
      throw new BadCommand(
        `Team relay limit reached (${MAX_TEAM_RELAY_HOPS} automatic lead↔member messages with no human input). ` +
          `Pausing the exchange to avoid a runaway agent-to-agent loop — the user can send a message to continue.`,
      );
    }
    this.teamRelayHops.set(leadId, hops);
  }

  /** A human prompt to a team session (lead or member) resets that team's relay hop counter — a real
   *  person in the loop clears the ping-pong guard. Called from the `prompt.send` dispatch path. */
  noteHumanPrompt(sessionId: string): void {
    const s = this.deps.getSession(sessionId);
    if (!s) return;
    const leadId = s.data.teamRole === "lead" ? s.data.id : s.data.parentId;
    if (leadId) this.teamRelayHops.delete(leadId);
  }

  /** Build the member-only tool server (message_lead), closed over this member's id. */
  buildMemberServer(memberId: string) {
    return buildMemberToolsServer({ memberId, messageLead: (text) => this.teamMessageLead(memberId, text) });
  }

  /** Dismiss (tear down) a member of this lead: reuse the standard session teardown (kill worktree +
   *  branch + state). Guarded so a lead can only dismiss its OWN members. */
  private teamDismissMember(leadId: string, memberId: string): string {
    const member = this.deps.getSession(memberId);
    if (!member || member.data.parentId !== leadId) throw new BadCommand(`not a member of this team: ${memberId}`);
    const title = member.data.title;
    void this.deps.kill(memberId); // async teardown; broadcasts session.deleted + team.info
    return `Dismissed member "${title}" (${memberId}); its worktree and branch are being removed.`;
  }

  /** The lead proposed a decomposition. At `bypass` autonomy it auto-approves and spawns; otherwise it
   *  parks a reviewable `team.plan` card and waits for `team.plan.approve` (see team-gate.ts). */
  private teamProposePlan(leadId: string, members: TeamPlanMember[], integration: TeamPlan["integration"]): string {
    const lead = this.deps.require(leadId);
    if (lead.data.teamRole !== "lead") throw new BadCommand("only a team lead can propose a team plan");
    const plan: TeamPlan = { leadId, members, integration };
    if (shouldAutoApprove(lead.data.autonomy)) {
      const started = this.startTeamPlan(plan);
      return `Auto-approved (bypass autonomy): started ${started} of ${members.length} member(s); the rest queue as slots free.`;
    }
    this.pendingTeamPlans.set(leadId, plan);
    const ev: TeamPlanEvent = { v: PROTOCOL_VERSION, type: "team.plan", ts: now(), sessionId: leadId, plan };
    this.deps.registry.toAll(ev);
    return `Proposed a ${members.length}-member plan (${integration}); awaiting the user's approval before spawning.`;
  }

  /** Approve a parked plan (possibly user-edited) and spawn its members up to the concurrency cap. */
  approveTeamPlan(leadId: string, plan?: TeamPlan): void {
    const lead = this.deps.require(leadId);
    // Guard the auth boundary: a client-supplied sessionId + hand-built plan must not spawn members
    // off a session that was never created as a lead (e.g. the concierge). Mirrors teamProposePlan.
    if (lead.data.teamRole !== "lead") throw new BadCommand("not a team lead");
    const chosen = plan ?? this.pendingTeamPlans.get(leadId);
    if (!chosen) throw new BadCommand(`no pending team plan for ${leadId}`);
    if (!chosen.members?.length) throw new BadCommand("cannot approve an empty team plan (no members)"); // #8
    this.pendingTeamPlans.delete(leadId);
    this.startTeamPlan({ ...chosen, leadId });
    this.deps.registry.toAll({ v: PROTOCOL_VERSION, type: "team.plan.resolved", ts: now(), sessionId: leadId, approved: true });
    void lead;
  }

  /** Reject a parked plan — no members spawn. */
  rejectTeamPlan(leadId: string): void {
    this.deps.require(leadId);
    this.pendingTeamPlans.delete(leadId);
    this.deps.registry.toAll({ v: PROTOCOL_VERSION, type: "team.plan.resolved", ts: now(), sessionId: leadId, approved: false });
  }

  /** Record the plan as active and spawn members up to the lead's cap; queue any overflow. Returns the
   *  count started now. */
  private startTeamPlan(plan: TeamPlan): number {
    const lead = this.deps.require(plan.leadId);
    if (lead.data.teamRole !== "lead") throw new BadCommand("not a team lead");
    if (!plan.members?.length) throw new BadCommand("cannot start an empty team plan (no members)"); // #8
    lead.data.team = lead.data.team ?? { integration: plan.integration, maxConcurrentMembers: 3 };
    lead.data.team.integration = plan.integration; // honor the plan's integration choice
    this.deps.persist();
    this.activeTeamPlans.set(plan.leadId, plan);
    // Budget backstop: while the subscription budget is warning, spawn nothing new — queue every
    // member and let the drain (on member completion / budget recovery) start them later.
    if (spawnPaused(this.deps.budget())) {
      this.queuedMembers.set(plan.leadId, [...(this.queuedMembers.get(plan.leadId) ?? []), ...plan.members]);
      return 0;
    }
    const cap = Math.max(1, lead.data.team.maxConcurrentMembers ?? 3); // #3: never 0/negative
    const room = Math.max(0, cap - this.activeMemberCount(plan.leadId));
    const toStart = plan.members.slice(0, room);
    const overflow = plan.members.slice(room);
    let started = 0;
    for (const m of toStart) if (this.spawnMember(plan.leadId, m)) started++;
    if (overflow.length) this.queuedMembers.set(plan.leadId, [...(this.queuedMembers.get(plan.leadId) ?? []), ...overflow]);
    return started; // actual successes, not attempts — a failed spawn must not inflate the count
  }

  /** Spawn one planned member, surfacing a failure to the lead's conversation rather than swallowing
   *  it (design §7: "that member is flagged and reported to the lead"). Returns true on success. A
   *  common cause is a branch-name collision (two teams in one repo asking for the same member title →
   *  the same branch slug → `git worktree add` fails). */
  private spawnMember(leadId: string, m: TeamPlanMember): boolean {
    try {
      this.teamCreateMember(leadId, { title: m.title, task: m.task, source: m.source, brief: m.task });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[teams] member spawn failed for "${m.title}":`, msg);
      this.deps.getSession(leadId)?.emitError(`Team member "${m.title}" failed to spawn — not added: ${msg}`, false);
      return false;
    }
  }

  /** Start queued members up to the lead's concurrency cap, unless the budget is paused. Called when a
   *  member frees a slot (its turn ends) so a large plan drains as capacity + budget allow.
   *  `justFinishedId` is the member whose completion triggered this: the driver fires `onResult` BEFORE
   *  flipping its status to idle (driver.ts), so we must exclude it from the active count or it would
   *  still occupy its own slot and the drain would be short by one (stalling a cap-1 team entirely). */
  drainQueuedMembers(leadId: string, justFinishedId?: string): void {
    const queue = this.queuedMembers.get(leadId);
    if (!queue || queue.length === 0) return;
    const lead = this.deps.getSession(leadId);
    if (!lead || lead.data.teamRole !== "lead") return;
    if (spawnPaused(this.deps.budget())) return; // still under budget pressure — leave them queued
    const cap = Math.max(1, lead.data.team?.maxConcurrentMembers ?? 3); // #3
    let room = Math.max(0, cap - this.activeMemberCount(leadId, justFinishedId));
    while (room > 0 && queue.length > 0) {
      const m = queue.shift()!;
      if (this.spawnMember(leadId, m)) room--; // a failed spawn is reported + dropped, not retried
    }
    if (queue.length === 0) this.queuedMembers.delete(leadId);
  }

  /** A lead is being torn down: drop its orchestration state so the cascade kills can't re-spawn
   *  queued members off a dying lead (#8: clears activeTeamPlans/queue too). Called from kill(). */
  onLeadKilled(leadId: string): void {
    this.queuedMembers.delete(leadId);
    this.pendingTeamPlans.delete(leadId);
    this.activeTeamPlans.delete(leadId);
    this.teamRelayHops.delete(leadId);
  }

  /** Members currently occupying a concurrency slot (spawned and not yet terminal). `excludeId` drops a
   *  member that is about to free its slot but hasn't flipped to idle yet (see drainQueuedMembers). */
  private activeMemberCount(leadId: string, excludeId?: string): number {
    return this.deps.list().filter(
      (s) => s.parentId === leadId && s.id !== excludeId && s.status !== "idle" && s.status !== "exited" && s.status !== "error",
    ).length;
  }

  /** Spawn one member session off the lead: its worktree branches off the lead's branch HEAD. */
  private teamCreateMember(
    leadId: string,
    a: { title: string; task: string; source: "fresh-worktree" | "existing-dir"; base?: string; brief: string },
  ): { id: string; title: string; cwd: string } {
    const lead = this.deps.require(leadId);
    const leadBranch = lead.data.worktree?.branch ?? lead.data.git?.branch;
    const env = lead.data.environmentId ? this.deps.getEnvironment(lead.data.environmentId) : undefined;
    const base = a.base ?? memberBaseRef({ source: a.source, leadBranch, envDefault: env?.defaultBase });
    // #1: auto-suffix the title so its branch slug is unique — two members whose titles slugify the
    // same (dup / case / punctuation / 32-char-truncation collision) no longer drop one silently.
    // #7: a lead without an env can still spawn members off its own repo (worktree repoRoot, or its
    // cwd when it's an existing-dir lead pointing at a git repo).
    const repoRoot = lead.data.worktree?.repoRoot ?? env?.repoRoot ?? lead.data.cwd;
    const title = a.source === "fresh-worktree" && repoRoot ? this.uniqueMemberTitle(repoRoot, a.title) : a.title;
    return this.deps.handoffCreate({
      environmentId: lead.data.environmentId,
      repoRoot,
      source: a.source,
      cwd: a.source === "existing-dir" ? lead.data.cwd : undefined,
      base,
      title,
      model: lead.data.model,
      autonomy: lead.data.autonomy,
      brief: a.brief,
      parentId: leadId,
      teamRole: "member",
      memberTask: a.task,
    });
  }

  /** A member title whose branch slug is free in `repoRoot` — appends " 2", " 3", … on collision. */
  private uniqueMemberTitle(repoRoot: string, desired: string): string {
    if (!git.branchExists(repoRoot, slugify(desired))) return desired;
    for (let n = 2; n < 200; n++) {
      const cand = `${desired} ${n}`;
      if (!git.branchExists(repoRoot, slugify(cand))) return cand;
    }
    return desired; // exhausted — let the spawn fail and surface the error via spawnMember
  }

  private teamListMembers(leadId: string): TeamInfo | null {
    return deriveTeams(this.deps.list()).find((t) => t.leadId === leadId) ?? null;
  }

  /** Integrate member branches per the team policy (combined-pr merges into the lead's worktree in
   *  dependency order → one PR; pr-per-member is a no-op merge). Idempotent + resumable: on a merge
   *  conflict it prompts the lead to resolve as an agent turn, then a re-run continues. */
  integrateTeam(leadId: string): string {
    const lead = this.deps.require(leadId);
    if (lead.data.teamRole !== "lead") throw new BadCommand("only a team lead can integrate");
    const team = deriveTeams(this.deps.list()).find((t) => t.leadId === leadId);
    if (!team || team.members.length === 0) throw new BadCommand("this lead has no members to integrate");
    // #6: don't merge a member's branch while it's mid-work — refuse until every member is terminal.
    const stillRunning = team.members.filter((m) => m.status !== "idle" && m.status !== "exited" && m.status !== "error");
    if (stillRunning.length) {
      throw new BadCommand(
        `Cannot integrate yet — ${stillRunning.length} member(s) still working: ${stillRunning.map((m) => m.task ?? m.sessionId).join(", ")}. ` +
          `Wait for them to finish (or dismiss them) before integrating.`,
      );
    }

    // Order members by the plan's dependsOn when we have it (session.title === plan member title,
    // stamped at spawn); hand-added members with no plan entry keep their natural order at the end.
    const memberSessions = team.members
      .map((m) => this.deps.getSession(m.sessionId)?.data)
      .filter((s): s is SessionData => !!s);
    const plan = this.activeTeamPlans.get(leadId);
    let ordered = memberSessions;
    if (plan) {
      const byTitle = new Map(memberSessions.map((s) => [s.title, s]));
      const seen = new Set<string>();
      const out: SessionData[] = [];
      for (const pm of integrationOrder(plan.members)) {
        const s = byTitle.get(pm.title);
        if (s && !seen.has(s.id)) { out.push(s); seen.add(s.id); }
      }
      for (const s of memberSessions) if (!seen.has(s.id)) out.push(s);
      ordered = out;
    }

    const members: IntegrateMember[] = ordered.map((s) => ({
      sessionId: s.id,
      title: s.title,
      branch: s.worktree?.branch,
    }));
    const integration = lead.data.team?.integration ?? "combined-pr";
    // Guard the push target: never push the combined branch ONTO the repo's default/base branch. If the
    // remote-branch classifier tagged the lead as "main"/"master" (or the base), pushing branch:main
    // would try to shove team work straight onto main — fall back to the branch's own name instead.
    const baseName = lead.data.worktree?.base?.replace(/^origin\//, "");
    const leadRemoteBranch = safeRemoteBranch(lead.data.worktree?.remoteBranch, baseName);
    const result = runTeamIntegration({
      integration,
      leadCwd: lead.data.cwd,
      leadBranch: lead.data.worktree?.branch ?? lead.data.git?.branch ?? "HEAD",
      leadRemoteBranch,
      members,
      prTitle: `${lead.data.title}: team integration`,
      prBody: `Combined PR integrating ${members.length} team member(s):\n${members.map((m) => `- ${m.title}${m.branch ? ` (${m.branch})` : ""}`).join("\n")}`,
      git,
    });

    // Refresh the lead's git projection (branch/PR badge) and the derived team rollup.
    lead.data.git = gitStatus(lead.data.cwd);
    this.deps.persist();
    this.deps.broadcastUpdated(lead.data);

    if (!result.ok && result.failedMember && result.conflicted) {
      // A real conflict: hand it to the lead as an agent turn; a re-run of integrate() continues past it.
      this.deps.prompt(
        leadId,
        `Integration hit a merge conflict pulling in member "${result.failedMember}". ` +
          `Resolve the conflicts in this worktree, commit the merge, then call the integrate tool again to continue.`,
      );
    }
    // #8: a completed integrate consumes the active plan (no stale dependsOn lingering for a re-run).
    if (result.ok) this.activeTeamPlans.delete(leadId);
    return result.output;
  }
}
