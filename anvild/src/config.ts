import { networkInterfaces } from "node:os";
import { DEFAULT_LAPO_BASE_URL, DEFAULT_LAPO_SCOPE, type LapoConfig } from "./integrations/lapo";

/** Runtime configuration, resolved from the environment. */
export interface Config {
  host: string;
  port: number;
  stateDir: string;
  /** Where the daemon clones repos added by git URL. Independent of the app's install location. */
  clonesDir: string;
  /** Warn threshold as a fraction (0–1) of any rate-limit window's utilization (arch §3). */
  warnFraction: number;
  /** Soft-stop threshold as a fraction (0–1) of the 7-day window's utilization (arch §3). */
  softStopFraction: number;
  /** OpenRouter API key for the adversarial planning panel. Its own provider/key — NOT Anthropic — so
   *  it lives entirely outside the §3 subscription-auth guard. Absent → the panel is skipped. */
  openRouterApiKey?: string;
  /** Competing models the adversarial panel critiques each plan with (OpenRouter slugs). */
  adversarialModels: string[];
  /** Whether the adversarial panel runs: true when a key is set, unless ANVIL_ADVERSARIAL=0 disables it. */
  adversarialEnabled: boolean;
  /** Preferred OpenRouter provider slug for the panel (e.g. "deepinfra"). Pins the critic to one
   *  provider so its implicit prompt cache stays warm across the agent loop's rounds — GLM has no
   *  explicit cache_control, so a stable, cheap-cache-read provider is the real cost lever. Falls back
   *  to normal routing for any model that provider can't serve (allow_fallbacks). Undefined → default routing. */
  adversarialProvider?: string;
}

/** OpenRouter slugs used by the adversarial panel when ANVIL_ADVERSARIAL_MODELS isn't set — an
 *  OpenAI Codex-class model and GLM 5.2 (1M context, strong at tool use / long agentic tasks, so it's
 *  well suited to the codebase-reading critic role). */
const DEFAULT_ADVERSARIAL_MODELS = ["openai/gpt-5-codex", "z-ai/glm-5.2"];

function expandHome(p: string, home: string): string {
  return p.startsWith("~") ? home + p.slice(1) : p;
}

/** [BE-misc] Parse a numeric env var with validation — a typo must fail loudly at startup, not
 *  silently become NaN (which would bind a garbage port or a NaN budget threshold). */
function numEnv(
  raw: string | undefined,
  fallback: number,
  label: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`invalid ${label}: ${JSON.stringify(raw)} is not a number`);
  if (opts.integer && !Number.isInteger(n)) throw new Error(`invalid ${label}: ${raw} must be an integer`);
  if (opts.min !== undefined && n < opts.min) throw new Error(`invalid ${label}: ${n} is below the minimum ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new Error(`invalid ${label}: ${n} is above the maximum ${opts.max}`);
  return n;
}

/** This host's Tailscale IPv4, if any: the CGNAT range 100.64.0.0/10 (second octet 64–127). Found
 *  from the OS network interfaces — no `tailscale` CLI needed. This is how the daemon makes itself
 *  reachable over the tailnet WITHOUT `tailscale serve` (which can fail per-machine). Binding to this
 *  specific address keeps it tailnet-only (not exposed on the LAN). */
export function tailnetIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const o = a.address.split(".").map(Number);
      if (o[0] === 100 && o[1]! >= 64 && o[1]! <= 127) return a.address;
    }
  }
  return undefined;
}

/**
 * Resolve the lapo integration's OAuth + entry-API surface from ANVIL_LAPO_* env, or `undefined` when
 * it isn't configured. The base URL defaults to `https://app.heylapo.com` and the OAuth endpoints are
 * DISCOVERED from its well-known metadata at runtime (RFC 8414), so the only required var is the client
 * id; the client secret is optional (omit it for a public / PKCE client). Read LIVE at the point of use
 * (not cached at startup) so setting these in the launcher env + restarting is enough — mirrors how the
 * OpenRouter key is read live. The *Path fallbacks apply only if discovery is unreachable.
 */
export function resolveLapoConfig(env: Record<string, string | undefined> = process.env): LapoConfig | undefined {
  const baseUrl = (env.ANVIL_LAPO_BASE_URL?.trim() || DEFAULT_LAPO_BASE_URL).replace(/\/+$/, "");
  const clientId = env.ANVIL_LAPO_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  const clientSecret = env.ANVIL_LAPO_CLIENT_SECRET?.trim();
  const path = (raw: string | undefined, fallback: string): string => {
    const p = raw?.trim() || fallback;
    return p.startsWith("/") ? p : `/${p}`;
  };
  return {
    baseUrl,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    authorizePath: path(env.ANVIL_LAPO_AUTHORIZE_PATH, "/oauth/authorize"),
    tokenPath: path(env.ANVIL_LAPO_TOKEN_PATH, "/oauth/token"),
    entryPath: path(env.ANVIL_LAPO_ENTRY_PATH, "/v1/journal/append"),
    whoamiPath: path(env.ANVIL_LAPO_WHOAMI_PATH, "/me"),
    scope: env.ANVIL_LAPO_SCOPE?.trim() || DEFAULT_LAPO_SCOPE,
    ...(env.ANVIL_LAPO_COLLECTION?.trim() ? { collection: env.ANVIL_LAPO_COLLECTION.trim() } : {}),
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = env.HOME ?? ".";
  // Default: bind the tailnet IP (reachable over the tailnet via plain HTTP, no `tailscale serve`),
  // falling back to localhost if this host isn't on a tailnet. `ANVIL_HOST` overrides (e.g. 127.0.0.1).
  const host = env.ANVIL_HOST || tailnetIPv4() || "127.0.0.1";
  const openRouterApiKey = env.OPENROUTER_API_KEY?.trim() || undefined;
  const adversarialModels = (env.ANVIL_ADVERSARIAL_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return {
    host,
    port: numEnv(env.ANVIL_PORT, 7701, "ANVIL_PORT", { min: 1, max: 65535, integer: true }),
    stateDir: expandHome(env.ANVIL_STATE_DIR ?? "~/.anvil", home),
    clonesDir: expandHome(env.ANVIL_CLONES_DIR ?? "~/.anvil/repos", home),
    warnFraction: numEnv(env.ANVIL_BUDGET_WARN, 0.8, "ANVIL_BUDGET_WARN", { min: 0, max: 1 }),
    softStopFraction: numEnv(env.ANVIL_BUDGET_SOFTSTOP, 0.95, "ANVIL_BUDGET_SOFTSTOP", { min: 0, max: 1 }),
    openRouterApiKey,
    adversarialModels: adversarialModels.length ? adversarialModels : DEFAULT_ADVERSARIAL_MODELS,
    // On when a key is present, unless explicitly killed via ANVIL_ADVERSARIAL=0.
    adversarialEnabled: Boolean(openRouterApiKey) && env.ANVIL_ADVERSARIAL !== "0",
    adversarialProvider: env.ANVIL_ADVERSARIAL_PROVIDER?.trim() || undefined,
  };
}
