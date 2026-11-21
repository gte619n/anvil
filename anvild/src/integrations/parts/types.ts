/**
 * Part sources (agent-cad-and-browser §4.12 "Part sources", §4.14 items 35–36, Phase C5): the vendor
 * APIs behind `parts_search` / `parts_fetch`. Every connector returns the same normalized result and
 * reports failures as a `PartSourceError` whose message never contains a key.
 */
import type { PartSourceId } from "@protocol";
import type { DailyCounter } from "./ratelimit";

export type { PartSourceId };

export interface PartModelLink {
  /** `STEP`, `IGES`, `3D` (a vendor media link of unknown format), … */
  format: string;
  url: string;
}

/** One part, normalized across sources. */
export interface PartResult {
  source: PartSourceId;
  manufacturer: string;
  mpn: string;
  description: string;
  datasheetUrl?: string;
  modelUrls?: PartModelLink[];
  productUrl?: string;
  stock?: number;
  /** Shown with the result, always (the vendors' terms ask for it). */
  attribution: string;
}

export interface PartSearchOpts {
  limit: number;
  /** A manufacturer name the query's part number belongs to (TraceParts looks part numbers up per
   *  manufacturer catalog). */
  manufacturer?: string;
  /** Parts other sources found in the same search (TraceParts checks those for CAD models). */
  candidates?: readonly { manufacturer: string; mpn: string }[];
}

export type PartSourceErrorKind = "not-configured" | "auth" | "rate-limited" | "timeout" | "network" | "http" | "bad-response" | "refused";

export class PartSourceError extends Error {
  constructor(
    readonly kind: PartSourceErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PartSourceError";
  }
}

export interface PartSource {
  id: PartSourceId;
  label: string;
  attribution: string;
  /** Every key field it needs is set. */
  configured(): boolean;
  search(query: string, opts: PartSearchOpts): Promise<PartResult[]>;
  /** One cheap authenticated call (Settings' "Test" button). Resolves with what it proved. */
  test(): Promise<string>;
  /** Every credential it holds right now — its keys and any access token it was issued — for scrubbing. */
  secrets(): string[];
}

/** What every connector is built with. `fetch` and `now` are the test seams. */
export interface ConnectorDeps {
  fetch: typeof fetch;
  now: () => number;
  /** The source's key fields, read at use time (env-file name → value). */
  keys: () => Readonly<Record<string, string | undefined>>;
  /** Override the vendor's base URL (tests point it at a local fixture server). */
  baseUrl?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Sleep between TraceParts polls (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** The persisted calendar-day counts the daily quotas use (in memory only when absent). */
  daily?: DailyCounter;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
