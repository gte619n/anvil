import { test, expect } from "bun:test";
import { shouldAutoApprove, spawnPaused } from "../../src/integrations/team-gate";

test("bypass auto-approves; everything else waits", () => {
  expect(shouldAutoApprove("bypass")).toBe(true);
  expect(shouldAutoApprove("mostly-autonomous")).toBe(false);
  expect(shouldAutoApprove("allowlist")).toBe(false);
  expect(shouldAutoApprove("prompt-all")).toBe(false);
});

test("member spawns pause only while the budget is in its warn zone", () => {
  expect(spawnPaused({ warn: true })).toBe(true);
  expect(spawnPaused({ warn: false })).toBe(false);
  expect(spawnPaused({})).toBe(false);
});
