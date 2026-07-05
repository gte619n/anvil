/**
 * [Phase 3 / BE-7] Autopilot plan selection + presentation, extracted from supervisor.ts as pure
 * functions. This is the business logic that decides what appears on the Autopilot card grid and how
 * each card/brief is shaped — previously untested. selectPendingPlans in particular encodes
 * non-trivial rules (started units drop off; held-for-clarification units stay; pipeline-run units
 * linger in review/blocked so their trace stays reviewable).
 */
import { test, expect } from "bun:test";
import type { WorkUnit } from "../../src/integrations/workunit";
import { selectPendingPlans, toPlanInfo, buildAutopilotBrief } from "../../src/integrations/autopilot-plans";

const wu = (o: Partial<WorkUnit>): WorkUnit =>
  ({
    id: "u1",
    environmentId: "e1",
    todoistProjectId: "p1",
    taskIds: [],
    title: "Do the thing",
    status: "planned",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as WorkUnit;

const fakeRenderer = { render: (source: string) => ({ source, html: `<p>${source}</p>` }) };

test("selectPendingPlans includes planned + needs-clarification units without a session", () => {
  const planned = wu({ id: "a", status: "planned" });
  const held = wu({ id: "b", status: "needs-clarification" });
  const picked = selectPendingPlans([planned, held]);
  expect(picked.map((u) => u.id)).toEqual(["a", "b"]);
});

test("selectPendingPlans drops units that already have a build session", () => {
  const started = wu({ id: "a", status: "planned", sessionId: "sess_1" });
  const heldStarted = wu({ id: "b", status: "needs-clarification", sessionId: "sess_2" });
  expect(selectPendingPlans([started, heldStarted])).toEqual([]);
});

test("selectPendingPlans keeps pipeline-run units in review/blocked, but not plain ones", () => {
  const pipe = { status: "shipped", phaseReached: "transfer", trace: {} } as unknown as WorkUnit["devPipeline"];
  const pipeReview = wu({ id: "a", status: "review", devPipeline: pipe });
  const pipeBlocked = wu({ id: "b", status: "blocked", devPipeline: pipe });
  const plainReview = wu({ id: "c", status: "review" }); // no devPipeline → not on the grid
  const picked = selectPendingPlans([pipeReview, pipeBlocked, plainReview]);
  expect(picked.map((u) => u.id).sort()).toEqual(["a", "b"]);
});

test("selectPendingPlans excludes unrelated statuses", () => {
  expect(selectPendingPlans([wu({ status: "completed" }), wu({ status: "in-progress" as WorkUnit["status"] })])).toEqual([]);
});

test("toPlanInfo maps core fields, includes env name + rendered plan, omits absent optionals", () => {
  const u = wu({ id: "x", title: "T", taskIds: ["t1", "t2"], plan: "# Plan", rationale: "because" });
  const info = toPlanInfo(u, "my-env", fakeRenderer);
  expect(info.id).toBe("x");
  expect(info.title).toBe("T");
  expect(info.environmentName).toBe("my-env");
  expect(info.taskCount).toBe(2);
  expect(info.plan?.html).toBe("<p># Plan</p>");
  expect(info.rationale).toBe("because");
  // absent optionals aren't present
  expect("summary" in info).toBe(false);
});

test("toPlanInfo omits environmentName when the env is gone, and plan when absent", () => {
  const info = toPlanInfo(wu({}), undefined, fakeRenderer);
  expect("environmentName" in info).toBe(false);
  expect(info.plan).toBeUndefined();
});

test("buildAutopilotBrief frames the unit as a build task, including rationale + plan when present", () => {
  const brief = buildAutopilotBrief(wu({ title: "Add search", rationale: "users asked", plan: "1. do it" }));
  expect(brief).toContain("Add search");
  expect(brief).toContain("users asked");
  expect(brief).toContain("1. do it");
  expect(brief).toContain("Implement it end to end");

  const minimal = buildAutopilotBrief(wu({ title: "Bare", rationale: undefined, plan: undefined }));
  expect(minimal).toContain("Bare");
  expect(minimal).not.toContain("Here is the plan");
});
