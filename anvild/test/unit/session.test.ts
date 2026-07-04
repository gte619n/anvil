import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "anvil-sup-"));
}
const createCmd = (cwd: string) =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd } as const);

test("each session has an independent seq starting at 1", () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());

  const a = sup.create(createCmd(dir));
  const b = sup.create(createCmd(dir));

  a.setStatus("thinking"); // a seq 1
  a.setStatus("idle"); // a seq 2
  b.setStatus("thinking"); // b seq 1

  expect(a.lastSeq).toBe(2);
  expect(b.lastSeq).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("resume replays events after lastSeq, and snapshots from scratch", () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir));
  s.setStatus("thinking"); // seq 1 (persisted)
  s.setStatus("idle"); // seq 2

  // resume replays events after lastSeq, then appends a trailing live-status sync
  const replay = sup.resume(s.id, 1);
  expect((replay[0] as any).seq).toBe(2); // the seq-2 event
  expect(replay.at(-1)!.type).toBe("status"); // trailing live status
  expect((replay.at(-1) as any).status).toBe("idle");

  const snap = sup.resume(s.id, undefined);
  expect(snap[0]!.type).toBe("conversation.snapshot");
  expect(snap.at(-1)!.type).toBe("status"); // current status synced on attach
  rmSync(dir, { recursive: true, force: true });
});

test("resume re-surfaces an unanswered permission prompt (the 'lost dialog' fix)", () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir));

  // Simulate the PreToolUse hook parking on a decision.
  s.requestPermission("perm-1", "Edit", { file_path: "a.ts" }, [{ decision: "allow", label: "Allow once" }]);
  expect(s.data.status).toBe("awaiting_permission");

  // A cold attach (no lastSeq → snapshot path) must still carry the pending request, even though
  // the snapshot itself drops permission.request — otherwise the prompt is invisible and stuck.
  const cold = sup.resume(s.id, undefined);
  const perm = cold.find((e) => e.type === "permission.request") as any;
  expect(perm).toBeDefined();
  expect(perm.requestId).toBe("perm-1");
  expect(perm.tool).toBe("Edit");

  // Once answered (cleared), it is no longer re-surfaced.
  s.clearPermission("perm-1");
  expect(sup.resume(s.id, undefined).some((e) => e.type === "permission.request")).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("concurrent permission prompts (sub-agent fan-out) each re-surface and clear independently", () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir));

  // Two sub-agents each park a tool prompt on the SAME session at once.
  s.requestPermission("perm-1", "Bash", { command: "echo a" }, [{ decision: "allow", label: "Allow once" }]);
  s.requestPermission("perm-2", "Bash", { command: "echo b" }, [{ decision: "allow", label: "Allow once" }]);

  // Both must re-surface on a cold attach — a single-slot model silently drops perm-1.
  const cold = sup.resume(s.id, undefined);
  const reqs = (cold.filter((e) => e.type === "permission.request") as any[]).map((r) => r.requestId).sort();
  expect(reqs).toEqual(["perm-1", "perm-2"]);

  // Resolving one must NOT retire the other (the orphan-then-timeout-deny bug).
  s.clearPermission("perm-1");
  const after = (sup.resume(s.id, undefined).filter((e) => e.type === "permission.request") as any[]).map((r) => r.requestId);
  expect(after).toEqual(["perm-2"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a session stays awaiting_permission while any prompt is still parked (no mid-fan-out badge clear)", () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir));

  s.requestPermission("perm-1", "Bash", { command: "echo a" }, [{ decision: "allow", label: "Allow once" }]);
  s.requestPermission("perm-2", "Bash", { command: "echo b" }, [{ decision: "allow", label: "Allow once" }]);

  // perm-1 was allowed → its sub-agent continues and the driver reports activity. The session must
  // stay "awaiting_permission" because perm-2 is still parked, or the fleet badge clears wrongly.
  s.setStatus("running_tool");
  expect(s.data.status).toBe("awaiting_permission");

  // Once every prompt is answered, transient statuses flow normally again.
  s.clearPermission("perm-1");
  s.clearPermission("perm-2");
  s.setStatus("running_tool");
  expect(s.data.status).toBe("running_tool");
  rmSync(dir, { recursive: true, force: true });
});

