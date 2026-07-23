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
  dnsName: string; // MagicDNS name, trailing dot stripped ("" when the node has none)
  /** The node's CGNAT-range (100.64.0.0/10) tailnet IPv4, if any. This is the reachability floor:
   *  it needs no DNS at all, so it's the ONLY address that works when MagicDNS is disabled on the
   *  tailnet (or a node simply has no name). Reached over plain http (a bare IP has no TLS cert). */
  ipv4?: string;
  online: boolean;
  isSelf: boolean;
}

export interface ProbeResult {
  serverId: string;
  serverName: string;
  version: string;
  /** From the peer's /api/health. False ⇒ up but with no Claude login, so discovery labels it
   *  "needs setup" and the operator can pair it (headless-join HJ-9). */
  subscriptionAuthOk?: boolean;
  /** The peer's `SERVER_CAPABILITIES`. Contains "pairing" when credentials can be pushed to its own
   *  :7701 API; absent/omitted means a pre-capability daemon → the macOS :7702 listener (HJ-32/§5.4). */
  capabilities?: string[];
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
    .filter((p) => !p.isSelf && (p.dnsName || p.ipv4))
    .map((p) => ({
      // Prefer the friendly short name; for an IP-only node (no MagicDNS) the IP IS the label/host.
      name: p.dnsName ? p.dnsName.split(".")[0]! : p.ipv4!,
      host: p.dnsName || p.ipv4!,
      online: p.online,
    }));
  return { ok: true, peers };
}

/** The CGNAT-range (100.64.0.0/10) IPv4 from a Tailscale node's `TailscaleIPs`, if present. Mirrors
 *  the interface-based {@link tailnetIPv4} in config.ts, but reads the address off the status JSON so
 *  it works for *peers* (whose interfaces we can't see), not just self. */
function cgnatIPv4(ips?: string[]): string | undefined {
  for (const ip of ips ?? []) {
    const o = ip.split(".");
    if (o.length !== 4) continue; // skip IPv6 (fd7a:…) and anything malformed
    const a = Number(o[0]);
    const b = Number(o[1]);
    if (a === 100 && b >= 64 && b <= 127) return ip;
  }
  return undefined;
}

/** True for a bare IPv4 literal (as opposed to a MagicDNS name). Used to skip the pointless https
 *  probe to a raw tailnet IP — no TLS cert exists for a 100.x address, so only http reaches it. */
