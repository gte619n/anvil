/**
 * [P3] Combined reconcile+verify pass (spec Phase 3) — the lifecycle harness: real WorkUnitStore + real
 * EnvironmentStore over a committed fixture repo, a FAKE Todoist, an injected queryFn (canned verdicts),
 * and an injected clock. Drives the §4.3 table end to end:
 *   done+closed-seen → completed + idempotent evidence comment
 *   done+open        → "Likely complete" overlay (no status change)
 *   not-done+closed  → held as a mismatch (never completed, never reopened)
 *   Acknowledge      → completes immediately, NO comment
 *   Keep-as-work     → keptAsWork, stays planned, skipped by the next sweep
 *   staleness        → unchanged baseSha ⇒ not re-verified; bumped baseSha ⇒ re-verified
 *   deleted task     → overlay cleared + unit expired
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutopilotService, type AutopilotDeps, type VerifyTodoist } from "../../src/session/autopilot-service";
import { BadCommand } from "../../src/session/errors";
import { WorkUnitStore } from "../../src/integrations/workunit";
import { EnvironmentStore } from "../../src/env/store";
import { IntegrationStore } from "../../src/integrations/store";
import { IntegrationsFacade } from "../../src/session/integrations-facade";
import { AccountStore } from "../../src/auth/accounts";
import { PassthroughRenderer } from "../../src/render/markdown";
import type { ConnectionRegistry } from "../../src/server/registry";
import type { QueryLike } from "../../src/agent/query";
import type { TodoistTask, TodoistComment } from "../../src/integrations/todoist";
import type { WorkUnitVerification } from "../../src/integrations/workunit";
import { OPENROUTER_KEY } from "../../src/auth/openrouter";
import { generateFixture } from "../fixtures/verify/generate";

function git(args: string[], cwd: string): void {
  Bun.spawnSync(["git", ...args], { cwd });
}

/** A fake Todoist capturing what the verifier does to it. */
class FakeTodoist implements VerifyTodoist {
  completedIds = new Set<string>();
  closed = new Set<string>();
  labels = new Map<string, string[]>();
  comments_ = new Map<string, TodoistComment[]>();
  deleted = new Set<string>();
  tasks = new Map<string, TodoistTask>();
  seed(id: string, content = `task ${id}`) {
    this.tasks.set(id, { id, project_id: "p1", content });
  }
  async completedTasks({ projectId }: { projectId?: string; windowDays: number }): Promise<TodoistTask[]> {
    return [...this.completedIds].map((id) => ({ id, project_id: projectId ?? "p1", content: "" }));
  }
  async getTask(id: string): Promise<TodoistTask> {
    if (this.deleted.has(id)) throw new Error(`GET /tasks/${id} → 404`);
    const t = this.tasks.get(id);
    if (!t) throw new Error(`GET /tasks/${id} → 404`);
    return t;
  }
  async setTaskLabels(id: string, labels: string[]): Promise<TodoistTask> {
    this.labels.set(id, labels);
    return this.tasks.get(id) ?? { id, project_id: "p1", content: "" };
  }
  async closeTask(id: string): Promise<void> {
    this.closed.add(id);
  }
  async comments(id: string): Promise<TodoistComment[]> {
    return this.comments_.get(id) ?? [];
  }
  async addComment(id: string, content: string): Promise<TodoistComment> {
    const arr = this.comments_.get(id) ?? [];
    arr.push({ id: `c${arr.length}`, content });
    this.comments_.set(id, arr);
    return { id: "c", content };
  }
}

/** A queryFn that reads the task ids out of the verifier prompt and returns per-task verdicts. Counts calls. */
function verdictQuery(verdictByTask: Record<string, "done" | "not-done">, counter?: { n: number }): QueryLike {
  return (args) =>
    (async function* () {
      if (counter) counter.n++;
      const prompt = String((args as { prompt: string }).prompt);
      const ids = [...prompt.matchAll(/id=([^\s:]+)/g)].map((m) => m[1]!);
      const tasks = ids.map((id) => {
        const v = verdictByTask[id] ?? "not-done";
        return { taskId: id, verdict: v, ...(v === "done" ? { cite: `src/${id}.ts:1` } : {}) };
      });
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: JSON.stringify({ tasks }) } }] } };
      yield { type: "result", result: "ok" };
    })();
}

