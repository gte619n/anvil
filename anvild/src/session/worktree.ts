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
 * The local branch a `base` ref refers to, for sync purposes: `HEAD` resolves to the currently
 * checked-out branch (undefined when detached), a bare local branch name resolves to itself, and
 * anything else (a remote ref, tag, or raw SHA the caller asked for explicitly) resolves to undefined
 * so we leave it untouched.
 */
function localBranchFor(repoRoot: string, base: string): string | undefined {
  if (base === "HEAD") {
    const cur = git(["symbolic-ref", "--short", "HEAD"], repoRoot);
    return cur.code === 0 ? cur.stdout.trim() : undefined; // detached HEAD → nothing to sync
  }
  const name = base.startsWith("refs/heads/") ? base.slice("refs/heads/".length) : base;
  return git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], repoRoot).code === 0 ? name : undefined;
}

/** The remote-tracking ref a local branch should sync to: its upstream, else `origin/<branch>` if
 *  that tracking ref exists. Undefined when the branch tracks nothing on a remote. */
function remoteTrackingRef(repoRoot: string, branch: string): string | undefined {
  const up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], repoRoot);
  if (up.code === 0 && up.stdout.trim()) return up.stdout.trim();
  const guess = `origin/${branch}`;
  return git(["rev-parse", "--verify", "--quiet", `refs/remotes/${guess}`], repoRoot).code === 0 ? guess : undefined;
}

/** True if `branch` is checked out in any worktree of this repo (so its ref must not be moved). */
function isCheckedOutAnywhere(repoRoot: string, branch: string): boolean {
  const r = git(["worktree", "list", "--porcelain"], repoRoot);
  if (r.code !== 0) return false;
  return r.stdout.split("\n").some((l) => l.trim() === `branch refs/heads/${branch}`);
}

/**
 * Opportunistically fast-forward the canonical checkout's local `branch` to its freshly-fetched
 * tracking ref, healing the stale-local-branch problem at the source (not just for the new worktree).
 * Strictly fast-forward and only when provably safe:
 *   • does nothing unless `branch` is already an ancestor of `tracking` (never a rewrite or non-ff merge);
 *   • if `branch` is the canonical checkout's current branch, advances it with `merge --ff-only` only
 *     when the tree has no tracked changes — so in-progress work is never disturbed;
 *   • if `branch` is checked out in no worktree, moves the ref directly with `branch -f`;
 *   • if some *other* worktree has it checked out (a live session), leaves it alone.
 * Never throws; on any failure the local branch simply stays put (the worktree already bases off
 * `tracking`, so correctness never depends on this).
 */
function fastForwardLocal(repoRoot: string, branch: string, tracking: string): void {
  if (git(["merge-base", "--is-ancestor", branch, tracking], repoRoot).code !== 0) return; // not a ff

  const here = git(["symbolic-ref", "--short", "HEAD"], repoRoot);
  if (here.code === 0 && here.stdout.trim() === branch) {
    const dirty = git(["status", "--porcelain", "--untracked-files=no"], repoRoot).stdout.trim();
    if (dirty) return; // tracked changes present — don't touch the user's working tree
    git(["merge", "--ff-only", tracking], repoRoot);
    return;
  }
  if (isCheckedOutAnywhere(repoRoot, branch)) return; // a live session is on it; can't move it safely
  git(["branch", "-f", branch, tracking], repoRoot);
}

/**
 * Resolve the ref a new worktree should actually branch from, keeping it in sync with the remote.
 *
 * The canonical checkout's local default branch (e.g. `main`) goes stale: after a session's PR merges
 * we `git fetch origin` (which only advances the remote-tracking ref `origin/main`) but never
 * fast-forward the local `main` — and a PR merged on GitHub directly teaches the local repo nothing
 * at all. A worktree branched off `HEAD`/`main` would then start from pre-merge code and silently
 * re-introduce just-merged work.
 *
 * So when `base` resolves to a local branch that tracks a remote, we fetch that remote branch,
 * opportunistically fast-forward the local branch to the new tip (see `fastForwardLocal`, healing the
 * staleness at the source), and return the remote-tracking ref (e.g. `origin/main`) for the worktree
 * to branch off — so it picks up the freshly-fetched tip even if the local branch couldn't be moved
 * (e.g. it's dirty or checked out elsewhere). Bases that aren't a tracked local branch — an explicit
 * remote ref, tag, SHA, or a detached/untracked branch — are honored unchanged. Best-effort: offline /
 * no-remote / failed fetch all fall back to `base`, so worktree creation never depends on the network.
 */
