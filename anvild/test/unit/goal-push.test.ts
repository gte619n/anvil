/**
 * Push behaviour around a goal (design D3/D4) and restore-as-paused (D5).
 *
 * These are the parts of `/goal` that neither E2E pass could click-verify: web-push only speaks
 * https (so a local sink can never receive a delivery), and observing restore needs a daemon
 * restart, which would kill the dev server under test. Both E2E runs could only READ the code —
 * so pin the behaviour here instead, where it also guards against regression.
 *
 * The seam is `Supervisor.webpush/fcm/apns` (public fields) plus the session's emit sink, which is
 * what drives `maybeNotify`. No SDK, no driver, no network.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type SessionGoal } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";

/** A Supervisor with every push channel replaced by a counter. Returns the counts array. */
async function harness(dir: string) {
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const pushes: Array<{ kind?: string; body: string }> = [];
  const spy = async (p: { kind?: string; body: string }) => void pushes.push({ kind: p.kind, body: p.body });
  // readonly is compile-time only; these are the real fields the supervisor pushes through.
  (sup as any).webpush = { notify: spy, subscribe() {}, unsubscribe() {}, publicKey: "" };
  (sup as any).fcm = { notify: spy };
  (sup as any).apns = { notify: spy };
  const s = await sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: dir });
  return { sup, pushes, id: s.id, session: (sup as any).sessions.get(s.id) };
}

/** The `result` event that ends a turn — the branch D3 suppresses. */
const emitResult = (session: any) => session.emit({ type: "result" });

test("a goal in flight suppresses the per-turn 'your turn' push (D3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-goalpush-"));
  try {
    const { pushes, session } = await harness(dir);

    // No goal → the ordinary reminder fires (three channels: web, fcm, apns).
    emitResult(session);
    expect(pushes.length).toBe(3);

    // Goal armed → every iteration's result is silent. This is what makes a 10-iteration goal send
    // ONE notification instead of ten.
    pushes.length = 0;
    session.data.goal = { condition: "c", iterations: 1, setAt: "t" } satisfies SessionGoal;
    emitResult(session);
    emitResult(session);
    emitResult(session);
    expect(pushes.length).toBe(0);

    // A PAUSED goal is dormant (restored, not re-armed), so it must not swallow reminders.
    session.data.goal.paused = true;
    emitResult(session);
    expect(pushes.length).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolving a goal pushes exactly once — the following result does NOT double-push", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-goalpush-"));
  try {
    const { sup, pushes, id, session } = await harness(dir);
    const goal: SessionGoal = { condition: "all tests pass", iterations: 2, setAt: "t" };

    // The Stop hook clears data.goal and then calls onGoalResolved — reproduce that order exactly.
    session.data.goal = undefined;
    (sup as any).onGoalResolved(id, true, goal);
    expect(pushes.length).toBe(3); // one notification, fanned to the three channels
    expect(pushes[0]!.body).toBe("Goal met: all tests pass");

    // The SDK's `result` lands moments later with no goal left to match on. Without the one-shot
    // marker this would fire a second, redundant "your turn" push.
    pushes.length = 0;
    emitResult(session);
    expect(pushes.length).toBe(0);

    // The marker is ONE-shot: the next unrelated turn gets its ordinary reminder back.
    emitResult(session);
    expect(pushes.length).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ceiling push names the abandonment and its blocker (D4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-goalpush-"));
  try {
    const { sup, pushes, id } = await harness(dir);
    (sup as any).onGoalResolved(id, false, { condition: "impossible", iterations: 10, lastReason: "still red", setAt: "t" });
    expect(pushes.length).toBe(3);
    expect(pushes[0]!.body).toBe("Goal abandoned after 10 turns: impossible");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a goal blocked on approval still reaches the user (only the result branch is suppressed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-goalpush-"));
  try {
    const { pushes, session } = await harness(dir);
    session.data.goal = { condition: "c", iterations: 3, setAt: "t" } satisfies SessionGoal;

    // An unattended goal loop that needs a decision MUST be able to interrupt the user — otherwise
    // the session parks forever behind a prompt nobody knows about.
    session.requestPermission("req-1", "Bash", { command: "git push" }, []);
    expect(pushes.length).toBe(3);
    expect(pushes[0]!.kind).toBe("permission");

    pushes.length = 0;
    session.requestQuestion("req-2", [{ question: "which?", options: [] }] as any);
    expect(pushes.length).toBe(3);
    expect(pushes[0]!.kind).toBe("question");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a persisted goal comes back PAUSED after a restart (D5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-goalrestore-"));
  try {
    const first = await harness(dir);
    first.session.data.goal = { condition: "keep going", iterations: 4, lastReason: "not yet", setAt: "t" } satisfies SessionGoal;
    (first.sup as any).persist();

    // A second Supervisor over the same state dir IS the restart (restore() runs in the ctor).
    const revived = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
    const restored = revived.get(first.id)!.data;
    // Armed state survives — but dormant: a self-update must never silently resume an unattended loop.
    expect(restored.goal?.condition).toBe("keep going");
    expect(restored.goal?.iterations).toBe(4);
    expect(restored.goal?.paused).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
