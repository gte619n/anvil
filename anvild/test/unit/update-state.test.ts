/**
 * [stable-update-service Phase 2] The on-disk update state store — persists the pre-pull SHA + phase
 * across the restart it coordinates. Pins: idle default, merge+stamp on set, atomic durability across a
 * fresh instance, corrupt-file tolerance (never throws on the read path the watchdog depends on), and
 * clear() keeping the known-good SHA.
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateStateStore } from "../../src/daemon/update-state";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "anvil-update-state-"));
}

test("defaults to an idle record when absent", () => {
  const s = new UpdateStateStore(tmp());
  const r = s.get();
  expect(r.phase).toBe("idle");
  expect(r.targetSha).toBe("");
  expect(r.prePullSha).toBe("");
});

test("set() merges, stamps updatedAt, and persists across a fresh instance", () => {
  const dir = tmp();
  let clock = 1000;
  const s = new UpdateStateStore(dir, { now: () => clock });
  s.set({ phase: "pulling", targetSha: "abc123", prePullSha: "def456" });
  clock = 2000;
  s.set({ phase: "restarting" });
  const reloaded = new UpdateStateStore(dir).get();
  expect(reloaded.phase).toBe("restarting");
  expect(reloaded.targetSha).toBe("abc123"); // merged, not clobbered
  expect(reloaded.prePullSha).toBe("def456");
  expect(reloaded.updatedAt).toBe(2000);
});

test("a corrupt file reads back as idle instead of throwing", () => {
  const dir = tmp();
  const s = new UpdateStateStore(dir);
  s.set({ phase: "building", targetSha: "x" });
  // Corrupt the file directly.
  Bun.write(join(dir, "update-state.json"), "{not json");
  expect(() => s.get()).not.toThrow();
  expect(s.get().phase).toBe("idle");
});

test("clear() returns to idle but keeps the known-good prePullSha by default", () => {
  const s = new UpdateStateStore(tmp());
  s.set({ phase: "restarting", targetSha: "t", prePullSha: "good" });
  s.clear();
  expect(s.get().phase).toBe("idle");
  expect(s.get().targetSha).toBe("");
  expect(s.get().prePullSha).toBe("good");
  s.clear(false);
  expect(s.get().prePullSha).toBe("");
});
