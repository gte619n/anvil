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
 * Rate limits belong to a Claude ACCOUNT, not a session or a machine, so the gauge is keyed by roster
 * account id: a daemon with two accounts keeps two independent gauges (and two soft-stop latches),
 * instead of one gauge that flips between whichever account finished a turn last. The key "" holds
 * the bare env-var token (no roster).
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

interface AccountState {
  budget: Budget;
  softStopped: boolean; // latched so the soft-stop advisory fires once per 7-day window
  weekResetsAt?: string; // when this changes, the window rolled over → clear the latch
}

interface Persisted {
  accounts: Record<string, AccountState>;
  latest?: string; // key of the most recently refreshed account
  /** A pre-per-account `budget.json`'s gauge, kept only as `snapshot()`'s fallback until a fresh
   *  reading lands — we can't know which account it belonged to. */
  legacy?: Budget;
}

const EMPTY: Budget = { available: false, warn: false };

export class RateLimitTracker {
  private readonly file: string;
  private state: Persisted;

  constructor(private readonly cfg: BudgetConfig) {
    mkdirSync(cfg.stateDir, { recursive: true });
    this.file = join(cfg.stateDir, "budget.json");
    this.state = this.load();
  }

  /** The most recently refreshed account's gauge (also what a cold-attaching client / health check
   *  sees, and what autopilot/teams gate on) — the pre-per-account behavior. */
  snapshot(): Budget {
    const k = this.state.latest;
    return (k !== undefined ? this.state.accounts[k]?.budget : undefined) ?? this.state.legacy ?? EMPTY;
  }

  /** Every account's gauge, newest reading first. */
  snapshots(): Budget[] {
    return Object.values(this.state.accounts)
      .map((a) => a.budget)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  /** Drop accounts no longer in the roster so a removed account's gauge stops being reported. */
  retain(keep: (accountKey: string) => boolean): void {
    let changed = false;
    for (const k of Object.keys(this.state.accounts)) {
      if (keep(k)) continue;
      delete this.state.accounts[k];
      if (this.state.latest === k) delete this.state.latest;
      changed = true;
    }
    if (changed) this.save();
  }

  /**
   * Fold a fresh SDK `rate_limits` payload into `accountKey`'s gauge ("" = no roster account). `raw`
   * is null/undefined when the reading was unavailable this turn (API-key session, missing scope,
   * or a transient failure) — we keep the last-known snapshot rather than blanking a real gauge.
   * Returns that account's new snapshot and whether this crossed its weekly soft-stop (fires once
   * per window, per account).
   */
  update(accountKey: string, raw: unknown, subscriptionType?: string | null): { budget: Budget; crossedSoftStop: boolean } {
    const r = raw && typeof raw === "object" ? (raw as Record<string, Win>) : null;
    const prev = this.state.accounts[accountKey];
    if (!r) return { budget: prev?.budget ?? this.snapshot(), crossedSoftStop: false };
    const acct: AccountState = prev ?? { budget: EMPTY, softStopped: false };

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
    if (week?.resetsAt && week.resetsAt !== acct.weekResetsAt) {
      acct.softStopped = false;
      acct.weekResetsAt = week.resetsAt;
    }
    let crossedSoftStop = false;
    if (!acct.softStopped && (week?.utilization ?? 0) >= this.cfg.softStopFraction * PCT) {
      acct.softStopped = true;
      crossedSoftStop = true;
    }

    acct.budget = {
      available: true,
      ...(accountKey ? { accountId: accountKey } : {}),
      ...(subscriptionType ? { subscriptionType } : {}),
      ...(session ? { session } : {}),
      ...(week ? { week } : {}),
      ...(weekOpus ? { weekOpus } : {}),
      ...(weekSonnet ? { weekSonnet } : {}),
      warn,
      updatedAt: new Date().toISOString(),
    };
    this.state.accounts[accountKey] = acct;
    this.state.latest = accountKey;
    delete this.state.legacy;
    this.save();
    return { budget: acct.budget, crossedSoftStop };
  }

  private load(): Persisted {
    if (existsSync(this.file)) {
      try {
        const p = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted> & { budget?: Budget };
        if (p && typeof p === "object" && p.accounts && typeof p.accounts === "object") {
          return { accounts: p.accounts, ...(p.latest !== undefined ? { latest: p.latest } : {}) };
        }
        // Pre-per-account shape: keep its gauge as the fallback; a legacy cost→hours file is dropped.
        if (p?.budget && typeof p.budget.available === "boolean") return { accounts: {}, legacy: p.budget };
      } catch {
        /* fall through to a fresh gauge */
      }
    }
    return { accounts: {} };
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.state, null, 2)); // [BE-9] atomic (tmp+rename)
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
