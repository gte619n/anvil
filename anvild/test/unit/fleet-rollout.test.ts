/**
 * [stable-update-service Phase 5] The hub-side fleet rollout coordinator. All network/service-manager
 * effects are injected (fake MemberUpdateClient, fake clock/sleep, fake applySelf), so orchestration is
 * asserted deterministically. Pins: hub-updates-itself-LAST (D6), unreachable→pending-offline (D18),
 * a member that rolls back is reported as such (D4), legacy members take the old path (§4.3), an
 * explicit target is pinned (D13), and desired-state reconcile-on-reconnect (D19).
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FleetRolloutCoordinator,
  DesiredTargetStore,
  type MemberUpdateClient,
  type RolloutTarget,
  type ProbeInfo,
} from "../../src/server/fleet-rollout";
import type { rest } from "@protocol";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "anvil-rollout-"));
}

/** A scripted in-memory member. `statusScript` is consumed one phase per status() poll. */
interface FakeMember {
  probe: ProbeInfo;
  applyOk?: boolean;
  statusScript?: rest.update.UpdatePhase[];
}

function makeClient(members: Record<string, FakeMember>, order: string[]): MemberUpdateClient {
  const scripts = new Map<string, rest.update.UpdatePhase[]>();
  for (const [url, m] of Object.entries(members)) scripts.set(url, [...(m.statusScript ?? ["healthy"])]);
  return {
    async probe(base) {
      return members[base]?.probe ?? { reachable: false };
    },
    async apply(base) {
      order.push(`apply:${base}`);
      return { ok: members[base]?.applyOk ?? true };
    },
    async status(base) {
      const q = scripts.get(base)!;
      const phase = q.length > 1 ? q.shift()! : q[0]!;
      const target = members[base]!.probe.currentSha; // irrelevant; coordinator matches on toSha
      return {
        ok: true,
        updateApiVersion: 1,
        phase,
        currentSha: phase === "healthy" ? "target1" : (target ?? ""),
        currentVersion: "x",
        targetSha: "target1",
        prePullSha: "prev",
        webBundleOk: phase === "healthy",
        ...(phase === "rolled-back" ? { reason: "smoke failed — reverted" } : {}),
      };
    },
    async legacyUpdate(base) {
      order.push(`legacy:${base}`);
      return { ok: true };
    },
  };
}

