# Lapo integration

Anvil can authorize against a **lapo** instance over OAuth2 and post a markdown **information entry**
summarizing every autopilot run — what was built/started, what's held for clarification, and what was
skipped. The integration is hub-scoped (like Todoist and the model-provider tokens): the tokens live on
the hub daemon and the Settings → Lapo card routes to the hub.

## How it fits together

| Layer | Where |
|-------|-------|
| OAuth + entry client | `anvild/src/integrations/lapo.ts` (`LapoClient`) |
| Config (env → `LapoConfig`) | `anvild/src/config.ts` (`resolveLapoConfig`) |
| Token/handshake persistence | `anvild/src/integrations/store.ts` (`LapoState`, `<stateDir>/integrations/lapo.json`, mode 0600) |
| Report generation (pure) | `anvild/src/integrations/lapo-report.ts` (`buildAutopilotReport`) |
| Auth + report methods | `anvild/src/session/supervisor.ts` (`beginLapoAuth` / `completeLapoAuth` / `disconnectLapo` / `postAutopilotReport`) |
| OAuth callback route | `anvild/src/server/http.ts` (`GET /api/integrations/lapo/callback`) |
| Protocol | `docs/plans/anvil-protocol.ts` (`lapo.status` / `lapo.connect` / `lapo.disconnect` cmds; `lapo.status` / `lapo.authorize` events) |
| Settings UI | `anvild/web/src/main.ts` (Settings → Lapo) |

## Endpoint discovery

The OAuth authorize + token endpoints are **discovered at runtime** from lapo's
[OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414) at
`https://app.heylapo.com/.well-known/oauth-authorization-server`. As of writing, that document is:

```json
{ "issuer": "https://app.heylapo.com",
  "authorization_endpoint": "https://app.heylapo.com/#/oauth/authorize",
  "token_endpoint": "https://app.heylapo.com/oauth/token",
  "registration_endpoint": "https://app.heylapo.com/oauth/register",
  "scopes_supported": ["journal.append", "documents.write"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_post"] }
```

Notes the client handles from this:
- The **authorize endpoint is a hash route** (`/#/oauth/authorize`); the client appends the query
  *after* the fragment so the SPA router sees the params (a normal `?query` before the `#` would be lost).
- **PKCE (S256)** is used because it's advertised; a client without a secret is public and always PKCEs.
- Token auth is **`client_secret_post`** (client id/secret in the form body) — what the client already does.
- The `ANVIL_LAPO_AUTHORIZE_PATH` / `_TOKEN_PATH` vars are only fallbacks if discovery is unreachable.

## Configuring (hub daemon env)

Set these in the hub daemon's launcher env, then restart it. Only the client id is required; until it's
set the Settings → Integrations card shows setup guidance instead of a Connect button.

| Env var | Required | Default | Meaning |
|---------|----------|---------|---------|
| `ANVIL_LAPO_CLIENT_ID` | ✅ | — | OAuth client id registered for this daemon |
| `ANVIL_LAPO_CLIENT_SECRET` | | — | OAuth client secret; **omit for a public (PKCE) client** |
| `ANVIL_LAPO_BASE_URL` | | `https://app.heylapo.com` | lapo origin (discovery + entry API hang off it) |
| `ANVIL_LAPO_ENTRY_PATH` | | `/v1/journal/append` | fallback create-entry route if OpenAPI discovery fails (see below) |
| `ANVIL_LAPO_WHOAMI_PATH` | | `/me` | identity endpoint (only used to label the account) |
| `ANVIL_LAPO_SCOPE` | | `journal.append documents.write` | OAuth scopes requested (both advertised scopes) |
| `ANVIL_LAPO_COLLECTION` | | — | optional collection/space id every entry is filed under |
| `ANVIL_LAPO_AUTHORIZE_PATH` | | `/oauth/authorize` | authorize endpoint — **discovery fallback only** |
| `ANVIL_LAPO_TOKEN_PATH` | | `/oauth/token` | token endpoint — **discovery fallback only** |

On lapo's side, register this redirect URI as allowed (the daemon origin the web client is served from):

```
<daemon-origin>/api/integrations/lapo/callback
```

## Connecting

Settings → **Lapo** → **Connect Lapo** opens a popup to lapo's authorize page. On approval, lapo
redirects back to the daemon callback, which exchanges the code for tokens (validated + stored, mode
0600) and broadcasts the connected status. The token is refreshed automatically before it expires.

## The report

After any autopilot run that produced results (empty runs are skipped), the daemon appends the report
to the day's journal via `POST /v1/journal/append` with a bearer access token. Journal pages are Logseq
outlines, so the report is rendered (`renderJournalOutline`) as a **single collapsed node** — the whole
run folds under one bullet, TAB-indented children, so it adds one tidy line to the day rather than a
wall of headings:

```
{ "date": "2026-07-07", "markdown":
"- # ✈️ Anvil Autopilot Report
\tcollapsed:: true
\t_scheduled run · anvil · 2026-07-07_
\t- **2** units planned · **1** auto-started · **2** tasks skipped.
\t- ✅ Started
\t\t- **Wire push retries** — add backoff · 1 task
\t- ❓ Needs more information
\t\t- **Add export button** — which format?
\t\t\t- CSV or JSON?
\t- ⏭️ Skipped — 2 tasks already in the pipeline" }
```

Nesting is by **tab** (spaces don't nest in lapo's outline), and `collapsed:: true` on the top node
folds it. A `documents.write` endpoint (if preferred instead) gets the titled `buildAutopilotReport`
markdown rather than the outline.

The body is bucketed into **Started**, **Ready for review**, **Needs more information** (with the held
units' open questions), and a **Skipped** tally. The wording lives in `buildAutopilotReport`.

### Resource-endpoint discovery (RFC 9728 → OpenAPI)

OAuth discovery covers auth only. The daemon learns the create-entry **route + payload field names**
from lapo's [Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728) at
`https://app.heylapo.com/.well-known/oauth-protected-resource`, which points to the OpenAPI spec:

```json
{ "resource": "https://app.heylapo.com",
  "authorization_servers": ["https://app.heylapo.com"],
  "scopes_supported": ["journal.append", "documents.write"],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://app.heylapo.com/v1/docs" }
```

The daemon (`LapoClient.discoverResource`) follows `resource_documentation` to the OpenAPI 3.1 doc
(`/v1/openapi.json` — a Swagger-UI landing page is followed to the JSON it loads), then picks the write
operation requiring **`journal.append`** (preferred — the run report is appended to the day's journal)
and derives the route + request fields from its schema. For `POST /v1/journal/append`
(`{date, markdown}`) that means:

- **`date`** is auto-filled with today (UTC, `YYYY-MM-DD`).
- The journal has **no title field**, so the report title is folded into the markdown as an `##` heading.
- The result is cached at connect, so posting a report costs no extra discovery round-trips.

A compact `x-lapo-entry` extension in the same metadata doc is also honored as a fast path (skips OpenAPI
parsing). If nothing is discoverable, the daemon falls back to `ANVIL_LAPO_ENTRY_PATH`
(default `/v1/journal/append`, journal-shaped `{date, markdown}`).

## Notes / limits

- **Hub-only, by design.** Unlike the Todoist token, lapo tokens are **not** propagated across the
  fleet: OAuth refresh-token rotation across daemons would invalidate each other. Reports post on the
  daemon where lapo is connected (normally the hub, where the scheduled run fires).
- **Configurability.** Everything lapo-specific lives in `LapoConfig` + the two payload builders in
  `lapo.ts`, so pointing at a different lapo deployment is env + a small edit, never a flow change.
