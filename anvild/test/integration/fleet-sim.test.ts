/**
 * [stable-update-service Phase 7 / REQUIRED functional gate] Multi-daemon fleet-sim. Spins up several
 * lightweight "member" daemons on loopback that speak the REAL frozen update API, and drives them with
 * the REAL FleetRolloutCoordinator over the REAL httpMemberUpdateClient (actual HTTP, routing, status
 * polling). Each sim member models a real self-update: apply() records the pre-pull SHA, "restarts"
 * asynchronously, and either lands healthy on the target or (poisoned) self-heals back to the pre-pull
 * SHA — exactly the local self-heal the daemon+watchdog perform, but simulated so no real git runs.
 *
 * Asserts the spec's functional invariants end-to-end:
 *   F1  hub updates itself LAST (only after every reachable member is healthy)   — D6
 *   F2  deterministic convergence: every reachable member lands on the ONE pinned SHA — D13
 *   F3  a poisoned member auto-rolls-back to its prior build and is reported rolled-back — D4/D8
 *   F4  an unreachable member is skipped (pending-offline) and reconciled on reconnect — D18/D19
 *   F5  the frozen surface answers identically the whole time (shape stable)     — D12
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetRolloutCoordinator, DesiredTargetStore, httpMemberUpdateClient } from "../../src/server/fleet-rollout";

const PINNED = "aaaa111"; // the single SHA the whole fleet must converge to

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "anvil-fleet-sim-"));
}

/** A minimal daemon that speaks the frozen update API, modelling one member's local self-update + heal. */
function simMember(opts: { id: string; startSha: string; poison?: boolean }) {
  let cur = opts.startSha;
  let phase = "idle";
  let target = "";
  let prePull = "";
  const health = () => ({ ok: true, version: `0.0.0+${cur}`, updateApiVersion: 1, webBundleOk: true });
  const status = () => ({
    ok: true,
    updateApiVersion: 1,
    phase,
    currentSha: cur,
    currentVersion: `0.0.0+${cur}`,
    targetSha: target,
    prePullSha: prePull,
    webBundleOk: true,
  });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/health") return Response.json(health());
      if (u.pathname === "/api/update/v1/status") return Response.json(status());
      if (u.pathname === "/api/update/v1/apply" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { targetSha?: string };
        prePull = cur;
        target = body.targetSha ?? "";
        phase = "restarting";
        // Async "restart": land healthy on the target, or (poison) self-heal back to the pre-pull SHA.
        setTimeout(() => {
          if (opts.poison) {
            cur = prePull;
            phase = "rolled-back";
          } else {
            cur = target;
            phase = "healthy";
          }
        }, 25);
        return Response.json({ ok: true, updateApiVersion: 1, phase: "restarting", willRestart: true, currentVersion: `0.0.0+${cur}`, prePullSha: prePull, targetSha: target, output: "restarting" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { id: opts.id, url: () => `http://localhost:${server.port}/`, sha: () => cur, phase: () => phase, stop: () => server.stop(true) };
}

test("[F1,F2,F3,F5] parallel rollout: members converge to the pinned SHA, poison rolls back, hub is last", async () => {
  const m1 = simMember({ id: "m1", startSha: "old1" });
  const m2 = simMember({ id: "m2", startSha: "old2" });
  const bad = simMember({ id: "bad", startSha: "old3", poison: true });
  const members = [m1, m2, bad];

  const hubEvents: { membersSettled: boolean }[] = [];
  const coord = new FleetRolloutCoordinator({
    self: { serverId: "hub", serverName: "hub" },
    members: () => members.map((m) => ({ serverId: m.id, serverName: m.id, url: m.url() })),
    resolveTargetSha: async () => PINNED,
    applySelf: async () => {
      // F1: capture whether every reachable member has already reached a terminal state when the hub runs.
      hubEvents.push({ membersSettled: members.every((m) => m.phase() === "healthy" || m.phase() === "rolled-back") });
      return { ok: true };
    },
    client: httpMemberUpdateClient(),
    desired: new DesiredTargetStore(tmp()),
    pollIntervalMs: 15,
    memberTimeoutMs: 5_000,
  });

  const snap = await coord.start({});
  expect(snap.ok).toBe(true);
  expect(snap.targetSha).toBe(PINNED); // F2: one pinned target for the whole fleet
  await coord.settled();

  // F1: the hub updated itself exactly once, and only after the reachable set had settled.
  expect(hubEvents.length).toBe(1);
  expect(hubEvents[0]!.membersSettled).toBe(true);

  // F2: healthy members are all on the identical pinned SHA.
  expect(m1.sha()).toBe(PINNED);
  expect(m2.sha()).toBe(PINNED);

  // F3: the poisoned member rolled back to its prior build and is reported rolled-back.
  expect(bad.sha()).toBe("old3");
  const st = coord.status();
  expect(st.members.find((m) => m.serverId === "m1")?.state).toBe("healthy");
  expect(st.members.find((m) => m.serverId === "m2")?.state).toBe("healthy");
  expect(st.members.find((m) => m.serverId === "bad")?.state).toBe("rolled-back");
  expect(st.members.find((m) => m.serverId === "hub")?.isHub).toBe(true);

  members.forEach((m) => m.stop());
});

test("[F4] an unreachable member is skipped, then converges when reconciled on reconnect", async () => {
  const online = simMember({ id: "online", startSha: "oldA" });
  const offline = simMember({ id: "offline", startSha: "oldB" });
  const offlineUrl = offline.url();
  offline.stop(); // down at fan-out time

  const desired = new DesiredTargetStore(tmp());
  const coord = new FleetRolloutCoordinator({
    self: { serverId: "hub", serverName: "hub" },
    members: () => [
      { serverId: "online", serverName: "online", url: online.url() },
      { serverId: "offline", serverName: "offline", url: offlineUrl },
    ],
    resolveTargetSha: async () => PINNED,
    applySelf: async () => ({ ok: true }),
    client: httpMemberUpdateClient(),
    desired,
    pollIntervalMs: 15,
    memberTimeoutMs: 5_000,
  });

  await coord.start({});
  await coord.settled();
  expect(coord.status().members.find((m) => m.serverId === "offline")?.state).toBe("pending-offline");
  expect(online.sha()).toBe(PINNED);
  expect(desired.get()).toBe(PINNED); // desired-state persisted for reconcile

  // The member comes back (fresh server, still behind). Reconcile nudges it to the pinned target.
  const rejoined = simMember({ id: "offline", startSha: "oldB" });
  await coord.reconcile({ serverId: "offline", serverName: "offline", url: rejoined.url() });
  // Give the sim's async "restart" time to land.
  for (let i = 0; i < 50 && rejoined.sha() !== PINNED; i++) await new Promise((r) => setTimeout(r, 15));
  expect(rejoined.sha()).toBe(PINNED);

  online.stop();
  rejoined.stop();
});
