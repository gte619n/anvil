/**
 * The autopilot "Plan with Claude" session's in-process MCP tools (planning-tools.ts) — the interactive
 * replacement for the old refine chat. These drive the exported `planningTools` handlers directly (no
 * live SDK server), asserting each forwards to its work-unit-scoped dep and surfaces the summary/error.
 */
import { test, expect } from "bun:test";
import { planningTools, PLANNING_TOOL_IDS, type PlanningToolDeps } from "../../src/agent/planning-tools";

function stub(over: Partial<PlanningToolDeps> = {}): { deps: PlanningToolDeps; calls: any } {
  const calls: any = { saved: [] as { plan: string; ready: boolean }[], pipeline: 0 };
  const deps: PlanningToolDeps = {
    sessionId: "sess_plan",
    savePlan: (plan, ready) => { calls.saved.push({ plan, ready }); return `saved (${ready ? "settled" : "checkpoint"})`; },
    runPipeline: () => { calls.pipeline++; return "pipeline started"; },
    ...over,
  };
  return { deps, calls };
}

const byName = (deps: PlanningToolDeps) => new Map(planningTools(deps).map((t) => [t.name, t]));
const text = (r: any) => r.content[0].text as string;

test("PLANNING_TOOL_IDS are the namespaced planning-session tools", () => {
  expect(PLANNING_TOOL_IDS).toEqual(["mcp__anvil_planning__save_plan", "mcp__anvil_planning__run_pipeline"]);
});

test("save_plan forwards the plan + ready flag and confirms the save", async () => {
  const { deps, calls } = stub();
  const r = await byName(deps).get("save_plan")!.handler({ plan: "# Plan\ndo it", ready: true }, {});
  expect(calls.saved).toEqual([{ plan: "# Plan\ndo it", ready: true }]);
  expect(text(r)).toContain("settled");
});

test("save_plan defaults ready to true when omitted", async () => {
  const { deps, calls } = stub();
  await byName(deps).get("save_plan")!.handler({ plan: "x" }, {});
  expect(calls.saved[0].ready).toBe(true);
});

test("save_plan can checkpoint a work-in-progress plan (ready=false)", async () => {
  const { deps, calls } = stub();
  const r = await byName(deps).get("save_plan")!.handler({ plan: "wip", ready: false }, {});
  expect(calls.saved[0].ready).toBe(false);
  expect(text(r)).toContain("checkpoint");
});

test("run_pipeline engages the dev loop for this unit", async () => {
  const { deps, calls } = stub();
  const r = await byName(deps).get("run_pipeline")!.handler({}, {});
  expect(calls.pipeline).toBe(1);
  expect(text(r)).toContain("pipeline started");
});

test("a throwing dep surfaces as a tool error, not an unhandled rejection", async () => {
  const { deps } = stub({ savePlan: () => { throw new Error("not a planning session"); } });
  const r = (await byName(deps).get("save_plan")!.handler({ plan: "x", ready: true }, {})) as any;
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("not a planning session");
});
