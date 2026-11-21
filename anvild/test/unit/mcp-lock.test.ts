/** [C1] The exclusive lock (mcp-integrations spec §4.5), with a fake clock. */
import { test, expect } from "bun:test";
import { McpLock, MCP_LOCK_IDLE_MS } from "../../src/mcp/lock";
import { fakeClock } from "../helpers/mcp";

const MIN = 60_000;

test("[C1] the first session to acquire holds it; a second is refused and told who holds it", () => {
  const lock = new McpLock(fakeClock());
  expect(lock.holder("i1")).toBeUndefined();
  expect(lock.acquire("i1", "A")).toEqual({ ok: true });
  expect(lock.holder("i1")).toBe("A");
  expect(lock.acquire("i1", "B")).toEqual({ ok: false, heldBy: "A" });
  expect(lock.holder("i1")).toBe("A"); // a refused acquire changes nothing
  expect(lock.acquire("i1", "A")).toEqual({ ok: true }); // the holder re-acquiring is a refresh
  expect(lock.acquire("i2", "B")).toEqual({ ok: true }); // locks are per integration
});

test("[C1] release frees it for the next session; a non-holder cannot release it", () => {
  const lock = new McpLock(fakeClock());
  lock.acquire("i1", "A");
  expect(lock.release("i1", "B")).toBe(false);
  expect(lock.holder("i1")).toBe("A");
  expect(lock.release("i1", "A")).toBe(true);
  expect(lock.acquire("i1", "B")).toEqual({ ok: true });
  expect(lock.release("i1")).toBe(true); // no session named: whoever holds it
  expect(lock.holder("i1")).toBeUndefined();
});

test("[C1] releaseSession frees everything a session holds and nothing else", () => {
  const lock = new McpLock(fakeClock());
  lock.acquire("i1", "A");
  lock.acquire("i2", "A");
  lock.acquire("i3", "B");
  expect(lock.releaseSession("A").sort()).toEqual(["i1", "i2"]);
  expect(lock.holder("i1")).toBeUndefined();
  expect(lock.holder("i3")).toBe("B");
  expect(lock.releaseSession("A")).toEqual([]);
});

test("[C1] 10 minutes of silence releases the lock", () => {
  const clock = fakeClock();
  const lock = new McpLock(clock);
  expect(MCP_LOCK_IDLE_MS).toBe(10 * MIN);
  lock.acquire("i1", "A");
  clock.advance(10 * MIN - 1);
  expect(lock.holder("i1")).toBe("A");
  expect(lock.acquire("i1", "B")).toEqual({ ok: false, heldBy: "A" });
  clock.advance(1);
  expect(lock.holder("i1")).toBeUndefined();
  expect(lock.acquire("i1", "B")).toEqual({ ok: true });
});

test("[C1] activity at minute 9 keeps the lock past minute 10", () => {
  const clock = fakeClock();
  const lock = new McpLock(clock);
  lock.acquire("i1", "A");
  clock.advance(9 * MIN);
  lock.refresh("i1", "A"); // a tool.result from the integration
  clock.advance(2 * MIN); // minute 11 overall, 2 since the refresh
  expect(lock.holder("i1")).toBe("A");
  clock.advance(8 * MIN); // 10 since the refresh
  expect(lock.holder("i1")).toBeUndefined();
});

test("[C1] refresh by a non-holder neither takes nor extends the lock", () => {
  const clock = fakeClock();
  const lock = new McpLock(clock);
  lock.refresh("i1", "B");
  expect(lock.holder("i1")).toBeUndefined();
  lock.acquire("i1", "A");
  clock.advance(9 * MIN);
  lock.refresh("i1", "B");
  clock.advance(MIN);
  expect(lock.holder("i1")).toBeUndefined();
});

test("[C1] sweep reports the locks that went idle", () => {
  const clock = fakeClock();
  const lock = new McpLock(clock);
  lock.acquire("i1", "A");
  clock.advance(5 * MIN);
  lock.acquire("i2", "B");
  clock.advance(5 * MIN);
  expect(lock.sweep()).toEqual(["i1"]);
  expect(lock.sweep()).toEqual([]);
  expect(lock.holder("i2")).toBe("B");
});
