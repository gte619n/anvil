/**
 * The CAD process manager (agent-cad-and-browser spec §4.2, §4.3, §4.14 #1 #5 #9 #18).
 *
 * One daemon-owned `solidcraft-cli mcp` process per part, keyed by the part's real folder
 * (`realpath(worktree)/cad/<part>`). Every caller — the agent's tools now, the parameters panel
 * later — goes through ONE strict FIFO queue per part, so two writers can never interleave.
 *
 *  - Start:    `mcp --headless --compact --allow-path <part dir> --require-allow-path [--in design.json]`
 *              with only PATH/HOME/TMPDIR/SOLIDCRAFT_GPU=cpu. Replay is `--in`. The live process
 *              never calls `save`, `open` or `new_design`.
 *  - Limits:   idle exit after 10 min with an empty queue; at most `ANVIL_CAD_MAX_PROCS` (4) live.
 *              A part that needs a slot evicts an idle process first, else waits ("waiting for a
 *              CAD slot" is visible in `status()` and as a `waiting` event).
 *  - Crash:    the pending request fails with the stderr tail; the next request restarts the process
 *              and replays `design.json`. A request that outlives its timeout kills the process.
 *  - Disk:     `design.json` is compared with the copy this process was started from / last wrote
 *              when a request is DEQUEUED (changed → restart from disk, caller is told) and again
 *              immediately before the script rename (changed → never overwrite; see poststep.ts).
 *  - Undo:     a `batch` is many SolidCraft undo steps, so the manager keeps a stack of undo depths
 *              and the agent's `undo` / `redo` revert exactly ONE agent request.
 *
 * THE REFRESH (Phases A2/A3). After a mutating request's script write the part is marked dirty. A
 * `RefreshJob` installed with `setRefresh()` then runs inside the part's queue: at most once per
 * `REFRESH_DEBOUNCE_MS` while requests keep arriving, always when the queue drains, and synchronously
 * first for a job queued with `refreshFirst` (what `forceRefresh()` does). With no job installed —
 * this phase — all of that is a no-op.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveSolidcraftCli } from "../solidcraft/binary";
import {
  McpClient,
  McpExitError,
  McpRpcError,
  McpTimeoutError,
  realClock,
  type CadClock,
  type McpSpawn,
  type McpToolResult,
} from "./mcp-client";
import { assertPartFolderSafe, ensureCadExcludes, type PartRef } from "./partfolder";
import { CACHE_DIR, DESIGN_FILE, DISK_CONFLICT_REASON, formatNumber, readDesignFile, writeScript, type PoststepFs } from "./poststep";

export const DEFAULT_MAX_PROCS = 4;
export const IDLE_EXIT_MS = 10 * 60_000;
export const REQUEST_TIMEOUT_MS = 120_000;
export const BATCH_TIMEOUT_MS = 600_000;
export const REFRESH_DEBOUNCE_MS = 500;
export const WAITING_FOR_SLOT = "waiting for a CAD slot";
export const OLDER_SOLIDCRAFT = "this machine's SolidCraft is older than the design";
export const UNREPLAYABLE_FILE = "design.unreplayable.json";

/** The light read the manager takes after start and after every change (A0: 2.2 KB, 0.5 ms). */
const SNAPSHOT_ARGS = { measure: false, sketches: false, timeline: "summary", bodies: "names" } as const;
const DEPTH_ARGS = { measure: false, sketches: false, timeline: false, bodies: false } as const;

export type CadErrorCode = "unavailable" | "format" | "process" | "timeout" | "rpc" | "script" | "shutdown" | "unsafe";

/** A request that could not be carried out (as opposed to a tool answering `isError`). */
export class CadError extends Error {
  constructor(
    readonly code: CadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CadError";
  }
}

export interface FeatureIssue {
  id?: number;
  feature: string;
  message: string;
}

export interface CadParamInfo {
  name: string;
  expression: string;
  value: number;
  unit: string;
  error?: string;
}

/** What the gate last concluded about the script the process now holds (set by the refresh). */
export interface PartVerdict {
  status: "pass" | "fail" | "unverified";
  reason?: string;
}

/**
 * A part's state. The manager itself knows `unverified` (changed since the last check) and `fail`
 * (a disk conflict, a script that did not replay, failed features); the gate's refresh adds its own
 * verdict through `SlotContext.setVerdict` — including `pass` — which holds until the script changes.
 */
export interface PartState {
  status: "unverified" | "fail" | "pass";
  /** Why it is `fail` (a disk conflict, a script that did not replay, failed features). */
  reason?: string;
  featureErrors: FeatureIssue[];
  featureWarnings: FeatureIssue[];
  /** `design.json` changed on disk during a change; cleared by the reload that follows. */
  conflict: boolean;
  /** `design.json` could not be replayed at start (the process started empty). */
  replayFailure?: string;
  /** `status` is the GATE's verdict (expectations vs measurement), not a failure of the design itself. */
  fromGate?: boolean;
}