function isBareIPv4(host: string): boolean {
  const o = host.split(".");
  return o.length === 4 && o.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Candidate `:7701` daemon base URLs for a host, most-preferred first. A MagicDNS name is tried over
 * https (serve mode — the joiner binds loopback and only https reaches it) then http (a direct-bind
 * host answers only http). A bare tailnet IP is http-ONLY: a 100.x literal has no TLS cert, so an
 * https attempt to it is a guaranteed-wasted probe (and a wasted timeout). Shared by every reach path
 * — discovery, pairing/rotation, ack, Todoist propagation — so they agree on scheme order.
 */
function daemonBases(host: string, port: number | string): string[] {
  return isBareIPv4(host) ? [`http://${host}:${port}`] : [`https://${host}:${port}`, `http://${host}:${port}`];
}

/** Every base URL worth probing for a discovered peer, preferred first: its MagicDNS name (https then
 *  http) and/or its raw tailnet IP (http only). The IP leg is what keeps an IP-only peer — MagicDNS
 *  off, or no name — reachable instead of invisible. */
export function peerBases(peer: { dnsName?: string; ipv4?: string }, port: number): string[] {
  const bases: string[] = [];
  if (peer.dnsName) bases.push(...daemonBases(peer.dnsName, port));
  if (peer.ipv4) bases.push(`http://${peer.ipv4}:${port}`);
  return bases;
}

/** Parse `tailscale status --json` into the peers we might probe (Self + every Peer). A node is
 *  admitted if it's reachable by EITHER a MagicDNS name OR a raw tailnet IP — dropping IP-only nodes
 *  (the no-MagicDNS case) made them invisible even though http://<ip>:7701 reaches them fine. */
export function parseTailscalePeers(statusJson: string): TailscalePeer[] {
  const s = JSON.parse(statusJson) as {
    Self?: { DNSName?: string; TailscaleIPs?: string[] };
    Peer?: Record<string, { DNSName?: string; Online?: boolean; TailscaleIPs?: string[] }>;
  };
  const strip = (d?: string): string => (d ?? "").replace(/\.$/, "");
  const out: TailscalePeer[] = [];
  const add = (node: { DNSName?: string; TailscaleIPs?: string[] } | undefined, online: boolean, isSelf: boolean): void => {
    if (!node) return;
    const dnsName = strip(node.DNSName);
    const ipv4 = cgnatIPv4(node.TailscaleIPs);
    if (!dnsName && !ipv4) return; // no way to reach it — neither a name nor a tailnet IP
    out.push({ dnsName, online, isSelf, ...(ipv4 ? { ipv4 } : {}) });
  };
  add(s.Self, true, true);
  for (const peer of Object.values(s.Peer ?? {})) add(peer, !!peer.Online, false);
  return out;
}

// PATH first (works on any OS where `tailscale` is installed), then the common Linux/Homebrew
// install locations, then the macOS App bundle path last as a fallback for the GUI-only install.
const TAILSCALE_BINS = [
  "tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
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
 * still be starting up) so the registry still gets a usable entry. `host` is a bare MagicDNS name or,
 * when MagicDNS is off, a raw tailnet IP (http-only — see {@link daemonBases}).
 */
export async function resolveMember(
  host: string,
  port: number,
  probe: Probe = defaultProbe,
): Promise<{ url: string; serverId?: string; serverName?: string; capabilities?: string[]; subscriptionAuthOk?: boolean }> {
  for (const base of daemonBases(host, port)) {
    const r = await probe(base);
    // `capabilities` rides along so the invite path can pick a push destination from what the joiner
    // actually advertises rather than guessing (headless-join HJ-15) — same probe, no extra round trip.
    if (r) {
      return {
        url: `${base}/`,
        serverId: r.serverId,
        serverName: r.serverName,
        ...(r.capabilities ? { capabilities: r.capabilities } : {}),
        ...(r.subscriptionAuthOk !== undefined ? { subscriptionAuthOk: r.subscriptionAuthOk } : {}),
      };
    }
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
      return {
        serverId: h.serverId,
        serverName: h.serverName ?? "",
        version: h.version ?? "",
        // Carried through so the hub can label a tokenless peer AND route a credential push by
        // capability rather than by guessing (headless-join HJ-9/HJ-15). Both are optional on the
        // wire: a peer whose health predates them simply omits them.
        ...(typeof h.subscriptionAuthOk === "boolean" ? { subscriptionAuthOk: h.subscriptionAuthOk } : {}),
        ...(Array.isArray(h.capabilities) ? { capabilities: h.capabilities.filter((c): c is string => typeof c === "string") } : {}),
      };
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
  const targets = peers.filter((p) => p.online && (p.dnsName || p.ipv4));
  const probed = await Promise.all(
    targets.map(async (p) => {
      for (const url of peerBases(p, opts.port)) {
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
      serverName: x.serverName || x.peer.dnsName || x.peer.ipv4 || x.url,
      url: x.url,
      version: x.version,
      online: true,
      isSelf: x.serverId === opts.selfServerId,
      ...(x.subscriptionAuthOk !== undefined ? { subscriptionAuthOk: x.subscriptionAuthOk } : {}),
      ...(x.capabilities ? { capabilities: x.capabilities } : {}),
    });
  }
  return { ok: true, servers: [...byId.values()] };
}

// ─── Hub-side token distribution (anvil-server-app.md §4 · anvil-headless-join.md §5.4/§6) ─────
// The hub daemon pushes ITS subscription token to a joiner so the fleet can be managed from any
// client — web/Android/Mac — without touching the hub's Mac app. The token is read from the daemon's
// own env and never returned to a client. First join is code-gated; rotation is identity-gated.
//
// There are TWO possible destinations, and the hub picks by capability, not by guessing:
//   :7701 /api/fleet/pair|token — the joiner's OWN daemon API. Works on any platform, which is what
//     lets a headless Linux box join at all. Reached over https (serve mode, where the joiner binds
//     loopback only) or http (direct bind) — the scheme fallback is not optional.
//   :7702 /anvil-pair|/anvil-token — the macOS Server.app's standalone listener, plain HTTP bound
//     directly on the tailnet so it works with the sandboxed App Store Tailscale (Pairing.swift:47).
//     This is now the PRE-UPGRADE path only: an upgraded Mac takes the :7701 route like everyone else.
//
// Either way WireGuard encrypts the hop, and the joiner verifies the caller by tailnet identity —
// `tailscale whois` on a direct bind, the serve-injected `Tailscale-User-Login` header on loopback
// (headless-join §7) — plus the 6-digit code for a first join.

interface PairOutcome {
  ok: boolean;
  serverId?: string;
  serverName?: string;
  error?: string;
  /** The route answered, but with "no such route" semantics (404/405, or a non-JSON error page). The
   *  caller treats this as "try the other destination", NOT as a hard failure — see {@link pushCredential}. */
  routeMissing?: boolean;
  /** The fetch never produced a response at all — connection refused, DNS failure, TLS-to-plain-HTTP
   *  mismatch, or timeout. The caller retries the next scheme/port rather than surfacing it as a real
   *  rejection (see {@link pushCredential}). Deliberately a FLAG set at the fetch boundary, not a
   *  string match on `error`: Bun's refused-connection message ("Unable to connect…") contains none of
   *  the keywords a regex would look for, so classifying by text silently defeated the https→http
   *  fallback and broke pairing to every direct-bind (serve-less) joiner. */
  transportError?: boolean;
}

async function postPairing(url: string, body: Record<string, unknown>, timeoutMs = 12_000, fetchImpl: typeof fetch = fetch): Promise<PairOutcome> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // An un-upgraded daemon ANSWERS on :7701 — it's the ordinary daemon port — and 404s an unknown
    // route. So a status check, not just a connection error, is what tells us to try :7702 (HJ-15).
    if (res.status === 404 || res.status === 405) return { ok: false, routeMissing: true, error: `HTTP ${res.status}` };
    const text = await res.text();
    let data: PairOutcome | null = null;
    try {
      data = JSON.parse(text) as PairOutcome;
    } catch {
      // A proxy's HTML error page is the same signal as a 404: whatever answered isn't the pair route.
      return { ok: false, routeMissing: !res.ok, error: `HTTP ${res.status} (non-JSON response)` };
    }
    return { ok: res.ok && data.ok !== false, serverId: data.serverId, serverName: data.serverName, error: data.error };
  } catch (e) {
    // Threw before any response: unreachable scheme/port, DNS failure, TLS mismatch, or timeout. Flag
    // it so the caller retries the next base instead of reading the message — see transportError.
    return { ok: false, transportError: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Strip any scheme/path an operator (or a stored URL) left on a host so it can be used bare. */
function bareHost(host: string): string {
  return host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
}

/** Does this peer's advertised capability set say it receives credentials on its own :7701 API? */
export function speaksPairing(capabilities: string[] | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes("pairing");
}

/**
 * Push a credential payload to a member, choosing the destination by **capability, not by failure**
 * (HJ-15 · headless-join §5.4/§6):
 *
 *   1. health advertises `pairing`         → the daemon's own `:7701` route;
 *   2. capabilities present but no `pairing`, or absent entirely (a pre-capability daemon)
 *                                          → the macOS Server.app's `:7702` listener;
 *   3. `:7701` answers 404/405 (or an HTML error page) → fall back to `:7702` anyway.
 *
 * Step 3 is load-bearing: an un-upgraded Mac *does* answer on :7701 and returns 404 for an unknown
 * route, so a connect-failure-only fallback would treat that as a hard failure and break pairing
 * against every Mac not yet upgraded.
 *
 * The `:7701` leg reuses the https-then-http scheme fallback (see {@link memberBases}) because it is
 * not optional: in serve mode the joiner binds **loopback only** so only `https://` reaches it, while a
 * direct-bind joiner answers only `http://`. The `:7702` leg is plain HTTP by design (Pairing.swift:47).
 */
async function pushCredential(opts: {
  host: string;
  capabilities?: string[];
  /** The daemon route on :7701, e.g. "/api/fleet/pair". */
  daemonPath: string;
  /** The Server.app route on :7702, e.g. "/anvil-pair". */
  legacyPath: string;
  body: Record<string, unknown>;
  port?: number;
  pairingPort?: number;
  fetchImpl?: typeof fetch;
}): Promise<PairOutcome> {
  const host = bareHost(opts.host);
  const doFetch = opts.fetchImpl ?? fetch;
  const port = opts.port ?? 7701;
  const legacyUrl = `http://${host}:${opts.pairingPort ?? 7702}${opts.legacyPath}`;

  if (speaksPairing(opts.capabilities)) {
    let last: PairOutcome = { ok: false, error: "no reachable transport" };
    for (const base of daemonBases(host, port)) {
      const r = await postPairing(`${base}${opts.daemonPath}`, opts.body, 12_000, doFetch);
      if (r.ok) return r;
      last = r;
      // A real rejection ("wrong code") is an ANSWER — stop, don't shop the credential around. Only a
      // transport failure (this scheme was unreachable) or a missing route justifies trying elsewhere.
      // Gate on the transportError FLAG, not the error text: Bun's connection-refused message
      // ("Unable to connect…") matches none of the obvious keywords, so a regex here silently treated
      // an unreachable https scheme as a real rejection and never tried http — which is exactly the
      // state of every direct-bind (serve-less) joiner, i.e. the whole headless case.
      if (!r.routeMissing && !r.transportError) return r;
      if (r.routeMissing) break; // it's a daemon, but an old one — go straight to :7702
    }
    const legacy = await postPairing(legacyUrl, opts.body, 12_000, doFetch);
    return legacy.ok ? legacy : { ...legacy, error: legacy.error ?? last.error };
  }

  return postPairing(legacyUrl, opts.body, 12_000, doFetch);
}

/**
 * First join: push the hub's credentials to a joiner, code-gated. Named `invitePeer` (not `inviteMac`)
 * since the joiner no longer has to be a Mac — that was the whole point of headless-join. Sibling
 * secrets ride along in the same payload so joining a fleet means adopting its config (HJ-24/HJ-27);
 * the `:7702` listener ignores the extra fields, so the legacy path is unaffected.
 */
export async function invitePeer(opts: {
  host: string;
  code: string;
  token: string;
  hubServerId: string;
  capabilities?: string[];
  fleetName?: string;
  todoistToken?: string;
  openRouterKey?: string;
  port?: number;
  pairingPort?: number;
  fetchImpl?: typeof fetch;
}): Promise<PairOutcome> {
  if (!opts.token) return { ok: false, error: "this server has no OAuth token to share" };
  return pushCredential({
    host: opts.host,
    capabilities: opts.capabilities,
    daemonPath: "/api/fleet/pair",
    legacyPath: "/anvil-pair",
    port: opts.port,
    pairingPort: opts.pairingPort,
    fetchImpl: opts.fetchImpl,
    body: {
      code: opts.code,
      token: opts.token,
      hubServerId: opts.hubServerId,
      ...(opts.fleetName ? { fleetName: opts.fleetName } : {}),
      ...(opts.todoistToken ? { todoistToken: opts.todoistToken } : {}),
      ...(opts.openRouterKey ? { openRouterKey: opts.openRouterKey } : {}),
    },
  });
}

/**
 * Confirm to the joiner that the member is recorded, so it disarms its window (HJ-16). Best-effort and
 * :7701-only — the `:7702` listener disarms on its own successful pair, so there is nothing to ack.
 */
export async function ackPair(opts: {
  host: string;
  code: string;
  hubServerId: string;
  capabilities?: string[];
  port?: number;
  fetchImpl?: typeof fetch;
}): Promise<PairOutcome> {
  if (!speaksPairing(opts.capabilities)) return { ok: true };
  const host = bareHost(opts.host);
  const port = opts.port ?? 7701;
  let last: PairOutcome = { ok: false, error: "no reachable transport" };
  for (const base of daemonBases(host, port)) {
    const r = await postPairing(`${base}/api/fleet/pair/ack`, { code: opts.code, hubServerId: opts.hubServerId }, 8_000, opts.fetchImpl ?? fetch);
    if (r.ok) return r;
    last = r;
  }
  return last;
}

/**
 * Candidate daemon base URLs for a member, https first then http (http only for a bare IP host — see
 * {@link daemonBases}). We deliberately re-derive these from the member's host:port and IGNORE the
 * stored scheme: a member's transport can change after pairing (e.g. `tailscale serve` HTTPS comes up
 * only after the join), and a token POST sent to the wrong scheme is hard-rejected ("Client sent an
 * HTTP request to an HTTPS server") — silently stranding the member without a token forever. Trying
 * both schemes lets propagation self-correct a stale registry entry.
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
  return host ? daemonBases(host, port) : [];
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

/**
 * Rotate: push the current hub token to every member, identity-gated (no code). First-join and
 * rotation are the same push differing only in gate — the split macOS already makes.
 *
 * Destination selection is identical to {@link invitePeer}'s (headless-join §6): capability-directed,
 * with the 404/405 fallback. Consequence worth stating — once this ships, an **upgraded Mac** receives
 * rotation on `:7701` like any other member; `:7702` is the path for pre-upgrade daemons only.
 *
 * A member's capabilities are probed here rather than stored, so a member that upgrades later starts
 * getting the :7701 route without needing to be re-paired.
 */
export async function rotateToken(opts: {
  members: { host: string; capabilities?: string[] }[];
  token: string;
  hubServerId: string;
  todoistToken?: string;
  openRouterKey?: string;
  port?: number;
  pairingPort?: number;
  probe?: Probe;
  fetchImpl?: typeof fetch;
}): Promise<{ host: string; ok: boolean; error?: string }[]> {
  if (!opts.token) return opts.members.map((m) => ({ host: m.host, ok: false, error: "no token" }));
  const probe = opts.probe ?? defaultProbe;
  const port = opts.port ?? 7701;
  return Promise.all(
    opts.members.map(async (m) => {
      const host = bareHost(m.host);
      let capabilities = m.capabilities;
      if (capabilities === undefined) {
        for (const base of [`https://${host}:${port}`, `http://${host}:${port}`]) {
          const r = await probe(base);
          if (r) {
            capabilities = r.capabilities ?? [];
            break;
          }
        }
      }
      const r = await pushCredential({
        host,
        capabilities,
        daemonPath: "/api/fleet/token",
        legacyPath: "/anvil-token",
        port: opts.port,
        pairingPort: opts.pairingPort,
        fetchImpl: opts.fetchImpl,
        body: {
          token: opts.token,
          hubServerId: opts.hubServerId,
          ...(opts.todoistToken ? { todoistToken: opts.todoistToken } : {}),
          ...(opts.openRouterKey ? { openRouterKey: opts.openRouterKey } : {}),
        },
      });
      return { host: m.host, ok: r.ok, error: r.error };
    }),
  );
}
