/**
 * The environment handed to the Agent SDK subprocess (arch §3).
 *
 * The SDK's `env` option REPLACES the environment, so we build an explicit allow-list per spawn. Two
 * model profiles share this path:
 *
 *  - "claude" (default): drives Claude Code against Anthropic on the subscription OAuth token. Carries
 *    CLAUDE_CODE_OAUTH_TOKEN and deliberately OMITS ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so a
 *    metered key can never leak into the agent, even if one appears in the daemon's own environment.
 *
 *  - "glm": drives the SAME Agent SDK against OpenRouter's Anthropic-compatible endpoint (its "Anthropic
 *    Skin") with the OpenRouter key, so GLM gets the full agentic tool/worktree machinery Claude uses.
 *    This sets ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN in the SUBPROCESS env only. The daemon's own
 *    process.env is never touched, so the §3 startup guard (which governs the daemon, not its children)
 *    is unaffected — the guard forbids Anthropic keys in the daemon; here they live only in the child,
 *    and the value is an OpenRouter key, not a metered Anthropic one.
 */

export type ModelProfile = "claude" | "glm";

/** OpenRouter's Anthropic-compatible base URL ("Anthropic Skin"): the Agent SDK speaks its native
 *  protocol here and OpenRouter maps the `model` slug (e.g. "z-ai/glm-5.2") to the right provider. */
export const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";

/** Non-secret basics every spawned agent needs, regardless of model provider. */
const BASE_KEEP = [
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

export function buildAgentEnv(
  opts: { profile?: ModelProfile; src?: Record<string, string | undefined> } = {},
): Record<string, string> {
  const src = opts.src ?? process.env;
  const profile = opts.profile ?? "claude";
  // _ZO_DOCTOR=0 silences zoxide's "detected a configuration issue" banner in spawned shells
  // (the Bash tool + terminal PTY), which otherwise spams tool output and the terminal.
  const out: Record<string, string> = { _ZO_DOCTOR: "0" };
  for (const k of BASE_KEEP) {
    const v = src[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  if (profile === "glm") {
    // Point the SDK at OpenRouter with the OpenRouter key as the bearer. Note we do NOT carry the Claude
    // subscription token into a GLM spawn — that would risk auth-precedence confusion.
    const key = (src.OPENROUTER_API_KEY ?? "").trim();
    if (!key) throw new Error("GLM agent profile requires OPENROUTER_API_KEY (set it in Settings → Models)");
    out.ANTHROPIC_BASE_URL = OPENROUTER_ANTHROPIC_BASE_URL;
    out.ANTHROPIC_AUTH_TOKEN = key;
  } else {
    const tok = src.CLAUDE_CODE_OAUTH_TOKEN;
    if (typeof tok === "string" && tok.length > 0) out.CLAUDE_CODE_OAUTH_TOKEN = tok;
  }
  return out;
}
