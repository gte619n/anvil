import { test, expect, mock } from "bun:test";
import type { OpenRouterClient } from "../../src/integrations/openrouter";

// Mock the Agent SDK so planUnit() gets a canned plan without spawning a subprocess. runQuery reads
// the plan from an ExitPlanMode tool_use block and the wrap-up from the result message.
const CANNED_PLAN = "# Plan\n\nChange src/x.ts to do the thing.";
// mock.module replaces the SDK module globally for the whole run, so provide every export the rest of
// the codebase pulls from it (createSdkMcpServer/tool are used by the default-tools MCP server) — a
// query-only stub would break unrelated test files that import the supervisor.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: CANNED_PLAN } }],
        },
      } as any;
      yield { type: "result", result: "The plan is ready." } as any;
    },
  }),
  createSdkMcpServer: () => ({ type: "sdk", name: "mock", instance: {} }),
  tool: (name: string, _desc: unknown, _schema: unknown, handler: unknown) => ({ name, handler }),
}));

const { planUnit } = await import("../../src/integrations/autopilot");

const UNIT = { title: "Do the thing", rationale: "grouped", taskIds: ["t1"] };
const TASKS = [{ id: "t1", project_id: "p1", content: "the task" } as any];

// planUnit passes its repoRoot to the panel, so critics run in agentic mode (client.complete). This
// fake commits to a verdict immediately with no tool calls — the loop finishes in one turn.
function fakeClient(reply: string): OpenRouterClient {
  return {
    complete: async () => ({ content: reply, toolCalls: [] }),
    chat: async () => reply,
  } as unknown as OpenRouterClient;
}

test("planUnit is inert without the adversarial panel: no review, plan unchanged", async () => {
  const planned = await planUnit(UNIT, TASKS, { repoRoot: "/tmp" });
  expect(planned.adversarial).toBeUndefined();
  expect(planned.plan).toBe(CANNED_PLAN);
  expect(planned.plan).not.toContain("## Adversarial Review");
});

test("planUnit runs the panel when enabled: review persisted + appended to the plan", async () => {
  const client = fakeClient(JSON.stringify({ score: 5, verdict: "meh", objections: ["a real gap"] }));
  const planned = await planUnit(UNIT, TASKS, {
    repoRoot: "/tmp",
    adversarial: { enabled: true, client, models: ["m1", "m2"] },
  });
  expect(planned.adversarial?.critiques).toHaveLength(2);
  expect(planned.plan).toContain("## Adversarial Review");
  expect(planned.plan).toContain("a real gap");
  // the original plan text is still present, ahead of the appended block
  expect(planned.plan.startsWith(CANNED_PLAN)).toBe(true);
});
