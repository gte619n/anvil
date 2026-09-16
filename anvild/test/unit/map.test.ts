import { test, expect } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mapMessage, extractSessionId, extractResultUsage, askUserQuestionToolIds, subAgentSignals, toolResultImages } from "../../src/agent/map";
import { PassthroughRenderer } from "../../src/render/markdown";

const r = new PassthroughRenderer();
const map = (m: unknown) => mapMessage(m as SDKMessage, r);
const sig = (m: unknown) => subAgentSignals(m as SDKMessage);

test("stream_event text_delta → assistant.delta", () => {
  const out = map({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "PO" } } });
  expect(out).toEqual([{ type: "assistant.delta", text: "PO" }]);
});

test("non-text stream_event → nothing", () => {
  expect(map({ type: "stream_event", event: { type: "message_start" } })).toEqual([]);
});

test("assistant text → assistant.message with one markdown block", () => {
  const out = map({ type: "assistant", message: { content: [{ type: "text", text: "hello **world**" }] } });
  expect(out).toHaveLength(1);
  expect(out[0]!.type).toBe("assistant.message");
  const blocks = (out[0] as any).blocks;
  expect(blocks[0].kind).toBe("markdown");
  expect(blocks[0].rendered.source).toBe("hello **world**");
});

test("assistant tool_use → assistant.message block + a tool.use event", () => {
  const out = map({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }] },
  });
  expect(out.map((e) => e.type)).toEqual(["assistant.message", "tool.use"]);
  expect((out[1] as any).toolUseId).toBe("tu_1");
  expect((out[1] as any).name).toBe("Bash");
});

test("AskUserQuestion tool_use is suppressed (rendered as a question card, not a tool block)", () => {
  const m = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu_q", name: "AskUserQuestion", input: { questions: [] } }] },
  };
  // No assistant.message (blocks would be empty) and no tool.use event for the question.
  expect(map(m)).toEqual([]);
  expect(askUserQuestionToolIds(m as unknown as SDKMessage)).toEqual(["tu_q"]);
});

test("AskUserQuestion alongside text keeps the text block but drops the question tool_use", () => {
  const out = map({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "let me ask" },
        { type: "tool_use", id: "tu_q", name: "AskUserQuestion", input: { questions: [] } },
        { type: "tool_use", id: "tu_b", name: "Bash", input: { command: "ls" } },
      ],
    },
  });
  expect(out.map((e) => e.type)).toEqual(["assistant.message", "tool.use"]);
  expect((out[0] as any).blocks.map((b: any) => b.kind)).toEqual(["markdown", "tool_use"]);
  expect((out[1] as any).name).toBe("Bash"); // only the non-question tool.use is emitted
});

test("user tool_result → tool.result (string + array content)", () => {
  const s = map({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }] } });
  expect(s).toEqual([{ type: "tool.result", toolUseId: "tu_1", content: "ok", isError: false }]);
  const a = map({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: [{ type: "text", text: "li" }, { type: "text", text: "ne" }], is_error: true }] } });
  expect(a).toEqual([{ type: "tool.result", toolUseId: "tu_2", content: "line", isError: true }]);
});

test("tool_result with an image block: base64 stays out of the text, extracted separately", () => {
  const m = {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_shot",
          is_error: false,
          content: [
            { type: "text", text: "captured" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAAbase64AAAA" } },
          ],
        },
      ],
    },
  };
  // The emitted tool.result carries only the text — never the megabyte of base64.
  expect(map(m)).toEqual([{ type: "tool.result", toolUseId: "tu_shot", content: "captured", isError: false }]);
  // …and the image is surfaced for the driver to persist, keyed by tool_use id.
  expect(toolResultImages(m as unknown as SDKMessage)).toEqual([
    { toolUseId: "tu_shot", images: [{ mediaType: "image/png", dataBase64: "AAAAbase64AAAA" }] },
  ]);
});

test("toolResultImages: nothing to extract from text-only / non-user messages", () => {
  expect(toolResultImages({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } } as unknown as SDKMessage)).toEqual([]);
  expect(toolResultImages({ type: "assistant", message: { content: [] } } as unknown as SDKMessage)).toEqual([]);
});

// ── Sub-agents (§sub-agents): suppression from the normal flow + signal extraction ─────────────────

