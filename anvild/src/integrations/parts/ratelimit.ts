/**
 * Client-side rate limiting for the part sources (Phase C5): one token bucket per short window
 * (per minute, per hour), all of which must have a token for a call to go out, plus — for the
 * sources with a daily quota — a calendar-day (UTC) count persisted in the daemon's state dir, so a
 * restart does not hand out a fresh day. Kept under the vendors' published limits (C0 evidence:
 * DigiKey 120/min + 1000/day, Mouser 30/min + 1000/day, TraceParts 3000/hour) so this daemon never
 * earns a 429 or a suspended key.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../../util/atomic";

export interface RateWindow {
  limit: number;
  perMs: number;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type RateVerdict = { ok: true } | { ok: false; retryAfterMs: number };

/** `YYYY-MM-DD` of `t` in UTC. */
export function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Milliseconds from `t` to the next UTC midnight. */
export function msToUtcMidnight(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - t;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calls made today (UTC calendar day), per source, in `<stateDir>/parts-ratelimit.json`
 * (`{source: {day: "YYYY-MM-DD", count}}`), written atomically on every counted call and read once
 * at construction. A new UTC day starts every count at 0. Without a file (a connector unit test) it
 * counts in memory only.
 *
 * A file that cannot be read or is not that shape FAILS CLOSED for the rest of the current UTC day:
 * every source counts as used up until midnight, when the next counted call rewrites the file. (A
 * corrupt counter must not become a fresh quota; it must not brick the sources forever either.)
 */
export class DailyCounter {
  private counts: Record<string, { day: string; count: number }> = {};
  /** The UTC day a corrupt file was found on: every source is used up until it ends. */
  private poisonedDay?: string;

  constructor(
    private readonly file: string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
      for (const [source, v] of Object.entries(raw as Record<string, unknown>)) {
        const e = v as { day?: unknown; count?: unknown } | null;
        if (!e || typeof e !== "object" || typeof e.day !== "string" || !DAY_RE.test(e.day) || typeof e.count !== "number" || !Number.isInteger(e.count) || e.count < 0) throw new Error(`bad entry ${source}`);
        this.counts[source] = { day: e.day, count: e.count };
      }
    } catch {
      this.counts = {};
      this.poisonedDay = utcDay(now());
    }
  }

  /** A row (or a corrupt read) dated LATER than today means the clock stepped back: it counts as
   *  today, with its count, so stepping the clock back never buys a fresh day. (Days are YYYY-MM-DD,
   *  so they compare as strings.) */
  private used(source: string, today: string): number {
    if (this.poisonedDay !== undefined && this.poisonedDay >= today) return Number.POSITIVE_INFINITY;
    const e = this.counts[source];
    return e && e.day >= today ? e.count : 0;
  }

  /** Whether one more call fits under `limit` today; a refused call waits for the next UTC midnight. */
  check(source: string, limit: number): RateVerdict {
    const t = this.now();
    return this.used(source, utcDay(t)) < limit ? { ok: true } : { ok: false, retryAfterMs: msToUtcMidnight(t) };
  }

  /** Count one call (after `check` said yes) and persist every count of today. */
  count(source: string): void {
    const today = utcDay(this.now());
    this.poisonedDay = undefined; // only reachable on a later day than the corrupt read
    this.counts[source] = { day: today, count: this.used(source, today) + 1 };
    for (const [k, e] of Object.entries(this.counts)) if (e.day < today) delete this.counts[k]; // a future-dated row is today's
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, `${JSON.stringify(this.counts)}\n`, { mode: 0o600 });
    } catch {
      /* the in-memory count still holds for this process */
    }
  }
}

export class RateLimiter {
  private readonly buckets: { w: RateWindow; tokens: number; at: number }[];

  /** `daily`: a calendar-day quota for `source` in a (shared, persisted) `DailyCounter`. */
  constructor(
    windows: readonly RateWindow[],
    private readonly now: () => number = Date.now,
    private readonly daily?: { counter: DailyCounter; source: string; limit: number },
  ) {
    const t = now();
    this.buckets = windows.map((w) => ({ w, tokens: w.limit, at: t }));
  }

  private refill(): void {
    const t = this.now();
    for (const b of this.buckets) {
      const elapsed = Math.max(0, t - b.at);
      b.tokens = Math.min(b.w.limit, b.tokens + (elapsed * b.w.limit) / b.w.perMs);
      b.at = t;
    }
  }

  /** Take one call's worth from every window, or say how long until one is available. */
  take(): RateVerdict {
    this.refill();
    const short = this.buckets.filter((b) => b.tokens < 1);
    const waits = short.map((b) => ((1 - b.tokens) * b.w.perMs) / b.w.limit);
    const day = this.daily?.counter.check(this.daily.source, this.daily.limit);
    if (day && !day.ok) waits.push(day.retryAfterMs);
    if (waits.length) return { ok: false, retryAfterMs: Math.ceil(Math.max(...waits)) };
    for (const b of this.buckets) b.tokens -= 1;
    if (this.daily) this.daily.counter.count(this.daily.source);
    return { ok: true };
  }

  /** The vendor said to wait: empty every bucket so no call goes out for `ms`. */
  pause(ms: number): void {
    this.refill();
    for (const b of this.buckets) b.tokens = Math.min(b.tokens, 1 - (ms * b.w.limit) / b.w.perMs);
  }
}

/** "retry after N s" in words, rounded up. */
export function retryAfterText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.ceil(s / 60);
  return m < 120 ? `${m} min` : `${Math.ceil(m / 60)} h`;
}
