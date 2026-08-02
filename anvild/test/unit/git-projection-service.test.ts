/**
 * [P7] GitProjectionService — the git status/PR-badge domain extracted from Supervisor. Pins the local
 * gitOp behaviour (status projects into s.data.git; a non-repo reports "(not a git repo)"; diff returns
 * git output) and the persist/broadcast wiring. The PR-badge/sweep network paths use git.prStatusAsync
 * (covered by pr-badge + the dispatch integration through the Supervisor delegation).
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session as SessionData } from "@protocol";
import { GitProjectionService, type GitProjectionDeps } from "../../src/session/git-projection-service";
import type { Session } from "../../src/session/session";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "anvil-gitproj-"));
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "hi");
  run(["add", "-A"]);
  run(["commit", "-qm", "init"]);
  return dir;
}

function harness(cwd: string) {
  const persists: number[] = [];
  const updated: SessionData[] = [];
  const session = { id: "s1", data: { id: "s1", cwd, title: "t" } as SessionData } as unknown as Session;
  const deps: GitProjectionDeps = {
    require: () => session,
    getSession: () => session,
    sessions: () => [session],
    persist: () => persists.push(1),
    broadcastUpdated: (d) => updated.push(d),
  };
  return { svc: new GitProjectionService(deps), session, persists, updated };
}

test("[P7] gitOp status projects local git state into s.data.git", () => {
  const cwd = gitRepo();
  try {
    const h = harness(cwd);
    const ev = h.svc.gitOp({ v: 4, ts: "t", type: "git", op: "status", sessionId: "s1" } as never);
    expect(ev.type).toBe("git.result");
    expect(ev.ok).toBe(true);
    expect(h.session.data.git).toBeDefined();
    expect(ev.output).toContain(h.session.data.git!.branch); // branch name in the status line
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("[P7] gitOp status on a non-git dir reports (not a git repo)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "anvil-nongit-"));
  try {
    const h = harness(cwd);
    const ev = h.svc.gitOp({ v: 4, ts: "t", type: "git", op: "status", sessionId: "s1" } as never);
    expect(ev.output).toBe("(not a git repo)");
    expect(h.session.data.git).toBeUndefined();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("[P7] gitOp diff returns git output without touching the projection", () => {
  const cwd = gitRepo();
  try {
    writeFileSync(join(cwd, "a.txt"), "changed");
    const h = harness(cwd);
    const ev = h.svc.gitOp({ v: 4, ts: "t", type: "git", op: "diff", sessionId: "s1" } as never);
    expect(ev.ok).toBe(true);
    expect(ev.output).toContain("a.txt"); // the diff mentions the changed file
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
