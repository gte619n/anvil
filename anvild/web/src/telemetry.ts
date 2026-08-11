// ── Resilience telemetry (incremental-offline-resilience.md §5.7, Phase 6) ────────────────────────
// Lightweight counters that measure how the client behaves on flaky links: how often it reconnects,
// whether a resume was an incremental delta or a full snapshot, and how the offline outbox drains.
// They gate the automated acceptance checks (e.g. "cold reload → delta, not snapshot") and surface in
// a debug panel. Kept in-memory + mirrored to localStorage so a reload doesn't zero the history; the
// daemon-synced aggregation (spec D11) rides on top via reportSink.

export interface TelemetryCounters {
  reconnects: number; // disconnected → connected transitions
  resumeDelta: number; // attaches served by an incremental delta (seq > lastSeq)
  resumeSnapshot: number; // attaches that needed a full conversation.snapshot
  flushOk: number; // outbox items acknowledged by the server
  flushFail: number; // outbox items that errored (command.error) on flush
  sendDuplicates: number; // optimistic bubbles retired by a matching authoritative message (should stay 0-ish)
  offlineReloads: number; // cold opens painted from cache with no server reachable
}

export type TelemetryKey = keyof TelemetryCounters;

const ZERO: TelemetryCounters = {
  reconnects: 0,
  resumeDelta: 0,
  resumeSnapshot: 0,
  flushOk: 0,
  flushFail: 0,
  sendDuplicates: 0,
  offlineReloads: 0,
};

const STORAGE_KEY = "anvil.telemetry";

function load(): TelemetryCounters {
  try {
    return { ...ZERO, ...(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<TelemetryCounters>) };
  } catch {
    return { ...ZERO };
  }
}

class Telemetry {
  private counters = load();
  /** ms from the last (re)connect attempt to the first frame — time-to-interactive proxy. */
  timeToInteractiveMs = 0;
  /** ms the last watermark verify took (connect → resume.watermarks). */
  verifyMs = 0;
  private reportSink: ((c: TelemetryCounters) => void) | undefined;
  private listeners = new Set<(c: TelemetryCounters) => void>();

  /** Bump a counter and persist. `n` defaults to 1. */
  mark(key: TelemetryKey, n = 1): void {
    this.counters[key] += n;
    this.persist();
  }
  set(key: TelemetryKey, value: number): void {
    this.counters[key] = value;
    this.persist();
  }
  snapshot(): TelemetryCounters {
    return { ...this.counters };
  }
  /** Reset all counters (used by the fault harness between scenarios). */
  reset(): void {
    this.counters = { ...ZERO };
    this.persist();
  }
  /** Register the daemon-sync sink (spec D11) — called with the latest counters after each change. */
  onReport(sink: (c: TelemetryCounters) => void): void {
    this.reportSink = sink;
  }
  /** Subscribe a UI listener (debug panel) to counter changes. */
  subscribe(fn: (c: TelemetryCounters) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.counters));
    } catch {
      /* quota — in-memory counters stay authoritative */
    }
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
    this.reportSink?.(snap);
  }
}

export const telemetry = new Telemetry();

// Expose for the fault harness + manual debugging (asserting "delta not snapshot", etc.).
if (typeof window !== "undefined") (window as unknown as { __anvilTelemetry?: Telemetry }).__anvilTelemetry = telemetry;
