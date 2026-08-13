/**
 * LoopEngine (loops-circuit spec §4.2) — the run lifecycle: lap → checks → verdict → repeat | gate | stop.
 *
 * Owned by the daemon, driven through injected deps (the AutopilotDeps pattern) so the whole lifecycle is
 * deterministic under test: a fake clock, a scripted `runLap` (diffs + outputs, no worktree/subprocess),
 * a scripted judge/command, and a real LoopStore over a temp dir. Enforces the three hard stops at lap
 * boundaries (lap ceiling; token/time budget; terminal no-progress), the scope guard (scope-violation /
 * check-tampering), and the gate (park at-gate; open per rung; send back exactly one more lap).
 */
import { checkLocks } from "./contract";
import { combineVerdicts, runChecks, type CheckContext } from "./checks";
import { evaluateScope } from "./scope-guard";
import { BadCommand } from "../session/errors";
import type { Lap, Loop, LoopRun, LoopRunStatus } from "@protocol";
import type { LoopStore } from "./store";

export interface LapExecution {
  diffFiles: string[]; // repo-relative paths the lap touched (git diff --name-only)
  summary: string; // one-line "what the lap did"
  tokens: number; // tokens spent this lap
  transcript: string; // recent transcript (fed to judge checks)
  cwd: string; // the run's worktree
  sessionId?: string; // heavy bodies expose their session
}

export interface LoopEngineDeps {
  store: LoopStore;
  now: () => Date;
  genRunId: () => string;
  /** Execute one lap of the act body. `feedback` carries prior failing verdicts; `note` the sendback note. */
  runLap: (args: { loop: Loop; run: LoopRun; feedback?: string; note?: string }) => Promise<LapExecution>;
  /** Separate-spawn judge (maker–checker). */
  judge: (condition: string, transcript: string) => Promise<{ met: boolean; reason?: string }>;
  /** Run a check command in the run's worktree. */
  runCommand: (command: string, cwd: string) => Promise<{ exit: number; output: string }>;
  /** GET a URL for http checks (returns the status). Optional — absent ⇒ http checks check-error. */
  httpGet?: (url: string) => Promise<{ status: number }>;
  /** Ship at the gate per rung (Suggest report / Draft branch / PR PR). Returns a summary + optional url. */
  openGateAction: (loop: Loop, run: LoopRun) => Promise<{ summary: string; url?: string }>;
  /** Live run/lap broadcast. */
  onRun: (run: LoopRun) => void;
  /** Optional push notification hook. */
  notify?: (loop: Loop, run: LoopRun, kind: "gate" | "failure" | "success") => void;
}

export class LoopEngine {
  private readonly active = new Set<string>(); // loopIds with a live run (coalesce concurrent triggers)
  private readonly gating = new Set<string>(); // runIds with an in-flight gate verb (idempotency, spec §7)
  // Per-run diff signatures per lap, for no-progress detection (not persisted on the wire shape).
  private readonly lapSigs = new Map<string, string[]>();

  constructor(private readonly deps: LoopEngineDeps) {}

  /** Is a run live for this loop right now? */
  isActive(loopId: string): boolean {
    return this.active.has(loopId);
  }

  /**
   * Start a run for a loop and drive it to its first pause (terminal or at-gate). Resolves with the run
   * in that paused state. Coalesces: a trigger firing while a run is live for that loop returns the live
   * run's latest snapshot instead of starting a second (one run per loop at a time, spec §7).
   */
  async run(loop: Loop, trigger: { kind: string; source?: string }): Promise<LoopRun> {
    if (this.active.has(loop.id)) {
      const live = this.deps.store.latestRun(loop.id);
      if (live) return live;
    }
    const nowIso = this.deps.now().toISOString();
    const run: LoopRun = {
      id: this.deps.genRunId(),
      loopId: loop.id,
      configRevision: loop.configRevision, // pin the revision this run started with
      trigger: { kind: trigger.kind, ...(trigger.source ? { source: trigger.source } : {}), at: nowIso },
      status: "running",
      laps: [],
      startedAt: nowIso,
    };
    this.deps.store.putRun(run);
    this.lapSigs.set(run.id, []);
    this.deps.onRun(run);
    return this.drive(loop, run);
  }

