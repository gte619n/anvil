import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type SubAgentView } from "@protocol";
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

  const snap = log.snapshot("s1", 4, "ep_test");
  expect(snap.type).toBe("conversation.snapshot");
  expect(snap.lastSeq).toBe(4);
  expect(snap.epoch).toBe("ep_test"); // v4: the resume lineage token rides the snapshot
  expect(snap.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "result"]);
  rmSync(d, { recursive: true, force: true });
});

test("promptCids returns message.user cids in log order (exactly-once seed)", () => {
  const d = tmp();
  const log = new EventLog(d);
  log.append(ev(1, "message.user", { rendered: { source: "a", html: "a" }, attachments: [], cid: "c1" }));
  log.append(ev(2, "assistant.message", { blocks: [] }));
  log.append(ev(3, "message.user", { rendered: { source: "b", html: "b" }, attachments: [], cid: "c2" }));
  log.append(ev(4, "message.user", { rendered: { source: "c", html: "c" }, attachments: [] })); // no cid → skipped
  expect(log.promptCids()).toEqual(["c1", "c2"]);
  rmSync(d, { recursive: true, force: true });
});

test("[BE2-6] after hydration, reads are served from the in-memory tail (no re-parse of the file)", () => {
  const d = tmp();
  const log = new EventLog(d);
  log.append(ev(1, "message.user", { rendered: { source: "a", html: "a" }, attachments: [], cid: "c1" }));
  log.append(ev(2, "assistant.message", { blocks: [] }));
  log.snapshot("s1", 2, "ep"); // first read → hydrates the cache from disk

  // Delete the on-disk log. If reads still re-parsed the file, they'd now return nothing; served from
  // the in-memory tail, they must still reflect every persisted event.
  rmSync(join(d, "events.ndjson"), { force: true });
  expect(log.since(0).map((e) => e.type)).toEqual(["message.user", "assistant.message"]);
  expect(log.promptCids()).toEqual(["c1"]);
  expect(log.snapshot("s1", 2, "ep").events.map((e) => e.kind)).toEqual(["user", "assistant"]);

  // A new append after hydration is reflected without touching disk on the read.
  log.append(ev(3, "result", { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, turns: 1 } }));
  expect(log.since(2).map((e) => (e as any).seq)).toEqual([3]);
  rmSync(d, { recursive: true, force: true });
});

test("a background sub-agent's subagent.settled is persisted and folds into the snapshot", () => {
  const d = mkdtempSync(join(tmpdir(), "anvil-log-"));
  const log = new EventLog(d);
  const agent: SubAgentView = { id: "toolu_bg", label: "Audit", state: "done", steps: 4, background: true };
  log.append(ev(1, "subagent.settled", { agent }));
  expect(log.since(0).map((e) => e.type)).toEqual(["subagent.settled"]);
  expect(log.snapshot("s1", 1, "ep").events).toEqual([{ kind: "subagent_settled", ts: expect.anything(), agent }]);
  rmSync(d, { recursive: true, force: true });
});

test("orphanedBackgroundAgents: launch acks still running with no later settle", () => {
  const d = mkdtempSync(join(tmpdir(), "anvil-log-"));
  const log = new EventLog(d);
  const bg = (id: string): SubAgentView => ({ id, label: id, state: "running", steps: 0, background: true });
  log.append(ev(1, "tool.result", { toolUseId: "a", content: "", isError: false, subagent: bg("a") }));
  log.append(ev(2, "tool.result", { toolUseId: "b", content: "", isError: false, subagent: bg("b") }));
  log.append(ev(3, "tool.result", { toolUseId: "c", content: "", isError: false, subagent: { id: "c", label: "c", state: "done", steps: 1 } }));
  log.append(ev(4, "subagent.settled", { agent: { ...bg("a"), state: "done" } }));
  expect(log.orphanedBackgroundAgents().map((a) => a.id)).toEqual(["b"]);
  rmSync(d, { recursive: true, force: true });
});
