/** [C5] Unit: the client-side token buckets and the key scrubber. */
import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY, DailyCounter, MINUTE, RateLimiter, msToUtcMidnight, retryAfterText } from "../../src/integrations/parts/ratelimit";
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

describe("daily quota (UTC calendar day, persisted)", () => {
  const withDir = (fn: (file: string) => void): void => {
    const d = mkdtempSync(join(tmpdir(), "anvil-c5-daily-"));
    try {
      fn(join(d, "parts-ratelimit.json"));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  const limiter = (file: string, now: () => number, limit = 3) => new RateLimiter([{ limit: 120, perMs: MINUTE }], now, { counter: new DailyCounter(file, now), source: "mouser", limit });

  test("[C5] daily quota: N calls use up the UTC day, a new limiter over the same file (a restart) still refuses, the refusal waits until UTC midnight, and the next UTC day allows again", () => {
    withDir((file) => {
      let t = Date.UTC(2026, 10, 19, 22, 0, 0);
      const now = () => t;
      const a = limiter(file, now);
      for (let i = 0; i < 3; i++) {
        t += 1000;
        expect(a.take()).toEqual({ ok: true });
      }
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mouser: { day: "2026-11-19", count: 3 } });
      expect(a.take().ok).toBe(false);
      // The restart: fresh buckets, the same file.
      const b = limiter(file, now);
      const no = b.take();
      expect(no).toEqual({ ok: false, retryAfterMs: msToUtcMidnight(t) });
      expect(msToUtcMidnight(t)).toBe(2 * 3600_000 - 3000);
      expect(retryAfterText((no as { retryAfterMs: number }).retryAfterMs)).toBe("2 h");
      // Another source in the same file is counted on its own.
      const other = new RateLimiter([], now, { counter: new DailyCounter(file, now), source: "digikey", limit: 3 });
      expect(other.take()).toEqual({ ok: true });
      // Across UTC midnight: a new day.
      t = Date.UTC(2026, 10, 20, 0, 0, 1);
      expect(b.take()).toEqual({ ok: true });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mouser: { day: "2026-11-20", count: 1 } });
      expect(limiter(file, now).take()).toEqual({ ok: true });
    });
  });

  test("[C5] daily quota: a refused short window does not count against the day, and the vendor's pause leaves the day alone", () => {
    withDir((file) => {
      let t = Date.UTC(2026, 10, 19, 12);
      const now = () => t;
      const rl = new RateLimiter([{ limit: 1, perMs: MINUTE }], now, { counter: new DailyCounter(file, now), source: "mouser", limit: 5 });
      expect(rl.take().ok).toBe(true);
      expect(rl.take().ok).toBe(false); // the minute bucket refused it
      expect(JSON.parse(readFileSync(file, "utf8")).mouser.count).toBe(1);
      rl.pause(10_000);
      t += 70_000;
      expect(rl.take().ok).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8")).mouser.count).toBe(2);
    });
  });

  test("[C5] daily quota: a corrupt or wrong-shaped file fails closed for the rest of that UTC day, then the next day rewrites it; a missing file is a fresh day", () => {
    for (const bad of ["{not json", "[]", JSON.stringify({ mouser: { day: "yesterday", count: 1 } }), JSON.stringify({ mouser: { day: "2026-11-19", count: -1 } }), JSON.stringify({ digikey: { day: "2026-11-19", count: "0" } })]) {
      withDir((file) => {
        writeFileSync(file, bad);
        let t = Date.UTC(2026, 10, 19, 8);
        const now = () => t;
        const rl = limiter(file, now);
        expect([bad, rl.take()]).toEqual([bad, { ok: false, retryAfterMs: msToUtcMidnight(t) }]);
        expect(readFileSync(file, "utf8")).toBe(bad); // left for inspection until it is replaced
        t = Date.UTC(2026, 10, 20, 0, 0, 0);
        expect(rl.take()).toEqual({ ok: true });
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mouser: { day: "2026-11-20", count: 1 } });
      });
    }
    withDir((file) => {
      expect(existsSync(file)).toBe(false);
      expect(limiter(file, () => Date.UTC(2026, 10, 19)).take()).toEqual({ ok: true });
    });
  });
});
