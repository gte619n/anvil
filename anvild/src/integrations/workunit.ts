import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "../util/ids";
import type { AnvilStatus } from "./status";

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
  status: AnvilStatus; // mirrors the anvil:* label kept on the member tasks
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
    } catch {
      /* start empty on a corrupt file */
    }
  }
  private save(): void {
    writeFileSync(this.file, JSON.stringify({ workunits: this.units }, null, 2));
  }
}
