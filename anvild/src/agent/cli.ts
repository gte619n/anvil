/**
 * How the Agent SDK should locate/launch the Claude Code CLI child process (Phase 0/B spike —
 * anvil-server-app.md §3.1, multi-server §9.1).
 *
 * Resolution precedence (highest first):
 *   1. `ANVIL_CLI_PATH` env — packaged (`bun build --compile`) mode. `node_modules` isn't on disk
 *      next to the binary, so the SDK's own resolution fails ("Native CLI binary for … not found").
 *      We ship the SDK's native CLI binary and point here. (Verified by test/tools/compile-spike.ts.)
 *   2. A **managed** Claude CLI installed under the daemon state dir (see daemon/claude-cli.ts). This
 *      is how the Claude engine advances to the latest version *without* an Anvil release — set at
 *      boot by `setManagedCliPath()` and hot-swapped after an in-app "Update Claude engine".
 *   3. `executable: "bun"` — dev / run-from-source. The SDK resolves its own bundled CLI from
 *      `node_modules/@anthropic-ai/claude-agent-sdk-<platform>` via `import.meta.url`.
 *
 * See docs/plans/2026-11-10-managed-claude-cli-updates.md.
 */
type CliSpawn = { executable: "bun" } | { pathToClaudeCodeExecutable: string };

/** Managed CLI binary primed at boot (precedence 2). `undefined` ⇒ no managed install. */
let managedCliPath: string | undefined;

/**
 * Point every subsequent `query()` at a managed Claude CLI binary (or clear it with `undefined` to
 * fall back to the bundled CLI). Called at daemon boot once the state dir is known, and again after
 * an in-app CLI install so new sessions immediately use the new engine.
 */
export function setManagedCliPath(path: string | undefined): void {
  managedCliPath = path?.trim() || undefined;
}

/** The managed CLI binary currently in effect, if any (mainly for diagnostics/tests). */
export function currentManagedCliPath(): string | undefined {
  return managedCliPath;
}

export function claudeCliOptions(env: Record<string, string | undefined> = process.env): CliSpawn {
  const cliPath = env.ANVIL_CLI_PATH?.trim() || managedCliPath;
  return cliPath ? { pathToClaudeCodeExecutable: cliPath } : { executable: "bun" };
}
