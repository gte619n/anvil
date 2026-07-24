/**
 * Team integration (see docs/plans/anvil-team-support.md §4) — pure orchestration over an injected
 * git surface so it's deterministically testable. The lead merges each member branch into its OWN
 * worktree branch in dependency order, then opens ONE combined PR (default); `pr-per-member` skips
 * merging entirely (each member PRs its own branch through its own git lifecycle).
 *
 * Idempotent: a member whose commits are already an ancestor of the lead's HEAD (merged in an earlier,
 * possibly conflict-interrupted, run) is skipped — so after the lead resolves a conflict and commits,
 * re-running integration simply continues with the remaining members.
 */

/** One member to integrate, already in the desired merge order. `branch` absent → nothing to merge
 *  (an `existing-dir`/no-worktree member). */
export interface IntegrateMember {
  sessionId: string;
  title: string;
  branch?: string;
}

export interface IntegrateGit {
  isAncestor(cwd: string, ref: string): boolean;
  mergeBranch(cwd: string, branch: string, message?: string): { ok: boolean; conflicted: boolean; output: string };
  push(cwd: string, branch: string, remoteBranch?: string): { ok: boolean; output: string };
  createPr(cwd: string, title: string, body: string): { ok: boolean; output: string; url?: string };
}

export interface IntegrateInput {
  integration: "combined-pr" | "pr-per-member";
  leadCwd: string;
  leadBranch: string;
  leadRemoteBranch?: string;
  members: IntegrateMember[]; // ordered (integrationOrder already applied by the caller)
  prTitle: string;
  prBody: string;
  git: IntegrateGit;
}

export interface IntegrateResult {
  ok: boolean;
  mode: "combined-pr" | "pr-per-member";
  merged: string[]; // member titles merged (or already-merged) this run
  conflictedMember?: string; // set when a merge conflicted → team parks needs-human, no PR
  prUrl?: string;
  output: string;
}

export function integrateTeam(input: IntegrateInput): IntegrateResult {
  if (input.integration === "pr-per-member") {
    return {
      ok: true,
      mode: "pr-per-member",
      merged: [],
      output: "pr-per-member: each member opens its own PR through its own git lifecycle; the lead merges nothing.",
    };
  }

  const merged: string[] = [];
  for (const m of input.members) {
    if (!m.branch) continue; // no worktree to merge (research/read-only member)
    if (input.git.isAncestor(input.leadCwd, m.branch)) {
      merged.push(m.title); // already merged in an earlier run — skip, but count it
      continue;
    }
    const r = input.git.mergeBranch(input.leadCwd, m.branch, `Merge team member ${m.title} (${m.branch})`);
    if (!r.ok) {
      return {
        ok: false,
        mode: "combined-pr",
        merged,
        conflictedMember: m.title,
        output:
          `Merge conflict integrating "${m.title}" (${m.branch}) into ${input.leadBranch}. ` +
          `Resolve the conflicts in the lead worktree, commit, then run integrate again to continue.\n${r.output}`,
      };
    }
    merged.push(m.title);
  }

  const pushed = input.git.push(input.leadCwd, input.leadBranch, input.leadRemoteBranch);
  if (!pushed.ok) {
    return { ok: false, mode: "combined-pr", merged, output: `Merged ${merged.length} member(s), but push failed: ${pushed.output}` };
  }
  const pr = input.git.createPr(input.leadCwd, input.prTitle, input.prBody);
  return {
    ok: pr.ok,
    mode: "combined-pr",
    merged,
    prUrl: pr.url,
    output: pr.ok
      ? `Integrated ${merged.length ? merged.join(", ") : "no branches"}; opened PR ${pr.url ?? "(url not detected)"}.`
      : `Merged ${merged.length} member(s), but opening the PR failed: ${pr.output}`,
  };
}
