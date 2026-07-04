/**
 * First frontend unit test — proves the web client's pure logic is testable under `bun test`
 * without a DOM. `sessionColor.ts` is deliberately DOM-free (color math + FNV hash + ordinal), so
 * it's the natural seam to establish the harness. Phase 4 extends this to `ws.ts`/`state.ts`/etc.
 * with a DOM environment; the pure modules need none.
 *
 * Lives under test/ (not web/src) on purpose: the root tsconfig includes test/ with bun types,
 * while web/tsconfig (types:[]) would reject `bun:test` — so this typechecks under `typecheck`
 * and stays out of `typecheck:web`.
 */
import { test, expect } from "bun:test";
import type { Environment, Session } from "../../web/../protocol";
import {
  hueFromHex,
  hslToHex,
  baseHue,
  sessionBg,
  stripeColor,
  envOrdinal,
} from "../../web/src/sessionColor";

test("hueFromHex maps primaries to their wheel positions and greys/garbage to 0", () => {
  expect(hueFromHex("#ff0000")).toBe(0); // red
  expect(hueFromHex("#00ff00")).toBe(120); // green
  expect(hueFromHex("#0000ff")).toBe(240); // blue
  expect(hueFromHex("#808080")).toBe(0); // grey → 0
  expect(hueFromHex("not-a-color")).toBe(0); // unparseable → 0
  expect(hueFromHex("ff0000")).toBe(0 /* no hash still parses */);
});

test("hslToHex round-trips the primary hues", () => {
  expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
  expect(hslToHex(120, 1, 0.5)).toBe("#00ff00");
  expect(hslToHex(240, 1, 0.5)).toBe("#0000ff");
  // hue normalization: -120 ≡ 240
  expect(hslToHex(-120, 1, 0.5)).toBe(hslToHex(240, 1, 0.5));
});

test("baseHue prefers the picked color, else hashes the name deterministically", () => {
  const withColor = { id: "e1", name: "anything", color: "#0000ff" } as Environment;
  expect(baseHue(withColor)).toBe(240);

  const named = { id: "e2", name: "my-project" } as Environment;
  expect(baseHue(named)).toBe(baseHue(named)); // stable
  expect(baseHue(named)).toBeGreaterThanOrEqual(0);
  expect(baseHue(named)).toBeLessThan(360);
  // undefined env hashes the empty string (FNV offset basis) → a stable in-range hue, not 0.
  expect(baseHue(undefined)).toBe(baseHue(undefined));
  expect(baseHue(undefined)).toBeGreaterThanOrEqual(0);
  expect(baseHue(undefined)).toBeLessThan(360);
});

test("sessionBg / stripeColor produce valid hex and differ across themes", () => {
  const env = { id: "e1", name: "proj" } as Environment;
  for (const fn of [sessionBg, stripeColor]) {
    const light = fn(env, 0, "light");
    const dark = fn(env, 0, "dark");
    expect(light).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(light).not.toBe(dark); // theme-clamped lightness differs
  }
});

test("envOrdinal orders sessions within an environment by createdAt, 0 when unassigned", () => {
  const mk = (id: string, environmentId: string | undefined, createdAt: string): Session =>
    ({ id, environmentId, createdAt } as Session);
  const a = mk("a", "env1", "2026-01-01T00:00:00Z");
  const b = mk("b", "env1", "2026-01-02T00:00:00Z");
  const c = mk("c", "env1", "2026-01-03T00:00:00Z");
  const loner = mk("d", undefined, "2026-01-01T00:00:00Z");
  const all = [c, a, b, loner]; // deliberately unordered input

  expect(envOrdinal(a, all)).toBe(0);
  expect(envOrdinal(b, all)).toBe(1);
  expect(envOrdinal(c, all)).toBe(2);
  expect(envOrdinal(loner, all)).toBe(0); // no environment → 0
});
