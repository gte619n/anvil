/**
 * Hand-written vendor fixtures for the part-source tests (Phase C5): one local HTTP server answering
 * the DigiKey, Mouser and TraceParts endpoints in the shapes their documentation gives (TraceParts and
 * DigiKey read on their reference pages 2026-11-19; Mouser from the C0 research table), and a local
 * HTTPS file server with a throwaway self-signed certificate for parts_fetch. No vendor is contacted.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const KEYS = {
  DIGIKEY_CLIENT_ID: "dk-client-id-1234567890",
  DIGIKEY_CLIENT_SECRET: "dk-secret-ABCDEFGHIJ",
  MOUSER_API_KEY: "mouser-key-0000-1111-2222-333344445555",
  TRACEPARTS_TENANT_UID: "0f6c1d2e-3a4b-5c6d-7e8f-9a0b1c2d3e4f",
  TRACEPARTS_API_KEY: "tp-api-key-ZYXWVUTSRQ",
  TRACEPARTS_EMAIL: "owner@example.test",
};
export const SECRET_VALUES = Object.values(KEYS);

export interface VendorFixture {
  url: string;
  port: number;
  calls: { path: string; method: string; auth?: string | null; clientId?: string | null; body?: string; query: string }[];
  /** Behaviour switches the tests flip. */
  opts: {
    dkTokenTtl: number;
    dkFail401Once: boolean;
    dkSearchStatus?: number;
    mouserBadKey: boolean;
    mouserStatus?: number;
    tpTokenExpiry: () => string;
    tpPending: number; // 204s before the file URL
    fileUrl: string; // what cadFileUrl answers
    datasheetUrl: string;
    modelUrl: string;
    hang?: boolean;
  };
  tokensIssued: { digikey: number; traceparts: number };
  stop(): void;
}