test("a sub-agent's INTERNAL assistant/user messages are suppressed from the normal flow (ID1)", () => {
  // parent_tool_use_id set → these belong to a sub-agent; they must NOT enter the main activity block.
  const asst = { type: "assistant", parent_tool_use_id: "task_1", message: { content: [{ type: "tool_use", id: "x", name: "Read", input: {} }] } };
  const usr = { type: "user", parent_tool_use_id: "task_1", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } };
  expect(map(asst)).toEqual([]);
  expect(map(usr)).toEqual([]);
});

test("the MAIN-turn Task tool_use is still emitted normally (durable anchor for the sub-agent group)", () => {
  const out = map({ type: "assistant", message: { content: [{ type: "tool_use", id: "task_1", name: "Agent", input: { subagent_type: "Explore", description: "Audit mappings" } }] } });
  expect(out.map((e) => e.type)).toEqual(["assistant.message", "tool.use"]);
  expect((out[1] as any).name).toBe("Agent");
});

test("subAgentSignals: a main-turn Agent launch → a start signal with launchedBy=null", () => {
  expect(sig({ type: "assistant", message: { content: [{ type: "tool_use", id: "task_1", name: "Agent", input: { subagent_type: "Explore", description: "Audit mappings" } }] } })).toEqual([
    { kind: "start", taskId: "task_1", launchedBy: null, type: "Explore", label: "Audit mappings" },
  ]);
});

test("subAgentSignals: a sub-agent's tool_use → a step; its message meta → a meta signal", () => {
  const out = sig({
    type: "assistant",
    parent_tool_use_id: "task_1",
    subagent_type: "Explore",
    task_description: "Audit mappings",
    message: { content: [{ type: "tool_use", id: "y", name: "Grep", input: {} }] },
  });
  expect(out).toEqual([
    { kind: "step", parent: "task_1", tool: "Grep" },
    { kind: "meta", parent: "task_1", type: "Explore", label: "Audit mappings" },
  ]);
});

test("subAgentSignals: a nested Agent launch → a start with launchedBy set (grandchild, ID7)", () => {
  expect(sig({ type: "assistant", parent_tool_use_id: "root", message: { content: [{ type: "tool_use", id: "grand", name: "Task", input: {} }] } })).toEqual([
    { kind: "start", taskId: "grand", launchedBy: "root", type: undefined, label: undefined },
  ]);
});

test("subAgentSignals: a sub-agent tool_result → step_done; a MAIN-turn tool_result → nothing", () => {
  expect(sig({ type: "user", parent_tool_use_id: "task_1", message: { content: [{ type: "tool_result", tool_use_id: "y", content: "ok" }] } })).toEqual([{ kind: "step_done", parent: "task_1" }]);
  // The Task tool_result on the main turn (parent null) is the DURABLE completion — handled by the driver, not a signal.
  expect(sig({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "task_1", content: "done" }] } })).toEqual([]);
});

test("subAgentSignals: task_progress → a progress overlay keyed by tool_use_id (ID8)", () => {
  expect(sig({ type: "system", subtype: "task_progress", task_id: "t", tool_use_id: "task_1", description: "Deep dive", subagent_type: "Explore", last_tool_name: "Bash", usage: { total_tokens: 10, tool_uses: 4, duration_ms: 12000 } })).toEqual([
    { kind: "progress", taskId: "task_1", type: "Explore", label: "Deep dive", steps: 4, currentTool: "Bash", elapsedSeconds: 12 },
  ]);
});

test("subAgentSignals: ordinary main-turn messages produce no signals", () => {
  expect(sig({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "b", name: "Bash", input: {} }] } })).toEqual([]);
});

test("result → result event + usage extraction", () => {
  const m = { type: "result", subtype: "success", stop_reason: "end_turn", num_turns: 2, usage: { input_tokens: 11, output_tokens: 22 } };
  const out = map(m);
  expect(out[0]).toEqual({ type: "result", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 22, turns: 2 } });
  expect(extractResultUsage(m as unknown as SDKMessage)).toEqual({ inputTokens: 11, outputTokens: 22, turns: 2 });
});

test("extractSessionId pulls session_id when present", () => {
  expect(extractSessionId({ type: "system", session_id: "abc" } as unknown as SDKMessage)).toBe("abc");
  expect(extractSessionId({ type: "system" } as unknown as SDKMessage)).toBeUndefined();
});
