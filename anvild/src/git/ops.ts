/**
 * Git / gh operations on a session worktree (arch §8). All shell out and return combined
 * stdout+stderr so the UI can show exactly what happened. PR ops use the `gh` CLI.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

function run(cmd: string[], cwd: string): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
  return { code: r.exitCode, out };
}

/**
 * Derive a directory name from a git URL: the last path segment with any `.git`
 * suffix / trailing slash stripped. Handles ssh-scp (`git@host:owner/repo.git`),
 * `ssh://`, and `https://` forms.
 */
export function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "");
}

// [SEC-H5] Clone-URL guard. `git clone <url>` treats `ext::sh -c '…'` as a remote helper that runs
// an arbitrary shell command, and a leading-dash "URL" as a git option — both RCE, since the URL is
// caller-supplied ("add environment from git URL"). We allowlist the intended transports rather than
// blocklist the dangerous ones (new remote helpers appear); `cloneRepo` additionally passes `--` and
// disables the ext protocol as defense-in-depth.
const HTTPS_OR_SSH = /^(https?|ssh):\/\/[^\s]+$/i;
// scp-form: [user@]host.tld:path — require a dot in the host and a non-empty path, and forbid the
// `::` remote-helper separator so `ext::…` can't masquerade as scp-form.
const SCP_FORM = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}:(?!:)[^\s].*$/;

export function assertSafeCloneUrl(url: string): void {
  const u = url.trim();
  if (!u) throw new Error("a git URL is required");
  if (u.startsWith("-")) throw new Error(`invalid git URL (looks like an option): ${url}`);
  if (u.includes("::")) throw new Error(`unsupported git URL (remote-helper syntax not allowed): ${url}`);
  if (HTTPS_OR_SSH.test(u) || SCP_FORM.test(u)) return;
  throw new Error(`unsupported git URL scheme (use https://, ssh://, or user@host:path): ${url}`);
}

/**
 * Clone `url` into `<parent>/<repo-name>` using the host's git auth (SSH keys,
 * credential helpers). `parent` is caller-supplied (configurable; see `Config.clonesDir`) so the
 * clone destination never depends on the daemon's install location. Synchronous. Throws on a bad
 * URL, an existing destination, or a git failure (message carries git's combined output for the UI).
 */
export function cloneRepo(url: string, parent: string): { dest: string; output: string } {
  assertSafeCloneUrl(url); // [SEC-H5] before any name derivation / mkdir / spawn
  const trimmed = url.trim();
  const name = repoNameFromUrl(trimmed);
  if (!name) throw new Error(`could not derive a repo name from URL: ${url}`);
  const dest = join(parent, name);
  if (existsSync(dest)) {
    throw new Error(`destination already exists: ${dest}`);
  }
  mkdirSync(parent, { recursive: true });
  // `-c protocol.ext.allow=never` neutralizes the ext remote helper even if the allowlist is ever
  // loosened; `--` stops any dash-leading value from being read as an option.
  const r = run(["git", "-c", "protocol.ext.allow=never", "clone", "--", trimmed, dest], parent);
  if (r.code !== 0) {
    throw new Error(`git clone failed: ${r.out || `exit ${r.code}`}`);
  }
  // A freshly-created (empty) repo clones with an unborn HEAD — there's no commit to branch a
  // session worktree from, so seed one. Otherwise `session.create` fails with git's cryptic
  // "invalid reference: HEAD".
  const init = ensureInitialCommit(dest);
  return { dest, output: init.initialized ? `${r.out}\n${init.output}` : r.out };
}

/**
 * If `dest` is an empty repo (unborn HEAD), seed it with an initial commit so HEAD resolves and
 * sessions can branch a worktree off it. Writes a minimal README, commits with the host's git
 * identity, and best-effort pushes so the remote default branch is initialized too. No-op (and
 * never throws) if the repo already has commits or the commit can't be made — callers that need a
 * commit surface a clear error later instead.
 */
export function ensureInitialCommit(dest: string): { initialized: boolean; output: string } {
  if (run(["git", "rev-parse", "--verify", "HEAD"], dest).code === 0) {
    return { initialized: false, output: "" };
  }
  const ref = run(["git", "symbolic-ref", "--short", "HEAD"], dest);
  const branch = ref.code === 0 && ref.out.trim() ? ref.out.trim() : "main";
  const readme = join(dest, "README.md");
  if (!existsSync(readme)) writeFileSync(readme, `# ${basename(dest)}\n`);
  run(["git", "add", "-A"], dest);
  const commit = run(["git", "commit", "-m", "Initial commit"], dest);
  if (commit.code !== 0) {
    return { initialized: false, output: `could not auto-create an initial commit: ${commit.out}` };
  }
  const pushed = run(["git", "push", "-u", "origin", branch], dest);
  return {
    initialized: true,
    output:
      pushed.code === 0
        ? `seeded an initial commit on ${branch} and pushed to origin`
        : `seeded a local initial commit on ${branch} (push failed: ${pushed.out})`,
  };
}

