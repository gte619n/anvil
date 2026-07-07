/**
 * Thin client for a "lapo" instance (default `https://app.heylapo.com`) — an OAuth2 endpoint Anvil
 * authorizes against, plus a REST endpoint that turns well-formatted markdown into an "information
 * entry" (the autopilot posts a run report there when a run finishes).
 *
 * Endpoints are DISCOVERED, not hardcoded: lapo publishes OAuth 2.0 Authorization Server Metadata
 * (RFC 8414) at `/.well-known/oauth-authorization-server` (OpenID Connect discovery as a fallback), so
 * the daemon learns the real authorize/token endpoints — and whether PKCE is required — at runtime. The
 * `authorizePath`/`tokenPath` in LapoConfig are only fallbacks used when discovery is unreachable.
 *
 * The client supports BOTH a confidential client (client_secret) and a public client (PKCE, no secret):
 * the secret is sent only when configured, and PKCE is used when the server advertises `S256`. A random
 * `state` guards the redirect against CSRF; the daemon verifies it on callback.
 *
 * The client is STATELESS: every call takes the tokens/endpoints it needs as arguments. Persistence,
 * refresh scheduling, and the pending-auth handshake live in the IntegrationStore / Supervisor.
 */
import { createHash, randomBytes } from "node:crypto";
import { retryAsync, parseRetryAfterMs } from "../util/retry";

/** Default lapo host — overridable via ANVIL_LAPO_BASE_URL (see config.ts). */
export const DEFAULT_LAPO_BASE_URL = "https://app.heylapo.com";

/** Default OAuth scope — the scopes app.heylapo.com advertises in its RFC 8414 metadata. `journal.append`
 *  lets the autopilot report be appended as a journal entry; `documents.write` covers document-style
 *  entries. Requesting both keeps the entry API working whichever it maps to. Override with ANVIL_LAPO_SCOPE. */
export const DEFAULT_LAPO_SCOPE = "journal.append documents.write";

/** A lapo deployment's OAuth + entry-API surface. Resolved from ANVIL_LAPO_* env (see config.ts). */
export interface LapoConfig {
  /** Base origin, no trailing slash — e.g. `https://app.heylapo.com`. Discovery + all paths hang off it. */
  baseUrl: string;
  /** OAuth client id registered with lapo for this daemon. */
  clientId: string;
  /** OAuth client secret — omit for a public (PKCE) client. */
  clientSecret?: string;
  /** Authorize endpoint FALLBACK, used only when discovery fails. Default `/oauth/authorize`. */
  authorizePath: string;
  /** Token endpoint FALLBACK, used only when discovery fails. Default `/oauth/token`. */
  tokenPath: string;
  /** Where an information entry is created (POST markdown). Default `/api/entries`. */
  entryPath: string;
  /** Optional identity endpoint used only to label the connected account. Default `/api/me`. */
  whoamiPath?: string;
  /** OAuth scope requested. Default `entries:write`. */
  scope?: string;
  /** Optional collection/space id every entry is filed under (passed through in the payload). */
  collection?: string;
}

/** The subset of OAuth Authorization Server Metadata (RFC 8414) the flow needs. */
export interface LapoServerMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
}

/**
 * The resolved "append a markdown entry" endpoint, discovered from lapo's RFC 9728 Protected Resource
 * Metadata (`/.well-known/oauth-protected-resource`, the `x-lapo-entry` extension). OAuth discovery
 * (RFC 8414) covers auth only; THIS is how the daemon learns the resource route + payload field names
 * without hardcoding them. Falls back to the configured `entryPath` + conventional fields when absent.
 */
export interface LapoEntryEndpoint {
  method: string; // e.g. "POST"
  url: string; // absolute
  contentField: string; // JSON field for the markdown body (e.g. "markdown")
  titleField?: string; // JSON field for the title, when the endpoint accepts one (e.g. "title")
  dateField?: string; // required date field (e.g. journal/append's "date"), auto-filled with today (UTC)
  formatField?: string; // JSON field naming the body format, if the API wants one
  formatValue?: string; // value for formatField (default "markdown")
  collectionField?: string; // JSON field for the collection id, if supported
}

/** A PKCE pair: the secret `verifier` and its `S256` `challenge` (both base64url, no padding). */
export interface LapoPkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** OAuth token material returned by the token endpoint. `expiresAt` is an absolute epoch-ms deadline
 *  (computed from `expires_in`) so the caller can refresh proactively without re-deriving "now". */
