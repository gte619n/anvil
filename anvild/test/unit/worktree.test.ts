import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryPrBadge, createWorktree, prBadgeFor, removeWorktree, gitStatus } from "../../src/session/worktree";
import type { GitStatus } from "@protocol";
import { ensureInitialCommit } from "../../src/git/ops";

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "anvil-repo-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

test("create + remove a fresh worktree off HEAD", () => {
  const repo = makeRepo();
  const wtRoot = mkdtempSync(join(tmpdir(), "anvil-wt-"));

  const created = createWorktree(repo, "HEAD", "my-task", wtRoot, "sess_abcd1234");
  expect(existsSync(created.cwd)).toBe(true);
  expect(existsSync(join(created.cwd, "README.md"))).toBe(true);
  expect(created.worktree.branch).toBe("my-task");
  expect(created.worktree.repoRoot).toBe(repo);

  // gitStatus resolves the worktree branch
  const status = gitStatus(created.cwd);
  expect(status?.branch).toBe(created.worktree.branch);
  expect(status?.dirtyFileCount).toBe(0);

  removeWorktree(repo, created.cwd);
  expect(existsSync(created.cwd)).toBe(false);

  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});

test("createWorktree branches off the fresh remote tip when the local default branch is stale", () => {
  // Simulate the real bug: a session's work merges into the remote default, but the canonical
  // checkout's local `main` never fast-forwards (a fetch only moves origin/main; a GitHub-side merge
  // teaches the local repo nothing). A new worktree based on HEAD/main must still start from the
  // merged remote tip — not the stale local commit.
  const origin = mkdtempSync(join(tmpdir(), "anvil-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], origin);

  const repo = mkdtempSync(join(tmpdir(), "anvil-repo-"));
  git(["clone", "-q", origin, repo], tmpdir());
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  git(["push", "-q", "origin", "main"], repo);

  // A second clone pushes new work to origin/main — the first checkout's local `main` is now stale.
  const other = mkdtempSync(join(tmpdir(), "anvil-other-"));
  git(["clone", "-q", origin, other], tmpdir());
  git(["config", "user.email", "t@example.com"], other);
  git(["config", "user.name", "Test"], other);
  writeFileSync(join(other, "merged.txt"), "merged work\n");
  git(["add", "."], other);
  git(["commit", "-q", "-m", "merged PR"], other);
  git(["push", "-q", "origin", "main"], other);

  const wtRoot = mkdtempSync(join(tmpdir(), "anvil-wt-"));
  const created = createWorktree(repo, "HEAD", "fresh-task", wtRoot, "sess_fresh1");

  // The new worktree sees the just-merged file even though the local `main` ref had never advanced.
  expect(existsSync(join(created.cwd, "merged.txt"))).toBe(true);
  // And the canonical checkout's local main was opportunistically fast-forwarded to the remote tip
  // (it was the current branch and the tree was clean), healing the staleness at the source.
  const localMain = git(["rev-parse", "main"], repo).stdout.toString().trim();
  const remoteMain = git(["rev-parse", "origin/main"], repo).stdout.toString().trim();
  expect(localMain).toBe(remoteMain);

  removeWorktree(repo, created.cwd);
  rmSync(origin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});

test("createWorktree leaves a dirty canonical checkout's local branch untouched but still bases off the fresh tip", () => {
  // The fast-forward must never disturb in-progress work: when the canonical checkout has uncommitted
  // tracked changes, local `main` stays where it is — yet the new worktree still starts from the
  // freshly-fetched remote tip (via origin/main) so it isn't stale.
  const origin = mkdtempSync(join(tmpdir(), "anvil-origin-"));
  git(["init", "-q", "--bare", "-b", "main"], origin);

  const repo = mkdtempSync(join(tmpdir(), "anvil-repo-"));
  git(["clone", "-q", origin, repo], tmpdir());
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  git(["push", "-q", "origin", "main"], repo);

  const other = mkdtempSync(join(tmpdir(), "anvil-other-"));
  git(["clone", "-q", origin, other], tmpdir());
  git(["config", "user.email", "t@example.com"], other);
  git(["config", "user.name", "Test"], other);
  writeFileSync(join(other, "merged.txt"), "merged work\n");
  git(["add", "."], other);
  git(["commit", "-q", "-m", "merged PR"], other);
  git(["push", "-q", "origin", "main"], other);

  const staleMain = git(["rev-parse", "main"], repo).stdout.toString().trim();
  writeFileSync(join(repo, "README.md"), "uncommitted local edit\n"); // dirty tracked change

  const wtRoot = mkdtempSync(join(tmpdir(), "anvil-wt-"));
  const created = createWorktree(repo, "HEAD", "dirty-task", wtRoot, "sess_dirty1");

  // Worktree still got the fresh remote work...
  expect(existsSync(join(created.cwd, "merged.txt"))).toBe(true);
  // ...but the dirty canonical checkout's local main was left exactly where it was.
  expect(git(["rev-parse", "main"], repo).stdout.toString().trim()).toBe(staleMain);
  expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("uncommitted local edit\n");

  removeWorktree(repo, created.cwd);
  rmSync(origin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});

test("createWorktree symlinks the canonical node_modules into the worktree (root + subdir)", () => {
  const repo = makeRepo();
  const wtRoot = mkdtempSync(join(tmpdir(), "anvil-wt-"));

  // Installed deps live in node_modules dirs that git never tracks — at the repo root and in a
  // package subdir (monorepo layout). The subdir itself IS tracked (it has a committed file).
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules", "marker"), "root-deps\n");
  mkdirSync(join(repo, "pkg"));
  writeFileSync(join(repo, "pkg", "keep.txt"), "x\n");
  mkdirSync(join(repo, "pkg", "node_modules"));
  writeFileSync(join(repo, "pkg", "node_modules", "marker"), "pkg-deps\n");
  git(["add", "pkg/keep.txt"], repo);
  git(["commit", "-q", "-m", "add pkg"], repo);

  const created = createWorktree(repo, "HEAD", "deps-task", wtRoot, "sess_deps1");

  // Both node_modules are symlinks in the worktree, and reading through them hits the canonical deps.
  expect(lstatSync(join(created.cwd, "node_modules")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(created.cwd, "node_modules", "marker"), "utf8")).toBe("root-deps\n");
  expect(lstatSync(join(created.cwd, "pkg", "node_modules")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(created.cwd, "pkg", "node_modules", "marker"), "utf8")).toBe("pkg-deps\n");

  removeWorktree(repo, created.cwd);
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});

test("gitStatus ignores the linked node_modules even when .gitignore uses a dir-only pattern", () => {
  // The classic merge-indicator bug: a managed repo whose .gitignore uses `node_modules/` (trailing
  // slash → directories only) doesn't match the *symlink* linkDeps creates, so git reports it as
  // untracked. Without filtering, dirtyFileCount > 0 keeps the git buttons live and hides the merged
  // badge. gitStatus must read a clean tree regardless of the repo's ignore style.
  const repo = makeRepo();
  const wtRoot = mkdtempSync(join(tmpdir(), "anvil-wt-"));

  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules", "marker"), "root-deps\n");
  mkdirSync(join(repo, "web"));
  writeFileSync(join(repo, "web", "keep.txt"), "x\n"); // tracked → web/ exists in the worktree
  mkdirSync(join(repo, "web", "node_modules"));
  writeFileSync(join(repo, "web", "node_modules", "marker"), "web-deps\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n"); // dir-only — does NOT match the symlink
  git(["add", ".gitignore", "web/keep.txt"], repo);
  git(["commit", "-q", "-m", "add gitignore + web"], repo);

  const created = createWorktree(repo, "HEAD", "ignore-task", wtRoot, "sess_ignore1");

  // The worktree has node_modules symlinks at root + web/, yet the tree reads clean.
  expect(lstatSync(join(created.cwd, "node_modules")).isSymbolicLink()).toBe(true);
  expect(lstatSync(join(created.cwd, "web", "node_modules")).isSymbolicLink()).toBe(true);
  expect(gitStatus(created.cwd)?.dirtyFileCount).toBe(0);

  // A real edit still counts — we only drop the node_modules links, not actual work.
  writeFileSync(join(created.cwd, "README.md"), "changed\n");
  expect(gitStatus(created.cwd)?.dirtyFileCount).toBe(1);

  removeWorktree(repo, created.cwd);
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});

test("createWorktree is fine when the repo has no deps to link", () => {
  const repo = makeRepo(); // no node_modules anywhere
  const wtRoot = mkdtempSync(join(tmpdir(), "anvil-wt-"));

  const created = createWorktree(repo, "HEAD", "no-deps", wtRoot, "sess_nodeps1");
  expect(existsSync(created.cwd)).toBe(true);
  expect(existsSync(join(created.cwd, "node_modules"))).toBe(false);

  removeWorktree(repo, created.cwd);
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});

function makeEmptyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "anvil-empty-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  return repo; // unborn HEAD — no commits
}

test("createWorktree on an empty repo throws an actionable error", () => {
  const repo = makeEmptyRepo();
  const wtRoot = mkdtempSync(join(tmpdir(), "anvil-wt-"));
  expect(() => createWorktree(repo, "HEAD", "my-task", wtRoot, "sess_empty1")).toThrow(/no commits yet/);
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});

test("ensureInitialCommit seeds a commit so a worktree can branch off HEAD", () => {
  const repo = makeEmptyRepo();
  const wtRoot = mkdtempSync(join(tmpdir(), "anvil-wt-"));

  const res = ensureInitialCommit(repo); // no origin → push fails best-effort, commit still made
  expect(res.initialized).toBe(true);
  expect(existsSync(join(repo, "README.md"))).toBe(true);
  expect(git(["rev-parse", "--verify", "HEAD"], repo).exitCode).toBe(0);

  // and now a session worktree can be created
  const created = createWorktree(repo, "HEAD", "my-task", wtRoot, "sess_seeded1");
  expect(existsSync(created.cwd)).toBe(true);

  // idempotent: a second call is a no-op once commits exist
  expect(ensureInitialCommit(repo).initialized).toBe(false);

  removeWorktree(repo, created.cwd);
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});

test("gitStatus returns undefined outside a repo", () => {
  const notRepo = mkdtempSync(join(tmpdir(), "anvil-norepo-"));
  expect(gitStatus(notRepo)).toBeUndefined();
  rmSync(notRepo, { recursive: true, force: true });
});

const mergedBadge = { prState: "merged" as const, prUrl: "https://example/pr/1", prBranch: "feature-work" };
const stat = (over: Partial<GitStatus> = {}): GitStatus => ({
  branch: "feature-work",
  ahead: 0,
  behind: 0,
  dirtyFileCount: 0,
  diffstat: [],
  ...mergedBadge,
  ...over,
});

test("carryPrBadge keeps the PR badge on its own branch and clears it after a branch switch", () => {
  const merged = stat();

  // Same branch, clean tree → the merged badge (and its URL) is carried forward.
  expect(carryPrBadge(merged, stat())).toEqual(mergedBadge);

  // New branch (more work started after the merge) → the stale badge clears entirely.
  expect(carryPrBadge(merged, stat({ branch: "more-work" }))).toEqual({});

  // No prior badge, or a prior status that never had a PR → nothing to carry.
  expect(carryPrBadge(undefined, stat())).toEqual({});
  expect(carryPrBadge(stat({ prState: undefined, prUrl: undefined, prBranch: undefined }), stat())).toEqual({});
});

test("a merged badge clears once there is uncommitted work, even on the same branch", () => {
  const merged = stat();

  // Same branch but the tree is now dirty → the "done" merged badge is suppressed.
  expect(carryPrBadge(merged, stat({ dirtyFileCount: 3 }))).toEqual({});
  expect(prBadgeFor("merged", "https://example/pr/1", "feature-work", 1)).toEqual({});

  // An open/closed PR is unaffected by dirtiness (uncommitted work alongside an open PR is normal).
  expect(prBadgeFor("open", "https://example/pr/1", "feature-work", 5)).toEqual({
    prState: "open",
    prUrl: "https://example/pr/1",
    prBranch: "feature-work",
  });
  // A merged PR on a clean tree still shows.
  expect(prBadgeFor("merged", "https://example/pr/1", "feature-work", 0)).toEqual(mergedBadge);
  // No PR → nothing to show.
  expect(prBadgeFor(undefined, undefined, "feature-work", 0)).toEqual({});
});
