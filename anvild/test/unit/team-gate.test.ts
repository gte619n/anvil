import { test, expect } from "bun:test";
import { shouldAutoApprove } from "../../src/integrations/team-gate";

test("bypass auto-approves; everything else waits", () => {
  expect(shouldAutoApprove("bypass")).toBe(true);
  expect(shouldAutoApprove("mostly-autonomous")).toBe(false);
  expect(shouldAutoApprove("allowlist")).toBe(false);
  expect(shouldAutoApprove("prompt-all")).toBe(false);
});
