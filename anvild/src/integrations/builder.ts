import type { TodoistClient } from "./todoist";
import type { WorkUnit, WorkUnitStore } from "./workunit";
import { withStatus, type AnvilStatus } from "./status";
import type { ValidationResult } from "./validation";

/**
 * Phase 2B — BUILD → VALIDATE → PR → tag. Drives each planned WorkUnit through a worktree build
 * session, runs the validation gate, and opens a PR. Tags member tasks `anvil:building` →
 * `anvil:review` (PR open) or `anvil:blocked` (needs a human) and posts a comment at each step.
 *
 * The session/git/validation mechanics live behind `BuildHost` (implemented by the Supervisor) so
 * this orchestration — the state machine, the fix-retry loop, the tagging — is pure and unit-testable
 * with a fake host.
 */

export type SettledStatus = "idle" | "awaiting_question" | "awaiting_permission" | "error" | "exited" | "timeout";

export interface BuildHost {
  /** Create a fresh-worktree build session (autonomy: bypass) and start it on `brief`. */
  startBuildSession(o: { environmentId: string; title: string; brief: string }): { sessionId: string };
  /** Feed another turn to an existing build session (used for the fix-retry loop). */
  promptSession(sessionId: string, text: string): void;
  /** Resolve once the session leaves its working states (or times out). */
  awaitSettled(sessionId: string): Promise<SettledStatus>;
  /** True if the worktree has new commits vs its base (i.e. the agent actually produced work). */
  hasChanges(sessionId: string): boolean;
  /** Run the environment's validation gate (explicit or auto-detected) in the worktree. */
  validate(sessionId: string): Promise<ValidationResult>;
  /** Commit (best-effort), push, and open a PR for the session's worktree. */
  openPr(sessionId: string, title: string, body: string): { ok: boolean; url?: string; output: string };
  /** Stop the session's driver (keeps the worktree + history). */
  stopSession(sessionId: string): Promise<void>;
}

export interface BuilderEnv {
  id: string;
  name: string;
}

export interface BuilderOpts {
  maxFixAttempts?: number; // validation fix-retries before blocking (default 2)
  batchSize?: number; // units built concurrently (default 3)
  onProgress?: (msg: string) => void;
}

