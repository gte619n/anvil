import { test, expect } from "bun:test";
import { parseTailscalePeers, peerBases, planMemberUrlHeals, discoverFleet, discoverSelfBaseUrl, tailnetPeers, resolveMember, propagateTodoist, invitePeer, rotateToken, ackPair, type ProbeResult } from "../../src/server/fleet";

const SELF_STATUS = JSON.stringify({ Self: { DNSName: "mymac.tail-scale.ts.net." } });

test("discoverSelfBaseUrl: ANVIL_BASE_URL override wins (trailing slash trimmed)", async () => {
  expect(await discoverSelfBaseUrl({ port: 7701, override: "https://anvil.example.com/" })).toBe("https://anvil.example.com");
});

test("discoverSelfBaseUrl: prefers the MagicDNS https URL that answers /api/health", async () => {
  const url = await discoverSelfBaseUrl({
    port: 7701,
    runTailscale: async () => SELF_STATUS,
    probe: async (base) => (base === "https://mymac.tail-scale.ts.net" ? { serverId: "srv_self", serverName: "MyMac", version: "1" } : null),
  });
  expect(url).toBe("https://mymac.tail-scale.ts.net");
});

test("discoverSelfBaseUrl: falls back to http://<tailnet-ip>:<port> when no probe answers", async () => {
  const url = await discoverSelfBaseUrl({
    port: 7701,
    runTailscale: async () => SELF_STATUS,
    probe: async () => null,
    ipv4: () => "100.101.102.103",
  });
  expect(url).toBe("http://100.101.102.103:7701");
});

test("discoverSelfBaseUrl: no tailscale + no tailnet IP → undefined", async () => {
  expect(await discoverSelfBaseUrl({ port: 7701, runTailscale: async () => null, ipv4: () => undefined })).toBeUndefined();
});

/** A fake `fetch` whose handler maps a URL → {status, body}; records every URL it was called with. */
function fakeFetch(handler: (url: string) => { status?: number; body?: unknown } | "throw") {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = handler(url);
    // Throw Bun's ACTUAL refused-connection message, verbatim. The previous mock threw
    // "ECONNREFUSED …", whose "refused" happened to match the old string-based retry gate — so the
    // fallback tests passed while real pairing to a serve-less joiner failed (Bun's message contains
    // none of those keywords). The message IS the regression guard; keep it literal.
    if (r === "throw") throw new Error("Unable to connect. Is the computer able to access the url?");
    // A STRING body models a real non-JSON response (a proxy's HTML error page) — sent verbatim with a
    // text/html type so postPairing's JSON.parse actually throws, exercising the routeMissing branch.
    // JSON.stringify-ing it (the old behaviour) turned "<html>…" into valid JSON and silently skipped
    // that path. An object body is a normal JSON response.
    const raw = typeof r.body === "string";
    return new Response(raw ? (r.body as string) : JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": raw ? "text/html" : "application/json" },
    });
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

test("parseTailscalePeers: carries the CGNAT tailnet IPv4, and admits an IP-only (no-MagicDNS) peer", () => {
  const status = JSON.stringify({
    Self: { DNSName: "hub.ts.net.", TailscaleIPs: ["fd7a:aaaa::1", "100.100.1.1"] },
    Peer: {
      // MagicDNS OFF for this node: no DNSName, only a tailnet IP. Must NOT be dropped.
      nameless: { Online: true, TailscaleIPs: ["100.64.9.9", "fd7a:bbbb::2"] },
      // A non-CGNAT address (e.g. a subnet route) is not a tailnet IP → not picked up.
      lan: { DNSName: "lan.ts.net.", Online: true, TailscaleIPs: ["192.168.1.5"] },
    },
  });
  const peers = parseTailscalePeers(status);
  expect(peers).toContainEqual({ dnsName: "hub.ts.net", online: true, isSelf: true, ipv4: "100.100.1.1" });
  expect(peers).toContainEqual({ dnsName: "", online: true, isSelf: false, ipv4: "100.64.9.9" });
  expect(peers.find((p) => p.dnsName === "lan.ts.net")).toEqual({ dnsName: "lan.ts.net", online: true, isSelf: false }); // no CGNAT ip
});

