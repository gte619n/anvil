import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@protocol";

/**
 * The hub's last-known live model labels (see agent/model-catalog.ts). Persisted to
 * `<stateDir>/model-labels.json` so a restart serves the latest labels immediately from disk while the
 * next background refresh runs — and so a daemon with no reachable API (offline / no token) still hands
 * clients the most recent labels it saw instead of nothing. Hub-authoritative, like the prompt library.
 */
export class ModelLabelStore {
  private readonly file: string;
  private labels: Partial<Record<Model, string>> = {};

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "model-labels.json");
    this.load();
  }

  /** The current label overrides (a copy, so callers can't mutate the backing store). */
  get(): Partial<Record<Model, string>> {
    return { ...this.labels };
  }

  /** Replace the stored labels. Returns true iff anything actually changed (so the caller can skip a
   *  no-op broadcast when a refresh yields the same labels). */
  set(next: Partial<Record<Model, string>>): boolean {
    if (JSON.stringify(next) === JSON.stringify(this.labels)) return false;
    this.labels = next;
    this.save();
    return true;
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (raw && typeof raw === "object") this.labels = raw as Partial<Record<Model, string>>;
    } catch {
      /* first run / unreadable — start empty and let the next refresh populate it */
    }
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.labels));
    } catch {
      /* disk full / read-only — the in-memory copy is still authoritative this run */
    }
  }
}
