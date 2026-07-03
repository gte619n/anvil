import { envFile, envFileHasKey, mask, readEnvKey, removeEnvLine, upsertEnvLine } from "./env-file";

/**
 * The daemon's Claude subscription OAuth token, set/reset from the UI (auth.set / auth.clear).
 *
 * The token must satisfy the arch §3 invariant: CLAUDE_CODE_OAUTH_TOKEN set, ANTHROPIC_API_KEY unset.
 * It lives in the SAME file the launchd launcher sources on every start — `$HOME/.config/anvil/env`
 * (see scripts/service.sh) — so a token written here survives a service restart instead of being
 * silently reverted to whatever the launcher exported. Setting it also updates this process's
 * `process.env` live, so the next agent/planning run picks it up without a restart (the agent env is
 * built per-spawn from process.env; see agent/env.ts and integrations/autopilot.ts).
 *
 * We deliberately never echo the token back to clients — only a masked preview and whether it's set.
 */
export const CLAUDE_TOKEN_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

/** Auth provider id. Only "claude" is functional today; the field exists so the settings UI and this
 *  store can grow additional providers (Gemini/ChatGPT) without a protocol change. */
export type AuthProvider = "claude";

export interface AuthStatus {
  provider: AuthProvider;
  connected: boolean; // a non-empty token is present in this process's environment
  persisted: boolean; // the token is written to the env file, so it survives a service restart
  masked?: string; // e.g. "sk-ant-…últ4f2" — enough to recognise, never the full secret
}

/** The env file the launchd launcher sources — see auth/env-file.ts (`envFile`). Re-exported under the
 *  historical name so existing call sites keep working. */
export const authEnvFile = envFile;

/** A value that looks like a metered API key rather than a subscription OAuth token. §3 forbids it:
 *  ANTHROPIC_API_KEY-style credentials outrank the OAuth token and would bill per-token. */
export function looksLikeMeteredKey(token: string): boolean {
  return /^sk-ant-api/i.test(token.trim());
}

export function claudeAuthStatus(env: NodeJS.ProcessEnv = process.env, file: string = authEnvFile()): AuthStatus {
  const tok = (env[CLAUDE_TOKEN_KEY] ?? "").trim();
  return {
    provider: "claude",
    connected: tok.length > 0,
    persisted: envFileHasKey(file, CLAUDE_TOKEN_KEY),
    ...(tok ? { masked: mask(tok) } : {}),
  };
}

/**
 * Validate + persist a new Claude OAuth token: update this process's env (live, for the next run) and
 * upsert it into the launcher's env file (durable across restarts). Throws on an empty or metered key.
 */
export function setClaudeToken(token: string, file: string = authEnvFile()): AuthStatus {
  const t = token.trim();
  if (!t) throw new Error("a Claude OAuth token is required");
  if (looksLikeMeteredKey(t)) {
    throw new Error("that looks like a metered ANTHROPIC_API_KEY, not a subscription OAuth token — run `claude setup-token` and paste that token instead (arch §3)");
  }
  process.env[CLAUDE_TOKEN_KEY] = t;
  upsertEnvLine(file, CLAUDE_TOKEN_KEY, t);
  return claudeAuthStatus(process.env, file);
}
// (env-file read/write primitives live in ./env-file and are shared with the OpenRouter key store.)

/** Remove the Claude token from this process and the persisted env file. The next agent run will have
 *  no token until one is set again (the §3 startup guard still applies on the next restart). */
export function clearClaudeToken(file: string = authEnvFile()): AuthStatus {
  delete process.env[CLAUDE_TOKEN_KEY];
  removeEnvLine(file, CLAUDE_TOKEN_KEY);
  return claudeAuthStatus(process.env, file);
}

/**
 * Startup hook: if the OAuth token isn't already in the environment (e.g. a dev run, or a launcher
 * that didn't source the file), load just that one key from the persisted env file so a UI-set token
 * is honoured on the next start. Only CLAUDE_CODE_OAUTH_TOKEN is loaded — never ANTHROPIC_API_KEY,
 * which §3 forbids — so this can't reintroduce a metered key.
 */
export function loadPersistedClaudeToken(file: string = authEnvFile()): void {
  if ((process.env[CLAUDE_TOKEN_KEY] ?? "").trim()) return;
  const value = readEnvKey(file, CLAUDE_TOKEN_KEY);
  // Never reintroduce a metered key — §3 forbids it, so the guard would refuse to start anyway.
  if (value && !looksLikeMeteredKey(value)) process.env[CLAUDE_TOKEN_KEY] = value;
}
