/**
 * [BE2-10] GET /api/fleet/members used to `await` an unthrottled heal pass, and a single malformed stored
 * member url made `new URL(...)` throw through Promise.all — so the endpoint 500'd forever until
 * fleet.json was hand-edited, taking down the whole Fleet dashboard. The heal is now fire-and-forget +
 * throttled + defensive. These pin: (a) a malformed url → 200, not 500; (b) the GET returns fast
 * regardless of a slow/failed heal probe.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";
const { createServer } = await import("../../src/server/http");

function bootWithFleet(members: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "anvil-fleetheal-"));
  writeFileSync(join(dir, "fleet.json"), JSON.stringify({ members }));
  const srv = createServer({ host: "127.0.0.1", port: 0, stateDir: dir, envFile: join(dir, "env") });
  return { base: `http://127.0.0.1:${srv.port}`, cleanup: () => { srv.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("[BE2-10] a malformed member url does not 500 the members endpoint", async () => {
  // serverId NOT starting with 'srv_' marks it a "stale" legacy record → triggers healStaleFleetRecords,
  // whose `new URL(m.url)` would previously throw through Promise.all and 500 the whole GET.
  const { base, cleanup } = bootWithFleet([
    { serverId: "legacyhost", serverName: "legacy", host: "legacy.invalid", url: "not a url" },
  ]);
  try {
    const t0 = Date.now();
    const res = await fetch(`${base}/api/fleet/members`);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200); // NOT 500
    const body = (await res.json()) as { members: Array<{ serverId: string }> };
    expect(body.members.map((m) => m.serverId)).toContain("legacyhost"); // still listed
    expect(elapsed).toBeLessThan(2000); // fire-and-forget heal never blocks the response
  } finally {
    cleanup();
  }
});

test("[BE2-10] the members GET stays fast even with an unreachable member to heal", async () => {
  const { base, cleanup } = bootWithFleet([
    { serverId: "legacyhost", serverName: "legacy", host: "10.255.255.1", url: "http://10.255.255.1:7701/" },
  ]);
  try {
    const t0 = Date.now();
    const res = await fetch(`${base}/api/fleet/members`);
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
  } finally {
    cleanup();
  }
});
