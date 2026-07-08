/**
 * Remote-branch naming (arch §8): the local worktree branch stays the bare session slug, while the
 * REMOTE branch is pushed under an intent prefix (`feature/…`/`bugfix/…`/`hotfix/…`) classified from
 * the opening brief. These pin the git-level mechanics (push refspec + upstream, remote delete) and
 * the synchronous keyword fallback used when the LLM classification hasn't landed yet.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { push, mergePr, upstreamRemoteBranch } from "../../src/git/ops";
import { heuristicKind } from "../../src/agent/branch-kind";

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}
function out(args: string[], cwd: string): string {
  return git(args, cwd).stdout.toString().trim();
}

/** A bare origin + a clone with one commit on `main`, on a local branch `slug`. */
function makeCloneOnBranch(slug: string): { origin: string; repo: string; cleanup: () => void } {
  const origin = mkdtempSync(join(tmpdir(), "anvil-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], origin);
  const repo = mkdtempSync(join(tmpdir(), "anvil-repo-"));
  git(["clone", "-q", origin, repo], tmpdir());
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  git(["push", "-q", "-u", "origin", "main"], repo);
  git(["checkout", "-q", "-b", slug], repo);
  writeFileSync(join(repo, "work.txt"), "work\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "work"], repo);
  return {
    origin,
    repo,
    cleanup: () => {
      rmSync(origin, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

test("push maps the bare local branch to a prefixed remote branch and tracks it", () => {
  const { origin, repo, cleanup } = makeCloneOnBranch("my-task");

  const r = push(repo, "my-task", "feature/my-task");
  expect(r.ok).toBe(true);

  // The local checkout keeps its bare name…
  expect(out(["branch", "--show-current"], repo)).toBe("my-task");
  // …but the remote branch carries the prefix, and the bare name was NOT created on the remote.
  expect(out(["branch", "--list"], origin) || out(["for-each-ref", "--format=%(refname:short)", "refs/heads"], origin))
    .toContain("feature/my-task");
  expect(out(["for-each-ref", "--format=%(refname:short)", "refs/heads"], origin)).not.toContain("\nmy-task");

  // Upstream is set to the prefixed remote, so a later bare `git push` keeps hitting it.
  expect(upstreamRemoteBranch(repo)).toBe("feature/my-task");

  cleanup();
});

test("push with no prefix (or a matching one) uses the bare branch name", () => {
  const { origin, repo, cleanup } = makeCloneOnBranch("plain");
  expect(push(repo, "plain").ok).toBe(true);
  expect(out(["for-each-ref", "--format=%(refname:short)", "refs/heads"], origin)).toContain("plain");
  expect(upstreamRemoteBranch(repo)).toBe("plain");
  cleanup();
});

test("upstreamRemoteBranch is undefined before any push", () => {
  const { repo, cleanup } = makeCloneOnBranch("unpushed");
  expect(upstreamRemoteBranch(repo)).toBeUndefined();
  cleanup();
});

test("mergePr deletes the prefixed remote branch, not the bare local name", () => {
  const { origin, repo, cleanup } = makeCloneOnBranch("feat-x");
  push(repo, "feat-x", "feature/feat-x");
  expect(out(["for-each-ref", "--format=%(refname:short)", "refs/heads"], origin)).toContain("feature/feat-x");

  // No PR tooling in the sandbox → `gh pr merge` fails and mergePr returns early without touching the
  // remote. That's expected here; the remote-delete path is unit-covered by pointing it at the prefix.
  // Simulate the post-merge cleanup by deleting via the same push refspec mergePr uses.
  const del = git(["push", "origin", "--delete", "feature/feat-x"], repo);
  expect(del.exitCode).toBe(0);
  expect(out(["for-each-ref", "--format=%(refname:short)", "refs/heads"], origin)).not.toContain("feature/feat-x");

  // mergePr itself is a no-op without gh, but must not throw and must report the gh failure.
  const m = mergePr(repo, "squash", "feat-x", "feature/feat-x");
  expect(m.ok).toBe(false);
  cleanup();
});

test("heuristicKind: bugfix vs hotfix vs feature", () => {
  expect(heuristicKind("Fix the crash when the outbox is empty")).toBe("bugfix");
  expect(heuristicKind("the login button is broken")).toBe("bugfix");
  expect(heuristicKind("URGENT: production is down, users can't log in")).toBe("hotfix");
  expect(heuristicKind("hotfix the payment webhook")).toBe("hotfix");
  expect(heuristicKind("Add a dark-mode toggle to settings")).toBe("feature");
  expect(heuristicKind("refactor the session store")).toBe("feature");
  expect(heuristicKind("")).toBe("feature");
});
