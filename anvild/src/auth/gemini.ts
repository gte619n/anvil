import { envFile, envFileHasKey, mask, readEnvKey, removeEnvLine, upsertEnvLine } from "./env-file";

/**
 * The daemon's Google Gemini API key, set/reset from Settings → Models (auth.set/clear with
 * provider:"gemini"). Lets the adversarial planning panel call Gemini DIRECTLY through Google's
 * OpenAI-compatible endpoint (integrations/openrouter.ts `geminiClient`) instead of via OpenRouter.
 *
 * Mirrors auth/openrouter.ts exactly: a metered third-party key outside the §3 subscription-auth guard
 * (which governs Anthropic auth only), persisted to the launcher env file, applied to this process's env
 * live, and never echoed back to clients — only a masked preview.
 */
export const GEMINI_KEY = "GEMINI_API_KEY";

export interface GeminiAuthStatus {
  provider: "gemini";
  connected: boolean;
  persisted: boolean;
  masked?: string;
}

export function geminiAuthStatus(env: NodeJS.ProcessEnv = process.env, file: string = envFile()): GeminiAuthStatus {
  const key = (env[GEMINI_KEY] ?? "").trim();
  return {
    provider: "gemini",
    connected: key.length > 0,
    persisted: envFileHasKey(file, GEMINI_KEY),
    ...(key ? { masked: mask(key) } : {}),
  };
}

export function setGeminiKey(key: string, file: string = envFile()): GeminiAuthStatus {
  const k = key.trim();
  if (!k) throw new Error("a Gemini API key is required");
  process.env[GEMINI_KEY] = k;
  upsertEnvLine(file, GEMINI_KEY, k);
  return geminiAuthStatus(process.env, file);
}

export function clearGeminiKey(file: string = envFile()): GeminiAuthStatus {
  delete process.env[GEMINI_KEY];
  removeEnvLine(file, GEMINI_KEY);
  return geminiAuthStatus(process.env, file);
}

/** Startup hook: load a UI-set key from the env file when the launcher didn't export it. */
export function loadPersistedGeminiKey(file: string = envFile()): void {
  if ((process.env[GEMINI_KEY] ?? "").trim()) return;
  const value = readEnvKey(file, GEMINI_KEY);
  if (value) process.env[GEMINI_KEY] = value;
}
