/**
 * Integration test for team integration (anvil-team-support.md §4) against REAL git in a temp repo:
 * a 2-member team where each member committed a distinct file on its own branch. combined-pr merges
 * both into the lead branch (→ one PR); pr-per-member merges nothing. Push/PR are faked (no network
 * / gh), but the merge — the risky part — runs through the real git ops.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../../src/git/ops";
import { integrateTeam, type IntegrateGit } from "../../src/integrations/team-integrate";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function sh(cwd: string, args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

/** A repo checked out on `lead`, with member branches m1 (adds a.txt) and m2 (adds b.txt) off lead. */
function makeTeamRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "anvil-integ-"));
  dirs.push(repo);
  sh(repo, ["init", "-q", "-b", "main"]);
  sh(repo, ["config", "user.email", "t@example.com"]);
  sh(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", "init"]);
  sh(repo, ["branch", "lead"]);
  sh(repo, ["checkout", "-q", "-b", "m1", "lead"]);
  writeFileSync(join(repo, "a.txt"), "A\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", "member1: a"]);
  sh(repo, ["checkout", "-q", "-b", "m2", "lead"]);
  writeFileSync(join(repo, "b.txt"), "B\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", "member2: b"]);
  sh(repo, ["checkout", "-q", "lead"]);
  return repo;
}

/** Real git merge/ancestor; faked push + createPr (record calls). */
function gitSurface(): { git: IntegrateGit; pushes: number; prs: number } {
  const state = { pushes: 0, prs: 0 };
  const g: IntegrateGit = {
    isAncestor: (cwd, ref) => git.isAncestor(cwd, ref),
    mergeBranch: (cwd, branch, message) => git.mergeBranch(cwd, branch, message),
    push: () => { state.pushes++; return { ok: true, output: "pushed" }; },
    createPr: () => { state.prs++; return { ok: true, output: "created", url: "https://gh/pr/7" }; },
  };
  return { git: g, get pushes() { return state.pushes; }, get prs() { return state.prs; } } as any;
}

test("combined-pr merges both member branches into the lead branch and opens one PR", () => {
  const repo = makeTeamRepo();
  const s = gitSurface();
  const r = integrateTeam({
    integration: "combined-pr",
    leadCwd: repo,
    leadBranch: "lead",
    members: [
      { sessionId: "s1", title: "M1", branch: "m1" },
      { sessionId: "s2", title: "M2", branch: "m2" },
    ],
    prTitle: "team", prBody: "body", git: s.git,
  });
  expect(r.ok).toBe(true);
  // The lead worktree now contains BOTH members' files.
  expect(existsSync(join(repo, "a.txt"))).toBe(true);
  expect(existsSync(join(repo, "b.txt"))).toBe(true);
  // Both member branches are now ancestors of lead HEAD (really merged).
  expect(git.isAncestor(repo, "m1")).toBe(true);
  expect(git.isAncestor(repo, "m2")).toBe(true);
  expect(s.prs).toBe(1); // exactly one combined PR
  expect(r.prUrl).toBe("https://gh/pr/7");
});

test("pr-per-member merges nothing into the lead branch and opens no combined PR", () => {
  const repo = makeTeamRepo();
  const s = gitSurface();
  const r = integrateTeam({
    integration: "pr-per-member",
    leadCwd: repo,
    leadBranch: "lead",
    members: [
      { sessionId: "s1", title: "M1", branch: "m1" },
      { sessionId: "s2", title: "M2", branch: "m2" },
    ],
    prTitle: "team", prBody: "body", git: s.git,
  });
  expect(r.mode).toBe("pr-per-member");
  expect(existsSync(join(repo, "a.txt"))).toBe(false); // lead branch untouched
  expect(existsSync(join(repo, "b.txt"))).toBe(false);
  expect(git.isAncestor(repo, "m1")).toBe(false);
  expect(s.prs).toBe(0);
});
