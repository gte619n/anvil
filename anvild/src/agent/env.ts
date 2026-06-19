/**
 * The environment handed to the Agent SDK subprocess (arch §3).
 *
 * The SDK's `env` option REPLACES the environment, so we build an explicit allow-list that
 * carries the OAuth token and the basics Claude Code needs — and deliberately OMITS
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so a metered key can never leak into the agent,
 * even if one somehow appears in the daemon's own environment.
 */
const KEEP = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TERM",
  "USER",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
] as const;

export function buildAgentEnv(src: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEEP) {
    const v = src[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}
