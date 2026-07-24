import { describe, expect, test } from "bun:test";
import { fetchModelCatalog, resolveModelLabels, type ModelCatalogEntry } from "../../src/agent/model-catalog";

/** A trimmed but representative `GET /v1/models` payload: two Opus generations (4.8 + 5), Sonnet 5,
 *  Haiku, Fable, plus a dated legacy Opus — deliberately unsorted to prove newest-wins by created_at. */
const CATALOG: ModelCatalogEntry[] = [
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: "2026-05-28T00:00:00Z" },
  { id: "claude-fable-5", display_name: "Claude Fable 5", created_at: "2026-06-07T00:00:00Z" },
  { id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z" },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-06-29T00:00:00Z" },
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-15T00:00:00Z" },
  { id: "claude-opus-4-5-20251101", display_name: "Claude Opus 4.5", created_at: "2025-11-24T00:00:00Z" },
];

describe("resolveModelLabels", () => {
  test("picks the newest per alias family and strips the 'Claude ' prefix", () => {
    const labels = resolveModelLabels(CATALOG);
    expect(labels.opus).toBe("Opus 5"); // newest claude-opus-* beats 4.8 and the dated 4.5
    expect(labels.sonnet).toBe("Sonnet 5");
    expect(labels.haiku).toBe("Haiku 4.5");
  });

  test("resolves the pinned `fable` tier by its exact sdk id, not by family recency", () => {
    // Even with a (hypothetical) newer fable in the list, the label must track the pinned claude-fable-5.
    const withNewerFable = [
      ...CATALOG,
      { id: "claude-fable-6", display_name: "Claude Fable 6", created_at: "2027-01-01T00:00:00Z" },
    ];
    expect(resolveModelLabels(withNewerFable).fable).toBe("Fable 5");
  });

  test("omits a tier with no catalog match so the client keeps its static fallback", () => {
    const noSonnet = CATALOG.filter((e) => !e.id.startsWith("claude-sonnet-"));
    const labels = resolveModelLabels(noSonnet);
    expect(labels.sonnet).toBeUndefined();
    expect(labels.opus).toBe("Opus 5");
  });

  test("ignores malformed entries without throwing", () => {
    const dirty = [...CATALOG, { id: 123 } as unknown as ModelCatalogEntry, null as unknown as ModelCatalogEntry];
    expect(resolveModelLabels(dirty).opus).toBe("Opus 5");
  });
});

describe("fetchModelCatalog", () => {
  test("sends bearer + oauth beta headers and returns the data array", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ data: CATALOG }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await fetchModelCatalog("tok-abc", fakeFetch);
    expect(out).toHaveLength(CATALOG.length);
    expect(seen?.headers.authorization).toBe("Bearer tok-abc");
    expect(seen?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  test("throws on a non-2xx response", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchModelCatalog("tok", fakeFetch)).rejects.toThrow("HTTP 401");
  });
});
