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
  /** How often (ms) the plan-usage gauge is re-read between turns; 0 disables (arch §3). */
  usagePollMs: number;
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
  /** Opt-in feature flags from `ANVIL_FEATURES` (comma-separated), each one of `FEATURE_CAPABILITIES`.
   *  An enabled feature is advertised as a capability (`serverCapabilities`) and unlocks its code
   *  paths (`featureEnabled`). Read once at startup, so a flag changes only with a daemon restart. */
  features: string[];
}

/** The capability-gated features `ANVIL_FEATURES` may switch on (agent-cad-and-browser spec §4.8):
 *  `cad-work` (Track A), `solidcraft-pin` (Track B), `mcp-integrations`, `browser` and `part-sources` (Track C).
 *  All are OFF by default; the list order is the order they are advertised in. */
export const FEATURE_CAPABILITIES = ["cad-work", "solidcraft-pin", "mcp-integrations", "browser", "part-sources"] as const;
export type FeatureName = (typeof FEATURE_CAPABILITIES)[number];

/** Parse `ANVIL_FEATURES`: comma-separated, trimmed, de-duplicated, returned in `FEATURE_CAPABILITIES`
 *  order. An unknown name is ignored with a warning rather than failing startup — a member that is a
 *  release behind the hub must still boot when the fleet env names a feature it doesn't know yet. */
export function parseFeatures(raw: string | undefined, warn: (msg: string) => void = (m) => console.warn(m)): string[] {
  const asked = (raw ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  const known = new Set<string>(FEATURE_CAPABILITIES);
  for (const f of asked) {
    if (!known.has(f)) warn(`[anvild] ANVIL_FEATURES: ignoring unknown feature ${JSON.stringify(f)} (known: ${FEATURE_CAPABILITIES.join(", ")})`);
  }
  return FEATURE_CAPABILITIES.filter((f) => asked.includes(f));
}

/** Whether a capability-gated feature is switched on for this daemon. Takes anything carrying a
 *  `features` list (the full `Config`, or `ServerOptions`), so callers needn't thread the whole config. */
export function featureEnabled(config: { features?: readonly string[] }, name: FeatureName): boolean {
  return config.features?.includes(name) ?? false;
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
 * Resolve the lapo integration's OAuth + entry-API surface from ANVIL_LAPO_* env. Returns `undefined`
 * ONLY when explicitly disabled (`ANVIL_LAPO_DISABLE=1`) — otherwise it's always available with sensible
 * defaults: the base URL defaults to `https://app.heylapo.com`, the OAuth endpoints are DISCOVERED at
 * runtime (RFC 8414), and the client id is OPTIONAL — when absent the daemon dynamically registers one
 * (RFC 7591) on connect, so no manual provisioning is needed. Read LIVE at the point of use (not cached
 * at startup). The *Path fallbacks apply only if discovery is unreachable.
 */
export function resolveLapoConfig(env: Record<string, string | undefined> = process.env): LapoConfig | undefined {
  if (env.ANVIL_LAPO_DISABLE === "1" || env.ANVIL_LAPO_DISABLE === "true") return undefined;
  const baseUrl = (env.ANVIL_LAPO_BASE_URL?.trim() || DEFAULT_LAPO_BASE_URL).replace(/\/+$/, "");
  const clientId = env.ANVIL_LAPO_CLIENT_ID?.trim();
  const clientSecret = env.ANVIL_LAPO_CLIENT_SECRET?.trim();
  const path = (raw: string | undefined, fallback: string): string => {
    const p = raw?.trim() || fallback;
    return p.startsWith("/") ? p : `/${p}`;
  };
  return {
    baseUrl,
    ...(clientId ? { clientId } : {}),
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
    usagePollMs: numEnv(env.ANVIL_BUDGET_POLL_MS, 5 * 60_000, "ANVIL_BUDGET_POLL_MS", { min: 0, integer: true }),
    openRouterApiKey,
    adversarialModels: adversarialModels.length ? adversarialModels : DEFAULT_ADVERSARIAL_MODELS,
    // On when a key is present, unless explicitly killed via ANVIL_ADVERSARIAL=0.
    adversarialEnabled: Boolean(openRouterApiKey) && env.ANVIL_ADVERSARIAL !== "0",
    adversarialProvider: env.ANVIL_ADVERSARIAL_PROVIDER?.trim() || undefined,
    features: parseFeatures(env.ANVIL_FEATURES),
  };
}
