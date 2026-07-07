import type { rest } from "@protocol";
import { tailnetIPv4 } from "../config";

/**
 * Fleet discovery (anvil-multi-server.md §4.1). The tailnet already knows every device, so we
 * enumerate Tailscale peers (`tailscale status --json`) and probe each one's `/api/health`; any
 * that answer as an Anvil daemon are surfaced as add-suggestions, deduped by serverId. This runs
 * server-side on the hub daemon (it has the CLI and no CORS limits), so the web client just calls
 * its own `/api/fleet/discover` — no cross-node browser probing / CSP gymnastics for discovery.
 *
 * The pure orchestration takes injectable `runTailscale`/`probe` so it's unit-testable without a
 * real tailnet; the defaults shell out and `fetch` for production.
 */

export interface TailscalePeer {
  dnsName: string; // MagicDNS name, trailing dot stripped
  online: boolean;
  isSelf: boolean;
}

export interface ProbeResult {
  serverId: string;
  serverName: string;
  version: string;
}

export type RunTailscale = () => Promise<string | null>; // null → CLI unavailable / not logged in
export type Probe = (baseUrl: string) => Promise<ProbeResult | null>; // null → not an Anvil server

/** A tailnet Mac the user can pick when adding to the fleet (no IPs to track down). */
export interface TailnetPeer {
  name: string; // short label (first DNS label), e.g. "mac-mini-m1"
  host: string; // full MagicDNS name for :7701/:7702
  online: boolean;
}

/** List the other Macs on this tailnet (Self excluded) so a client can pick one by name. */
export async function tailnetPeers(runTailscale: RunTailscale = defaultRunTailscale): Promise<{ ok: boolean; peers: TailnetPeer[]; warning?: string }> {
  const json = await runTailscale();
  if (!json) return { ok: false, peers: [], warning: "Tailscale isn't available (CLI missing or not logged in)." };
  let parsed: TailscalePeer[];
  try {
    parsed = parseTailscalePeers(json);
  } catch {
    return { ok: false, peers: [], warning: "Couldn't parse `tailscale status --json`." };
  }
  const peers = parsed
    .filter((p) => !p.isSelf && p.dnsName)
    .map((p) => ({ name: p.dnsName.split(".")[0]!, host: p.dnsName, online: p.online }));
  return { ok: true, peers };
}

/** Parse `tailscale status --json` into the peers we might probe (Self + every Peer). */
export function parseTailscalePeers(statusJson: string): TailscalePeer[] {
  const s = JSON.parse(statusJson) as {
    Self?: { DNSName?: string };
    Peer?: Record<string, { DNSName?: string; Online?: boolean }>;
  };
  const strip = (d?: string): string => (d ?? "").replace(/\.$/, "");
  const out: TailscalePeer[] = [];
  if (s.Self?.DNSName) out.push({ dnsName: strip(s.Self.DNSName), online: true, isSelf: true });
  for (const peer of Object.values(s.Peer ?? {})) {
    if (peer.DNSName) out.push({ dnsName: strip(peer.DNSName), online: !!peer.Online, isSelf: false });
  }
  return out;
}

const TAILSCALE_BINS = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
];

async function defaultRunTailscale(): Promise<string | null> {
  for (const bin of TAILSCALE_BINS) {
    try {
      const p = Bun.spawn([bin, "status", "--json"], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      if (p.exitCode === 0 && out.trim()) return out;
    } catch {
      /* not at this path / not runnable — try the next */
    }
  }
  return null;
}

/**
 * Resolve a freshly-paired member's reachable URL *and* identity by probing its transport: https on
 * the MagicDNS name (serve-capable host) first, then plain http (App-Store-Tailscale host that binds
 * the tailnet IP directly). The probe hits `/api/health`, so we also capture the member's real
 * serverId/serverName — important because the `:7702` pairing outcome may omit a serverId, and falling
 * back to the bare host as the serverId silently breaks *targeted* token propagation (members are
 * matched by serverId). Defaults to http with no identity if neither scheme answers (the member may
 * still be starting up) so the registry still gets a usable entry. `host` is a bare MagicDNS name.
 */
export async function resolveMember(host: string, port: number, probe: Probe = defaultProbe): Promise<{ url: string; serverId?: string; serverName?: string }> {
  for (const base of [`https://${host}:${port}`, `http://${host}:${port}`]) {
    const r = await probe(base);
    if (r) return { url: `${base}/`, serverId: r.serverId, serverName: r.serverName };
  }
  return { url: `http://${host}:${port}/` };
}

/** URL-only convenience over {@link resolveMember} (kept for callers that don't need the identity). */
export async function resolveMemberUrl(host: string, port: number, probe: Probe = defaultProbe): Promise<string> {
  return (await resolveMember(host, port, probe)).url;
}

async function defaultProbe(baseUrl: string): Promise<ProbeResult | null> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const h = (await res.json()) as Partial<rest.HealthResponse>;
    if (typeof h.serverId === "string" && h.serverId) {
      return { serverId: h.serverId, serverName: h.serverName ?? "", version: h.version ?? "" };
    }
  } catch {
    /* unreachable, timed out, or not an Anvil daemon */
  }
  return null;
}

