/**
 * [SEC2-1] applyUpdateToTarget must refuse to check out a target that isn't reachable from the trusted
 * upstream tip (origin/HEAD / the resolved update ref). Before this guard, `git checkout --detach
 * <targetSha>` ran with NO ancestry or signature check — a fleet-update route (or a browser page reaching
 * one, pre-SEC2-2) could pin the whole fleet to an arbitrary side-branch commit and force a restart onto
 * it. The rollback path (allowNonFastForward) must still be able to reset backwards to a prePullSha.
 */
import { test, expect } from "bun:test";
import { applyUpdateToTarget, type CommandRunner } from "../../src/daemon/selfupdate";

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

test("[SEC2-1] a side-branch SHA (not an ancestor of the upstream tip) is rejected before any checkout", async () => {
  // merge-base --is-ancestor exits 1 when target is NOT reachable from the upstream tip.
  const { run, calls } = fakeRunner({ "merge-base --is-ancestor": { code: 1, out: "" } });
  await expect(applyUpdateToTarget("deadbeef", { run })).rejects.toThrow(/ancestor|not reachable|upstream/i);
  // The rejection must land BEFORE the tree is mutated.
  expect(ran(calls, "checkout --detach")).toBe(false);
  expect(ran(calls, "bun install")).toBe(false);
});

test("[SEC2-1] an on-branch SHA (ancestor of the upstream tip) is accepted and checked out", async () => {
  const { run, calls } = fakeRunner({ "merge-base --is-ancestor": { code: 0, out: "" }, "status --porcelain": { code: 0, out: "" } });
  const res = await applyUpdateToTarget("abc1234", { run });
  expect(ran(calls, "checkout --detach abc1234")).toBe(true);
  expect(res.targetSha).toBe("abc1234");
});

test("[SEC2-1] rollback path (allowNonFastForward) resets backwards without the ancestry gate", async () => {
  // A rollback target is deliberately behind the upstream tip; the ancestry gate must be bypassed so the
  // watchdog/rollback can still move the checkout backwards to a known-good prePullSha.
  const { run, calls } = fakeRunner({ "merge-base --is-ancestor": { code: 1, out: "" }, "status --porcelain": { code: 0, out: "" } });
  const res = await applyUpdateToTarget("0old000", { run, allowNonFastForward: true });
  expect(res.targetSha).toBe("0old000");
  expect(ran(calls, "checkout --detach 0old000")).toBe(true);
  expect(ran(calls, "merge-base --is-ancestor")).toBe(false); // gate skipped on the rollback path
});

test("[SEC2-1] records the pre-pull SHA before rejecting a bad target (caller may need it)", async () => {
  const seen: string[] = [];
  const { run } = fakeRunner({
    "rev-parse --short HEAD": { code: 0, out: "good123" },
    "merge-base --is-ancestor": { code: 1, out: "" },
  });
  await expect(
    applyUpdateToTarget("deadbeef", { run, recordPrePull: (s) => seen.push(s) }),
  ).rejects.toThrow();
  expect(seen).toEqual(["good123"]);
});
