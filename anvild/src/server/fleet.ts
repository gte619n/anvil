import type { rest } from "@protocol";

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
  const targets = peers.filter((p) => p.online && p.dnsName);
  const probed = await Promise.all(
    targets.map(async (p) => {
      const url = `https://${p.dnsName}:${opts.port}`;
      const r = await probe(url);
      return r ? { ...r, peer: p, url } : null;
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
  const url = `https://${host}:${opts.pairingPort ?? 7702}/anvil-pair`;
  return postPairing(url, { code: opts.code, token: opts.token, hubServerId: opts.hubServerId });
}

/** Rotate: push the current hub token to each member's `:7702/anvil-token`, identity-gated. */
export async function rotateToken(opts: { members: { host: string }[]; token: string; hubServerId: string; pairingPort?: number }): Promise<{ host: string; ok: boolean; error?: string }[]> {
  if (!opts.token) return opts.members.map((m) => ({ host: m.host, ok: false, error: "no token" }));
  return Promise.all(
    opts.members.map(async (m) => {
      const url = `https://${m.host}:${opts.pairingPort ?? 7702}/anvil-token`;
      const r = await postPairing(url, { token: opts.token, hubServerId: opts.hubServerId });
      return { host: m.host, ok: r.ok, error: r.error };
    }),
  );
}