export interface SelfBaseUrlOpts {
  /** The tailnet-facing port (== ANVIL_PORT). */
  port: number;
  /** ANVIL_BASE_URL override — when set, used verbatim (trailing slashes trimmed). */
  override?: string;
  runTailscale?: RunTailscale;
  probe?: Probe;
  ipv4?: () => string | undefined; // injectable for tests
}

/**
 * Discover THIS daemon's own externally-reachable base URL, for deep links embedded in outbound
 * reports (e.g. the lapo autopilot report's "Open in Anvil" link). It self-configures per device/user:
 *   1. `ANVIL_BASE_URL` if set (explicit override);
 *   2. the MagicDNS name from `tailscale status`, probing `https://<name>` (behind `tailscale serve`),
 *      then `https://<name>:<port>`, then `http://<name>:<port>` — whichever `/api/health` answers;
 *   3. the raw tailnet IPv4 `http://<ip>:<port>` (direct-bind hosts with no serve/MagicDNS).
 * Returns undefined only when there's no tailnet at all. The MagicDNS name changes per device/tailnet,
 * so this is re-derived (and cached by the caller), never hardcoded.
 */
export async function discoverSelfBaseUrl(opts: SelfBaseUrlOpts): Promise<string | undefined> {
  const override = opts.override?.trim();
  if (override) return override.replace(/\/+$/, "");
  const runTailscale = opts.runTailscale ?? defaultRunTailscale;
  const probe = opts.probe ?? defaultProbe;
  const json = await runTailscale();
  const dnsName = json ? parseTailscalePeers(json).find((p) => p.isSelf)?.dnsName : undefined;
  if (dnsName) {
    for (const base of [`https://${dnsName}`, `https://${dnsName}:${opts.port}`, `http://${dnsName}:${opts.port}`]) {
      if (await probe(base)) return base;
    }
  }
  const ip = (opts.ipv4 ?? tailnetIPv4)();
  if (ip) return `http://${ip}:${opts.port}`;
  return dnsName ? `http://${dnsName}:${opts.port}` : undefined;
}

export interface DiscoverOpts {
  /** The tailnet-facing port (== ANVIL_PORT; `tailscale serve --https=$PORT` maps to it). */
  port: number;
  /** This server's own id, so its entry can be flagged `isSelf`. */
  selfServerId: string;
  runTailscale?: RunTailscale;
  probe?: Probe;
}

export async function discoverFleet(opts: DiscoverOpts): Promise<rest.FleetDiscoverResponse> {
  const runTailscale = opts.runTailscale ?? defaultRunTailscale;
  const probe = opts.probe ?? defaultProbe;

  const statusJson = await runTailscale();
  if (!statusJson) {
    return {
      ok: false,
      servers: [],
      warning: "Tailscale isn't available (CLI missing or not logged in). Add servers by URL instead.",
    };
  }

  let peers: TailscalePeer[];
  try {
    peers = parseTailscalePeers(statusJson);
  } catch {
    return { ok: false, servers: [], warning: "Couldn't parse `tailscale status --json`." };
  }

  // Only online peers can answer a probe; offline known members are handled by the registry.
  // A peer's transport depends on ITS host: serve-capable hosts answer over https on the MagicDNS
  // name; App-Store-Tailscale hosts bind the tailnet IP directly and answer over plain http. So try
  // https first, then http, and record whichever URL answered (server-side fetch isn't subject to
  // the browser's ts.net HSTS, so http://<name> reaches a direct-bind peer fine).
  const targets = peers.filter((p) => p.online && p.dnsName);
  const probed = await Promise.all(
    targets.map(async (p) => {
      for (const url of [`https://${p.dnsName}:${opts.port}`, `http://${p.dnsName}:${opts.port}`]) {
        const r = await probe(url);
        if (r) return { ...r, peer: p, url };
      }
      return null;
    }),
  );

  const byId = new Map<string, rest.DiscoveredServer>();
  for (const x of probed) {
    if (!x || byId.has(x.serverId)) continue; // dedup by serverId (first address wins)
    byId.set(x.serverId, {
      serverId: x.serverId,
      serverName: x.serverName || x.peer.dnsName,
      url: x.url,
      version: x.version,
      online: true,
      isSelf: x.serverId === opts.selfServerId,
    });
  }
  return { ok: true, servers: [...byId.values()] };
}

