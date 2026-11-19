/**
 * One call to a vendor API (Phase C5), with what every connector needs: the client-side rate limit,
 * a timeout, no redirects (a key must never follow one), and errors normalized into a
 * `PartSourceError` whose text has every key scrubbed out.
 */
import { DEFAULT_TIMEOUT_MS, PartSourceError, type ConnectorDeps } from "./types";
import { retryAfterText, type RateLimiter } from "./ratelimit";

/** Replace every secret (and its URL-encoded form) in `text` with a placeholder. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    for (const form of new Set([s, encodeURIComponent(s)])) out = out.split(form).join("•••");
  }
  return out;
}

export interface VendorReply {
  status: number;
  /** Parsed JSON, or the raw text when the body is not JSON; undefined for an empty body. */
  body: unknown;
  headers: Headers;
}

function retryAfterMs(h: Headers): number | undefined {
  const v = h.get("retry-after");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

/**
 * Make the call. `label` names the source in errors; `secrets` are scrubbed from every message.
 * Statuses in `accept` (default: 2xx) resolve; 401/403 are `auth`, 429 is `rate-limited` (and pauses
 * the limiter), anything else is `http`.
 */
export async function vendorCall(
  deps: ConnectorDeps,
  limiter: RateLimiter,
  label: string,
  secrets: readonly (string | undefined)[],
  url: string,
  init: RequestInit,
  accept: (status: number) => boolean = (s) => s >= 200 && s < 300,
): Promise<VendorReply> {
  const slot = limiter.take();
  if (!slot.ok) throw new PartSourceError("rate-limited", `${label}: rate limited by Anvil's own limit for this source, retry after ${retryAfterText(slot.retryAfterMs)}`, slot.retryAfterMs);
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new PartSourceError(timedOut ? "timeout" : "network", timedOut ? `${label}: no answer within ${Math.max(1, Math.round((deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000))} s` : `${label}: could not be reached (${redact(msg, secrets)})`);
  }
  const text = await res.text().catch(() => "");
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (accept(res.status)) return { status: res.status, body, headers: res.headers };
  const snippet = redact(typeof body === "string" ? body : JSON.stringify(body ?? ""), secrets).slice(0, 200);
  if (res.status === 429) {
    const wait = retryAfterMs(res.headers) ?? 60_000;
    limiter.pause(wait);
    throw new PartSourceError("rate-limited", `${label}: rate limited by the vendor, retry after ${retryAfterText(wait)}`, wait);
  }
  if (res.status === 401 || res.status === 403) throw new PartSourceError("auth", `${label}: the key was refused (HTTP ${res.status}); check it in Settings → Models → Part sources`);
  if (res.status >= 300 && res.status < 400) throw new PartSourceError("http", `${label}: unexpected redirect (HTTP ${res.status}); not followed`);
  throw new PartSourceError("http", `${label}: HTTP ${res.status}${snippet ? ` (${snippet})` : ""}`);
}

/** An https URL as given, `//host/…` made https; anything else (http, junk) is dropped. */
export function httpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const t = raw.trim();
  try {
    const u = new URL(t.startsWith("//") ? `https:${t}` : t);
    if (u.protocol === "https:" || u.protocol === "http:") return u.href;
  } catch {
    /* not a URL */
  }
  return undefined;
}

/** A model link's format from its URL or title: STEP, IGES, STL, … or `3D` when it cannot be told. */
export function modelFormat(url: string, title = ""): string {
  const hay = `${url} ${title}`.toLowerCase();
  if (/\.(step|stp)\b|\bstep\b/.test(hay)) return "STEP";
  if (/\.(iges|igs)\b|\biges\b/.test(hay)) return "IGES";
  if (/\.stl\b/.test(hay)) return "STL";
  if (/\.3mf\b/.test(hay)) return "3MF";
  if (/\.zip\b/.test(hay)) return "ZIP";
  return "3D";
}
