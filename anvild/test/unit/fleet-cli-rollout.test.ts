import { describe, expect, test } from "bun:test";
import { FleetCliRolloutCoordinator, type CliRolloutTarget, type MemberCliClient } from "../../src/server/fleet-cli-rollout";

const self = { serverId: "hub", serverName: "Hub" };
const member = (id: string): CliRolloutTarget => ({ serverId: id, serverName: id.toUpperCase(), url: `https://${id}/` });

/** In-memory member transport: reachability + support + per-host install outcome are scripted by id. */
function fakeClient(
  plan: Record<string, { reachable?: boolean; supported?: boolean; ok?: boolean; version?: string; error?: string }>,
): MemberCliClient & { installed: string[] } {
  const installed: string[] = [];
  return {
    installed,
    async probe(base) {
      const p = plan[base] ?? {};
      return { reachable: p.reachable ?? true, supported: p.supported ?? true };
    },
    async install(base, version) {
      installed.push(base);
      const p = plan[base] ?? {};
      return { ok: p.ok ?? true, version: p.version ?? version, error: p.error };
    },
  };
}

describe("FleetCliRolloutCoordinator", () => {
  test("installs the resolved latest on every reachable member, hub last", async () => {
    const client = fakeClient({});
    const selfInstalls: string[] = [];
    const coord = new FleetCliRolloutCoordinator({
      self,
      members: () => [member("m1"), member("m2")],
      resolveLatest: async () => "2.1.322",
      installSelf: async (v) => {
        // Hub must be installed only after both members have settled.
        expect(client.installed.sort()).toEqual(["https://m1/", "https://m2/"]);
        selfInstalls.push(v);
        return { ok: true, version: v };
      },
      client,
      now: () => 0,
    });

    const start = await coord.start({});
    expect(start.ok).toBe(true);
    expect(start.version).toBe("2.1.322");
    await coord.settled();

    expect(selfInstalls).toEqual(["2.1.322"]);
    const st = coord.status();
    expect(st.active).toBe(false);
    expect(st.members.every((m) => m.state === "healthy")).toBe(true);
    // Hub sorts last.
    expect(st.members.at(-1)?.isHub).toBe(true);
  });

  test("pins an explicit version without resolving latest", async () => {
    let resolved = false;
    const coord = new FleetCliRolloutCoordinator({
      self,
      members: () => [member("m1")],
      resolveLatest: async () => {
        resolved = true;
        return "9.9.9";
      },
      installSelf: async (v) => ({ ok: true, version: v }),
      client: fakeClient({}),
      now: () => 0,
    });
    const start = await coord.start({ version: "2.1.290" });
    await coord.settled();
    expect(resolved).toBe(false);
    expect(start.version).toBe("2.1.290");
    expect(coord.status().members.find((m) => m.serverId === "m1")?.version).toBe("2.1.290");
  });

  test("marks unreachable + unsupported + failed members distinctly, and never wedges active:true", async () => {
    const client = fakeClient({
      "https://off/": { reachable: false },
      "https://old/": { supported: false },
      "https://bad/": { ok: false, error: "disk full" },
    });
    const coord = new FleetCliRolloutCoordinator({
      self,
      members: () => [member("off"), member("old"), member("bad"), member("ok")],
      resolveLatest: async () => "2.1.322",
      installSelf: async (v) => ({ ok: true, version: v }),
      client,
      now: () => 0,
    });
    await coord.start({});
    await coord.settled();
    const by = Object.fromEntries(coord.status().members.map((m) => [m.serverId, m.state]));
    expect(by.off).toBe("pending-offline");
    expect(by.old).toBe("error"); // too old to manage the CLI
    expect(by.bad).toBe("error");
    expect(by.ok).toBe("healthy");
    expect(coord.status().active).toBe(false); // lock always released
  });

  test("rejects a second rollout while one is in progress", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const coord = new FleetCliRolloutCoordinator({
      self,
      members: () => [],
      resolveLatest: async () => "2.1.322",
      installSelf: async (v) => {
        await gate; // hold the hub install open so the rollout stays active
        return { ok: true, version: v };
      },
      client: fakeClient({}),
      now: () => 0,
    });
    const first = await coord.start({});
    expect(first.ok).toBe(true);
    const second = await coord.start({});
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already in progress/);
    release();
    await coord.settled();
  });

  test("surfaces a resolveLatest failure as a non-ok start", async () => {
    const coord = new FleetCliRolloutCoordinator({
      self,
      members: () => [],
      resolveLatest: async () => {
        throw new Error("registry down");
      },
      installSelf: async (v) => ({ ok: true, version: v }),
      client: fakeClient({}),
      now: () => 0,
    });
    const start = await coord.start({});
    expect(start.ok).toBe(false);
    expect(start.error).toMatch(/registry down/);
  });
});
