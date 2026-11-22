/**
 * DigiKey Product Information v4 (Phase C5). OAuth2 client credentials
 * (`POST /v1/oauth2/token`, a token of about 10 minutes, cached until shortly before it expires and
 * refreshed once on a 401), keyword search (`POST /products/v4/search/keyword`) and, for model links,
 * product media (`GET /products/v4/search/{pn}/media`). Headers per the C0 evidence:
 * `X-DIGIKEY-Client-Id` + `Authorization: Bearer`. Terms: no database building or bulk download;
 * attribution. Limits: 120/min, 1000/day (client-side, `RateLimiter`).
 */
import { DailyCounter, MINUTE, RateLimiter } from "./ratelimit";
import { httpsUrl, modelFormat, vendorCall } from "./http";
import { PartSourceError, type ConnectorDeps, type PartModelLink, type PartResult, type PartSearchOpts, type PartSource } from "./types";

export const DIGIKEY_BASE_URL = "https://api.digikey.com";
export const DIGIKEY_ATTRIBUTION = "Data from DigiKey (digikey.com)";
const LABEL = "DigiKey";
/** How long before the vendor's expiry a cached token is replaced. */
const TOKEN_MARGIN_MS = 30_000;
/** At most this many results get a media call (each costs one call of the daily 1000). */
const MEDIA_LOOKUPS = 5;

interface DkProduct {
  Manufacturer?: { Name?: string };
  ManufacturerProductNumber?: string;
  Description?: { ProductDescription?: string; DetailedDescription?: string };
  DatasheetUrl?: string;
  ProductUrl?: string;
  QuantityAvailable?: number;
}

export class DigiKeySource implements PartSource {
  readonly id = "digikey" as const;
  readonly label = LABEL;
  readonly attribution = DIGIKEY_ATTRIBUTION;
  private readonly limiter: RateLimiter;
  /** The token endpoint is not a product call and does not count against the product limits. */
  private readonly tokenLimiter: RateLimiter;
  private token?: { value: string; expiresAt: number; for: string };
  /** Token requests made (tests read it to prove the cache). */
  tokenRequests = 0;

  constructor(private readonly deps: ConnectorDeps) {
    this.limiter = new RateLimiter([{ limit: 120, perMs: MINUTE }], deps.now, { counter: deps.daily ?? new DailyCounter(undefined, deps.now), source: "digikey", limit: 1000 });
    this.tokenLimiter = new RateLimiter([{ limit: 30, perMs: MINUTE }], deps.now);
  }

  private get base(): string {
    return (this.deps.baseUrl ?? DIGIKEY_BASE_URL).replace(/\/+$/, "");
  }
  private creds(): { id: string; secret: string } {
    const k = this.deps.keys();
    const id = k.DIGIKEY_CLIENT_ID?.trim();
    const secret = k.DIGIKEY_CLIENT_SECRET?.trim();
    if (!id || !secret) throw new PartSourceError("not-configured", `${LABEL} is not configured (client ID and secret)`);
    return { id, secret };
  }
  secrets(): string[] {
    const k = this.deps.keys();
    return [k.DIGIKEY_CLIENT_ID, k.DIGIKEY_CLIENT_SECRET, this.token?.value].filter((x): x is string => !!x);
  }

  configured(): boolean {
    const k = this.deps.keys();
    return !!k.DIGIKEY_CLIENT_ID?.trim() && !!k.DIGIKEY_CLIENT_SECRET?.trim();
  }