export interface PartStatus {
  key: string;
  part: string;
  /** A SolidCraft process is up for this part. */
  live: boolean;
  pid?: number;
  /** A request is running or queued. */
  busy: boolean;
  queued: number;
  /** Its next request is held because every slot is taken by a busy process. */
  waitingForSlot: boolean;
  state: PartState;
  /** sha256 of the canonical `commands` of the script on disk (see poststep.scriptSha). */
  scriptSha?: string;
  /** User parameters as of the last change. */
  params: CadParamInfo[];
  /** The script changed since the last refresh ran. */
  refreshPending: boolean;
}

export type CadRequestKind = "read" | "mutate" | "undo" | "redo";

export interface CadRequest {
  tool: string;
  args?: Record<string, unknown>;
  /** `read` skips the post-step; `mutate` runs it; `undo`/`redo` revert one agent request. */
  kind: CadRequestKind;
  timeoutMs?: number;
  /**
   * Runs INSIDE the same queue slot, after the request and its script write and before anything
   * else (the refresh included). The owner's parameter change uses it to update the accepted numbers
   * atomically with the change, so no other caller's request can slip in between.
   */
  afterWrite?: (slot: SlotContext, done: { result: McpToolResult; wrote: boolean }) => void | Promise<void>;
}

export interface CadReply {
  result: McpToolResult;
  /** Things the caller must be told (design reloaded from disk, conflict, replay failure, …). */
  notes: string[];
  /** `design.json` had changed on disk, so the process was restarted from it before this request. */
  reloaded: boolean;
  /** The request waited for a process slot. */
  waitedForSlot: boolean;
  /** The post-step wrote `design.json` (false for reads, failures and no-op changes). */
  wrote: boolean;
  state: PartState;
  scriptSha?: string;
}

/** What a queued job may do with the part's process while it holds the slot. */
export interface SlotContext {
  ref: PartRef;
  call(tool: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult>;
  notes: string[];
  reloaded: boolean;
  waitedForSlot: boolean;
  state(): PartState;
  scriptSha(): string | undefined;
  /** User parameters as of the last change. */
  params(): CadParamInfo[];
  /** Record the gate's verdict for the script the process holds now (the refresh calls this). */
  setVerdict(verdict: PartVerdict): void;
}

/** The refresh a later phase installs: measure, gate, preview, broadcast (§4.3 steps 2–5). */
export type RefreshJob = (ctx: SlotContext & { forced: boolean }) => Promise<void>;

export type CadManagerEvent =
  | { type: "waiting"; key: string; part: string; waiting: boolean }
  | { type: "started"; key: string; part: string; pid?: number; replayed: boolean }
  | { type: "stopped"; key: string; part: string; reason: "idle" | "evicted" | "reload" | "exit" | "shutdown" }
  | { type: "reloaded"; key: string; part: string }
  | { type: "changed"; key: string; part: string; scriptSha?: string }
  | { type: "refresh-error"; key: string; part: string; error: string };

export interface CadManagerOptions {
  /** Finds the binary. Default: `resolveSolidcraftCli()` — the only way production finds it. */
  resolveCli?: () => { path: string } | undefined;
  spawn?: McpSpawn;
  clock?: CadClock;
  /** Default: `ANVIL_CAD_MAX_PROCS`, else 4. */
  maxProcs?: number;
  idleMs?: number;
  requestTimeoutMs?: number;
  batchTimeoutMs?: number;
  /** FAKE_SC_* hooks for the fake server (tests only). A function is re-read on every spawn. */
  extraEnv?: Record<string, string> | (() => Record<string, string>);
  onEvent?: (e: CadManagerEvent) => void;
  refresh?: RefreshJob;
  /** Test seams for the script write. */
  poststepFs?: PoststepFs;
  beforeScriptRename?: (ref: PartRef) => void | Promise<void>;
}

interface Job {
  body: (rec: PartRec, slot: SlotContext) => Promise<unknown>;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  refreshFirst: boolean;
}

interface PartRec {
  ref: PartRef;
  queue: Job[];
  pumping: boolean;
  client?: McpClient;
  slot?: object;
  /** The sha of the `design.json` the process was started from or last wrote (null: no file). */
  diskSha: string | null;
  /** A process has been started for this part at least once (so `diskSha` means something). */
  started: boolean;
  scriptSha?: string;
  depth: number;
  revision: number;
  /** SolidCraft's own redo depth at the last snapshot. */
  redoDepth: number;
  /** Undo depths recorded BEFORE each agent request that added undo steps. */
  undoStack: number[];
  /** Undo depths to return to on `redo`. */
  redoStack: number[];
  featureErrors: FeatureIssue[];
  featureWarnings: FeatureIssue[];
  params: CadParamInfo[];
  conflict: boolean;
  replayFailure?: string;
  waitingForSlot: boolean;
  idleTimer?: unknown;
  lastUsed: number;
  refreshDirty: boolean;
  lastRefreshAt: number;
  /** The gate's verdict and the script it is about. */
  verdict?: PartVerdict & { scriptSha?: string };
}

export function maxProcsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ANVIL_CAD_MAX_PROCS);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_PROCS;
}

