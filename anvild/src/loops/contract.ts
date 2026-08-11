/**
 * Loop contract (loops-circuit spec §4.1, Contract v2). Pure: validate + default + complete a
 * `LoopInput` into a full `Loop`, or throw `BadCommand` with a precise reason. No SDK, no I/O — the
 * `autostart-gate.ts` extraction pattern, so every rule is unit-testable.
 *
 * The mandatory-budget guarantee is STRUCTURAL here: `tokenBudget` is always present on the output loop
 * (defaulted by act body when omitted — 300k session/skill, 500k autopilot/pipeline), so no armed path
 * can run unbounded. `act: "autopilot"` is reserved for the daemon-managed Todoist-intake singleton and
 * is rejected on user-created loops.
 */
import { BadCommand } from "../session/errors";
import type { Loop, LoopAct, LoopCheck, LoopInput, LoopRung, LoopState } from "@protocol";

export const PROMOTION_THRESHOLD = 3; // consecutive clean gated laps before Claude suggests the next rung
const RUNG_ORDER: LoopRung[] = ["suggest", "draft", "pr", "ship"];

/**
 * Earned autonomy (loops-circuit spec §5, Phase 5): after PROMOTION_THRESHOLD clean human-approved gates,
 * suggest moving the gate one rung to the right. Never silent, never automatic — the caller surfaces this
 * as a *suggestion* and only an explicit user tap changes `rung`. Returns the suggested next rung, or null.
 */
export function promotionSuggestion(loop: Pick<Loop, "rung" | "cleanGatedLaps">): LoopRung | null {
  const i = RUNG_ORDER.indexOf(loop.rung);
  if (i < 0 || i >= RUNG_ORDER.length - 1) return null; // already at Ship
  return loop.cleanGatedLaps >= PROMOTION_THRESHOLD ? RUNG_ORDER[i + 1]! : null;
}

/** Whether the `ship` rung is unlocked for this loop (earned via promotion from `pr`). */
export function shipUnlocked(loop: Pick<Loop, "rung" | "cleanGatedLaps">): boolean {
  return loop.rung === "ship" || (loop.rung === "pr" && loop.cleanGatedLaps >= PROMOTION_THRESHOLD);
}

export const DEFAULT_MAX_LAPS = 10;
export const DEFAULT_NO_PROGRESS_LAPS = 2;
export const SESSION_TOKEN_BUDGET = 300_000; // session-prompt / skill-check bodies
export const PIPELINE_TOKEN_BUDGET = 500_000; // autopilot / pipeline bodies

/** The default token budget for an act body — the mandatory-budget guarantee's fallback. */
export function defaultTokenBudget(act: LoopAct): number {
  return act.kind === "autopilot" || act.kind === "pipeline" ? PIPELINE_TOKEN_BUDGET : SESSION_TOKEN_BUDGET;
}

/** A short human label for a check (used in verdict rows + lock derivation). */
export function checkLabel(c: LoopCheck): string {
  switch (c.kind) {
    case "judge":
      return `judge: ${c.condition}`;
    case "command":
      return `$ ${c.command}`;
    case "metric":
      return `metric: ${c.command} ${c.op} ${c.threshold}`;
    case "http":
      return `http: ${c.url}`;
  }
}

export interface CompleteOpts {
  now: string;
  genId: () => string; // mint a fresh "loop_…" id (create path)
  existing?: Loop; // update path — preserves createdAt/cleanGatedLaps/workUnitId, bumps configRevision
  allowAutopilotAct?: boolean; // internal: the Todoist-intake singleton may use act: "autopilot"
}

export interface CompleteResult {
  loop: Loop;
  warnings: string[]; // non-fatal (empty checks, "any" mode) — surfaced at arm time
}

const isBlank = (s: string | undefined): boolean => !s || !s.trim();

