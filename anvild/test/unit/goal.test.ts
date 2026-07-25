import { test, expect } from "bun:test";
import { parseGoalCommand, parseVerdict } from "../../src/agent/goal";

test("parseGoalCommand recognises set, clear, and status", () => {
  expect(parseGoalCommand("/goal all tests pass")).toEqual({ kind: "set", condition: "all tests pass" });
  expect(parseGoalCommand("  /goal   all tests pass  ")).toEqual({ kind: "set", condition: "all tests pass" });
  expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
  expect(parseGoalCommand("/goal")).toEqual({ kind: "status" });
});

test("parseGoalCommand ignores anything that is not the whole message", () => {
  // Matches Claude Code's slash-command rule and the existing /clear + /compact intercepts.
  expect(parseGoalCommand("please run /goal all tests pass")).toBeUndefined();
  expect(parseGoalCommand("/goalpost is unrelated")).toBeUndefined();
  expect(parseGoalCommand("/goals all tests pass")).toBeUndefined();
  expect(parseGoalCommand("")).toBeUndefined();
});

test("parseVerdict reads the judge's reply", () => {
  expect(parseVerdict("MET")).toEqual({ met: true, reason: "" });
  expect(parseVerdict("  met  ")).toEqual({ met: true, reason: "" });
  expect(parseVerdict("UNMET: 3 tests still failing")).toEqual({ met: false, reason: "3 tests still failing" });
  expect(parseVerdict("unmet: no evidence the file was created")).toEqual({
    met: false,
    reason: "no evidence the file was created",
  });
});

test("parseVerdict throws on an unparseable reply so the hook fails open (D6)", () => {
  expect(() => parseVerdict("I think maybe?")).toThrow();
  expect(() => parseVerdict("")).toThrow();
});