export class CadManager {
  private readonly parts = new Map<string, PartRec>();
  private readonly slots = new Set<object>();
  private waiters: (() => void)[] = [];
  private readonly excluded = new Set<string>();
  private readonly listeners = new Set<(e: CadManagerEvent) => void>();
  private refreshJob?: RefreshJob;
  private closed = false;

  private readonly resolveCli: () => { path: string } | undefined;
  private readonly clock: CadClock;
  readonly maxProcs: number;
  readonly idleMs: number;
  readonly requestTimeoutMs: number;
  readonly batchTimeoutMs: number;

  constructor(private readonly opts: CadManagerOptions = {}) {
    this.resolveCli = opts.resolveCli ?? (() => resolveSolidcraftCli());
    this.clock = opts.clock ?? realClock;
    this.maxProcs = opts.maxProcs ?? maxProcsFromEnv();
    this.idleMs = opts.idleMs ?? IDLE_EXIT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.batchTimeoutMs = opts.batchTimeoutMs ?? BATCH_TIMEOUT_MS;
    this.refreshJob = opts.refresh;
    if (opts.onEvent) this.listeners.add(opts.onEvent);
  }

  // ── public surface ────────────────────────────────────────────────────────────────────────────

  /** Listen to manager events (waiting, started, stopped, reloaded, changed). Returns unsubscribe. */
  subscribe(fn: (e: CadManagerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Install (or clear) the refresh job. See the header for when it runs. */
  setRefresh(job: RefreshJob | undefined): void {
    this.refreshJob = job;
  }

  /** How many SolidCraft processes are up right now. */
  liveCount(): number {
    return this.slots.size;
  }

  status(ref: PartRef | string): PartStatus | undefined {
    const rec = this.parts.get(typeof ref === "string" ? ref : ref.key);
    if (!rec) return undefined;
    return {
      key: rec.ref.key,
      part: rec.ref.part,
      live: !!rec.client?.alive,
      pid: rec.client?.alive ? rec.client.pid : undefined,
      busy: rec.pumping || rec.queue.length > 0,
      queued: rec.queue.length,
      waitingForSlot: rec.waitingForSlot,
      state: this.stateOf(rec),
      scriptSha: rec.scriptSha,
      params: rec.params,
      refreshPending: rec.refreshDirty,
    };
  }

  /** Every part this manager has touched. */
  statuses(): PartStatus[] {
    return [...this.parts.keys()].map((k) => this.status(k)!);
  }

  /** Create the part folder (and the git excludes) and bring its process up. Queued like any request. */
  open(ref: PartRef): Promise<{ notes: string[]; reloaded: boolean; waitedForSlot: boolean; state: PartState; params: CadParamInfo[]; scriptSha?: string; hasDesign: boolean }> {
    return this.enqueue(ref, async (rec, slot) => ({
      notes: slot.notes,
      reloaded: slot.reloaded,
      waitedForSlot: slot.waitedForSlot,
      state: this.stateOf(rec),
      params: rec.params,
      scriptSha: rec.scriptSha,
      hasDesign: rec.diskSha !== null,
    }));
  }

  /** One tool call on the part's process, in arrival order with every other caller's. */
  request(ref: PartRef, req: CadRequest): Promise<CadReply> {
    return this.enqueue(ref, async (rec, slot) => {
      const args = req.args ?? {};
      const timeout = req.timeoutMs ?? (req.tool === "batch" ? this.batchTimeoutMs : this.requestTimeoutMs);
      let result: McpToolResult;
      let wrote = false;
      if (req.kind === "read") {
        result = await this.call(rec, req.tool, args, timeout);
      } else {
        result = req.kind === "mutate" ? await this.call(rec, req.tool, args, timeout) : await this.undoRedo(rec, req.kind, timeout, slot.notes);
        wrote = await this.afterMutation(rec, result, req.kind, slot.notes);
        if (req.afterWrite) await req.afterWrite(slot, { result, wrote });
      }
      return { result, notes: slot.notes, reloaded: slot.reloaded, waitedForSlot: slot.waitedForSlot, wrote, state: this.stateOf(rec), scriptSha: rec.scriptSha };
    });
  }

  /**
   * Run a composite job in the part's queue with direct access to its process (exports now; the
   * gate, release and reference import later). `refreshFirst` runs a pending refresh before `fn`.
   */
  run<T>(ref: PartRef, fn: (ctx: SlotContext) => Promise<T>, opts: { refreshFirst?: boolean } = {}): Promise<T> {
    return this.enqueue(ref, (_rec, slot) => fn(slot), opts.refreshFirst === true);
  }

  /**
   * Run the pending refresh for a part now, in queue order, and wait for it. A NO-OP in Phase A1
   * (no refresh job is installed) and whenever nothing changed since the last refresh.
   */
  async forceRefresh(ref: PartRef | string): Promise<void> {
    const rec = this.parts.get(typeof ref === "string" ? ref : ref.key);
    // Nothing pending and nothing running: nothing to wait for. While the queue is running, a
    // refresh may be in flight (it clears the dirty flag when it STARTS), so queue behind it.
    if (!rec || !this.refreshJob || (!rec.refreshDirty && !rec.pumping)) return;
    await this.enqueue(rec.ref, async () => undefined, true);
  }

  /**
   * Run the refresh for a part NOW, in queue order, and wait for it — even when the script has not
   * changed. `check_part` uses this: `part.json`, `cad/rules.json` or the lock store may have changed
   * with the design untouched. Starts the process if it is not up. A no-op with no refresh job.
   */
  async refreshNow(ref: PartRef): Promise<void> {
    if (!this.refreshJob) return;
    this.rec(ref).refreshDirty = true;
    await this.enqueue(ref, async () => undefined, true);
  }

  /** Stop every process and fail whatever is still queued. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const stops: Promise<unknown>[] = [];
    for (const rec of this.parts.values()) {
      for (const job of rec.queue.splice(0)) job.reject(new CadError("shutdown", "the CAD manager is shutting down"));
      stops.push(this.stop(rec, "shutdown"));
    }
    this.wake();
    await Promise.all(stops);
  }

  // ── queue ─────────────────────────────────────────────────────────────────────────────────────

  private rec(ref: PartRef): PartRec {
    let rec = this.parts.get(ref.key);
    if (!rec) {
      rec = {
        ref,
        queue: [],
        pumping: false,
        diskSha: null,
        started: false,
        depth: 0,
        revision: 0,
        redoDepth: 0,
        undoStack: [],
        redoStack: [],
        featureErrors: [],
        featureWarnings: [],
        params: [],
        conflict: false,
        waitingForSlot: false,
        lastUsed: this.clock.now(),
        refreshDirty: false,
        lastRefreshAt: -Infinity,
      };
      this.parts.set(ref.key, rec);
    }
    return rec;
  }

  private enqueue<T>(ref: PartRef, body: (rec: PartRec, slot: SlotContext) => Promise<T>, refreshFirst = false): Promise<T> {
    if (this.closed) return Promise.reject(new CadError("shutdown", "the CAD manager is shutting down"));
    const rec = this.rec(ref);
    const p = new Promise<T>((resolve, reject) => rec.queue.push({ body, resolve, reject, refreshFirst }));
    void this.pump(rec);
    return p;
  }

  /** The part's single consumer: strictly one job at a time, in arrival order. */
  private async pump(rec: PartRec): Promise<void> {
    if (rec.pumping) return;
    rec.pumping = true;
    this.clearIdle(rec);
    try {
      while (rec.queue.length > 0) {
        const job = rec.queue.shift()!;
        try {
          const slot = await this.prepare(rec);
          if (job.refreshFirst) await this.runRefresh(rec, slot, true);
          job.resolve(await job.body(rec, slot));
        } catch (e) {
          job.reject(this.toCadError(e));
        }
        // The refresh: its own step after the request, never part of the request's reply. Always
        // when the queue has drained; during a burst at most once per REFRESH_DEBOUNCE_MS.
        if (rec.refreshDirty && this.refreshJob && rec.client?.alive && (rec.queue.length === 0 || this.clock.now() - rec.lastRefreshAt >= REFRESH_DEBOUNCE_MS)) {
          await this.runRefresh(rec, this.slotContext(rec, { notes: [], reloaded: false, waitedForSlot: false }), false);
        }
      }
    } finally {
      rec.pumping = false;
      rec.lastUsed = this.clock.now();
      this.armIdle(rec);
      this.wake(); // this part is idle now: someone waiting for a slot may evict it
    }
  }

  private async runRefresh(rec: PartRec, slot: SlotContext, forced: boolean): Promise<void> {
    const job = this.refreshJob;
    if (!job || !rec.refreshDirty) return;
    rec.refreshDirty = false;
    rec.lastRefreshAt = this.clock.now();
    try {
      await job({ ...slot, forced });
    } catch (e) {
      // A refresh that throws must never take a request down with it. The gate (A2) fails closed
      // on its own side; here the part simply stays dirty for the next attempt.
      rec.refreshDirty = true;
      this.emit({ type: "refresh-error", key: rec.ref.key, part: rec.ref.part, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private slotContext(rec: PartRec, info: { notes: string[]; reloaded: boolean; waitedForSlot: boolean }): SlotContext {
    return {
      ref: rec.ref,
      call: (tool, args = {}, timeoutMs) => this.call(rec, tool, args, timeoutMs ?? (tool === "batch" ? this.batchTimeoutMs : this.requestTimeoutMs)),
      notes: info.notes,
      reloaded: info.reloaded,
      waitedForSlot: info.waitedForSlot,
      state: () => this.stateOf(rec),
      scriptSha: () => rec.scriptSha,
      params: () => rec.params,
      setVerdict: (verdict) => {
        rec.verdict = { ...verdict, scriptSha: rec.scriptSha };
      },
    };
  }

  // ── process lifecycle ─────────────────────────────────────────────────────────────────────────

  /** Runs at DEQUEUE: the disk check, then make sure a process is up (waiting for a slot if needed). */
  private async prepare(rec: PartRec): Promise<SlotContext> {
    const notes: string[] = [];
    let reloaded = false;
    let waited = false;
    let disk = readDesignFile(rec.ref.dir);
    if (rec.client?.alive && disk.sha !== rec.diskSha) {
      await this.stop(rec, "reload");
      reloaded = true;
    }
    if (!rec.client?.alive) {
      if (rec.client) {
        // It died a moment ago and its exit has not been processed yet: give its slot back now,
        // or the replacement would be counted on top of it.
        rec.client = undefined;
        this.releaseSlot(rec);
      }
      if (rec.started && disk.sha !== rec.diskSha) reloaded = true;
      waited = await this.acquireSlot(rec);
      try {
        if (waited) disk = readDesignFile(rec.ref.dir); // it may have changed while we waited
        await this.start(rec, disk, notes);
      } catch (e) {
        // A start that got as far as a live process but failed after it must not leave one behind.
        const half = rec.client as McpClient | undefined; // set inside start(); TS cannot see that
        rec.client = undefined;
        half?.kill();
        this.releaseSlot(rec);
        throw e;
      }
      if (waited) notes.push(`This call waited for a CAD slot (at most ${this.maxProcs} SolidCraft process${this.maxProcs === 1 ? "" : "es"} run at once on this machine).`);
      if (reloaded) {
        rec.refreshDirty = true;
        notes.push(`cad/${rec.ref.part}/design.json was changed on disk, so the design was reloaded from it before this call. Earlier undo history is gone.`);
        this.emit({ type: "reloaded", key: rec.ref.key, part: rec.ref.part });
      }
    }
    return this.slotContext(rec, { notes, reloaded, waitedForSlot: waited });
  }

  private async acquireSlot(rec: PartRec): Promise<boolean> {
    let waited = false;
    try {
      for (;;) {
        if (this.closed) throw new CadError("shutdown", "the CAD manager is shutting down");
        if (this.slots.size < this.maxProcs) {
          rec.slot = {};
          this.slots.add(rec.slot);
          return waited;
        }
        // Idle processes go first, least recently used first.
        const victim = [...this.parts.values()]
          .filter((p) => p !== rec && p.client?.alive && !p.pumping && p.queue.length === 0)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (victim) {
          await this.stop(victim, "evicted");
          continue;
        }
        if (!waited) {
          waited = true;
          rec.waitingForSlot = true;
          this.emit({ type: "waiting", key: rec.ref.key, part: rec.ref.part, waiting: true });
        }
        await new Promise<void>((r) => this.waiters.push(r));
      }
    } finally {
      if (rec.waitingForSlot) {
        rec.waitingForSlot = false;
        this.emit({ type: "waiting", key: rec.ref.key, part: rec.ref.part, waiting: false });
      }
    }
  }

  private releaseSlot(rec: PartRec): void {
    if (rec.slot) this.slots.delete(rec.slot);
    rec.slot = undefined;
    this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  private spawnEnv(): Record<string, string> {
    const x = this.opts.extraEnv;
    return typeof x === "function" ? x() : (x ?? {});
  }

  private baseCmd(cli: string, dir: string): string[] {
    // --allow-path is the PART folder, never the worktree root; --allow-any-path is never passed.
    return [cli, "mcp", "--headless", "--compact", "--allow-path", dir, "--require-allow-path"];
  }

  private async start(rec: PartRec, disk: ReturnType<typeof readDesignFile>, notes: string[]): Promise<void> {
    const { ref } = rec;
    const cli = this.resolveCli();
    if (!cli) throw new CadError("unavailable", "SolidCraft is not installed on this machine (no solidcraft-cli found)");
    // Never start in (or create) a folder that is, or sits behind, a symbolic link out of the repo.
    this.assertSafe(ref);
    mkdirSync(ref.dir, { recursive: true });
    this.assertSafe(ref);
    if (!this.excluded.has(ref.worktree)) {
      if (ensureCadExcludes(ref.worktree) !== undefined) this.excluded.add(ref.worktree);
    }

    // Anvil enforces the format number itself: SolidCraft does not check `about.format` on a script.
    // Fail closed: a script that parses but does not say which format it is cannot be checked, so
    // it is refused before anything is started. (A file that is not a script at all — not JSON, no
    // `commands` — cannot be replayed by any build; it takes the replay-failure path below.)
    const designFormat = disk.script ? formatNumber(disk.script) : undefined;
    if (disk.script && designFormat === undefined) {
      throw new CadError(
        "format",
        `cad/${ref.part}/design.json does not say which SolidCraft format it is (\`about.format\` is missing or is not a number), so it cannot be opened safely. ` +
          `Restore the file from git; it was not touched.`,
      );
    }

    const common = { extraEnv: this.spawnEnv(), spawn: this.opts.spawn, clock: this.clock };
    const base = this.baseCmd(cli.path, ref.dir);
    let client: McpClient | undefined;
    let replayFailure: string | undefined;
    if (disk.sha !== null) {
      try {
        client = await McpClient.start({ cmd: [...base, "--in", join(ref.dir, DESIGN_FILE)], ...common });
      } catch (e) {
        // `--in` exits 1 with `error: step N (cmd): …` (or `error: <path>: …`) on a script it cannot
        // run at all. That is the design's problem, not the machine's: start empty and say so.
        const line = e instanceof McpExitError ? /^error: (.+)$/m.exec(e.stderrTail)?.[1] : undefined;
        if (!line) throw e;
        replayFailure = line.trim();
      }
    }
    if (!client) client = await McpClient.start({ cmd: base, ...common });
    // The build's own format number comes from THIS process's script export — no second process,
    // and no way to skip the check: if the number cannot be learned, the design is not opened.
    if (designFormat !== undefined) {
      let local: number | undefined;
      try {
        const r = await client.callTool("execute", { command: "timeline.export_script", params: {} }, this.requestTimeoutMs);
        local = r.isError ? undefined : formatNumber(r.json?.script);
      } catch {
        local = undefined;
      }
      if (local === undefined || designFormat > local) {
        client.kill();
        throw new CadError(
          "format",
          local === undefined
            ? `could not learn which design format this machine's SolidCraft reads, so cad/${ref.part}/design.json (format ${designFormat}) was not opened. The file was not touched.`
            : `${OLDER_SOLIDCRAFT}: cad/${ref.part}/design.json is format ${designFormat} and this build reads up to ${local}. Update SolidCraft on this machine; the file was not touched.`,
        );
      }
    }

    if (replayFailure) {
      // Keep the file that did not replay: the first successful change will overwrite design.json.
      try {
        mkdirSync(join(ref.dir, CACHE_DIR), { recursive: true });
        copyFileSync(join(ref.dir, DESIGN_FILE), join(ref.dir, CACHE_DIR, UNREPLAYABLE_FILE));
      } catch {
        /* best effort */
      }
      notes.push(
        `cad/${ref.part}/design.json could not be replayed (${replayFailure}), so SolidCraft started EMPTY. ` +
          `The file is untouched until a change succeeds; a copy is in cad/${ref.part}/.cache/${UNREPLAYABLE_FILE}.`,
      );
    }

    rec.client = client;
    rec.started = true;
    rec.diskSha = disk.sha;
    rec.scriptSha = disk.scriptSha;
    rec.undoStack = [];
    rec.redoStack = [];
    rec.conflict = false;
    rec.replayFailure = replayFailure;
    void client.exited.then(() => this.onExit(rec, client));
    this.emit({ type: "started", key: ref.key, part: ref.part, pid: client.pid, replayed: disk.sha !== null && !replayFailure });

    // `--in` starts even when features fail, so read the timeline straight away.
    await this.snapshot(rec);
    if (rec.featureErrors.length) notes.push(this.featureNote(rec));
  }

  private assertSafe(ref: PartRef): void {
    try {
      assertPartFolderSafe(ref);
    } catch (e) {
      throw new CadError("unsafe", e instanceof Error ? e.message : String(e));
    }
  }

  private onExit(rec: PartRec, client: McpClient): void {
    if (rec.client !== client) return; // we stopped it ourselves
    rec.client = undefined;
    this.clearIdle(rec);
    this.releaseSlot(rec);
    this.emit({ type: "stopped", key: rec.ref.key, part: rec.ref.part, reason: "exit" });
  }

  private async stop(rec: PartRec, reason: "idle" | "evicted" | "reload" | "shutdown"): Promise<void> {
    const client = rec.client;
    this.clearIdle(rec);
    if (!client) return;
    rec.client = undefined; // from here a new request restarts from disk
    const slot = rec.slot;
    rec.slot = undefined;
    await client.close().catch(() => undefined);
    if (slot) this.slots.delete(slot); // the slot frees only once the old process is really gone
    this.emit({ type: "stopped", key: rec.ref.key, part: rec.ref.part, reason });
    this.wake();
  }

  private armIdle(rec: PartRec): void {
    this.clearIdle(rec);
    if (!rec.client?.alive || this.closed) return;
    rec.idleTimer = this.clock.setTimeout(() => {
      rec.idleTimer = undefined;
      if (!rec.pumping && rec.queue.length === 0) void this.stop(rec, "idle");
    }, this.idleMs);
  }

  private clearIdle(rec: PartRec): void {
    if (rec.idleTimer !== undefined) this.clock.clearTimeout(rec.idleTimer);
    rec.idleTimer = undefined;
  }

  // ── talking to the process ────────────────────────────────────────────────────────────────────

  private async call(rec: PartRec, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpToolResult> {
    const client = rec.client;
    if (!client?.alive) throw new CadError("process", `SolidCraft is not running for cad/${rec.ref.part}; call again to restart it from design.json`);
    try {
      return await client.callTool(tool, args, timeoutMs);
    } catch (e) {
      if (e instanceof McpExitError || e instanceof McpTimeoutError) {
        if (rec.client === client) {
          rec.client = undefined;
          this.clearIdle(rec);
          this.releaseSlot(rec);
          this.emit({ type: "stopped", key: rec.ref.key, part: rec.ref.part, reason: "exit" });
        }
        const lost = "Nothing from this call was saved; the next call restarts SolidCraft from design.json.";
        if (e instanceof McpTimeoutError) throw new CadError("timeout", `${e.message}. ${lost}`);
        throw new CadError("process", `SolidCraft stopped while running \`${tool}\` — ${e.message}. ${lost}`);
      }
      throw e;
    }
  }

  private toCadError(e: unknown): Error {
    if (e instanceof CadError) return e;
    if (e instanceof McpRpcError) return new CadError("rpc", e.message);
    if (e instanceof McpExitError) return new CadError("process", `SolidCraft could not be started: ${e.message}`);
    if (e instanceof McpTimeoutError) return new CadError("timeout", e.message);
    return e instanceof Error ? e : new Error(String(e));
  }

  /** Read undo depth, revision, parameters and feature errors/warnings into the record. */
  private async snapshot(rec: PartRec): Promise<void> {
    const r = await this.call(rec, "inspect_design", { ...SNAPSHOT_ARGS }, this.requestTimeoutMs);
    const j = r.json ?? {};
    rec.depth = Number(j.undo ?? 0);
    rec.redoDepth = Number(j.redo ?? 0);
    rec.revision = Number(j.revision ?? 0);
    const timeline: any[] = Array.isArray(j.timeline) ? j.timeline : [];
    rec.featureErrors = timeline.filter((f) => f?.error).map((f) => ({ id: f.id, feature: String(f.name ?? f.id), message: String(f.error) }));
    rec.featureWarnings = timeline.filter((f) => f?.warning).map((f) => ({ id: f.id, feature: String(f.name ?? f.id), message: String(f.warning) }));
    const params: any[] = Array.isArray(j.params) ? j.params : [];
    rec.params = params
      .filter((p) => p && p.model !== true)
      .map((p) => ({ name: String(p.name), expression: String(p.expression ?? ""), value: Number(p.value), unit: String(p.unit ?? ""), ...(p.error ? { error: String(p.error) } : {}) }));
  }

  private async depthNow(rec: PartRec): Promise<number> {
    const r = await this.call(rec, "inspect_design", { ...DEPTH_ARGS }, this.requestTimeoutMs);
    return Number(r.json?.undo ?? 0);
  }

  /**
   * The agent's `undo` / `redo`: step SolidCraft back (or forward) until the undo depth is the one
   * recorded around the agent's last request, so a 16-command batch is undone as ONE thing and a
   * sketch is never left half re-opened. With nothing recorded (after a restart) it is one step.
   */
  private async undoRedo(rec: PartRec, dir: "undo" | "redo", timeoutMs: number, notes: string[]): Promise<McpToolResult> {
    const stack = dir === "undo" ? rec.undoStack : rec.redoStack;
    const other = dir === "undo" ? rec.redoStack : rec.undoStack;
    const start = rec.depth;
    const target = stack.pop();
    let last = await this.call(rec, dir, {}, timeoutMs);
    if (last.isError) {
      if (target !== undefined) stack.push(target);
      return last;
    }
    let steps = 1;
    if (target !== undefined) {
      const short = (d: number) => (dir === "undo" ? d > target : d < target);
      let depth = await this.depthNow(rec);
      while (short(depth) && steps < 10_000) {
        const r = await this.call(rec, dir, {}, timeoutMs);
        if (r.isError) break;
        last = r;
        steps++;
        depth = await this.depthNow(rec);
      }
    }
    other.push(start);
    if (steps > 1) notes.push(`${dir === "undo" ? "Undid" : "Redid"} your last request as a whole (${steps} SolidCraft steps).`);
    return last;
  }

  /** The post-step. Returns whether `design.json` was (re)written. */
  private async afterMutation(rec: PartRec, result: McpToolResult, kind: CadRequestKind, notes: string[]): Promise<boolean> {
    const before = { depth: rec.depth, revision: rec.revision };
    await this.snapshot(rec);
    // A failed request that left the design as it was (a rolled-back batch, a refused parameter)
    // needs no write. One that failed but kept its change (an `expect` mismatch) does.
    const changed = !result.isError || rec.depth !== before.depth || rec.revision !== before.revision;
    if (!changed) return false;
    if (kind === "mutate") {
      if (rec.depth > before.depth) rec.undoStack.push(before.depth);
      if (rec.redoDepth === 0) rec.redoStack = [];
    }
    let out: Awaited<ReturnType<typeof writeScript>>;
    try {
      out = await writeScript({
        call: (tool, args) => this.call(rec, tool, args, this.requestTimeoutMs),
        partDir: rec.ref.dir,
        part: rec.ref.part,
        expectedDiskSha: rec.diskSha,
        fs: this.opts.poststepFs,
        beforeRename: this.opts.beforeScriptRename ? () => this.opts.beforeScriptRename!(rec.ref) : undefined,
      });
    } catch (e) {
      if (e instanceof CadError) throw e;
      throw new CadError(
        "script",
        `the change was applied in SolidCraft but cad/${rec.ref.part}/design.json could not be written (${e instanceof Error ? e.message : String(e)}). The file on disk is the previous version.`,
      );
    }
    if (out.kind === "conflict") {
      rec.conflict = true;
      notes.push(
        `${DISK_CONFLICT_REASON}: cad/${rec.ref.part}/design.json was edited while this request ran, so it was NOT overwritten. ` +
          `What this request produced is in cad/${rec.ref.part}/.cache/design.conflict.json. The file on disk wins: the next call reloads the design from it.`,
      );
      return false;
    }
    rec.diskSha = out.diskSha;
    rec.scriptSha = out.scriptSha;
    rec.replayFailure = undefined;
    if (out.changed) {
      rec.refreshDirty = true;
      this.emit({ type: "changed", key: rec.ref.key, part: rec.ref.part, scriptSha: out.scriptSha });
    }
    if (rec.featureErrors.length) notes.push(this.featureNote(rec));
    return out.changed;
  }

  private featureNote(rec: PartRec): string {
    const list = rec.featureErrors.map((f) => `${f.feature}: ${f.message}`).join("; ");
    return `${rec.featureErrors.length} feature${rec.featureErrors.length === 1 ? "" : "s"} failed to build, so the geometry is PARTIAL and measurements are not of the intended part — ${list}`;
  }

  private stateOf(rec: PartRec): PartState {
    const base = { featureErrors: rec.featureErrors, featureWarnings: rec.featureWarnings, conflict: rec.conflict, ...(rec.replayFailure ? { replayFailure: rec.replayFailure } : {}) };
    if (rec.conflict) return { status: "fail", reason: DISK_CONFLICT_REASON, ...base };
    if (rec.replayFailure) return { status: "fail", reason: `design.json failed to replay: ${rec.replayFailure}`, ...base };
    if (rec.featureErrors.length) return { status: "fail", reason: `failed features: ${rec.featureErrors.map((f) => `${f.feature}: ${f.message}`).join("; ")}`, ...base };
    // The gate's verdict stands while it is about the current script and nothing is waiting to be re-checked.
    if (rec.verdict && !rec.refreshDirty && rec.verdict.scriptSha === rec.scriptSha) {
      return { status: rec.verdict.status, ...(rec.verdict.reason ? { reason: rec.verdict.reason } : {}), ...base, fromGate: true };
    }
    return { status: "unverified", ...base };
  }

  private emit(e: CadManagerEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a listener must never break the queue */
      }
    }
  }
}
