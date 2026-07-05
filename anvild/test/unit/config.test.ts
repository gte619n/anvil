/**
 * [BE-misc] loadConfig parsed numeric env with a bare Number(), so a typo like ANVIL_PORT=77O1
 * (letter O) silently became NaN and the daemon bound to a garbage port. Validate numeric env with a
 * clear startup error instead of a silent NaN.
 */
import { test, expect } from "bun:test";
import { loadConfig } from "../../src/config";

const base = { HOME: "/home/t", ANVIL_HOST: "127.0.0.1" } as Record<string, string | undefined>;

test("defaults apply when numeric env is unset", () => {
  const c = loadConfig({ ...base });
  expect(c.port).toBe(7701);
  expect(c.warnFraction).toBe(0.8);
  expect(c.softStopFraction).toBe(0.95);
});

test("valid numeric env is parsed", () => {
  const c = loadConfig({ ...base, ANVIL_PORT: "8080", ANVIL_BUDGET_WARN: "0.5" });
  expect(c.port).toBe(8080);
  expect(c.warnFraction).toBe(0.5);
});

test("a non-numeric port is a clear error, not a silent NaN", () => {
  expect(() => loadConfig({ ...base, ANVIL_PORT: "77O1" })).toThrow(/ANVIL_PORT/);
});

test("an out-of-range port is rejected", () => {
  expect(() => loadConfig({ ...base, ANVIL_PORT: "0" })).toThrow(/ANVIL_PORT/);
  expect(() => loadConfig({ ...base, ANVIL_PORT: "70000" })).toThrow(/ANVIL_PORT/);
  expect(() => loadConfig({ ...base, ANVIL_PORT: "8080.5" })).toThrow(/ANVIL_PORT/);
});

test("out-of-range budget fractions are rejected", () => {
  expect(() => loadConfig({ ...base, ANVIL_BUDGET_WARN: "1.5" })).toThrow(/ANVIL_BUDGET_WARN/);
  expect(() => loadConfig({ ...base, ANVIL_BUDGET_SOFTSTOP: "abc" })).toThrow(/ANVIL_BUDGET_SOFTSTOP/);
});