export interface LapoTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
}

/** The result of creating an information entry — whatever id/url lapo hands back (best-effort). */
export interface LapoEntryResult {
  id?: string;
  url?: string;
}

// A single hung request must never latch the autopilot run (and its spinner) open — the report post
// happens at the tail of a run. Cap each call; compose with the run-level abort signal below.
const REQUEST_TIMEOUT_MS = 30_000;
// Discovery is off the hot path but shouldn't hang a connect — cap it tighter.
const DISCOVERY_TIMEOUT_MS = 10_000;
// Refresh a little BEFORE the real expiry so a token that lapses mid-request doesn't 401 the post.
const EXPIRY_SKEW_MS = 60_000;

export class LapoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LapoError";
  }
}

/** True when the access token is absent or within the refresh skew of expiring. */
export function tokenNeedsRefresh(tokens: Pick<LapoTokens, "accessToken" | "expiresAt">, now: number): boolean {
  if (!tokens.accessToken) return true;
  return tokens.expiresAt !== undefined && tokens.expiresAt - EXPIRY_SKEW_MS <= now;
}

/** base64url (no padding) of a buffer — the encoding PKCE + OAuth expect. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class LapoClient {
  constructor(
    private readonly cfg: LapoConfig,
    /** Optional run-level abort so a cancelled/timed-out autopilot run unwinds an in-flight call. */
    private readonly signal?: AbortSignal,
  ) {}

  /** The redirect_uri lapo will send the browser back to — the daemon's own callback, same origin as
   *  the web client that started the flow. Must be registered as an allowed redirect on lapo's side. */
  static callbackPath(): string {
    return "/api/integrations/lapo/callback";
  }

  /** Generate a fresh PKCE pair (S256). Stored in the pending handshake and replayed at token exchange. */
  static generatePkce(): LapoPkce {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    return { verifier, challenge, method: "S256" };
  }

  /**
   * Discover the authorization + token endpoints (and PKCE support) from lapo's well-known metadata.
   * Tries RFC 8414 (`/.well-known/oauth-authorization-server`) then OIDC
   * (`/.well-known/openid-configuration`). Returns undefined when neither is reachable/parseable, so
   * the caller falls back to the configured `authorizePath`/`tokenPath`.
   */
  async discover(): Promise<LapoServerMetadata | undefined> {
    const origin = new URL(this.cfg.baseUrl).origin;
    for (const wellKnown of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
      try {
        const res = await this.fetch(`${origin}${wellKnown}`, { method: "GET", headers: { accept: "application/json" } }, DISCOVERY_TIMEOUT_MS);
        if (!res.ok) continue;
        const ct = res.headers.get("content-type") ?? "";
        if (!/json/i.test(ct)) continue; // an SPA index.html masquerading as 200 → not real metadata
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        const authorizationEndpoint = typeof data?.authorization_endpoint === "string" ? data.authorization_endpoint : undefined;
        const tokenEndpoint = typeof data?.token_endpoint === "string" ? data.token_endpoint : undefined;
        if (!authorizationEndpoint || !tokenEndpoint) continue;
        return {
          authorizationEndpoint,
          tokenEndpoint,
          ...(typeof data?.registration_endpoint === "string" ? { registrationEndpoint: data.registration_endpoint } : {}),
          ...(Array.isArray(data?.scopes_supported) ? { scopesSupported: data.scopes_supported.filter((s): s is string => typeof s === "string") } : {}),
          ...(Array.isArray(data?.code_challenge_methods_supported)
            ? { codeChallengeMethodsSupported: data.code_challenge_methods_supported.filter((s): s is string => typeof s === "string") }
            : {}),
        };
      } catch {
        /* try the next well-known, then fall back to configured paths */
      }
    }
    return undefined;
  }

  /**
   * Discover the "write a markdown entry" endpoint from lapo's RFC 9728 Protected Resource Metadata
   * (`/.well-known/oauth-protected-resource`). Two supported shapes, in order:
   *   1. an explicit `x-lapo-entry` extension (fast path, zero OpenAPI parsing), or
   *   2. the standard `resource_documentation` → OpenAPI, from which the operation requiring
   *      `journal.append` (preferred — the autopilot report is appended to the day's journal) or
   *      `documents.write` is resolved, deriving the path + request field names from its request schema.
   * Returns undefined when nothing is discoverable, so the caller falls back to the configured entryPath.
   */
  async discoverResource(): Promise<LapoEntryEndpoint | undefined> {
    const origin = new URL(this.cfg.baseUrl).origin;
    try {
      const res = await this.fetch(`${origin}/.well-known/oauth-protected-resource`, { method: "GET", headers: { accept: "application/json" } }, DISCOVERY_TIMEOUT_MS);
      if (!res.ok || !/json/i.test(res.headers.get("content-type") ?? "")) return undefined;
      const meta = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!meta) return undefined;
      const ext = meta["x-lapo-entry"];
      if (ext && typeof ext === "object") {
        const parsed = this.parseEntryExtension(ext as Record<string, unknown>, origin);
        if (parsed) return parsed;
      }
      const docUrl = typeof meta.resource_documentation === "string" ? meta.resource_documentation : undefined;
      const spec = await this.fetchOpenApi(docUrl ?? `${origin}/v1/openapi.json`, origin);
      return spec ? this.resolveEntryFromOpenApi(spec) : undefined;
    } catch {
      return undefined; // fall back to the configured entryPath
    }
  }

  /** Parse the compact `x-lapo-entry` extension (a lapo without published OpenAPI can serve just this). */
  private parseEntryExtension(e: Record<string, unknown>, origin: string): LapoEntryEndpoint | undefined {
    const rawUrl = typeof e.endpoint === "string" ? e.endpoint : typeof e.url === "string" ? e.url : undefined;
    if (!rawUrl) return undefined;
    const fields = (e.fields && typeof e.fields === "object" ? e.fields : {}) as Record<string, unknown>;
    return {
      method: typeof e.method === "string" ? e.method.toUpperCase() : "POST",
      url: new URL(rawUrl, `${origin}/`).toString(),
      contentField: typeof fields.content === "string" ? fields.content : "markdown",
      ...(typeof fields.title === "string" ? { titleField: fields.title } : {}),
      ...(typeof fields.date === "string" ? { dateField: fields.date } : {}),
      ...(typeof fields.format === "string" ? { formatField: fields.format } : {}),
      ...(typeof e.format === "string" ? { formatValue: e.format } : {}),
      ...(typeof fields.collection === "string" ? { collectionField: fields.collection } : {}),
    };
  }

  /** Fetch an OpenAPI document, following a Swagger-UI HTML page to the `url:"…openapi.json"` it loads. */
  private async fetchOpenApi(docUrl: string, origin: string): Promise<Record<string, unknown> | undefined> {
    const res = await this.fetch(new URL(docUrl, `${origin}/`).toString(), { method: "GET", headers: { accept: "application/json" } }, DISCOVERY_TIMEOUT_MS);
    if (!res.ok) return undefined;
    if (/json/i.test(res.headers.get("content-type") ?? "")) return (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    // Swagger-UI landing page → pull the openapi.json URL it points SwaggerUIBundle at.
    const html = await res.text().catch(() => "");
    const m = /url:\s*["']([^"']+)["']/.exec(html);
    if (!m) return undefined;
    const specRes = await this.fetch(new URL(m[1]!, `${origin}/`).toString(), { method: "GET", headers: { accept: "application/json" } }, DISCOVERY_TIMEOUT_MS);
    if (!specRes.ok || !/json/i.test(specRes.headers.get("content-type") ?? "")) return undefined;
    return (await specRes.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  }

  /** Resolve a write operation from an OpenAPI 3.x doc, preferring the one that requires `journal.append`
   *  (append the run report to the day's journal) over `documents.write`. Derives the request field names
   *  from its request schema. */
  private resolveEntryFromOpenApi(spec: Record<string, unknown>): LapoEntryEndpoint | undefined {
    const paths = asRecord(spec.paths);
    if (!paths) return undefined;
    const servers = Array.isArray(spec.servers) ? spec.servers : [];
    const serverUrl = (asRecord(servers[0])?.url as string) || new URL(this.cfg.baseUrl).origin;
    const schemas = asRecord(asRecord(spec.components)?.schemas) ?? {};
    const WRITE = new Set(["post", "put", "patch"]);
    const opScopes = (op: Record<string, unknown>): Set<string> => {
      const out = new Set<string>();
      for (const req of Array.isArray(op.security) ? op.security : []) {
        for (const v of Object.values(asRecord(req) ?? {})) if (Array.isArray(v)) for (const s of v) if (typeof s === "string") out.add(s);
      }
      return out;
    };
    const deref = (schema: Record<string, unknown> | undefined): Record<string, unknown> => {
      const ref = schema?.$ref;
      if (typeof ref === "string") return asRecord(schemas[ref.split("/").pop() ?? ""]) ?? {};
      return schema ?? {};
    };
    for (const wantScope of ["journal.append", "documents.write"]) {
      for (const [path, opsRaw] of Object.entries(paths)) {
        const ops = asRecord(opsRaw);
        if (!ops) continue;
        for (const [method, opRaw] of Object.entries(ops)) {
          const op = asRecord(opRaw);
          if (!op || !WRITE.has(method.toLowerCase()) || !opScopes(op).has(wantScope)) continue;
          const schema = deref(asRecord(asRecord(asRecord(asRecord(op.requestBody)?.content)?.["application/json"])?.schema));
          const props = asRecord(schema.properties) ?? {};
          const required: string[] = Array.isArray(schema.required) ? schema.required.filter((s): s is string => typeof s === "string") : [];
          const names = Object.keys(props);
          const find = (re: RegExp): string | undefined => required.find((n) => re.test(n)) ?? names.find((n) => re.test(n));
          const contentField = find(/^(markdown|content|body|text)$/i) ?? required[0] ?? "markdown";
          const titleField = names.find((n) => /^(title|name|heading)$/i.test(n));
          const dateField = required.find((n) => /date/i.test(n));
          try {
            return {
              method: method.toUpperCase(),
              url: new URL(path, serverUrl).toString(),
              contentField,
              ...(titleField ? { titleField } : {}),
              ...(dateField ? { dateField } : {}),
            };
          } catch {
            return undefined;
          }
        }
      }
    }
    return undefined;
  }

  /** Build the authorize URL the user's browser is sent to. Prefer a discovered `authorizationEndpoint`;
   *  otherwise fall back to `baseUrl + authorizePath`. Include the PKCE `codeChallenge` when present.
   *
   *  lapo's authorization_endpoint is a HASH route (`https://app.heylapo.com/#/oauth/authorize`), so the
   *  query must be appended to the END of the URL (after the fragment), not inserted into the query
   *  component — a plain `new URL().searchParams` would wrongly place `?…` before the `#` and the SPA
   *  router would never see the params. String-append is correct for both a hash-routed SPA endpoint and
   *  a conventional endpoint. */
  authorizeUrl(opts: { redirectUri: string; state: string; authorizationEndpoint?: string; codeChallenge?: string }): string {
    const endpoint = opts.authorizationEndpoint ?? this.url(this.cfg.authorizePath);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: opts.redirectUri,
      scope: this.cfg.scope ?? DEFAULT_LAPO_SCOPE,
      state: opts.state,
      ...(opts.codeChallenge ? { code_challenge: opts.codeChallenge, code_challenge_method: "S256" } : {}),
    });
    return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${params.toString()}`;
  }

  /** Exchange an authorization code for tokens. Sends the client_secret when configured (confidential
   *  client) and the PKCE `codeVerifier` when the handshake used one (public client). */
  async exchangeCode(opts: { code: string; redirectUri: string; tokenEndpoint?: string; codeVerifier?: string }): Promise<LapoTokens> {
    return this.tokenRequest(opts.tokenEndpoint, {
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      ...(opts.codeVerifier ? { code_verifier: opts.codeVerifier } : {}),
    });
  }

  /** Trade a refresh token for a fresh access token (and possibly a rotated refresh token). */
  async refresh(refreshToken: string, opts: { tokenEndpoint?: string } = {}): Promise<LapoTokens> {
    const next = await this.tokenRequest(opts.tokenEndpoint, { grant_type: "refresh_token", refresh_token: refreshToken });
    // Some servers omit the refresh_token on refresh (non-rotating) — keep the existing one so the
    // next refresh still has something to present.
    return next.refreshToken ? next : { ...next, refreshToken };
  }

  /** Best-effort account label for display (email/name/username). Never throws to the caller-critical
   *  path: a lapo without a whoami endpoint just yields undefined. */
  async whoami(accessToken: string): Promise<{ account?: string }> {
    const path = this.cfg.whoamiPath ?? "/me";
    try {
      const data = await this.apiGet<Record<string, unknown>>(path, accessToken);
      const account = pickString(data, ["email", "name", "full_name", "username", "handle"]);
      return account ? { account } : {};
    } catch {
      return {};
    }
  }

  /**
   * Create an information entry from markdown. The route + payload field names come from the discovered
   * `resolved` endpoint (RFC 9728 `x-lapo-entry`) when available; otherwise they fall back to the
   * configured `entryPath` and conventional `{title, content, format}`. Returns whatever id/url lapo
   * echoes back (used only for logging/linking).
   */
  async createEntry(accessToken: string, entry: { title: string; markdown: string }, resolved?: LapoEntryEndpoint): Promise<LapoEntryResult> {
    // Default (no discovery) → the journal/append shape: {date, markdown}, with no separate title field.
    const ep: LapoEntryEndpoint = resolved ?? {
      method: "POST",
      url: this.url(this.cfg.entryPath),
      contentField: "markdown",
      dateField: "date",
    };
    // When the endpoint has no title field (journal/append), fold the title into the markdown as a
    // heading so it isn't lost; otherwise send it as its own field (documents-style).
    const markdown = ep.titleField || !entry.title ? entry.markdown : `## ${entry.title}\n\n${entry.markdown}`;
    const body: Record<string, unknown> = { [ep.contentField]: markdown };
    if (ep.titleField && entry.title) body[ep.titleField] = entry.title;
    if (ep.dateField) body[ep.dateField] = new Date().toISOString().slice(0, 10); // today, UTC (YYYY-MM-DD)
    if (ep.formatField) body[ep.formatField] = ep.formatValue ?? "markdown";
    if (this.cfg.collection && ep.collectionField) body[ep.collectionField] = this.cfg.collection;
    const data = await this.apiSend<Record<string, unknown>>(ep.method, ep.url, accessToken, body);
    const id = pickString(data, ["noteId", "id"]);
    const url = pickString(data, ["url", "html_url", "permalink"]);
    return { ...(id ? { id } : {}), ...(url ? { url } : {}) };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async tokenRequest(tokenEndpoint: string | undefined, fields: Record<string, string>): Promise<LapoTokens> {
    const form = new URLSearchParams({
      ...fields,
      client_id: this.cfg.clientId,
      ...(this.cfg.clientSecret ? { client_secret: this.cfg.clientSecret } : {}),
    });
    const endpoint = tokenEndpoint ?? this.url(this.cfg.tokenPath);
    const res = await this.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
    if (!res.ok) throw await this.error("token", endpoint, res);
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };
    if (!data.access_token) throw new LapoError("lapo token response had no access_token", res.status);
    return {
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      ...(typeof data.expires_in === "number" ? { expiresAt: Date.now() + data.expires_in * 1000 } : {}),
      ...(data.token_type ? { tokenType: data.token_type } : {}),
    };
  }

  private apiGet<T>(path: string, accessToken: string): Promise<T> {
    return this.apiSend<T>("GET", this.url(path), accessToken);
  }

  /** A bearer-authed JSON call (to an ABSOLUTE `target` URL) with transient-retry on 429/5xx. */
  private apiSend<T>(method: string, target: string, accessToken: string, body?: unknown): Promise<T> {
    return retryAsync(
      async () => {
        const res = await this.fetch(target, {
          method,
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (!res.ok) throw await this.error(method, target, res);
        if (res.status === 204) return undefined as T;
        return (await res.json().catch(() => ({}))) as T;
      },
      {
        isRetryable: (e) => e instanceof LapoError && (e.status === 429 || (e.status ?? 0) >= 500),
        retryAfterMs: (e) => (e instanceof LapoError ? e.retryAfterMs : undefined),
        signal: this.signal,
      },
    );
  }

  private url(path: string): string {
    return new URL(path, `${this.cfg.baseUrl}/`).toString();
  }

  private fetch(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    // Abort on EITHER the run-level cancel OR this call outliving the per-request ceiling.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    return fetch(url, { ...init, signal });
  }

  private async error(method: string, path: string, res: Response): Promise<LapoError> {
    const text = await res.text().catch(() => "");
    return new LapoError(
      `lapo ${method} ${path} → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
      res.status,
      parseRetryAfterMs(res),
    );
  }
}

/** Narrow an unknown to a plain object (for walking untyped OpenAPI/JSON), else undefined. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** First present string value among `keys` in `obj` (trimmed, non-empty), else undefined. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}
