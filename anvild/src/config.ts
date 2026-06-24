import { networkInterfaces } from "node:os";

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
  return {
    host,
    port: Number(env.ANVIL_PORT ?? 7701),
    stateDir: expandHome(env.ANVIL_STATE_DIR ?? "~/.anvil", home),
    warnFraction: Number(env.ANVIL_BUDGET_WARN ?? 0.8),
    softStopFraction: Number(env.ANVIL_BUDGET_SOFTSTOP ?? 0.95),
  };
}
