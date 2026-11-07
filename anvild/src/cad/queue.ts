// Bounded-concurrency FIFO queue for CAD conversions (D19). OCCT tessellation is CPU + memory
// heavy; without a cap a handful of large B-reps could exhaust the daemon. Tasks run in enqueue
// order, at most `concurrency` at once, and a rejecting task must not wedge the ones behind it.

export class ConvertQueue {
  private readonly waiting: Array<() => void> = [];
  private running = 0;

  constructor(private readonly concurrency: number) {}

  /** Number of tasks queued but not yet started. */
  get pending(): number {
    return this.waiting.length;
  }

  /** Number of tasks currently executing. */
  get active(): number {
    return this.running;
  }

  /** Run `fn` once a slot is free, preserving FIFO order. Resolves/rejects with fn's result. */
  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.waiting.shift();
    if (next) next();
  }
}