// ─── Hub-side token distribution (anvil-server-app.md §4) ──────────────────────────────────────
// The hub daemon pushes ITS subscription token to a joiner's pairing listener (:7702, hosted by the
// joiner's Anvil Server.app) so the fleet can be managed from any client — web/Android/Mac — without
// touching the hub's Mac app. The token is read from the daemon's own env and never returned to a
// client. First join is code-gated (/anvil-pair); rotation is identity-gated (/anvil-token).
//
// Transport is PLAIN HTTP over the tailnet (not `tailscale serve` HTTPS): the joiner binds :7702
// directly on its tailnet interface, so this works with any Tailscale install (incl. the sandboxed
// App Store build that can't run `serve`). WireGuard encrypts the hop; the joiner verifies the
// caller via `tailscale whois` on the connecting IP + the 6-digit code (anvil-server-app.md §4.3).

interface PairOutcome {
  ok: boolean;
  serverId?: string;
  serverName?: string;
  error?: string;
}

async function postPairing(url: string, body: Record<string, unknown>, timeoutMs = 12_000): Promise<PairOutcome> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as PairOutcome;
    return { ok: res.ok && data.ok !== false, serverId: data.serverId, serverName: data.serverName, error: data.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Invite a Mac: push the hub token to `host:7702/anvil-pair`, code-gated (first join). */
export async function inviteMac(opts: { host: string; code: string; token: string; hubServerId: string; pairingPort?: number }): Promise<PairOutcome> {
  if (!opts.token) return { ok: false, error: "this server has no OAuth token to share" };
  const host = opts.host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const url = `http://${host}:${opts.pairingPort ?? 7702}/anvil-pair`;
  return postPairing(url, { code: opts.code, token: opts.token, hubServerId: opts.hubServerId });
}

/**
 * Candidate daemon base URLs for a member, https first then http. We deliberately re-derive these from
 * the member's host:port and IGNORE the stored scheme: a member's transport can change after pairing
 * (e.g. `tailscale serve` HTTPS comes up only after the join), and a token POST sent to the wrong scheme
 * is hard-rejected ("Client sent an HTTP request to an HTTPS server") — silently stranding the member
 * without a token forever. Trying both schemes lets propagation self-correct a stale registry entry.
 */
function memberBases(m: { url: string; host?: string }): string[] {
  let host = m.host ?? "";
  let port = "7701";
  try {
    const u = new URL(m.url);
    if (u.hostname) host = u.hostname;
    if (u.port) port = u.port;
  } catch {
    /* malformed stored url — fall back to the bare host on the default port */
  }
  return host ? [`https://${host}:${port}`, `http://${host}:${port}`] : [];
}

/**
 * Replicate the hub's Todoist token to member DAEMONS (anvil-multi-server.md — autopilot runs where
 * the repo lives, so each member that hosts a linked environment needs the token). Unlike the OAuth
 * token (pushed to the Server.app pairing listener on :7702), this lands in the member daemon's own
 * IntegrationStore via its REST API on :7701. Tailnet-gated like the rest of the daemon API; the hop
 * is WireGuard-encrypted. Best-effort + idempotent — unreachable members heal on their next connect.
 *
 * Transport-resilient: each member is tried https-then-http (see {@link memberBases}), and the working
 * base plus the member's self-reported serverId/serverName come back in `resolvedUrl`/`serverId` so the
 * caller can heal a stale fleet record. `fetchImpl` is injectable for tests.
 */
export async function propagateTodoist(opts: {
  members: { url: string; host?: string; serverId?: string; serverName?: string }[];
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{ url: string; resolvedUrl?: string; serverId?: string; serverName?: string; ok: boolean; account?: string; error?: string }[]> {
  if (!opts.token) return opts.members.map((m) => ({ url: m.url, ok: false, error: "no token" }));
  const doFetch = opts.fetchImpl ?? fetch;
  return Promise.all(
    opts.members.map(async (m) => {
      let lastError = "no reachable transport";
      // First scheme that accepts the POST wins; report it (and the member's identity) for healing.
      for (const base of memberBases(m)) {
        try {
          const res = await doFetch(`${base}/api/integrations/todoist`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: opts.token }),
            signal: AbortSignal.timeout(12_000),
          });
          const data = (await res.json().catch(() => ({}))) as { ok?: boolean; account?: string; error?: string; serverId?: string; serverName?: string };
          if (res.ok && data.ok !== false) {
            return { url: m.url, resolvedUrl: `${base}/`, serverId: data.serverId, serverName: data.serverName, ok: true, account: data.account };
          }
          lastError = data.error ?? `HTTP ${res.status}`;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
      return { url: m.url, ok: false, error: lastError };
    }),
  );
}

/** Rotate: push the current hub token to each member's `:7702/anvil-token`, identity-gated. */
export async function rotateToken(opts: { members: { host: string }[]; token: string; hubServerId: string; pairingPort?: number }): Promise<{ host: string; ok: boolean; error?: string }[]> {
  if (!opts.token) return opts.members.map((m) => ({ host: m.host, ok: false, error: "no token" }));
  return Promise.all(
    opts.members.map(async (m) => {
      const url = `http://${m.host}:${opts.pairingPort ?? 7702}/anvil-token`;
      const r = await postPairing(url, { token: opts.token, hubServerId: opts.hubServerId });
      return { host: m.host, ok: r.ok, error: r.error };
    }),
  );
}
