/**
 * Real default adapters for the pipeline's injected side effects. Kept separate from the gate logic
 * (phases.ts) so the logic stays testable with fakes. The daemon wires these in — and overrides
 * `checks`/`openPr` with the environment's configured validation command and the existing git/PR
 * machinery where those are richer than the repo-agnostic defaults here.
 */
import { runAgentQuery } from "../agent/query";
import type { AgentFn, CaptureDiffFn } from "./phases";

/** The real agent adapter: drive either model through the one Agent SDK path. */
export const defaultAgent: AgentFn = (prompt, opts) => runAgentQuery(prompt, opts);

/** Capture a compact, repo-agnostic reference to the implemented change: HEAD sha + diffstat. */
export const captureGitDiff: CaptureDiffFn = async (repoRoot, signal) => {
  const git = async (args: string[]): Promise<string> => {
    const p = Bun.spawn(["git", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "ignore", signal });
    const out = await new Response(p.stdout).text();
    await p.exited; // [BE-6] reap the child — reading stdout alone leaves a zombie until GC
    return out.trim();
  };
  const [sha, stat] = await Promise.all([git(["rev-parse", "--short", "HEAD"]), git(["diff", "--stat", "HEAD~1"])]);
  const firstLine = stat.split("\n").filter(Boolean).slice(-1)[0] ?? "";
  return sha ? `${sha}${firstLine ? ` (${firstLine.trim()})` : ""}` : "(no commit)";
};
