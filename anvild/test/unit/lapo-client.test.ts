/**
 * LapoClient's URL/refresh logic, exercised without a network. The OAuth authorize URL and the
 * "does this token need refreshing" predicate are the parts most likely to break silently, so they're
 * pinned here; the transport (exchange/refresh/createEntry) is covered by the supervisor integration.
 */
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { LapoClient, tokenNeedsRefresh, type LapoConfig } from "../../src/integrations/lapo";

const cfg: LapoConfig = {
  baseUrl: "https://lapo.example.com",
  clientId: "cid-123",
  clientSecret: "secret",
  authorizePath: "/oauth/authorize",
  tokenPath: "/oauth/token",
  entryPath: "/api/entries",
  scope: "entries:write",
};

test("authorizeUrl carries the standard code-flow params", () => {
  const url = new URL(new LapoClient(cfg).authorizeUrl({ redirectUri: "https://host:7701/api/integrations/lapo/callback", state: "st-abc" }));
  expect(url.origin + url.pathname).toBe("https://lapo.example.com/oauth/authorize");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("client_id")).toBe("cid-123");
  expect(url.searchParams.get("redirect_uri")).toBe("https://host:7701/api/integrations/lapo/callback");
  expect(url.searchParams.get("scope")).toBe("entries:write");
  expect(url.searchParams.get("state")).toBe("st-abc");
});

test("callbackPath is the fixed daemon redirect route", () => {
  expect(LapoClient.callbackPath()).toBe("/api/integrations/lapo/callback");
});

test("authorizeUrl prefers a discovered endpoint and carries the PKCE challenge", () => {
  const url = new URL(
    new LapoClient(cfg).authorizeUrl({
      redirectUri: "https://host/api/integrations/lapo/callback",
      state: "st",
      authorizationEndpoint: "https://auth.heylapo.com/oauth2/authorize",
      codeChallenge: "chal-xyz",
    }),
  );
  // Discovered endpoint wins over the configured baseUrl+authorizePath fallback.
  expect(url.origin + url.pathname).toBe("https://auth.heylapo.com/oauth2/authorize");
  expect(url.searchParams.get("code_challenge")).toBe("chal-xyz");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
});

test("authorizeUrl appends params AFTER a hash-routed authorization endpoint (app.heylapo.com)", () => {
  // lapo's real discovered authorization_endpoint is a SPA hash route; params must follow the fragment.
  const raw = new LapoClient(cfg).authorizeUrl({
    redirectUri: "https://host/api/integrations/lapo/callback",
    state: "st",
    authorizationEndpoint: "https://app.heylapo.com/#/oauth/authorize",
    codeChallenge: "chal",
  });
  expect(raw.startsWith("https://app.heylapo.com/#/oauth/authorize?")).toBe(true);
  const u = new URL(raw);
  expect(u.search).toBe(""); // nothing in the query component…
  expect(u.hash).toContain("response_type=code"); // …it all lives in the fragment
  expect(u.hash).toContain("code_challenge=chal");
  expect(u.hash).toContain("state=st");
});

test("generatePkce yields a base64url S256 challenge of its verifier", () => {
  const { verifier, challenge, method } = LapoClient.generatePkce();
  expect(method).toBe("S256");
  expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
  expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  const expected = createHash("sha256").update(verifier).digest("base64url");
  expect(challenge).toBe(expected);
});

test("discoverResource parses the RFC 9728 x-lapo-entry extension", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    expect(String(url)).toBe("https://lapo.example.com/.well-known/oauth-protected-resource");
    return new Response(
      JSON.stringify({
        resource: "https://lapo.example.com",
        authorization_servers: ["https://lapo.example.com"],
        scopes_supported: ["journal.append"],
        "x-lapo-entry": { method: "post", endpoint: "/journal", format: "markdown", fields: { title: "heading", content: "body", format: "kind" } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  try {
    const entry = await new LapoClient(cfg).discoverResource();
    expect(entry).toEqual({
      method: "POST",
      url: "https://lapo.example.com/journal",
      titleField: "heading",
      contentField: "body",
      formatField: "kind",
      formatValue: "markdown",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("discoverResource resolves the journal.append operation from a linked OpenAPI doc", async () => {
  const openapi = {
    openapi: "3.1.0",
    servers: [{ url: "https://lapo.example.com" }],
    paths: {
      "/v1/journal/append": {
        post: {
          operationId: "appendJournal",
          security: [{ oauth2: ["journal.append"] }],
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/JournalAppendRequest" } } } },
        },
      },
      "/v1/documents": {
        post: { security: [{ oauth2: ["documents.write"] }], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/DocumentCreateRequest" } } } } },
      },
    },
    components: {
      schemas: {
        JournalAppendRequest: { type: "object", required: ["date", "markdown"], properties: { date: { type: "string" }, markdown: { type: "string" } } },
        DocumentCreateRequest: { type: "object", required: ["markdown"], properties: { markdown: { type: "string" }, title: { type: "string" } } },
      },
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/.well-known/oauth-protected-resource")) {
      return new Response(JSON.stringify({ resource: "https://lapo.example.com", resource_documentation: "https://lapo.example.com/v1/openapi.json" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.endsWith("/v1/openapi.json")) return new Response(JSON.stringify(openapi), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
  try {
    // journal.append is preferred over documents.write; date is a required field to auto-fill, no title.
    expect(await new LapoClient(cfg).discoverResource()).toEqual({
      method: "POST",
      url: "https://lapo.example.com/v1/journal/append",
      contentField: "markdown",
      dateField: "date",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("discoverResource returns undefined when the extension is absent (falls back to config)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ resource: "https://lapo.example.com" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  try {
    expect(await new LapoClient(cfg).discoverResource()).toBeUndefined();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("registerClient posts RFC 7591 metadata and returns the issued credentials", async () => {
  const realFetch = globalThis.fetch;
  let captured: any;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://app.heylapo.com/oauth/register");
    captured = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ client_id: "dyn-123", client_secret: "shh" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    // A client with no clientId can still register (registration doesn't require one).
    const client = new LapoClient({ ...cfg, clientId: undefined });
    const reg = await client.registerClient({ registrationEndpoint: "https://app.heylapo.com/oauth/register", redirectUri: "https://host/api/integrations/lapo/callback" });
    expect(reg).toEqual({ clientId: "dyn-123", clientSecret: "shh" });
    expect(captured.redirect_uris).toEqual(["https://host/api/integrations/lapo/callback"]);
    expect(captured.grant_types).toContain("authorization_code");
    expect(captured.client_name).toBe("Anvil");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a public client (no secret) is valid config", () => {
  const publicCfg: LapoConfig = { ...cfg, clientSecret: undefined };
  const url = new URL(new LapoClient(publicCfg).authorizeUrl({ redirectUri: "https://h/cb", state: "s" }));
  expect(url.searchParams.get("client_id")).toBe("cid-123");
});

test("tokenNeedsRefresh: missing token, and expiry within the skew window", () => {
  const now = 1_000_000_000_000;
  expect(tokenNeedsRefresh({ accessToken: "" }, now)).toBe(true); // no token
  expect(tokenNeedsRefresh({ accessToken: "x" }, now)).toBe(false); // no expiry → assume valid
  expect(tokenNeedsRefresh({ accessToken: "x", expiresAt: now + 5 * 60_000 }, now)).toBe(false); // comfortably ahead
  expect(tokenNeedsRefresh({ accessToken: "x", expiresAt: now + 30_000 }, now)).toBe(true); // inside the 60s skew
  expect(tokenNeedsRefresh({ accessToken: "x", expiresAt: now - 1 }, now)).toBe(true); // already expired
});