function coordinator(opts: {
  members: Record<string, FakeMember>;
  targets: RolloutTarget[];
  order: string[];
  desiredDir?: string;
  applySelf?: (t: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  let clock = 0;
  return new FleetRolloutCoordinator({
    self: { serverId: "hub", serverName: "hub" },
    members: () => opts.targets,
    resolveTargetSha: async () => "target1",
    applySelf:
      opts.applySelf ??
      (async () => {
        opts.order.push("hub");
        return { ok: true };
      }),
    client: makeClient(opts.members, opts.order),
    desired: new DesiredTargetStore(opts.desiredDir ?? tmp()),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    memberTimeoutMs: 180_000,
    pollIntervalMs: 3_000,
  });
}

test("updates every reachable member and then the hub LAST", async () => {
  const order: string[] = [];
  const c = coordinator({
    order,
    targets: [
      { serverId: "m1", serverName: "m1", url: "u1" },
      { serverId: "m2", serverName: "m2", url: "u2" },
    ],
    members: {
      u1: { probe: { reachable: true, updateApiVersion: 1, currentSha: "old1" }, statusScript: ["restarting", "healthy"] },
      u2: { probe: { reachable: true, updateApiVersion: 1, currentSha: "old2" }, statusScript: ["healthy"] },
    },
  });
  const snap = await c.start({});
  expect(snap.ok).toBe(true);
  expect(snap.targetSha).toBe("target1");
  await c.settled(); // await the body deterministically
  // Hub is the final action.
  expect(order[order.length - 1]).toBe("hub");
  // Both members were applied before the hub.
  expect(order.filter((o) => o.startsWith("apply:")).length).toBe(2);
  const st = c.status();
  expect(st.members.find((m) => m.serverId === "m1")?.state).toBe("healthy");
  expect(st.members.find((m) => m.serverId === "m2")?.state).toBe("healthy");
  expect(st.members.find((m) => m.serverId === "hub")?.isHub).toBe(true);
});

test("an unreachable member is skipped and marked pending-offline; the rollout still finishes", async () => {
  const order: string[] = [];
  const c = coordinator({
    order,
    targets: [
      { serverId: "up", serverName: "up", url: "uUp" },
      { serverId: "down", serverName: "down", url: "uDown" },
    ],
    members: {
      uUp: { probe: { reachable: true, updateApiVersion: 1, currentSha: "old" }, statusScript: ["healthy"] },
      uDown: { probe: { reachable: false } },
    },
  });
  await c.start({});
  await c.settled();
  const st = c.status();
  expect(st.members.find((m) => m.serverId === "down")?.state).toBe("pending-offline");
  expect(st.members.find((m) => m.serverId === "up")?.state).toBe("healthy");
  expect(order[order.length - 1]).toBe("hub"); // never blocked by the offline member
});

test("a member that fails its gate is reported rolled-back (self-heal observed, D4/D10)", async () => {
  const order: string[] = [];
  const c = coordinator({
    order,
    targets: [{ serverId: "bad", serverName: "bad", url: "uBad" }],
    members: {
      uBad: { probe: { reachable: true, updateApiVersion: 1, currentSha: "old" }, statusScript: ["restarting", "rolled-back"] },
    },
  });
  await c.start({});
  await c.settled();
  const m = c.status().members.find((x) => x.serverId === "bad")!;
  expect(m.state).toBe("rolled-back");
  expect(m.detail).toMatch(/reverted/);
});

test("a legacy member (no updateApiVersion) is driven via the old path", async () => {
  const order: string[] = [];
  const c = coordinator({
    order,
    targets: [{ serverId: "leg", serverName: "leg", url: "uLeg" }],
    members: { uLeg: { probe: { reachable: true, currentSha: "old" } } }, // no updateApiVersion
  });
  await c.start({});
  await c.settled();
  expect(order).toContain("legacy:uLeg");
  expect(c.status().members.find((m) => m.serverId === "leg")?.state).toBe("legacy");
});

test("an explicit target SHA is pinned and persisted as desired state", async () => {
  const dir = tmp();
  const order: string[] = [];
  const c = coordinator({
    order,
    desiredDir: dir,
    targets: [{ serverId: "m", serverName: "m", url: "u" }],
    members: { u: { probe: { reachable: true, updateApiVersion: 1, currentSha: "old" }, statusScript: ["healthy"] } },
  });
  const snap = await c.start({ targetSha: "pinnedXYZ" });
  expect(snap.targetSha).toBe("pinnedXYZ");
  expect(new DesiredTargetStore(dir).get()).toBe("pinnedXYZ");
});

test("a member already at the target is left healthy without re-applying", async () => {
  const order: string[] = [];
  const c = coordinator({
    order,
    targets: [{ serverId: "cur", serverName: "cur", url: "u" }],
    members: { u: { probe: { reachable: true, updateApiVersion: 1, currentSha: "target1" } } },
  });
  await c.start({});
  await c.settled();
  expect(order.some((o) => o.startsWith("apply:"))).toBe(false);
  expect(c.status().members.find((m) => m.serverId === "cur")?.state).toBe("healthy");
});

test("reconcile nudges a behind member to the pinned target, and no-ops when already converged", async () => {
  const dir = tmp();
  const desired = new DesiredTargetStore(dir);
  desired.set("target1");
  const order: string[] = [];
  const c = coordinator({
    order,
    desiredDir: dir,
    targets: [],
    members: {
      behind: { probe: { reachable: true, updateApiVersion: 1, currentSha: "old" } },
      atTarget: { probe: { reachable: true, updateApiVersion: 1, currentSha: "target1" } },
      offline: { probe: { reachable: false } },
    },
  });
  await c.reconcile({ serverId: "b", serverName: "b", url: "behind" });
  await c.reconcile({ serverId: "a", serverName: "a", url: "atTarget" });
  await c.reconcile({ serverId: "o", serverName: "o", url: "offline" });
  expect(order).toContain("apply:behind");
  expect(order).not.toContain("apply:atTarget");
  expect(order).not.toContain("apply:offline");
});

test("[BE2-11] a throw during the rollout body still releases the active lock (no permanent wedge)", async () => {
  const order: string[] = [];
  const targets: RolloutTarget[] = [{ serverId: "m1", serverName: "m1", url: "m1" }];
  let calls = 0;
  const coord = new FleetRolloutCoordinator({
    self: { serverId: "hub", serverName: "hub" },
    // Succeeds for start()'s enumeration, throws on run()'s second call — the "throw after active:true"
    // case that used to strand `active` forever (start-time throws are handled before state is set).
    members: () => {
      calls++;
      if (calls === 2) throw new Error("members enumeration blew up");
      return targets;
    },
    resolveTargetSha: async () => "target1",
    applySelf: async () => ({ ok: true }),
    client: makeClient({ m1: { probe: { reachable: true, updateApiVersion: 1, currentSha: "old" } } }, order),
    desired: new DesiredTargetStore(tmp()),
    now: () => 0,
    sleep: async () => {},
  });
  const r1 = await coord.start({} as rest.FleetUpdateRequest);
  expect(r1.ok).toBe(true);
  await coord.settled();
  expect(coord.status().active).toBe(false); // lock released despite the thrown run() body
  const r2 = await coord.start({} as rest.FleetUpdateRequest); // NOT rejected "already in progress"
  expect(r2.ok).toBe(true);
});
