import { test, expect } from "bun:test";
import { memberBaseRef } from "../../src/integrations/member-base";

test("fresh-worktree member branches off the lead branch; existing-dir needs none", () => {
  expect(memberBaseRef({ source: "fresh-worktree", leadBranch: "team/foo" })).toBe("team/foo");
  expect(memberBaseRef({ source: "existing-dir", leadBranch: "team/foo" })).toBeUndefined();
});
test("falls back to env default when lead branch unknown", () => {
  expect(memberBaseRef({ source: "fresh-worktree", leadBranch: undefined, envDefault: "main" })).toBe("main");
});
