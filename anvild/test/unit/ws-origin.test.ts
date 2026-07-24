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

// A serve-mode daemon's Host is its MagicDNS name, so a sibling fleet member's browser page (a different
// MagicDNS host in the SAME tailnet) can open a cross-origin WS with no ANVIL_ALLOWED_ORIGINS config.
const TS_HOST = "beelink-4450.softshell-mark.ts.net:7701";

test("allows same-tailnet fleet-peer origins (cross-origin WS within the tailnet)", () => {
  expect(isAllowedWsOrigin("https://mac-mini-m4.softshell-mark.ts.net:7701", TS_HOST)).toBe(true); // the hub's page
  expect(isAllowedWsOrigin("https://mac-mini-m1.softshell-mark.ts.net:7701", TS_HOST)).toBe(true); // another member
  expect(isAllowedWsOrigin("https://beelink-4450.softshell-mark.ts.net:7701", TS_HOST)).toBe(true); // self
});

test("same-tailnet trust does not leak to other tailnets, spoofs, or public sites", () => {
  expect(isAllowedWsOrigin("https://mac.other-tailnet.ts.net:7701", TS_HOST)).toBe(false); // different tailnet
  expect(isAllowedWsOrigin("https://softshell-mark.ts.net.evil.com", TS_HOST)).toBe(false); // suffix in the middle
  expect(isAllowedWsOrigin("https://evilsoftshell-mark.ts.net", TS_HOST)).toBe(false); // no dot boundary
  expect(isAllowedWsOrigin("https://evil.example.com", TS_HOST)).toBe(false);
});

test("no same-tailnet trust when the daemon binds a bare IP (not serve mode)", () => {
  // Direct-IP Host → no MagicDNS domain derivable → a .ts.net origin gets no free pass.
  expect(isAllowedWsOrigin("https://mac-mini-m4.softshell-mark.ts.net:7701", "100.116.161.46:7701")).toBe(false);
  // And a Host directly under ts.net must not yield a bare "ts.net" that matches every tailnet.
  expect(isAllowedWsOrigin("https://anything.ts.net", "host.ts.net:7701")).toBe(false);
});
