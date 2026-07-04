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

  return false;
}

/** Parse the ANVIL_ALLOWED_ORIGINS env (comma/space separated) into an exact-match allowlist. */
export function configuredAllowedOrigins(src: Record<string, string | undefined> = process.env): string[] {
  return (src.ANVIL_ALLOWED_ORIGINS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
