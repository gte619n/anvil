/**
 * [Phase 4] Daemon endpoint resolution. Pins daemonBase (injected native URL vs page origin),
 * apiUrl (absolute pass-through + relative resolution), and the wsUrl mixed-content guard — an
 * https page must never emit ws:// (which browsers reject with a synchronous SecurityError).
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";

let api: typeof import("../../web/src/api");

beforeAll(async () => {
  installDom({ url: "https://appassets.androidplatform.net/app/" }); // an https page
  api = await import("../../web/src/api");
});
afterAll(() => uninstallDom());

beforeEach(() => {
  delete (globalThis as any).window.ANVIL_DAEMON_URL;
});

test("daemonBase uses the injected native URL and strips a trailing slash", () => {
  (globalThis as any).window.ANVIL_DAEMON_URL = "https://mac.ts.net:7701/";
  expect(api.daemonBase()).toBe("https://mac.ts.net:7701");
});

test("daemonBase falls back to the page origin when not injected", () => {
  expect(api.daemonBase()).toBe("https://appassets.androidplatform.net");
});

test("apiUrl passes absolute URLs through and resolves relative paths", () => {
  (globalThis as any).window.ANVIL_DAEMON_URL = "https://mac.ts.net:7701";
  expect(api.apiUrl("https://other/x")).toBe("https://other/x");
  expect(api.apiUrl("/api/health")).toBe("https://mac.ts.net:7701/api/health");
  expect(api.apiUrl("api/health")).toBe("https://mac.ts.net:7701/api/health"); // adds the leading slash
});

test("wsUrl upgrades to wss on an https page (mixed-content guard)", () => {
  // Even a stored/injected http:// base must not produce a blocked ws:// on an https page.
  (globalThis as any).window.ANVIL_DAEMON_URL = "http://mac.ts.net:7701";
  expect(api.wsUrl()).toBe("wss://mac.ts.net:7701/ws");
  (globalThis as any).window.ANVIL_DAEMON_URL = "https://mac.ts.net:7701";
  expect(api.wsUrl()).toBe("wss://mac.ts.net:7701/ws");
});

test("sameServerUrl matches across scheme + trailing-slash drift (zombie-session reconcile)", () => {
  // The member URL http/https drift: a session cached under the http:// url the server was added
  // with must still reconcile against the https:// url it reconnects under, or its row zombies.
  expect(api.sameServerUrl("http://m1.ts.net:2501", "https://m1.ts.net:2501")).toBe(true);
  expect(api.sameServerUrl("https://m1.ts.net:2501/", "https://m1.ts.net:2501")).toBe(true);
  expect(api.sameServerUrl("https://M1.TS.NET:2501", "https://m1.ts.net:2501")).toBe(true);
});

test("sameServerUrl keeps genuinely different daemons apart", () => {
  expect(api.sameServerUrl("https://m1.ts.net:2501", "https://m2.ts.net:2501")).toBe(false); // different host
  expect(api.sameServerUrl("https://m1.ts.net:2501", "https://m1.ts.net:2502")).toBe(false); // different port
  expect(api.sameServerUrl(undefined, "https://m1.ts.net:2501")).toBe(false); // no recorded owner
});
