/**
 * [BE2-15] In-memory job coordinator for the fleet fan-outs (rotate / invite). The REST latency of
 * those POSTs was bound to the SLOWEST remote — an offline member burns ~14s of pairing timeouts, so
 * "Sync now" pinned a request open long enough that the global idleTimeout had to be raised to 120s.
 * Job-ifying them decouples the HTTP round-trip from the fan-out: the POST starts (or joins) a job and
 * answers immediately; observers poll `GET /api/fleet/jobs/:id` for the terminal result, which is the
 * exact body the old synchronous POST produced (information-content equivalent).
 *
 * Modelled on the FleetRolloutCoordinator (the in-repo job-style orchestration): fire-and-forget body,
 * observers poll a snapshot, and a same-key start() JOINS the in-flight job rather than double-firing
 * (double-click safety; two clients pressing "Sync now" share one fan-out). Deliberately in-memory —
 * the web client polls the same daemon that started the job, and a daemon restart mid-fan-out loses
 * nothing durable (rotate/invite are idempotent, best-effort pushes); an unknown id is answered as
 * gone and the client surfaces "try again".
 */
import { newId } from "../util/ids";

export type FleetJobKind = "rotate" | "invite";

/** What observers see. `result` appears exactly when `state` becomes "done". */
export interface FleetJobSnapshot {
  jobId: string;
  kind: FleetJobKind;
  state: "running" | "done";
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
}

interface Job {
  id: string;
  kind: FleetJobKind;
  /** Join key: a second start() with the same key while running returns THIS job. */
  key: string;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  completion: Promise<unknown>;
}

/** Keep finished jobs visible for this long so a slow poller still reads its result. */
const FINISHED_TTL_MS = 10 * 60_000;

export class FleetJobs {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Start a job, or JOIN the running one with the same kind+key. `run` must resolve with the terminal
   * result (never reject — but a reject is still caught and stored as a `{ok:false,error}` result so a
   * poller can never hang on a job that died).
   */
  start<R>(kind: FleetJobKind, key: string, run: () => Promise<R>): { job: FleetJobSnapshot; completion: Promise<R> } {
    this.prune();
    for (const j of this.jobs.values()) {
      if (j.kind === kind && j.key === key && j.finishedAt === undefined) {
        return { job: this.snapshot(j), completion: j.completion as Promise<R> };
      }
    }
    const job: Job = { id: newId("job"), kind, key, startedAt: this.now(), completion: Promise.resolve() };
    job.completion = run()
      .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as unknown as R)
      .then((result) => {
        job.result = result;
        job.finishedAt = this.now();
        return result;
      });
    this.jobs.set(job.id, job);
    return { job: this.snapshot(job), completion: job.completion as Promise<R> };
  }

  /** The job's current snapshot, or null when unknown/expired. */
  get(id: string): FleetJobSnapshot | null {
    this.prune();
    const j = this.jobs.get(id);
    return j ? this.snapshot(j) : null;
  }

  private snapshot(j: Job): FleetJobSnapshot {
    return {
      jobId: j.id,
      kind: j.kind,
      state: j.finishedAt === undefined ? "running" : "done",
      startedAt: j.startedAt,
      ...(j.finishedAt !== undefined ? { finishedAt: j.finishedAt } : {}),
      ...(j.result !== undefined ? { result: j.result } : {}),
    };
  }

  /** Drop finished jobs past their TTL (running jobs are never dropped). */
  private prune(): void {
    const cutoff = this.now() - FINISHED_TTL_MS;
    for (const [id, j] of this.jobs) {
      if (j.finishedAt !== undefined && j.finishedAt < cutoff) this.jobs.delete(id);
    }
  }
}