export class Autopilot {
  private readonly maxFixAttempts: number;
  private readonly batchSize: number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly host: BuildHost,
    private readonly deps: { client: TodoistClient; workUnits: WorkUnitStore },
    opts: BuilderOpts = {},
  ) {
    this.maxFixAttempts = opts.maxFixAttempts ?? 2;
    this.batchSize = opts.batchSize ?? 3;
    this.log = opts.onProgress ?? (() => {});
  }

  /** Build every `planned` WorkUnit for an environment, in concurrent batches. */
  async runBuildPhase(env: BuilderEnv): Promise<WorkUnit[]> {
    const planned = this.deps.workUnits.forEnvironment(env.id).filter((u) => u.status === "planned");
    this.log(`${planned.length} planned units for "${env.name}".`);
    const done: WorkUnit[] = [];
    for (let i = 0; i < planned.length; i += this.batchSize) {
      const batch = planned.slice(i, i + this.batchSize);
      const results = await Promise.all(batch.map((u) => this.runWorkUnit(u, env).catch((e) => this.fail(u, `build crashed: ${msg(e)}`))));
      done.push(...results);
    }
    return done;
  }

  /** Drive one unit: build → (block on question/no-change) → validate → (retry|block) → PR → review. */
  async runWorkUnit(unit: WorkUnit, env: BuilderEnv): Promise<WorkUnit> {
    await this.transition(unit, "building");
    const { sessionId } = this.host.startBuildSession({ environmentId: env.id, title: unit.title, brief: this.brief(unit) });
    this.deps.workUnits.update(unit.id, { sessionId });
    this.log(`  building "${unit.title}" → session ${sessionId}`);

    for (let attempt = 0; ; attempt++) {
      const settled = await this.host.awaitSettled(sessionId);
      if (settled === "awaiting_question") {
        await this.host.stopSession(sessionId);
        return this.block(unit, "The build agent needs a decision it couldn't make autonomously — open its session to answer, then re-run.");
      }
      if (settled !== "idle") {
        await this.host.stopSession(sessionId);
        return this.block(unit, `Build session ended in state "${settled}" before completing.`);
      }
      if (!this.host.hasChanges(sessionId)) {
        await this.host.stopSession(sessionId);
        return this.block(unit, "The build session produced no committed changes.");
      }

      const result = await this.host.validate(sessionId);
      if (result.passed) {
        await this.host.stopSession(sessionId);
        return this.openPr(unit, sessionId, result);
      }
      // Failed — retry by feeding the failure back, or give up.
      if (attempt >= this.maxFixAttempts) {
        await this.host.stopSession(sessionId);
        return this.block(unit, `Validation still failing after ${this.maxFixAttempts + 1} attempts.\n\n${failLog(result)}`);
      }
      this.log(`  validation failed (attempt ${attempt + 1}) — asking the session to fix`);
      this.host.promptSession(
        sessionId,
        `The validation gate failed:\n\n${failLog(result)}\n\nFix the issues so every check passes, then commit. Don't ask me — proceed autonomously.`,
      );
    }
  }

  // ── transitions ───────────────────────────────────────────────────────────
  private brief(unit: WorkUnit): string {
    const tasks = unit.taskIds.map((id) => `- ${id}`).join("\n");
    return [
      `You are autonomously implementing a planned unit of work in this worktree. Implement it fully, commit your work with a clear message, and make sure it builds and its tests pass.`,
      ``,
      `# Unit: ${unit.title}`,
      unit.rationale ? `\n${unit.rationale}` : ``,
      `\n## Todoist task ids\n${tasks}`,
      `\n## Plan\n${unit.plan ?? "(no plan recorded — derive one from the tasks)"}`,
      ``,
      `Work autonomously. If you have enough information, proceed without asking. Only if you genuinely cannot proceed without a human decision should you ask a question.`,
    ].join("\n");
  }

  private openPr(unit: WorkUnit, sessionId: string, result: ValidationResult): WorkUnit {
    const note = result.noChecks
      ? "\n\n> ⚠️ No validation gate ran (none configured and none auto-detected) — review extra carefully."
      : result.autodetected
        ? "\n\n> ✓ Auto-detected validation passed."
        : "\n\n> ✓ Validation gate passed.";
    const pr = this.host.openPr(sessionId, unit.title, `Implements anvil work unit “${unit.title}”.${note}`);
    if (!pr.ok) {
      return this.fail(unit, `Validation passed but opening the PR failed:\n\n${pr.output}`);
    }
    this.deps.workUnits.update(unit.id, { status: "review", prUrl: pr.url, validation: { passed: true, at: nowIso() } });
    void this.tag(unit, "review");
    void this.comment(unit, `🤖 **anvil** finished “${unit.title}” → review.${pr.url ? `\n\nPR: ${pr.url}` : ""}${note}`);
    this.log(`  ✓ "${unit.title}" → review${pr.url ? ` (${pr.url})` : ""}`);
    return this.deps.workUnits.get(unit.id) ?? unit;
  }

  private async transition(unit: WorkUnit, status: AnvilStatus): Promise<void> {
    this.deps.workUnits.update(unit.id, { status });
    await this.tag(unit, status);
  }

  private block(unit: WorkUnit, reason: string): WorkUnit {
    this.deps.workUnits.update(unit.id, { status: "blocked", blockedReason: reason });
    void this.tag(unit, "blocked");
    void this.comment(unit, `🤖 **anvil** blocked “${unit.title}”.\n\n${reason}`);
    this.log(`  ⚠ "${unit.title}" → blocked: ${reason.split("\n")[0]}`);
    return this.deps.workUnits.get(unit.id) ?? unit;
  }

  /** Like block(), but for an internal/unexpected failure (kept distinct for clarity in logs). */
  private fail(unit: WorkUnit, reason: string): WorkUnit {
    return this.block(unit, reason);
  }

  /** Re-tag every member task to `status`, preserving the user's own labels. */
  private async tag(unit: WorkUnit, status: AnvilStatus): Promise<void> {
    for (const taskId of unit.taskIds) {
      try {
        const task = await this.deps.client.getTask(taskId);
        await this.deps.client.setTaskLabels(taskId, withStatus(task.labels, status));
      } catch {
        /* a task may have been deleted/completed in Todoist — skip it */
      }
    }
  }

  private async comment(unit: WorkUnit, text: string): Promise<void> {
    const first = unit.taskIds[0];
    if (!first) return;
    try {
      await this.deps.client.addComment(first, text);
    } catch {
      /* best-effort */
    }
  }
}

function failLog(result: ValidationResult): string {
  const last = result.results[result.results.length - 1];
  if (!last) return "(no output)";
  return `\`${last.command}\` exited ${last.code}:\n\n\`\`\`\n${last.output}\n\`\`\``;
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function nowIso(): string {
  return new Date().toISOString();
}