const CAP = 60_000;
const cap = (s: string): string => (s.length > CAP ? `${s.slice(0, CAP)}\n… (truncated)` : s);

export function diff(cwd: string): { ok: boolean; output: string } {
  const r = run(["git", "--no-pager", "diff", "HEAD"], cwd);
  return { ok: r.code === 0, output: cap(r.out) || "(no uncommitted changes)" };
}

export function commit(cwd: string, message: string): { ok: boolean; output: string } {
  run(["git", "add", "-A"], cwd);
  const r = run(["git", "commit", "-m", message], cwd);
  return { ok: r.code === 0, output: r.out || (r.code === 0 ? "committed" : "nothing to commit") };
}

/**
 * Push the local worktree branch, setting upstream tracking. When `remoteBranch` differs from the
 * local `branch` (the usual case — the local slug maps to a `feature/…`/`bugfix/…`/`hotfix/…` remote,
 * arch §8), push a `branch:remoteBranch` refspec so the remote reads as intent while the checkout
 * keeps its bare name. `-u` then tracks `origin/remoteBranch`, so later plain `git push` in this
 * worktree keeps hitting the same remote branch.
 */
export function push(cwd: string, branch: string, remoteBranch?: string): { ok: boolean; output: string } {
  const refspec = remoteBranch && remoteBranch !== branch ? `${branch}:${remoteBranch}` : branch;
  const r = run(["git", "push", "-u", "origin", refspec], cwd);
  return { ok: r.code === 0, output: r.out || "pushed" };
}

/**
 * The remote branch this worktree already tracks (upstream `origin/<name>` → `<name>`), or
 * undefined if no upstream is set yet. Used to avoid re-prefixing — and thereby orphaning the old
 * remote — a branch that was already pushed (e.g. a session created before remote-branch prefixing).
 */
export function upstreamRemoteBranch(cwd: string): string | undefined {
  const r = run(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  if (r.code !== 0) return undefined;
  const name = r.out.trim();
  return name.startsWith("origin/") ? name.slice("origin/".length) : name || undefined;
}

export function createPr(cwd: string, title: string, body: string): { ok: boolean; output: string; url?: string } {
  const r = run(["gh", "pr", "create", "--title", title, "--body", body], cwd);
  const url = r.out.match(/https?:\/\/\S+/)?.[0];
  return { ok: r.code === 0, output: r.out, url };
}

/**
 * Merge the PR for the current branch. NB: no `--delete-branch` — letting gh delete the merged
 * branch forces the local checkout off it (onto the default branch, or a detached HEAD when the
 * default is already checked out in another worktree), which orphans a session worktree on the
 * "wrong branch" forever (and, because gh switches the checkout *before* it deletes the remote
 * branch, the failed switch aborts the whole cleanup so the remote branch is left behind too).
 * Instead, when `branch` is given (a worktree session), we roll the worktree onto a fresh
 * `<branch>_followup` branch based on the freshly-merged default, delete the merged branch locally,
 * and delete the remote branch with a plain push (which never touches the checkout) — so work can
 * continue cleanly, no remote branch is orphaned, and the health check stays happy.
 * Returns `newBranch` when a rollover happened so the caller can update the session's recorded branch.
 */
export function mergePr(
  cwd: string,
  method: "merge" | "squash" | "rebase",
  branch?: string,
  remoteBranch?: string,
): { ok: boolean; output: string; newBranch?: string } {
  const flag = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
  const r = run(["gh", "pr", "merge", flag], cwd);
  if (r.code !== 0 || !branch) return { ok: r.code === 0, output: r.out || "merged" };

  // Pull the merged state down so the follow-up branch starts from the new default-branch tip
  // (after a squash/rebase merge the local merged-branch tip has diverged from it).
  run(["git", "fetch", "origin"], cwd);

  // Delete the remote branch ourselves — what `--delete-branch` would have done, but as a plain push
  // so it never tries to move the local checkout and can't abort the rest of the cleanup. Best-effort:
  // the remote may already be gone (e.g. branch-protection auto-delete) and that's not a failure.
  // The remote branch carries the intent prefix (`feature/…`), which differs from the local slug.
  const remote = remoteBranch ?? branch;
  const remoteDeleted = run(["git", "push", "origin", "--delete", remote], cwd).code === 0;
  const remoteNote = remoteDeleted ? `; deleted remote ${remote}` : "";

  const def = defaultBranch(cwd);
  const start = def ? `origin/${def}` : "HEAD";
  const followup = freeFollowupBranch(cwd, branch);
  const co = run(["git", "checkout", "-b", followup, start], cwd);
  if (co.code !== 0) {
    // Couldn't roll over (e.g. uncommitted changes block the checkout) — leave the worktree on the
    // merged branch, which is still fine to keep working on. Surface it rather than failing silently.
    return { ok: true, output: `${r.out}\n(merged${remoteNote}; stayed on ${branch}: ${co.out})` };
  }
  run(["git", "branch", "-D", branch], cwd); // local-only; the merge is safely on the remote default
  return { ok: true, output: `${r.out}\nrolled onto ${followup} (off ${start}); deleted local ${branch}${remoteNote}`, newBranch: followup };
}

/** The remote's default branch (e.g. "main") via origin/HEAD; undefined if it isn't set locally. */
function defaultBranch(cwd: string): string | undefined {
  const r = run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  const name = r.code === 0 ? r.out.trim() : "";
  return name.startsWith("origin/") ? name.slice("origin/".length) : undefined;
}

/** A `<branch>_followup` name not already taken locally (…_followup, _followup_2, _followup_3, …). */
function freeFollowupBranch(cwd: string, branch: string): string {
  const base = `${branch}_followup`;
  const exists = (name: string) =>
    run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cwd).code === 0;
  if (!exists(base)) return base;
  for (let i = 2; i < 1000; i++) {
    if (!exists(`${base}_${i}`)) return `${base}_${i}`;
  }
  return `${base}_${Date.now()}`; // unreachable in practice; never collide
}

