import { describe, expect, test } from "bun:test";
import { ConvertQueue } from "../../src/cad/queue";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("ConvertQueue", () => {
  test("never exceeds concurrency", async () => {
    const q = new ConvertQueue(2);
    let concurrent = 0;
    let peak = 0;
    const task = () =>
      q.enqueue(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await delay(10);
        concurrent--;
      });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  test("FIFO start order", async () => {
    const q = new ConvertQueue(1);
    const started: number[] = [];
    const tasks = Array.from({ length: 5 }, (_, i) =>
      q.enqueue(async () => {
        started.push(i);
        await delay(5);
      }),
    );
    await Promise.all(tasks);
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  test("a rejecting task does not wedge later tasks", async () => {
    const q = new ConvertQueue(1);
    const bad = q.enqueue(async () => {
      throw new Error("boom");
    });
    await expect(bad).rejects.toThrow("boom");
    const good = await q.enqueue(async () => 42);
    expect(good).toBe(42);
    expect(q.active).toBe(0);
    expect(q.pending).toBe(0);
  });
});
