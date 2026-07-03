import { envFile, envFileHasKey, mask, readEnvKey, removeEnvLine, upsertEnvLine } from "./env-file";

/**
 * The daemon's OpenRouter API key, set/reset from Settings → Models (auth.set/clear with
 * provider:"openrouter"). Powers the adversarial planning panel (integrations/adversarial.ts).
 *
 * Unlike the Claude token, this is DELIBERATELY a metered third-party key — OpenRouter is a different
 * provider, entirely outside the §3 subscription-auth guard (which only governs Anthropic auth). So it
 * gets NO metered-key rejection. It's persisted to the same launcher env file so it survives a restart,
 * and setting it updates this process's env live so `loadConfig()`-derived reads pick it up on the next
 * autopilot run without a daemon restart. Never echoed back to clients — only a masked preview.
 */
export const OPENROUTER_KEY = "OPENROUTER_API_KEY";

export interface OpenRouterAuthStatus {
  provider: "openrouter";
  connected: boolean; // a non-empty key is present in this process's environment
  persisted: boolean; // the key is written to the env file, so it survives a service restart
  masked?: string;
}

export function openRouterAuthStatus(env: NodeJS.ProcessEnv = process.env, file: string = envFile()): OpenRouterAuthStatus {
  const key = (env[OPENROUTER_KEY] ?? "").trim();
  return {
    provider: "openrouter",
    connected: key.length > 0,
    persisted: envFileHasKey(file, OPENROUTER_KEY),
    ...(key ? { masked: mask(key) } : {}),
  };
}

/** Set/replace the OpenRouter key: update this process's env (live) and the launcher env file (durable). */
export function setOpenRouterKey(key: string, file: string = envFile()): OpenRouterAuthStatus {
  const k = key.trim();
  if (!k) throw new Error("an OpenRouter API key is required");
  process.env[OPENROUTER_KEY] = k;
  upsertEnvLine(file, OPENROUTER_KEY, k);
  return openRouterAuthStatus(process.env, file);
}

/** Remove the OpenRouter key from this process and the persisted env file (disables the panel). */
export function clearOpenRouterKey(file: string = envFile()): OpenRouterAuthStatus {
  delete process.env[OPENROUTER_KEY];
  removeEnvLine(file, OPENROUTER_KEY);
  return openRouterAuthStatus(process.env, file);
}

/**
 * Startup hook: if the key isn't already in the environment (e.g. a dev run, or a launcher that didn't
 * source the file), load it from the persisted env file so a UI-set key is honoured on the next start.
 */
export function loadPersistedOpenRouterKey(file: string = envFile()): void {
  if ((process.env[OPENROUTER_KEY] ?? "").trim()) return;
  const value = readEnvKey(file, OPENROUTER_KEY);
  if (value) process.env[OPENROUTER_KEY] = value;
}
