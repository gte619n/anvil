/**
 * [C5] Unit: the three part-source connectors against hand-written fixtures on a local server
 * (test/helpers/parts.ts). Token caching and refresh, normalized results, errors, timeouts, rate
 * limits and key scrubbing. No vendor is contacted.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { DigiKeySource, DIGIKEY_ATTRIBUTION } from "../../src/integrations/parts/digikey";
import { MouserSource, MOUSER_ATTRIBUTION } from "../../src/integrations/parts/mouser";
import { TracePartsSource, TRACEPARTS_ATTRIBUTION } from "../../src/integrations/parts/traceparts";
import { PartSourceError, type ConnectorDeps } from "../../src/integrations/parts/types";
import { KEYS, SECRET_VALUES, baseUrls, startVendorFixture, type VendorFixture } from "../helpers/parts";

let fx: VendorFixture;
let clock = 1_000_000;
const now = () => clock;
const deps = (source: "digikey" | "mouser" | "traceparts", keys: Record<string, string | undefined> = KEYS): ConnectorDeps => ({ fetch, now, keys: () => keys, baseUrl: baseUrls(fx)[source], sleep: async () => {} });
const noSecrets = (text: string) => {
  for (const s of SECRET_VALUES) expect(text).not.toContain(s);
};

beforeEach(() => {
  fx = startVendorFixture();
  clock = 1_000_000;
});
afterEach(() => fx.stop());

describe("DigiKey", () => {
  test("[C5] DigiKey: client-credentials token, then keyword search with X-DIGIKEY-Client-Id + Bearer; results are normalized, with model links from product media and attribution", async () => {
    const dk = new DigiKeySource(deps("digikey"));
    expect(dk.configured()).toBe(true);
    const res = await dk.search("LM317", { limit: 5 });
    expect(res).toEqual([
      { source: "digikey", manufacturer: "Texas Instruments", mpn: "LM317T", description: "Linear Voltage Regulator IC Positive Adjustable 1 Output 1.5A TO-220-3", datasheetUrl: fx.opts.datasheetUrl, productUrl: "https://www.digikey.com/en/products/detail/LM317T", stock: 12345, modelUrls: [{ format: "STEP", url: fx.opts.modelUrl }], attribution: DIGIKEY_ATTRIBUTION },
      { source: "digikey", manufacturer: "STMicroelectronics", mpn: "LM317D2T-TR", description: "IC REG LIN POS ADJ 1.5A D2PAK", datasheetUrl: "https://www.st.com/resource/lm317.pdf", productUrl: "https://www.digikey.com/en/products/detail/LM317D2T", stock: 0, attribution: DIGIKEY_ATTRIBUTION },
    ]);
    const search = fx.calls.find((c) => c.path === "/dk/products/v4/search/keyword")!;
    expect(search.clientId).toBe(KEYS.DIGIKEY_CLIENT_ID);
    expect(search.auth).toMatch(/^Bearer dk-bearer-1-/);
    expect(JSON.parse(search.body!)).toEqual({ Keywords: "LM317", Limit: 5, Offset: 0 });
    const token = fx.calls.find((c) => c.path === "/dk/v1/oauth2/token")!;
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({ client_id: KEYS.DIGIKEY_CLIENT_ID, client_secret: KEYS.DIGIKEY_CLIENT_SECRET, grant_type: "client_credentials" });
  });

  test("[C5] DigiKey token caching and refresh: one token for many searches until shortly before expiry, a new one after; a 401 on a search gets one fresh token and one retry", async () => {
    const dk = new DigiKeySource(deps("digikey"));
    await dk.search("a", { limit: 1 });
    await dk.search("b", { limit: 1 });
    expect(fx.tokensIssued.digikey).toBe(1);
    clock += 599_000 - 31_000; // inside the 30 s margin
    await dk.search("c", { limit: 1 });
    expect(fx.tokensIssued.digikey).toBe(1);
    clock += 2_000;
    await dk.search("d", { limit: 1 });
    expect(fx.tokensIssued.digikey).toBe(2);
    fx.opts.dkFail401Once = true;
    expect((await dk.search("e", { limit: 1 })).length).toBe(1);
    expect(fx.tokensIssued.digikey).toBe(3);
    // Changed credentials never reuse the old token.
    const other = { ...KEYS, DIGIKEY_CLIENT_SECRET: "wrong-secret-0000" };
    const dk2 = new DigiKeySource(deps("digikey", other));
    const err = await dk2.search("x", { limit: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(PartSourceError);
    expect(err.kind).toBe("auth");
    noSecrets(err.message);
    expect(err.message).not.toContain("wrong-secret-0000");
  });

  test("[C5] DigiKey errors are normalized and carry no key: a server error, an unreachable host, a timeout, and missing keys", async () => {
    fx.opts.dkSearchStatus = 500;
    const e1 = await new DigiKeySource(deps("digikey")).search("x", { limit: 1 }).catch((e) => e);
    expect([e1.kind, e1.message]).toEqual(["http", expect.stringMatching(/^DigiKey: HTTP 500/)]);
    const e2 = await new DigiKeySource({ ...deps("digikey"), baseUrl: "http://127.0.0.1:9" }).search("x", { limit: 1 }).catch((e) => e);
    expect(e2.kind).toBe("network");
    noSecrets(e2.message);
    fx.opts.hang = true;
    const e3 = await new DigiKeySource({ ...deps("digikey"), timeoutMs: 200 }).search("x", { limit: 1 }).catch((e) => e);
    expect([e3.kind, e3.message]).toEqual(["timeout", "DigiKey: no answer within 1 s"]);
    fx.opts.hang = false;
    const e4 = await new DigiKeySource(deps("digikey", {})).search("x", { limit: 1 }).catch((e) => e);
    expect(e4.kind).toBe("not-configured");
    expect(new DigiKeySource(deps("digikey", { DIGIKEY_CLIENT_ID: "x" })).configured()).toBe(false);
  });

  test("[C5] DigiKey Test makes one token request and says what it proved", async () => {
    expect(await new DigiKeySource(deps("digikey")).test()).toMatch(/accepted the client ID and secret/);
    expect(fx.calls.map((c) => c.path)).toEqual(["/dk/v1/oauth2/token"]);
  });
});

describe("Mouser", () => {
  test("[C5] Mouser: POST /api/v1/search/keyword?apiKey= with SearchByKeywordRequest; results are normalized with attribution and stock from Availability", async () => {
    const m = new MouserSource(deps("mouser"));
    const res = await m.search("LM317", { limit: 3 });
    expect(res).toEqual([{ source: "mouser", manufacturer: "Texas Instruments", mpn: "LM317T", description: "Linear Voltage Regulators (LM317)", datasheetUrl: "https://www.mouser.com/datasheet/2/405/lm317.pdf", productUrl: "https://www.mouser.com/ProductDetail/595-LM317T", stock: 2345, attribution: MOUSER_ATTRIBUTION }]);
    const call = fx.calls.find((c) => c.path === "/mouser/api/v1/search/keyword")!;
    expect(new URLSearchParams(call.query).get("apiKey")).toBe(KEYS.MOUSER_API_KEY);
    expect(JSON.parse(call.body!).SearchByKeywordRequest).toMatchObject({ keyword: "LM317", records: 3, startingRecord: 0 });
  });

  test("[C5] Mouser: an invalid key (reported in the body with HTTP 200) is an auth error; a vendor 429 is 'rate limited, retry after'; the key in the query string never appears in an error", async () => {
    fx.opts.mouserBadKey = true;
    const e1 = await new MouserSource(deps("mouser")).search("x", { limit: 1 }).catch((e) => e);
    expect(e1.kind).toBe("auth");
    noSecrets(e1.message);
    fx.opts.mouserBadKey = false;
    fx.opts.mouserStatus = 429;
    const m = new MouserSource(deps("mouser"));
    const e2 = await m.search("x", { limit: 1 }).catch((e) => e);
    expect([e2.kind, e2.message]).toEqual(["rate-limited", "Mouser: rate limited by the vendor, retry after 42 s"]);
    // …and the client-side limiter now holds further calls without contacting the vendor.
    const calls = fx.calls.length;
    fx.opts.mouserStatus = undefined;
    const e3 = await m.search("x", { limit: 1 }).catch((e) => e);
    expect(e3.message).toMatch(/rate limited by Anvil's own limit for this source, retry after/);
    expect(fx.calls.length).toBe(calls);
    const e4 = await new MouserSource({ ...deps("mouser"), baseUrl: "http://127.0.0.1:9" }).search("x", { limit: 1 }).catch((e) => e);
    noSecrets(e4.message);
  });
});

describe("TraceParts", () => {
  test("[C5] TraceParts is inactive until the tenant UID, the API key AND the request email are all set", () => {
    expect(new TracePartsSource(deps("traceparts")).configured()).toBe(true);
    for (const missing of ["TRACEPARTS_TENANT_UID", "TRACEPARTS_API_KEY", "TRACEPARTS_EMAIL"]) {
      expect([missing, new TracePartsSource(deps("traceparts", { ...KEYS, [missing]: undefined })).configured()]).toEqual([missing, false]);
    }
  });

  test("[C5] TraceParts: RequestToken {tenantUid, apiKey} → JWT; part-number availability per catalog; STEP formats become a cadRequest model link; normalized with attribution", async () => {
    const tp = new TracePartsSource(deps("traceparts"));
    const res = await tp.search("LM317", { limit: 5, candidates: [{ manufacturer: "Texas Instruments", mpn: "LM317T" }, { manufacturer: "Nobody", mpn: "X1" }] });
    expect(res).toEqual([
      {
        source: "traceparts",
        manufacturer: "Texas Instruments",
        mpn: "LM317T",
        description: "CAD model on TraceParts (STEP AP214)",
        modelUrls: [{ format: "STEP", url: `${baseUrls(fx).traceparts}/v3/Product/cadRequest?partFamilyCode=TI-LM317&selectionPath=LM317T%7CTO220&cadFormatId=96` }],
        attribution: TRACEPARTS_ATTRIBUTION,
      },
    ]);
    expect(JSON.parse(fx.calls.find((c) => c.path === "/tp/v2/RequestToken")!.body!)).toEqual({ tenantUid: KEYS.TRACEPARTS_TENANT_UID, apiKey: KEYS.TRACEPARTS_API_KEY });
    expect(fx.calls.filter((c) => c.path !== "/tp/v2/RequestToken").every((c) => c.auth === "Bearer tp-jwt-1-eyJhbGciOi")).toBe(true);
    expect(tp.isModelRequestUrl(res[0]!.modelUrls![0]!.url)).toBe(true);
    expect(tp.isModelRequestUrl("https://files.parts.test/v3/Product/cadRequest?x=1")).toBe(false);
  });

  test("[C5] TraceParts token caching and refresh: reused until a minute before its expiryDate, then renewed; a 401 renews once", async () => {
    fx.opts.tpTokenExpiry = () => new Date(clock + 10 * 60_000).toISOString();
    const tp = new TracePartsSource(deps("traceparts"));
    const cand = { limit: 1, candidates: [{ manufacturer: "Texas Instruments", mpn: "LM317T" }] };
    await tp.search("q", cand);
    await tp.search("q", cand);
    expect(fx.tokensIssued.traceparts).toBe(1);
    clock += 9 * 60_000 + 1;
    await tp.search("q", cand);
    expect(fx.tokensIssued.traceparts).toBe(2);
    expect(await tp.test()).toMatch(/accepted the tenant UID and API key/);
    expect(fx.tokensIssued.traceparts).toBe(3);
  });

  test("[C5] TraceParts model fetch: cadRequest is sent under the configured request email, cadFileUrl is polled through 204s, and the file URL is returned", async () => {
    fx.opts.tpPending = 3;
    const tp = new TracePartsSource(deps("traceparts"));
    const [r] = await tp.search("q", { limit: 1, candidates: [{ manufacturer: "Texas Instruments", mpn: "LM317T" }] });
    const file = await tp.resolveModel(r!.modelUrls![0]!.url);
    expect(file).toBe(fx.opts.fileUrl);
    expect(JSON.parse(fx.calls.find((c) => c.path === "/tp/v3/Product/cadRequest")!.body!)).toEqual({ userEmail: KEYS.TRACEPARTS_EMAIL, cultureInfo: "en", cadFormatId: 96, partFamilyCode: "TI-LM317", selectionPath: "LM317T|TO220" });
    expect(fx.calls.filter((c) => c.path === "/tp/v2/Product/cadFileUrl").length).toBe(4);
    // Never ready: it gives up with a clear message instead of polling forever.
    fx.opts.tpPending = 10_000;
    const e = await tp.resolveModel(r!.modelUrls![0]!.url).catch((x) => x);
    expect([e.kind, e.message]).toEqual(["timeout", expect.stringMatching(/not ready within 120 s \(request 4711\)/)]);
  });
});
