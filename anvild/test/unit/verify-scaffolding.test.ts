/**
 * [P0] Completion-verification scaffolding (spec Phase 0): the WorkUnit `verification` overlay block
 * persists/reloads intact, and the `verifyEnabled` schedule flag defaults off + round-trips through the
 * store. The protocol golden (new autopilot.verify* wire types) is pinned by the contract test; the
 * capability tag by the identity test — this file covers the two stateful pieces.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkUnitStore, type WorkUnitVerification } from "../../src/integrations/workunit";
import { AutopilotScheduleStore, DEFAULT_SCHEDULE } from "../../src/integrations/schedule";

const freshDir = (): string => mkdtempSync(join(tmpdir(), "anvil-verify-scaffold-"));

test("[P0] a WorkUnit's verification overlay persists and reloads (including raw)", () => {
  const dir = freshDir();
  try {
    const verification: WorkUnitVerification = {
      verdict: "done",
      evidence: "- task A → `src/foo.ts:42`",
      raw: '{"tasks":[{"taskId":"t1","verdict":"done","cited":true}]}',
      perTask: [{ taskId: "t1", verdict: "done", cited: true, note: "implemented in foo()" }],
      confidence: 0.8,
      baseRef: "origin/main",
      baseSha: "abc123",
      at: "2026-10-29T00:00:00.000Z",
      todoistClosedSeen: true,
    };
    const store = new WorkUnitStore(dir);
    const created = store.create({
      environmentId: "env1",
      todoistProjectId: "proj1",
      taskIds: ["t1"],
      title: "Add foo",
      verification,
    });

    // Reload from disk via a fresh store — the overlay must survive the JSON round-trip byte-for-byte.
    const reloaded = new WorkUnitStore(dir).get(created.id);
    expect(reloaded?.verification).toEqual(verification);
    // The raw verdict JSON is kept so a wrong call is debuggable (spec §4.7).
    expect(reloaded?.verification?.raw).toBe(verification.raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[P0] an old WorkUnit with no verification block still loads (additive/optional)", () => {
  const dir = freshDir();
  try {
    const store = new WorkUnitStore(dir);
    const u = store.create({ environmentId: "e", todoistProjectId: "p", taskIds: ["t"], title: "Legacy" });
    const reloaded = new WorkUnitStore(dir).get(u.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.verification).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[P0] verifyEnabled defaults OFF and round-trips through the schedule store", () => {
  const dir = freshDir();
  try {
    expect(DEFAULT_SCHEDULE.verifyEnabled).toBe(false);
    const store = new AutopilotScheduleStore(dir);
    expect(store.get().verifyEnabled).toBe(false);

    store.set({ verifyEnabled: true });
    expect(store.get().verifyEnabled).toBe(true);
    // Persisted: a fresh store over the same dir reads it back on.
    expect(new AutopilotScheduleStore(dir).get().verifyEnabled).toBe(true);

    // An unrelated patch must not clobber it (omitted fields stay as-is).
    store.set({ timeOfDay: "03:00" });
    expect(store.get().verifyEnabled).toBe(true);

    store.set({ verifyEnabled: false });
    expect(store.get().verifyEnabled).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
