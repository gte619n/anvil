/**
 * The expectation evaluator (agent-cad-and-browser spec §4.1). An `Expr` is a number, or a string of
 * arithmetic over the design's parameter names: `+ - * / ^ ( )`, unary minus, `pi`, numbers and
 * names. Nothing else — no functions, no units, no member access — and no `eval`: the string is
 * tokenised and walked by hand, so an expectation can never run code.
 *
 * A formula is what lets the owner's parameter change re-derive an expected value without trusting
 * the measurement (§4.5).
 */
export type Expr = number | string;

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

type Tok = { k: "num"; v: number; at: number } | { k: "name"; v: string; at: number } | { k: "op"; v: string; at: number };

const NUMBER_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME_RE = /^[A-Za-z_][A-Za-z_0-9]*/;
const MAX_LENGTH = 500;
const MAX_DEPTH = 64;

function tokenize(src: string): Tok[] {
  if (src.length > MAX_LENGTH) throw new ExprError(`expression is too long (${src.length} characters; the limit is ${MAX_LENGTH})`);
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const num = NUMBER_RE.exec(rest);
    if (num) {
      toks.push({ k: "num", v: Number(num[0]), at: i });
      i += num[0].length;
      continue;
    }
    const name = NAME_RE.exec(rest);
    if (name) {
      toks.push({ k: "name", v: name[0], at: i });
      i += name[0].length;
      continue;
    }
    if ("+-*/^()".includes(c)) {
      toks.push({ k: "op", v: c, at: i });
      i++;
      continue;
    }
    throw new ExprError(`unexpected character ${JSON.stringify(c)} at position ${i + 1} in ${JSON.stringify(src)} (allowed: numbers, parameter names, pi, + - * / ^ and parentheses)`);
  }
  return toks;
}

/** The parameter names an expression refers to (`pi` is not one), in first-use order. */
export function exprNames(src: Expr): string[] {
  if (typeof src === "number") return [];
  const out: string[] = [];
  for (const t of tokenize(String(src))) if (t.k === "name" && t.v !== "pi" && !out.includes(t.v)) out.push(t.v);
  return out;
}

/**
 * Evaluate an `Expr` against parameter values. Throws `ExprError` with a plain message for anything
 * it cannot read, an unknown parameter, a division by zero or a result that is not a finite number.
 * Precedence: `^` (right-associative) binds tighter than unary minus, then `* /`, then `+ -`.
 */
export function evalExpr(src: Expr, params: Readonly<Record<string, number>> = {}): number {
  if (typeof src === "number") {
    if (!Number.isFinite(src)) throw new ExprError("the value is not a finite number");
    return src;
  }
  if (typeof src !== "string") throw new ExprError("an expression must be a number or a string");
  const text = src;
  const toks = tokenize(text);
  if (toks.length === 0) throw new ExprError("the expression is empty");
  let i = 0;
  const peek = (): Tok | undefined => toks[i];
  const isOp = (v: string): boolean => {
    const t = toks[i];
    return !!t && t.k === "op" && t.v === v;
  };
  const bad = (what: string): never => {
    throw new ExprError(`${what} in ${JSON.stringify(text)}`);
  };

  const primary = (depth: number): number => {
    if (depth > MAX_DEPTH) bad("the expression is nested too deeply");
    const t = toks[i++];
    if (!t) return bad("unexpected end of the expression");
    if (t.k === "num") return t.v;
    if (t.k === "name") {
      if (t.v === "pi") return Math.PI;
      if (!Object.prototype.hasOwnProperty.call(params, t.v)) return bad(`unknown parameter \`${t.v}\``);
      const v = params[t.v];
      if (typeof v !== "number" || !Number.isFinite(v)) return bad(`parameter \`${t.v}\` has no numeric value`);
      return v;
    }
    if (t.v === "(") {
      const v = sum(depth + 1);
      if (!isOp(")")) bad("missing `)`");
      i++;
      return v;
    }
    return bad(`unexpected \`${t.v}\` at position ${t.at + 1}`);
  };
  const power = (depth: number): number => {
    const base = primary(depth);
    if (isOp("^")) {
      i++;
      return Math.pow(base, unary(depth + 1)); // right-associative; the exponent may be signed
    }
    return base;
  };
  const unary = (depth: number): number => {
    if (depth > MAX_DEPTH) bad("the expression is nested too deeply");
    if (isOp("-")) {
      i++;
      return -unary(depth + 1);
    }
    if (isOp("+")) {
      i++;
      return unary(depth + 1);
    }
    return power(depth);
  };
  const product = (depth: number): number => {
    let v = unary(depth);
    while (isOp("*") || isOp("/")) {
      const op = (toks[i++] as Tok).v;
      const r = unary(depth);
      if (op === "/" && r === 0) bad("division by zero");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (depth: number): number => {
    let v = product(depth);
    while (isOp("+") || isOp("-")) {
      const op = (toks[i++] as Tok).v;
      const r = product(depth);
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };

  const v = sum(0);
  const left = peek();
  if (left) bad(`unexpected \`${left.v}\` at position ${left.at + 1}`);
  if (!Number.isFinite(v)) bad("the result is not a finite number");
  return v;
}
