/**
 * How the Agent SDK should locate/launch the Claude Code CLI child process (Phase 0/B spike —
 * anvil-server-app.md §3.1, multi-server §9.1).
 *
 * - **Dev / run-from-source:** `executable: "bun"` — the SDK resolves its own bundled CLI from
 *   `node_modules/@anthropic-ai/claude-agent-sdk-<platform>` via `import.meta.url`.
 * - **Packaged (`bun build --compile`):** `node_modules` isn't on disk next to the binary, so that
 *   resolution fails ("Native CLI binary for … not found"). The fix is to ship the SDK's native CLI
 *   binary in the app and set `ANVIL_CLI_PATH` to it — the SDK then spawns that binary directly and
 *   **no `bun` is required on the user's machine.** (Verified by test/tools/compile-spike.ts.)
 */
type CliSpawn = { executable: "bun" } | { pathToClaudeCodeExecutable: string };

export function claudeCliOptions(env: Record<string, string | undefined> = process.env): CliSpawn {
  const cliPath = env.ANVIL_CLI_PATH?.trim();
  return cliPath ? { pathToClaudeCodeExecutable: cliPath } : { executable: "bun" };
}
