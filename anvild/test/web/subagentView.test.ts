import { test, expect } from "bun:test";
import { activityCountText, activityTitle, isSettled, mergeView } from "../../web/src/subagentView";

const v = (state: "running" | "done" | "error" | "canceled", extra: Record<string, unknown> = {}) => ({ id: "a", label: "L", state, steps: 1, ...extra });

test("a settled row never regresses to running; running → settled is allowed", () => {
  expect(mergeView(v("done"), v("running", { currentTool: "Grep" })).state).toBe("done");
  expect(mergeView(v("done"), v("running", { currentTool: "Grep" })).currentTool).toBeUndefined();
  expect(mergeView(v("running", { background: true }), v("done")).state).toBe("done");
});

test("the background flag is sticky across sources", () => {
  expect(mergeView(v("running", { background: true }), v("running")).background).toBe(true);
  expect(mergeView(v("running"), v("done", { background: true })).background).toBe(true);
  expect(mergeView(v("running"), v("done")).background).toBeUndefined();
});

test("activityTitle: live, ended-with-background-running, ended", () => {
  expect(activityTitle(true, ["running"])).toBe("Working");
  expect(activityTitle(false, ["done", "running"])).toBe("Background tasks running");
  expect(activityTitle(false, ["done", undefined])).toBe("Worked");
  expect(isSettled("canceled")).toBe(true);
  expect(isSettled("running")).toBe(false);
});

test("activityCountText: sub-agents and background shell tasks are counted separately", () => {
  expect(activityCountText([{}, {}], 9)).toBe("· 2 sub-agents");
  expect(activityCountText([{ kind: "shell" }], 9)).toBe("· 1 background task");
  expect(activityCountText([{}, { kind: "shell" }, { kind: "shell" }], 0)).toBe("· 1 sub-agent · 2 background tasks");
  expect(activityCountText([], 3)).toBe("· 3 steps");
  expect(activityCountText([], 0)).toBe("");
  expect(mergeView({ id: "a", label: "L", state: "running", steps: 0, kind: "shell" }, { id: "a", label: "L", state: "done", steps: 0 }).kind).toBe("shell");
});
