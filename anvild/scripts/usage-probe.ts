#!/usr/bin/env bun
/**
 * Plan-usage probe: does the Agent SDK's usage call return rate-limit windows for this machine's token?
 *
 * Why this exists: the sidebar usage meter is fed by `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`.
 * The CLI only answers it when it believes the token carries the `user:profile` scope, and for a token
 * supplied via CLAUDE_CODE_OAUTH_TOKEN it assumes `user:inference` only (unless CLAUDE_CODE_OAUTH_SCOPES
 * says otherwise). So under the daemon it reports `rate_limits_available: false` and the meter never fills.
 *
 * This runs the SAME call the daemon makes, twice, after one tiny Haiku turn (so the CLI has seen fresh
 * rate-limit response headers):
 *   A. as the daemon does today (no CLAUDE_CODE_OAUTH_SCOPES);
 *   B. with CLAUDE_CODE_OAUTH_SCOPES="user:inference user:profile".
 * Then it calls GET /api/oauth/usage directly, which tells us whether the token really has profile scope.
 *
 * Run on a daemon host, from the canonical checkout (uses ~2 tiny Haiku turns of plan usage):
 *   cd anvild && (set -a; . ~/.config/anvil/env; bun scripts/usage-probe.ts)
 * Prints no secrets.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeCliOptions } from "../src/agent/cli";
import { InputQueue, userMessage } from "../src/agent/input-queue";

const token = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
if (!token) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN is not set — run via: (set -a; . ~/.config/anvil/env; bun scripts/usage-probe.ts)");
  process.exit(2);
}
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is set — that would meter per token; unset it first.");
  process.exit(2);
}

async function probe(label: string, extraEnv: Record<string, string>): Promise<void> {
  const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: token, ...extraEnv };
  for (const k of ["PATH", "HOME", "USER", "TMPDIR", "LANG"]) if (process.env[k]) env[k] = process.env[k]!;
  const input = new InputQueue();
  const q = query({
    prompt: input,
    options: { model: "haiku", settingSources: [], env, permissionMode: "default", ...claudeCliOptions() },
  });
  input.push(userMessage("Reply with exactly: ok"));
  const events: string[] = [];
  try {
    // Pull messages by hand: `break` out of a for-await would call return() and close the query — the
    // usage call below needs the CLI still running, exactly like the daemon's long-lived query.
    const it = q[Symbol.asyncIterator]();
    for (;;) {
      const { value: m, done } = await it.next();
      if (done) break;
      if (m.type === "rate_limit_event") events.push(JSON.stringify((m as { rate_limit_info?: unknown }).rate_limit_info));
      if (m.type === "result") {
        if ((m as { is_error?: boolean }).is_error) console.log(`(turn error: ${JSON.stringify((m as { result?: unknown }).result ?? "")})`);
        break;
      }
    }
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    console.log(`\n── ${label}`);
    console.log(`subscription_type:     ${u?.subscription_type ?? "null"}`);
    console.log(`rate_limits_available: ${u?.rate_limits_available}`);
    console.log(`rate_limits:           ${JSON.stringify(u?.rate_limits ?? null, null, 2)}`);
    if (events.length) console.log(`rate_limit_event(s):   ${events.join("\n                       ")}`);
  } catch (e) {
    console.log(`\n── ${label}\nERROR: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    input.close();
    await q.interrupt().catch(() => {});
  }
}

await probe("A. as the daemon runs today (default scopes)", {});
await probe('B. with CLAUDE_CODE_OAUTH_SCOPES="user:inference user:profile"', { CLAUDE_CODE_OAUTH_SCOPES: "user:inference user:profile" });

// C. The endpoint itself: 200 = the token has profile scope (full data incl. Opus/Sonnet weekly);
//    401/403 = inference-only token (B can still work from response headers — the CLI's "seeded" fallback).
try {
  const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
  });
  const body = await r.text();
  console.log(`\n── C. GET /api/oauth/usage directly\nHTTP ${r.status}\n${body.slice(0, 1500)}`);
} catch (e) {
  console.log(`\n── C. GET /api/oauth/usage directly\nERROR: ${e instanceof Error ? e.message : String(e)}`);
}
process.exit(0);
