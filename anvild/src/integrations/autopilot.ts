import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AutopilotEffort, Model } from "@protocol";
import { buildAgentEnv } from "../agent/env";
import type { TodoistClient, TodoistTask, TodoistSection } from "./todoist";
import { readStatus, withStatus } from "./status";
import { extractPlanMeta, PLAN_META_INSTRUCTION } from "./plan-meta";
import type { WorkUnit, WorkUnitStore } from "./workunit";

/**
 * The nightly task autopilot's planning brain (phases 2–3 of the pipeline: BUNDLE + PLAN).
 * Read-only by design — it never writes to Todoist or the repo here; the supervisor wires the
 * build/validate/PR phases on top. Safe to dry-run against a real project.
 */

/** A proposed grouping of Todoist tasks into one unit of work. */
export interface ProposedUnit {
  title: string; // short, becomes the worktree/PR name
  rationale: string; // why these belong together
  taskIds: string[]; // Todoist task ids (must be candidates from the input)
}

/** A planned unit: a ProposedUnit plus its implementation plan and resolved task objects. */
export interface PlannedUnit extends ProposedUnit {
  tasks: TodoistTask[];
  plan: string; // markdown implementation plan
  summary?: string; // 1–2 line description for the Autopilot card (from the plan's metadata block)
  effort?: AutopilotEffort; // rough size + files-touched estimate (from the plan's metadata block)
}

/**
 * Instruction appended to every planning prompt so the plan commits to a concrete way to PROVE the
 * work is done — form and function — rather than leaving "how to verify" vague. The build session
 * gets this plan as its brief, so naming the validation up front is what makes the autopilot able to
 * self-check its own implementation (it's also what the per-environment validation gate runs).
 */
export const VALIDATION_INSTRUCTION = `Include a dedicated "## Validation" section near the end of the plan that specifies, concretely, how to prove BOTH that the change is wired up (form) and that it behaves correctly (function). Don't hand-wave "test it" — name the actual mechanism and make it runnable:
- Prefer automated checks: the exact unit/integration test files to add or extend and the command to run them (e.g. \`bun test path/to/x.test.ts\`), plus any typecheck/build/lint command that must pass.
- For UI or end-to-end behaviour, describe a debug-browser / headless (e.g. Playwright or the project's existing harness) check: the URL or screen to drive, the steps, and the observable signal that proves success.
- When neither fits, give a precise manual repro: the commands to run and the exact expected output/state.
State the expected passing outcome for each check so success is unambiguous. Ground every command in tooling that actually exists in this repo (inspect package.json / scripts / existing tests first).`;

/**
 * Run a one-shot SDK query. `readonly` uses plan mode (no writes), where the model delivers its plan
 * via an `ExitPlanMode` tool call rather than the final message — its `result` text is only a
 * conversational wrap-up ("the plan is ready at …"). We therefore capture BOTH: `plan` is the
 * `ExitPlanMode` input (the actual markdown plan, when present) and `text` is the closing message.
 * Planning callers want `plan`; the JSON-emitting bundler wants `text`.
 */
async function runQuery(
  prompt: string,
  opts: { model: Model; cwd?: string; readonly?: boolean; signal?: AbortSignal },
): Promise<{ text: string; plan?: string }> {
  // Bridge the run-level signal to the SDK's AbortController so a cancelled/timed-out run tears down the
  // planning subprocess instead of leaving it spinning (and the run — and its spinner — pinned open).
  const ac = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  const q = query({
    prompt,
    options: {
      model: opts.model,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      // plan mode = reads/greps allowed, edits/writes blocked → safe headless inspection.
      permissionMode: opts.readonly ? "plan" : "default",
      settingSources: [], // the daemon is the authority; don't load ambient Claude Code config
      executable: "bun",
      abortController: ac,
      // Built per-call (not cached at module load) so a token set/reset via the UI (auth.set) takes
      // effect for the next planning/refine run without restarting the daemon. See AuthStore.
      env: buildAgentEnv(),
    },
  });
  let text = "";
  let plan: string | undefined;
  for await (const msg of q) {
    if (msg.type === "assistant") {
      // The plan rides in the ExitPlanMode tool call's `input.plan`, not the final result text.
      for (const block of msg.message.content) {
        if (block.type === "tool_use" && block.name === "ExitPlanMode") {
          const p = (block.input as { plan?: unknown }).plan;
          if (typeof p === "string" && p.trim()) plan = p.trim();
        }
      }
    }
    if (msg.type === "result" && "result" in msg && typeof msg.result === "string") text = msg.result;
  }
  return { text: text.trim(), ...(plan ? { plan } : {}) };
}

