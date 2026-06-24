import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneUnusedFollowupBranches } from "./ops";

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let root: string;
let work: string;

// A "remote" (bare) repo with a default branch, cloned into `work` so origin/HEAD and origin/main
// exist — the inputs pruneUnusedFollowupBranches relies on.
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "anvil-ops-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  git(["init", "--bare", "-b", "main", remote], root);
  git(["init", "-b", "main", seed], root);
  git(["config", "user.email", "t@t"], seed);
  git(["config", "user.name", "t"], seed);
  writeFileSync(join(seed, "README.md"), "# seed\n");
  git(["add", "-A"], seed);
  git(["commit", "-m", "init"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-u", "origin", "main"], seed);

  work = join(root, "work");
  git(["clone", remote, work], root); // sets origin/HEAD -> origin/main
  git(["config", "user.email", "t@t"], work);
  git(["config", "user.name", "t"], work);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("prunes an unused follow-up branch (no commits beyond default, not checked out)", () => {
  git(["branch", "feat_followup", "origin/main"], work); // sits exactly on the merged default
  const r = pruneUnusedFollowupBranches(work);
  expect(r.deleted).toContain("feat_followup");
});

test("keeps a follow-up branch that has real work", () => {
  git(["checkout", "-b", "busy_followup", "origin/main"], work);
  writeFileSync(join(work, "new.txt"), "work\n");
  git(["add", "-A"], work);
  git(["commit", "-m", "wip"], work);
  git(["checkout", "main"], work); // get off it so it's eligible by the checked-out rule
  const r = pruneUnusedFollowupBranches(work);
  expect(r.deleted).not.toContain("busy_followup");
});

test("ignores non-follow-up branches entirely", () => {
  git(["branch", "regular-branch", "origin/main"], work);
  const r = pruneUnusedFollowupBranches(work);
  expect(r.deleted).not.toContain("regular-branch");
});

test("never deletes a follow-up branch checked out in a worktree", () => {
  git(["branch", "live_followup", "origin/main"], work); // empty → would be eligible…
  const wt = join(root, "wt-live");
  git(["worktree", "add", wt, "live_followup"], work); // …but a worktree holds it
  try {
    const r = pruneUnusedFollowupBranches(work);
    expect(r.deleted).not.toContain("live_followup");
  } finally {
    git(["worktree", "remove", "--force", wt], work);
  }
});
