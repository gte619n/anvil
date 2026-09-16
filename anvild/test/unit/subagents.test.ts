import { test, expect } from "bun:test";
import { SubAgentTracker, type SubAgentSignal } from "../../src/agent/subagents";

const apply = (t: SubAgentTracker, sigs: SubAgentSignal[]): boolean[] => sigs.map((s) => t.apply(s));

test("a main-turn Task launch creates a running row, labelled from the description", () => {
  const t = new SubAgentTracker();
  const changed = t.apply({ kind: "start", taskId: "task_1", launchedBy: null, type: "Explore", label: "Audit mappings" });
  expect(changed).toBe(true);
  const [v] = t.snapshot();
  expect(v).toMatchObject({ id: "task_1", label: "Audit mappings", type: "Explore", state: "running", steps: 0 });
});

test("label falls back to type#n, then Sub-agent#n (D6/ID3)", () => {
  const t = new SubAgentTracker();
  t.apply({ kind: "start", taskId: "a", launchedBy: null, type: "Explore" });
  t.apply({ kind: "start", taskId: "b", launchedBy: null });
  const views = t.snapshot();
  expect(views[0]!.label).toBe("Explore #1");
  expect(views[1]!.label).toBe("Sub-agent #2");
});

test("steps count child tool_use; currentTool sets on step and clears on step_done", () => {
  const t = new SubAgentTracker();
  t.apply({ kind: "start", taskId: "task_1", launchedBy: null });
  expect(t.apply({ kind: "step", parent: "task_1", tool: "Grep" })).toBe(true);
  expect(t.apply({ kind: "step", parent: "task_1", tool: "Read" })).toBe(true);
  let v = t.snapshot()[0]!;
  expect(v.steps).toBe(2);
  expect(v.currentTool).toBe("Read");
  expect(t.apply({ kind: "step_done", parent: "task_1" })).toBe(true);
  v = t.snapshot()[0]!;
  expect(v.currentTool).toBeUndefined();
  // a redundant step_done (nothing running) is a no-op, not a broadcast
  expect(t.apply({ kind: "step_done", parent: "task_1" })).toBe(false);
});

test("grandchildren roll their steps up into the depth-1 ancestor (D12/ID7); no deeper row appears", () => {
  const t = new SubAgentTracker();
  t.apply({ kind: "start", taskId: "root", launchedBy: null, type: "general-purpose" });
  // root spawns a grandchild sub-agent (nested Task launch, parent = root)
  expect(t.apply({ kind: "start", taskId: "grand", launchedBy: "root" })).toBe(true);
  // the grandchild does two tools — both roll up to root
  t.apply({ kind: "step", parent: "grand", tool: "Read" });
  t.apply({ kind: "step", parent: "grand", tool: "Edit" });
  const views = t.snapshot();
  expect(views).toHaveLength(1); // still only the depth-1 row
  expect(views[0]!.id).toBe("root");
  // 1 (the nested launch) + 2 (its tools) = 3 steps rolled up
  expect(views[0]!.steps).toBe(3);
});

test("signals for an unknown parent are ignored (defensive)", () => {
  const t = new SubAgentTracker();
  expect(t.apply({ kind: "step", parent: "nope", tool: "Read" })).toBe(false);
  expect(t.snapshot()).toHaveLength(0);
});

test("progress overlay lifts step count (max), current tool, label/type; elapsed alone does NOT broadcast (ID11)", () => {
  const t = new SubAgentTracker();
  t.apply({ kind: "start", taskId: "task_1", launchedBy: null });
  t.apply({ kind: "step", parent: "task_1", tool: "Read" }); // local steps = 1
  // progress says 5 tool_uses → lifts to 5, sets currentTool + label/type → structural change
  expect(t.apply({ kind: "progress", taskId: "task_1", steps: 5, currentTool: "Bash", type: "Explore", label: "Deep dive", elapsedSeconds: 12 })).toBe(true);
  let v = t.snapshot()[0]!;
  expect(v.steps).toBe(5);
  expect(v.currentTool).toBe("Bash");
  expect(v.elapsedSeconds).toBe(12);
  // a later progress that only bumps elapsed is NON-structural → false (no broadcast), but the value updates
  expect(t.apply({ kind: "progress", taskId: "task_1", steps: 5, currentTool: "Bash", elapsedSeconds: 20 })).toBe(false);
  v = t.snapshot()[0]!;
  expect(v.elapsedSeconds).toBe(20);
  // progress must never REGRESS the step count below the locally-observed value
  expect(t.apply({ kind: "progress", taskId: "task_1", steps: 2 })).toBe(false);
  expect(t.snapshot()[0]!.steps).toBe(5);
});

test("finish() settles done/error and returns the durable view; cancelRunning() sweeps the rest (D7)", () => {
  const t = new SubAgentTracker();
  t.apply({ kind: "start", taskId: "ok", launchedBy: null, label: "one" });
  t.apply({ kind: "start", taskId: "bad", launchedBy: null, label: "two" });
  t.apply({ kind: "start", taskId: "still", launchedBy: null, label: "three" });

  expect(t.isTracked("ok")).toBe(true);
  expect(t.isTracked("mystery")).toBe(false);

  const okView = t.finish("ok", false);
  expect(okView).toMatchObject({ id: "ok", state: "done" });
  const badView = t.finish("bad", true, "boom");
  expect(badView).toMatchObject({ id: "bad", state: "error", error: "boom" });
  expect(t.finish("mystery", false)).toBeUndefined();

  expect(t.hasRunning()).toBe(true);
  expect(t.cancelRunning()).toBe(true);
  expect(t.hasRunning()).toBe(false);
  const states = Object.fromEntries(t.snapshot().map((v) => [v.id, v.state]));
  expect(states).toEqual({ ok: "done", bad: "error", still: "canceled" });
  // a second cancel sweep is a no-op
  expect(t.cancelRunning()).toBe(false);
});

test("snapshot preserves launch order; reset() clears everything (ID12)", () => {
  const t = new SubAgentTracker();
  t.apply({ kind: "start", taskId: "z", launchedBy: null });
  t.apply({ kind: "start", taskId: "a", launchedBy: null });
  expect(t.snapshot().map((v) => v.id)).toEqual(["z", "a"]);
  t.reset();
  expect(t.hasAny()).toBe(false);
  expect(t.snapshot()).toHaveLength(0);
});
