/**
 * [P7] TeamCoordinator — the team orchestration domain extracted from Supervisor. Pins the injection
 * contract on the public surface: approve spawns via handoffCreate up to the lead's cap and queues the
 * overflow; a freed slot drains the queue (excluding the just-finished member from the active count);
 * budget pressure queues everything; onLeadKilled clears the queue so a dying lead can't re-spawn; the
 * lead-role guard on approve/reject/integrate. The MCP tool closures + integration git paths are
 * covered by team-tools/team-integrate units and the team dispatch integration tests.
 */
import { test, expect } from "bun:test";
import type { Budget, Session as SessionData, TeamPlan } from "@protocol";
import { TeamCoordinator, type TeamCoordinatorDeps } from "../../src/session/team-coordinator";
import { BadCommand } from "../../src/session/errors";
import type { Session } from "../../src/session/session";

type Spawned = { title: string; parentId: string; memberTask: string };

function harness(opts: { cap?: number; warn?: boolean } = {}) {
  const sessions = new Map<string, Session>();
  const spawned: Spawned[] = [];
  const events: string[] = [];
  const killed: string[] = [];
  let nextId = 1;

  const mkSession = (data: Partial<SessionData>): Session => {
    const s = {
      id: data.id!,
      data: { status: "idle", title: data.id, cwd: "/tmp", ...data } as SessionData,
      emitError: () => {},
    } as unknown as Session;
    sessions.set(s.id, s);
    return s;
  };

  const lead = mkSession({
    id: "lead1",
    teamRole: "lead",
    autonomy: "mostly-autonomous",
    team: { integration: "combined-pr", maxConcurrentMembers: opts.cap ?? 2 },
  });

  const deps: TeamCoordinatorDeps = {
    require: (id) => {
      const s = sessions.get(id);
      if (!s) throw new BadCommand(`no such session: ${id}`);
      return s;
    },
    getSession: (id) => sessions.get(id),
    list: () => [...sessions.values()].map((s) => s.data),
    registry: { toAll: (ev: { type: string }) => events.push(ev.type) } as unknown as TeamCoordinatorDeps["registry"],
    persist: () => {},
    broadcastUpdated: () => {},
    prompt: () => {},
    kill: async (id) => {
      killed.push(id);
    },
    budget: () => ({ available: true, warn: opts.warn ?? false }) as Budget,
    getEnvironment: () => undefined,
    handoffCreate: (a) => {
      const id = `m${nextId++}`;
      spawned.push({ title: a.title, parentId: a.parentId, memberTask: a.memberTask });
      mkSession({ id, title: a.title, parentId: a.parentId, teamRole: "member", status: "thinking" });
      return { id, title: a.title, cwd: "/tmp" };
    },
  };
  return { svc: new TeamCoordinator(deps), sessions, spawned, events, killed, lead };
}

const plan = (members: string[]): TeamPlan => ({
  leadId: "lead1",
  integration: "combined-pr",
  members: members.map((title) => ({ title, task: `do ${title}`, source: "existing-dir" as const })),
});

test("[P7] approveTeamPlan spawns members up to the cap and queues the overflow", async () => {
  const h = harness({ cap: 2 });
  await h.svc.approveTeamPlan("lead1", plan(["a", "b", "c"]));
  expect(h.spawned.map((s) => s.title)).toEqual(["a", "b"]); // cap 2 — "c" queued
  expect(h.spawned.every((s) => s.parentId === "lead1")).toBe(true);
  expect(h.events).toContain("team.plan.resolved");
});

test("[P7] drainQueuedMembers starts a queued member when a slot frees (justFinished excluded)", async () => {
  const h = harness({ cap: 2 });
  await h.svc.approveTeamPlan("lead1", plan(["a", "b", "c"]));
  expect(h.spawned).toHaveLength(2);
  // m1 finished its turn — the driver reports BEFORE the status flips to idle, so it must be
  // excluded from the active count for the drain to see the free slot.
  await h.svc.drainQueuedMembers("lead1", "m1");
  expect(h.spawned.map((s) => s.title)).toEqual(["a", "b", "c"]);
});

test("[P7] budget warn queues every member (spawn pause) and the drain respects it too", async () => {
  const h = harness({ cap: 2, warn: true });
  await h.svc.approveTeamPlan("lead1", plan(["a", "b"]));
  expect(h.spawned).toHaveLength(0); // all queued under budget pressure
  await h.svc.drainQueuedMembers("lead1");
  expect(h.spawned).toHaveLength(0); // still paused
});

test("[P7] onLeadKilled clears the queue so a dying lead cannot re-spawn members", async () => {
  const h = harness({ cap: 1 });
  await h.svc.approveTeamPlan("lead1", plan(["a", "b"]));
  expect(h.spawned).toHaveLength(1);
  h.svc.onLeadKilled("lead1");
  await h.svc.drainQueuedMembers("lead1", "m1");
  expect(h.spawned).toHaveLength(1); // queue was dropped with the lead
});

test("[P7] approve/reject/integrate guard the lead role (a non-lead session throws)", async () => {
  const h = harness();
  h.lead.data.teamRole = undefined; // e.g. the concierge — never created as a lead
  await expect(h.svc.approveTeamPlan("lead1", plan(["a"]))).rejects.toThrow(BadCommand);
  expect(() => h.svc.integrateTeam("lead1")).toThrow(BadCommand);
  await expect(h.svc.approveTeamPlan("nope")).rejects.toThrow(BadCommand);
});

test("[P7] approving an empty plan throws instead of resolving the card", async () => {
  const h = harness();
  await expect(h.svc.approveTeamPlan("lead1", plan([]))).rejects.toThrow(BadCommand);
});

test("[P7] teamInfoEvent derives the team tree from the flat session list", async () => {
  const h = harness({ cap: 3 });
  await h.svc.approveTeamPlan("lead1", plan(["a", "b"]));
  const ev = h.svc.teamInfoEvent();
  expect(ev.type).toBe("team.info");
  const team = ev.teams.find((t) => t.leadId === "lead1");
  expect(team?.members).toHaveLength(2);
});
