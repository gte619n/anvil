/**
 * [Phase 3 / BE-7] Pure PR-badge helpers extracted from supervisor.ts, where the
 * "copy badge onto git + detect change" triple was inlined 3× and the "eligible for a gh probe"
 * guard was duplicated between refreshPrState and refreshAllPrStates. Pinning them here dedupes the
 * logic and makes the sweep-eligibility rules (which gate network cost) testable.
 */
import { test, expect } from "bun:test";
import type { GitStatus } from "@protocol";
import { applyPrBadge, isPrSweepEligible } from "../../src/session/worktree";

const gs = (o: Partial<GitStatus>): GitStatus =>
  ({ branch: "feature", dirtyFileCount: 0, ahead: 0, behind: 0, ...o }) as GitStatus;

test("applyPrBadge copies fields and reports whether anything changed", () => {
  const g = gs({ branch: "feature" });
  expect(applyPrBadge(g, { prState: "open", prUrl: "u", prBranch: "feature" })).toBe(true);
  expect(g.prState).toBe("open");
  expect(g.prUrl).toBe("u");
  // idempotent: same badge → no change
  expect(applyPrBadge(g, { prState: "open", prUrl: "u", prBranch: "feature" })).toBe(false);
});

test("applyPrBadge clears fields when given an empty badge", () => {
  const g = gs({ prState: "merged", prUrl: "u", prBranch: "feature" });
  expect(applyPrBadge(g, {})).toBe(true);
  expect(g.prState).toBeUndefined();
  expect(g.prUrl).toBeUndefined();
  expect(g.prBranch).toBeUndefined();
});

test("isPrSweepEligible: needs a branch", () => {
  expect(isPrSweepEligible(gs({ branch: "" }), undefined)).toBe(false);
  expect(isPrSweepEligible(undefined, undefined)).toBe(false);
  expect(isPrSweepEligible(gs({ branch: "feature" }), undefined)).toBe(true);
});

test("isPrSweepEligible: falls back to the worktree branch when git has none", () => {
  expect(isPrSweepEligible(gs({ branch: "" }), "wt-branch")).toBe(true);
});

test("isPrSweepEligible: a merged PR on the same branch is terminal (skip), a switched branch is not", () => {
  // merged + still on the merged branch → terminal, not worth another probe
  expect(isPrSweepEligible(gs({ branch: "feature", prState: "merged", prBranch: "feature" }), "feature")).toBe(false);
  // merged, but work moved to a new branch → eligible again
  expect(isPrSweepEligible(gs({ branch: "feature_followup", prState: "merged", prBranch: "feature" }), "feature_followup")).toBe(true);
  // an open PR is always eligible
  expect(isPrSweepEligible(gs({ branch: "feature", prState: "open", prBranch: "feature" }), "feature")).toBe(true);
});
