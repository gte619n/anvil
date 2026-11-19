/**
 * Client-side rate limiting for the part sources (Phase C5): one token bucket per window, all of
 * which must have a token for a call to go out. Kept under the vendors' published limits (C0
 * evidence: DigiKey 120/min + 1000/day, Mouser 30/min + 1000/day, TraceParts 3000/hour) so this
 * daemon never earns a 429 or a suspended key.
 */
export interface RateWindow {
  limit: number;
  perMs: number;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type RateVerdict = { ok: true } | { ok: false; retryAfterMs: number };

export class RateLimiter {
  private readonly buckets: { w: RateWindow; tokens: number; at: number }[];

  constructor(
    windows: readonly RateWindow[],
    private readonly now: () => number = Date.now,
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
    if (short.length) {
      const wait = Math.max(...short.map((b) => ((1 - b.tokens) * b.w.perMs) / b.w.limit));
      return { ok: false, retryAfterMs: Math.ceil(wait) };
    }
    for (const b of this.buckets) b.tokens -= 1;
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