  /**
   * Dry run (loops-circuit spec §4.4): drive EXACTLY one lap, report the verdict, take no gate action.
   * The run carries `dryRun: true` so the gate verbs refuse it (no branch/push/PR is ever possible). The
   * caller (LoopService) runs it in a throwaway worktree and removes it after.
   */
  async dryRun(loop: Loop, trigger: { kind: string; source?: string } = { kind: "manual" }): Promise<LoopRun> {
    const nowIso = this.deps.now().toISOString();
    const run: LoopRun = {
      id: this.deps.genRunId(),
      loopId: loop.id,
      configRevision: loop.configRevision,
      trigger: { kind: trigger.kind, ...(trigger.source ? { source: trigger.source } : {}), at: nowIso },
      status: "running",
      laps: [],
      dryRun: true,
      startedAt: nowIso,
    };
    this.deps.store.putRun(run);
    this.lapSigs.set(run.id, []);
    this.deps.onRun(run);
    this.active.add(loop.id);
    try {
      const paused = await this.runOneLap(loop, run);
      // Cap at one lap. If it parked at-gate (checks passed) keep that; otherwise mark the report terminal.
      if (!paused || run.status === "running") {
        run.status = "failed"; // the single lap didn't pass — the report shows why
      }
      run.reason = `Dry run — no branch/PR/push. ${run.status === "at-gate" ? "First lap would park at your gate." : "First lap did not pass; tune the loop and try again."}`;
      run.endedAt = this.deps.now().toISOString();
      this.deps.store.putRun(run);
      this.deps.onRun(run);
      this.lapSigs.delete(run.id);
      return run;
    } finally {
      this.active.delete(loop.id);
    }
  }

