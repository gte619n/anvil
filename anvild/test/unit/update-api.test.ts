/**
 * [stable-update-service Phase 1/2] The frozen update API v1 logic layer + the pinned-target/rollback
 * primitives in selfupdate. The CommandRunner is injectable so the whole flow runs without real git/bun.
 * Pins: check reports behind + updateApiVersion; apply pins an EXACT target, records the pre-pull SHA
 * BEFORE mutating (rollback groundwork, spec D8/D13), refuses a dirty tree (spec OQ3), and drives the
 * status phase machine; settleAfterBoot adopts a landed build as known-good.
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateStateStore } from "../../src/daemon/update-state";
import { updateApply, updateCheck, updateStatus, settleAfterBoot, type UpdateApiDeps } from "../../src/daemon/update-api";
import { applyUpdateToTarget, rollbackTo, runningSha, type CommandRunner } from "../../src/daemon/selfupdate";
import { UPDATE_API_VERSION } from "@protocol";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "anvil-update-api-"));
}
/** A web dir that passes the smoke check (has index.html). */
function webDirOk(): string {
  const d = tmp();
  Bun.write(join(d, "index.html"), "<html></html>");
  return d;
}

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

/** The command set that makes resolveTargetSha → "newsha", HEAD → "oldsha", clean tree, green build. */
const HAPPY = {
  "symbolic-full-name @{u}": { code: 0, out: "origin/main" },
  "rev-parse --short origin/main": { code: 0, out: "newsha" },
  "rev-parse --short HEAD": { code: 0, out: "oldsha" },
  "status --porcelain": { code: 0, out: "" },
};

function deps(dir: string, run: CommandRunner, extra: Partial<UpdateApiDeps> = {}): UpdateApiDeps {
  return { state: new UpdateStateStore(dir), webDir: webDirOk(), run, ...extra };
}

test("check reports commits-behind and the frozen updateApiVersion", async () => {
  const { run } = fakeRunner({ ...HAPPY, "rev-list --count": { code: 0, out: "2" } });
  const c = await updateCheck(deps(tmp(), run));
  expect(c.ok).toBe(true);
  expect(c.behind).toBe(2);
  expect(c.targetSha).toBe("newsha");
  expect(c.updateApiVersion).toBe(UPDATE_API_VERSION);
});

test("apply to a resolved target pins the exact SHA, records the pre-pull SHA, and asks to restart", async () => {
  const dir = tmp();
  const { run, calls } = fakeRunner(HAPPY);
  const d = deps(dir, run, { isManaged: () => true, scheduleRestart: () => {} });
  const r = await updateApply({}, d);
  expect(r.ok).toBe(true);
  expect(r.phase).toBe("restarting");
  expect(r.willRestart).toBe(true);
  expect(r.targetSha).toBe("newsha");
  expect(r.prePullSha).toBe("oldsha"); // captured BEFORE the checkout
  expect(ran(calls, "checkout --detach newsha")).toBe(true);
  expect(ran(calls, "run typecheck")).toBe(true);
  // Persisted so /status (and the watchdog) can see the known-good rollback target across the restart.
  const persisted = new UpdateStateStore(dir).get();
  expect(persisted.phase).toBe("restarting");
  expect(persisted.prePullSha).toBe("oldsha");
  expect(persisted.targetSha).toBe("newsha");
});

test("apply honours an explicitly pinned target SHA (deterministic fleet convergence)", async () => {
  const { run, calls } = fakeRunner({ ...HAPPY, "rev-parse --short HEAD": { code: 0, out: "oldsha" } });
  const r = await updateApply({ targetSha: "pinned9" }, deps(tmp(), run, { isManaged: () => true, scheduleRestart: () => {} }));
  expect(r.targetSha).toBe("pinned9");
  expect(ran(calls, "checkout --detach pinned9")).toBe(true);
});

test("apply refuses a dirty working tree and surfaces an error phase (dev-box safety, OQ3)", async () => {
  const { run } = fakeRunner({ ...HAPPY, "status --porcelain": { code: 0, out: " M src/x.ts" } });
  const dir = tmp();
  const r = await updateApply({}, deps(dir, run));
  expect(r.ok).toBe(false);
  expect(r.phase).toBe("error");
  expect(r.error).toMatch(/dirty working tree/);
  expect(new UpdateStateStore(dir).get().phase).toBe("error");
});

