/**
 * [C2] The browser's loopback forward proxy (agent-cad-and-browser §4.12 "Network block", §4.14 item
 * 23, §7). Real sockets throughout: a real listener, a raw TCP client speaking the proxy protocol, and
 * local fixture servers as targets. A resolver stub scripts DNS; a dial stub records which address is
 * dialled and stands a local server in for a public address (nothing leaves the machine).
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { connect, type Socket } from "node:net";
import { BrowserProxy, BrowserProxyManager, blockedAddressReason, isLoopbackAddress, vetTarget, type BrowserProxyOptions, type ProxyDecision, type ProxyPolicy } from "../../src/browser/proxy";
import { startFixtureSite, type FixtureSite } from "../fixtures/browser/fixture-site";

let target: FixtureSite; // "a daemon the browser must not reach", on loopback
let publicSite: FixtureSite; // stands in for a server on the public internet
let proxy: BrowserProxy;
let decisions: ProxyDecision[];
let dialled: string[];
let dns: Map<string, string[][]>; // hostname → the answers to give, one per lookup (the last repeats)
let lookups: string[];

const PUBLIC = "93.184.216.34";

function options(over: Partial<BrowserProxyOptions> = {}): BrowserProxyOptions {
  return {
    resolve: async (host) => {
      lookups.push(host);
      const answers = dns.get(host);
      if (!answers) throw new Error(`ENOTFOUND ${host}`);
      return answers.length > 1 ? answers.shift()! : answers[0]!;
    },
    fleetHosts: () => ["m1.tailnet.example", "100.101.102.103", "203.0.113.77"],
    selfHosts: () => ["m4.tailnet.example", "198.51.100.9"],
    onDecision: (d) => void decisions.push(d),
    // Public addresses are dialled at the local stand-in; everything else for real.
    dial: (address, port) => {
      dialled.push(address);
      return blockedAddressReason(address) ? connect({ host: address, port }) : connect({ host: "127.0.0.1", port: publicSite.port });
    },
    ...over,
  };
}

/** Send raw bytes to the proxy and collect everything it answers until it closes the connection. */
function raw(port: number, text: string, then?: (sock: Socket, soFar: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const sock = connect({ host: "127.0.0.1", port }, () => sock.write(text));
    const timer = setTimeout(() => (sock.destroy(), resolve(out)), 4000);
    sock.on("data", (d) => {
      out += d.toString("latin1");
      if (then?.(sock, out)) then = undefined;
    });
    sock.on("close", () => (clearTimeout(timer), resolve(out)));
    sock.on("error", (e) => (clearTimeout(timer), reject(e)));
  });
}
const get = (url: string): Promise<string> => raw(proxy.port, `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nProxy-Connection: keep-alive\r\n\r\n`);
/** CONNECT, then (if the tunnel opens) one HTTP request through it. */
const tunnel = (hostPort: string, path = "/page2"): Promise<string> =>
  raw(proxy.port, `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`, (sock, soFar) => {
    if (!soFar.includes("\r\n\r\n")) return false;
    if (soFar.startsWith("HTTP/1.1 200")) sock.write(`GET ${path} HTTP/1.1\r\nHost: ${hostPort}\r\nConnection: close\r\n\r\n`);
    return true;
  });
const status = (response: string): number => Number(/^HTTP\/1\.[01] (\d{3})/.exec(response)?.[1] ?? 0);

beforeEach(() => {
  target = startFixtureSite();
  publicSite = startFixtureSite();
  decisions = [];
  dialled = [];
  lookups = [];
  dns = new Map([
    ["public.example", [[PUBLIC]]],
    ["evil.example", [["127.0.0.1"]]],
    ["m1.tailnet.example", [[PUBLIC]]],
  ]);
  proxy = new BrowserProxy(options());
  proxy.listen();
});
afterEach(() => {
  proxy.close();
  target.stop();
  publicSite.stop();
});

