/**
 * [BE-12] extractJson walks to the matching close bracket by counting `{`/`}`, but it counted them
 * even inside string literals. A model objection like {"reason":"the config has a { brace"} then
 * mis-balanced and threw "unbalanced JSON", turning a recoverable bad-reply into a fatal pipeline
 * failure. The walker must be string/escape-aware.
 */
import { test, expect } from "bun:test";
import { extractJson } from "../../src/integrations/json";

test("parses an object containing braces inside a string value", () => {
  const out = extractJson<{ reason: string }>('{"reason": "the config has a { brace"}');
  expect(out.reason).toBe("the config has a { brace");
});

test("does not close early on a closing brace inside a string", () => {
  const out = extractJson<{ note: string; ok: boolean }>('{"note": "ends with }", "ok": true}');
  expect(out.note).toBe("ends with }");
  expect(out.ok).toBe(true);
});

test("handles escaped quotes inside strings", () => {
  const out = extractJson<{ q: string }>('{"q": "she said \\"hi\\" and { left"}');
  expect(out.q).toBe('she said "hi" and { left');
});

test("still strips prose and ```json fences, and extracts arrays", () => {
  expect(extractJson<{ a: number }>('here is the result:\n```json\n{"a": 1}\n```\nthanks').a).toBe(1);
  expect(extractJson<number[]>('prefix [1, 2, 3] suffix')).toEqual([1, 2, 3]);
});

test("ignores brackets in trailing prose after a balanced object", () => {
  const out = extractJson<{ x: number }>('{"x": 5} and then some } stray { text');
  expect(out.x).toBe(5);
});

test("throws when there is no JSON at all", () => {
  expect(() => extractJson("just prose, no json")).toThrow(/no JSON/);
});
