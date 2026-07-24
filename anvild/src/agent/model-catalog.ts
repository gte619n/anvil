/**
 * Live model-label resolution (spec: "always show the latest models").
 *
 * The session picker lists stable tier *aliases* — `opus` / `sonnet` / `haiku` (which the Agent SDK
 * resolves to whatever the current generation is) plus `fable` (a pinned full id). Their human labels
 * ("Opus 5", "Sonnet 5", …) are the only thing that goes stale on a new release. This module fetches
 * the live catalog from the Anthropic Models API and derives the current label for each tier, so the
 * hub can refresh them on a timer instead of us hand-editing a constant every launch.
 *
 * Auth: the daemon's subscription OAuth token (CLAUDE_CODE_OAUTH_TOKEN) via `Authorization: Bearer` +
 * the `oauth-2025-04-20` beta header. `GET /v1/models` is a metadata call — no inference, no per-token
 * metering — so it does NOT violate the arch §3 "no metered ANTHROPIC_API_KEY" invariant.
 */
import { MODELS, type Model } from "@protocol";
import { sdkModelId } from "./models";

/** One entry from `GET /v1/models` — only the fields we resolve labels from. */
export interface ModelCatalogEntry {
  id: string;
  display_name: string;
  created_at: string; // ISO 8601 — sortable as a string
}

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";

/** Fetch the raw model catalog with the subscription OAuth token. Throws on a non-2xx response. */
export async function fetchModelCatalog(token: string, doFetch: typeof fetch = fetch): Promise<ModelCatalogEntry[]> {
  const res = await doFetch(MODELS_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`models list HTTP ${res.status}`);
  const body = (await res.json()) as { data?: ModelCatalogEntry[] };
  return Array.isArray(body.data) ? body.data : [];
}

/**
 * Map each picker tier to its current display label. For an alias tier (`opus`/`sonnet`/`haiku`) that's
 * the newest catalog entry in that family (`claude-opus-*`, …); for a pinned tier (`fable` →
 * `claude-fable-5`) it's the exact id. Labels drop the leading "Claude " to match the picker's style
 * ("Opus 5", not "Claude Opus 5"). Tiers with no match are omitted, so the client keeps its static
 * fallback for them. Pure — no network — so it's unit-testable against a fixed catalog.
 */
export function resolveModelLabels(entries: ModelCatalogEntry[]): Partial<Record<Model, string>> {
  const byNewest = entries
    .filter((e) => e && typeof e.id === "string" && typeof e.display_name === "string")
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const out: Partial<Record<Model, string>> = {};
  for (const { id } of MODELS) {
    const sdk = sdkModelId(id);
    const match = sdk.startsWith("claude-")
      ? byNewest.find((e) => e.id === sdk) // pinned concrete id (fable)
      : byNewest.find((e) => e.id.startsWith(`claude-${sdk}-`)); // alias family (opus/sonnet/haiku)
    const label = match?.display_name.replace(/^Claude\s+/i, "").trim();
    if (label) out[id] = label;
  }
  return out;
}
