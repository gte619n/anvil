import { test, expect } from "bun:test";
import { OpenRouterClient } from "../../src/integrations/openrouter";

// Live end-to-end smoke against the real OpenRouter endpoint — proves the URL, headers, and model slug
// are correct. SKIPPED by default (no key in CI, so the suite stays green). Run locally with:
//   OPENROUTER_LIVE=1 OPENROUTER_API_KEY=sk-or-... bun test test/unit/openrouter.live.test.ts
const LIVE = process.env.OPENROUTER_LIVE === "1" && !!process.env.OPENROUTER_API_KEY;
const MODEL = process.env.ANVIL_ADVERSARIAL_MODELS?.split(",")[0]?.trim() || "z-ai/glm-4.6";

test.skipIf(!LIVE)("real OpenRouter round-trip returns a non-empty string", async () => {
  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY!);
  const out = await client.chat(MODEL, [{ role: "user", content: 'Reply with only the JSON {"ok":true}.' }]);
  expect(typeof out).toBe("string");
  expect(out.length).toBeGreaterThan(0);
});
