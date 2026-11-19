/**
 * Mouser Search API v1 (Phase C5): `POST /api/v1/search/keyword?apiKey=<key>` with
 * `{SearchByKeywordRequest:{keyword, records, startingRecord}}` (C0 evidence). Datasheets and product
 * pages only; Mouser has no model files. The key travels in the query string, so it is scrubbed from
 * every error. Limits: 30/min, 1000/day (unverified on a primary page; enforced client-side anyway).
 * Terms: no caching or storing of content; attribution.
 *
 * The request and reply shapes are from the C0 research table, NOT read on Mouser's own docs (its
 * Swagger page is script-rendered); the fixtures in the tests are hand-written to that shape.
 */
import { DAY, MINUTE, RateLimiter } from "./ratelimit";
import { httpsUrl, vendorCall } from "./http";
import { PartSourceError, type ConnectorDeps, type PartResult, type PartSearchOpts, type PartSource } from "./types";

export const MOUSER_BASE_URL = "https://api.mouser.com";
export const MOUSER_ATTRIBUTION = "Data from Mouser Electronics (mouser.com)";
const LABEL = "Mouser";

interface MouserPart {
  Manufacturer?: string;
  ManufacturerPartNumber?: string;
  Description?: string;
  DataSheetUrl?: string;
  ProductDetailUrl?: string;
  Availability?: string;
  AvailabilityInStock?: string | number;
}
interface MouserReply {
  Errors?: { Code?: string; Message?: string; PropertyName?: string }[];
  SearchResults?: { NumberOfResult?: number; Parts?: MouserPart[] };
}

function stockOf(p: MouserPart): number | undefined {
  const raw = p.AvailabilityInStock ?? /^([\d,]+)\s+In Stock/i.exec(p.Availability ?? "")?.[1];
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/,/g, ""));
  return raw !== undefined && Number.isFinite(n) ? n : undefined;
}

export class MouserSource implements PartSource {
  readonly id = "mouser" as const;
  readonly label = LABEL;
  readonly attribution = MOUSER_ATTRIBUTION;
  private readonly limiter: RateLimiter;

  constructor(private readonly deps: ConnectorDeps) {
    this.limiter = new RateLimiter([{ limit: 30, perMs: MINUTE }, { limit: 1000, perMs: DAY }], deps.now);
  }

  configured(): boolean {
    return !!this.deps.keys().MOUSER_API_KEY?.trim();
  }

  private async keyword(keyword: string, records: number): Promise<MouserReply> {
    const key = this.deps.keys().MOUSER_API_KEY?.trim();
    if (!key) throw new PartSourceError("not-configured", `${LABEL} is not configured (Search API key)`);
    const base = (this.deps.baseUrl ?? MOUSER_BASE_URL).replace(/\/+$/, "");
    const reply = await vendorCall(this.deps, this.limiter, LABEL, [key], `${base}/api/v1/search/keyword?apiKey=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ SearchByKeywordRequest: { keyword: keyword.slice(0, 250), records, startingRecord: 0, searchOptions: "", searchWithYourSignUpLanguage: "" } }),
    });
    const body = reply.body as MouserReply | undefined;
    if (!body || typeof body !== "object") throw new PartSourceError("bad-response", `${LABEL}: the search reply was not understood`);
    const errors = Array.isArray(body.Errors) ? body.Errors : [];
    if (errors.length) {
      const text = errors.map((e) => [e.PropertyName, e.Message].filter(Boolean).join(": ")).join("; ").split(key).join("•••");
      // An invalid key is reported in the body with HTTP 200.
      if (/api ?key|unique identifier|unauthori[sz]ed|invalid key/i.test(text)) throw new PartSourceError("auth", `${LABEL}: the key was refused (${text.slice(0, 160)}); check it in Settings → Models → Part sources`);
      throw new PartSourceError("http", `${LABEL}: ${text.slice(0, 200)}`);
    }
    return body;
  }

  async search(query: string, opts: PartSearchOpts): Promise<PartResult[]> {
    const limit = Math.max(1, Math.min(50, opts.limit));
    const body = await this.keyword(query, limit);
    const parts = body.SearchResults?.Parts;
    if (parts !== undefined && !Array.isArray(parts)) throw new PartSourceError("bad-response", `${LABEL}: the search reply was not understood`);
    const out: PartResult[] = [];
    for (const p of (parts ?? []).slice(0, limit)) {
      const mpn = p.ManufacturerPartNumber?.trim();
      if (!mpn) continue;
      const stock = stockOf(p);
      out.push({
        source: "mouser",
        manufacturer: p.Manufacturer?.trim() || "unknown",
        mpn,
        description: (p.Description ?? "").trim(),
        ...(httpsUrl(p.DataSheetUrl) ? { datasheetUrl: httpsUrl(p.DataSheetUrl) } : {}),
        ...(httpsUrl(p.ProductDetailUrl) ? { productUrl: httpsUrl(p.ProductDetailUrl) } : {}),
        ...(stock !== undefined ? { stock } : {}),
        attribution: MOUSER_ATTRIBUTION,
      });
    }
    return out;
  }

  async test(): Promise<string> {
    await this.keyword("resistor", 1);
    return `${LABEL} accepted the Search API key (a one-result search answered).`;
  }
}