export function startVendorFixture(): VendorFixture {
  const f: VendorFixture = {
    url: "",
    port: 0,
    calls: [],
    opts: { dkTokenTtl: 599, dkFail401Once: false, mouserBadKey: false, tpTokenExpiry: () => new Date(Date.now() + 3600_000).toISOString(), tpPending: 1, fileUrl: "https://files.parts.test/cad/bracket.step", datasheetUrl: "https://files.parts.test/ds/lm317.pdf", modelUrl: "https://files.parts.test/models/lm317.step" },
    tokensIssued: { digikey: 0, traceparts: 0 },
    stop: () => {},
  };
  let dkToken = "";
  let tpToken = "";
  let pending = 0;
  const srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : undefined;
      f.calls.push({ path: u.pathname, method: req.method, auth: req.headers.get("authorization"), clientId: req.headers.get("x-digikey-client-id"), body, query: u.search });
      if (f.opts.hang) await new Promise((r) => setTimeout(r, 5000));
      // ── DigiKey ──
      if (u.pathname === "/dk/v1/oauth2/token") {
        const p = new URLSearchParams(body);
        if (p.get("client_id") !== KEYS.DIGIKEY_CLIENT_ID || p.get("client_secret") !== KEYS.DIGIKEY_CLIENT_SECRET || p.get("grant_type") !== "client_credentials") return Response.json({ error: "invalid_client" }, { status: 401 });
        f.tokensIssued.digikey++;
        dkToken = `dk-bearer-${f.tokensIssued.digikey}-xyzxyzxyz`;
        return Response.json({ access_token: dkToken, expires_in: f.opts.dkTokenTtl, token_type: "Bearer" });
      }
      if (u.pathname.startsWith("/dk/products/v4/")) {
        if (req.headers.get("x-digikey-client-id") !== KEYS.DIGIKEY_CLIENT_ID || req.headers.get("authorization") !== `Bearer ${dkToken}`) return Response.json({ title: "Unauthorized", status: 401, detail: "Token is expired or Client Id or subscription are invalid." }, { status: 401 });
        if (f.opts.dkFail401Once) {
          f.opts.dkFail401Once = false;
          return Response.json({ title: "Unauthorized", status: 401 }, { status: 401 });
        }
        if (f.opts.dkSearchStatus) return Response.json({ title: "Server error", status: f.opts.dkSearchStatus }, { status: f.opts.dkSearchStatus });
        if (u.pathname === "/dk/products/v4/search/keyword") {
          return Response.json({
            ProductsCount: 2,
            Products: [
              { Manufacturer: { Id: 1, Name: "Texas Instruments" }, ManufacturerProductNumber: "LM317T", Description: { ProductDescription: "IC REG LIN POS ADJ 1.5A TO220-3", DetailedDescription: "Linear Voltage Regulator IC Positive Adjustable 1 Output 1.5A TO-220-3" }, DatasheetUrl: f.opts.datasheetUrl, ProductUrl: "https://www.digikey.com/en/products/detail/LM317T", QuantityAvailable: 12345, UnitPrice: 0.9 },
              { Manufacturer: { Name: "STMicroelectronics" }, ManufacturerProductNumber: "LM317D2T-TR", Description: { ProductDescription: "IC REG LIN POS ADJ 1.5A D2PAK" }, DatasheetUrl: "//www.st.com/resource/lm317.pdf", ProductUrl: "https://www.digikey.com/en/products/detail/LM317D2T", QuantityAvailable: 0 },
            ],
          });
        }
        const media = /^\/dk\/products\/v4\/search\/([^/]+)\/media$/.exec(u.pathname);
        if (media) {
          return Response.json({ MediaLinks: decodeURIComponent(media[1]!) === "LM317T" ? [{ MediaType: "Product Photos", Title: "TO-220", Url: "https://mm.digikey.com/photo.jpg" }, { MediaType: "3D Models", Title: "LM317T STEP", Url: f.opts.modelUrl }] : [] });
        }
      }
      // ── Mouser ──
      if (u.pathname === "/mouser/api/v1/search/keyword") {
        if (f.opts.mouserStatus) return new Response("busy", { status: f.opts.mouserStatus, headers: f.opts.mouserStatus === 429 ? { "retry-after": "42" } : {} });
        if (f.opts.mouserBadKey || u.searchParams.get("apiKey") !== KEYS.MOUSER_API_KEY) return Response.json({ Errors: [{ Id: 0, Code: "Invalid", Message: "Invalid unique identifier.", PropertyName: "API Key" }], SearchResults: null });
        const kw = JSON.parse(body ?? "{}").SearchByKeywordRequest?.keyword;
        return Response.json({
          Errors: [],
          SearchResults: {
            NumberOfResult: 1,
            Parts: [{ Manufacturer: "Texas Instruments", ManufacturerPartNumber: "LM317T", Description: `Linear Voltage Regulators (${kw})`, DataSheetUrl: "https://www.mouser.com/datasheet/2/405/lm317.pdf", ProductDetailUrl: "https://www.mouser.com/ProductDetail/595-LM317T", Availability: "2,345 In Stock", AvailabilityInStock: "2345", MouserPartNumber: "595-LM317T" }],
          },
        });
      }
      // ── TraceParts ──
      if (u.pathname === "/tp/v2/RequestToken") {
        const b = JSON.parse(body ?? "{}");
        if (b.tenantUid !== KEYS.TRACEPARTS_TENANT_UID || b.apiKey !== KEYS.TRACEPARTS_API_KEY) return Response.json("Invalid credentials", { status: 401 });
        f.tokensIssued.traceparts++;
        tpToken = `tp-jwt-${f.tokensIssued.traceparts}-eyJhbGciOi`;
        return Response.json({ token: tpToken, expiryDate: f.opts.tpTokenExpiry() });
      }
      if (u.pathname.startsWith("/tp/")) {
        if (req.headers.get("authorization") !== `Bearer ${tpToken}`) return Response.json("Unauthorized", { status: 401 });
        if (u.pathname === "/tp/v2/Search/PartNumber/Availability") {
          if (u.searchParams.get("catalog") === "Texas Instruments" && u.searchParams.get("partNumber") === "LM317T") return Response.json({ partFamilyCode: "TI-LM317", classificationCode: "TI", partNumber: "LM317T", selectionPath: "LM317T|TO220", version: "1" });
          return new Response(null, { status: 404 });
        }
        if (u.pathname === "/tp/v3/Product/CadDataAvailability") {
          return Response.json({ partNumberAvailability: { partNumber: "LM317T", availability: true }, viewerAvailability: true, cadFormatList: [{ cadFormatId: 96, cadFormatName: "STEP AP214", deliveryMethod: 1 }, { cadFormatId: 12, cadFormatName: "AutoCAD DWG", deliveryMethod: 1 }, { cadFormatId: 200, cadFormatName: "STEP (web page)", deliveryMethod: 2 }] });
        }
        if (u.pathname === "/tp/v3/Product/cadRequest") {
          pending = f.opts.tpPending;
          return Response.json(4711);
        }
        if (u.pathname === "/tp/v2/Product/cadFileUrl") {
          if (u.searchParams.get("cadRequestId") !== "4711") return new Response(null, { status: 404 });
          if (pending-- > 0) return new Response(null, { status: 204 });
          return Response.json(f.opts.fileUrl);
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  f.port = srv.port as number;
  f.url = `http://127.0.0.1:${f.port}`;
  f.stop = () => srv.stop(true);
  return f;
}

export const baseUrls = (f: VendorFixture) => ({ digikey: `${f.url}/dk`, mouser: `${f.url}/mouser`, traceparts: `${f.url}/tp` });

export const STEP_BYTES = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('bracket'),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";

export interface FileFixture {
  port: number;
  ca: string;
  requests: string[];
  stop(): void;
}

/** An HTTPS file server for `*.parts.test` with a throwaway self-signed certificate (openssl). */
export function startFileFixture(): FileFixture {
  const dir = mkdtempSync(join(tmpdir(), "anvil-c5-tls-"));
  const r = Bun.spawnSync(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=files.parts.test", "-addext", "subjectAltName=DNS:files.parts.test,DNS:other.parts.test"], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`openssl failed: ${r.stderr.toString()}`);
  const cert = readFileSync(join(dir, "c.pem"), "utf8");
  const key = readFileSync(join(dir, "k.pem"), "utf8");
  rmSync(dir, { recursive: true, force: true });
  const requests: string[] = [];
  const srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch(req) {
      const u = new URL(req.url);
      requests.push(u.pathname + u.search);

      if (u.pathname.endsWith(".pdf")) return new Response("%PDF-1.4 datasheet\n", { headers: { "content-type": "application/pdf" } });
      if (u.pathname === "/tool.exe") return new Response("MZ", { headers: { "content-type": "application/octet-stream" } });
      if (u.pathname === "/named") return new Response("not a step", { headers: { "content-disposition": 'attachment; filename="installer.dmg"' } });
      if (u.pathname === "/big.step") return new Response("x".repeat(100));
      if (u.pathname === "/huge-stream.step") {
        // No Content-Length: the cap must be enforced while streaming.
        let n = 0;
        return new Response(new ReadableStream({ pull(c) { if (n++ > 200) return c.close(); c.enqueue(new TextEncoder().encode("y".repeat(4096))); } }));
      }
      if (u.pathname.endsWith(".step")) return new Response(STEP_BYTES, { headers: { "content-type": "application/octet-stream" } });
      if (u.pathname === "/to-loopback") return Response.redirect("https://127.0.0.1:9/x.step", 302);
      if (u.pathname === "/to-private-name") return Response.redirect("https://intranet.parts.test/x.step", 302);
      if (u.pathname === "/to-http") return Response.redirect("http://files.parts.test/x.step", 302);
      if (u.pathname === "/to-good") return Response.redirect("https://other.parts.test/models/ok.step", 302);
      return new Response("nf", { status: 404 });
    },
  });
  return { port: srv.port as number, ca: cert, requests, stop: () => srv.stop(true) };
}

/** The resolver parts_fetch is given in tests: public-looking addresses for the fixture names. */
export const fixtureResolver = async (host: string): Promise<string[]> => {
  if (host === "files.parts.test" || host === "other.parts.test") return ["93.184.216.34"];
  if (host === "intranet.parts.test") return ["10.1.2.3"];
  throw new Error(`no such host ${host}`);
};
