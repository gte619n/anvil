/**
 * [BE2-17] The identity gate runs on every request and used to spawn uncached `tailscale` subprocesses
 * each time. selfLogin is now memoized (5min TTL) and whois is a 60s LRU by IP. These pin: within the
 * TTL the underlying runner is called ONCE; past the TTL it refreshes.
 */
import { test, expect, beforeEach } from "bun:test";
import { tailscaleSelfLogin, tailscaleWhois, __resetIdentityCaches } from "../../src/server/pairing";

beforeEach(() => __resetIdentityCaches());

test("[BE2-17] selfLogin memoizes within the 5min TTL and refreshes after it", async () => {
  let clock = 0;
  let calls = 0;
  const run = async () => {
    calls++;
    return JSON.stringify({ Self: { UserID: 1 }, User: { "1": { LoginName: "me@example.com" } } });
  };
  const inject = { now: () => clock, run };
  expect(await tailscaleSelfLogin(inject)).toBe("me@example.com");
  expect(await tailscaleSelfLogin(inject)).toBe("me@example.com");
  expect(calls).toBe(1); // second call served from cache
  clock += 5 * 60_000 + 1; // TTL elapses
  expect(await tailscaleSelfLogin(inject)).toBe("me@example.com");
  expect(calls).toBe(2); // refreshed
});

test("[BE2-17] whois caches per IP within the 60s TTL", async () => {
  let clock = 0;
  const calls: string[] = [];
  const run = async (args: string[]) => {
    const ip = args[args.length - 1]!;
    calls.push(ip);
    return JSON.stringify({ UserProfile: { LoginName: `${ip}@ex.com` } });
  };
  const inject = { now: () => clock, run };
  expect(await tailscaleWhois("100.64.0.1", inject)).toBe("100.64.0.1@ex.com");
  expect(await tailscaleWhois("100.64.0.1", inject)).toBe("100.64.0.1@ex.com");
  expect(await tailscaleWhois("100.64.0.2", inject)).toBe("100.64.0.2@ex.com");
  expect(calls).toEqual(["100.64.0.1", "100.64.0.2"]); // first IP cached; second is a distinct key
  clock += 60_001; // TTL elapses
  expect(await tailscaleWhois("100.64.0.1", inject)).toBe("100.64.0.1@ex.com");
  expect(calls).toEqual(["100.64.0.1", "100.64.0.2", "100.64.0.1"]); // refreshed after TTL
});
