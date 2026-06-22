/**
 * Git / gh operations on a session worktree (arch §8). All shell out and return combined
 * stdout+stderr so the UI can show exactly what happened. PR ops use the `gh` CLI.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  return { dest, output: r.out };
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

/** Best-effort delete of the remote branch (for abandon/cleanup). */
export function deleteRemoteBranch(cwd: string, branch: string): void {
  run(["git", "push", "origin", "--delete", branch], cwd);
}
