/**
 * Real-model loop intake (loops-circuit follow-up FU-1, extended). A read-only repo agent that evaluates
 * the outcome the user typed IN THE CONTEXT OF THE CODEBASE — it infers the project's goals from the
 * repo's own docs (CLAUDE.md / README / docs/), verifies the check against the real test setup, and
 * confirms scope against directories that actually exist — then proposes the loop's check / scope /
 * assumptions: the seed the web intake conversation drives off.
 *
 * It runs through `runAgentQuery` in read-only plan mode (Read/Grep/Glob allowed, edits blocked, gated by
 * the danger-list guard), so the daemon stays the permission authority. It THROWS on timeout / transport
 * failure / an unparseable reply — each caught at the call site (LoopService.intakeSuggest), which falls
 * back to the deterministic heuristic. So intake is always available; the model just makes it sharper
 * (and codebase-grounded) when a repo + reachable model are present. `onStep` streams each file it reads.
 */
import { runAgentQuery, type QueryLike } from "../agent/query";
import type { ModelSpec } from "../agent/model-roster";
import type { AccountStore } from "../auth/accounts";
import type { LoopRung } from "@protocol";

/** What the model may sharpen on top of the heuristic base. Every field is optional + validated; a
 *  missing/invalid field just leaves the heuristic's value in place. */
export interface IntakeOverlay {
  name?: string;
  checkCommand?: string;
  checkLocks?: string[];
  scopeAllow?: string[];
  assumptions?: string[];
  rung?: LoopRung;
}

export interface IntakeModelContext {
  prompt: string;
  isFeature: boolean;
  repoRoot?: string; // the environment's checkout — read-only, gives the agent real codebase context
  testScript?: string; // the repo's configured test command, if known
}

export interface IntakeModelOptions {
  model: ModelSpec; // which model authors the intake (the Supervisor wires Sonnet)
  accounts?: AccountStore;
  accountId?: string;
  onStep?: (step: { tool: string; detail: string }) => void; // fired per file read / grep, for streaming
  signal?: AbortSignal;
  queryFn?: QueryLike; // injectable so tests script the reply without a subprocess
}

/** The minimal SDK `query` shape — injectable so tests can script the reply without a subprocess. */
export type IntakeQueryLike = QueryLike;

const RUNGS: LoopRung[] = ["suggest", "draft", "pr", "ship"];
const INTAKE_TIMEOUT_MS = 60_000; // reading a few files is slower than a one-shot; still bounded

/**
 * Ask the model for a codebase-grounded intake overlay. Resolves with the validated overlay, or throws
 * on any failure (the caller falls back to the heuristic). Read-only plan mode with a hard timeout, so it
 * can inspect the repo but never edits it or wedges the daemon. In plan mode the agent delivers its
 * answer via `ExitPlanMode` (captured as `plan`); we parse the JSON object out of that (or the final text).
 */
export async function modelIntake(ctx: IntakeModelContext, opts: IntakeModelOptions): Promise<IntakeOverlay> {
  const prompt = buildPrompt(ctx);
  // Bound the run, and also honor a caller-supplied signal (both abort the underlying subprocess).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INTAKE_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  try {
    const res = await runAgentQuery(prompt, {
      model: opts.model,
      ...(ctx.repoRoot ? { cwd: ctx.repoRoot } : {}),
      readonly: true, // plan mode: reads/greps allowed, edits blocked, danger-list guarded
      signal: ac.signal,
      ...(opts.accounts ? { accounts: opts.accounts } : {}),
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
      ...(opts.onStep ? { onStep: opts.onStep } : {}),
      ...(opts.queryFn ? { queryFn: opts.queryFn } : {}),
    });
    return parseOverlay(res.plan ?? res.text, ctx);
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(ctx: IntakeModelContext): string {
  return (
    `You are setting up an autonomous coding "loop" for THIS repository. The user stated this outcome, ` +
    `most likely an underspecified task pulled from their to-do list:\n\n` +
    `"""${ctx.prompt.slice(0, 1000)}"""\n\n` +
    `This is a ${ctx.isFeature ? "FEATURE (build something new)" : "FIX (repair something broken)"}.\n` +
    (ctx.testScript ? `The repo's test command is: ${ctx.testScript}\n` : "") +
    `\nInspect the codebase read-only to ground your proposal in what's actually here:\n` +
    `1. Infer the PROJECT'S GOALS from its own docs — read CLAUDE.md, README, and anything under docs/ ` +
    `that exists. Understand what this project is trying to be before you shape the loop.\n` +
    `2. Evaluate the outcome AGAINST THE REAL CODE: find the files/areas it touches, confirm the check ` +
    `command actually exercises them (a real test file or script — not a guess), and confirm every scope ` +
    `path is a directory/glob that truly exists in the tree.\n` +
    `3. Surface the genuine AMBIGUITIES — where the task is underspecified relative to how this codebase ` +
    `works, name the concrete decision you had to make (these become logged assumptions the user reviews).\n` +
    `\nThen finish by calling ExitPlanMode with ONLY this JSON object as the plan (no prose):\n` +
    `{\n` +
    `  "name": "<≤60-char loop name>",\n` +
    `  "checkCommand": "<a shell command that exits 0 iff the outcome is met; prefer the repo test command narrowed to the relevant area, verified to exist>",\n` +
    `  "checkLocks": ["<repo-relative file the check reads and the lap must NOT edit>", ...],\n` +
    `  "scopeAllow": ["<repo-relative glob the lap may touch — must exist>", ...],\n` +
    `  "assumptions": ["<a decision you made because the outcome was ambiguous for this codebase>", ...],\n` +
    `  "rung": "suggest" | "draft" | "pr"\n` +
    `}\n\n` +
    `Rules: If a check is a METRIC (a number vs a threshold), its command must print ONLY the number ` +
    `(append " | tail -1" if needed). Keep scope tight and real. New loops start gated — never propose "ship".`
  );
}

/** Parse + validate the model's JSON reply into an overlay. Throws on anything unusable. */
export function parseOverlay(text: string, ctx: IntakeModelContext): IntakeOverlay {
  const json = extractJson(text);
  if (!json) throw new Error(`intake reply had no JSON object: ${text.slice(0, 120)}`);
  const raw = JSON.parse(json) as Record<string, unknown>;
  const overlay: IntakeOverlay = {};
  if (typeof raw.name === "string" && raw.name.trim()) overlay.name = raw.name.trim().slice(0, 60);
  if (typeof raw.checkCommand === "string" && raw.checkCommand.trim()) overlay.checkCommand = raw.checkCommand.trim();
  const locks = strArray(raw.checkLocks);
  if (locks) overlay.checkLocks = locks;
  const scope = strArray(raw.scopeAllow);
  if (scope) overlay.scopeAllow = scope;
  const assumptions = strArray(raw.assumptions);
  if (assumptions) overlay.assumptions = assumptions;
  // Never trust a model into a higher rung than a new loop earns — cap at "pr".
  if (typeof raw.rung === "string" && RUNGS.includes(raw.rung as LoopRung) && raw.rung !== "ship") overlay.rung = raw.rung as LoopRung;
  // A totally empty overlay is a failed parse — fall back rather than silently no-op.
  if (Object.keys(overlay).length === 0) throw new Error(`intake reply had no usable fields (isFeature=${ctx.isFeature})`);
  return overlay;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
  return out.length ? out : undefined;
}

/** Pull the first balanced `{ … }` object out of the reply (models often wrap JSON in prose/fences). */
function extractJson(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}
