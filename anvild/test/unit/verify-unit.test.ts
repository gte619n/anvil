/**
 * [P2] Tier-1 verifier + read worktree (spec Phase 2) — the BLOCKING, deterministic gate.
 *
 * verifyUnit is driven with an injected queryFn (no SDK subprocess), so the test is fully deterministic.
 * Canned verdicts force the full enum — a `done` AND a `partial` must come through — so a fail-open stub
 * that always returns `not-done` CANNOT pass this file (R1-TEST-4). Malformed model output must fail open
 * to `not-done` and never throw.
 *
 * The read-worktree half runs against a real bare-origin + clone (worktree.test.ts pattern): createReadWorktree
 * must `--detach` at the FETCHED origin/main (seeing a commit pushed after the clone — proving fetch-first),
 * and pruneReadWorktrees must remove an orphan.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryLike } from "../../src/agent/query";
import type { TodoistTask } from "../../src/integrations/todoist";
import { verifyUnit } from "../../src/integrations/autopilot";
import { resolveBaseSha, createReadWorktree, pruneReadWorktrees, removeReadWorktree } from "../../src/session/worktree";
import { generateFixture } from "../fixtures/verify/generate";

const task = (id: string, content = `task ${id}`): TodoistTask => ({ id, project_id: "p1", content });

/** A fake SDK query that delivers `planJson` through an ExitPlanMode tool call (how plan mode returns). */
const fakeQuery = (planJson: string): QueryLike => () =>
  (async function* () {
    yield { type: "assistant", message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: planJson } }] } };
    yield { type: "result", result: "verification complete" };
  })();

const unit = { title: "U", plan: "the plan" };
const WT = "/tmp/unused-cwd"; // the fake queryFn ignores cwd

// ── verifyUnit: the full enum via canned verdicts (fail-open stub can't pass) ──────────────────
test("[P2] verifyUnit returns `done` when every task is done-with-citation", async () => {
  const q = fakeQuery(JSON.stringify({ tasks: [{ taskId: "t1", verdict: "done", cite: "src/a.ts:1" }, { taskId: "t2", verdict: "done", cite: "src/b.ts:2" }], confidence: 0.9 }));
  const r = await verifyUnit(unit, [task("t1"), task("t2")], { baseWorktree: WT, queryFn: q });
  expect(r.verdict).toBe("done");
  expect(r.perTask.every((t) => t.verdict === "done" && t.cited)).toBe(true);
  expect(r.confidence).toBe(0.9);
  expect(r.evidence).toContain("src/a.ts:1");
  expect(r.raw).toContain("t1");
});

test("[P2] verifyUnit returns `partial` when only some tasks are done", async () => {
  const q = fakeQuery(JSON.stringify({ tasks: [{ taskId: "t1", verdict: "done", cite: "src/a.ts:1" }, { taskId: "t2", verdict: "not-done" }] }));
  const r = await verifyUnit(unit, [task("t1"), task("t2")], { baseWorktree: WT, queryFn: q });
  expect(r.verdict).toBe("partial");
});

test("[P2] verifyUnit returns `not-done` for uncited / not-done work", async () => {
  const q = fakeQuery(JSON.stringify({ tasks: [{ taskId: "t1", verdict: "done" /* no cite */ }] }));
  const r = await verifyUnit(unit, [task("t1")], { baseWorktree: WT, queryFn: q });
  expect(r.verdict).toBe("not-done");
  expect(r.perTask[0]!.cited).toBe(false);
});

test("[P2] verifyUnit fails OPEN to not-done on malformed output — never throws", async () => {
  const q = fakeQuery("the model emitted no json whatsoever");
  const r = await verifyUnit(unit, [task("t1")], { baseWorktree: WT, queryFn: q });
  expect(r.verdict).toBe("not-done");
});

