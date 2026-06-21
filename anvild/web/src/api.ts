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

/** ws:// or wss:// URL for the daemon's /ws endpoint. */
export function wsUrl(): string {
  return daemonBase().replace(/^http/i, "ws") + "/ws";
}
