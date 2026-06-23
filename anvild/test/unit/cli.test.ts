import { test, expect } from "bun:test";
import { claudeCliOptions } from "../../src/agent/cli";

test("dev / source: uses executable 'bun' (SDK resolves its bundled CLI from node_modules)", () => {
  expect(claudeCliOptions({})).toEqual({ executable: "bun" });
  expect(claudeCliOptions({ ANVIL_CLI_PATH: "   " })).toEqual({ executable: "bun" }); // blank ignored
});

test("packaged: ANVIL_CLI_PATH → pathToClaudeCodeExecutable, no bun needed (Phase 0/B)", () => {
  expect(claudeCliOptions({ ANVIL_CLI_PATH: "/Apps/Anvil Server.app/Contents/Resources/claude" })).toEqual({
    pathToClaudeCodeExecutable: "/Apps/Anvil Server.app/Contents/Resources/claude",
  });
});
