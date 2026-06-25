import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/** The env file the launchd launcher sources (`set -a; . "$HOME/.config/anvil/env"`). Mirrors
 *  scripts/service.sh exactly — do NOT swap in XDG_CONFIG_HOME here or the daemon would write a file
 *  the launcher never reads, and a UI-set token would vanish on the next restart. */
export function authEnvFile(home: string = homedir()): string {
  return join(home, ".config", "anvil", "env");
}

/** Show enough of a token to recognise it without leaking it (first 8 + last 4 chars). */
function mask(token: string): string {
  const t = token.trim();
  if (t.length <= 14) return "•".repeat(t.length);
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

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
    persisted: envFileHasToken(file),
    ...(tok ? { masked: mask(tok) } : {}),
  };
}

/** True if the persisted env file already carries a CLAUDE_CODE_OAUTH_TOKEN line. */
function envFileHasToken(file: string = authEnvFile()): boolean {
  if (!existsSync(file)) return false;
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .some((l) => l.replace(/^export\s+/, "").startsWith(`${CLAUDE_TOKEN_KEY}=`));
  } catch {
    return false;
  }
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
  if (!existsSync(file)) return;
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.replace(/^export\s+/, "").trim();
      if (!line.startsWith(`${CLAUDE_TOKEN_KEY}=`)) continue;
      const value = stripQuotes(line.slice(CLAUDE_TOKEN_KEY.length + 1));
      if (value && !looksLikeMeteredKey(value)) process.env[CLAUDE_TOKEN_KEY] = value;
      return;
    }
  } catch {
    /* unreadable file — fall through; the §3 guard reports the missing token */
  }
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

/** Rewrite `file` with `KEY=value` set (preserving every other line), creating it 0600 if absent. */
function upsertEnvLine(file: string, key: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const kept = lines.filter((l) => {
    const bare = l.replace(/^export\s+/, "");
    return !bare.startsWith(`${key}=`);
  });
  // Drop a trailing empty line so we don't accumulate blank lines on repeated writes.
  while (kept.length && kept[kept.length - 1]!.trim() === "") kept.pop();
  kept.push(`${key}=${value}`);
  writeFileSync(file, `${kept.join("\n")}\n`, { mode: 0o600 });
}

/** Remove any `KEY=…` line from `file` (no-op if the file or line is absent). */
function removeEnvLine(file: string, key: string): void {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n");
  const kept = lines.filter((l) => !l.replace(/^export\s+/, "").startsWith(`${key}=`));
  writeFileSync(file, kept.join("\n"), { mode: 0o600 });
}
