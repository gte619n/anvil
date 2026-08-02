/**
 * [BE2-15] Fleet rotate/invite are JOB-IFIED: the POST must answer fast (<~1s) even when a member is
 * unreachable/slow (the fan-out used to hold the request open ~14s of pairing timeouts per offline
 * member — the reason idleTimeout was raised to 120s), and the job status must eventually carry the
 * SAME per-member outcome the old synchronous response did. The fan-out network calls are injected
 * (ServerOptions.fleetNet) so a "sleeping Mac" is simulated deterministically — no real tailnet.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { rest } from "@protocol";

process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";
const { createServer } = await import("../../src/server/http");
type ServerOptions = Parameters<typeof createServer>[0];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function boot(extra: Partial<ServerOptions> = {}, members: unknown[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "anvil-fleetjobs-"));
  if (members.length) writeFileSync(join(dir, "fleet.json"), JSON.stringify({ members }));
  const srv = createServer({
    host: "127.0.0.1",
    port: 0,
    stateDir: dir,
    envFile: join(dir, "env"),
    // The loopback test caller has no provable tailnet identity (and the real resolver shells out to
    // the tailscale CLI, whose presence differs per machine) — pin it to the permissive "unknown".
    resolveIdentity: async () => ({ trust: "unknown" }),
    ...extra,
  });
  return { base: `http://127.0.0.1:${srv.port}`, cleanup: () => { srv.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

async function pollJob(base: string, jobId: string, timeoutMs = 10_000): Promise<rest.FleetJobStatusResponse> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = (await (await fetch(`${base}/api/fleet/jobs/${jobId}`)).json()) as rest.FleetJobStatusResponse;
    if (st.state === "done" || Date.now() >= deadline) return st;
    await sleep(100);
  }
}

test("[BE2-15] rotate POST answers fast with an unreachable member; the job carries the per-member failure", async () => {
  const member = { serverId: "srv_sleepy", serverName: "sleepy", host: "sleepy.ts.net", url: "https://sleepy.ts.net:7701/" };
  const { base, cleanup } = boot(
    {
      fleetNet: {
        // A sleeping Mac: the fan-out takes 3s and then reports it unreachable — far past the ~1s the
        // POST is allowed to hold the socket.
        rotateToken: async ({ members }) => {
          await sleep(3_000);
          return members.map((m) => ({ host: m.host, ok: false, error: "unreachable (simulated sleeping Mac)" }));
        },
      },
    },
    [member],
  );
  try {
    const t0 = Date.now();
    const res = await fetch(`${base}/api/fleet/rotate?async=1`, { method: "POST" });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(202);
    expect(elapsed).toBeLessThan(1_000); // the fan-out (3s) must NOT hold the POST open
    const start = (await res.json()) as rest.FleetJobStartResponse;
    expect(start.ok).toBe(true);
    expect(start.jobId).toStartWith("job_");
    expect(start.kind).toBe("rotate");
    expect(start.state).toBe("running");

    // A second POST while the fan-out runs JOINS the in-flight job (double-click / second client).
    const again = (await (await fetch(`${base}/api/fleet/rotate?async=1`, { method: "POST" })).json()) as rest.FleetJobStartResponse;
    expect(again.jobId).toBe(start.jobId);

    const final = await pollJob(base, start.jobId);
    expect(final.state).toBe("done");
    const result = final.result as rest.FleetRotateResponse;
    expect(result.ok).toBe(false);
    expect(result.results).toEqual([{ host: "sleepy.ts.net", ok: false, error: "unreachable (simulated sleeping Mac)" }]);
  } finally {
    cleanup();
  }
});

test("[BE2-15] invite POST answers fast with an unreachable joiner; the job carries the failure outcome", async () => {
  const { base, cleanup } = boot({
    fleetNet: {
      peerIPv4: async () => undefined,
      resolveMember: async (host, port) => ({ url: `http://${host}:${port}/` }), // never answers → no identity
      invitePeer: async () => {
        await sleep(3_000); // the credential push times out against a dead joiner
        return { ok: false, error: "no reachable transport (simulated)" };
      },
      ackPair: async () => ({ ok: true }),
    },
  });
  try {
    const t0 = Date.now();
    const res = await fetch(`${base}/api/fleet/invite?async=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "dead.ts.net", code: "123456" }),
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(202);
    expect(elapsed).toBeLessThan(1_000);
    const start = (await res.json()) as rest.FleetJobStartResponse;
    expect(start.kind).toBe("invite");
    expect(start.state).toBe("running");

    const final = await pollJob(base, start.jobId);
    expect(final.state).toBe("done");
    expect(final.result as rest.FleetInviteResponse).toEqual({ ok: false, error: "no reachable transport (simulated)" });
  } finally {
    cleanup();
  }
});

test("[BE2-15] without ?async=1 both POSTs keep the legacy synchronous shapes (old bundled native UIs)", async () => {
  const member = { serverId: "srv_ok", serverName: "okmac", host: "ok.ts.net", url: "https://ok.ts.net:7701/" };
  const { base, cleanup } = boot(
    {
      fleetNet: {
        rotateToken: async ({ members }) => members.map((m) => ({ host: m.host, ok: true })),
        peerIPv4: async () => undefined,
        resolveMember: async (host) => ({ url: `https://${host}:7701/`, serverId: "srv_new", serverName: "newmac" }),
        invitePeer: async () => ({ ok: true, serverId: "srv_new", serverName: "newmac" }),
        ackPair: async () => ({ ok: true }),
      },
    },
    [member],
  );
  try {
    const rot = (await (await fetch(`${base}/api/fleet/rotate`, { method: "POST" })).json()) as rest.FleetRotateResponse;
    expect(rot.ok).toBe(true);
    expect(rot.results).toEqual([{ host: "ok.ts.net", ok: true }]);

    const inv = (await (await fetch(`${base}/api/fleet/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "new.ts.net", code: "654321" }),
    })).json()) as rest.FleetInviteResponse;
    expect(inv.ok).toBe(true);
    expect(inv.member?.serverId).toBe("srv_new");
    expect(inv.member?.url).toBe("https://new.ts.net:7701/");
  } finally {
    cleanup();
  }
});

test("[BE2-15] an unknown job id answers 404, not a hang", async () => {
  const { base, cleanup } = boot();
  try {
    const res = await fetch(`${base}/api/fleet/jobs/job_nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as rest.FleetJobStatusResponse;
    expect(body.ok).toBe(false);
  } finally {
    cleanup();
  }
});
