/** [C5] Unit: the client-side token buckets and the key scrubber. */
import { describe, test, expect } from "bun:test";
import { DAY, MINUTE, RateLimiter, retryAfterText } from "../../src/integrations/parts/ratelimit";
import { redact, vendorCall } from "../../src/integrations/parts/http";

describe("rate limiter", () => {
  test("[C5] rate limiter: a per-minute and a per-day window are both enforced, refill over time, and a refused call says how long to wait", () => {
    let t = 0;
    const rl = new RateLimiter([{ limit: 30, perMs: MINUTE }, { limit: 1000, perMs: DAY }], () => t);
    for (let i = 0; i < 30; i++) expect(rl.take()).toEqual({ ok: true });
    const no = rl.take();
    expect(no.ok).toBe(false);
    expect((no as { retryAfterMs: number }).retryAfterMs).toBe(2000); // one token per 2 s
    t += 2000;
    expect(rl.take()).toEqual({ ok: true });
    // The daily window: 1000 calls spread over the day, then a wait measured in minutes.
    const day = new RateLimiter([{ limit: 120, perMs: MINUTE }, { limit: 1000, perMs: DAY }], () => t);
    for (let i = 0; i < 1000; i++) {
      t += 600;
      expect(day.take().ok).toBe(true);
    }
    // The day refilled a few calls' worth while they were spread out; then it is empty.
    let later = day.take();
    for (let i = 0; i < 20 && later.ok; i++) later = day.take();
    expect(later.ok).toBe(false);
    expect(retryAfterText((later as { retryAfterMs: number }).retryAfterMs)).toMatch(/ (s|min)$/);
    const wait = (later as { retryAfterMs: number }).retryAfterMs;
    expect(wait).toBeLessThanOrEqual(86_400); // one daily token takes 86.4 s to come back
    t += wait;
    expect(day.take().ok).toBe(true);
    expect(day.take().ok).toBe(false);
    // A vendor's Retry-After pauses everything.
    const p = new RateLimiter([{ limit: 3000, perMs: 60 * MINUTE }], () => t);
    p.pause(30_000);
    expect(p.take().ok).toBe(false);
    t += 31_000;
    expect(p.take().ok).toBe(true);
  });

  test("[C5] rate limited calls never reach the vendor and come back as 'rate limited, retry after'", async () => {
    let calls = 0;
    const rl = new RateLimiter([{ limit: 1, perMs: MINUTE }], () => 0);
    const deps = { fetch: (async () => (calls++, Response.json({}))) as never, now: () => 0, keys: () => ({}) };
    await vendorCall(deps, rl, "Mouser", [], "http://x.test/", {});
    const e = await vendorCall(deps, rl, "Mouser", [], "http://x.test/", {}).catch((x) => x);
    expect([e.kind, e.message]).toEqual(["rate-limited", "Mouser: rate limited by Anvil's own limit for this source, retry after 60 s"]);
    expect(calls).toBe(1);
  });

  test("[C5] keys are scrubbed from text, raw and URL-encoded", () => {
    expect(redact("GET /x?apiKey=ab%2Bcd%3D&y=ab+cd= failed", ["ab+cd="])).toBe("GET /x?apiKey=•••&y=••• failed");
    expect(redact("short ab", ["ab"])).toBe("short ab"); // too short to be a key; left alone
  });
});
