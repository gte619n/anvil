/** Runtime configuration, resolved from the environment. */
export interface Config {
  host: string;
  port: number;
  stateDir: string;
  /** Warn threshold as a fraction (0–1) of any rate-limit window's utilization (arch §3). */
  warnFraction: number;
  /** Soft-stop threshold as a fraction (0–1) of the 7-day window's utilization (arch §3). */
  softStopFraction: number;
}

function expandHome(p: string, home: string): string {
  return p.startsWith("~") ? home + p.slice(1) : p;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = env.HOME ?? ".";
  return {
    // localhost-only by default — Tailscale serve is the access boundary (arch §4.1).
    host: env.ANVIL_HOST ?? "127.0.0.1",
    port: Number(env.ANVIL_PORT ?? 7701),
    stateDir: expandHome(env.ANVIL_STATE_DIR ?? "~/.anvil", home),
    warnFraction: Number(env.ANVIL_BUDGET_WARN ?? 0.8),
    softStopFraction: Number(env.ANVIL_BUDGET_SOFTSTOP ?? 0.95),
  };
}