describe("the block list", () => {
  test("[C2] blockedAddressReason: loopback, RFC 1918, link-local, tailnet/CGNAT, unique-local (incl. Tailscale's IPv6 range), unspecified — and the public internet is not blocked", () => {
    const blocked = [
      "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "100.100.100.100", "100.127.255.255", "0.0.0.0", "0.1.2.3", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fe80::1", "febf::1", "fc00::1", "fd7a:115c:a1e0::1", "fdff::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "fe80::1%en0",
      "not-an-address", "",
    ];
    for (const ip of blocked) expect([ip, typeof blockedAddressReason(ip)]).toEqual([ip, "string"]);
    const open = ["93.184.216.34", "1.1.1.1", "8.8.8.8", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.167.1.1", "169.253.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"];
    for (const ip of open) expect([ip, blockedAddressReason(ip)]).toEqual([ip, undefined]);
    expect(isLoopbackAddress("127.0.0.53")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });

  test("[C2] through the proxy: 127.0.0.1, a 10.x address, a tailnet address and a public name that resolves to 127.0.0.1 are all refused with 403; a public address is allowed", async () => {
    for (const url of [target.url("/page2"), `http://10.1.2.3:${target.port}/`, `http://100.101.1.1:${target.port}/`, `http://evil.example:${target.port}/page2`]) {
      const res = await get(url);
      expect([url, status(res)]).toEqual([url, 403]);
      expect(res).toContain("Blocked by Anvil");
    }
    expect(dialled).toEqual([]); // no refused target was ever dialled…
    expect(target.requests).toEqual([]); // …and the loopback server saw nothing

    const ok = await get(`http://${PUBLIC}:8080/page2`);
    expect(status(ok)).toBe(200);
    expect(ok).toContain("Fixture Two");
    const named = await get("http://public.example/page2");
    expect(status(named)).toBe(200);
    expect(dialled).toEqual([PUBLIC, PUBLIC]);
    expect(publicSite.requests.map((r) => r.path)).toEqual(["/page2", "/page2"]);
    expect(decisions.filter((d) => d.allowed).map((d) => d.address)).toEqual([PUBLIC, PUBLIC]);
  });

  test("[C2] localhost, [::1], link-local, RFC 1918 and unique-local targets are refused, for plain HTTP and for CONNECT (which is how WebSockets arrive)", async () => {
    dns.set("localhost", [["::1", "127.0.0.1"]]);
    for (const host of ["localhost", "[::1]", "169.254.169.254", "192.168.0.10", "172.20.0.1", "[fd7a:115c:a1e0::5]", "[fe80::1]", "0.0.0.0", "[::ffff:127.0.0.1]"]) {
      expect([host, status(await get(`http://${host}:${target.port}/page2`))]).toEqual([host, 403]);
      const viaConnect = await tunnel(`${host}:${target.port}`);
      expect([host, status(viaConnect)]).toEqual([host, 403]);
      expect(viaConnect).not.toContain("Fixture Two");
    }
    expect(dialled).toEqual([]);
    expect(target.requests).toEqual([]);
    expect(decisions.every((d) => !d.allowed)).toBe(true);
    expect(decisions.filter((d) => d.kind === "connect")).toHaveLength(9);
  });

  test("[C2] every resolved address is checked: a name with one public and one private address is refused", async () => {
    dns.set("mixed.example", [[PUBLIC, "10.0.0.5"]]);
    dns.set("mixed6.example", [["2606:4700:4700::1111", "fd7a:115c:a1e0::9"]]);
    expect(status(await get("http://mixed.example/page2"))).toBe(403);
    expect(status(await get("http://mixed6.example/page2"))).toBe(403);
    expect(status(await tunnel("mixed.example:443"))).toBe(403);
    expect(dialled).toEqual([]);
    expect(publicSite.requests).toEqual([]);
  });

  test("[C2] every fleet member's hostname and address is refused whatever it resolves to, and so are the daemon's own addresses", async () => {
    dns.set("m4.tailnet.example", [[PUBLIC]]);
    dns.set("alias.example", [["203.0.113.77"]]); // another name for a member's (public) address
    for (const url of ["http://m1.tailnet.example:7701/api/health", "http://M1.Tailnet.Example.:7701/", "http://100.101.102.103:7701/", "http://203.0.113.77:7701/", "http://alias.example:7701/", "http://m4.tailnet.example:7701/", "http://198.51.100.9:7701/"]) {
      const res = await get(url);
      expect([url, status(res)]).toEqual([url, 403]);
    }
    expect(status(await tunnel("m1.tailnet.example:7701"))).toBe(403);
    expect(dialled).toEqual([]);
    expect(publicSite.requests).toEqual([]);
    expect(decisions.find((d) => d.host === "m1.tailnet.example")!.reason).toMatch(/machine in the fleet/);
  });

  test("[C2] an unresolvable name, a non-http scheme and a malformed request are refused without dialling anything", async () => {
    expect(status(await get("http://nowhere.invalid/"))).toBe(403);
    expect(status(await raw(proxy.port, "GET ftp://public.example/ HTTP/1.1\r\n\r\n"))).toBe(400);
    expect(status(await raw(proxy.port, "GET /relative HTTP/1.1\r\nHost: public.example\r\n\r\n"))).toBe(400);
    expect(status(await raw(proxy.port, "NONSENSE\r\n\r\n"))).toBe(400);
    expect(status(await raw(proxy.port, "CONNECT no-port HTTP/1.1\r\n\r\n"))).toBe(400);
    expect(status(await raw(proxy.port, `GET http://public.example/ HTTP/1.1\r\nX: ${"a".repeat(70_000)}`))).toBe(431);
    expect(dialled).toEqual([]);
  });
});

describe("DNS rebinding", () => {
  test("[C2] a name that answers public first and private next: the address that was checked is the one connected, with one lookup per connection", async () => {
    dns.set("rebind.example", [[PUBLIC], ["127.0.0.1"]]);

    // Connection 1: the lookup says public. The proxy dials THAT address and does not look again —
    // a second lookup would have returned 127.0.0.1 and reached the loopback server.
    const first = await get(`http://rebind.example:${target.port}/page2`);
    expect(status(first)).toBe(200);
    expect(lookups).toEqual(["rebind.example"]);
    expect(dialled).toEqual([PUBLIC]);
    expect(decisions.at(-1)).toMatchObject({ allowed: true, address: PUBLIC });
    expect(target.requests).toEqual([]); // the loopback server was not reached
    expect(publicSite.requests.map((r) => r.path)).toEqual(["/page2"]);

    // Connection 2: now the name answers 127.0.0.1. Checked per connection → refused, nothing dialled.
    const second = await get(`http://rebind.example:${target.port}/page2`);
    expect(status(second)).toBe(403);
    expect(lookups).toEqual(["rebind.example", "rebind.example"]);
    expect(dialled).toEqual([PUBLIC]);
    expect(target.requests).toEqual([]);

    // The same through CONNECT.
    dns.set("rebind2.example", [[PUBLIC], ["10.0.0.7"]]);
    expect(status(await tunnel(`rebind2.example:${target.port}`))).toBe(200);
    expect(status(await tunnel(`rebind2.example:${target.port}`))).toBe(403);
    expect(dialled).toEqual([PUBLIC, PUBLIC]);
    expect(target.requests).toEqual([]);
  });

  test("[C2] vetTarget returns only addresses it checked, and never the name", async () => {
    const policy: ProxyPolicy = { resolve: async () => [PUBLIC, "1.1.1.1"], fleetHosts: () => [], selfHosts: () => [], allowedLoopbackPorts: new Set() };
    expect(await vetTarget("multi.example", 443, policy)).toEqual({ ok: true, address: PUBLIC, addresses: [PUBLIC, "1.1.1.1"] });
    expect(await vetTarget("multi.example", 443, { ...policy, resolve: async () => ["not-an-ip"] })).toMatchObject({ ok: false });
    expect(await vetTarget("multi.example", 443, { ...policy, resolve: async () => [] })).toMatchObject({ ok: false });
    expect(await vetTarget("multi.example", 0, policy)).toMatchObject({ ok: false });
  });
});

describe("plain HTTP and CONNECT forwarding", () => {
  test("[C2] an allowed plain request is forwarded in origin form with the proxy headers removed; an allowed CONNECT is a transparent tunnel", async () => {
    const res = await get("http://public.example/page2");
    expect(status(res)).toBe(200);
    expect(res).toContain("Fixture Two");
    const tunnelled = await tunnel("public.example:443");
    expect(tunnelled.startsWith("HTTP/1.1 200 Connection Established")).toBe(true);
    expect(tunnelled).toContain("Fixture Two");
    expect(publicSite.requests.map((r) => r.path)).toEqual(["/page2", "/page2"]);
  });

  test("[C2] a target that does not answer is a 502, not a hang and not a fallback to another address", async () => {
    const dead = startFixtureSite();
    const deadPort = dead.port;
    dead.stop();
    proxy.close();
    proxy = new BrowserProxy(options({ dial: (address) => (dialled.push(address), connect({ host: "127.0.0.1", port: deadPort })) }));
    proxy.listen();
    expect(status(await get("http://public.example/page2"))).toBe(502);
    expect(dialled).toEqual([PUBLIC]);
  });
});

describe("per-session listeners and the loopback exemption", () => {
  let manager: BrowserProxyManager;
  beforeEach(() => {
    manager = new BrowserProxyManager(options());
  });
  afterEach(() => manager.stop());
  const viaSession = async (sessionId: string, url: string): Promise<number> => {
    const port = manager.get(sessionId)!.port;
    return status(await raw(port, `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n\r\n`));
  };

  test("[C2] one listener per session on its own random loopback port; ensure() is stable until the listener dies", () => {
    const a = manager.ensure("sess_a");
    const b = manager.ensure("sess_b");
    if ("error" in a || "error" in b) throw new Error("no listener");
    expect(a.port).not.toBe(b.port);
    expect(manager.ensure("sess_a")).toEqual({ port: a.port });
    expect(manager.running("sess_a")).toBe(true);
    expect(manager.running("sess_zzz")).toBe(false);
    expect(manager.state()).toEqual({ state: "ready", sessions: 2 });
  });

  test("[C2] allowLoopbackPort opens one loopback port for one session only; revoke closes it again", async () => {
    manager.ensure("sess_a");
    manager.ensure("sess_b");
    expect(await viaSession("sess_a", target.url("/page2"))).toBe(403);

    expect(manager.allowLoopbackPort("sess_a", target.port)).toBe(true);
    expect(await viaSession("sess_a", target.url("/page2"))).toBe(200);
    expect(await viaSession("sess_a", target.url("/page2", "localhost").replace("localhost", "127.0.0.1"))).toBe(200);
    expect(await viaSession("sess_b", target.url("/page2"))).toBe(403); // the other session: still refused
    expect(await viaSession("sess_a", publicSite.url("/page2"))).toBe(403); // another loopback port: still refused
    expect(await viaSession("sess_a", `http://10.0.0.1:${target.port}/`)).toBe(403); // the port alone opens nothing private
    expect(target.requests).toHaveLength(2);

    manager.revoke("sess_a", target.port);
    expect(await viaSession("sess_a", target.url("/page2"))).toBe(403);
    expect(manager.allowLoopbackPort("sess_none", target.port)).toBe(false); // no listener → nothing opened

    manager.allowLoopbackPort("sess_a", target.port);
    manager.revoke("sess_a"); // every exemption
    expect(await viaSession("sess_a", target.url("/page2"))).toBe(403);
    expect(target.requests).toHaveLength(2);
  });

  test("[C2] proxy dies: the browser has no route out (its port refuses connections), the state reports stopped, and Check recovers", async () => {
    const a = manager.ensure("sess_a");
    if ("error" in a) throw new Error("no listener");
    manager.get("sess_a")!.close(); // the listener dies under the browser

    await expect(raw(a.port, "GET http://public.example/ HTTP/1.1\r\n\r\n")).rejects.toThrow(/ECONNREFUSED|connect/i);
    expect(manager.running("sess_a")).toBe(false);
    expect(manager.state().state).toBe("stopped");
    expect(manager.state().reason).toMatch(/stopped unexpectedly/);
    expect(publicSite.requests).toEqual([]);

    manager.recheck(); // the operator's Check
    expect(manager.state()).toEqual({ state: "ready", sessions: 0 });
    const again = manager.ensure("sess_a");
    expect("port" in again && again.port !== a.port).toBe(true);
  });

  test("[C2] a stopped manager refuses to create a listener, and one that cannot bind reports why", () => {
    manager.ensure("sess_a");
    manager.stop("the browser's network block is stopped");
    expect(manager.ensure("sess_a")).toEqual({ error: "the browser's network block is stopped" });
    expect(manager.state()).toEqual({ state: "stopped", reason: "the browser's network block is stopped", sessions: 0 });
    expect(manager.running("sess_a")).toBe(false);

    const broken = new BrowserProxyManager(options(), () => ({ listen: () => { throw new Error("EADDRNOTAVAIL"); }, close() {} }) as never);
    expect(broken.ensure("sess_a")).toEqual({ error: "the browser's network block could not start: EADDRNOTAVAIL" });
    expect(broken.state().state).toBe("stopped");
  });
});
