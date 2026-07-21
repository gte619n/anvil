import { looksLikeMeteredKey } from "./env-file";

/**
 * Auth & billing guard — arch §3 (load-bearing).
 *
 * The daemon MUST drive Claude Code with a subscription OAuth token and MUST NOT have a
 * metered API key in its environment. Claude Code's auth precedence puts ANTHROPIC_API_KEY
 * and ANTHROPIC_AUTH_TOKEN ABOVE CLAUDE_CODE_OAUTH_TOKEN, so a stray key silently switches
 * every turn to metered pay-per-token. This guard is the enforcement point.
 *
 * The two failure modes are NOT the same and are reported separately (headless-join §4.1):
 *  - a metered key present → **fatal**. §3 exists to prevent surprise per-token billing, so the
 *    daemon still refuses to start. Unchanged behaviour.
 *  - no subscription token → **degraded, not fatal**. An absent token can't cause a charge; its only
 *    consequence is that turns don't run. Exiting here is what made a freshly-installed headless box
 *    impossible to pair (there was no daemon left to receive a token), so the daemon now boots,
 *    reports `subscriptionAuthOk: false`, and offers the setup/pairing UI instead.
 */

export interface GuardStatus {
  /** A plausible subscription OAuth token is present (and no metered key outranks it). */
  subscriptionAuthOk: boolean;
  /** The §3 invariant is VIOLATED — a metered key would bill per-token. The daemon must not start. */
  fatal: boolean;
  reason?: string;
}

function isSet(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Pure check — no side effects. Used by /api/health and by the startup assertion.
 *
 * The two axes are independent, so all four combinations are defined (headless-join §4.1):
 *
 * | metered key | OAuth token       | fatal | subscriptionAuthOk |
 * |-------------|-------------------|-------|--------------------|
 * | set         | any               | true  | false (moot)       |
 * | unset       | plausible         | false | true               |
 * | unset       | absent/empty      | false | false              |
 * | unset       | `sk-ant-api…`     | false | false              |
 *
 * "Plausible" is a SHAPE check, not a validity check: a well-formed but revoked token still reports
 * `true` here until a turn actually fails. Auto-degrade (auth/degrade.ts) is what makes the flag
 * eventually truthful about a token that is merely wrong.
 */
export function checkAuth(env: Record<string, string | undefined> = process.env): GuardStatus {
  // Fatal first: a metered key outranks the OAuth token, so its presence decides the outcome
  // regardless of whether a subscription token is also set.
  if (isSet(env.ANTHROPIC_API_KEY)) {
    return {
      subscriptionAuthOk: false,
      fatal: true,
      reason:
        "ANTHROPIC_API_KEY is set — it outranks the OAuth token and would meter billing per-token. Unset it (arch §3).",
    };
  }
  if (isSet(env.ANTHROPIC_AUTH_TOKEN)) {
    return {
      subscriptionAuthOk: false,
      fatal: true,
      reason: "ANTHROPIC_AUTH_TOKEN is set — it outranks the OAuth token. Unset it (arch §3).",
    };
  }
  const token = env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  if (!isSet(token)) {
    return {
      subscriptionAuthOk: false,
      fatal: false,
      reason:
        "CLAUDE_CODE_OAUTH_TOKEN is not set — this machine can't run turns until it's paired with a fleet or a token is set in Settings → Auth.",
    };
  }
  if (looksLikeMeteredKey(token)) {
    return {
      subscriptionAuthOk: false,
      fatal: false,
      reason:
        "CLAUDE_CODE_OAUTH_TOKEN looks like a metered ANTHROPIC_API_KEY (`sk-ant-api…`), not a subscription token — run `claude setup-token` and use that value (arch §3).",
    };
  }
  return { subscriptionAuthOk: true, fatal: false };
}

/**
 * Startup gate for `main.ts`. Exits only on a §3 VIOLATION (a metered key). A missing token warns
 * loudly and continues, so the machine comes up degraded and can be paired from its own web UI
 * (headless-join §4.1) — sessions then refuse to spawn with an explicit message (agent/env.ts).
 */
export function assertSubscriptionAuth(env: Record<string, string | undefined> = process.env): void {
  const status = checkAuth(env);
  if (status.fatal) {
    console.error(`[anvild] FATAL — auth/billing guard (arch §3): ${status.reason}`);
    process.exit(1);
  }
  if (!status.subscriptionAuthOk) {
    console.warn(
      `[anvild] ⚠️  DEGRADED — no usable Claude subscription token: ${status.reason}\n` +
        "[anvild]    The daemon is running and reachable, but agent turns will refuse to start.\n" +
        "[anvild]    Open this machine's web UI to pair it with a fleet, or paste a token in Settings → Auth.",
    );
  }
}
