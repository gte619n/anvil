import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { EventLog } from "../../src/eventlog/log";

const tmp = () => mkdtempSync(join(tmpdir(), "anvil-log-"));
const ev = (seq: number, type: string, extra: object = {}) =>
  ({ v: PROTOCOL_VERSION, ts: "t", sessionId: "s1", seq, type, ...extra }) as any;

test("append persists durable events but skips deltas; since filters by seq", () => {
  const d = tmp();
  const log = new EventLog(d);
  log.append(ev(1, "status", { status: "thinking" }));
  log.append(ev(2, "assistant.delta", { text: "x" })); // not persisted
  log.append(ev(3, "assistant.message", { blocks: [] }));
  log.append(ev(4, "result", { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2, turns: 1 } }));

  expect(log.since(2).map((e) => (e as any).seq)).toEqual([3, 4]);
  expect(log.since(0).map((e) => e.type)).toEqual(["status", "assistant.message", "result"]);
  rmSync(d, { recursive: true, force: true });
});

test("snapshot folds the log into ConversationEvent[]", () => {
  const d = tmp();
  const log = new EventLog(d);
  log.append(ev(1, "message.user", { rendered: { source: "hi", html: "<p>hi</p>" }, attachments: [] }));
  log.append(ev(2, "assistant.message", { blocks: [{ kind: "markdown", rendered: { source: "yo", html: "y" } }] }));
  log.append(ev(3, "tool.result", { toolUseId: "t1", content: "ok", isError: false }));
  log.append(ev(4, "result", { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, turns: 1 } }));

  const snap = log.snapshot("s1", 4);
  expect(snap.type).toBe("conversation.snapshot");
  expect(snap.lastSeq).toBe(4);
  expect(snap.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "result"]);
  rmSync(d, { recursive: true, force: true });
});
