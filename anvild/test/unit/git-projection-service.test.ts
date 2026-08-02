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

// ── [BE2-5] async per-turn refresh + per-session coalescing ────────────────────────────────────────

test("[BE2-5] refreshGitAsync projects local git state without blocking (async twin of refreshGit)", async () => {
  const cwd = gitRepo();
  try {
    const h = harness(cwd);
    await h.svc.refreshGitAsync(h.session);
    expect(h.session.data.git?.branch).toBeDefined();
    expect(h.session.data.git?.dirtyFileCount).toBe(0);
    // A change is picked up and persisted + broadcast on the next refresh.
    writeFileSync(join(cwd, "a.txt"), "changed");
    await h.svc.refreshGitAsync(h.session);
    expect(h.session.data.git?.dirtyFileCount).toBe(1);
    expect(h.updated.length).toBeGreaterThan(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("[BE2-5] scheduleRefreshGit coalesces a burst of turns into leading + one trailing refresh", async () => {
  const cwd = gitRepo();
  try {
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
    const svc = new GitProjectionService(deps, 120); // short window so the test stays fast
    let calls = 0;
    const realRefresh = svc.refreshGitAsync.bind(svc);
    svc.refreshGitAsync = async (s: Session) => {
      calls++;
      await Bun.sleep(50); // slow git stand-in: keeps the refresh IN FLIGHT while more turns land
      await realRefresh(s);
    };

    // A burst of turn completions before the (immediate) leading refresh starts: they all fold into
    // that single pending refresh — it reads git AFTER the burst, so once is enough.
    for (let i = 0; i < 6; i++) svc.scheduleRefreshGit("s1");
    await Bun.sleep(20); // leading refresh started (calls=1) and is now mid-flight
    expect(calls).toBe(1);
    // Turns landing MID-FLIGHT could be missed by the in-progress read — they must book exactly one
    // trailing refresh at the window edge (not one each, and not zero).
    svc.scheduleRefreshGit("s1");
    svc.scheduleRefreshGit("s1");
    await Bun.sleep(40); // still inside the window: nothing new ran yet
    expect(calls).toBe(1);
    await Bun.sleep(300); // window elapsed → the single trailing refresh ran
    expect(calls).toBe(2);
    await Bun.sleep(200);
    expect(calls).toBe(2); // quiet → no further refreshes
    expect(session.data.git?.branch).toBeDefined(); // the refresh really projected git state
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("[BE2-5] scheduleRefreshGit drops its throttle state when the session is gone", async () => {
  const cwd = gitRepo();
  try {
    let present = true;
    const session = { id: "s1", data: { id: "s1", cwd, title: "t" } as SessionData } as unknown as Session;
    const deps: GitProjectionDeps = {
      require: () => session,
      getSession: () => (present ? session : undefined),
      sessions: () => (present ? [session] : []),
      persist: () => {},
      broadcastUpdated: () => {},
    };
    const svc = new GitProjectionService(deps, 50);
    present = false; // killed before the refresh fires
    svc.scheduleRefreshGit("s1");
    await Bun.sleep(30);
    expect((svc as unknown as { gitRefreshers: Map<string, unknown> }).gitRefreshers.has("s1")).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
