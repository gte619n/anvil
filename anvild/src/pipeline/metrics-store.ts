/**
 * Persistence for the collusion/theater metric (§6.3). The first-pass rejection rate only means
 * something across many tasks, so it survives restarts in `<stateDir>/integrations/pipeline-metrics.json`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdversaryMetrics, type AdversaryTally } from "./metrics";

function file(stateDir: string): string {
  const dir = join(stateDir, "integrations");
  mkdirSync(dir, { recursive: true });
  return join(dir, "pipeline-metrics.json");
}

export function loadMetrics(stateDir: string): AdversaryMetrics {
  const f = file(stateDir);
  if (!existsSync(f)) return new AdversaryMetrics();
  try {
    return AdversaryMetrics.fromJSON(JSON.parse(readFileSync(f, "utf8")).tallies as AdversaryTally[]);
  } catch {
    return new AdversaryMetrics(); // a corrupt metrics file must never block a run
  }
}

/** Atomic write (tmp + rename) so a crash mid-write can't truncate the metrics. */
export function saveMetrics(stateDir: string, m: AdversaryMetrics): void {
  const f = file(stateDir);
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tallies: m.toJSON() }, null, 2));
  renameSync(tmp, f);
}