  /** Resume driving a run (used by sendback and, in Phase 5, interrupted-run recovery). */
  private async drive(loop: Loop, run: LoopRun): Promise<LoopRun> {
    this.active.add(loop.id);
    try {
      // Loop laps until a pause (terminal or at-gate).
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // ── Hard stops, evaluated at the lap boundary BEFORE the next lap runs ──
        if (run.laps.length >= loop.hardStops.maxLaps) return this.terminal(loop, run, "failed", `reached the ${loop.hardStops.maxLaps}-lap ceiling`);
        const tokensSoFar = run.laps.reduce((n, l) => n + (l.tokens ?? 0), 0);
        if (tokensSoFar >= loop.hardStops.tokenBudget) return this.terminal(loop, run, "over-budget", `token budget ${loop.hardStops.tokenBudget} exhausted`);
        if (loop.hardStops.timeBudgetMs && this.deps.now().getTime() - Date.parse(run.startedAt) >= loop.hardStops.timeBudgetMs)
          return this.terminal(loop, run, "over-budget", "time budget exhausted");

        const paused = await this.runOneLap(loop, run);
        if (paused) return run; // parked at-gate or terminal (state already set + broadcast)
      }
    } finally {
      this.active.delete(loop.id);
    }
  }

  /**
   * Run exactly one lap and record it. Returns true when the run reached a PAUSE (at-gate or terminal) —
   * the caller (drive) stops looping; false to keep lapping.
   */
  private async runOneLap(loop: Loop, run: LoopRun, note?: string): Promise<boolean> {
    const feedback = lastFailingFeedback(run);
    const exec = await this.deps.runLap({ loop, run, ...(feedback ? { feedback } : {}), ...(note ? { note } : {}) });
    if (exec.sessionId && !run.sessionId) run.sessionId = exec.sessionId;

    const n = run.laps.length + 1;
    const at = this.deps.now().toISOString();
    let lap: Lap;

    // ── Scope guard (lap-boundary diff) ──
    const scope = evaluateScope(exec.diffFiles, loop.scope?.allow, checkLocks(loop.checks));
    if (scope.verdict !== "ok") {
      lap = { n, summary: exec.summary, verdicts: [{ check: "scope", v: scope.verdict, detail: scope.offending.join(", ") }], tokens: exec.tokens, at };
    } else {
      const ctx: CheckContext = { judge: this.deps.judge, runCommand: this.deps.runCommand, ...(this.deps.httpGet ? { httpGet: this.deps.httpGet } : {}), transcript: exec.transcript, cwd: exec.cwd };
      const results = await runChecks(loop.checks, ctx);
      lap = { n, summary: exec.summary, verdicts: results, tokens: exec.tokens, at };
    }
    run.laps.push(lap);
    // Track this lap's diff signature for no-progress detection.
    const sigs = this.lapSigs.get(run.id) ?? [];
    sigs.push([...exec.diffFiles].sort().join(" "));
    this.lapSigs.set(run.id, sigs);
    // Checkpoint at the lap boundary, AFTER the verdict is rendered (spec §4.2).
    run.checkpoint = { lap: n };
    this.deps.store.putRun(run);
    this.deps.onRun(run);

    // ── Outcome ──
    const passed = scope.verdict === "ok" && combineVerdicts(lap.verdicts, loop.checksMode).passed;
    if (passed) {
      run.status = "at-gate";
      this.deps.store.putRun(run);
      this.deps.onRun(run);
      this.deps.notify?.(loop, run, "gate");
      return true;
    }
    // Terminal no-progress: last N laps failing with an identical diff signature (empty delta), spec §4.2.
    if (this.isNoProgress(run, loop.hardStops.noProgressLaps)) {
      this.terminal(loop, run, "no-progress", `no progress across ${loop.hardStops.noProgressLaps} laps`);
      return true;
    }
    return false; // keep lapping
  }

  /** last N laps all non-passing AND their diff signatures identical (empty delta). */
  private isNoProgress(run: LoopRun, n: number): boolean {
    if (run.laps.length < n) return false;
    const lastLaps = run.laps.slice(-n);
    const allFail = lastLaps.every((l) => !l.verdicts.some((v) => v.v === "pass") || l.verdicts.length === 0);
    if (!allFail) return false;
    const sigs = (this.lapSigs.get(run.id) ?? []).slice(-n);
    if (sigs.length < n) return false;
    return sigs.every((s) => s === sigs[0]);
  }

  private terminal(loop: Loop, run: LoopRun, status: LoopRunStatus, reason: string): LoopRun {
    run.status = status;
    run.reason = reason;
    run.endedAt = this.deps.now().toISOString();
    this.deps.store.putRun(run);
    this.deps.onRun(run);
    this.lapSigs.delete(run.id);
    if (loop.notify.onFailure) this.deps.notify?.(loop, run, "failure");
    return run;
  }

  // ── Gate verbs (idempotent per run id) ─────────────────────────────────────────────────────────────
  /** Open the gate: ship per rung. A verb on a non-at-gate run is a BadCommand (idempotent / stale gate). */
  async openGate(loopId: string, runId: string): Promise<LoopRun> {
    const loop = this.deps.store.get(loopId);
    if (!loop) throw new BadCommand(`no such loop: ${loopId}`);
    const run = this.deps.store.runById(loopId, runId);
    if (!run) throw new BadCommand(`no such run: ${runId}`);
    if (run.dryRun) throw new BadCommand("this was a dry run — arm the loop and Run now for a real run");
    if (run.status !== "at-gate") throw new BadCommand(`run ${runId} is not at the gate (it is ${run.status})`);
    // In-flight guard: the status check + mutation straddle the awaited ship action, so a second
    // concurrent open would otherwise double-ship (double PR + double autonomy credit). Claim the run id.
    if (this.gating.has(runId)) throw new BadCommand(`a gate action is already in progress for run ${runId}`);
    this.gating.add(runId);
    try {
      const result = await this.deps.openGateAction(loop, run);
      run.status = "shipped";
      run.gate = { ...(run.gate ?? {}), openedAt: this.deps.now().toISOString() };
      run.reason = result.url ? `${result.summary} — ${result.url}` : result.summary;
      run.endedAt = this.deps.now().toISOString();
      this.deps.store.putRun(run);
      loop.cleanGatedLaps = (loop.cleanGatedLaps ?? 0) + 1;
      loop.updatedAt = this.deps.now().toISOString();
      this.deps.store.save(loop);
      this.deps.onRun(run);
      if (loop.notify.onSuccess) this.deps.notify?.(loop, run, "success");
      this.lapSigs.delete(run.id);
      return run;
    } finally {
      this.gating.delete(runId);
    }
  }

  /** Send back a lap: record the note + run EXACTLY one more lap with it injected (spec §4.2). Refused at
   *  the lap ceiling (send-back laps count toward maxLaps). */
  async sendback(loopId: string, runId: string, note: string): Promise<LoopRun> {
    const loop = this.deps.store.get(loopId);
    if (!loop) throw new BadCommand(`no such loop: ${loopId}`);
    const run = this.deps.store.runById(loopId, runId);
    if (!run) throw new BadCommand(`no such run: ${runId}`);
    if (run.status !== "at-gate") throw new BadCommand(`run ${runId} is not at the gate (it is ${run.status})`);
    if (run.laps.length >= loop.hardStops.maxLaps) throw new BadCommand(`run ${runId} is at the ${loop.hardStops.maxLaps}-lap ceiling — can't send back`);
    // The status flip below is synchronous (no await before it), so a concurrent sendback/open sees a
    // non-at-gate run and is rejected — no extra in-flight guard needed here (unlike openGate).
    run.gate = { ...(run.gate ?? {}), sentBackNote: note };
    run.status = "sent-back";
    this.deps.store.putRun(run);
    this.deps.onRun(run);
    // Ensure the no-progress signature history is present (a resumed run may have lost it in-memory).
    if (!this.lapSigs.has(run.id)) this.lapSigs.set(run.id, run.laps.map(() => "resumed"));

    this.active.add(loop.id);
    try {
      const paused = await this.runOneLap(loop, run, note);
      if (!paused) {
        // The single sendback lap neither passed nor tripped a terminal → re-park at the gate for the human.
        run.status = "at-gate";
        this.deps.store.putRun(run);
        this.deps.onRun(run);
        this.deps.notify?.(loop, run, "gate");
      }
    } finally {
      this.active.delete(loop.id);
    }
    return run;
  }
}

/** Feedback for the next lap = the prior lap's failing verdict details (so the agent knows what to fix). */
function lastFailingFeedback(run: LoopRun): string | undefined {
  const last = run.laps[run.laps.length - 1];
  if (!last) return undefined;
  const fails = last.verdicts.filter((v) => v.v !== "pass");
  if (!fails.length) return undefined;
  return fails.map((v) => `${v.check}: ${v.v}${v.detail ? ` — ${v.detail}` : ""}`).join("; ");
}