test("peerBases: name → https+http; IP → http only; both → all three in preference order", () => {
  expect(peerBases({ dnsName: "m.ts.net" }, 7701)).toEqual(["https://m.ts.net:7701", "http://m.ts.net:7701"]);
  expect(peerBases({ ipv4: "100.64.9.9" }, 7701)).toEqual(["http://100.64.9.9:7701"]); // no https to a bare IP (no cert)
  expect(peerBases({ dnsName: "m.ts.net", ipv4: "100.64.9.9" }, 7701)).toEqual([
    "https://m.ts.net:7701",
    "http://m.ts.net:7701",
    "http://100.64.9.9:7701",
  ]);
});

test("discoverFleet: reaches an IP-only (no-MagicDNS) peer over http on its tailnet IP", async () => {
  const status = JSON.stringify({
    Self: { DNSName: "hub.ts.net.", TailscaleIPs: ["100.100.1.1"] },
    Peer: { nameless: { Online: true, TailscaleIPs: ["100.64.9.9"] } },
  });
  const probed: string[] = [];
  const probe = async (baseUrl: string): Promise<ProbeResult | null> => {
    probed.push(baseUrl);
    if (baseUrl === "https://hub.ts.net:7701") return { serverId: "srv_hub", serverName: "Hub", version: "1.0.0" };
    if (baseUrl === "http://100.64.9.9:7701") return { serverId: "srv_beelink", serverName: "", version: "1.0.0" };
    return null;
  };
  const res = await discoverFleet({ port: 7701, selfServerId: "srv_hub", runTailscale: async () => status, probe });

  expect(probed).toContain("http://100.64.9.9:7701"); // the IP-only peer was probed on its IP
  expect(probed).not.toContain("https://100.64.9.9:7701"); // never https to a bare IP
  const beelink = res.servers.find((s) => s.serverId === "srv_beelink")!;
  expect(beelink.url).toBe("http://100.64.9.9:7701");
  expect(beelink.serverName).toBe("100.64.9.9"); // no reported name, no dnsName → IP is the label
});

test("tailnetPeers: an IP-only node is listed with the IP as both label and host", async () => {
  const status = JSON.stringify({
    Self: { DNSName: "hub.ts.net." },
    Peer: { nameless: { Online: true, TailscaleIPs: ["100.64.9.9"] } },
  });
  const r = await tailnetPeers(async () => status);
  expect(r.peers).toContainEqual({ name: "100.64.9.9", host: "100.64.9.9", online: true });
});

test("planMemberUrlHeals: heals a MagicDNS-off member from its dead name-url to the rediscovered IP-url", () => {
  const members = [
    { serverId: "srv_beelink", url: "https://beelink.ts.net:7701" }, // name went dark (MagicDNS off)
    { serverId: "srv_mini", url: "https://mini.ts.net:7701" }, // still reachable at the same url
  ];
  const discovered = [
    { serverId: "srv_beelink", url: "http://100.64.9.9:7701" }, // same machine, now only on its tailnet IP
    { serverId: "srv_mini", url: "https://mini.ts.net:7701" },
  ];
  expect(planMemberUrlHeals(members, discovered)).toEqual([{ serverId: "srv_beelink", url: "http://100.64.9.9:7701" }]);
});