function harness() {
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-verify-recon-"));
  const fx = generateFixture("done"); // committed repo + origin (content irrelevant — queryFn is injected)
  const envStore = new EnvironmentStore(stateDir);
  const env = envStore.add("proj", fx.repo);
  envStore.update(env.id, { todoistProjectId: "p1" });

  const seed = new WorkUnitStore(stateDir);
  const events: string[] = [];
  const integrations = new IntegrationStore(stateDir);
  const registry = { toAll: (ev: { type: string }) => events.push(ev.type) } as unknown as ConnectionRegistry;
  const sessions = new Set<string>();
  const fakeSessions = new Map<string, { data: { environmentId: string } }>();
  const deps: AutopilotDeps = {
    registry,
    stateDir,
    envStore,
    integrations,
    integrationsFacade: new IntegrationsFacade({ integrations, registry, selfBaseUrl: async () => undefined, cachedSelfBaseUrl: () => undefined }),
    accounts: new AccountStore(stateDir),
    renderer: new PassthroughRenderer(),
    adversarial: { models: [] },
    worktreeRoot: () => join(stateDir, "worktrees"),
    selfBaseUrl: async () => undefined,
    getSession: (id) => fakeSessions.get(id) as never,
    hasSession: (id) => sessions.has(id),
    require: (id) => {
      throw new BadCommand(`no such session: ${id}`);
    },
    budget: () => ({ available: false, warn: false }),
    handoffCreate: (a) => ({ id: "sess_x", title: a.title, cwd: "/tmp" }),
    authDegraded: () => false,
    claimDegradeEpisodeAlert: () => false,
    pushSystemAlert: () => {},
    notifyAll: () => {},
    broadcastLoops: () => {},
    armGoal: () => {},
  };
  const svc = new AutopilotService(deps);
  const mkUnit = (taskIds: string[], over: Record<string, unknown> = {}) =>
    seed.create({ environmentId: env.id, todoistProjectId: "p1", taskIds, title: `unit ${taskIds.join(",")}`, ...over }).id;
  // Reload the service's own store after seeding (it reads from disk at construction).
  const svc2 = new AutopilotService(deps);
  const bumpOrigin = () => {
    const other = mkdtempSync(join(tmpdir(), "anvil-bump-"));
    git(["clone", "-q", fx.origin, other], tmpdir());
    git(["config", "user.email", "t@e.com"], other);
    git(["config", "user.name", "T"], other);
    writeFileSync(join(other, `bump-${Date.now()}.txt`), "x");
    git(["add", "."], other);
    git(["commit", "-q", "-m", "bump"], other);
    git(["push", "-q", "origin", "main"], other);
    rmSync(other, { recursive: true, force: true });
  };
  const cleanup = () => {
    rmSync(stateDir, { recursive: true, force: true });
    fx.cleanup();
  };
  return { stateDir, env, envStore, deps, mkUnit, bumpOrigin, cleanup, events, fakeSessions };
}

/** Build the service fresh over the seeded stateDir (its store loads from disk at construction). */
function service(deps: AutopilotDeps): AutopilotService {
  return new AutopilotService(deps);
}
function unitOf(deps: AutopilotDeps, id: string) {
  return new WorkUnitStore(deps.stateDir).get(id);
}