/** Validate + default a LoopInput into a full Loop. Throws BadCommand on a fatal violation. */
export function completeLoop(input: LoopInput, opts: CompleteOpts): CompleteResult {
  if (isBlank(input.name)) throw new BadCommand("a loop needs a name");
  if (!input.trigger || typeof input.trigger.kind !== "string") throw new BadCommand("a loop needs a trigger");
  if (!input.act || typeof input.act.kind !== "string") throw new BadCommand("a loop needs an act body");

  // Reserved act: only the daemon-managed Todoist-intake singleton may use it.
  if (input.act.kind === "autopilot" && !opts.allowAutopilotAct)
    throw new BadCommand('act "autopilot" is reserved for the built-in Todoist-intake loop');

  // Body-specific required fields.
  if (input.act.kind === "session-prompt" && isBlank(input.act.prompt)) throw new BadCommand("a session-prompt act needs a prompt");
  if (input.act.kind === "skill-check" && isBlank(input.act.command)) throw new BadCommand("a skill-check act needs a command");

  const checks = input.checks ?? [];
  for (const c of checks) {
    if (c.kind === "judge" && isBlank(c.condition)) throw new BadCommand("a judge check needs a condition");
    if (c.kind === "command" && isBlank(c.command)) throw new BadCommand("a command check needs a command");
    if (c.kind === "metric" && isBlank(c.command)) throw new BadCommand("a metric check needs a command");
    if (c.kind === "http" && isBlank(c.url)) throw new BadCommand("an http check needs a url");
  }

  // Earned autonomy: the Ship rung (auto-merge) can't be requested until a loop has earned it (3 clean
  // gated laps). A loop already promoted to Ship keeps it across edits.
  if (input.rung === "ship" && opts.existing?.rung !== "ship" && (opts.existing?.cleanGatedLaps ?? 0) < PROMOTION_THRESHOLD)
    throw new BadCommand("the Ship rung is earned — it unlocks after 3 clean gated laps");

  const warnings: string[] = [];
  if (checks.length === 0) warnings.push("This loop has no checks — it can't prove it's done, so a lap always parks at the gate.");
  const checksMode = input.checksMode ?? "all";
  if (checksMode === "any" && checks.length > 1)
    warnings.push('"any" mode passes on the weakest check — a lap can game the gate. "all" is safer.');

  const hs = input.hardStops ?? {};
  const maxLaps = clampInt(hs.maxLaps, 1, 100, DEFAULT_MAX_LAPS);
  const tokenBudget = hs.tokenBudget && hs.tokenBudget > 0 ? Math.floor(hs.tokenBudget) : defaultTokenBudget(input.act);
  const noProgressLaps = clampInt(hs.noProgressLaps, 1, maxLaps, DEFAULT_NO_PROGRESS_LAPS);

  const existing = opts.existing;
  const notify = {
    onGate: input.notify?.onGate ?? existing?.notify.onGate ?? true,
    onFailure: input.notify?.onFailure ?? existing?.notify.onFailure ?? true,
    onSuccess: input.notify?.onSuccess ?? existing?.notify.onSuccess ?? false,
    dailyDigest: input.notify?.dailyDigest ?? existing?.notify.dailyDigest ?? false,
  };

  const loop: Loop = {
    id: existing?.id ?? input.id ?? opts.genId(),
    name: input.name.trim(),
    ...(input.environmentId ? { environmentId: input.environmentId } : existing?.environmentId ? { environmentId: existing.environmentId } : {}),
    status: existing?.status ?? "draft",
    trigger: input.trigger,
    act: input.act,
    checks,
    checksMode,
    ...(input.scope && input.scope.allow.length ? { scope: input.scope } : existing?.scope ? { scope: existing.scope } : {}),
    rung: input.rung ?? existing?.rung ?? "pr", // new loops start gated at PR (concept §2)
    hardStops: { maxLaps, tokenBudget, noProgressLaps, ...(hs.timeBudgetMs ? { timeBudgetMs: hs.timeBudgetMs } : existing?.hardStops.timeBudgetMs ? { timeBudgetMs: existing.hardStops.timeBudgetMs } : {}) },
    assumptions: input.assumptions ?? existing?.assumptions ?? [],
    notify,
    cleanGatedLaps: existing?.cleanGatedLaps ?? 0,
    configRevision: (existing?.configRevision ?? 0) + 1, // bump on every save; a run pins its revision
    ...(existing?.workUnitId ? { workUnitId: existing.workUnitId } : input.workUnitId ? { workUnitId: input.workUnitId } : {}),
    createdAt: existing?.createdAt ?? opts.now,
    updatedAt: opts.now,
  };
  return { loop, warnings };
}

function clampInt(v: number | undefined, min: number, max: number, dflt: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * Detect a chain cycle (loops-circuit spec §5, Phase 4): a `chained` loop must not, by following its
 * `onLoopId` links, reach itself. Returns the offending reason, or null when the chain is acyclic.
 * @param loops   the full catalog (may or may not already contain the candidate)
 * @param candidate the loop being saved (its id + trigger)
 */
export function chainCycleReason(loops: Loop[], candidate: { id: string; trigger: Loop["trigger"] }): string | null {
  if (candidate.trigger.kind !== "chained") return null;
  const byId = new Map(loops.map((l) => [l.id, l]));
  // Walk the chain from the candidate's target; if we ever land on the candidate, it's a cycle.
  const seen = new Set<string>([candidate.id]);
  let cursor: string | undefined = candidate.trigger.onLoopId;
  while (cursor) {
    if (cursor === candidate.id) return "this chain loops back onto itself";
    if (seen.has(cursor)) break; // a pre-existing cycle elsewhere isn't this save's fault
    seen.add(cursor);
    const next: Loop | undefined = byId.get(cursor);
    if (!next) return `chained onto a loop that doesn't exist (${cursor})`;
    cursor = next.trigger.kind === "chained" ? next.trigger.onLoopId : undefined;
  }
  return null;
}

/** Armed `event` loops subscribed to `eventKind` (pure, testable — the dedupe lives in the service). */
export function eventTargets(loops: Loop[], eventKind: string): Loop[] {
  return loops.filter((l) => l.status === "armed" && l.trigger.kind === "event" && l.trigger.eventKind === eventKind);
}

/** Armed `chained` loops that should fire when `parentLoopId` reaches `terminalStatus` (pure, testable). */
export function chainedTargets(loops: Loop[], parentLoopId: string, terminalStatus: string): Loop[] {
  const outcome: "success" | "failure" = terminalStatus === "shipped" ? "success" : "failure";
  return loops.filter(
    (l) =>
      l.status === "armed" &&
      l.trigger.kind === "chained" &&
      l.trigger.onLoopId === parentLoopId &&
      (l.trigger.on === "any" || l.trigger.on === outcome),
  );
}

/** The union of every check's `locks` — the globs the acting lap may not touch (deterministic). */
export function checkLocks(checks: LoopCheck[]): string[] {
  const out = new Set<string>();
  for (const c of checks) for (const g of c.locks ?? []) out.add(g);
  return [...out];
}

/** Can this loop arm? A loop with zero checks arms with a warning (it always gates); everything else is
 *  a structural error caught by completeLoop. Returns the blocking reason, or null when armable. */
export function armBlockReason(loop: Loop): string | null {
  if (loop.status === "disabled") return "this loop is disabled";
  return null;
}

export type { LoopState };
