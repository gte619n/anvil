import { test, expect } from "bun:test";
import { teamTools, TEAM_TOOL_IDS, type TeamToolDeps } from "../../src/agent/team-tools";
import type { TeamInfo, TeamPlanMember } from "@protocol";

function stub(over: Partial<TeamToolDeps> = {}): { deps: TeamToolDeps; calls: any } {
  const calls: any = { proposed: null as null | { members: TeamPlanMember[]; integration: string }, created: [] as any[], integrated: 0, dismissed: [] as string[], messaged: [] as any[] };
  const deps: TeamToolDeps = {
    leadId: "lead",
    proposePlan: (members, integration) => { calls.proposed = { members, integration }; return `proposed ${members.length}`; },
    createMember: (a) => { calls.created.push(a); return { id: "sess_m", title: a.title, cwd: "/w/m" }; },
    listMembers: () => ({ leadId: "lead", policy: { integration: "combined-pr", maxConcurrentMembers: 3 }, members: [], rollup: { total: 0, running: 0, awaiting: 0, done: 0, error: 0 } } as TeamInfo),
    integrate: () => { calls.integrated++; return "integrated"; },
    dismissMember: (sid) => { calls.dismissed.push(sid); return `dismissed ${sid}`; },
    messageMember: (sid, text) => { calls.messaged.push({ sid, text }); return `messaged ${sid}`; },
    ...over,
  };
  return { deps, calls };
}

const byName = (deps: TeamToolDeps) => new Map(teamTools(deps).map((t) => [t.name, t]));
const text = (r: any) => r.content[0].text as string;

test("TEAM_TOOL_IDS are the namespaced lead tools", () => {
  expect(TEAM_TOOL_IDS).toEqual([
    "mcp__anvil_team__propose_team_plan",
    "mcp__anvil_team__create_member",
    "mcp__anvil_team__list_members",
    "mcp__anvil_team__integrate",
    "mcp__anvil_team__dismiss_member",
    "mcp__anvil_team__message_member",
  ]);
});

test("message_member forwards the id + text to the steering dep", async () => {
  const { deps, calls } = stub();
  await byName(deps).get("message_member")!.handler({ sessionId: "sess_m2", text: "focus on the API layer" }, {});
  expect(calls.messaged).toEqual([{ sid: "sess_m2", text: "focus on the API layer" }]);
});

test("dismiss_member forwards the session id to the teardown dep", async () => {
  const { deps, calls } = stub();
  const r = await byName(deps).get("dismiss_member")!.handler({ sessionId: "sess_m1" }, {});
  expect(calls.dismissed).toEqual(["sess_m1"]);
  expect(text(r)).toContain("sess_m1");
});

test("create_member forwards args to deps and confirms the spawn", async () => {
  const { deps, calls } = stub();
  const r = await byName(deps).get("create_member")!.handler(
    { title: "Auth", task: "oauth", source: "fresh-worktree", brief: "do oauth" }, {},
  );
  expect(calls.created[0]).toMatchObject({ title: "Auth", task: "oauth", source: "fresh-worktree", brief: "do oauth" });
  expect(text(r)).toContain("sess_m");
});

test("propose_team_plan routes members + integration to the gate", async () => {
  const { deps, calls } = stub();
  await byName(deps).get("propose_team_plan")!.handler(
    { members: [{ title: "A", task: "a", source: "fresh-worktree" }], integration: "combined-pr" }, {},
  );
  expect(calls.proposed).toMatchObject({ integration: "combined-pr" });
  expect(calls.proposed.members).toHaveLength(1);
});

test("a throwing dep surfaces as an isError tool result, not an exception", async () => {
  const { deps } = stub({ createMember: () => { throw new Error("worktree add failed"); } });
  const r = await byName(deps).get("create_member")!.handler(
    { title: "X", task: "t", source: "fresh-worktree", brief: "b" }, {},
  );
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("worktree add failed");
});
