import { AccountStore } from "./accounts";
import { envFileHasKey, looksLikeMeteredKey, readEnvKey } from "./env-file";
import { authEnvFile, CLAUDE_TOKEN_KEY, clearClaudeToken, setClaudeToken } from "./store";

/**
 * Mirror the roster's default account into `~/.config/anvil/env` (multi-account design §3.2).
 *
 * ALWAYS routes through `setClaudeToken()` rather than writing the env line directly. That function
 * is what rejects a metered key (§3), writes `process.env` and the file together, and — crucially —
 * calls `clearBoundDegradeMarker()`. A direct `upsertEnvLine()` here would leave an auto-degraded
 * daemon degraded after the user had visibly fixed the credential (auth/degrade.ts).
 *
 * Never throws: a roster mutation must still succeed on a box whose env file is read-only. The caller
 * surfaces `persisted: false` as "won't survive a restart", matching the existing `persistWarn` card.
 */
export interface MirrorResult {
  persisted: boolean;
  error?: string;
}

export function mirrorDefault(store: AccountStore, file: string | undefined = authEnvFile()): MirrorResult {
  const token = store.token(undefined);
  try {
    if (!token) {
      clearClaudeToken(file);
      return { persisted: true };
    }
    setClaudeToken(token, file);
    return { persisted: true };
  } catch (e) {
    return { persisted: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Read-only counterpart to `mirrorDefault()` — is the roster's default token CURRENTLY durable in the
 * env file? Never writes/clears anything, so it's safe to call from a plain getter (the WS connect
 * burst, `auth.accounts.get`) without the side effect of stomping a token that lives outside the
 * roster entirely (e.g. a dev box that only ever set `CLAUDE_CODE_OAUTH_TOKEN` directly). An empty
 * roster has nothing to persist, so it reports true — there's nothing at risk of being lost.
 */
export function defaultPersisted(store: AccountStore, file: string | undefined = authEnvFile()): boolean {
  const token = store.token(undefined);
  if (!token) return true;
  return envFileHasKey(file, CLAUDE_TOKEN_KEY) && readEnvKey(file, CLAUDE_TOKEN_KEY) === token;
}

/**
 * One-way boot migration (§3.3): an install that predates the roster has its token only in
 * `~/.config/anvil/env`. Seed it as the `default` account so the upgrade is zero-touch.
 *
 * Idempotent — returns false and does nothing once the roster is non-empty, so it is safe to call on
 * every boot. Never seeds a metered key (the §3 guard would refuse that token anyway) and never
 * writes into a replica, whose contents belong to its hub.
 */
export function seedFromEnv(store: AccountStore, env: Record<string, string | undefined> = process.env): boolean {
  if (!store.isEmpty() || store.snapshot().role === "replica") return false;
  const tok = (env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  if (!tok || looksLikeMeteredKey(tok)) return false;
  store.add("default", tok);
  return true;
}