test("planMemberUrlHeals: skips legacy (non-srv_) records and members absent from discovery", () => {
  const members = [
    { serverId: "beelink.ts.net", url: "https://beelink.ts.net:7701" }, // legacy bare-host id → resolveMember's job
    { serverId: "srv_offline", url: "https://offline.ts.net:7701" }, // not in discovery (offline) → leave as-is
  ];
  const discovered = [{ serverId: "beelink.ts.net", url: "http://100.64.9.9:7701" }];
  expect(planMemberUrlHeals(members, discovered)).toEqual([]);
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

test("propagateTodoist: a bare-IP member is reached over http only (no wasted https probe to a certless IP)", async () => {
  const { fn, calls } = fakeFetch((u) => (u.startsWith("http://100.64.9.9:7701") ? { body: { ok: true } } : "throw"));
  const [r] = await propagateTodoist({ members: [{ url: "http://100.64.9.9:7701/", host: "100.64.9.9" }], token: "tok", fetchImpl: fn });
  expect(r!.ok).toBe(true);
  expect(r!.resolvedUrl).toBe("http://100.64.9.9:7701/");
  expect(calls).toEqual(["http://100.64.9.9:7701/api/integrations/todoist"]); // http only — https to a bare IP is skipped
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

// ── Push destination: capability-directed, with a 404 fallback (headless-join HJ-15 / §5.4 / §6) ──
//
// These cases pin the ONE thing the spec's v1.0 got wrong. An un-upgraded Mac *does* answer on :7701 —
// that's the ordinary daemon port — and returns 404 for an unknown route. A connect-failure-only
// fallback would read that as a hard failure and never try :7702, breaking pairing against every Mac
// that hasn't been upgraded yet.
//
// Coverage note (HJ-38): the :7702 leg ships with MOCKED coverage only. This exercises the selection
// logic and the fallback trigger against injected doubles — it asserts what we believe a
// pre-capability daemon does, never a real one.

test("invitePeer: a peer advertising `pairing` is pushed to its own :7701 daemon route", async () => {
  const { fn, calls } = fakeFetch((u) => (u.startsWith("https://joiner.ts.net:7701") ? { body: { ok: true, serverId: "srv_j", serverName: "Joiner" } } : "throw"));
  const r = await invitePeer({ host: "joiner.ts.net", code: "123456", token: "tok", hubServerId: "srv_hub", capabilities: ["auth", "pairing"], fetchImpl: fn });
  expect(r.ok).toBe(true);
  expect(r.serverId).toBe("srv_j");
  expect(calls).toEqual(["https://joiner.ts.net:7701/api/fleet/pair"]);
});

test("invitePeer: NO capabilities (a pre-capability daemon) goes straight to :7702 — no :7701 attempt", async () => {
  const { fn, calls } = fakeFetch(() => ({ body: { ok: true, serverId: "srv_mac" } }));
  const r = await invitePeer({ host: "oldmac.ts.net", code: "123456", token: "tok", hubServerId: "srv_hub", fetchImpl: fn });
  expect(r.ok).toBe(true);
  expect(calls).toEqual(["http://oldmac.ts.net:7702/anvil-pair"]);
});

test("invitePeer: capabilities WITHOUT `pairing` also route to :7702", async () => {
  const { fn, calls } = fakeFetch(() => ({ body: { ok: true } }));
  await invitePeer({ host: "mac.ts.net", code: "123456", token: "tok", hubServerId: "srv_hub", capabilities: ["autopilot", "auth"], fetchImpl: fn });
  expect(calls).toEqual(["http://mac.ts.net:7702/anvil-pair"]);
});

test("invitePeer: :7701 answers 404 → falls back to :7702 (the un-upgraded-Mac case, HJ-15)", async () => {
  // The daemon port is live and answering; it just doesn't know this route. That must NOT be a failure.
  const { fn, calls } = fakeFetch((u) => (u.includes(":7702") ? { body: { ok: true, serverId: "srv_mac" } } : { status: 404, body: "not found" }));
  const r = await invitePeer({ host: "mac.ts.net", code: "123456", token: "tok", hubServerId: "srv_hub", capabilities: ["pairing"], fetchImpl: fn });
  expect(r.ok).toBe(true);
  expect(calls).toContain("http://mac.ts.net:7702/anvil-pair");
});

test("invitePeer: :7701 answers 405 → same fallback", async () => {
  const { fn, calls } = fakeFetch((u) => (u.includes(":7702") ? { body: { ok: true } } : { status: 405, body: "method not allowed" }));
  expect((await invitePeer({ host: "m.ts.net", code: "1", token: "t", hubServerId: "h", capabilities: ["pairing"], fetchImpl: fn })).ok).toBe(true);
  expect(calls).toContain("http://m.ts.net:7702/anvil-pair");
});

test("invitePeer: a non-JSON error page (a proxy) is treated like a missing route, not a rejection", async () => {
  const { fn, calls } = fakeFetch((u) =>
    u.includes(":7702") ? { body: { ok: true } } : { status: 502, body: "<html>Bad Gateway</html>" },
  );
  expect((await invitePeer({ host: "m.ts.net", code: "1", token: "t", hubServerId: "h", capabilities: ["pairing"], fetchImpl: fn })).ok).toBe(true);
  expect(calls).toContain("http://m.ts.net:7702/anvil-pair");
});

test("invitePeer: connection refused on https falls through to http on the SAME port first", async () => {
  // Serve mode vs direct bind is a per-HOST property, so the scheme fallback is not optional: a
  // serve-mode joiner binds loopback and answers only https; a direct-bind joiner answers only http.
  const { fn, calls } = fakeFetch((u) => (u.startsWith("http://joiner.ts.net:7701") ? { body: { ok: true } } : "throw"));
  expect((await invitePeer({ host: "joiner.ts.net", code: "1", token: "t", hubServerId: "h", capabilities: ["pairing"], fetchImpl: fn })).ok).toBe(true);
  expect(calls.slice(0, 2)).toEqual(["https://joiner.ts.net:7701/api/fleet/pair", "http://joiner.ts.net:7701/api/fleet/pair"]);
});

test("invitePeer: a real REJECTION stops there — the credential is not shopped around to :7702", async () => {
  const { fn, calls } = fakeFetch(() => ({ status: 403, body: { ok: false, error: "wrong code" } }));
  const r = await invitePeer({ host: "joiner.ts.net", code: "000000", token: "tok", hubServerId: "srv_hub", capabilities: ["pairing"], fetchImpl: fn });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("wrong code");
  expect(calls.some((c) => c.includes(":7702"))).toBe(false);
});

test("invitePeer: sibling secrets ride along in the same payload (HJ-24/HJ-27)", async () => {
  let sent: Record<string, unknown> = {};
  const fn = (async (_u: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await invitePeer({ host: "j.ts.net", code: "123456", token: "tok", hubServerId: "h", capabilities: ["pairing"], todoistToken: "td", openRouterKey: "or", fleetName: "Home", fetchImpl: fn });
  expect(sent).toMatchObject({ code: "123456", token: "tok", hubServerId: "h", todoistToken: "td", openRouterKey: "or", fleetName: "Home" });
});

test("invitePeer: no hub token → refuses without any network call", async () => {
  const { fn, calls } = fakeFetch(() => ({ body: { ok: true } }));
  expect((await invitePeer({ host: "j.ts.net", code: "1", token: "", hubServerId: "h", fetchImpl: fn })).ok).toBe(false);
  expect(calls).toEqual([]);
});

test("ackPair: sent only to a :7701 pairing peer — a :7702 member disarms on its own successful pair", async () => {
  const { fn, calls } = fakeFetch(() => ({ body: { ok: true } }));
  expect((await ackPair({ host: "mac.ts.net", code: "1", hubServerId: "h", capabilities: ["auth"], fetchImpl: fn })).ok).toBe(true);
  expect(calls).toEqual([]);
  await ackPair({ host: "j.ts.net", code: "123456", hubServerId: "h", capabilities: ["pairing"], fetchImpl: fn });
  expect(calls).toEqual(["https://j.ts.net:7701/api/fleet/pair/ack"]);
});

test("rotateToken: probes each member and routes an UPGRADED one to :7701 (§6)", async () => {
  const probe = async (base: string): Promise<ProbeResult | null> =>
    base === "https://linux.ts.net:7701" ? { serverId: "srv_l", serverName: "L", version: "1", capabilities: ["auth", "pairing"] } : null;
  const { fn, calls } = fakeFetch((u) => (u === "https://linux.ts.net:7701/api/fleet/token" ? { body: { ok: true } } : "throw"));
  const [r] = await rotateToken({ members: [{ host: "linux.ts.net" }], token: "tok", hubServerId: "h", probe, fetchImpl: fn });
  expect(r!.ok).toBe(true);
  expect(calls).toEqual(["https://linux.ts.net:7701/api/fleet/token"]);
});

test("rotateToken: a pre-capability member is routed to :7702 (MOCKED coverage only — HJ-38)", async () => {
  const probe = async (base: string): Promise<ProbeResult | null> =>
    base === "https://oldmac.ts.net:7701" ? { serverId: "srv_m", serverName: "M", version: "0.9" } : null; // no capabilities field
  const { fn, calls } = fakeFetch(() => ({ body: { ok: true } }));
  const [r] = await rotateToken({ members: [{ host: "oldmac.ts.net" }], token: "tok", hubServerId: "h", probe, fetchImpl: fn });
  expect(r!.ok).toBe(true);
  expect(calls).toEqual(["http://oldmac.ts.net:7702/anvil-token"]);
});

test("rotateToken: an unreachable member (no probe answer) still tries :7702 rather than giving up", async () => {
  const { fn, calls } = fakeFetch(() => ({ body: { ok: true } }));
  const [r] = await rotateToken({ members: [{ host: "gone.ts.net" }], token: "tok", hubServerId: "h", probe: async () => null, fetchImpl: fn });
  expect(r!.ok).toBe(true);
  expect(calls).toEqual(["http://gone.ts.net:7702/anvil-token"]);
});

test("rotateToken: no token → every member reports an error, with no network calls", async () => {
  const { fn, calls } = fakeFetch(() => ({ body: { ok: true } }));
  const results = await rotateToken({ members: [{ host: "a.ts.net" }, { host: "b.ts.net" }], token: "", hubServerId: "h", fetchImpl: fn });
  expect(results.every((r) => !r.ok)).toBe(true);
  expect(calls).toEqual([]);
});

// ── Discovery carries the joiner's setup state + capabilities (HJ-9 / HJ-32) ─────────────────────

test("discoverFleet: a tokenless daemon is listed with subscriptionAuthOk:false and its capabilities", async () => {
  const status = JSON.stringify({ Self: { DNSName: "hub.ts.net." }, Peer: { a: { DNSName: "beelink.ts.net.", Online: true } } });
  const res = await discoverFleet({
    port: 7701,
    selfServerId: "srv_hub",
    runTailscale: async () => status,
    probe: async (base) =>
      base === "https://beelink.ts.net:7701"
        ? { serverId: "srv_bee", serverName: "beelink", version: "1.2", subscriptionAuthOk: false, capabilities: ["auth", "pairing"] }
        : null,
  });
  const bee = res.servers.find((s) => s.serverId === "srv_bee")!;
  expect(bee.subscriptionAuthOk).toBe(false); // → the Fleet UI labels it "needs setup"
  expect(bee.capabilities).toContain("pairing");
});

test("discoverFleet: arm-state is NOT exposed — health must never advertise an open credential window", async () => {
  const status = JSON.stringify({ Self: { DNSName: "hub.ts.net." }, Peer: { a: { DNSName: "bee.ts.net.", Online: true } } });
  const res = await discoverFleet({
    port: 7701,
    selfServerId: "srv_hub",
    runTailscale: async () => status,
    probe: async () => ({ serverId: "srv_bee", serverName: "bee", version: "1", subscriptionAuthOk: false, capabilities: ["pairing"] }),
  });
  expect(JSON.stringify(res)).not.toMatch(/armed|"code"/i);
});

test("resolveMember: carries capabilities through, so the invite path can pick a destination", async () => {
  const r = await resolveMember("j.ts.net", 7701, async (u) =>
    u.startsWith("https") ? { serverId: "srv_j", serverName: "J", version: "1", capabilities: ["pairing"], subscriptionAuthOk: false } : null,
  );
  expect(r.capabilities).toEqual(["pairing"]);
  expect(r.subscriptionAuthOk).toBe(false);
});
