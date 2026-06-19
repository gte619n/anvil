import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Budget, Model } from "@protocol";

/**
 * Budget tracker — arch §3, decision #9 (load-bearing).
 *
 * The Max pool is denominated in *hours*, but the SDK reports per-turn USD-equivalent cost.
 * We accumulate cost per model over a rolling 7-day window and convert to an hours-estimate
 * via calibratable USD/hr rates. The exact hour figure is approximate; what matters is that
 * usage accrues, `warn` flips at the threshold, and a one-shot soft-stop fires near the cap
 * so an autonomous Opus session can't silently drain the week.
 *
 * Calibration knobs (env): ANVIL_OPUS_USD_PER_HR, ANVIL_SONNET_USD_PER_HR,
 * ANVIL_OPUS_LIMIT_HRS, ANVIL_SONNET_LIMIT_HRS. The cost→hours mapping is isolated here so
 * the paused Agent-SDK billing split (arch §3) can be re-pointed without touching callers.
 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const USD_PER_HR = {
  opus: Number(process.env.ANVIL_OPUS_USD_PER_HR ?? 18),
  sonnet: Number(process.env.ANVIL_SONNET_USD_PER_HR ?? 6),
};
const LIMIT_HRS = {
  opus: Number(process.env.ANVIL_OPUS_LIMIT_HRS ?? 20), // Max-5x defaults
  sonnet: Number(process.env.ANVIL_SONNET_LIMIT_HRS ?? 240),
};

interface BudgetState {
  windowStart: number;
  opusUsd: number;
  sonnetUsd: number;
  softStopped: boolean;
}

export interface BudgetConfig {
  stateDir: string;
  warnFraction: number;
  softStopFraction: number;
}

export class BudgetTracker {
  private readonly file: string;
  private state: BudgetState;

  constructor(private readonly cfg: BudgetConfig) {
    mkdirSync(cfg.stateDir, { recursive: true });
    this.file = join(cfg.stateDir, "budget.json");
    this.state = this.load();
    this.roll();
  }

  /** Record a turn's cost; returns the new snapshot and whether this crossed the soft-stop. */
  record(model: Model, costUsd: number): { budget: Budget; crossedSoftStop: boolean } {
    this.roll();
    if (model === "opus") this.state.opusUsd += costUsd;
    else this.state.sonnetUsd += costUsd;

    const budget = this.snapshot();
    const opusFrac = budget.opus.limitHrs > 0 ? budget.opus.usedHrs / budget.opus.limitHrs : 0;
    let crossedSoftStop = false;
    if (!this.state.softStopped && opusFrac >= this.cfg.softStopFraction) {
      this.state.softStopped = true;
      crossedSoftStop = true;
    }
    this.save();
    return { budget, crossedSoftStop };
  }

  snapshot(): Budget {
    this.roll();
    const opusHrs = this.state.opusUsd / USD_PER_HR.opus;
    const sonnetHrs = this.state.sonnetUsd / USD_PER_HR.sonnet;
    const warn =
      opusHrs >= this.cfg.warnFraction * LIMIT_HRS.opus ||
      sonnetHrs >= this.cfg.warnFraction * LIMIT_HRS.sonnet;
    return {
      opus: { usedHrs: round(opusHrs), limitHrs: LIMIT_HRS.opus },
      sonnet: { usedHrs: round(sonnetHrs), limitHrs: LIMIT_HRS.sonnet },
      windowResetsAt: new Date(this.state.windowStart + WEEK_MS).toISOString(),
      warn,
    };
  }

  private load(): BudgetState {
    if (existsSync(this.file)) {
      try {
        return JSON.parse(readFileSync(this.file, "utf8")) as BudgetState;
      } catch {
        /* fall through to a fresh window */
      }
    }
    return { windowStart: Date.now(), opusUsd: 0, sonnetUsd: 0, softStopped: false };
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  private roll(): void {
    if (Date.now() - this.state.windowStart >= WEEK_MS) {
      this.state = { windowStart: Date.now(), opusUsd: 0, sonnetUsd: 0, softStopped: false };
      this.save();
    }
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