test("[P2] verifyUnit fails OPEN with errored=true when the query keeps throwing (after retries)", async () => {
  let calls = 0;
  const throwing: QueryLike = () => {
    calls++;
    throw new Error("sdk blew up");
  };
  const r = await verifyUnit(unit, [task("t1")], { baseWorktree: WT, queryFn: throwing });
  expect(r.verdict).toBe("not-done");
  expect(r.errored).toBe(true); // distinct from a genuine not-done — caller won't persist it
  expect(r.perTask[0]).toEqual({ taskId: "t1", verdict: "not-done", cited: false });
  expect(calls).toBeGreaterThan(1); // retried the transient failure before giving up
});

test("[P2] verifyUnit retries a transient failure then succeeds (not errored)", async () => {
  let calls = 0;
  const flaky: QueryLike = (args) => {
    calls++;
    if (calls === 1) throw new Error("throttled");
    return (async function* () {
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: JSON.stringify({ tasks: [{ taskId: "t1", verdict: "done", cite: "src/a.ts:1" }] }) } }] } };
      yield { type: "result", result: "ok" };
    })();
  };
  const r = await verifyUnit(unit, [task("t1")], { baseWorktree: WT, queryFn: flaky });
  expect(calls).toBe(2);
  expect(r.verdict).toBe("done");
  expect(r.errored).toBeFalsy();
});

test("[P2] a prose (non-JSON) answer is NOT errored — it's a real, safe not-done", async () => {
  const q = fakeQuery("**Verdict: not-done** — nothing in `src/x.ts:9` implements it.");
  const r = await verifyUnit(unit, [task("t1")], { baseWorktree: WT, queryFn: q });
  expect(r.verdict).toBe("not-done");
  expect(r.errored).toBeFalsy();
});

// ── read worktree: fetch-first --detach + orphan prune ─────────────────────────────────────────
test("[P2] resolveBaseSha + createReadWorktree detach at the FETCHED origin tip (proves fetch-first)", async () => {
  const fx = generateFixture("done");
  const wtRoot = mkdtempSync(join(tmpdir(), "anvil-readwt-"));
  try {
    // Push a NEW commit to origin from a second clone, so the fixture repo's LOCAL main is now stale.
    const other = mkdtempSync(join(tmpdir(), "anvil-other-"));
    const git = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd });
    git(["clone", "-q", fx.origin, other], tmpdir());
    git(["config", "user.email", "t@example.com"], other);
    git(["config", "user.name", "Test"], other);
    writeFileSync(join(other, "fetched_marker.txt"), "pushed after clone\n");
    git(["add", "."], other);
    git(["commit", "-q", "-m", "post-clone commit"], other);
    git(["push", "-q", "origin", "main"], other);

    const { ref, sha } = await resolveBaseSha(fx.repo, "HEAD");
    expect(ref).toBe("origin/main");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const { cwd } = await createReadWorktree(fx.repo, ref, wtRoot, "r1");
    // The read checkout sees the post-clone commit — so it detached at the fetched tip, not the stale local main.
    expect(existsSync(join(cwd, "fetched_marker.txt"))).toBe(true);
    // Branchless + no node_modules (tier-1 reads source, runs nothing — A5).
    expect(existsSync(join(cwd, "node_modules"))).toBe(false);

    removeReadWorktree(fx.repo, cwd);
    expect(existsSync(cwd)).toBe(false);
    rmSync(other, { recursive: true, force: true });
  } finally {
    rmSync(wtRoot, { recursive: true, force: true });
    fx.cleanup();
  }
});

test("[P2] pruneReadWorktrees removes an orphaned read worktree", async () => {
  const fx = generateFixture("not-done");
  const wtRoot = mkdtempSync(join(tmpdir(), "anvil-readwt-"));
  try {
    const { ref } = await resolveBaseSha(fx.repo, "HEAD");
    const { cwd } = await createReadWorktree(fx.repo, ref, wtRoot, "orphan");
    expect(existsSync(cwd)).toBe(true);
    // Simulate a crash: the daemon restarts and prunes before the next sweep.
    pruneReadWorktrees(fx.repo, wtRoot);
    expect(existsSync(cwd)).toBe(false);
  } finally {
    rmSync(wtRoot, { recursive: true, force: true });
    fx.cleanup();
  }
});