test("[P3] done + closed-seen → completed with an idempotent evidence comment", async () => {
  const h = harness();
  try {
    const id = h.mkUnit(["t1"]);
    const todoist = new FakeTodoist();
    todoist.seed("t1");
    todoist.completedIds.add("t1"); // the human checked it off
    const svc = service(h.deps);
    const m = await svc.reconcileAndVerify({ todoist, queryFn: verdictQuery({ t1: "done" }), now: () => 1_000 });
    expect(m.done).toBe(1);
    const u = unitOf(h.deps, id);
    expect(u?.status).toBe("completed");
    expect(todoist.closed.has("t1")).toBe(true);
    expect((todoist.comments_.get("t1") ?? []).length).toBe(1);
    expect(todoist.comments_.get("t1")![0]!.content).toContain("<!-- anvil:verify -->");

    // Idempotent: a second sweep (unit is terminal now, but even forcing a comment) never double-posts.
    await svc.reconcileAndVerify({ todoist, queryFn: verdictQuery({ t1: "done" }), now: () => 2_000 });
    expect((todoist.comments_.get("t1") ?? []).length).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("[P3] done + open → Likely-complete overlay, no status change", async () => {
  const h = harness();
  try {
    const id = h.mkUnit(["t1"]);
    const todoist = new FakeTodoist();
    todoist.seed("t1");
    const svc = service(h.deps);
    const m = await svc.reconcileAndVerify({ todoist, queryFn: verdictQuery({ t1: "done" }), now: () => 1_000 });
    expect(m.done).toBe(1);
    const u = unitOf(h.deps, id);
    expect(u?.status).toBe("planned"); // unchanged
    expect(u?.verification?.verdict).toBe("done");
    expect(u?.verification?.mismatch).toBeUndefined();
    expect(todoist.closed.size).toBe(0);
  } finally {
    h.cleanup();
  }
});

test("[P3] not-done + closed-seen → held as a mismatch (not completed), then Acknowledge completes now, no comment", async () => {
  const h = harness();
  try {
    const id = h.mkUnit(["t1"]);
    const todoist = new FakeTodoist();
    todoist.seed("t1");
    todoist.completedIds.add("t1");
    const svc = service(h.deps);
    const m = await svc.reconcileAndVerify({ todoist, queryFn: verdictQuery({ t1: "not-done" }), now: () => 1_000 });
    expect(m.mismatches).toBe(1);
    let u = unitOf(h.deps, id);
    expect(u?.status).toBe("planned"); // NOT completed — held
    expect(u?.verification?.mismatch).toBe(true);
    expect(todoist.closed.size).toBe(0);

    // Acknowledge = trust the checkbox → complete immediately, no close call (already closed), no comment.
    await svc.ackMismatch(id);
    u = unitOf(h.deps, id);
    expect(u?.status).toBe("completed");
    expect((todoist.comments_.get("t1") ?? []).length).toBe(0);
  } finally {
    h.cleanup();
  }
});

test("[P3] Keep-as-work on a mismatch → keptAsWork, stays planned, and a later sweep SKIPS it", async () => {
  const h = harness();
  try {
    const id = h.mkUnit(["t1"]);
    const todoist = new FakeTodoist();
    todoist.seed("t1");
    todoist.completedIds.add("t1");
    const svc = service(h.deps);
    await svc.reconcileAndVerify({ todoist, queryFn: verdictQuery({ t1: "not-done" }), now: () => 1_000 });
    svc.keepAsWork(id);
    let u = unitOf(h.deps, id);
    expect(u?.status).toBe("planned");
    expect(u?.verification?.keptAsWork).toBeTruthy();
    expect(u?.verification?.mismatch).toBe(false);

    // A later sweep must skip it even though the task is still closed — no re-mismatch, no auto-complete.
    const counter = { n: 0 };
    h.bumpOrigin(); // even with a moved base, keptAsWork is excluded from selection
    const m = await svc.reconcileAndVerify({ todoist, queryFn: verdictQuery({ t1: "done" }, counter), now: () => 2_000 });
    expect(counter.n).toBe(0); // verifier never ran on it
    expect(m.verified).toBe(0);
    u = unitOf(h.deps, id);
    expect(u?.status).toBe("planned"); // still buildable, not auto-completed
  } finally {
    h.cleanup();
  }
});

test("[P3] staleness: unchanged baseSha ⇒ not re-verified (1→1); bumped baseSha ⇒ re-verified", async () => {
  const h = harness();
  try {
    h.mkUnit(["t1"]);
    const todoist = new FakeTodoist();
    todoist.seed("t1");
    const svc = service(h.deps);
    const counter = { n: 0 };

    // Sweep 1: open+done → overlay (stays planned, so it remains verifiable).
    await svc.reconcileAndVerify({ todoist, queryFn: verdictQuery({ t1: "done" }, counter), now: () => 1_000 });
    expect(counter.n).toBe(1);

    // Sweep 2: base SHA unchanged → not stale → verifier NOT called again.
    await svc.reconcileAndVerify({ todoist, queryFn: verdictQuery({ t1: "done" }, counter), now: () => 2_000 });
    expect(counter.n).toBe(1);

    // Sweep 3: bump origin/main → stale → re-verified (proves the skip was staleness, not a dead unit).
    h.bumpOrigin();
    await svc.reconcileAndVerify({ todoist, queryFn: verdictQuery({ t1: "done" }, counter), now: () => 3_000 });
    expect(counter.n).toBe(2);
  } finally {
    h.cleanup();
  }
});

test("[P3] metrics histogram reflects the verdict mix across several units", async () => {
  const h = harness();
  try {
    h.mkUnit(["t1"]);
    h.mkUnit(["t2"]);
    h.mkUnit(["t3", "t4"]);
    const todoist = new FakeTodoist();
    ["t1", "t2", "t3", "t4"].forEach((id) => todoist.seed(id));
    const svc = service(h.deps);
    // t1 done, t2 not-done, t3 done + t4 not-done → that unit is partial.
    const m = await svc.reconcileAndVerify({ todoist, queryFn: verdictQuery({ t1: "done", t2: "not-done", t3: "done", t4: "not-done" }), now: () => 1_000 });
    expect(m.verified).toBe(3);
    expect(m.done).toBe(1);
    expect(m.notDone).toBe(1);
    expect(m.partial).toBe(1);
    expect(h.events).toContain("autopilot.verify.metrics");
  } finally {
    h.cleanup();
  }
});

test("[P3] a deleted (404) task clears the overlay and expires the unit", async () => {
  const h = harness();
  try {
    const id = h.mkUnit(["t1"]);
    const todoist = new FakeTodoist();
    todoist.seed("t1");
    todoist.deleted.add("t1"); // task removed in Todoist
    const svc = service(h.deps);
    await svc.reconcileAndVerify({ todoist, queryFn: verdictQuery({ t1: "done" }), now: () => 1_000 });
    const u = unitOf(h.deps, id);
    expect(u?.status).toBe("expired");
    expect(u?.verification).toBeUndefined();
  } finally {
    h.cleanup();
  }
});

test("[P3] an errored (throttled) verification is NOT persisted as a verdict — unit left unverified to retry", async () => {
  const h = harness();
  try {
    const id = h.mkUnit(["t1"]);
    const todoist = new FakeTodoist();
    todoist.seed("t1");
    const throwing: QueryLike = () => {
      throw new Error("throttled");
    };
    const svc = service(h.deps);
    const m = await svc.reconcileAndVerify({ todoist, queryFn: throwing, now: () => 1_000 });
    expect(m.errors).toBe(1);
    expect(m.verified).toBe(0);
    const u = unitOf(h.deps, id);
    expect(u?.status).toBe("planned");
    expect(u?.verification).toBeUndefined(); // no false not-done stamped — stays stale for the next sweep
  } finally {
    h.cleanup();
  }
});

// ── [P4] manual command: run-token, flag guard, cancel/teardown, late-joiner snapshot ───────────
/** A queryFn that blocks on `gate` before answering, so a test can observe the mid-sweep running state. */
function gatedQuery(gate: Promise<void>, verdict: "done" | "not-done" = "done"): QueryLike {
  return (args) =>
    (async function* () {
      await gate;
      const prompt = String((args as { prompt: string }).prompt);
      const ids = [...prompt.matchAll(/id=([^\s:]+)/g)].map((m) => m[1]!);
      const tasks = ids.map((id) => ({ taskId: id, verdict, ...(verdict === "done" ? { cite: `src/${id}.ts:1` } : {}) }));
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: JSON.stringify({ tasks }) } }] } };
      yield { type: "result", result: "ok" };
    })();
}

