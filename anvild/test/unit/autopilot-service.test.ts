/**
 * [P7] AutopilotService — the autopilot domain extracted from Supervisor. Pins the injection contract
 * on the public surface: the plans/schedule/snapshot events, the Go (startPlan) / linkPlan lifecycle
 * against the service-owned WorkUnitStore, the offline guards (Todoist not connected), and the
 * needs-clarification hold. The run/pipeline internals are covered by autopilot/pipeline units and the
 * dispatch integration through the Supervisor delegation.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutopilotService, type AutopilotDeps } from "../../src/session/autopilot-service";
import { BadCommand } from "../../src/session/errors";
import { WorkUnitStore } from "../../src/integrations/workunit";
import { EnvironmentStore } from "../../src/env/store";
import { IntegrationStore } from "../../src/integrations/store";
import { IntegrationsFacade } from "../../src/session/integrations-facade";
import { AccountStore } from "../../src/auth/accounts";
import { PassthroughRenderer } from "../../src/render/markdown";
import type { ConnectionRegistry } from "../../src/server/registry";
import type { Session } from "../../src/session/session";

function gitRepo(dir: string): string {
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  run(["init", "-q"]);
  return dir;
}

function harness() {
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-autopilot-"));
  const repo = gitRepo(mkdtempSync(join(tmpdir(), "anvil-autopilot-repo-")));
  const envStore = new EnvironmentStore(stateDir);
  const env = envStore.add("proj", repo);
  // Seed a planned unit through a second store over the same stateDir — the service's own store
  // loads it from disk at construction (the store is owned by the service, per the extraction).
  const seed = new WorkUnitStore(stateDir);
  const unit = seed.create({ environmentId: env.id, todoistProjectId: "p1", taskIds: ["t1"], title: "do the thing" });
  const held = seed.create({ environmentId: env.id, todoistProjectId: "p1", taskIds: ["t2"], title: "unclear", status: "needs-clarification" });

  const events: string[] = [];
  const handoffs: Array<{ title: string; workUnitRole?: string }> = [];
  const integrations = new IntegrationStore(stateDir);
  const registry = { toAll: (ev: { type: string }) => events.push(ev.type) } as unknown as ConnectionRegistry;
  const sessions = new Set<string>();
  const deps: AutopilotDeps = {
    registry,
    stateDir,
    envStore,
    integrations,
    integrationsFacade: new IntegrationsFacade({
      integrations,
      registry,
      selfBaseUrl: async () => undefined,
      cachedSelfBaseUrl: () => undefined,
    }),
    accounts: new AccountStore(stateDir),
    renderer: new PassthroughRenderer(),
    adversarial: { models: [] },
    worktreeRoot: () => join(stateDir, "worktrees"),
    selfBaseUrl: async () => undefined,
    getSession: () => undefined,
    hasSession: (id) => sessions.has(id),
    require: (id) => {
      throw new BadCommand(`no such session: ${id}`);
    },
    budget: () => ({ available: false, warn: false }),
    handoffCreate: (a) => {
      handoffs.push({ title: a.title, ...(a.workUnitRole ? { workUnitRole: a.workUnitRole } : {}) });
      const id = `sess_${handoffs.length}`;
      sessions.add(id);
      return { id, title: a.title, cwd: "/tmp" };
    },
    authDegraded: () => false,
    claimDegradeEpisodeAlert: () => false,
    pushSystemAlert: () => {},
    notifyAll: () => {},
  };
  const svc = new AutopilotService(deps);
  const cleanup = () => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  };
  return { svc, unit, held, env, events, handoffs, sessions, cleanup };
}

test("[P7] autopilotPlansEvent lists the seeded planned units with their env name", () => {
  const h = harness();
  try {
    const ev = h.svc.autopilotPlansEvent("c1");
    expect(ev.type).toBe("autopilot.plans");
    expect(ev.cid).toBe("c1");
    const titles = ev.plans.map((p) => p.title);
    expect(titles).toContain("do the thing");
    expect(titles).toContain("unclear"); // held units still show as reviewable cards
    expect(ev.plans[0]?.environmentName).toBe("proj");
  } finally {
    h.cleanup();
  }
});

test("[P7] startPlan (Go) hands off a build session and flips the unit to building", async () => {
  const h = harness();
  try {
    const ev = await h.svc.startPlan(h.unit.id, undefined, undefined, "c2");
    expect(ev.type).toBe("autopilot.started");
    expect(ev.workUnitId).toBe(h.unit.id);
    expect(h.handoffs).toHaveLength(1);
    expect(h.handoffs[0]!.title).toBe("do the thing");
    expect(h.events).toContain("autopilot.plans"); // the grid refreshes everywhere
    // the card leaves the pending grid: building units are no longer "pending plans"
    expect(h.svc.autopilotPlansEvent().plans.map((p) => p.id)).not.toContain(h.unit.id);
    // a second Go on the now-live unit refuses ([BE2-2] startPlan is async → rejects)
    await expect(h.svc.startPlan(h.unit.id)).rejects.toThrow(BadCommand);
  } finally {
    h.cleanup();
  }
});

test("[P7] startPlan refuses a needs-clarification unit and an unknown unit", async () => {
  const h = harness();
  try {
    await expect(h.svc.startPlan(h.held.id)).rejects.toThrow(/needs clarification/);
    await expect(h.svc.startPlan("wu_nope")).rejects.toThrow(BadCommand);
  } finally {
    h.cleanup();
  }
});

test("[P7] startPlanningSession opens a planner-role session on a held unit", async () => {
  const h = harness();
  try {
    const ev = await h.svc.startPlanningSession(h.held.id);
    expect(ev.type).toBe("autopilot.started");
    expect(h.handoffs[0]!.workUnitRole).toBe("planner");
  } finally {
    h.cleanup();
  }
});

test("[P7] offline guards: runAutopilot needs Todoist; reconcile is a 0-unit no-op without it", async () => {
  const h = harness();
  try {
    await expect(h.svc.runAutopilot({})).rejects.toThrow(/Todoist is not connected/);
    expect(await h.svc.reconcileCompletedUnits()).toBe(0);
  } finally {
    h.cleanup();
  }
});

test("[P7] schedule events: snapshot idle, setAutopilotSchedule patches + broadcasts", () => {
  const h = harness();
  try {
    const snap = h.svc.autopilotRunSnapshotEvent();
    expect(snap.running).toBe(false);
    expect(snap.log).toEqual([]);
    const ev = h.svc.setAutopilotSchedule({ autoStart: true }, "c3");
    expect(ev.type).toBe("autopilot.schedule");
    expect(ev.cid).toBe("c3");
    expect(ev.schedule.autoStart).toBe(true);
    expect(ev.running).toBe(false);
    expect(h.events).toContain("autopilot.schedule"); // the no-cid broadcast to every device
  } finally {
    h.cleanup();
  }
});
