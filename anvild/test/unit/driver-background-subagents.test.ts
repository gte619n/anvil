/**
 * Background sub-agents end-to-end through a real `consume()` (§sub-agents, background). In streaming-input
 * mode the CLI does NOT hold back `result` while a background agent runs, so the driver sees:
 *   launch (run_in_background) → instant "Async agent launched" tool.result → result
 *   … later … task_notification → a turn the CLI starts by itself → result.
 * Pins: the launch ack does not settle the row; the session idles but knows work is outstanding; the
 * notification persists a durable `subagent.settled`; the self-started turn flips status back to thinking.
 */
import { test, expect } from "bun:test";
import { AgentDriver } from "../../src/agent/driver";
import { PermissionBroker } from "../../src/agent/permissions";
import { QuestionBroker } from "../../src/agent/questions";
import { Session } from "../../src/session/session";
import type { ServerEvent, Session as SessionData } from "@protocol";

function makeSession() {
  const appended: ServerEvent[] = [];
  const statuses: string[] = [];
  const data = {
    id: "sess_bg",
    title: "t",
    cwd: "/tmp",
    source: "existing-dir",
    model: "sonnet",
    autonomy: "mostly-autonomous",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  } as unknown as SessionData;
  const s = new Session(
    data,
    0,
    (_id, ev) => {
      if (ev.type === "status") statuses.push((ev as { status: string }).status);
    },
    () => {},
    (ev) => appended.push(ev),
    "epoch-1",
  );
  return { s, appended, statuses };
}

const assistant = (content: unknown[], parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { content } });
const result = () => ({ type: "result", subtype: "success", stop_reason: "end_turn", num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });

test("a background sub-agent stays running past its turn, then settles durably and wakes the session", async () => {
  const { s, appended, statuses } = makeSession();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let firstTurnDone!: () => void;
  const firstTurn = new Promise<void>((r) => (firstTurnDone = r));
  const q: any = {
    async *[Symbol.asyncIterator]() {
      yield assistant([{ type: "tool_use", id: "toolu_bg", name: "Agent", input: { description: "Audit mappings", subagent_type: "Explore", run_in_background: true } }]);
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_bg", description: "Audit mappings" };
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Async agent launched successfully. agentId: a1 (internal ID) The agent is working in the background." }] },
        tool_use_result: { isAsync: true, status: "async_launched", agentId: "a1" },
      };
      yield assistant([{ type: "text", text: "Launched an auditor in the background." }]);
      yield result();
      firstTurnDone();
      await gate; // … the background agent works …
      yield { type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_bg", status: "completed", output_file: "", summary: "found 3 issues" };
      yield { type: "system", subtype: "session_state_changed", state: "running" };
      yield assistant([{ type: "text", text: "The audit found 3 issues." }]);
      yield result();
      await new Promise(() => {}); // stay open like a live streaming query
    },
    interrupt: async () => {},
    setModel: async () => {},
  };
  const driver = new AgentDriver(
    s,
    { render: (t: string) => ({ source: t, html: t }) } as never,
    new PermissionBroker(),
    new QuestionBroker(),
    {},
    () => {},
    undefined,
    undefined,
    undefined,
    (() => q) as never,
  );

  driver.prompt("audit in the background");
  await firstTurn;
  await new Promise((r) => setTimeout(r, 5)); // let the result's async tail (usage reads) finish

  // Turn 1 ended: the session idles, but the sub-agent is NOT settled — its tool.result was the launch ack.
  expect(s.data.status).toBe("idle");
  expect(s.hasRunningBackgroundSubAgents()).toBe(true);
  const ack = appended.find((e) => e.type === "tool.result") as any;
  expect(ack.subagent).toMatchObject({ id: "toolu_bg", state: "running", background: true });
  expect(appended.some((e) => e.type === "subagent.settled")).toBe(false);

  release();
  for (let i = 0; i < 100 && appended.filter((e) => e.type === "result").length < 2; i++) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 5));

  // The notification settled it DURABLY (seq'd, persisted) — what a client that slept through it replays.
  const settled = appended.find((e) => e.type === "subagent.settled") as any;
  expect(settled).toBeDefined();
  expect(typeof settled.seq).toBe("number");
  expect(settled.agent).toMatchObject({ id: "toolu_bg", label: "Audit mappings", state: "done", background: true });
  expect(s.hasRunningBackgroundSubAgents()).toBe(false);

  // The CLI's self-started follow-up turn flipped idle → thinking (never went through prompt()), then idled.
  const lastIdle = statuses.lastIndexOf("idle");
  expect(statuses.slice(statuses.indexOf("idle") + 1, lastIdle)).toContain("thinking");
  expect(s.data.status).toBe("idle");
  await driver.stop();
});

test("a new user turn keeps a still-running background agent so its later settle isn't lost", () => {
  const { s, appended } = makeSession();
  s.applySubAgentSignals([{ kind: "start", taskId: "bg", launchedBy: null, label: "Long audit", background: true }]);
  s.applySubAgentSignals([{ kind: "start", taskId: "fg", launchedBy: null, label: "Quick look" }]);
  s.finishSubAgent("fg", false);
  s.resetSubAgents(); // next prompt
  expect(s.subAgents.snapshot().map((a) => a.id)).toEqual(["bg"]);
  s.applySubAgentSignals([{ kind: "settle", taskId: "bg", status: "failed", error: "rate limited" }]);
  const settled = appended.filter((e) => e.type === "subagent.settled") as any[];
  expect(settled).toHaveLength(1);
  expect(settled[0].agent).toMatchObject({ id: "bg", state: "error", error: "rate limited", background: true });
});

test("the query dying cancels a background agent durably", () => {
  const { s, appended } = makeSession();
  s.applySubAgentSignals([{ kind: "start", taskId: "bg", launchedBy: null, background: true }]);
  s.cancelRunningSubAgents();
  expect((appended.find((e) => e.type === "subagent.settled") as any)?.agent.state).toBe("canceled");
});