test("[P4] verifyCompletion rejects when the flag is OFF (server-side reject-when-off)", async () => {
  const h = harness();
  try {
    h.mkUnit(["t1"]);
    const svc = service(h.deps); // verifyEnabled defaults off
    await expect(svc.verifyCompletion()).rejects.toThrow(BadCommand);
  } finally {
    h.cleanup();
  }
});

test("[P4] verifyCompletion sets running + rejects a concurrent invoke; clears running when done", async () => {
  const h = harness();
  try {
    h.mkUnit(["t1"]);
    const todoist = new FakeTodoist();
    todoist.seed("t1");
    const svc = service(h.deps);
    svc.setAutopilotSchedule({ verifyEnabled: true });

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const p1 = svc.verifyCompletion({ todoist, queryFn: gatedQuery(gate), now: () => 1_000 });
    // running flips true synchronously (start timestamp set before the first await).
    expect(svc.autopilotScheduleEvent().running).toBe(true);
    // A late-joining client's snapshot reflects the live run.
    expect(svc.autopilotRunSnapshotEvent().running).toBe(true);
    // A second concurrent invoke is rejected.
    await expect(svc.verifyCompletion({ todoist })).rejects.toThrow(BadCommand);

    release();
    await p1;
    expect(svc.autopilotScheduleEvent().running).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("[P4] cancel mid-sweep propagates the abort into the queryFn and tears down the read worktree", async () => {
  const h = harness();
  try {
    h.mkUnit(["t1"]);
    const todoist = new FakeTodoist();
    todoist.seed("t1");
    const svc = service(h.deps);
    svc.setAutopilotSchedule({ verifyEnabled: true });

    const extAc = new AbortController();
    let sawAbort = false;
    let markReached: () => void = () => {};
    const reached = new Promise<void>((r) => (markReached = r));
    // The query signals once it's actually running (so the cancel can't race the git-heavy setup), then
    // blocks until it observes the abort on its injected controller — proving the cancel propagated in.
    const q: QueryLike = (args) =>
      (async function* () {
        const sig = (args.options as { abortController: AbortController }).abortController.signal;
        markReached();
        await new Promise<void>((res) => (sig.aborted ? res() : sig.addEventListener("abort", () => res(), { once: true })));
        sawAbort = true;
        yield { type: "result", result: "aborted" };
      })();

    const p = svc.verifyCompletion({ todoist, queryFn: q, signal: extAc.signal, now: () => 1_000 });
    const readWt = join(h.stateDir, "worktrees", `anvil-verify-${h.env.id}`);
    await reached; // the query is running (read worktree created) before we cancel
    expect(existsSync(readWt)).toBe(true);
    extAc.abort();
    await p;
    expect(sawAbort).toBe(true); // the abort reached the queryFn
    expect(existsSync(readWt)).toBe(false); // read worktree torn down in the finally
  } finally {
    h.cleanup();
  }
});

// ── [P5] clear-on-build (3 entry points) + tick deferral ────────────────────────────────────────
const overlay = (): WorkUnitVerification => ({
  verdict: "done",
  evidence: "- ✅ done — src/x.ts:1",
  raw: "{}",
  baseRef: "origin/main",
  baseSha: "sha1",
  at: "2026-01-01T00:00:00Z",
});

test("[P5] startPlan (Go) clears the verification overlay when it starts real work", async () => {
  const h = harness();
  try {
    const id = h.mkUnit(["t1"], { verification: overlay() });
    const svc = service(h.deps);
    await svc.startPlan(id);
    const u = unitOf(h.deps, id);
    expect(u?.status).toBe("building");
    expect(u?.verification).toBeUndefined();
  } finally {
    h.cleanup();
  }
});

test("[P5] linkPlan clears the verification overlay when it links to live work", () => {
  const h = harness();
  try {
    const id = h.mkUnit(["t1"], { verification: overlay() });
    h.fakeSessions.set("sess_link", { data: { environmentId: h.env.id } });
    const svc = service(h.deps);
    svc.linkPlan(id, "sess_link");
    const u = unitOf(h.deps, id);
    expect(u?.status).toBe("building");
    expect(u?.verification).toBeUndefined();
  } finally {
    h.cleanup();
  }
});

test("[P5] runDevPipeline clears the verification overlay before it starts (asserted per-path)", async () => {
  const h = harness();
  const prevKey = process.env[OPENROUTER_KEY];
  process.env[OPENROUTER_KEY] = "test-key"; // pass the key guard so we reach the clear + createWorktree
  const emptyRepo = mkdtempSync(join(tmpdir(), "anvil-empty-repo-"));
  git(["init", "-q"], emptyRepo); // no commits → createWorktree throws AFTER clearVerificationOnBuild ran
  try {
    const env2 = h.envStore.add("empty", emptyRepo);
    const id = h.mkUnit(["t1"], { environmentId: env2.id, verification: overlay() });
    const svc = service(h.deps);
    await expect(svc.runDevPipeline(id)).rejects.toThrow(); // createWorktree fails on the commitless repo
    const u = unitOf(h.deps, id);
    expect(u?.verification).toBeUndefined(); // the clear ran before the worktree failure
  } finally {
    if (prevKey === undefined) delete process.env[OPENROUTER_KEY];
    else process.env[OPENROUTER_KEY] = prevKey;
    rmSync(emptyRepo, { recursive: true, force: true });
    h.cleanup();
  }
});

test("[P5] tick deferral: a closed verifiable unit with NO fresh verdict is NOT completed; done-verdict + review units are", async () => {
  const h = harness();
  try {
    const a = h.mkUnit(["tA"]); // planned (verifiable), closed, no verdict → deferred
    const b = h.mkUnit(["tB"], { verification: overlay() }); // planned, closed, fresh done verdict → completes
    const c = h.mkUnit(["tC"], { status: "review" }); // non-verifiable, closed → checkbox completes
    const todoist = new FakeTodoist();
    ["tA", "tB", "tC"].forEach((id) => todoist.completedIds.add(id));
    const svc = service(h.deps);
    const n = await svc.reconcileCompletedUnits({ verifyDeferral: true, todoist });
    expect(n).toBe(2); // b + c
    expect(unitOf(h.deps, a)?.status).toBe("planned"); // deferred to the verify pass, NOT completed
    expect(unitOf(h.deps, b)?.status).toBe("completed");
    expect(unitOf(h.deps, c)?.status).toBe("completed");
  } finally {
    h.cleanup();
  }
});