/** Local branch names matching `<x>_followup` / `<x>_followup_<n>`. */
function listFollowupBranches(cwd: string): string[] {
  const r = run(["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd);
  if (r.code !== 0) return [];
  return r.out.split("\n").map((l) => l.trim()).filter((b) => /_followup(_\d+)?$/.test(b));
}

/** Branches currently checked out in any worktree of this repo (must not be deleted). */
function checkedOutBranches(cwd: string): Set<string> {
  const r = run(["git", "worktree", "list", "--porcelain"], cwd);
  const out = new Set<string>();
  for (const line of r.out.split("\n")) {
    const m = line.match(/^branch refs\/heads\/(.+)$/);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

/**
 * Delete local follow-up branches that were never used. A follow-up branch is "unused" when it is
 * not checked out in any worktree and has no commits beyond the default branch — i.e. the user
 * merged and then never continued the work. Follow-up branches are local-only (we never push them),
 * so an untouched one is pure garbage. Best-effort and safe: branches with real work, or that a live
 * session is sitting on, are left alone. Returns the names actually deleted.
 */
export function pruneUnusedFollowupBranches(repoRoot: string): { deleted: string[]; output: string } {
  const def = defaultBranch(repoRoot);
  if (!def) return { deleted: [], output: "skipped: no origin/HEAD default branch" };
  const checkedOut = checkedOutBranches(repoRoot);
  const deleted: string[] = [];
  for (const b of listFollowupBranches(repoRoot)) {
    if (checkedOut.has(b)) continue; // a live session is on it
    const ahead = run(["git", "rev-list", "--count", `${b}`, `^origin/${def}`], repoRoot);
    if (ahead.code !== 0 || ahead.out.trim() !== "0") continue; // has unique commits → real work
    if (run(["git", "branch", "-D", b], repoRoot).code === 0) deleted.push(b);
  }
  return { deleted, output: deleted.length ? `pruned ${deleted.join(", ")}` : "no unused follow-up branches" };
}

/** PR state for the current branch via `gh` (network); undefined if there's no PR. */
export function prStatus(cwd: string): { state?: "open" | "merged" | "closed"; url?: string } {
  const r = run(["gh", "pr", "view", "--json", "state,url"], cwd);
  if (r.code !== 0) return {};
  try {
    const j = JSON.parse(r.out) as { state?: string; url?: string };
    const s = (j.state ?? "").toLowerCase();
    return { state: s === "open" || s === "merged" || s === "closed" ? s : undefined, url: j.url };
  } catch {
    return {};
  }
}

/** Async PR state via `gh` (network), non-blocking — for the on-attach badge refresh so it never
 *  stalls the single-threaded daemon. Same shape/semantics as prStatus(). */
export async function prStatusAsync(cwd: string): Promise<{ state?: "open" | "merged" | "closed"; url?: string }> {
  try {
    const proc = Bun.spawn(["gh", "pr", "view", "--json", "state,url"], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return {};
    const j = JSON.parse(out) as { state?: string; url?: string };
    const s = (j.state ?? "").toLowerCase();
    return { state: s === "open" || s === "merged" || s === "closed" ? s : undefined, url: j.url };
  } catch {
    return {};
  }
}

/** Best-effort delete of the remote branch (for abandon/cleanup). */
export function deleteRemoteBranch(cwd: string, branch: string): void {
  run(["git", "push", "origin", "--delete", branch], cwd);
}
