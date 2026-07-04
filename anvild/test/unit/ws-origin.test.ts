/**
 * [SEC-H3] WebSockets are exempt from same-origin/CORS, so any web page a trusted device's browser
 * loads can open `ws://<daemon>/ws` and immediately receive the full session list, budget, and
 * autopilot snapshot, then dispatch commands — a cross-site WebSocket hijack. Tailscale (the accepted
 * network boundary) does NOT stop this: the victim's browser is already on the tailnet. So we check
 * the `Origin` on the upgrade. The allowlist must not break the real clients:
 *   - PWA: same-origin as the daemon
 *   - Android WebView: https://appassets.androidplatform.net (WebViewAssetLoader)
 *   - iOS/macOS WebView: anvil-app:// custom scheme (non-http)
 *   - native fetch / CLI: no Origin header at all
 */
import { test, expect } from "bun:test";
import { isAllowedWsOrigin } from "../../src/server/origin";

const HOST = "100.64.1.2:7701";

test("allows the real clients", () => {
  expect(isAllowedWsOrigin(null, HOST)).toBe(true); // native fetch / CLI (no Origin)
  expect(isAllowedWsOrigin("", HOST)).toBe(true);
  expect(isAllowedWsOrigin("null", HOST)).toBe(true); // opaque/sandboxed
  expect(isAllowedWsOrigin(`http://${HOST}`, HOST)).toBe(true); // same-origin PWA
  expect(isAllowedWsOrigin("https://appassets.androidplatform.net", HOST)).toBe(true); // Android
  expect(isAllowedWsOrigin("anvil-app://app", HOST)).toBe(true); // iOS/macOS custom scheme
  expect(isAllowedWsOrigin("https://mac.tail1234.ts.net", "mac.tail1234.ts.net")).toBe(true); // tailscale serve, no port
});

test("rejects a foreign browser origin (the drive-by attack)", () => {
  expect(isAllowedWsOrigin("https://evil.example.com", HOST)).toBe(false);
  expect(isAllowedWsOrigin("http://evil.example.com", HOST)).toBe(false);
  expect(isAllowedWsOrigin("http://100.64.1.9:7701", HOST)).toBe(false); // another tailnet host's page
});

test("honors an extra configured allowlist", () => {
  expect(isAllowedWsOrigin("https://my.other.app", HOST, ["https://my.other.app"])).toBe(true);
});