function syncedBase(repoRoot: string, base: string): string {
  const branch = localBranchFor(repoRoot, base);
  if (!branch) return base;
  const tracking = remoteTrackingRef(repoRoot, branch);
  if (!tracking) return base;

  const slash = tracking.indexOf("/"); // split "origin/feature/x" → remote "origin", branch "feature/x"
  const remote = tracking.slice(0, slash);
  const remoteBranch = tracking.slice(slash + 1);
  const fetched = git(["fetch", remote, remoteBranch], repoRoot); // updates refs/remotes/<tracking>
  if (fetched.code !== 0) return base;
  fastForwardLocal(repoRoot, branch, tracking);
  return tracking;
}

/**
 * Create a fresh git worktree off `base` (arch §5) on branch `branch` (the session name),
 * checked out at `<worktreeRoot>/<sessionId>`. The base is first synced to the remote tip when it
 * targets the default branch (see `syncedBase`) so sessions never start from a stale local `main`.
 * Throws if the branch already exists so the caller can ask for a different name.
 */
// [SEC-L1] `base` (and `branch`) become positional args to `git worktree add`. They're argv, so no
// shell injection, but a leading-dash value can be parsed as a git option, and git ref names forbid
// whitespace, `..`, `~^:?*[`, `\`, and control chars anyway. Validate before spawning git.
export function assertSafeRef(ref: string, label: string): void {
  const r = ref.trim();
  if (!r || r !== ref) throw new Error(`invalid git ${label} (empty or padded): ${JSON.stringify(ref)}`);
  if (r.startsWith("-")) throw new Error(`invalid git ${label} (looks like an option): ${ref}`);
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*\[\\\x00-\x1f]/.test(r) || r.includes("..")) {
    throw new Error(`invalid git ${label}: ${ref}`);
  }
}

export function createWorktree(
  repoRoot: string,
  base: string,
  branch: string,
  worktreeRoot: string,
  sessionId: string,
): CreatedWorktree {
  assertSafeRef(base, "base");
  assertSafeRef(branch, "branch");
  const cwd = join(worktreeRoot, sessionId);
  base = syncedBase(repoRoot, base);
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
    : git(["worktree", "add", "-b", branch, cwd, syncedBase(repoRoot, base)], repoRoot);
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

/**
 * True for a `git status --porcelain` line that is an untracked `node_modules` entry — the symlink
 * linkDeps injects into every worktree (and never user work). We can't rely on the target repo's
 * `.gitignore` to hide it: a dir-only `node_modules/` pattern (trailing slash) matches a directory
 * but NOT the symlink git sees, so such repos report the link as untracked and the worktree looks
 * perpetually dirty. That phantom file inflates the "changed" count, keeps the commit/push/merge
 * buttons live, and (via prBadgeFor) hides the "merged" badge. Drop it here so dirtyFileCount tracks
 * only real changes regardless of the repo's ignore conventions. (Anvil's own .gitignore uses the
 * slash-less form; this makes every other managed repo behave the same way without editing theirs.)
 */
function isLinkedNodeModules(porcelainLine: string): boolean {
  const m = porcelainLine.match(/^\?\? (.+)$/); // `??` = untracked
  if (!m) return false;
  const path = m[1]!.replace(/^"|"$/g, "").replace(/\/$/, ""); // unquote + drop any trailing slash
  return path === "node_modules" || path.endsWith("/node_modules");
}

/** Best-effort git state for the worktree panel (arch §8); undefined if `cwd` isn't a repo. */
export function gitStatus(cwd: string): GitStatus | undefined {
  const branch = git(["branch", "--show-current"], cwd);
  if (branch.code !== 0) return undefined;

  const dirty = git(["status", "--porcelain"], cwd).stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .filter((l) => !isLinkedNodeModules(l));

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
