// ── Offline outbox: writes made offline are queued and flushed, in order, on reconnect (arch §8) ──
// This module owns only the QUEUE (the persisted OutboxItem list); the flush/reconcile orchestration
// stays in main.ts because it touches sockets, routing, and session state. Extracted so the queue's
// persistence + mutation logic is unit-testable (inject a Storage; no DOM required).

export interface OutboxItem {
  cid: string;
  cmd: Record<string, unknown> & { type: string };
  tempId?: string; // for session.create: the optimistic local session id to reconcile
  serverUrl?: string; // target server for commands with no sessionId yet (session.create)
}

/** A correlation id for a command awaiting its ack/result. Broadly used, so it lives with the outbox. */
export const newCid = (): string => (crypto.randomUUID ? crypto.randomUUID() : `c_${Date.now()}_${Math.floor(Math.random() * 1e9)}`);

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export class OutboxQueue {
  private items: OutboxItem[];

  constructor(
    private readonly storage: StorageLike = localStorage,
    private readonly key = "anvil.outbox",
  ) {
    this.items = this.load();
  }

  list(): OutboxItem[] {
    return this.items;
  }
  get size(): number {
    return this.items.length;
  }

  enqueue(item: OutboxItem): void {
    this.items.push(item);
    this.save();
  }

  /** Replace the whole queue (used by flush: the items that couldn't be sent stay). */
  replace(items: OutboxItem[]): void {
    this.items = items;
    this.save();
  }

  /** Drop items matching a predicate (used when a queued create is rejected → drop its dependents). */
  removeWhere(pred: (i: OutboxItem) => boolean): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => !pred(i));
    if (this.items.length !== before) this.save();
  }

  private load(): OutboxItem[] {
    try {
      return JSON.parse(this.storage.getItem(this.key) ?? "[]") as OutboxItem[];
    } catch {
      return [];
    }
  }
  private save(): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.items));
    } catch {
      /* quota — the in-memory queue is still authoritative for this session */
    }
  }
}
