import { test, expect } from "bun:test";
import { Session } from "../../src/session/session";
import type { ServerEvent, Session as SessionData } from "@protocol";

function makeSession() {
  const broadcasts: ServerEvent[] = [];
  const appended: ServerEvent[] = [];
  let onChangeCount = 0;
  const data = {
    id: "sess_1",
    title: "t",
    cwd: "/tmp",
    source: "existing-dir",
    model: "sonnet",
    autonomy: "mostly-autonomous",
    status: "thinking",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  } as unknown as SessionData;
  const s = new Session(
    data,
    5, // lastSeq → nextSeq starts at 6
    (_id, ev) => broadcasts.push(ev),
    () => {
      onChangeCount++;
    },
    (ev) => appended.push(ev),
    "epoch-1",
  );
  return { s, broadcasts, appended, onChangeCount: () => onChangeCount };
}

test("emitLive (via applySubAgentSignals) broadcasts WITHOUT minting seq, appending, or dirtying (D5/ID5)", () => {
  const { s, broadcasts, appended, onChangeCount } = makeSession();
  const seqBefore = s.lastSeq;

  s.applySubAgentSignals([{ kind: "start", taskId: "task_1", launchedBy: null, type: "Explore", label: "Audit" }]);

  // exactly one live broadcast, and it is the sub-agent snapshot
  expect(broadcasts).toHaveLength(1);
  const ev = broadcasts[0] as any;
  expect(ev.type).toBe("subagent.activity");
  expect(ev.live).toBe(true);
  expect(ev.sessionId).toBe("sess_1");
  expect(ev.agents).toEqual([{ id: "task_1", label: "Audit", type: "Explore", state: "running", steps: 0 }]);

  // THE INVARIANT (offline-watermark safety): no seq minted, nothing persisted, not marked dirty.
  expect("seq" in ev).toBe(false);
  expect(s.lastSeq).toBe(seqBefore);
  expect(appended).toHaveLength(0);
  expect(onChangeCount()).toBe(0);
});

test("no structural change → no broadcast (ID11 anti-flood)", () => {
  const { s, broadcasts } = makeSession();
  s.applySubAgentSignals([{ kind: "start", taskId: "task_1", launchedBy: null }]); // 1 broadcast
  s.applySubAgentSignals([{ kind: "progress", taskId: "task_1", elapsedSeconds: 3 }]); // elapsed-only → no broadcast
  s.applySubAgentSignals([{ kind: "step_done", parent: "task_1" }]); // nothing running → no broadcast
  expect(broadcasts).toHaveLength(1);
});

test("finishSubAgent settles + broadcasts + returns the durable view; unknown id returns undefined", () => {
  const { s, broadcasts } = makeSession();
  s.applySubAgentSignals([{ kind: "start", taskId: "task_1", launchedBy: null, label: "Audit" }]);
  const view = s.finishSubAgent("task_1", false);
  expect(view).toMatchObject({ id: "task_1", state: "done" });
  expect((broadcasts.at(-1) as any).agents[0].state).toBe("done");
  expect(s.finishSubAgent("mystery", false)).toBeUndefined();
});

test("subAgentActivityEvents(): empty until a sub-agent exists, then one live snapshot (attach re-surface, D9)", () => {
  const { s } = makeSession();
  expect(s.subAgentActivityEvents()).toHaveLength(0);
  s.applySubAgentSignals([{ kind: "start", taskId: "task_1", launchedBy: null }]);
  const live = s.subAgentActivityEvents();
  expect(live).toHaveLength(1);
  expect((live[0] as any).type).toBe("subagent.activity");
  expect("seq" in (live[0] as any)).toBe(false); // still no seq — a client must not watermark from it
});

test("cancelRunningSubAgents marks running rows canceled and broadcasts (D7)", () => {
  const { s, broadcasts } = makeSession();
  s.applySubAgentSignals([{ kind: "start", taskId: "task_1", launchedBy: null }]);
  s.cancelRunningSubAgents();
  expect((broadcasts.at(-1) as any).agents[0].state).toBe("canceled");
});

test("resetSubAgents clears the set and does NOT broadcast (client resets its own rows on new turn, ID12)", () => {
  const { s, broadcasts } = makeSession();
  s.applySubAgentSignals([{ kind: "start", taskId: "task_1", launchedBy: null }]);
  const before = broadcasts.length;
  s.resetSubAgents();
  expect(broadcasts.length).toBe(before);
  expect(s.subAgentActivityEvents()).toHaveLength(0);
});
