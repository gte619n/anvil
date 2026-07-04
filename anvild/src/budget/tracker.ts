import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Budget, RateWindow } from "@protocol";
import { writeFileAtomic } from "../util/atomic";

/**
 * Rate-limit tracker — arch §3, decision #9 (load-bearing).
 *
 * The daemon runs on a Claude subscription (OAuth), so the authoritative usage signal is the
 * plan's own rate-limit windows — the 5-hour and 7-day utilization shown in claude.ai →
 * Settings → Usage. The Agent SDK surfaces these per session via its (experimental) usage
 * endpoint; the driver reads them after each turn and feeds the raw payload here. We map it to
 * the protocol `Budget`, flip `warn` when any window passes the threshold, and fire a one-shot
 * soft-stop when the weekly window nears the cap so an autonomous session can't silently drain
 * the week.
 *
 * This replaces the previous cost→hours *estimate*, which invented an hours figure against a
 * configured cap and could read far from reality (e.g. "over" while the plan was at 5%).
 *
 * Thresholds (env, fractions of a window 0–1): ANVIL_BUDGET_WARN, ANVIL_BUDGET_SOFTSTOP.
 */

const PCT = 100;

/** Loosely-typed view of the SDK's `rate_limits` object — the experimental endpoint may add or
 *  rename windows, so we read known keys defensively rather than coupling to its exact type. */
type Win = { utilization?: number | null; resets_at?: string | null } | null | undefined;

export interface BudgetConfig {
  stateDir: string;
  warnFraction: number; // 0–1 of any window
  softStopFraction: number; // 0–1 of the 7-day window
}

interface Persisted {
  budget: Budget;
  softStopped: boolean; // latched so the soft-stop advisory fires once per 7-day window
  weekResetsAt?: string; // when this changes, the window rolled over → clear the latch
}

export class RateLimitTracker {
  private readonly file: string;
  private state: Persisted;

  constructor(private readonly cfg: BudgetConfig) {
    mkdirSync(cfg.stateDir, { recursive: true });
    this.file = join(cfg.stateDir, "budget.json");
    this.state = this.load();
  }

  /** The last-known gauge (also what a cold-attaching client / health check sees). */
  snapshot(): Budget {
    return this.state.budget;
  }

  /**
   * Fold a fresh SDK `rate_limits` payload into the gauge. `raw` is null/undefined when the
   * reading was unavailable this turn (API-key session, missing scope, or a transient failure) —
   * we keep the last-known snapshot rather than blanking a real gauge. Returns the new snapshot
   * and whether this crossed the weekly soft-stop (fires once per window).
   */
  update(raw: unknown, subscriptionType?: string | null): { budget: Budget; crossedSoftStop: boolean } {
    const r = raw && typeof raw === "object" ? (raw as Record<string, Win>) : null;
    if (!r) return { budget: this.state.budget, crossedSoftStop: false };

    const win = (w: Win): RateWindow | undefined =>
      w && typeof w.utilization === "number"
        ? { utilization: round(w.utilization), ...(w.resets_at ? { resetsAt: w.resets_at } : {}) }
        : undefined;
    const session = win(r.five_hour);
    const week = win(r.seven_day);
    const weekOpus = win(r.seven_day_opus);
    const weekSonnet = win(r.seven_day_sonnet);

    const warnAt = this.cfg.warnFraction * PCT;
    const warn = [session, week, weekOpus, weekSonnet].some((w) => (w?.utilization ?? 0) >= warnAt);

    // Clear the soft-stop latch when the 7-day window rolls over (its reset timestamp changes).
    if (week?.resetsAt && week.resetsAt !== this.state.weekResetsAt) {
      this.state.softStopped = false;
      this.state.weekResetsAt = week.resetsAt;
    }
    let crossedSoftStop = false;
    if (!this.state.softStopped && (week?.utilization ?? 0) >= this.cfg.softStopFraction * PCT) {
      this.state.softStopped = true;
      crossedSoftStop = true;
    }

    this.state.budget = {
      available: true,
      ...(subscriptionType ? { subscriptionType } : {}),
      ...(session ? { session } : {}),
      ...(week ? { week } : {}),
      ...(weekOpus ? { weekOpus } : {}),
      ...(weekSonnet ? { weekSonnet } : {}),
      warn,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return { budget: this.state.budget, crossedSoftStop };
  }

  private load(): Persisted {
    if (existsSync(this.file)) {
      try {
        const p = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted>;
        // Accept only the current shape; a legacy cost→hours file falls through to a fresh gauge.
        if (p && typeof p === "object" && p.budget && typeof p.budget.available === "boolean") {
          return { budget: p.budget, softStopped: Boolean(p.softStopped), weekResetsAt: p.weekResetsAt };
        }
      } catch {
        /* fall through to a fresh gauge */
      }
    }
    return { budget: { available: false, warn: false }, softStopped: false };
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.state, null, 2)); // [BE-9] atomic (tmp+rename)
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
