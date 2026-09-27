/**
 * The concierge's fleet-aware routing (anvil-fleet-concierge): ONE "Claude" chat fronts every repo
 * in the fleet. Tests `conciergeRouter` — the logic behind list_environments / repo_* /
 * create_session — directly rather than through the MCP transport: another suite `mock.module`s the
 * whole agent SDK (bun mocks leak across files in one process), so the SDK layer is deliberately
 * not in the loop here. Asserts:
 *   • list_environments aggregates local + member environments, tolerating an unreachable member;
 *   • repo ops route to the environment's owner — deps.localRepo for local envs, fleet.memberRepo
 *     (with the right serverId) for member envs, an error for envs nobody has;
 *   • a handoff to a member-hosted environment goes to that member and names the machine.
 */
import { test, expect } from "bun:test";
import { conciergeRouter, type ConciergeFleetOps, type DefaultToolDeps } from "../../src/agent/default-tools";
import type { Environment } from "@protocol";

const LOCAL_ENV: Environment = { id: "env_local", name: "hub-proj", repoRoot: "/hub/proj", isRepo: true };
const MEMBER_ENV: Environment = { id: "env_m1", name: "lapo", repoRoot: "/m1/lapo", isRepo: true };

interface Calls {
  localRepo: unknown[];
  memberRepo: { serverId: string; req: unknown }[];
  memberHandoff: { serverId: string; args: unknown }[];
}

function makeDeps(opts: { memberDown?: boolean } = {}): { deps: DefaultToolDeps; calls: Calls } {
  const calls: Calls = { localRepo: [], memberRepo: [], memberHandoff: [] };
  const fleet: ConciergeFleetOps = {
    self: () => ({ serverId: "srv_hub", serverName: "Hub" }),
    members: () => [{ serverId: "srv_m1", serverName: "M1" }],
    memberEnvironments: async () => (opts.memberDown ? { ok: false, error: "member is down" } : { ok: true, environments: [MEMBER_ENV] }),
    memberRepo: async (serverId, req) => {
      calls.memberRepo.push({ serverId, req });
      return { ok: true, text: "member file content" };
    },
    memberHandoff: async (serverId, args) => {
      calls.memberHandoff.push({ serverId, args });
      return { ok: true, id: "sess_on_m1", title: (args as { title: string }).title, cwd: "/m1/worktrees/x" };
    },
  };
  const deps: DefaultToolDeps = {
    listSessions: () => [],
    getSession: () => undefined,
    listEnvironments: () => [LOCAL_ENV],
    localRepo: async (req) => {
      calls.localRepo.push(req);
      return { ok: true, text: "local file content" };
    },
    fleet: () => fleet,
    handoff: () => ({ id: "sess_local", title: "t", cwd: "/hub/worktrees/x" }),
  };
  return { deps, calls };
}

test("listStanzas aggregates local + member repos, grouped by machine", async () => {
  const { deps } = makeDeps();
  const stanzas = (await conciergeRouter(deps).listStanzas()) as { machine: string; environments?: { id: string }[] }[];
  expect(stanzas.map((s) => s.machine)).toEqual(["Hub", "M1"]);
  expect(stanzas[0]!.environments!.map((e) => e.id)).toEqual(["env_local"]);
  expect(stanzas[1]!.environments!.map((e) => e.id)).toEqual(["env_m1"]);
});

test("listStanzas tolerates an unreachable member (error stanza, local list intact)", async () => {
  const { deps } = makeDeps({ memberDown: true });
  const stanzas = (await conciergeRouter(deps).listStanzas()) as { machine: string; error?: string; environments?: unknown[] }[];
  expect(stanzas[0]!.environments).toBeDefined();
  expect(stanzas[1]!.machine).toBe("M1");
  expect(stanzas[1]!.error).toContain("down");
});

test("repo ops route by owner: member env → memberRepo with its serverId (no prior listing needed)", async () => {
  const { deps, calls } = makeDeps();
  // Cold cache on purpose — ownerOf must refresh the fleet listings on a miss.
  const r = await conciergeRouter(deps).routedRepo("env_m1", { op: "read", path: "README.md" });
  expect(r).toMatchObject({ ok: true, text: "member file content" });
  expect(calls.memberRepo).toHaveLength(1);
  expect(calls.memberRepo[0]!.serverId).toBe("srv_m1");
  expect(calls.memberRepo[0]!.req).toMatchObject({ environmentId: "env_m1", op: "read", path: "README.md" });
  expect(calls.localRepo).toHaveLength(0);
});

test("repo ops route by owner: local env → deps.localRepo, member path untouched", async () => {
  const { deps, calls } = makeDeps();
  const r = await conciergeRouter(deps).routedRepo("env_local", { op: "read", path: "a.ts" });
  expect(r).toMatchObject({ ok: true, text: "local file content" });
  expect(calls.localRepo).toHaveLength(1);
  expect(calls.memberRepo).toHaveLength(0);
});

test("repo ops on an environment nobody has report a fleet-wide miss", async () => {
  const { deps } = makeDeps();
  const r = await conciergeRouter(deps).routedRepo("env_ghost", { op: "list" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("no such environment anywhere in the fleet");
});

test("a member env's handoff goes to that member and names the machine", async () => {
  const { deps, calls } = makeDeps();
  const r = await conciergeRouter(deps).routedHandoff({ environmentId: "env_m1", source: "fresh-worktree", title: "fix lapo bug", brief: "Fix the thing." });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.message).toContain("sess_on_m1");
    expect(r.message).toContain("on M1");
  }
  expect(calls.memberHandoff).toHaveLength(1);
  expect(calls.memberHandoff[0]!.serverId).toBe("srv_m1");
  expect(calls.memberHandoff[0]!.args).toMatchObject({ environmentId: "env_m1", source: "fresh-worktree", brief: "Fix the thing." });
});

test("a local env's handoff stays local (and no-env handoffs never leave the hub)", async () => {
  const { deps, calls } = makeDeps();
  const router = conciergeRouter(deps);
  const local = await router.routedHandoff({ environmentId: "env_local", source: "fresh-worktree", title: "hub work", brief: "Do it." });
  expect(local.ok).toBe(true);
  if (local.ok) expect(local.message).toContain("sess_local");
  const noEnv = await router.routedHandoff({ source: "existing-dir", cwd: "/tmp", title: "scratch", brief: "Do it." });
  expect(noEnv.ok).toBe(true);
  expect(calls.memberHandoff).toHaveLength(0);
});

test("a member handoff failure is reported, not thrown", async () => {
  const { deps } = makeDeps();
  deps.fleet()!.memberHandoff = async () => ({ ok: false, error: "member refused" });
  const r = await conciergeRouter(deps).routedHandoff({ environmentId: "env_m1", source: "fresh-worktree", title: "t", brief: "b" });
  expect(r).toMatchObject({ ok: false, error: "member refused" });
});

test("without a fleet layer (member/standalone daemon) everything degrades to local-only", async () => {
  const { deps, calls } = makeDeps();
  deps.fleet = () => undefined;
  const router = conciergeRouter(deps);
  const stanzas = (await router.listStanzas()) as { machine: string }[];
  expect(stanzas).toHaveLength(1);
  expect((await router.routedRepo("env_local", { op: "read", path: "a.ts" })).ok).toBe(true);
  expect((await router.routedRepo("env_m1", { op: "read", path: "a.ts" })).ok).toBe(false);
  expect(calls.memberRepo).toHaveLength(0);
});
