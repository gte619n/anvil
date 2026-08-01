/**
 * [BE2-33] shaMatches was triplicated across daemon/watchdog/update-api and used a bare `startsWith`, so
 * a 1-char SHA matched anything — on the update/rollback path that's "adopt the wrong build as
 * known-good". The shared module adds a minimum-length guard: a prefix match is only trusted when both
 * sides are a plausibly-abbreviated SHA (≥7, git's default `%h` width).
 */
import { test, expect } from "bun:test";
import { shaMatches, shaOf } from "../../src/daemon/sha";

test("[BE2-33] full/abbreviated SHAs of the same commit match", () => {
  expect(shaMatches("abc1234", "abc1234def5678")).toBe(true);
  expect(shaMatches("abc1234def5678", "abc1234")).toBe(true);
  expect(shaMatches("abc1234", "abc1234")).toBe(true);
});

test("[BE2-33] different SHAs do not match", () => {
  expect(shaMatches("abc1234", "def5678")).toBe(false);
});

test("[BE2-33] empty/undefined never match", () => {
  expect(shaMatches("", "abc1234")).toBe(false);
  expect(shaMatches("abc1234", "")).toBe(false);
  expect(shaMatches(undefined, "abc1234")).toBe(false);
  expect(shaMatches(undefined, undefined)).toBe(false);
});

test("[BE2-33] a too-short value can't prefix-match an arbitrary commit (the guard)", () => {
  expect(shaMatches("a", "abc1234def")).toBe(false); // 'a' would have matched under the old startsWith
  expect(shaMatches("abc", "abc1234")).toBe(false); // 3 chars < 7 → not trusted as a prefix
  expect(shaMatches("abc", "abc")).toBe(true); // but an exact short match is still equal
});

test("[BE2-33] shaOf extracts the +sha from a version string", () => {
  expect(shaOf("3.0.5+abc1234")).toBe("abc1234");
  expect(shaOf("abc1234")).toBe("abc1234");
  expect(shaOf(undefined)).toBe("");
});
