/**
 * [stable-update-service Phase 3] The out-of-process update watchdog state machine (D5/D9). Driven with
 * a fake clock + injected health/rollback/restart so the 180s gate and auto-rollback are asserted with
 * zero real time or processes. Pins: idle when not mid-update, adopt-known-good on a healthy landing,
 * wait-then-rollback on timeout (the poison-build path, F3), and safe failure when there's nothing to
 * roll back to.
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateStateStore } from "../../src/daemon/update-state";
import { UpdateWatchdog, type HealthProbe, type WatchdogDeps } from "../../src/daemon/updater/watchdog";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "anvil-watchdog-"));
}

function harness(overrides: Partial<WatchdogDeps> = {}) {
  const state = new UpdateStateStore(tmp());
  let clock = 0;
  const calls = { rollback: [] as string[], restart: 0 };
  let health: HealthProbe | null = null;
  const deps: WatchdogDeps = {
    state,
    health: async () => health,
    rollback: async (sha) => {
      calls.rollback.push(sha);
    },
    restartDaemon: () => {
      calls.restart++;
    },
    now: () => clock,
    gateMs: 180_000,
    ...overrides,
  };
  const wd = new UpdateWatchdog(deps);
  return {
    wd,
    state,
    calls,
    setHealth: (h: HealthProbe | null) => (health = h),
    advance: (ms: number) => (clock += ms),
  };
}

test("idle when no update is in flight", async () => {
  const h = harness();
  h.state.set({ phase: "idle" });
  expect(await h.wd.tick()).toBe("idle");
});

test("adopts the new build as known-good once it answers healthy on the target SHA", async () => {
  const h = harness();
  h.state.set({ phase: "restarting", targetSha: "newsha", prePullSha: "oldsha" });
  h.setHealth({ ok: true, version: "0.2.1+newsha", webBundleOk: true });
  expect(await h.wd.tick()).toBe("healthy");
  expect(h.state.get().phase).toBe("healthy");
  expect(h.state.get().prePullSha).toBe("newsha"); // known-good advanced to the landed build
  expect(h.calls.rollback.length).toBe(0);
});

test("waits while the daemon is still coming up, then rolls back when the gate elapses", async () => {
  const h = harness();
  h.state.set({ phase: "restarting", targetSha: "newsha", prePullSha: "oldsha" });
  h.setHealth(null); // unreachable — mid-restart or won't boot
  expect(await h.wd.tick()).toBe("waiting"); // arms the 180s gate
  h.setHealth({ ok: true, version: "0.2.1+oldsha", webBundleOk: true }); // still the OLD build (stuck)
  expect(await h.wd.tick()).toBe("waiting");
  h.advance(180_001); // gate elapses
  expect(await h.wd.tick()).toBe("rolled-back");
  expect(h.calls.rollback).toEqual(["oldsha"]);
  expect(h.calls.restart).toBe(1);
  const rec = h.state.get();
  expect(rec.phase).toBe("rolled-back");
  expect(rec.targetSha).toBe("oldsha"); // now converging back to the known-good
  expect(rec.reason).toMatch(/timed out/);
});

test("a broken bundle (webBundleOk:false) never counts as healthy and eventually rolls back", async () => {
  const h = harness();
  h.state.set({ phase: "restarting", targetSha: "newsha", prePullSha: "oldsha" });
  h.setHealth({ ok: true, version: "0.2.1+newsha", webBundleOk: false }); // up, right SHA, but can't serve
  expect(await h.wd.tick()).toBe("waiting");
  h.advance(180_001);
  expect(await h.wd.tick()).toBe("rolled-back");
  expect(h.calls.rollback).toEqual(["oldsha"]);
});

test("[BE2-29] arms during 'building' and rolls back if the daemon crashes mid-build", async () => {
  const h = harness();
  // A crash mid-`bun install`/build leaves the phase at "building" with the checkout already on target.
  h.state.set({ phase: "building", targetSha: "newsha", prePullSha: "oldsha" });
  h.setHealth(null); // the daemon crashed during the build → unreachable
  expect(await h.wd.tick()).toBe("waiting"); // ARMED even though phase isn't "restarting"
  h.advance(180_001);
  expect(await h.wd.tick()).toBe("rolled-back");
  expect(h.calls.rollback).toEqual(["oldsha"]);
  expect(h.calls.restart).toBe(1);
});

test("[BE2-29] does NOT roll back a live daemon still legitimately building past the gate", async () => {
  const h = harness();
  h.state.set({ phase: "building", targetSha: "newsha", prePullSha: "oldsha" });
  // Daemon is alive and serving the OLD bundle while a slow build runs — normal, not a failure.
  h.setHealth({ ok: true, version: "0.2.1+oldsha", webBundleOk: true });
  expect(await h.wd.tick()).toBe("waiting");
  h.advance(180_001); // gate elapses, but the daemon is still up building
  expect(await h.wd.tick()).toBe("waiting"); // must NOT roll back a healthy building daemon
  expect(h.calls.rollback.length).toBe(0);
});

test("[BE2-31] a target that becomes healthy DURING rollback is adopted, not restarted backwards", async () => {
  const state = new UpdateStateStore(tmp());
  let clock = 0;
  let health: HealthProbe | null = null; // unreachable through the gate
  const calls = { restart: 0, rollback: [] as string[] };
  const wd = new UpdateWatchdog({
    state,
    health: async () => health,
    rollback: async (sha) => {
      calls.rollback.push(sha);
      health = { ok: true, version: "0.2.1+newsha", webBundleOk: true }; // recovered during the rebuild
    },
    restartDaemon: () => calls.restart++,
    now: () => clock,
    gateMs: 180_000,
  });
  state.set({ phase: "restarting", targetSha: "newsha", prePullSha: "oldsha" });
  expect(await wd.tick()).toBe("waiting"); // arm (health null)
  clock += 180_001; // gate elapses
  const r = await wd.tick();
  expect(calls.rollback).toEqual(["oldsha"]); // rollback WAS attempted
  expect(r).toBe("healthy"); // …but the re-probe found the target healthy → adopt
  expect(calls.restart).toBe(0); // and the backwards restart was SKIPPED (no restart storm)
  expect(state.get().phase).toBe("healthy");
});

test("fails safe (no rollback attempt) when there is no pre-pull SHA to revert to", async () => {
  const h = harness();
  h.state.set({ phase: "restarting", targetSha: "newsha", prePullSha: "" });
  h.setHealth(null);
  await h.wd.tick();
  h.advance(180_001);
  expect(await h.wd.tick()).toBe("rollback-failed");
  expect(h.calls.rollback.length).toBe(0);
  expect(h.state.get().phase).toBe("error");
});

test("reports rollback-failed (not a silent success) when the git rollback itself throws", async () => {
  const h = harness({
    rollback: async () => {
      throw new Error("git reset exploded");
    },
  });
  h.state.set({ phase: "restarting", targetSha: "newsha", prePullSha: "oldsha" });
  h.setHealth(null);
  await h.wd.tick();
  h.advance(180_001);
  expect(await h.wd.tick()).toBe("rollback-failed");
  expect(h.state.get().phase).toBe("error");
  expect(h.state.get().reason).toMatch(/rollback FAILED/);
});
