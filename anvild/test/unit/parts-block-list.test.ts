/**
 * [C5] The network block list shared by the browser proxy and parts_fetch (`vetTarget`): 6to4
 * (2002::/16) and the benchmarking range 198.18.0.0/15, added in the Phase C5 review.
 */
import { describe, test, expect } from "bun:test";
import { blockedAddressReason, vetTarget, type ProxyPolicy } from "../../src/browser/proxy";

const policy = (answers: Record<string, string[]> = {}): ProxyPolicy => ({
  resolve: async (h) => {
    const a = answers[h];
    if (!a) throw new Error(`ENOTFOUND ${h}`);
    return a;
  },
  fleetHosts: () => [],
  selfHosts: () => [],
  allowedLoopbackPorts: new Set(),
});

describe("block list: 6to4 and 198.18.0.0/15", () => {
  test("[C5] 6to4 (2002::/16) is refused — those embedding loopback, RFC 1918 or tailnet IPv4 name the embedded address, and one with a public IPv4 is refused too", () => {
    expect(blockedAddressReason("2002:7f00:0001::")).toBe("a 6to4 address (2002::/16) embedding 127.0.0.1, a loopback address");
    expect(blockedAddressReason("2002:7f00:1::1")).toMatch(/embedding 127\.0\.0\.1, a loopback address/);
    expect(blockedAddressReason("2002:c0a8:0101::1")).toMatch(/embedding 192\.168\.1\.1, a private address \(192\.168\.0\.0\/16\)/);
    expect(blockedAddressReason("2002:0a00:0001::")).toMatch(/embedding 10\.0\.0\.1, a private address \(10\.0\.0\.0\/8\)/);
    expect(blockedAddressReason("2002:6440:0001::")).toMatch(/embedding 100\.64\.0\.1, a tailnet/);
    expect(blockedAddressReason("2002:5db8:d822::1")).toBe("a 6to4 address (2002::/16)"); // 93.184.216.34 embedded: still a 6to4 LAN
    // Neighbours of 2002::/16 are not caught by it.
    expect(blockedAddressReason("2003::1")).toBeUndefined();
    expect(blockedAddressReason("2001:db8::1")).toBeUndefined();
  });

  test("[C5] 198.18.0.0/15 is refused (plain and v4-mapped); its neighbours are not", () => {
    for (const ip of ["198.18.0.1", "198.19.255.254", "::ffff:198.18.5.5"]) expect([ip, blockedAddressReason(ip)]).toEqual([ip, "a benchmarking address (198.18.0.0/15)"]);
    for (const ip of ["198.17.255.255", "198.20.0.1"]) expect([ip, blockedAddressReason(ip)]).toEqual([ip, undefined]);
  });

  test("[C5] vetTarget (the proxy's and parts_fetch's check) refuses a 6to4 or 198.18/15 literal and a name that resolves to one", async () => {
    const p = policy({ "six.test": ["93.184.216.34", "2002:7f00:1::"], "bench.test": ["198.18.0.9"], "ok.test": ["93.184.216.34"] });
    for (const host of ["2002:7f00:1::", "[2002:c0a8::1]", "198.18.0.1", "six.test", "bench.test"]) expect([host, (await vetTarget(host, 443, p)).ok]).toEqual([host, false]);
    expect(await vetTarget("six.test", 443, p)).toMatchObject({ ok: false, reason: expect.stringMatching(/resolves to 2002:7f00:1::, a 6to4 address/) });
    expect(await vetTarget("ok.test", 443, p)).toMatchObject({ ok: true, address: "93.184.216.34" });
  });
});
