import { networkInterfaces } from "node:os";

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
