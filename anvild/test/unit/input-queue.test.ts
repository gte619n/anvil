/**
 * [P5 coverage] InputQueue is the streaming-input prompt feeding query() — the seam that makes
 * enqueue-while-busy, drain-on-idle, and multi-turn durability work. It had zero tests. Pins: FIFO order
 * preserved, a waiter parked before a push resolves exactly once, close() ends the iteration and drops
 * further pushes; plus userMessage/attachment block shaping (image/pdf/text/binary).
 */
import { test, expect } from "bun:test";
import { InputQueue, userMessage } from "../../src/agent/input-queue";

const msg = (t: string) => ({ type: "user", message: { role: "user", content: t } }) as any;

test("[P5] buffered pushes drain in FIFO order", async () => {
  const q = new InputQueue();
  q.push(msg("a"));
  q.push(msg("b"));
  const it = q[Symbol.asyncIterator]();
  expect((await it.next()).value.message.content).toBe("a");
  expect((await it.next()).value.message.content).toBe("b");
});

test("[P5] a consumer waiting before a push is resolved exactly once, in order", async () => {
  const q = new InputQueue();
  const it = q[Symbol.asyncIterator]();
  const p1 = it.next(); // parks a waiter (queue empty)
  const p2 = it.next(); // parks a second waiter
  q.push(msg("first"));
  q.push(msg("second"));
  expect((await p1).value.message.content).toBe("first");
  expect((await p2).value.message.content).toBe("second");
});

test("[P5] close() ends the iteration and drops later pushes (no loss-to-a-dead-queue surprise)", async () => {
  const q = new InputQueue();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next(); // a parked waiter
  q.close();
  expect((await pending).done).toBe(true); // the parked waiter is released as done
  q.push(msg("late")); // dropped — the queue is closed
  expect((await it.next()).done).toBe(true);
});

test("[P5] userMessage inlines text with no attachments as a bare string", () => {
  const m = userMessage("hello") as any;
  expect(m.message.content).toBe("hello");
  expect(m.type).toBe("user");
});

test("[P5] attachments become typed content blocks (image / pdf / text / binary)", () => {
  const png = Buffer.from("fakepng").toString("base64");
  const txt = Buffer.from("const x = 1;\n").toString("base64");
  const bin = Buffer.from([0, 1, 2, 3, 0]).toString("base64"); // NUL → binary
  const m = userMessage("look", [
    { mediaType: "image/png", name: "a.png", data: png },
    { mediaType: "application/pdf", name: "b.pdf", data: png },
    { mediaType: "text/plain", name: "c.ts", data: txt },
    { mediaType: "application/octet-stream", name: "d.bin", data: bin },
  ]) as any;
  const blocks = m.message.content as Array<Record<string, any>>;
  expect(blocks[0]).toEqual({ type: "text", text: "look" });
  expect(blocks[1]!.type).toBe("image");
  expect(blocks[2]!.type).toBe("document");
  expect(blocks[3]!.type).toBe("text");
  expect(blocks[3]!.text).toContain('Attached file "c.ts"');
  expect(blocks[4]!.text).toContain("binary, not inlined");
});
