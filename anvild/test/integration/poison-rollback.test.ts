/**
 * [stable-update-service Phase 7 / F3] Poison-build auto-rollback against a REAL git repository. The
 * REAL UpdateWatchdog drives the REAL selfupdate.rollbackTo primitive (only `bun install`/`build:web`
 * are stubbed) over an injected CommandRunner pointed at a throwaway repo. This proves the end-to-end
 * rollback DECISION + ACTION: a build that never becomes healthy is reverted, by real `git reset --hard`,
 * to the exact pre-pull commit, and the daemon is restarted — no hand-waving, the git HEAD moves for real.
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateStateStore } from "../../src/daemon/update-state";
import { rollbackTo, type CommandRunner } from "../../src/daemon/selfupdate";
import { UpdateWatchdog } from "../../src/daemon/updater/watchdog";

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return p.stdout.toString().trim();
}

/** A real git repo with two commits (good → bad), HEAD parked on bad. Returns short SHAs. */
function twoCommitRepo(): { repo: string; good: string; bad: string } {
  const repo = mkdtempSync(join(tmpdir(), "anvil-poison-repo-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  Bun.write(join(repo, "f.txt"), "good\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "good");
  const good = git(repo, "rev-parse", "--short", "HEAD");
  Bun.write(join(repo, "f.txt"), "bad\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "bad");
  const bad = git(repo, "rev-parse", "--short", "HEAD");
  return { repo, good, bad };
}

test("[F3] the watchdog reverts a never-healthy build to the pre-pull commit via real git reset", async () => {
  const { repo, good, bad } = twoCommitRepo();
  expect(git(repo, "rev-parse", "--short", "HEAD")).toBe(bad); // parked on the poisoned build

  // A CommandRunner that runs REAL git in the throwaway repo and stubs the bun build steps.
  const run: CommandRunner = async (cmd) => {
    if (cmd[0] === "git") {
      const p = Bun.spawnSync(["git", ...cmd.slice(1)], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
    }
    return { code: 0, out: "(stubbed bun step)" };
  };

  // The daemon just "updated" to `bad` and persisted the pre-pull SHA — but the new build won't come up.
  const state = new UpdateStateStore(mkdtempSync(join(tmpdir(), "anvil-poison-state-")));
  state.set({ phase: "restarting", targetSha: bad, prePullSha: good });

  let clock = 0;
  let restarts = 0;
  const wd = new UpdateWatchdog({
    state,
    health: async () => ({ ok: true, version: `0.0.0+${bad}`, webBundleOk: false }), // up, but bundle broken → never healthy
    rollback: (sha) => rollbackTo(sha, run).then(() => {}),
    restartDaemon: () => {
      restarts++;
    },
    now: () => clock,
    gateMs: 180_000,
  });

  expect(await wd.tick()).toBe("waiting"); // arms the gate
  clock += 180_001; // gate elapses without ever going healthy
  expect(await wd.tick()).toBe("rolled-back");

  // The real repo HEAD is back on the good commit, and the daemon was restarted.
  expect(git(repo, "rev-parse", "--short", "HEAD")).toBe(good);
  expect(git(repo, "show", "-s", "--format=%s", "HEAD")).toBe("good");
  expect(restarts).toBe(1);
  const rec = state.get();
  expect(rec.phase).toBe("rolled-back");
  expect(rec.targetSha).toBe(good);
});
