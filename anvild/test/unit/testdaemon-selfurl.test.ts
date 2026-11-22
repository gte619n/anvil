/**
 * [C4] Decision 25: the bug the C0 spike found while booting the test daemon without ANVIL_BASE_URL.
 * `tailscale status --json` can print something that is not JSON; `discoverSelfBaseUrl` then threw
 * out of `parseTailscalePeers` as an unhandled rejection in whoever asked for the daemon's own URL.
 */
import { describe, test, expect } from "bun:test";
import { discoverSelfBaseUrl, parseTailscalePeers } from "../../src/server/fleet";

describe("discoverSelfBaseUrl with unparsable tailscale output", () => {
  test("[C4] non-JSON output from tailscale resolves — to the tailnet address when there is one, else undefined — and never rejects", async () => {
    for (const junk of ["Tailscale is stopped.\n", "# Health check:\n#     - not logged in\n", "<html>", "{", "null", "[]", '"text"', "42"]) {
      const probes: string[] = [];
      const withIp = discoverSelfBaseUrl({ port: 7799, runTailscale: async () => junk, probe: async (b) => (probes.push(b), null), ipv4: () => "100.101.102.103" });
      expect([junk, await withIp]).toEqual([junk, "http://100.101.102.103:7799"]);
      expect(probes).toEqual([]); // no name was learned, so nothing was probed
      expect([junk, await discoverSelfBaseUrl({ port: 7799, runTailscale: async () => junk, ipv4: () => undefined })]).toEqual([junk, undefined]);
    }
  });

  test("[C4] the parser itself still throws on non-JSON (its other callers report that as a warning), and valid output still yields the MagicDNS name", async () => {
    expect(() => parseTailscalePeers("Tailscale is stopped.")).toThrow();
    const status = JSON.stringify({ Self: { DNSName: "mymac.tail-scale.ts.net." } });
    expect(await discoverSelfBaseUrl({ port: 7799, runTailscale: async () => status, probe: async (b) => (b === "https://mymac.tail-scale.ts.net" ? { serverId: "s", serverName: "n", version: "1" } : null) })).toBe("https://mymac.tail-scale.ts.net");
  });
});
