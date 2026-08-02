/**
 * [BE2-30] UpdateStateStore is written by TWO PROCESSES — the daemon (role "primary") and the
 * out-of-process watchdog (role "watchdog") — and `set()` is a read-modify-write: with one shared file,
 * a writer serialized the FULL record from a stale read and silently erased the other's fields (atomic
 * write ≠ atomic RMW). The watchdog now writes a numbered-patch SIDECAR (its own file; one writer per
 * file) and readers merge. These tests simulate the two processes with two store instances over the
 * same stateDir — the exact cross-process topology (separate memory, shared files) — and pin:
 * interleaved RMWs lose neither writer's fields, a raced primary write (stale read) cannot bury an
 * unabsorbed watchdog patch, watchdog patches accumulate until absorbed, and the read path stays
 * throw-free on a corrupt sidecar.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateStateStore } from "../../src/daemon/update-state";

function stores(): { dir: string; daemon: UpdateStateStore; watchdog: UpdateStateStore } {
  const dir = mkdtempSync(join(tmpdir(), "anvil-update-rmw-"));
  return {
    dir,
    daemon: new UpdateStateStore(dir), // the daemon process (primary)
    watchdog: new UpdateStateStore(dir, { role: "watchdog" }), // the watchdog process
  };
}

test("[BE2-30] a watchdog write is visible to the daemon (and vice versa) through the merge", () => {
  const { daemon, watchdog } = stores();
  daemon.set({ phase: "restarting", targetSha: "tgt1234", prePullSha: "good111" });
  watchdog.set({ phase: "rolled-back", targetSha: "good111", reason: "health gate timed out" });
  // Both processes read the SAME merged view.
  for (const s of [daemon, watchdog]) {
    const r = s.get();
    expect(r.phase).toBe("rolled-back");
    expect(r.targetSha).toBe("good111");
    expect(r.reason).toBe("health gate timed out");
    expect(r.prePullSha).toBe("good111"); // a main-record field the patch didn't touch carries through the overlay
  }
});

test("[BE2-30] interleaved RMWs: neither writer's fields are lost", () => {
  const { daemon, watchdog } = stores();
  // daemon: an apply is in flight…
  daemon.set({ phase: "restarting", targetSha: "tgt1234", prePullSha: "good111" });
  // watchdog: adopts the landed build as known-good (an RMW over its merged read)…
  watchdog.set({ phase: "healthy", prePullSha: "tgt1234" });
  // daemon: starts the NEXT apply — an RMW that, on the old shared file, rewrote the full record.
  daemon.set({ phase: "checking" });
  const r = daemon.get();
  expect(r.phase).toBe("checking"); // the daemon's update took…
  expect(r.prePullSha).toBe("tgt1234"); // …and the watchdog's known-good adoption survived it
  expect(r.targetSha).toBe("tgt1234");
  expect(watchdog.get()).toEqual(r); // both processes agree
});

test("[BE2-30] a raced primary write (stale read) cannot bury an unabsorbed watchdog patch", () => {
  const { dir, daemon, watchdog } = stores();
  daemon.set({ phase: "restarting", targetSha: "tgt1234", prePullSha: "good111" });
  // The watchdog rolls back…
  watchdog.set({ phase: "rolled-back", targetSha: "good111", reason: "gate" });
  // …while a daemon write that READ BEFORE the watchdog's write lands AFTER it. We emulate the raced
  // outcome at the file level (the race window is inside set(), between its read and its atomic
  // rename): a full main record whose absorbedSeq predates the sidecar patch. This is byte-for-byte
  // what such an interleave leaves on disk.
  const file = join(dir, "update-state.json");
  const staleView = { phase: "restarting", targetSha: "tgt1234", prePullSha: "good111", updatedAt: Date.now(), absorbedSeq: 0 };
  writeFileSync(file, JSON.stringify(staleView));
  // The unabsorbed sidecar patch (seq 1 > absorbedSeq 0) still overlays — the rollback is NOT lost.
  const r = daemon.get();
  expect(r.phase).toBe("rolled-back");
  expect(r.reason).toBe("gate");
  expect(r.targetSha).toBe("good111");
  // And the next primary RMW folds it in durably.
  daemon.set({ phase: "checking" });
  expect((JSON.parse(readFileSync(file, "utf8")) as { absorbedSeq: number }).absorbedSeq).toBe(1);
  expect(daemon.get().reason).toBe("gate");
});

test("[BE2-30] successive watchdog patches accumulate until the primary absorbs them", () => {
  const { daemon, watchdog } = stores();
  daemon.set({ phase: "restarting", targetSha: "tgt1234", prePullSha: "good111" });
  watchdog.set({ phase: "healthy", prePullSha: "new22222" }); // adoption…
  watchdog.set({ phase: "error", reason: "later failure" }); // …then a later transition, NOT absorbed in between
  const r = daemon.get();
  expect(r.phase).toBe("error");
  expect(r.reason).toBe("later failure");
  expect(r.prePullSha).toBe("new22222"); // the earlier, unabsorbed adoption still rides along
  // After a primary absorb, a FRESH watchdog patch no longer re-carries stale fields.
  daemon.set({ phase: "checking" });
  watchdog.set({ phase: "rolled-back", reason: "second gate" });
  const r2 = daemon.get();
  expect(r2.phase).toBe("rolled-back");
  expect(r2.prePullSha).toBe("new22222"); // now durable in the main record, not the patch
});

test("[BE2-30] merged state survives fresh instances in both processes", () => {
  const { dir, daemon, watchdog } = stores();
  daemon.set({ phase: "restarting", targetSha: "tgt1234", prePullSha: "good111" });
  watchdog.set({ phase: "rolled-back", reason: "gate" });
  // Both processes restart (new instances, same stateDir).
  expect(new UpdateStateStore(dir).get().phase).toBe("rolled-back");
  expect(new UpdateStateStore(dir, { role: "watchdog" }).get().reason).toBe("gate");
});

test("[BE2-30] a corrupt sidecar is ignored, never thrown", () => {
  const { dir, daemon, watchdog } = stores();
  daemon.set({ phase: "building", targetSha: "tgt1234" });
  watchdog.set({ phase: "error", reason: "x" });
  writeFileSync(join(dir, "update-state.watchdog.json"), "{not json");
  expect(() => daemon.get()).not.toThrow();
  expect(daemon.get().phase).toBe("building"); // falls back to the main record
});
