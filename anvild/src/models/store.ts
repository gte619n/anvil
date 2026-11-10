import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model, ModelTierInfo } from "@protocol";

/** Persisted shape — the resolved tier catalog plus when the hub last checked the Models API. */
interface Persisted {
  catalog: Partial<Record<Model, ModelTierInfo>>;
  checkedAt: string; // ISO 8601, "" if never checked
}

/**
 * The hub's last-known live model catalog (see agent/model-catalog.ts). Persisted to
 * `<stateDir>/model-labels.json` so a restart serves the latest labels immediately from disk while the
 * next background refresh runs — and so a daemon with no reachable API (offline / no token) still hands
 * clients the most recent catalog it saw instead of nothing. Hub-authoritative, like the prompt library.
 *
 * Holds the full per-tier detail (concrete model id + release date), not just labels, so Settings →
 * Models can show the *exact* model each picker tier resolves to. `labels()` derives the back-compat
 * `ModelLabelsEvent.labels` map from it.
 */
export class ModelLabelStore {
  private readonly file: string;
  private data: Persisted = { catalog: {}, checkedAt: "" };

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "model-labels.json");
    this.load();
  }

  /** Back-compat label overrides for `ModelLabelsEvent.labels` (a tier → label map). */
  get(): Partial<Record<Model, string>> {
    const out: Partial<Record<Model, string>> = {};
    for (const [id, info] of Object.entries(this.data.catalog)) {
      if (info) out[id as Model] = info.label;
    }
    return out;
  }

  /** The full resolved catalog (a copy, so callers can't mutate the backing store). */
  catalog(): Partial<Record<Model, ModelTierInfo>> {
    return { ...this.data.catalog };
  }

  /** ISO 8601 of the hub's last catalog check ("" if never). */
  checkedAt(): string {
    return this.data.checkedAt;
  }

  /** Record a check: stamp `checkedAt` (always) and replace the catalog (when given). Returns true iff
   *  the resolved *catalog* actually changed — so the caller can broadcast a fresh label set only on a
   *  real change, while the timestamp still advances for the "last checked" display. A check that threw
   *  (no token / API error) passes `undefined` to bump only the timestamp. */
  set(catalog: Partial<Record<Model, ModelTierInfo>> | undefined, checkedAt: string): boolean {
    this.data.checkedAt = checkedAt;
    const changed = catalog !== undefined && JSON.stringify(catalog) !== JSON.stringify(this.data.catalog);
    if (changed) this.data.catalog = catalog;
    this.save();
    return changed;
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (raw && typeof raw === "object" && "catalog" in raw) {
        const p = raw as Partial<Persisted>;
        this.data = { catalog: p.catalog ?? {}, checkedAt: typeof p.checkedAt === "string" ? p.checkedAt : "" };
      }
      // A legacy flat `{opus:"Opus 5"}` file (pre-catalog) is ignored — start empty and let the next
      // refresh repopulate the richer shape; labels degrade to the static fallback until then.
    } catch {
      /* first run / unreadable — start empty and let the next refresh populate it */
    }
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.data));
    } catch {
      /* disk full / read-only — the in-memory copy is still authoritative this run */
    }
  }
}
