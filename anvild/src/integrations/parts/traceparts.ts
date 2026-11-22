/**
 * TraceParts API (Phase C5, §4.14 item 36): the one source with STEP models through an API. Built
 * against the documented API (developers.traceparts.com, read 2026-11-19) with hand-written fixtures;
 * no live call has been made. Inactive until the tenant UID, the API key AND the request email are set.
 *
 *   token      POST /v2/RequestToken {tenantUid, apiKey} → {token (JWT), expiryDate (ISO 8601)}
 *   lookup     GET  /v2/Search/PartNumber/Availability?partNumber&catalog → {partFamilyCode,
 *              classificationCode, partNumber, selectionPath} (404: not in that catalog)
 *   formats    GET  /v3/Product/CadDataAvailability?cultureInfo&partFamilyCode&selectionPath
 *              → {cadFormatList:[{cadFormatId, cadFormatName, deliveryMethod}]}
 *   request    POST /v3/Product/cadRequest {userEmail, cultureInfo, cadFormatId, partFamilyCode, …} → int
 *   poll       GET  /v2/Product/cadFileUrl?cadRequestId → 200 the file URL | 204 not ready yet
 *
 * TraceParts finds parts by part number within a manufacturer's catalog, not by keyword, so a search
 * looks up the parts the other sources found (and the query itself when a manufacturer is given).
 * A STEP link in a result is the `cadRequest` URL with its parameters: `parts_fetch` of it makes the
 * request under the configured email, polls for the file and downloads that.
 * Limit: 3000 calls an hour (C0 evidence; not on the pages read).
 */
import { HOUR, MINUTE, RateLimiter } from "./ratelimit";
import { httpsUrl, vendorCall } from "./http";
import { PartSourceError, type ConnectorDeps, type PartResult, type PartSearchOpts, type PartSource } from "./types";

export const TRACEPARTS_BASE_URL = "https://api-gateway.traceparts.com";
export const TRACEPARTS_ATTRIBUTION = "CAD model from TraceParts (traceparts.com)";
const LABEL = "TraceParts";
const TOKEN_MARGIN_MS = 60_000;
/** Part numbers looked up per search (two calls each). */
const LOOKUPS = 3;
const POLL_EVERY_MS = 3_000;
const POLL_FOR_MS = 120_000;
const CULTURE = "en";
const REQUEST_PATH = "/v3/Product/cadRequest";

interface Availability {
  partFamilyCode?: string | null;
  classificationCode?: string | null;
  partNumber?: string | null;
  selectionPath?: string | null;
}

/** The part a model link names (the query string of the `cadRequest` URL). */
type CadTarget = { partFamilyCode?: string; selectionPath?: string; classificationCode?: string; partNumber?: string; cadFormatId: number };

export class TracePartsSource implements PartSource {
  readonly id = "traceparts" as const;
  readonly label = LABEL;
  readonly attribution = TRACEPARTS_ATTRIBUTION;
  private readonly limiter: RateLimiter;
  private token?: { value: string; expiresAt: number; for: string };
  tokenRequests = 0;

  constructor(private readonly deps: ConnectorDeps) {
    this.limiter = new RateLimiter([{ limit: 3000, perMs: HOUR }], deps.now);
  }

  get base(): string {
    return (this.deps.baseUrl ?? TRACEPARTS_BASE_URL).replace(/\/+$/, "");
  }
  private creds(): { tenantUid: string; apiKey: string; email: string } {
    const k = this.deps.keys();
    const tenantUid = k.TRACEPARTS_TENANT_UID?.trim();
    const apiKey = k.TRACEPARTS_API_KEY?.trim();
    const email = k.TRACEPARTS_EMAIL?.trim();
    if (!tenantUid || !apiKey || !email) throw new PartSourceError("not-configured", `${LABEL} is not configured (tenant UID, API key and request email)`);
    return { tenantUid, apiKey, email };
  }
  secrets(): string[] {
    const k = this.deps.keys();
    return [k.TRACEPARTS_TENANT_UID, k.TRACEPARTS_API_KEY, k.TRACEPARTS_EMAIL, this.token?.value].filter((x): x is string => !!x);
  }

  configured(): boolean {
    const k = this.deps.keys();
    return !!k.TRACEPARTS_TENANT_UID?.trim() && !!k.TRACEPARTS_API_KEY?.trim() && !!k.TRACEPARTS_EMAIL?.trim();
  }

