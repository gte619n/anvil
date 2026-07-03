import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutopilotEffort } from "@protocol";
import { newId } from "../util/ids";
import type { AnvilStatus } from "./status";
import type { AdversarialReview } from "./adversarial";
import type { PipelinePhase } from "../agent/model-roster";
import type { PipelineStatus } from "../pipeline/types";
import type { TraceRecord } from "../pipeline/trace";

/**
 * A bundle of Todoist tasks the nightly planner decided make sense to implement together,
 * scoped to one environment. This is the unit the autopilot plans, builds (in a worktree
 * session), validates, and opens a PR for. Persisted to `<stateDir>/integrations/workunits.json`.
 */
export interface WorkUnit {
  id: string;
  environmentId: string;
  todoistProjectId: string;
  taskIds: string[]; // Todoist task ids bundled into this unit
  title: string; // short human title for the unit (becomes the worktree/PR name)
  rationale?: string; // why these tasks were grouped
  plan?: string; // the implementation plan (markdown), also posted as a Todoist comment
  summary?: string; // 1–2 line description for the Autopilot card (planner-emitted)
  effort?: AutopilotEffort; // rough size + files-touched estimate for the card (planner-emitted)
  adversarial?: AdversarialReview; // competing-model critiques of the plan (present when the OpenRouter panel ran)
  devPipeline?: { status: PipelineStatus; phaseReached: PipelinePhase; reason?: string; trace: TraceRecord }; // last autonomous-dev-pipeline run (§4)
  status: AnvilStatus; // mirrors the anvil:* label kept on the member tasks
  source?: "project" | "label"; // how the unit was sourced: a linked project (default) or the Autopilot label
  sessionId?: string; // the worktree session implementing it, once started
  prUrl?: string; // PR opened after validation passes
  validation?: { passed: boolean; log?: string; at?: string }; // last validation result
  blockedReason?: string; // populated when status === "blocked"
  createdAt: string;
  updatedAt: string;
}

export class WorkUnitStore {
  private readonly file: string;
  private units: WorkUnit[] = [];

  constructor(stateDir: string) {
    const dir = join(stateDir, "integrations");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "workunits.json");
    this.load();
  }

  list(): WorkUnit[] {
    return [...this.units];
  }
  get(id: string): WorkUnit | undefined {
    return this.units.find((u) => u.id === id);
  }
  forEnvironment(environmentId: string): WorkUnit[] {
    return this.units.filter((u) => u.environmentId === environmentId);
  }
  /** Find the unit that already owns a given Todoist task (a task belongs to at most one unit). */
  forTask(taskId: string): WorkUnit | undefined {
    return this.units.find((u) => u.taskIds.includes(taskId));
  }

  create(
    input: Omit<WorkUnit, "id" | "status" | "createdAt" | "updatedAt"> & { status?: AnvilStatus },
  ): WorkUnit {
    const now = new Date().toISOString();
    const unit: WorkUnit = {
      ...input,
      id: newId("wu"),
      status: input.status ?? "planned",
      createdAt: now,
      updatedAt: now,
    };
    this.units.push(unit);
    this.save();
    return unit;
  }

  update(id: string, fields: Partial<Omit<WorkUnit, "id" | "createdAt">>): WorkUnit | undefined {
    const unit = this.units.find((u) => u.id === id);
    if (!unit) return undefined;
    Object.assign(unit, fields, { updatedAt: new Date().toISOString() });
    this.save();
    return unit;
  }

  remove(id: string): void {
    this.units = this.units.filter((u) => u.id !== id);
    this.save();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      this.units = (JSON.parse(readFileSync(this.file, "utf8")).workunits ?? []) as WorkUnit[];
    } catch (e) {
      // A truncated/corrupt file must NOT silently wipe every work unit — the next save() would then
      // persist the empty list and the autopilot history is gone for good (with the member tasks left
      // orphan-tagged anvil:*). Move the bad file aside (kept for forensics) and start empty so the
      // daemon can still come up; mirrors SessionStore.loadAll().
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, backup);
        console.error(`[workunit] workunits.json was unreadable (${e instanceof Error ? e.message : e}); backed up to ${backup}`);
      } catch {
        /* best-effort */
      }
    }
  }
  /** Atomic write (tmp + rename) so a crash mid-write can never truncate the store. */
  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ workunits: this.units }, null, 2));
    renameSync(tmp, this.file);
  }
}
