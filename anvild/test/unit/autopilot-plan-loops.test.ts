import { test, expect } from "bun:test";
import { buildAutopilotGoal, selectPendingPlans, toPlanInfo } from "../../src/integrations/autopilot-plans";
import type { WorkUnit } from "../../src/integrations/workunit";

const renderer = { render: (s: string) => ({ source: s, html: `<p>${s}</p>` }) } as unknown as Parameters<typeof toPlanInfo>[2];

function unit(over: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id: "wu1",
    environmentId: "env1",
    todoistProjectId: "p1",
    taskIds: ["t1"],
    title: "Add retry to upload",
    status: "planned",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...over,
  };
}

// ── buildAutopilotGoal: run-until-done stop-condition for the build session ──

test("buildAutopilotGoal derives a checkable condition from a planned unit", () => {
  const g = buildAutopilotGoal(unit({ plan: "1. edit uploader\n2. add test" }));
  expect(g).toContain("Add retry to upload");
  expect(g).toMatch(/build and tests pass/);
});

test("buildAutopilotGoal returns undefined without a plan (a bare title isn't checkable)", () => {
  expect(buildAutopilotGoal(unit({ plan: undefined }))).toBeUndefined();
  expect(buildAutopilotGoal(unit({ plan: "   " }))).toBeUndefined();
});

// ── toPlanInfo: carries the new card fields, strips the server-only dedupeKey ──

test("toPlanInfo carries hold, goalCondition, and a wire-shaped trigger", () => {
  const info = toPlanInfo(
    unit({
      status: "proposed",
      hold: { reason: "adversarial consensus 4/10 < 6 — held for review", at: "2026-07-30T01:00:00.000Z" },
      goalCondition: "the plan is built and tests pass",
      trigger: { kind: "ci-failure", source: "CI build #1421", at: "2026-07-30T02:00:00.000Z", dedupeKey: "ci-failure:x" },
    }),
    "web",
    renderer,
  );
  expect(info.hold?.reason).toContain("4/10");
  expect(info.goalCondition).toBe("the plan is built and tests pass");
  expect(info.trigger).toEqual({ kind: "ci-failure", source: "CI build #1421", at: "2026-07-30T02:00:00.000Z" });
  expect((info.trigger as unknown as Record<string, unknown>).dedupeKey).toBeUndefined(); // server-only, not on the wire
});

// ── selectPendingPlans: proposed units join the grid ──

test("selectPendingPlans surfaces a proposed unit awaiting approval", () => {
  const plans = selectPendingPlans([unit({ id: "p", status: "proposed" }), unit({ id: "d", status: "dismissed" })]);
  expect(plans.map((u) => u.id)).toEqual(["p"]);
});