  private async bearer(force = false): Promise<string> {
    const { tenantUid, apiKey } = this.creds();
    const key = `${tenantUid}\0${apiKey}`;
    if (!force && this.token && this.token.for === key && this.deps.now() < this.token.expiresAt - TOKEN_MARGIN_MS) return this.token.value;
    this.tokenRequests++;
    const reply = await vendorCall(this.deps, this.limiter, LABEL, this.secrets(), `${this.base}/v2/RequestToken`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ tenantUid, apiKey }),
    });
    const b = reply.body as { token?: unknown; expiryDate?: unknown } | undefined;
    if (typeof b?.token !== "string" || !b.token) throw new PartSourceError("bad-response", `${LABEL}: the token reply had no token`);
    const at = typeof b.expiryDate === "string" ? Date.parse(b.expiryDate) : NaN;
    this.token = { value: b.token, expiresAt: Number.isFinite(at) ? at : this.deps.now() + 30 * MINUTE, for: key };
    return b.token;
  }

  /** An authorized call; a 401 gets one fresh token and one retry. */
  private async call(path: string, init: RequestInit, accept?: (s: number) => boolean): Promise<{ status: number; body: unknown }> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.bearer(attempt > 0);
      const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}`, accept: "application/json" };
      try {
        return await vendorCall(this.deps, this.limiter, LABEL, this.secrets(), `${this.base}${path}`, { ...init, headers }, accept);
      } catch (e) {
        if (attempt === 0 && e instanceof PartSourceError && e.kind === "auth") {
          this.token = undefined;
          continue;
        }
        throw e;
      }
    }
  }

  async search(query: string, opts: PartSearchOpts): Promise<PartResult[]> {
    this.creds();
    const wanted: { manufacturer: string; mpn: string }[] = [];
    if (opts.manufacturer?.trim()) wanted.push({ manufacturer: opts.manufacturer.trim(), mpn: query.trim() });
    for (const c of opts.candidates ?? []) wanted.push(c);
    const seen = new Set<string>();
    const unique = wanted.filter((w) => {
      const k = `${w.manufacturer.toLowerCase()}\0${w.mpn.toLowerCase()}`;
      if (!w.manufacturer || !w.mpn || w.manufacturer === "unknown" || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const out: PartResult[] = [];
    for (const w of unique.slice(0, Math.min(LOOKUPS, Math.max(1, opts.limit)))) {
      const found = await this.call(`/v2/Search/PartNumber/Availability?${new URLSearchParams({ partNumber: w.mpn, catalog: w.manufacturer, removeChar: "true" })}`, { method: "GET" }, (s) => (s >= 200 && s < 300) || s === 404);
      if (found.status === 404 || !found.body || typeof found.body !== "object") continue;
      const a = found.body as Availability;
      const target: Omit<CadTarget, "cadFormatId"> = a.partFamilyCode
        ? { partFamilyCode: a.partFamilyCode, ...(a.selectionPath ? { selectionPath: a.selectionPath } : {}) }
        : a.classificationCode && (a.partNumber || w.mpn)
          ? { classificationCode: a.classificationCode, partNumber: a.partNumber || w.mpn }
          : {};
      if (!Object.keys(target).length) continue;
      const formats = await this.call(`/v3/Product/CadDataAvailability?${new URLSearchParams({ cultureInfo: CULTURE, ...target })}`, { method: "GET" }, (s) => (s >= 200 && s < 300) || s === 404);
      const list = (formats.body as { cadFormatList?: { cadFormatId?: unknown; cadFormatName?: unknown; deliveryMethod?: unknown }[] } | undefined)?.cadFormatList;
      const steps = (Array.isArray(list) ? list : []).filter((f) => typeof f.cadFormatId === "number" && typeof f.cadFormatName === "string" && /step|stp/i.test(f.cadFormatName) && (f.deliveryMethod === undefined || f.deliveryMethod === 1));
      if (!steps.length) continue;
      out.push({
        source: "traceparts",
        manufacturer: w.manufacturer,
        mpn: a.partNumber || w.mpn,
        description: `CAD model on TraceParts (${steps.map((f) => f.cadFormatName as string).join(", ")})`,
        modelUrls: steps.map((f) => ({ format: "STEP", url: this.requestUrl({ ...target, cadFormatId: f.cadFormatId as number }) })),
        attribution: TRACEPARTS_ATTRIBUTION,
      });
    }
    return out;
  }

  private requestUrl(t: CadTarget): string {
    const q = new URLSearchParams();
    for (const k of ["partFamilyCode", "selectionPath", "classificationCode", "partNumber"] as const) if (t[k]) q.set(k, t[k]!);
    q.set("cadFormatId", String(t.cadFormatId));
    return `${this.base}${REQUEST_PATH}?${q}`;
  }

  /** Whether `url` is a model link this source made (a `cadRequest` URL). */
  isModelRequestUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}` === `${this.base}${REQUEST_PATH}`;
    } catch {
      return false;
    }
  }

  /**
   * Ask TraceParts for the file a model link names, under the configured request email, and wait for
   * it. Resolves with the https URL of the file.
   */
  async resolveModel(url: string): Promise<string> {
    const { email } = this.creds();
    const q = new URL(url).searchParams;
    const cadFormatId = Number(q.get("cadFormatId"));
    if (!Number.isInteger(cadFormatId)) throw new PartSourceError("refused", `${LABEL}: that model link has no format`);
    const body: Record<string, unknown> = { userEmail: email, cultureInfo: CULTURE, cadFormatId };
    for (const k of ["partFamilyCode", "selectionPath", "classificationCode", "partNumber"]) if (q.get(k)) body[k] = q.get(k);
    const made = await this.call(REQUEST_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const id = typeof made.body === "number" ? made.body : Number(made.body);
    if (!Number.isInteger(id)) throw new PartSourceError("bad-response", `${LABEL}: the CAD request was not given an id`);
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const until = this.deps.now() + POLL_FOR_MS;
    for (let polls = 1; ; polls++) {
      const r = await this.call(`/v2/Product/cadFileUrl?${new URLSearchParams({ cadRequestId: String(id) })}`, { method: "GET" }, (s) => (s >= 200 && s < 300) || s === 404);
      if (r.status === 404) throw new PartSourceError("http", `${LABEL}: the CAD request ${id} is unknown`);
      if (r.status !== 204) {
        const file = httpsUrl(r.body);
        if (!file) throw new PartSourceError("bad-response", `${LABEL}: the CAD file reply had no URL`);
        return file;
      }
      if (this.deps.now() >= until || polls >= POLL_FOR_MS / POLL_EVERY_MS) throw new PartSourceError("timeout", `${LABEL}: the CAD file was not ready within ${POLL_FOR_MS / 1000} s (request ${id}); try parts_fetch again later`);
      await sleep(POLL_EVERY_MS);
    }
  }

  async test(): Promise<string> {
    this.creds();
    await this.bearer(true);
    return `${LABEL} accepted the tenant UID and API key (a token was issued).`;
  }
}
