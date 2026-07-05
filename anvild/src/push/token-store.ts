/**
 * [Phase 3 / BE-8] Shared push-target registry + fan-out, extracted from the three near-identical
 * providers (apns/fcm device tokens, webpush subscriptions). Each provider previously hand-rolled
 * the same register/unregister/load/save and send→collect-dead→prune skeleton; this collapses them.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../util/atomic";

/**
 * A persisted, de-duplicated set of push targets keyed by `keyOf`. Writes are atomic and 0600
 * ([SEC-L3]/[BE-9]) because these hold device tokens / push secrets. A corrupt file loads as empty
 * rather than throwing (a bad registry must never wedge push).
 */
export class TokenStore<T> {
  private items: T[];

  constructor(
    private readonly file: string,
    private readonly keyOf: (item: T) => string,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.items = this.load();
  }

  list(): readonly T[] {
    return this.items;
  }
  get size(): number {
    return this.items.length;
  }

  /** Add a target unless one with the same key already exists. */
  add(item: T): void {
    const k = this.keyOf(item);
    if (this.items.some((i) => this.keyOf(i) === k)) return;
    this.items.push(item);
    this.save();
  }

  /** Remove the target with this key (no-op if absent). */
  remove(key: string): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => this.keyOf(i) !== key);
    if (this.items.length !== before) this.save();
  }

  /** Drop every listed dead target in a single write (used after a send). */
  prune(dead: readonly T[]): void {
    if (!dead.length) return;
    const keys = new Set(dead.map((d) => this.keyOf(d)));
    const before = this.items.length;
    this.items = this.items.filter((i) => !keys.has(this.keyOf(i)));
    if (this.items.length !== before) this.save();
  }

  private load(): T[] {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as T[];
    } catch {
      return [];
    }
  }
  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.items), { mode: 0o600 });
  }
}

/**
 * Send to every target concurrently and return the ones `sendOne` reported dead (so the caller can
 * `prune` them). `sendOne` returns true iff the provider said the target is permanently gone; it
 * should swallow transient/network errors (return false) so a blip doesn't drop a good token.
 */
export async function fanOut<T>(items: readonly T[], sendOne: (item: T) => Promise<boolean>): Promise<T[]> {
  const dead: T[] = [];
  await Promise.all(
    items.map(async (item) => {
      if (await sendOne(item)) dead.push(item);
    }),
  );
  return dead;
}
