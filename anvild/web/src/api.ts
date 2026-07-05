/**
 * Daemon endpoint resolution. In the browser/PWA the page is served BY the daemon, so the
 * daemon is the page origin. In the native shells the UI is bundled and served locally
 * (appassets://…), so the native app injects `window.ANVIL_DAEMON_URL` — the absolute daemon
 * URL to reach over Tailscale. Everything that talks to the daemon (WS, REST, daemon-relative
 * URLs in events) goes through here.
 */
declare global {
  interface Window {
    ANVIL_DAEMON_URL?: string;
  }
}

/** Absolute daemon base URL with no trailing slash. */
export function daemonBase(): string {
  const injected = typeof window !== "undefined" ? window.ANVIL_DAEMON_URL : undefined;
  return (injected || (typeof location !== "undefined" ? location.origin : "")).replace(/\/+$/, "");
}

/** Resolve a daemon-relative path (e.g. "/api/health" or "/api/sessions/x/files?…") to absolute. */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path; // already absolute
  return daemonBase() + (path.startsWith("/") ? path : `/${path}`);
}

/** fetch() against the daemon, regardless of where the page is served from. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}

/** Two base URLs address the same daemon when they differ only by scheme (http/https) or a trailing
 *  slash. A fleet member reconnects under a force-upgraded https:// url (mixed-content upgrade /
 *  `tailscale serve`) while its sessions were cached under the http:// url it was added with — the
 *  member URL http/https drift. Reconciling a server's session.list by exact url string then orphans
 *  those cached rows (the owning server can no longer drop them), leaving un-removable zombies.
 *  Compare on this scheme-insensitive identity so a reconnect under a new scheme still reaps its old
 *  rows. */
export function sameServerUrl(a: string | undefined, b: string): boolean {
  const norm = (u: string): string => u.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  return a !== undefined && norm(a) === norm(b);
}

/** ws:// or wss:// URL for the daemon's /ws endpoint. */
export function wsUrl(): string {
  const ws = daemonBase().replace(/^http/i, "ws") + "/ws";
  // An https page can't open ws:// (mixed content → synchronous SecurityError). Match the page's
  // security context so a stored/injected http:// base can't produce a blocked socket.
  return typeof location !== "undefined" && location.protocol === "https:" ? ws.replace(/^ws:\/\//i, "wss://") : ws;
}
