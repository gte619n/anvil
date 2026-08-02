/**
 * [CI2-7] Self-update provenance for the ROLLBACK paths. SEC2-1 gated the forward pin
 * (applyUpdateToTarget must target an ancestor of the trusted upstream tip) but left both rollback
 * mechanisms unchecked: `allowNonFastForward` skipped the gate entirely, and `rollbackTo` did
 * `git reset --hard <sha>` with no check — the last two ways to move the daemon's tree to an
 * arbitrary out-of-tree commit. Now a rollback target must be in TRUSTED HISTORY: an ancestor of the
 * upstream tip OR reachable from the current checkout's HEAD (a legit prePullSha always is; a
 * tampered/attacker SHA is not).
 *
 * No `git verify-tag`/`verify-commit` here on purpose: CI mints its `v*` release tags UNSIGNED via
 * `gh release create` and commits land unsigned, so signature verification would test a property the
 * pipeline doesn't produce (and brick every update). Ancestry is the strongest real check today.
 */
import { test, expect } from "bun:test";
import { applyUpdateToTarget, rollbackTo, type CommandRunner } from "../../src/daemon/selfupdate";

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

test("[CI2-7] rollback (allowNonFastForward) to an out-of-tree SHA is refused before any tree mutation", async () => {
  // Neither an ancestor of the upstream ref nor reachable from HEAD → not ours, refuse.
  const { run, calls } = fakeRunner({ "merge-base --is-ancestor": { code: 1, out: "" } });
  await expect(applyUpdateToTarget("bad0bad", { run, allowNonFastForward: true })).rejects.toThrow(
    /neither an ancestor|refusing to roll back/i,
  );
  expect(ran(calls, "checkout --detach")).toBe(false);
  expect(ran(calls, "reset --hard")).toBe(false);
});

test("[CI2-7] rollbackTo resets to a SHA in local history (behind upstream is fine)", async () => {
  const { run, calls } = fakeRunner({
    "merge-base --is-ancestor good123 HEAD": { code: 0, out: "" },
    "merge-base --is-ancestor good123": { code: 1, out: "" }, // not an ancestor of the upstream ref
  });
  await rollbackTo("good123", run);
  expect(ran(calls, "reset --hard good123")).toBe(true);
});

test("[CI2-7] rollbackTo refuses an out-of-tree SHA before `git reset --hard` runs", async () => {
  const { run, calls } = fakeRunner({ "merge-base --is-ancestor": { code: 1, out: "" } });
  await expect(rollbackTo("bad0bad", run)).rejects.toThrow(/neither an ancestor|refusing to roll back/i);
  expect(ran(calls, "reset --hard")).toBe(false);
});

test("[CI2-7] rollback still works when the upstream ref can't be resolved (watchdog offline-ish case)", async () => {
  // resolveUpdateRef throws (no @{u}, no origin/HEAD) — the gate must fall back to the local-history
  // rule rather than wedging the watchdog's recovery path.
  const { run, calls } = fakeRunner({
    "rev-parse --abbrev-ref": { code: 1, out: "" },
    "symbolic-ref": { code: 1, out: "" },
    // default: merge-base --is-ancestor <sha> HEAD → code 0 (in local history)
  });
  await rollbackTo("good123", run);
  expect(ran(calls, "reset --hard good123")).toBe(true);
});

test("[CI2-7] the FORWARD gate is not relaxed: reachable-from-HEAD-only is still rejected", async () => {
  // A commit in local history but off the upstream track (e.g. a local side branch) must still fail a
  // forward pin — only the rollback paths accept the local-history rule.
  const { run, calls } = fakeRunner({
    "merge-base --is-ancestor deadbee HEAD": { code: 0, out: "" },
    "merge-base --is-ancestor deadbee": { code: 1, out: "" },
  });
  await expect(applyUpdateToTarget("deadbee", { run })).rejects.toThrow(/ancestor of the trusted upstream/i);
  expect(ran(calls, "checkout --detach")).toBe(false);
});
