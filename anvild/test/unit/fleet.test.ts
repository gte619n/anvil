import { test, expect } from "bun:test";
import { parseTailscalePeers, discoverFleet, tailnetPeers, type ProbeResult } from "../../src/server/fleet";

test("tailnetPeers: lists other Macs by short name (Self + offline excluded from the picker)", async () => {
  const status = JSON.stringify({
    Self: { DNSName: "mac-mini-m4.tnet.ts.net." },
    Peer: {
      a: { DNSName: "mac-mini-m1.tnet.ts.net.", Online: true },
      b: { DNSName: "laptop.tnet.ts.net.", Online: false },
    },
  });
  const r = await tailnetPeers(async () => status);
  expect(r.ok).toBe(true);
  expect(r.peers).toContainEqual({ name: "mac-mini-m1", host: "mac-mini-m1.tnet.ts.net", online: true });
  expect(r.peers.find((p) => p.name === "laptop")?.online).toBe(false); // listed but marked offline
  expect(r.peers.some((p) => p.name === "mac-mini-m4")).toBe(false); // Self excluded
});

test("tailnetPeers: Tailscale unavailable → ok:false + warning", async () => {
  const r = await tailnetPeers(async () => null);
  expect(r.ok).toBe(false);
  expect(r.peers).toEqual([]);
  expect(r.warning).toMatch(/Tailscale/);
});

const STATUS = JSON.stringify({
  Self: { DNSName: "mac-mini.tail-scale.ts.net." },
  Peer: {
    nodeA: { DNSName: "laptop.tail-scale.ts.net.", Online: true },
    nodeB: { DNSName: "asleep.tail-scale.ts.net.", Online: false },
    nodeC: { DNSName: "phone.tail-scale.ts.net.", Online: true },
  },
});

test("parseTailscalePeers: Self + peers, trailing dot stripped, online flags carried", () => {
  const peers = parseTailscalePeers(STATUS);
  expect(peers).toContainEqual({ dnsName: "mac-mini.tail-scale.ts.net", online: true, isSelf: true });
  expect(peers).toContainEqual({ dnsName: "laptop.tail-scale.ts.net", online: true, isSelf: false });
  expect(peers.find((p) => p.dnsName === "asleep.tail-scale.ts.net")?.online).toBe(false);
});

test("discoverFleet: probes https then http per peer, flags self, dedups by serverId", async () => {
  const probed: string[] = [];
  // mac-mini = this hub (serve-capable → https). laptop = an App-Store-Tailscale peer that only
  // answers over plain http (https probe fails → http fallback). phone isn't an Anvil daemon.
  const probe = async (baseUrl: string): Promise<ProbeResult | null> => {
    probed.push(baseUrl);
    if (baseUrl === "https://mac-mini.tail-scale.ts.net:7701") return { serverId: "srv_self", serverName: "Mac mini", version: "1.0.0" };
    if (baseUrl === "http://laptop.tail-scale.ts.net:7701") return { serverId: "srv_laptop", serverName: "Laptop", version: "1.0.0" };
    return null; // https://laptop (forces fallback), phone (both schemes) → not Anvil
  };
  const res = await discoverFleet({
    port: 7701,
    selfServerId: "srv_self",
    runTailscale: async () => STATUS,
    probe,
  });

  expect(res.ok).toBe(true);
  // offline "asleep" peer is never probed, on either scheme
  expect(probed).not.toContain("https://asleep.tail-scale.ts.net:7701");
  expect(probed).not.toContain("http://asleep.tail-scale.ts.net:7701");
  // self answered on https (http never tried); laptop fell back to http; phone tried both
  expect(probed).toContain("https://mac-mini.tail-scale.ts.net:7701");
  expect(probed).not.toContain("http://mac-mini.tail-scale.ts.net:7701");
  expect(probed).toContain("https://laptop.tail-scale.ts.net:7701");
  expect(probed).toContain("http://laptop.tail-scale.ts.net:7701");

  const byId = new Map(res.servers.map((s) => [s.serverId, s]));
  expect(byId.get("srv_self")!.isSelf).toBe(true);
  expect(byId.get("srv_self")!.url).toBe("https://mac-mini.tail-scale.ts.net:7701"); // serve host → https
  expect(byId.get("srv_laptop")!.isSelf).toBe(false);
  expect(byId.get("srv_laptop")!.url).toBe("http://laptop.tail-scale.ts.net:7701"); // App Store host → http
  expect(res.servers).toHaveLength(2); // phone (null on both) excluded
});

test("resolveMemberUrl: prefers https, falls back to http, defaults to http", async () => {
  const { resolveMemberUrl } = await import("../../src/server/fleet");
  // serve-capable joiner answers https
  expect(await resolveMemberUrl("served.ts.net", 7701, async (u) => (u.startsWith("https") ? { serverId: "s", serverName: "", version: "" } : null))).toBe("https://served.ts.net:7701/");
  // App Store joiner answers only http
  expect(await resolveMemberUrl("plain.ts.net", 7701, async (u) => (u.startsWith("http://") ? { serverId: "s", serverName: "", version: "" } : null))).toBe("http://plain.ts.net:7701/");
  // not yet up → default http so the registry still has a usable entry
  expect(await resolveMemberUrl("down.ts.net", 7701, async () => null)).toBe("http://down.ts.net:7701/");
});

test("discoverFleet: same server reachable twice is deduped by serverId", async () => {
  const status = JSON.stringify({
    Self: { DNSName: "a.ts.net." },
    Peer: { x: { DNSName: "b.ts.net.", Online: true } },
  });
  const res = await discoverFleet({
    port: 7701,
    selfServerId: "srv_x",
    runTailscale: async () => status,
    probe: async () => ({ serverId: "srv_dup", serverName: "Dup", version: "1" }), // both answer with same id
  });
  expect(res.servers).toHaveLength(1);
  expect(res.servers[0]!.serverId).toBe("srv_dup");
});

test("discoverFleet: Tailscale unavailable → ok:false with a guidance warning", async () => {
  const res = await discoverFleet({ port: 7701, selfServerId: "srv_self", runTailscale: async () => null });
  expect(res.ok).toBe(false);
  expect(res.servers).toEqual([]);
  expect(res.warning).toMatch(/Tailscale/);
});

test("discoverFleet: unparseable status → ok:false, no throw", async () => {
  const res = await discoverFleet({ port: 7701, selfServerId: "srv_self", runTailscale: async () => "{not json" });
  expect(res.ok).toBe(false);
  expect(res.warning).toMatch(/parse/);
});
