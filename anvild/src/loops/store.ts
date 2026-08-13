/**
 * LoopStore (loops-circuit spec §4.1) — persistence for the first-class Loop catalog + its runs.
 * Patterned on AutopilotScheduleStore (atomic JSON catalog, corrupt-file quarantine) + WorkUnitStore
 * (per-line resilience). Catalog: `<stateDir>/loops/loops.json`. Runs: `<stateDir>/loops/runs/<loopId>.jsonl`
 * — append-only, last-writer-wins per run id, compacted to the last 200 distinct runs (truncation logged).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../util/atomic";
import type { Loop, LoopRun } from "@protocol";

const RUN_RETENTION = 200; // distinct runs retained per loop
const COMPACT_AT = 2 * RUN_RETENTION; // compact the JSONL once it grows past this many lines

export class LoopStore {
  private readonly dir: string;
  private readonly runsDir: string;
  private readonly catalogFile: string;
  private loops: Loop[] = [];

  constructor(stateDir: string) {
    this.dir = join(stateDir, "loops");
    this.runsDir = join(this.dir, "runs");
    mkdirSync(this.runsDir, { recursive: true });
    this.catalogFile = join(this.dir, "loops.json");
    this.load();
  }

  // ── Catalog ────────────────────────────────────────────────────────────────────────────────────
  private load(): void {
    if (!existsSync(this.catalogFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.catalogFile, "utf8")) as { loops?: Loop[] };
      this.loops = parsed.loops ?? [];
    } catch (e) {
      // A corrupt catalog must NOT silently wipe every loop — quarantine it and start empty (WorkUnitStore pattern).
      const backup = `${this.catalogFile}.corrupt-${Date.now()}`;
      try {
        renameSync(this.catalogFile, backup);
        console.error(`[loops] loops.json was unreadable (${e instanceof Error ? e.message : e}); backed up to ${backup}`);
      } catch {
        /* best-effort */
      }
    }
  }
  private saveCatalog(): void {
    writeFileAtomic(this.catalogFile, JSON.stringify({ loops: this.loops }, null, 2));
  }

  list(): Loop[] {
    return [...this.loops];
  }
  get(id: string): Loop | undefined {
    return this.loops.find((l) => l.id === id);
  }
  /** Upsert a loop (create or replace by id). */
  save(loop: Loop): void {
    const i = this.loops.findIndex((l) => l.id === loop.id);
    if (i >= 0) this.loops[i] = loop;
    else this.loops.push(loop);
    this.saveCatalog();
  }
  remove(id: string): boolean {
    const before = this.loops.length;
    this.loops = this.loops.filter((l) => l.id !== id);
    if (this.loops.length === before) return false;
    this.saveCatalog();
    try {
      rmSync(this.runFile(id), { force: true });
    } catch {
      /* best-effort */
    }
    return true;
  }
  /** Find a loop already converted from a given work unit (loop.convert idempotency). */
  byWorkUnit(workUnitId: string): Loop | undefined {
    return this.loops.find((l) => l.workUnitId === workUnitId);
  }

  // ── Runs (per-loop JSONL) ────────────────────────────────────────────────────────────────────────
  private runFile(loopId: string): string {
    return join(this.runsDir, `${sanitize(loopId)}.jsonl`);
  }
  /** All runs for a loop, folded by id (last write wins), newest first. Corrupt lines are skipped. */
  runs(loopId: string): LoopRun[] {
    const file = this.runFile(loopId);
    if (!existsSync(file)) return [];
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const byId = new Map<string, LoopRun>();
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const run = JSON.parse(t) as LoopRun;
        if (run && run.id) byId.set(run.id, run); // last line for an id wins
      } catch {
        /* skip the corrupt line, keep the rest (never wipe the history) */
      }
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }
  /** The latest run for a loop (or a specific run by id). */
  latestRun(loopId: string): LoopRun | undefined {
    return this.runs(loopId)[0];
  }
  runById(loopId: string, runId: string): LoopRun | undefined {
    return this.runs(loopId).find((r) => r.id === runId);
  }
  /** Persist a run snapshot (append a line; compact when the file grows past the retention budget). */
  putRun(run: LoopRun): void {
    const file = this.runFile(run.loopId);
    appendFileSync(file, JSON.stringify(run) + "\n");
    // Cheap growth check: count lines only when the file could plausibly be large.
    let lineCount = 0;
    try {
      lineCount = readFileSync(file, "utf8").split("\n").length;
    } catch {
      return;
    }
    if (lineCount > COMPACT_AT) this.compact(run.loopId);
  }
  /** Rewrite the JSONL keeping only the last RUN_RETENTION distinct runs (newest first). Logged. */
  private compact(loopId: string): void {
    const all = this.runs(loopId); // newest first
    const kept = all.slice(0, RUN_RETENTION);
    const dropped = all.length - kept.length;
    // Persist oldest→newest so append semantics stay intact.
    const body = kept
      .slice()
      .reverse()
      .map((r) => JSON.stringify(r))
      .join("\n");
    writeFileAtomic(this.runFile(loopId), body ? body + "\n" : "");
    if (dropped > 0) console.error(`[loops] compacted runs for ${loopId}: kept ${kept.length}, dropped ${dropped}`);
  }

  /** All loop ids that have a persisted run file (for interrupted-run recovery on boot). */
  loopIdsWithRuns(): string[] {
    try {
      return readdirSync(this.runsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.slice(0, -".jsonl".length));
    } catch {
      return [];
    }
  }
}

/** A filesystem-safe file stem from a loop id (ids are "loop_<hex>" but be defensive). */
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