/**
 * Resolve a read-only planning query into a clean plan + metadata. Prefers the ExitPlanMode plan and
 * falls back to the wrap-up text. The model is told to append a ```json metadata block "after the
 * plan"; it may land in either the plan or the wrap-up, so we look in both for summary/effort.
 */
function resolvePlan(out: { text: string; plan?: string }): { plan: string; summary?: string; effort?: AutopilotEffort } {
  const primary = extractPlanMeta(out.plan ?? out.text);
  if (primary.summary || !out.plan) return primary; // metadata found, or nothing else to look at
  const fromText = extractPlanMeta(out.text); // plan had no block — try the wrap-up for summary/effort
  return { plan: primary.plan, ...(fromText.summary ? { summary: fromText.summary } : {}), ...(fromText.effort ? { effort: fromText.effort } : {}) };
}

/** Pull the first JSON value (object or array) out of a model response that may wrap it in prose/fences. */
function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error(`no JSON found in model output: ${text.slice(0, 200)}`);
  // Walk to the matching close bracket so trailing prose doesn't break JSON.parse.
  const open = candidate[start]!;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === open) depth++;
    else if (candidate[i] === close && --depth === 0) {
      return JSON.parse(candidate.slice(start, i + 1)) as T;
    }
  }
  throw new Error(`unbalanced JSON in model output: ${text.slice(0, 200)}`);
}

function taskLine(t: TodoistTask, sectionName?: string): string {
  const bits = [
    `id=${t.id}`,
    `P${5 - (t.priority ?? 1)}`,
    sectionName ? `section="${sectionName}"` : null,
    t.labels?.length ? `labels=[${t.labels.join(",")}]` : null,
    t.parent_id ? "subtask" : null,
  ].filter(Boolean);
  const desc = t.description?.trim() ? `\n    ${t.description.trim().replace(/\s+/g, " ").slice(0, 300)}` : "";
  return `- ${t.content}  (${bits.join(" ")})${desc}`;
}

/**
 * BUNDLE: group candidate tasks into units of work that make sense to implement together.
 * Every candidate ends up in exactly one unit (a standalone task → a unit of one).
 */
export async function bundleTasks(
  tasks: TodoistTask[],
  sections: TodoistSection[],
  opts: { model?: Model; repoName?: string; signal?: AbortSignal } = {},
): Promise<ProposedUnit[]> {
  if (tasks.length === 0) return [];
  const sectionName = (id?: string | null) => sections.find((s) => s.id === id)?.name;
  const list = tasks.map((t) => taskLine(t, sectionName(t.section_id))).join("\n");
  const prompt = `You are planning engineering work${opts.repoName ? ` for the "${opts.repoName}" repo` : ""}.
Below are outstanding Todoist tasks. Group them into "units of work" — bundles that make sense to implement together in a single branch/PR (related features, same area of the code, shared setup). A standalone task becomes a unit of one. Prefer cohesive, reviewable units; don't force unrelated tasks together.

Rules:
- Every task id below must appear in exactly one unit.
- Give each unit a short imperative title and a one-sentence rationale.

Tasks:
${list}

Respond with ONLY a JSON array, no prose:
[{"title": "...", "rationale": "...", "taskIds": ["id1","id2"]}]`;

  const out = await runQuery(prompt, { model: opts.model ?? "sonnet", signal: opts.signal });
  const units = extractJson<ProposedUnit[]>(out.text);
  // Defensive: keep only real candidate ids, drop empty units.
  const valid = new Set(tasks.map((t) => t.id));
  return units
    .map((u) => ({ title: u.title, rationale: u.rationale, taskIds: (u.taskIds ?? []).filter((id) => valid.has(id)) }))
    .filter((u) => u.taskIds.length > 0);
}

/**
 * PLAN: for one unit, read the repo (read-only) and write an implementation plan. The plan is
 * also what gets posted as a Todoist comment and handed to the build session as its brief.
 */
export async function planUnit(
  unit: ProposedUnit,
  tasks: TodoistTask[],
  opts: { model?: Model; repoRoot: string; signal?: AbortSignal },
): Promise<PlannedUnit> {
  const members = tasks.filter((t) => unit.taskIds.includes(t.id));
  const taskBlock = members.map((t) => taskLine(t)).join("\n");
  const prompt = `You are an engineer planning a unit of work in this repository. Inspect the codebase (read-only) and write a concrete implementation plan.

Unit: ${unit.title}
Why these are bundled: ${unit.rationale}

Tasks to satisfy:
${taskBlock}

Write a focused implementation plan in markdown: the approach, the specific files/functions to change, and edge cases. Be concrete and grounded in what you find in the repo. Do not make any edits — planning only.

${VALIDATION_INSTRUCTION}

${PLAN_META_INSTRUCTION}`;

  const out = await runQuery(prompt, { model: opts.model ?? "opus", cwd: opts.repoRoot, readonly: true, signal: opts.signal });
  const { plan, summary, effort } = resolvePlan(out);
  return { ...unit, tasks: members, plan, summary, effort };
}

