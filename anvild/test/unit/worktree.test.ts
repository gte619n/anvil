import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, removeWorktree, gitStatus } from "../../src/session/worktree";
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
