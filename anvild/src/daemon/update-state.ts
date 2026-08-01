/**
 * On-disk update state (stable-update-service spec §4.3 / D8). Persisted to
 * `<stateDir>/update-state.json` so it survives the very restart it's coordinating. Two jobs:
 *   1. Record the PRE-PULL SHA before an update mutates the checkout, so a daemon that comes up
 *      unhealthy can be rolled back to the last known-good build (the watchdog + `/api/update/v1/apply`
 *      both read/write this).
 *   2. Carry the live phase + target so `/api/update/v1/status` can report progress to a hub that's
 *      observing the rollout, and so a restart can resume/settle rather than losing the thread.
 *
 * Deliberately tiny and dependency-free (node:fs only, like FleetStore) — this is part of the STABLE
 * surface that a broken daemon release must not be able to corrupt, and it has to be readable even when
 * the rest of the daemon won't boot.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../util/atomic";
import type { rest } from "@protocol";

export interface UpdateRecord {
  /** Where the update flow currently is (or last ended). Defaults to "idle". */
  phase: rest.update.UpdatePhase;
  /** The SHA the checkout is being moved to (the pinned target). "" when idle. */
  targetSha: string;
  /** HEAD captured immediately BEFORE the pull — the known-good commit to roll back to. "" when none. */
  prePullSha: string;
  /** Why, when phase is "rolled-back" or "error". */
  reason?: string;
  /** ms epoch of the last transition. */
  updatedAt: number;
}

const EMPTY: UpdateRecord = { phase: "idle", targetSha: "", prePullSha: "", updatedAt: 0 };

export class UpdateStateStore {
  private readonly file: string;
  private readonly now: () => number;

  constructor(stateDir: string, opts: { now?: () => number } = {}) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "update-state.json");
    this.now = opts.now ?? (() => Date.now());
  }

  /** The current record, or a fresh idle one when absent/corrupt. */
  get(): UpdateRecord {
    if (!existsSync(this.file)) return { ...EMPTY };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<UpdateRecord>;
      return { ...EMPTY, ...raw };
    } catch {
      return { ...EMPTY }; // corrupt — treat as idle, never throw on the read path the watchdog depends on
    }
  }

  /** Merge a partial update and stamp `updatedAt`. Written atomically so a crash mid-write can't leave
   *  the file (which a not-yet-booted daemon may be the only thing that can rewrite) half-serialized. */
  set(patch: Partial<UpdateRecord>): UpdateRecord {
    const next: UpdateRecord = { ...this.get(), ...patch, updatedAt: this.now() };
    writeFileAtomic(this.file, JSON.stringify(next, null, 2));
    return next;
  }

  /** Back to idle (keeps prePullSha as the last known-good unless explicitly cleared). */
  clear(keepKnownGood = true): void {
    const prev = this.get();
    this.set({ phase: "idle", targetSha: "", reason: undefined, prePullSha: keepKnownGood ? prev.prePullSha : "" });
  }
}
