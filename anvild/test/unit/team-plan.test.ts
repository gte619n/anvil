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
