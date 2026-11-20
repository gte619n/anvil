/**
 * The daemon's state folder, protected for EVERY feature that keeps state there (merge item (c);
 * decisions 95, 119, 128). Track A's rule (./cad-protected.ts) denies the file tools anywhere under
 * the state dir except session worktrees and cloned repos, but it was registered only with
 * `cad-work`. The browser (`browser/**`, `browser-profile`, `browser-sites.json`,
 * `browser-loggedin.json`, `testdaemons.json`), the integration registry (`mcp-integrations.json`)
 * and the SolidCraft pin (`solidcraft*`, `solidcraft/**`) keep their state in the same folder, so the
 * same rule is registered whenever any of those features is on. It reuses Track A's resolver
 * (./tool-paths.ts: `~` expanded as the CLI does, case-insensitive, symlinks followed) and its Bash
 * tripwire.
 *
 * It also denies the file tools inside ANY folder named `.anvil-browser` (Playwright's output folder
 * in every worktree: page snapshots, screenshots and the files the download quarantine takes from)
 * and `.anvil-downloads` (the quarantine itself): both are the daemon's to write, so a planted file
 * can never pass as a download.
 */
import { refusedBash, refusedStatePath } from "./cad-protected";
import { registerProtectedRule, type ProtectedRule } from "./protected";
import { resolveToolPath, toolPathArg } from "./tool-paths";

/** Daemon-written folders inside a worktree (compared case-insensitively, as tool-paths does). */
const DAEMON_WORKTREE_DIRS = [".anvil-browser", ".anvil-downloads"];

/** Why `abs` is inside a daemon-written worktree folder, or undefined. */
export function refusedDaemonFolder(abs: string): string | undefined {
  const parts = abs.toLowerCase().split("/");
  const hit = DAEMON_WORKTREE_DIRS.find((d) => parts.includes(d));
  return hit ? `${hit}/ is written by the daemon's browser and its download quarantine; it is not a session's to edit` : undefined;
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Features whose state lives under the state dir; any one of them turns this protection on. */
export const STATE_FEATURES = ["cad-work", "mcp-integrations", "browser", "part-sources", "solidcraft-pin"] as const;

/** Register the state-dir rule for one daemon. Returns the thunk that withdraws it. */
export function registerStateDirProtection(stateDir: string, writable: string[]): () => void {
  const dirs: [string, string[]][] = [[stateDir, writable]];
  const rule: ProtectedRule = (ctx) => {
    if (FILE_TOOLS.has(ctx.tool)) {
      const target = resolveToolPath(toolPathArg(ctx.input), ctx.cwd);
      if (!target) return undefined;
      if (!target.ok) return { kind: "deny", reason: target.reason };
      const why = refusedDaemonFolder(target.abs) ?? refusedStatePath(target.abs, ctx.cwd, dirs);
      return why ? { kind: "deny", reason: why } : undefined;
    }
    if (ctx.tool === "Bash") {
      const why = refusedBash(typeof ctx.input.command === "string" ? ctx.input.command : "", [stateDir]);
      return why ? { kind: "deny", reason: why } : undefined;
    }
    return undefined;
  };
  return registerProtectedRule(rule);
}
