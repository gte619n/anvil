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