test("apply that fails typecheck refuses to restart (never onto a broken tree)", async () => {
  const { run, calls } = fakeRunner({ ...HAPPY, "run typecheck": { code: 1, out: "TS2345" } });
  const r = await updateApply({}, deps(tmp(), run, { isManaged: () => true, scheduleRestart: () => { throw new Error("must not restart"); } }));
  expect(r.ok).toBe(false);
  expect(r.phase).toBe("error");
  expect(ran(calls, "run build:web")).toBe(true); // build ran; typecheck gate came after
});

test("[BE2-28] a second concurrent apply is rejected 'already in progress' (no interleaved applies)", async () => {
  const dir = tmp();
  // Gate the first apply at the checkout so it's provably still in flight when the second call arrives.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run: CommandRunner = async (cmd) => {
    const key = cmd.join(" ");
    if (key.includes("checkout --detach")) await gate; // hold the first apply here
    for (const [pat, res] of Object.entries(HAPPY)) if (key.includes(pat)) return res;
    return { code: 0, out: "ok" };
  };
  const d = deps(dir, run, { isManaged: () => true, scheduleRestart: () => {} });
  const p1 = updateApply({}, d); // suspends at the gated checkout, holding the in-flight lock
  const r2 = await updateApply({}, d); // must hit the concurrency guard
  expect(r2.ok).toBe(false);
  expect(r2.error).toMatch(/already in progress/);
  release();
  const r1 = await p1;
  expect(r1.ok).toBe(true); // the first apply still completes normally
  // And once it's done, a fresh apply is accepted again (the lock cleared).
  const r3 = await updateApply({}, deps(tmp(), fakeRunner(HAPPY).run, { isManaged: () => true, scheduleRestart: () => {} }));
  expect(r3.ok).toBe(true);
});

test("status derives 'healthy' once the running process matches the target and the bundle is servable", async () => {
  const rs = runningSha();
  const dir = tmp();
  const state = new UpdateStateStore(dir);
  const d: UpdateApiDeps = { state, webDir: webDirOk() };
  if (rs) {
    state.set({ phase: "restarting", targetSha: rs, prePullSha: "prev" });
    expect(updateStatus(d).phase).toBe("healthy");
    settleAfterBoot(d);
    expect(state.get().phase).toBe("healthy");
    expect(state.get().prePullSha).toBe(rs); // adopts the landed build as the new known-good
  } else {
    // Git-less runtime (VERSION has no +sha): settle can't match, so it must stay put (no false healthy).
    state.set({ phase: "restarting", targetSha: "x", prePullSha: "prev" });
    settleAfterBoot(d);
    expect(state.get().phase).toBe("restarting");
  }
});

test("rollbackTo resets --hard to the known-good SHA and rebuilds", async () => {
  const { run, calls } = fakeRunner();
  await rollbackTo("goodsha", run);
  expect(ran(calls, "reset --hard goodsha")).toBe(true);
  expect(ran(calls, "run build:web")).toBe(true);
});

test("applyUpdateToTarget invokes recordPrePull with HEAD before touching the tree", async () => {
  const { run } = fakeRunner({ ...HAPPY });
  let recorded = "";
  await applyUpdateToTarget("newsha", { run, recordPrePull: (sha) => (recorded = sha) });
  expect(recorded).toBe("oldsha");
});

test("a build failure AFTER the checkout restores the pre-pull SHA on disk (never strands a broken build)", async () => {
  // Checkout succeeds (HEAD moves to the target) but the web build fails — disk must be reset back to the
  // pre-pull SHA so a later restart can't boot the broken build with nothing armed to roll it back.
  const { run, calls } = fakeRunner({ ...HAPPY, "run build:web": { code: 1, out: "Could not resolve" } });
  await expect(applyUpdateToTarget("newsha", { run })).rejects.toThrow(/web build failed/);
  expect(ran(calls, "checkout --detach newsha")).toBe(true);
  expect(ran(calls, "reset --hard oldsha")).toBe(true); // rolled the checkout back to the known-good SHA
});