test("concurrent AskUserQuestion prompts (sub-agent fan-out) each re-surface and clear independently", () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir));

  const q = (txt: string) => [{ question: txt, header: "H", options: [{ label: "a", description: "" }] }];
  s.requestQuestion("q-1", q("one?"));
  s.requestQuestion("q-2", q("two?"));

  const cold = sup.resume(s.id, undefined);
  const reqs = (cold.filter((e) => e.type === "question.request") as any[]).map((r) => r.requestId).sort();
  expect(reqs).toEqual(["q-1", "q-2"]);

  // A continuing sibling sub-agent must not clear the still-parked question's awaiting state.
  s.setStatus("running_tool");
  expect(s.data.status).toBe("awaiting_question");

  s.clearQuestion("q-1");
  const after = (sup.resume(s.id, undefined).filter((e) => e.type === "question.request") as any[]).map((r) => r.requestId);
  expect(after).toEqual(["q-2"]);
  rmSync(dir, { recursive: true, force: true });
});

test("supervisor persists sessions and a fresh instance restores them", async () => {
  const dir = tempState();
  const reg = new ConnectionRegistry();

  const sup1 = new Supervisor({ stateDir: dir }, reg);
  const s = sup1.create(createCmd(dir));
  s.setStatus("thinking"); // advance seq; [BE-1] emit-driven persistence is debounced
  const id = s.id;
  // Let the debounced registry write flush (a real turn always outlives the 100ms window) before
  // simulating the crash-restart, so the persisted "thinking" drives the interrupted-notice path.
  await new Promise((r) => setTimeout(r, 150));

  const sup2 = new Supervisor({ stateDir: dir }, reg);
  const restored = sup2.get(id);
  expect(restored).toBeDefined();
  expect(sup2.list().map((x) => x.id)).toContain(id);
  // transient "thinking" is reset to idle on restore (no live agent after a restart)
  expect(restored!.data.status).toBe("idle");
  // ...and the interrupted turn leaves a visible notice (seq 1 = status, seq 2 = notice)
  expect(restored!.lastSeq).toBe(2);
  const snap = sup2.resume(id, undefined).find((e) => e.type === "conversation.snapshot") as any;
  const blocks = snap.events.at(-1).blocks;
  expect(blocks[0].rendered.source).toContain("interrupted");
  rmSync(dir, { recursive: true, force: true });
});

test("fresh-worktree session: create checks out a worktree, kill removes it", async () => {
  const dir = tempState();
  // a real git repo to branch from
  const repo = mkdtempSync(join(tmpdir(), "anvil-repo-"));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  require("node:fs").writeFileSync(join(repo, "f.txt"), "x");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);

  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = sup.create({
    v: PROTOCOL_VERSION,
    ts: "t",
    type: "session.create",
    source: "fresh-worktree",
    repoRoot: repo,
    base: "HEAD",
    title: "feature work",
  });
  expect(s.data.source).toBe("fresh-worktree");
  expect(s.data.worktree?.branch).toBe("feature-work");
  expect(existsSync(s.data.cwd)).toBe(true);

  await sup.kill(s.id);
  await sup.settle(); // kill backgrounds the worktree reap — wait for it before asserting
  expect(existsSync(s.data.cwd)).toBe(false);

  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("killing a session removes it and its state dir", async () => {
  const dir = tempState();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = sup.create(createCmd(dir));
  const stateSub = join(dir, "sessions", s.id);
  expect(existsSync(stateSub)).toBe(true);

  await sup.kill(s.id);
  await sup.settle(); // kill backgrounds the state-dir reap — wait for it before asserting
  expect(sup.get(s.id)).toBeUndefined();
  expect(existsSync(stateSub)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
