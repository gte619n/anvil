import type { Session as SessionData } from "@protocol";

/**
 * The protected check (agent-cad-and-browser spec §4.4): a small, pluggable list of rules that the
 * permission gate consults at the very top of `decide()` — BEFORE the remembered-allow lookup and
 * BEFORE the `bypass` short-circuit. It exists for the handful of actions that must not be waved
 * through by autonomy policy or by an earlier "always allow": changing locked expectations, cutting a
 * release, editing files the daemon owns, driving the managed binaries from Bash.
 *
 * A rule returns one of:
 *  - `deny`           — refused outright with the reason; no prompt, whatever the policy.
 *  - `always-prompt`  — a permission card is parked on EVERY call, under every policy including
 *                       `bypass`, offering only Allow once / Deny. An `allow_always` answer is treated
 *                       as allow-once and never remembered. With `denyWhenUnattended`, an unattended
 *                       session (`isUnattended`) is denied instead, because no one is there to answer.
 *  - `owner-card`     — the tool parks its OWN typed owner card on every call (old and new values,
 *                       Approve / Deny, no "always allow"), so a generic permission card in front of
 *                       it would only ask the same question twice. The gate lets the call through
 *                       with no prompt under every policy, never remembers it, and DENIES it in an
 *                       unattended session, where no one could answer the card.
 *  - `undefined`      — the rule has no opinion; the normal permission flow applies.
 *
 * This module is deliberately dependency-light (types only — no Supervisor, no Session class) so
 * any feature module can register a rule without creating an import cycle. No rules are registered
 * here: each feature registers its own when it is switched on.
 */
export type ProtectedVerdict =
  | { kind: "deny"; reason: string }
  | {
      kind: "always-prompt";
      reason: string;
      /** Label for the card's allow button (default "Allow once"), e.g. "Release this part". */
      label?: string;
      /** Deny, with no card, when the session is unattended (see `isUnattended`). */
      denyWhenUnattended?: boolean;
    }
  | { kind: "owner-card"; reason: string }
  | undefined;

/** The slice of a session a rule (and `isUnattended`) may read. A real `Session` satisfies it. */
export interface ProtectedSession {
  id: string;
  data: SessionData;
}

export interface ProtectedContext {
  session: ProtectedSession;
  tool: string;
  input: Record<string, unknown>;
  /** The session's working directory (its worktree) — what relative tool paths resolve against. */
  cwd: string;
}

export type ProtectedRule = (ctx: ProtectedContext) => ProtectedVerdict;

const rules: ProtectedRule[] = [];

/** Add a rule to the registry. Returns a thunk that removes exactly that registration. Registering
 *  the same function twice is a no-op, so a feature's idempotent init can't double-register. */
export function registerProtectedRule(rule: ProtectedRule): () => void {
  if (!rules.includes(rule)) rules.push(rule);
  return () => {
    const i = rules.indexOf(rule);
    if (i >= 0) rules.splice(i, 1);
  };
}

/**
 * Consult every registered rule. Precedence: any `deny` outranks any `always-prompt` (the first deny
 * in registration order wins); otherwise the first non-undefined verdict wins; `undefined` when no
 * rule has an opinion. A rule that THROWS is treated as a deny — this is a safety gate, so a buggy
 * rule must fail closed rather than silently let the tool through.
 */
export function protectedVerdict(ctx: ProtectedContext): ProtectedVerdict {
  let first: ProtectedVerdict;
  for (const rule of rules) {
    let v: ProtectedVerdict;
    try {
      v = rule(ctx);
    } catch (e) {
      return { kind: "deny", reason: `protected check failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!v) continue;
    if (v.kind === "deny") return v;
    first ??= v;
  }
  return first;
}

/**
 * Whether nobody is watching this session to answer a card: an autopilot BUILDER session (spec
 * §4.11). A planner session is attended — it is the "Plan with Claude" chat the owner is in.
 */
export function isUnattended(session: ProtectedSession): boolean {
  return session.data.workUnitRole === "builder";
}

/** Test-only: drop every registered rule so one test's rules can't leak into the next. */
export function resetProtectedRulesForTest(): void {
  rules.length = 0;
}
