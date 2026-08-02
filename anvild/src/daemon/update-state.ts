/**
 * On-disk update state (stable-update-service spec §4.3 / D8). Persisted to
 * `<stateDir>/update-state.json` so it survives the very restart it's coordinating. Two jobs:
 *   1. Record the PRE-PULL SHA before an update mutates the checkout, so a daemon that comes up
 *      unhealthy can be rolled back to the last known-good build (the watchdog + `/api/update/v1/apply`
 *      both read/write this).
 *   2. Carry the live phase + target so `/api/update/v1/status` can report progress to a hub that's
 *      observing the rollout, and so a restart can resume/settle rather than losing the thread.
 *
 * [BE2-30] TWO PROCESSES write this state — the daemon (update-api paths) and the out-of-process
 * watchdog — and `set()` is a cross-process read-modify-write: each writer serialized the FULL record
 * from its own (possibly stale) read, so an atomic file write was still a non-atomic RMW and the two
 * processes could silently erase each other's fields (e.g. the watchdog's known-good adoption clobbered
 * by a daemon phase write it never saw). Fix (per the 2026-08-01 interview decision): the watchdog gets
 * its own SIDECAR file — each file has exactly ONE writer, so there is no shared-file RMW left to race:
 *   • `update-state.json`          — written ONLY by the daemon (role "primary"). Carries the full
 *                                    record plus `absorbedSeq`: the sidecar seq its content reflects.
 *   • `update-state.watchdog.json` — written ONLY by the watchdog (role "watchdog"). Carries a
 *                                    monotonically-numbered PATCH (cumulative until absorbed).
 * READERS MERGE: the sidecar patch overlays the main record iff its seq is newer than what the main
 * record absorbed. A primary write absorbs exactly the sidecar seq it READ — so a watchdog write that
 * lands inside a primary read→write window keeps a higher seq and still overlays afterwards; neither
 * writer can lose the other's fields. (A CAS was rejected: files offer no atomic compare-and-rename,
 * so "CAS" degrades to a lock file with staleness heuristics — worse for the crash-surviving backstop
 * than single-writer files. With exactly two writers the sidecar is race-free by construction.)
 * The frozen v1 response shapes are untouched — this is purely the persistence layer under them.
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

/** Which process this store instance belongs to — i.e. which file its `set()` is allowed to write.
 *  The daemon (and tests that don't care) use "primary"; ONLY the watchdog process uses "watchdog". */
export type UpdateStateRole = "primary" | "watchdog";

/** The watchdog's sidecar: a numbered patch, cumulative until the primary absorbs it ([BE2-30]). */
interface SidecarFile {
  seq: number;
  patch: Partial<UpdateRecord>;
  updatedAt: number;
}

export class UpdateStateStore {
  private readonly file: string;
  private readonly sidecarFile: string;
  private readonly role: UpdateStateRole;
  private readonly now: () => number;

  constructor(stateDir: string, opts: { now?: () => number; role?: UpdateStateRole } = {}) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "update-state.json");
    this.sidecarFile = join(stateDir, "update-state.watchdog.json");
    this.role = opts.role ?? "primary";
    this.now = opts.now ?? (() => Date.now());
  }

  /** The current MERGED record (main + any unabsorbed watchdog patch), or a fresh idle one when
   *  absent/corrupt. Both roles read the same merged view. */
  get(): UpdateRecord {
    return this.readMerged().record;
  }

  /**
   * Merge a partial update and stamp `updatedAt`. Written atomically so a crash mid-write can't leave
   * the file (which a not-yet-booted daemon may be the only thing that can rewrite) half-serialized.
   * [BE2-30] Each role writes ONLY its own file: the primary rewrites the full main record (recording
   * the sidecar seq it merged, so an unseen concurrent watchdog patch stays overlaid); the watchdog
   * appends to its cumulative sidecar patch and never touches the main file.
   */
  set(patch: Partial<UpdateRecord>): UpdateRecord {
    if (this.role === "watchdog") return this.setViaSidecar(patch);
    const m = this.readMerged();
    const next: UpdateRecord = { ...m.record, ...patch, updatedAt: this.now() };
    // `absorbedSeq` rides in the main file only (stripped on read): the sidecar content this record
    // already reflects. A sidecar seq ABOVE it — including one written during this very read→write
    // window — still overlays on every future read, so a raced watchdog write is never lost.
    writeFileAtomic(this.file, JSON.stringify({ ...next, absorbedSeq: m.sidecarSeq }, null, 2));
    return next;
  }

  /** Back to idle (keeps prePullSha as the last known-good unless explicitly cleared). */
  clear(keepKnownGood = true): void {
    const prev = this.get();
    this.set({ phase: "idle", targetSha: "", reason: undefined, prePullSha: keepKnownGood ? prev.prePullSha : "" });
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────

  /** The watchdog-side write: bump the sidecar seq and carry any not-yet-absorbed fields forward, so
   *  successive watchdog patches (e.g. a known-good adoption, then a later error) accumulate rather
   *  than replace each other until a primary write folds them into the main record. */
  private setViaSidecar(patch: Partial<UpdateRecord>): UpdateRecord {
    const main = this.readMain();
    const prev = this.readSidecar();
    const carry = prev && prev.seq > main.absorbedSeq ? prev.patch : {};
    const seq = Math.max(prev?.seq ?? 0, main.absorbedSeq) + 1;
    writeFileAtomic(this.sidecarFile, JSON.stringify({ seq, patch: { ...carry, ...patch }, updatedAt: this.now() } satisfies SidecarFile, null, 2));
    return this.get();
  }

  private readMain(): { record: UpdateRecord; absorbedSeq: number } {
    if (!existsSync(this.file)) return { record: { ...EMPTY }, absorbedSeq: 0 };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<UpdateRecord> & { absorbedSeq?: number };
      const { absorbedSeq, ...fields } = raw;
      return { record: { ...EMPTY, ...fields }, absorbedSeq: typeof absorbedSeq === "number" ? absorbedSeq : 0 };
    } catch {
      return { record: { ...EMPTY }, absorbedSeq: 0 }; // corrupt — treat as idle, never throw on the read path the watchdog depends on
    }
  }

  private readSidecar(): SidecarFile | null {
    if (!existsSync(this.sidecarFile)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.sidecarFile, "utf8")) as Partial<SidecarFile>;
      if (typeof raw.seq !== "number" || typeof raw.patch !== "object" || raw.patch === null) return null;
      return { seq: raw.seq, patch: raw.patch, updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0 };
    } catch {
      return null; // corrupt sidecar — ignore it rather than fail the read path
    }
  }

  /** Main + sidecar merged; `sidecarSeq` is what a primary write should record as absorbed. */
  private readMerged(): { record: UpdateRecord; sidecarSeq: number } {
    const main = this.readMain();
    const sc = this.readSidecar();
    if (!sc || sc.seq <= main.absorbedSeq) {
      return { record: main.record, sidecarSeq: Math.max(sc?.seq ?? 0, main.absorbedSeq) };
    }
    return {
      record: { ...main.record, ...sc.patch, updatedAt: Math.max(main.record.updatedAt, sc.updatedAt) },
      sidecarSeq: sc.seq,
    };
  }
}
