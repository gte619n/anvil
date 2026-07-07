/**
 * [Phase 6 / CI-S5] Daemon self-update flow. The command runner is injectable so the
 * pull→install→build→typecheck sequence is testable without spawning real git/bun. Pins: the new
 * pre-restart typecheck gate (never restart onto a tree that doesn't typecheck — the daemon runs
 * from TS source), abort-on-pull-failure before any build, conditional dependency install, and the
 * behind-count check. This critical path had zero tests.
 */
import { test, expect } from "bun:test";
import { applyUpdate, checkForUpdate, type CommandRunner } from "../../src/daemon/selfupdate";

function fakeRunner(overrides: Record<string, { code: number; out: string }> = {}) {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd) => {
    calls.push(cmd);
    const key = cmd.join(" ");
    for (const [pat, res] of Object.entries(overrides)) if (key.includes(pat)) return res;
    return { code: 0, out: "ok" };
  };
  return { run, calls };
}
const ran = (calls: string[][], pat: string) => calls.some((c) => c.join(" ").includes(pat));

test("happy path runs build then the typecheck gate and succeeds", async () => {
  const { run, calls } = fakeRunner();
  const res = await applyUpdate(run);
  expect(ran(calls, "run build:web")).toBe(true);
  expect(ran(calls, "run typecheck")).toBe(true);
  expect(res.output).toContain("typecheck");
});

test("a failed pull aborts before any build or typecheck", async () => {
  const { run, calls } = fakeRunner({ "git pull": { code: 1, out: "not fast-forward" } });
  await expect(applyUpdate(run)).rejects.toThrow(/git pull failed/);
  expect(ran(calls, "build:web")).toBe(false);
  expect(ran(calls, "typecheck")).toBe(false);
});

test("[S5] a tree that fails typecheck refuses to update (won't restart onto it)", async () => {
  const { run, calls } = fakeRunner({ "run typecheck": { code: 1, out: "src/x.ts(1,1): error TS2345" } });
  await expect(applyUpdate(run)).rejects.toThrow(/refusing to restart onto a broken tree/);
  expect(ran(calls, "build:web")).toBe(true); // build ran; the typecheck gate came after and blocked
});

test("dependencies install only when the pull touched package.json / lockfile", async () => {
  const changed = fakeRunner({ "git diff": { code: 0, out: "anvild/package.json" } });
  await applyUpdate(changed.run);
  expect(ran(changed.calls, "bun install")).toBe(true);

  const unchanged = fakeRunner({ "git diff": { code: 0, out: "anvild/src/foo.ts" } });
  await applyUpdate(unchanged.run);
  expect(ran(unchanged.calls, "bun install")).toBe(false);
});

test("checkForUpdate reports how many commits behind upstream", async () => {
  const { run } = fakeRunner({ "abbrev-ref": { code: 0, out: "origin/main" }, "rev-list --count": { code: 0, out: "3" } });
  const r = await checkForUpdate(run);
  expect(r.behind).toBe(3);
  expect(r.output).toContain("origin/main");
  expect(r.needsRestart).toBe(false); // a real update (pull) is needed, not just a restart
});

test("checkForUpdate flags a stale running process when disk HEAD is ahead of the live process", async () => {
  // Up to date with the remote (behind 0), but on-disk HEAD differs from the running process's SHA —
  // a prior pull whose restart never landed. Must surface as needsRestart, not a no-op "up to date".
  const { run } = fakeRunner({
    "abbrev-ref": { code: 0, out: "origin/main" },
    "rev-list --count": { code: 0, out: "0" },
    "log -1": { code: 0, out: "beefca7" }, // disk HEAD ≠ the running short SHA
  });
  const r = await checkForUpdate(run);
  expect(r.behind).toBe(0);
  expect(r.needsRestart).toBe(true);
  expect(r.output).toMatch(/restart to apply/i);
});

test("checkForUpdate is plainly up-to-date when the running process matches disk HEAD", async () => {
  const { VERSION } = await import("../../src/version");
  const runningSha = VERSION.includes("+") ? VERSION.split("+")[1]! : "";
  const { run } = fakeRunner({
    "abbrev-ref": { code: 0, out: "origin/main" },
    "rev-list --count": { code: 0, out: "0" },
    "log -1": { code: 0, out: runningSha || "0000000" }, // disk HEAD == running process SHA
  });
  const r = await checkForUpdate(run);
  expect(r.needsRestart).toBe(false);
  expect(r.output).toContain("Up to date");
});
