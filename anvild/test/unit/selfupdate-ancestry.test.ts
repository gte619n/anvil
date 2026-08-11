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

test("[SEC2-1] rollback path (allowNonFastForward) still resets backwards to a SHA in our own history", async () => {
  // A rollback target is deliberately behind the upstream tip (e.g. after a pin-backwards update it may
  // not even be an ancestor of it) — the STRICT forward gate must not block it. [CI2-7] replaced the
  // old skip-the-gate-entirely behavior with a relaxed one: reachable from the upstream track OR from
  // the current checkout's HEAD. Here the target fails the upstream check but is in local history.
  const { run, calls } = fakeRunner({
    "merge-base --is-ancestor 0old000 HEAD": { code: 0, out: "" },
    "merge-base --is-ancestor 0old000": { code: 1, out: "" }, // not an ancestor of the upstream ref
    "status --porcelain": { code: 0, out: "" },
  });
  const res = await applyUpdateToTarget("0old000", { run, allowNonFastForward: true });
  expect(res.targetSha).toBe("0old000");
  expect(ran(calls, "checkout --detach 0old000")).toBe(true);
});

test("an untracked-only dirty tree does NOT block the update (leftover artifacts / *.bak)", async () => {
  // The fingerprint of the field bug: a removed subtree left build junk behind and a stray *.bak sits
  // beside package.json — all UNTRACKED (`??`). `git checkout` never silently clobbers untracked files,
  // so the guard must let the update through instead of bricking auto-update on an otherwise-clean host.
  const { run, calls } = fakeRunner({
    "merge-base --is-ancestor": { code: 0, out: "" },
    "status --porcelain": { code: 0, out: "?? anvil-server/\n?? anvild/package.json.bak" },
  });
  const res = await applyUpdateToTarget("abc1234", { run });
  expect(res.targetSha).toBe("abc1234");
  expect(ran(calls, "checkout --detach abc1234")).toBe(true);
});

test("a TRACKED modification still blocks the update (protects the user's own work)", async () => {
  const { run, calls } = fakeRunner({
    "merge-base --is-ancestor": { code: 0, out: "" },
    // Mixed: a real tracked edit alongside untracked junk — the tracked line must still refuse.
    "status --porcelain": { code: 0, out: " M anvild/src/x.ts\n?? anvil-server/" },
  });
  await expect(applyUpdateToTarget("abc1234", { run })).rejects.toThrow(/dirty working tree/);
  expect(ran(calls, "checkout --detach")).toBe(false); // rejected before the tree is touched
});

test("the post-checkout install is --frozen-lockfile (never rewrites the tracked bun.lock)", async () => {
  // Without --frozen-lockfile a deploy's `bun install` normalizes bun.lock in place, leaving the tree
  // dirty after a *successful* update — which then trips this very guard on the next run.
  const { run, calls } = fakeRunner({
    "merge-base --is-ancestor": { code: 0, out: "" },
    "status --porcelain": { code: 0, out: "" },
    "rev-parse --short HEAD": { code: 0, out: "oldsha" },
    "git diff --name-only": { code: 0, out: "anvild/package.json" }, // force the install path
  });
  await applyUpdateToTarget("abc1234", { run });
  expect(ran(calls, "bun install --frozen-lockfile")).toBe(true);
  expect(ran(calls, "bun install")).toBe(true); // sanity: the install ran at all
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
