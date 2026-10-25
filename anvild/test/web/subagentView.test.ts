import { test, expect } from "bun:test";
import { activityTitle, isSettled, mergeView } from "../../web/src/subagentView";

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
  expect(activityTitle(false, ["done", "running"])).toBe("Background agents running");
  expect(activityTitle(false, ["done", undefined])).toBe("Worked");
  expect(isSettled("canceled")).toBe(true);
  expect(isSettled("running")).toBe(false);
});
