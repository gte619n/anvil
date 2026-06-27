import { test, expect } from "bun:test";
import { parseTailscalePeers, discoverFleet, tailnetPeers, resolveMember, propagateTodoist, type ProbeResult } from "../../src/server/fleet";

/** A fake `fetch` whose handler maps a URL → {status, body}; records every URL it was called with. */
function fakeFetch(handler: (url: string) => { status?: number; body?: unknown } | "throw") {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = handler(url);
    if (r === "throw") throw new Error("ECONNREFUSED / wrong scheme"); // mimic an https-vs-http transport reject
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

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

test("resolveMember: returns the working URL plus the probed serverId/serverName", async () => {
  const probe = async (u: string): Promise<ProbeResult | null> =>
    u.startsWith("https") ? { serverId: "srv_real", serverName: "M1", version: "1.0.0" } : null;
  expect(await resolveMember("m1.ts.net", 7701, probe)).toEqual({ url: "https://m1.ts.net:7701/", serverId: "srv_real", serverName: "M1" });
  // not up yet → usable http entry, but no identity to heal from
  expect(await resolveMember("down.ts.net", 7701, async () => null)).toEqual({ url: "http://down.ts.net:7701/" });
});

test("propagateTodoist: heals a stale http record by reaching the member over https", async () => {
  // The registry has the member as http://, but it actually serves https (the original M1 bug). The
  // first scheme (https) must succeed and come back as the resolvedUrl so the caller can heal the URL.
  const { fn, calls } = fakeFetch((u) =>
    u.startsWith("https://m1.ts.net:7701") ? { body: { ok: true, account: "me@x.com", serverId: "srv_m1", serverName: "M1" } } : "throw",
  );
  const [r] = await propagateTodoist({
    members: [{ url: "http://m1.ts.net:7701/", host: "m1.ts.net", serverId: "m1.ts.net" }], // serverId == host (legacy)
    token: "tok",
    fetchImpl: fn,
  });
  expect(r!.ok).toBe(true);
  expect(r!.resolvedUrl).toBe("https://m1.ts.net:7701/"); // healed transport
  expect(r!.serverId).toBe("srv_m1"); // real id echoed back for healing the host-as-serverId record
  expect(r!.account).toBe("me@x.com");
  expect(calls[0]).toBe("https://m1.ts.net:7701/api/integrations/todoist"); // https tried first
});

test("propagateTodoist: falls back to http for a direct-bind (App Store) member", async () => {
  const { fn, calls } = fakeFetch((u) => (u.startsWith("http://plain.ts.net") ? { body: { ok: true } } : "throw"));
  const [r] = await propagateTodoist({ members: [{ url: "http://plain.ts.net:7701/", host: "plain.ts.net" }], token: "tok", fetchImpl: fn });
  expect(r!.ok).toBe(true);
  expect(r!.resolvedUrl).toBe("http://plain.ts.net:7701/");
  expect(calls).toEqual([
    "https://plain.ts.net:7701/api/integrations/todoist", // tried first, threw
    "http://plain.ts.net:7701/api/integrations/todoist", // fell back
  ]);
});

test("propagateTodoist: unreachable on both schemes → ok:false, no throw", async () => {
  const { fn } = fakeFetch(() => "throw");
  const [r] = await propagateTodoist({ members: [{ url: "http://gone.ts.net:7701/", host: "gone.ts.net" }], token: "tok", fetchImpl: fn });
  expect(r!.ok).toBe(false);
  expect(r!.resolvedUrl).toBeUndefined();
  expect(r!.error).toBeTruthy();
});

test("propagateTodoist: no token → ok:false without any network calls", async () => {
  const { fn, calls } = fakeFetch(() => ({ body: { ok: true } }));
  const [r] = await propagateTodoist({ members: [{ url: "https://m1.ts.net:7701/", host: "m1.ts.net" }], token: "", fetchImpl: fn });
  expect(r!.ok).toBe(false);
  expect(calls).toEqual([]);
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