/**
 * REFINE: revise an existing plan from reviewer feedback (the Autopilot "refine with Claude" chat).
 * Read-only against the repo; returns the full rewritten plan plus refreshed summary/effort metadata.
 */
export async function refinePlanQuery(opts: {
  title: string;
  currentPlan: string;
  feedback: string;
  repoRoot: string;
  model?: Model;
}): Promise<{ plan: string; summary?: string; effort?: AutopilotEffort }> {
  const prompt = `You are revising an implementation plan for the unit of work "${opts.title}" in this repository, based on reviewer feedback. Inspect the codebase (read-only) as needed, then produce the FULL revised plan in markdown — the complete updated plan, not a diff.

Current plan:
${opts.currentPlan.trim() || "(no plan yet)"}

Reviewer feedback:
${opts.feedback.trim()}

Rewrite the plan to address the feedback while keeping the parts that are still valid. Do not make any edits to the repo — planning only.

${VALIDATION_INSTRUCTION}

${PLAN_META_INSTRUCTION}`;

  const out = await runQuery(prompt, { model: opts.model ?? "opus", cwd: opts.repoRoot, readonly: true });
  return resolvePlan(out);
}

/** Tasks eligible for planning: not already in the anvil pipeline (no anvil:* label, no work unit). */
function candidateTasks(tasks: TodoistTask[], workUnits: WorkUnitStore): TodoistTask[] {
  return tasks.filter((t) => !readStatus(t.labels) && !workUnits.forTask(t.id));
}

/** The Todoist comment for a freshly planned unit: just a one-line summary of what's ready. The full
 *  plan and its location live in Anvil's Autopilot view — no need to restate them (or editorialize)
 *  in the comment. */
function planComment(unit: PlannedUnit): string {
  const summary = unit.summary?.trim() || unit.rationale.trim() || "Implementation plan ready.";
  return `🤖 **anvil** planned “${unit.title}”.\n\n${summary}`;
}

/**
 * Phase 2A — PLAN + TAG (write side): pull candidate tasks for a linked project, bundle, plan each
 * unit, then persist a WorkUnit, post the plan as a Todoist comment, and tag members `anvil:planned`.
 * Tasks already in the pipeline are skipped. Does NOT build code — that's phase 2B.
 */
export async function planAndTagProject(
  deps: { client: TodoistClient; workUnits: WorkUnitStore },
  opts: {
    environmentId: string;
    projectId: string;
    repoRoot: string;
    repoName?: string;
    bundleModel?: Model;
    planModel?: Model;
    signal?: AbortSignal; // run-level abort: a cancelled/timed-out run unwinds in-flight planning
    onProgress?: (msg: string) => void;
    onUnitCreated?: (unit: WorkUnit) => void; // fires as each unit is persisted, so clients update the grid live
  },
): Promise<{ created: WorkUnit[]; skipped: number }> {
  const log = opts.onProgress ?? (() => {});
  const [tasks, sections] = await Promise.all([deps.client.tasks(opts.projectId), deps.client.sections(opts.projectId)]);
  const candidates = candidateTasks(tasks, deps.workUnits);
  const skipped = tasks.length - candidates.length;
  log(`${tasks.length} active tasks · ${candidates.length} candidates · ${skipped} already in pipeline.`);
  if (candidates.length === 0) return { created: [], skipped };

  const units = await bundleTasks(candidates, sections, { model: opts.bundleModel, repoName: opts.repoName, signal: opts.signal });
  log(`Bundled into ${units.length} units. Planning + tagging…`);
  const created: WorkUnit[] = [];
  for (const [i, unit] of units.entries()) {
    log(`  [${i + 1}/${units.length}] "${unit.title}" (${unit.taskIds.length} tasks)…`);
    const planned = await planUnit(unit, candidates, { model: opts.planModel, repoRoot: opts.repoRoot, signal: opts.signal });
    const wu = deps.workUnits.create({
      environmentId: opts.environmentId,
      todoistProjectId: opts.projectId,
      taskIds: planned.taskIds,
      title: planned.title,
      rationale: planned.rationale,
      plan: planned.plan,
      summary: planned.summary,
      effort: planned.effort,
      status: "planned",
    });
    // Tag every member; post the summary + deep link once (on the first member), pointers on the rest.
    for (const [j, t] of planned.tasks.entries()) {
      await deps.client.setTaskLabels(t.id, withStatus(t.labels, "planned"));
      if (j === 0) await deps.client.addComment(t.id, planComment(planned));
      else await deps.client.addComment(t.id, `🤖 Part of anvil unit “${planned.title}” — plan is on “${planned.tasks[0]!.content}”.`);
    }
    created.push(wu);
    opts.onUnitCreated?.(wu);
  }
  log(`Created ${created.length} planned work units.`);
  return { created, skipped };
}

