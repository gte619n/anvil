/**
 * [A2] The expectation evaluator (agent-cad-and-browser spec §4.1): `+ - * / ^ ( )`, unary minus,
 * `pi`, numbers and parameter names — and nothing else.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExprError, evalExpr, exprNames } from "../../src/cadwork/expr";

const P = { L: 80, W: 50, T: 6, inset: 8 };

describe("cad expr", () => {
  test("[A2] numbers, the four operators, powers, parentheses and unary minus follow ordinary precedence", () => {
    expect(evalExpr(42)).toBe(42);
    expect(evalExpr("1 + 2 * 3")).toBe(7);
    expect(evalExpr("(1 + 2) * 3")).toBe(9);
    expect(evalExpr("10 / 4")).toBe(2.5);
    expect(evalExpr("2 ^ 3 ^ 2")).toBe(512); // right-associative
    expect(evalExpr("-2 ^ 2")).toBe(-4); // the power binds tighter than the sign
    expect(evalExpr("(-2) ^ 2")).toBe(4);
    expect(evalExpr("2 ^ -1")).toBe(0.5);
    expect(evalExpr("--3")).toBe(3);
    expect(evalExpr("+3 - -2")).toBe(5);
    expect(evalExpr("1.5e2 + .5")).toBe(150.5);
    expect(evalExpr("  7  ")).toBe(7);
  });

  test("[A2] parameter names and pi are looked up; the plate's documented volume formula gives 23335.167 mm³", () => {
    expect(evalExpr("L", P)).toBe(80);
    expect(evalExpr("L/2 - inset", P)).toBe(32);
    expect(evalExpr("pi", {})).toBe(Math.PI);
    expect(evalExpr("2*pi*inset", P)).toBeCloseTo(50.2654825, 6);
    const volume = "L*W*T - (4 - pi)*5^2*T - 4*(pi*1.7^2*(T - 3.3) + pi*3.25^2*3.3)";
    expect(evalExpr(volume, P)).toBeCloseTo(23335.166952, 5);
    expect(evalExpr(volume, { ...P, L: 120 })).toBeCloseTo(35335.166952, 5);
    expect(exprNames(volume)).toEqual(["L", "W", "T"]);
    expect(exprNames(3)).toEqual([]);
    // `pi` is the constant even when a parameter of that name exists.
    expect(evalExpr("pi", { pi: 3 })).toBe(Math.PI);
  });

  test("[A2] anything else is refused with a clear error: unknown names, functions, units, bad syntax, division by zero", () => {
    const bad: [string, string][] = [
      ["H", "unknown parameter `H`"],
      ["sin(1)", "unknown parameter `sin`"],
      ["L mm", "unexpected `mm`"],
      ["80 mm", "unexpected `mm`"],
      ["1 +", "unexpected end"],
      ["(1 + 2", "missing `)`"],
      ["1 + 2)", "unexpected `)`"],
      ["", "empty"],
      ["   ", "empty"],
      ["1 / 0", "division by zero"],
      ["L / (W - 50)", "division by zero"],
      ["1 ; 2", "unexpected character"],
      ["a.b", "unexpected character"],
      ["x = 1", "unexpected character"],
      ["`id`", "unexpected character"],
      ["1e999", "not a finite number"],
      ["10 ^ 400", "not a finite number"],
      ["* 2", "unexpected `*`"],
    ];
    for (const [src, message] of bad) {
      let err: unknown;
      try {
        evalExpr(src, P);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ExprError);
      expect((err as Error).message).toContain(message);
    }
    expect(() => evalExpr(NaN)).toThrow(ExprError);
    expect(() => evalExpr({} as never)).toThrow(ExprError);
    expect(() => evalExpr("x".repeat(600), { x: 1 })).toThrow("too long");
    expect(() => evalExpr("(".repeat(100) + "1" + ")".repeat(100))).toThrow("nested too deeply");
    expect(() => evalExpr("L", { L: Number.NaN })).toThrow("no numeric value");
  });

  test("[A2] it never runs code: object-prototype names are unknown parameters and the source uses no eval or Function", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "process", "globalThis", "require"]) {
      expect(() => evalExpr(name, {})).toThrow(`unknown parameter \`${name}\``);
      expect(() => evalExpr(`${name}(1)`, {})).toThrow(ExprError);
    }
    const source = readFileSync(join(import.meta.dir, "..", "..", "src", "cadwork", "expr.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/\bFunction\s*\(/);
    expect(code).not.toMatch(/new\s+Function/);
    expect(code).not.toContain("import(");
  });
});
