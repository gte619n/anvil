import { test, expect } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mapMessage, extractSessionId, extractResultUsage } from "../../src/agent/map";
import { PassthroughRenderer } from "../../src/render/markdown";

const r = new PassthroughRenderer();
const map = (m: unknown) => mapMessage(m as SDKMessage, r);

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

test("user tool_result → tool.result (string + array content)", () => {
  const s = map({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }] } });
  expect(s).toEqual([{ type: "tool.result", toolUseId: "tu_1", content: "ok", isError: false }]);
  const a = map({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: [{ type: "text", text: "li" }, { type: "text", text: "ne" }], is_error: true }] } });
  expect(a).toEqual([{ type: "tool.result", toolUseId: "tu_2", content: "line", isError: true }]);
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
