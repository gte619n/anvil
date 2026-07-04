/**
 * [BE-5] External API calls (Todoist tagging, OpenRouter panel) threw immediately on any non-2xx,
 * so a single 429 aborted an autopilot tag loop mid-way — leaving some tasks tagged and others not.
 * retryAsync retries transient failures with capped backoff + jitter, honoring a server Retry-After,
 * and unwinds promptly on abort.
 */
import { test, expect } from "bun:test";
import { retryAsync } from "../../src/util/retry";

const fast = { baseDelayMs: 1, maxDelayMs: 4, jitter: () => 0 }; // deterministic + quick

test("succeeds after transient retryable failures", async () => {
  let calls = 0;
  const out = await retryAsync(
    async () => {
      calls++;
      if (calls < 3) throw new Error("boom");
      return "ok";
    },
    { ...fast, retries: 3, isRetryable: () => true },
  );
  expect(out).toBe("ok");
  expect(calls).toBe(3);
});

test("does not retry a non-retryable error", async () => {
  let calls = 0;
  await expect(
    retryAsync(
      async () => {
        calls++;
        throw new Error("fatal");
      },
      { ...fast, retries: 5, isRetryable: () => false },
    ),
  ).rejects.toThrow("fatal");
  expect(calls).toBe(1);
});

test("throws the last error after exhausting retries", async () => {
  let calls = 0;
  await expect(
    retryAsync(
      async () => {
        calls++;
        throw new Error(`fail-${calls}`);
      },
      { ...fast, retries: 2, isRetryable: () => true },
    ),
  ).rejects.toThrow("fail-3"); // 1 initial + 2 retries
  expect(calls).toBe(3);
});

test("stops retrying once the signal is aborted", async () => {
  const ac = new AbortController();
  let calls = 0;
  await expect(
    retryAsync(
      async () => {
        calls++;
        ac.abort();
        throw new Error("boom");
      },
      { ...fast, retries: 5, isRetryable: () => true, signal: ac.signal },
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1); // aborted before the second attempt
});

test("honors a Retry-After hint over the computed backoff", async () => {
  const seen: number[] = [];
  let calls = 0;
  await retryAsync(
    async () => {
      calls++;
      if (calls < 2) throw new Error("429");
      return "ok";
    },
    {
      retries: 2,
      isRetryable: () => true,
      retryAfterMs: () => 3,
      sleep: async (ms: number) => {
        seen.push(ms);
      },
    },
  );
  expect(seen).toEqual([3]); // used the hint, not the default backoff
});
