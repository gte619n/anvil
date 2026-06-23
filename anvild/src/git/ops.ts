/**
 * Git / gh operations on a session worktree (arch §8). All shell out and return combined
 * stdout+stderr so the UI can show exactly what happened. PR ops use the `gh` CLI.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

function run(cmd: string[], cwd: string): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
  return { code: r.exitCode, out };
}

/** Where freshly-cloned environment repos land. */
export function clonesParent(): string {
  return join(homedir(), "Development");
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

/**
 * Clone `url` into `~/Development/<repo-name>` using the host's git auth (SSH keys,
 * credential helpers). Synchronous. Throws on a bad URL, an existing destination, or a
 * git failure (message carries git's combined output so the UI can show it).
 */
export function cloneRepo(url: string): { dest: string; output: string } {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("a git URL is required");
  const name = repoNameFromUrl(trimmed);
  if (!name) throw new Error(`could not derive a repo name from URL: ${url}`);
  const parent = clonesParent();
  const dest = join(parent, name);
  if (existsSync(dest)) {
    throw new Error(`destination already exists: ${dest}`);
  }
  mkdirSync(parent, { recursive: true });
  const r = run(["git", "clone", trimmed, dest], parent);
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

export function push(cwd: string, branch: string): { ok: boolean; output: string } {
  const r = run(["git", "push", "-u", "origin", branch], cwd);
  return { ok: r.code === 0, output: r.out || "pushed" };
}

export function createPr(cwd: string, title: string, body: string): { ok: boolean; output: string; url?: string } {
  const r = run(["gh", "pr", "create", "--title", title, "--body", body], cwd);
  const url = r.out.match(/https?:\/\/\S+/)?.[0];
  return { ok: r.code === 0, output: r.out, url };
}

export function mergePr(cwd: string, method: "merge" | "squash" | "rebase"): { ok: boolean; output: string } {
  const flag = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
  const r = run(["gh", "pr", "merge", flag, "--delete-branch"], cwd);
  return { ok: r.code === 0, output: r.out || "merged" };
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
