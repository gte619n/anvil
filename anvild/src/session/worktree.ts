import { existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { GitStatus, Worktree } from "@protocol";

/** Run git in `cwd`, capturing output. */
function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/**
 * Symlink the canonical checkout's installed dependencies into a freshly-created worktree
 * (best-effort). `git worktree add` only checks out tracked files, so a new worktree has no
 * `node_modules` and an in-worktree `tsc` / `build:web` can't run — sessions could only do a
 * syntax-level check before merging. We link (not copy — zero install cost) the repo root and each
 * immediate subdirectory that has its own `node_modules`, which covers monorepo layouts like
 * `anvild/node_modules`. Skips anything already present so it never clobbers real installs.
 */
function linkDeps(repoRoot: string, cwd: string): void {
  const candidates = ["."];
  try {
    for (const e of readdirSync(repoRoot, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== ".git" && e.name !== "node_modules") candidates.push(e.name);
    }
  } catch {
    return; // can't read the repo root — skip linking entirely
  }
  for (const rel of candidates) {
    const src = join(repoRoot, rel, "node_modules");
    const dest = join(cwd, rel, "node_modules");
    if (!existsSync(src) || existsSync(dest)) continue;
    try {
      symlinkSync(src, dest, "dir");
    } catch {
      // best-effort: a missing parent dir or FS error just means this dir goes unlinked
    }
  }
}

export interface CreatedWorktree {
  worktree: Worktree;
  cwd: string;
}

/**
 * Create a fresh git worktree off `base` (arch §5) on branch `branch` (the session name),
 * checked out at `<worktreeRoot>/<sessionId>`. Throws if the branch already exists so the
 * caller can ask for a different name.
 */
export function createWorktree(
  repoRoot: string,
  base: string,
  branch: string,
  worktreeRoot: string,
  sessionId: string,
): CreatedWorktree {
  const cwd = join(worktreeRoot, sessionId);
  const r = git(["worktree", "add", "-b", branch, cwd, base], repoRoot);
  if (r.code !== 0) {
    // An empty repo (unborn HEAD) can't branch a worktree — git only says "invalid reference: HEAD".
    if (git(["rev-parse", "--verify", "HEAD"], repoRoot).code !== 0) {
      throw new Error(`repository has no commits yet — make an initial commit in ${repoRoot} before starting a session`);
    }
    throw new Error(r.stderr.trim() || r.stdout.trim() || "git worktree add failed");
  }
  linkDeps(repoRoot, cwd);
  return { worktree: { repoRoot, branch, base }, cwd };
}

/**
 * Remove a worktree (arch §5 kill cleanup): `git worktree remove --force` (rmtree + prune
 * fallback), then delete the branch so the session name is reusable.
 */
export function removeWorktree(repoRoot: string, cwd: string, branch?: string): void {
  const r = git(["worktree", "remove", "--force", cwd], repoRoot);
  if (r.code !== 0) {
    rmSync(cwd, { recursive: true, force: true });
    git(["worktree", "prune"], repoRoot);
  }
  if (branch) git(["branch", "-D", branch], repoRoot); // free the name (best-effort)
}

export type WorktreeHealth = "ok" | "missing" | "not-a-worktree" | "wrong-branch";

/**
 * Classify a fresh-worktree session's working dir (restart recovery, arch §5). `ok` means the
 * directory exists, is a git worktree, and (if `branch` is given) is checked out on that branch.
 */
export function worktreeHealth(cwd: string, branch?: string): WorktreeHealth {
  if (!existsSync(cwd)) return "missing";
  const inside = git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return "not-a-worktree";
  if (branch) {
    const cur = git(["branch", "--show-current"], cwd);
    if (cur.code !== 0 || cur.stdout.trim() !== branch) return "wrong-branch";
  }
  return "ok";
}

/**
 * Re-establish a worktree at `cwd` on `branch` after it went missing (restart/reset recovery).
 * Prunes any stale registration, then re-adds the worktree from the existing branch; if the branch
 * itself is gone, recreates it off `base`. Returns whether the worktree is healthy afterward.
 */
export function recreateWorktree(repoRoot: string, cwd: string, branch: string, base = "HEAD"): { ok: boolean; error?: string } {
  // Clear any half-state so `worktree add` won't refuse ("already exists"/"missing but locked").
  git(["worktree", "remove", "--force", cwd], repoRoot);
  git(["worktree", "prune"], repoRoot);
  if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });

  const branchExists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot).code === 0;
  const add = branchExists
    ? git(["worktree", "add", cwd, branch], repoRoot)
    : git(["worktree", "add", "-b", branch, cwd, base], repoRoot);
  if (add.code !== 0) return { ok: false, error: add.stderr.trim() || add.stdout.trim() || "git worktree add failed" };
  linkDeps(repoRoot, cwd);
  return { ok: true };
}

type PrBadge = Pick<GitStatus, "prState" | "prUrl" | "prBranch">;

/**
 * The PR-badge fields a worktree should display, given a freshly-known PR state and the current
 * tree. The "merged" badge means "this branch is done and merged" — so it's suppressed while the
 * tree has uncommitted work (`dirtyFileCount > 0`), regardless of branch: new local changes mean the
 * branch is no longer cleanly merged and the "done" icon would be misleading. Open/closed states are
 * unaffected by dirtiness. Returns empty when there's no badge to show.
 */
export function prBadgeFor(
  prState: GitStatus["prState"],
  prUrl: string | undefined,
  branch: string,
  dirtyFileCount: number,
): PrBadge {
  if (!prState) return {};
  if (prState === "merged" && dirtyFileCount > 0) return {};
  return { prState, prUrl, prBranch: branch };
}

/**
 * Decide which PR badge fields survive a local git refresh. `gitStatus()` is local-only and can't
 * learn PR state, so we carry forward what we last learned from `gh` — but only while the worktree
 * is still on the branch that PR belongs to (a branch switch, e.g. new work after a merge, clears
 * it) and, for a merged PR, only while the tree stays clean (see `prBadgeFor`). Returns the fields
 * to copy onto the fresh status (empty when the badge no longer applies).
 */
export function carryPrBadge(prev: GitStatus | undefined, next: GitStatus): PrBadge {
  if (!prev?.prBranch || prev.prBranch !== next.branch) return {};
  return prBadgeFor(prev.prState, prev.prUrl, next.branch, next.dirtyFileCount);
}

/** Best-effort git state for the worktree panel (arch §8); undefined if `cwd` isn't a repo. */
export function gitStatus(cwd: string): GitStatus | undefined {
  const branch = git(["branch", "--show-current"], cwd);
  if (branch.code !== 0) return undefined;

  const dirty = git(["status", "--porcelain"], cwd).stdout.split("\n").filter((l) => l.trim().length > 0);

  let ahead = 0;
  let behind = 0;
  const ab = git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], cwd);
  if (ab.code === 0) {
    const parts = ab.stdout.trim().split(/\s+/).map(Number);
    behind = parts[0] ?? 0;
    ahead = parts[1] ?? 0;
  }

  const diffstat = git(["diff", "--stat"], cwd).stdout.split("\n").filter((l) => l.trim().length > 0);

  return { branch: branch.stdout.trim(), ahead, behind, dirtyFileCount: dirty.length, diffstat };
}
