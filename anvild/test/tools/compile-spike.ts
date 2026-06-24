/**
 * Phase 0/B compile spike (anvil-server-app.md §3.1, multi-server §9.1):
 * does `bun build --compile` preserve the Agent-SDK child-process spawn?
 *
 * The daemon drives Claude via the SDK's `query()`, which spawns the bundled Claude Code CLI with
 * `executable: "bun"`. We don't need a valid token — we only need to learn whether the CLI process
 * can be LAUNCHED. So we start a query with a dummy token and watch for the outcome:
 *   - the CLI launches and then fails on auth        → SPAWN OK   (compilation is fine)
 *   - ENOENT / "cannot find" / cli.js not resolvable → SPAWN FAIL (need Bun+source packaging)
 *
 * Run from source (baseline):   bun test/tools/compile-spike.ts
 * Run compiled:                 bun build --compile test/tools/compile-spike.ts --outfile /tmp/spike && /tmp/spike
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || "dummy-spike-token" };
delete (env as Record<string, string>).ANTHROPIC_API_KEY;

// When SPIKE_CLI_PATH is set, point the SDK at a shipped native CLI binary (the packaging escape
// hatch for compiled binaries) and drop `executable: "bun"` — the native binary self-executes.
const cliPath = process.env.SPIKE_CLI_PATH;
const q = query({
  prompt: "say hi",
  options: cliPath
    ? { model: "sonnet", env, settingSources: [], pathToClaudeCodeExecutable: cliPath }
    : { model: "sonnet", executable: "bun", env, settingSources: [] },
});

const timer = setTimeout(() => {
  console.log("RESULT: SPAWN_OK (CLI launched; no spawn error within the window)");
  process.exit(0);
}, 20_000);

try {
  for await (const m of q) {
    // Any message — even a system/error message — means the child process launched and is talking.
    console.log(`RESULT: SPAWN_OK (got SDK message type=${(m as { type?: string }).type})`);
    clearTimeout(timer);
    process.exit(0);
  }
  console.log("RESULT: SPAWN_OK (stream ended without a spawn error)");
  clearTimeout(timer);
  process.exit(0);
} catch (e) {
  clearTimeout(timer);
  const msg = e instanceof Error ? e.message : String(e);
  // Distinguish a spawn/resolution failure from an ordinary auth/usage error.
  const spawnFail = /ENOENT|spawn|cannot find|no such file|not found|MODULE_NOT_FOUND|cli\.js/i.test(msg);
  console.log(`RESULT: ${spawnFail ? "SPAWN_FAIL" : "SPAWN_OK (non-spawn error — CLI launched)"} :: ${msg}`);
  process.exit(spawnFail ? 1 : 0);
}