/**
 * Phase 2A for label-sourced tasks: bundle + plan an explicit task list (gathered account-wide by the
 * Autopilot label, not a single project) against the catch-all environment. Same persistence/tag/comment
 * side effects as planAndTagProject, but each unit is marked `source: "label"` and carries the first
 * member's own project id. Caller is responsible for excluding tasks already covered by a linked project.
 */
export async function planAndTagTasks(
  deps: { client: TodoistClient; workUnits: WorkUnitStore },
  opts: {
    environmentId: string;
    repoRoot: string;
    repoName?: string;
    tasks: TodoistTask[];
    bundleModel?: Model;
    planModel?: Model;
    signal?: AbortSignal; // run-level abort: a cancelled/timed-out run unwinds in-flight planning
    onProgress?: (msg: string) => void;
    onUnitCreated?: (unit: WorkUnit) => void; // fires as each unit is persisted, so clients update the grid live
  },
): Promise<{ created: WorkUnit[]; skipped: number }> {
  const log = opts.onProgress ?? (() => {});
  const candidates = candidateTasks(opts.tasks, deps.workUnits);
  const skipped = opts.tasks.length - candidates.length;
  log(`${opts.tasks.length} labelled tasks · ${candidates.length} candidates · ${skipped} already in pipeline.`);
  if (candidates.length === 0) return { created: [], skipped };

  const units = await bundleTasks(candidates, [], { model: opts.bundleModel, repoName: opts.repoName, signal: opts.signal });
  log(`Bundled into ${units.length} units. Planning + tagging…`);
  const created: WorkUnit[] = [];
  for (const [i, unit] of units.entries()) {
    log(`  [${i + 1}/${units.length}] "${unit.title}" (${unit.taskIds.length} tasks)…`);
    const planned = await planUnit(unit, candidates, { model: opts.planModel, repoRoot: opts.repoRoot, signal: opts.signal });
    const wu = deps.workUnits.create({
      environmentId: opts.environmentId,
      todoistProjectId: planned.tasks[0]?.project_id ?? "",
      taskIds: planned.taskIds,
      title: planned.title,
      rationale: planned.rationale,
      plan: planned.plan,
      summary: planned.summary,
      effort: planned.effort,
      status: "planned",
      source: "label",
    });
    for (const [j, t] of planned.tasks.entries()) {
      await deps.client.setTaskLabels(t.id, withStatus(t.labels, "planned"));
      if (j === 0) await deps.client.addComment(t.id, planComment(planned));
      else await deps.client.addComment(t.id, `🤖 Part of anvil unit “${planned.title}” — plan is on “${planned.tasks[0]!.content}”.`);
    }
    created.push(wu);
    opts.onUnitCreated?.(wu);
  }
  log(`Created ${created.length} planned work units from the Autopilot label.`);
  return { created, skipped };
}

/**
 * Dry-run BUNDLE+PLAN for a linked project: pull active tasks, bundle, and plan each unit.
 * Writes nothing. Returns the planned units for inspection.
 */
export async function dryRunProject(
  client: TodoistClient,
  opts: { projectId: string; repoRoot: string; repoName?: string; bundleModel?: Model; planModel?: Model; onProgress?: (msg: string) => void },
): Promise<PlannedUnit[]> {
  const log = opts.onProgress ?? (() => {});
  const [tasks, sections] = await Promise.all([client.tasks(opts.projectId), client.sections(opts.projectId)]);
  log(`Pulled ${tasks.length} active tasks, ${sections.length} sections.`);
  const units = await bundleTasks(tasks, sections, { model: opts.bundleModel, repoName: opts.repoName });
  log(`Bundled into ${units.length} units. Planning…`);
  const planned: PlannedUnit[] = [];
  for (const [i, unit] of units.entries()) {
    log(`  [${i + 1}/${units.length}] planning "${unit.title}" (${unit.taskIds.length} tasks)…`);
    planned.push(await planUnit(unit, tasks, { model: opts.planModel, repoRoot: opts.repoRoot }));
  }
  return planned;
}
