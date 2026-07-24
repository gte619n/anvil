/**
 * [SEC-H3] WebSocket upgrade Origin gate — defense-in-depth on top of the Tailscale boundary.
 *
 * WebSockets bypass CORS, so a malicious page in a *trusted* device's browser could otherwise open
 * `ws://<daemon>/ws` and drive the daemon. We reject foreign browser origins while allowing every
 * real client. The daemon stays unauthenticated by design (Tailscale is the boundary); this only
 * blocks the browser cross-site vector, which the network boundary can't.
 */

// WebViewAssetLoader's fixed secure origin for the bundled Android UI.
const NATIVE_ORIGIN_HOSTS = new Set(["appassets.androidplatform.net"]);

/**
 * @param origin the request's `Origin` header (null when absent)
 * @param host   the request's `Host` header (the daemon's own host:port)
 * @param extraAllowed optional additional exact origins (e.g. from ANVIL_ALLOWED_ORIGINS)
 */
export function isAllowedWsOrigin(
  origin: string | null | undefined,
  host: string | null | undefined,
  extraAllowed: string[] = [],
): boolean {
  // No Origin (native fetch, CLI, non-browser WS clients) — not a browser cross-site request.
  if (!origin) return true;
  // Opaque/sandboxed browsing contexts send the literal "null".
  if (origin === "null") return true;
  if (extraAllowed.includes(origin)) return true;

  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    // A malformed Origin isn't a normal browser cross-site request; don't hard-fail real clients.
    return true;
  }

  // Native custom-scheme shells (iOS/macOS `anvil-app://`) — not http(s), so not the drive-by vector.
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  // Known bundled-native origins (Android WebViewAssetLoader).
  if (NATIVE_ORIGIN_HOSTS.has(u.hostname)) return true;
  // Same-origin PWA: the Origin's host[:port] matches the daemon's own Host header.
  if (host && u.host === host) return true;

  // Same-tailnet fleet peer: trust any Origin within THIS daemon's own Tailscale MagicDNS domain,
  // derived from our own Host header (e.g. Host "beelink.tailnet.ts.net:7701" → domain "tailnet.ts.net";
  // `tailscale serve` preserves the client-facing Host). Tailscale is the security boundary, and a
  // *.ts.net name is Tailscale-issued and only resolvable/reachable from within the tailnet — a public
  // drive-by page can't present one. This is what lets a whole fleet connect cross-origin in a browser
  // (the hub's page opening a WS to each member) with no per-member ANVIL_ALLOWED_ORIGINS config.
  const tailnet = tailnetDomainOf(host);
  if (tailnet && (u.hostname === tailnet || u.hostname.endsWith(`.${tailnet}`))) return true;

  return false;
}

/**
 * The registrable Tailscale MagicDNS domain from a daemon's own `Host` header — the host minus its
 * leading DNS label (the machine name) and any `:port`. Returns undefined unless it's a real `*.ts.net`
 * MagicDNS name, so a direct-IP or non-Tailscale Host grants no same-tailnet trust.
 *   "beelink-4450.softshell-mark.ts.net:7701" → "softshell-mark.ts.net"
 *   "100.116.161.46:7701" / "localhost:7701"  → undefined
 */
function tailnetDomainOf(host: string | null | undefined): string | undefined {
  if (!host) return undefined;
  const hostname = host.replace(/:\d+$/, ""); // strip :port
  if (!hostname.endsWith(".ts.net")) return undefined; // only Tailscale MagicDNS names
  const dot = hostname.indexOf(".");
  if (dot < 0 || dot === hostname.length - 1) return undefined;
  const domain = hostname.slice(dot + 1); // drop the leading machine label → "<tailnet>.ts.net"
  // Require a real tailnet label in front of ".ts.net" — never let a degenerate "ts.net" through, which
  // would over-match every tailnet on the internet.
  return domain.endsWith(".ts.net") ? domain : undefined;
}

/** Parse the ANVIL_ALLOWED_ORIGINS env (comma/space separated) into an exact-match allowlist. */
export function configuredAllowedOrigins(src: Record<string, string | undefined> = process.env): string[] {
  return (src.ANVIL_ALLOWED_ORIGINS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
