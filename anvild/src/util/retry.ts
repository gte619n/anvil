/**
 * [BE-5] Retry an async operation on transient failure with capped exponential backoff + jitter.
 *
 * External API calls (Todoist tagging, the OpenRouter adversarial panel) previously threw on the
 * first non-2xx, so one 429 aborted a whole tag loop and left inconsistent state. Wrapping the call
 * in retryAsync tolerates transient 429/5xx, honors a server `Retry-After`, and unwinds promptly when
 * the run's AbortSignal fires.
 */
export interface RetryOpts {
  /** Max ADDITIONAL attempts after the first (default 3). */
  retries?: number;
  /** Base backoff in ms (default 500); attempt N waits ~base * 2^N. */
  baseDelayMs?: number;
  /** Cap on a single backoff wait (default 15000). */
  maxDelayMs?: number;
  /** Whether an error is worth retrying (e.g. status 429 or >= 500). */
  isRetryable: (err: unknown) => boolean;
  /** A server-provided wait (e.g. from a Retry-After header) that overrides the computed backoff. */
  retryAfterMs?: (err: unknown) => number | undefined;
  /** Abort: when it fires, stop retrying and rethrow. */
  signal?: AbortSignal;
  /** Jitter fraction in [0,1); injectable for deterministic tests (default Math.random). */
  jitter?: () => number;
  /** Sleep primitive; injectable for tests (default an abortable setTimeout). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** Parse a `Retry-After` header (integer seconds; HTTP-date form is ignored → fall back to backoff). */
export function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) ? Math.max(0, secs) * 1000 : undefined;
}

export async function retryAsync<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  const {
    retries = 3,
    baseDelayMs = 500,
    maxDelayMs = 15_000,
    isRetryable,
    retryAfterMs,
    signal,
    jitter = Math.random,
    sleep = defaultSleep,
  } = opts;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || signal?.aborted || !isRetryable(err)) throw err;
      const hinted = retryAfterMs?.(err);
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const wait = hinted ?? backoff + jitter() * backoff * 0.5;
      await sleep(wait, signal);
      attempt++;
    }
  }
}