  /** A bearer token: the cached one while it is good for these credentials, else a new one. */
  private async bearer(force = false): Promise<string> {
    const { id, secret } = this.creds();
    const key = `${id}\0${secret}`;
    if (!force && this.token && this.token.for === key && this.deps.now() < this.token.expiresAt - TOKEN_MARGIN_MS) return this.token.value;
    this.tokenRequests++;
    const body = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" });
    const reply = await vendorCall(this.deps, this.tokenLimiter, LABEL, [id, secret], `${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    const b = reply.body as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (typeof b?.access_token !== "string" || !b.access_token) throw new PartSourceError("bad-response", `${LABEL}: the token reply had no access_token`);
    const ttl = typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in * 1000 : 10 * MINUTE;
    this.token = { value: b.access_token, expiresAt: this.deps.now() + ttl, for: key };
    return b.access_token;
  }

  /** A product call with the bearer; a 401 gets one fresh token and one retry. */
  private async call(path: string, init: RequestInit): Promise<unknown> {
    const { id } = this.creds();
    for (let attempt = 0; ; attempt++) {
      const token = await this.bearer(attempt > 0);
      const headers = {
        ...(init.headers as Record<string, string> | undefined),
        "X-DIGIKEY-Client-Id": id,
        Authorization: `Bearer ${token}`,
        "X-DIGIKEY-Locale-Site": "US",
        "X-DIGIKEY-Locale-Language": "en",
        "X-DIGIKEY-Locale-Currency": "USD",
        accept: "application/json",
      };
      try {
        return (await vendorCall(this.deps, this.limiter, LABEL, this.secrets(), `${this.base}${path}`, { ...init, headers })).body;
      } catch (e) {
        if (attempt === 0 && e instanceof PartSourceError && e.kind === "auth") {
          this.token = undefined; // expired early, or revoked: one new token, one retry
          continue;
        }
        throw e;
      }
    }
  }

  async search(query: string, opts: PartSearchOpts): Promise<PartResult[]> {
    const limit = Math.max(1, Math.min(50, opts.limit));
    const body = (await this.call("/products/v4/search/keyword", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Keywords: query.slice(0, 250), Limit: limit, Offset: 0 }),
    })) as { Products?: DkProduct[] } | undefined;
    if (!body || typeof body !== "object" || (body.Products !== undefined && !Array.isArray(body.Products))) throw new PartSourceError("bad-response", `${LABEL}: the search reply was not understood`);
    const results: PartResult[] = [];
    for (const p of (body.Products ?? []).slice(0, limit)) {
      const mpn = p.ManufacturerProductNumber?.trim();
      if (!mpn) continue;
      results.push({
        source: "digikey",
        manufacturer: p.Manufacturer?.Name?.trim() || "unknown",
        mpn,
        description: (p.Description?.DetailedDescription || p.Description?.ProductDescription || "").trim(),
        ...(httpsUrl(p.DatasheetUrl) ? { datasheetUrl: httpsUrl(p.DatasheetUrl) } : {}),
        ...(httpsUrl(p.ProductUrl) ? { productUrl: httpsUrl(p.ProductUrl) } : {}),
        ...(typeof p.QuantityAvailable === "number" ? { stock: p.QuantityAvailable } : {}),
        attribution: DIGIKEY_ATTRIBUTION,
      });
    }
    // Model links, where the product media has them. A media call that fails costs the result nothing.
    for (const r of results.slice(0, MEDIA_LOOKUPS)) {
      try {
        const media = (await this.call(`/products/v4/search/${encodeURIComponent(r.mpn)}/media`, { method: "GET" })) as { MediaLinks?: { MediaType?: string; Title?: string; Url?: string }[] } | undefined;
        const models: PartModelLink[] = [];
        for (const m of media?.MediaLinks ?? []) {
          const url = httpsUrl(m.Url);
          if (!url || !/3d|cad|model|step/i.test(`${m.MediaType ?? ""} ${m.Title ?? ""}`)) continue;
          models.push({ format: modelFormat(url, `${m.MediaType ?? ""} ${m.Title ?? ""}`), url });
        }
        if (models.length) r.modelUrls = models;
      } catch (e) {
        if (e instanceof PartSourceError && e.kind === "rate-limited") break;
      }
    }
    return results;
  }

  async test(): Promise<string> {
    await this.bearer(true);
    return `${LABEL} accepted the client ID and secret (a token was issued).`;
  }
}
